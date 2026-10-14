/**
 * #4131 grain G-C — unit tests for the listener PG helpers' pure logic
 * (scripts/lib/dashboard-journal.mjs). The CLIs stay thin; everything
 * testable lives in the lib (G-R precedent: backfill-read-state.test.ts).
 *
 * The invariants that matter downstream:
 *  - row → listener-shape mapping keeps the exact field names
 *    `Invoke-ProcessWorkspace` and the WAKE routing consume;
 *  - the read surface refuses unknown flags — it carries no write path and
 *    no `--type`;
 *  - the escalation surface refuses [ERROR] content (no --type flag exists
 *    at all — asserted against the CLI source as a drift-guard);
 *  - SQL mirrors the reader's journal query (order + archived filter).
 */
import { describe, it, expect } from 'vitest';
import {
  SQL_INTERCOM_SINCE,
  SQL_DISCOVER_WORKSPACES,
  SQL_MAX_CREATED,
  rowToListenerMessage,
  validateEscalationContent,
  buildListenerEscalationMessage,
  nextDashboardState,
  parseIntercomArgs,
} from '../../../../scripts/lib/dashboard-journal.mjs';
import { readFileSync } from 'fs';
import path from 'path';

describe('G-C row mapping (rowToListenerMessage)', () => {
  it('maps a full journal row to the listener shape', () => {
    const msg = rowToListenerMessage({
      message_id: 'x',
      author_machine: 'myia-ai-01',
      author_workspace: 'roo-extensions',
      content: '[WAKE-CLAUDE] myia-po-2023:roo-extensions',
      created_at: new Date('2026-10-13T19:46:32.123Z'),
    });
    expect(msg).toEqual({
      timestamp: '2026-10-13T19:46:32.123Z',
      content: '[WAKE-CLAUDE] myia-po-2023:roo-extensions',
      author: { machineId: 'myia-ai-01', workspace: 'roo-extensions' },
    });
  });

  it('passes a string created_at through and survives null author fields (legacy rows)', () => {
    const msg = rowToListenerMessage({ author_machine: null, author_workspace: undefined, content: null, created_at: '2026-10-13T00:00:00Z' });
    expect(msg.timestamp).toBe('2026-10-13T00:00:00Z');
    expect(msg.content).toBe('');
    expect(msg.author).toEqual({ machineId: '', workspace: '' });
  });

  it('refuses a non-object row', () => {
    expect(() => rowToListenerMessage(null)).toThrow();
    expect(() => rowToListenerMessage('row')).toThrow();
  });
});

describe('G-C escalation content guard (validateEscalationContent)', () => {
  it('accepts a [WARN]-prefixed escalation and reports the tag', () => {
    expect(validateEscalationContent('[WARN][LISTENER][#3761] Réveil non délivrable.')).toEqual({ ok: true, tag: 'WARN' });
  });

  it('accepts other non-ERROR tags (ASK, INFO…)', () => {
    expect(validateEscalationContent('[ASK] question').ok).toBe(true);
    expect(validateEscalationContent('[INFO][LISTENER] note').ok).toBe(true);
  });

  it('refuses [ERROR] whatever the case (case-insensitive tag classification)', () => {
    const v = validateEscalationContent('[error] boom');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('#3761');
  });

  it('refuses empty content and untagged prose', () => {
    expect(validateEscalationContent('   ').ok).toBe(false);
    expect(validateEscalationContent('pas de tag ici').ok).toBe(false);
  });
});

describe('G-C escalation message builder (buildListenerEscalationMessage)', () => {
  it('builds the id/author/timestamp at parity with the PS conventions', () => {
    const m = buildListenerEscalationMessage({
      machineId: 'myia-po-2023',
      content: '[WARN] x',
      nowIso: '2026-10-14T01:23:45.678Z',
      rand: 'ab12',
    });
    expect(m.id).toBe('myia-po-2023:listener:ic-20261014T012345-ab12');
    expect(m.timestamp).toBe('2026-10-14T01:23:45.678Z');
    expect(m.author).toEqual({ machineId: 'myia-po-2023', workspace: 'listener' });
    expect(m.content).toBe('[WARN] x');
  });

  it('refuses a bad machineId or a bad nowIso', () => {
    expect(() => buildListenerEscalationMessage({ machineId: '', content: 'x', nowIso: '2026-10-14T00:00:00Z', rand: 'r' })).toThrow();
    expect(() => buildListenerEscalationMessage({ machineId: 'm', content: 'x', nowIso: 'not-a-date', rand: 'r' })).toThrow();
  });
});

describe('G-C dashboard state fold (nextDashboardState)', () => {
  const base = {
    key: 'machine-m',
    lastModified: '2026-10-01T00:00:00Z',
    lastModifiedBy: { machineId: 'old', workspace: 'w' },
    intercom: { messages: [{ id: 'a' }], totalMessages: 1 },
  };
  const msg = buildListenerEscalationMessage({ machineId: 'm', content: '[WARN] y', nowIso: '2026-10-14T02:00:00Z', rand: 'zz9' });

  it('appends, bumps counters, stamps lastModified/By — without mutating the input', () => {
    const next = nextDashboardState(base, msg);
    expect(next.intercom.messages).toHaveLength(2);
    expect(next.intercom.messages[1]).toBe(msg);
    expect(next.intercom.totalMessages).toBe(2);
    expect(next.lastModified).toBe('2026-10-14T02:00:00.000Z'); // normalized ISO (ms added)
    expect(next.lastModifiedBy).toEqual({ machineId: 'm', workspace: 'listener' });
    expect(base.intercom.messages).toHaveLength(1);
    expect(base.lastModified).toBe('2026-10-01T00:00:00Z');
  });

  it('derives the counter from the message list when totalMessages is absent', () => {
    const noCounter = { ...base, intercom: { messages: [{ id: 'a' }, { id: 'b' }] } };
    expect(nextDashboardState(noCounter, msg).intercom.totalMessages).toBe(3);
  });

  it('refuses malformed inputs', () => {
    expect(() => nextDashboardState({}, msg)).toThrow();
    expect(() => nextDashboardState(base, null)).toThrow();
  });
});

describe('G-C read-surface grammar (parseIntercomArgs)', () => {
  it('parses the three modes', () => {
    expect(parseIntercomArgs(['--workspace', 'roo-extensions', '--since', '2026-10-13T00:00:00.000Z']))
      .toEqual({ mode: 'messages', workspace: 'roo-extensions', since: '2026-10-13T00:00:00.000Z' });
    expect(parseIntercomArgs(['--workspace', 'roo-extensions'])).toEqual({ mode: 'messages', workspace: 'roo-extensions', since: null });
    expect(parseIntercomArgs(['--discover'])).toEqual({ mode: 'discover' });
    expect(parseIntercomArgs(['--max-created', 'a, b ,c'])).toEqual({ mode: 'max-created', keys: ['a', 'b', 'c'] });
  });

  it('refuses unknown flags — the surface has no --type and no write path', () => {
    expect(parseIntercomArgs(['--type', 'global']).error).toContain('option inconnue');
    expect(parseIntercomArgs(['--write', 'x']).error).toContain('option inconnue');
  });

  it('refuses zero or multiple modes, bad cursors, empty workspaces', () => {
    expect(parseIntercomArgs([]).error).toContain('un mode');
    expect(parseIntercomArgs(['--workspace', 'a', '--discover']).error).toContain('un mode');
    expect(parseIntercomArgs(['--workspace', 'a', '--since', '13/10/2026']).error).toContain('ISO-8601');
    expect(parseIntercomArgs(['--workspace', '  ']).error).toContain('non vide');
    expect(parseIntercomArgs(['--max-created', ', ,']).error).toContain('≥1 workspace');
  });
});

describe('G-C SQL parity with the reader (drift-guard)', () => {
  it('intercom query filters archived rows and orders like getRooSyncDashboard', () => {
    expect(SQL_INTERCOM_SINCE).toContain('archived_at IS NULL');
    expect(SQL_INTERCOM_SINCE).toContain('ORDER BY created_at ASC, id ASC');
  });
  it('discovery only returns workspace keys; poll query is grouped', () => {
    expect(SQL_DISCOVER_WORKSPACES).toContain("LIKE 'workspace-%'");
    expect(SQL_MAX_CREATED).toContain('GROUP BY dashboard_key');
    expect(SQL_MAX_CREATED).toContain('archived_at IS NULL');
  });
});

describe('G-C escalation CLI surface (drift-guard on the CLI source)', () => {
  // #3761 condition 1 by construction: no --type option may ever appear in
  // the append CLI's grammar (only the refusal of one).
  const cli = readFileSync(
    path.join(__dirname, '../../../../scripts/rsm-dashboard-append.mjs'),
    'utf-8'
  );
  it('contains the --type refusal and no --type option in the accepted set', () => {
    expect(cli).toContain("args.includes('--type')");
    expect(cli).toContain('#3761');
    // The accepted-flag set must not grow a type flag:
    const knownSet = cli.match(/const known = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '';
    expect(knownSet).not.toContain('--type');
  });
  it('refuses [ERROR] content via the shared guard', () => {
    expect(cli).toContain('validateEscalationContent');
  });

  // ms#1425 CHANGES_REQUESTED (14/10): the three review items are part of the
  // CLI contract and must not drift. Negative assertions run on the CODE ONLY
  // (comments stripped) — the docstring legitimately NAMES the removed APIs
  // when narrating what the first head did wrong.
  const cliCode = cli
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  it('serializes the read→fold→write under the append lock, fail-open (review item 1)', () => {
    expect(cli).toContain('acquireAppendLock');
    expect(cli).toContain('releaseAppendLock');
    expect(cliCode).not.toContain('withAppendLockRequired'); // fail-closed sibling — destructive ops only, NEVER escalations
    expect(cli).toContain('unserialized');           // output field when the lock was not acquired
    // Bounded write (07/10 class): the fs write carries an abort signal
    expect(cli).toContain('AbortSignal.timeout');
    expect(cli).toContain('UNIFIED_STORE_DASHBOARD_GDRIVE_WRITE_TIMEOUT_MS');
    // ORDER (re-review 11:04Z): the lock is acquired BEFORE the base read —
    // presence alone let a pre-lock snapshot through (stale fold overwrite).
    const lockCall = cliCode.indexOf('acquireAppendLock(key, holder)');
    const readCall = cliCode.indexOf('readDashboardFile(key)');
    expect(lockCall).toBeGreaterThan(-1);
    expect(readCall).toBeGreaterThan(-1);
    expect(lockCall).toBeLessThan(readCall);
  });
  it('reads the base via readDashboardFile, never readDashboardFromPg (review item 2, #3782)', () => {
    expect(cli).toContain('readDashboardFile');
    expect(cliCode).not.toContain('readDashboardFromPg');
  });
  it('decides pgSynced via dualWriteDashboardSyncChecked (review item 3)', () => {
    expect(cli).toContain('dualWriteDashboardSyncChecked');
    // The void variant swallows its errors — a boolean derived from it is a lie.
    expect(cliCode).not.toMatch(/\bdualWriteDashboardSync\b(?!Checked)/);
  });
});
