/**
 * #3226(a) — GlobalNotifState unit tests
 *
 * Covers the §4 filter (the condition of success per the issue: a [NOTIF] that
 * surfaces everything becomes noise agents learn to skip), the §3 footer shape,
 * and the cursor semantics (advances only on effective read, monotonic,
 * bootstraps to now on first use).
 */

import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ERROR_DELAY_MIN,
  advanceGlobalSeenCursor,
  buildGlobalFooter,
  extractTags,
  filterNotifiableGlobalMessages,
  getGlobalSeenCursor,
  resetGlobalNotifQueueForTests
} from '../GlobalNotifState.js';
import type { IntercomMessage } from '../../tools/roosync/dashboard-schemas.js';

const NOW_MS = Date.parse('2026-08-25T12:00:00Z');
const CURSOR = '2026-08-25T10:00:00Z';

function mkMsg(id: string, ts: string, machineId: string, content: string): IntercomMessage {
  return {
    id,
    timestamp: ts,
    author: { machineId, workspace: 'roo-extensions' },
    content
  };
}

function filter(messages: IntercomMessage[], options: { selfMachineId?: string; errorDelayMin?: number } = {}) {
  return filterNotifiableGlobalMessages(messages, CURSOR, NOW_MS, options);
}

describe('extractTags (#3226)', () => {
  it('extracts leading bracket tags from plain content', () => {
    expect(extractTags('[ERROR] watchdog: embedding down')).toEqual(['ERROR']);
  });

  it('extracts tags inside bold markers', () => {
    expect(extractTags('**[DONE]** myia-po-204 c.288')).toEqual(['DONE']);
  });

  it('does not match brackets containing spaces or slashes (not tags)', () => {
    expect(extractTags('[PART 2/2] then [DONE]')).toEqual(['DONE']);
  });

  it('only scans the head of the message', () => {
    const long = 'x'.repeat(300) + ' [ERROR] buried too deep';
    expect(extractTags(long)).toEqual([]);
  });

  it('ignores lowercase and mixed-case brackets', () => {
    expect(extractTags('[done] pas un tag [ask]')).toEqual([]);
  });
});

describe('filterNotifiableGlobalMessages — §4 allow list', () => {
  it('never notifies on INFO, ACK, TASK, DONE, CLAIMED, REPLY, WARN', () => {
    const messages = [
      mkMsg('m1', '2026-08-25T11:00:00Z', 'myia-po-2023', '[INFO] routine'),
      mkMsg('m2', '2026-08-25T11:05:00Z', 'myia-po-2023', '[ACK] acknowledged'),
      mkMsg('m3', '2026-08-25T11:10:00Z', 'myia-po-2025', '[TASK] working'),
      mkMsg('m4', '2026-08-25T11:15:00Z', 'myia-po-2025', '[DONE] finished'),
      mkMsg('m5', '2026-08-25T11:20:00Z', 'myia-web1', '[CLAIMED] claimed'),
      mkMsg('m6', '2026-08-25T11:25:00Z', 'myia-web1', '[REPLY] reply'),
      mkMsg('m7', '2026-08-25T11:30:00Z', 'myia-web1', '[WARN] warn')
    ];
    expect(filter(messages)).toEqual({
      count: 0, errors: 0, clusterHealthTours: [], asks: 0, proposals: 0, blocked: 0, wakes: []
    });
  });

  it('notifies on ASK, PROPOSAL, BLOCKED', () => {
    const messages = [
      mkMsg('a', '2026-08-25T11:00:00Z', 'myia-po-2023', '[ASK] question'),
      mkMsg('p', '2026-08-25T11:01:00Z', 'myia-po-2025', '[PROPOSAL] proposal'),
      mkMsg('b', '2026-08-25T11:02:00Z', 'myia-web1', '[BLOCKED] blocked')
    ];
    const s = filter(messages);
    expect(s.count).toBe(3);
    expect(s.asks).toBe(1);
    expect(s.proposals).toBe(1);
    expect(s.blocked).toBe(1);
  });

  it('notifies on WAKE-* tags (distinct wakes collected)', () => {
    const messages = [
      mkMsg('w1', '2026-08-25T11:00:00Z', 'myia-ai-01', '[WAKE-CLAUDE] myia-po-2023'),
      mkMsg('w2', '2026-08-25T11:01:00Z', 'myia-ai-01', '[WAKE-HERMES]')
    ];
    const s = filter(messages);
    expect(s.count).toBe(2);
    expect(s.wakes).toEqual(['WAKE-CLAUDE', 'WAKE-HERMES']);
  });

  it('counts one notification per message even with multiple notifiable tags', () => {
    const messages = [mkMsg('m', '2026-08-25T11:00:00Z', 'myia-po-2023', '[ASK] [PROPOSAL] both')];
    // ASK is checked first → message counted once as ASK
    const s = filter(messages);
    expect(s.count).toBe(1);
    expect(s.asks).toBe(1);
    expect(s.proposals).toBe(0);
  });
});

describe('filterNotifiableGlobalMessages — ERROR pairing', () => {
  const errorTs = '2026-08-25T10:30:00Z'; // 90 min old — past the 15 min grace

  it('notifies on unmatched ERROR past the grace period', () => {
    const s = filter([mkMsg('e', errorTs, 'myia-web1', '[ERROR] embedding down')]);
    expect(s.errors).toBe(1);
    expect(s.count).toBe(1);
  });

  it('does not notify on a fresh ERROR (inside the grace period)', () => {
    const s = filter([mkMsg('e', '2026-08-25T11:55:00Z', 'myia-web1', '[ERROR] just opened')]);
    expect(s.errors).toBe(0);
    expect(s.count).toBe(0);
  });

  it('respects a custom errorDelayMin', () => {
    const s = filter(
      [mkMsg('e', '2026-08-25T11:55:00Z', 'myia-web1', '[ERROR] just opened')],
      { errorDelayMin: 1 }
    );
    expect(s.errors).toBe(1);
  });

  it('never notifies on an ERROR matched by a later DONE from the same machine', () => {
    const messages = [
      mkMsg('e', errorTs, 'myia-web1', '[ERROR] embedding down'),
      mkMsg('d', '2026-08-25T10:33:00Z', 'myia-web1', '[DONE] embedding back')
    ];
    const s = filter(messages);
    expect(s.errors).toBe(0);
    expect(s.count).toBe(0); // the DONE itself is never notifiable either
  });

  it('matches RESOLVED and FIXED as resolution tags too', () => {
    const messages = [
      mkMsg('e', errorTs, 'myia-web1', '[ERROR] a'),
      mkMsg('r', '2026-08-25T10:40:00Z', 'myia-web1', '[RESOLVED] a fixed'),
      mkMsg('e2', errorTs, 'myia-web1', '[ERROR] b'),
      mkMsg('f', '2026-08-25T10:40:00Z', 'myia-web1', '[FIXED] b fixed')
    ];
    expect(filter(messages).errors).toBe(0);
  });

  it('a DONE from a DIFFERENT machine does not close the ERROR', () => {
    const messages = [
      mkMsg('e', errorTs, 'myia-web1', '[ERROR] embedding down'),
      mkMsg('d', '2026-08-25T10:33:00Z', 'myia-po-2023', '[DONE] unrelated cycle report')
    ];
    expect(filter(messages).errors).toBe(1);
  });

  it('a resolution message OLDER than the error does not close it', () => {
    const messages = [
      mkMsg('d', '2026-08-25T10:00:00Z', 'myia-web1', '[DONE] earlier'),
      mkMsg('e', errorTs, 'myia-web1', '[ERROR] later')
    ];
    expect(filter(messages).errors).toBe(1);
  });

  it('a resolution already SEEN (older than cursor is not required — same stream) still closes a newer ERROR', () => {
    // The matching scans the full snapshot, not just unseen messages: a DONE
    // newer than the ERROR closes it even if that DONE is itself... (it is
    // unseen here) — but critically a DONE the reader has already "seen"
    // cannot resurrect the ERROR as notifiable.
    const messages = [
      mkMsg('e', '2026-08-25T10:30:00Z', 'myia-web1', '[ERROR] x'),
      mkMsg('d', '2026-08-25T10:31:00Z', 'myia-web1', '[DONE] x fixed')
    ];
    expect(filter(messages).errors).toBe(0);
  });
});

describe('filterNotifiableGlobalMessages — CLUSTER-HEALTH tours', () => {
  it('dedupes multiple messages of the same tour', () => {
    const messages = [
      mkMsg('c1', '2026-08-25T11:00:00Z', 'hermes', '[CLUSTER-HEALTH] T#54 flotte 90/100'),
      mkMsg('c2', '2026-08-25T11:05:00Z', 'hermes', '[CLUSTER-HEALTH] T#54 correction')
    ];
    const s = filter(messages);
    expect(s.clusterHealthTours).toEqual(['T#54']);
    expect(s.count).toBe(1);
  });

  it('counts one per distinct tour', () => {
    const messages = [
      mkMsg('c1', '2026-08-25T11:00:00Z', 'hermes', '[CLUSTER-HEALTH] T#54'),
      mkMsg('c2', '2026-08-25T11:05:00Z', 'hermes', '[CLUSTER-HEALTH] T#55')
    ];
    const s = filter(messages);
    expect(s.clusterHealthTours).toEqual(['T#54', 'T#55']);
    expect(s.count).toBe(2);
  });

  it('falls back to message id when no tour label is present', () => {
    const messages = [mkMsg('cx', '2026-08-25T11:00:00Z', 'hermes', '[CLUSTER-HEALTH] digest sans numéro')];
    const s = filter(messages);
    expect(s.clusterHealthTours).toEqual(['cx']);
    expect(s.count).toBe(1);
  });
});

describe('filterNotifiableGlobalMessages — cursor & self boundaries', () => {
  it('excludes messages at or before the cursor (already seen)', () => {
    const messages = [
      mkMsg('old', CURSOR, 'myia-po-2023', '[ASK] at cursor — seen'),
      mkMsg('older', '2026-08-25T09:00:00Z', 'myia-po-2023', '[ASK] before cursor — seen'),
      mkMsg('new', '2026-08-25T11:00:00Z', 'myia-po-2023', '[ASK] after cursor — new')
    ];
    expect(filter(messages).asks).toBe(1);
  });

  it('excludes self-authored messages from the notifiable set', () => {
    const messages = [mkMsg('mine', '2026-08-25T11:00:00Z', 'myia-po-2024', '[ASK] my own ask')];
    const s = filter(messages, { selfMachineId: 'myia-po-2024' });
    expect(s.count).toBe(0);
  });

  it('a self-authored DONE does not close a foreign ERROR (cross-machine rule holds under self-exclusion)', () => {
    const messages = [
      mkMsg('e', '2026-08-25T10:30:00Z', 'myia-web1', '[ERROR] down'),
      mkMsg('d', '2026-08-25T10:31:00Z', 'myia-po-2024', '[DONE] fixed by me (unrelated machine)')
    ];
    const s = filter(messages, { selfMachineId: 'myia-po-2024' });
    expect(s.errors).toBe(1);
  });

  it('resolution matching scans the full snapshot — a resolution and its ERROR both unseen still pair', () => {
    // Reader po-2024; error AND resolution authored by po-2023 (same machine
    // pairing). Both are after the cursor. The DONE must close the ERROR even
    // though the DONE is itself not notifiable.
    const messages = [
      mkMsg('e', '2026-08-25T10:30:00Z', 'myia-po-2023', '[ERROR] down'),
      mkMsg('d', '2026-08-25T10:31:00Z', 'myia-po-2023', '[DONE] back up')
    ];
    const s = filter(messages, { selfMachineId: 'myia-po-2024' });
    expect(s.errors).toBe(0);
    expect(s.count).toBe(0);
  });
});

describe('buildGlobalFooter — §3 shape', () => {
  it('returns null when nothing is notifiable (zero-token calm)', () => {
    expect(buildGlobalFooter({
      count: 0, errors: 0, clusterHealthTours: [], asks: 0, proposals: 0, blocked: 0, wakes: []
    })).toBeNull();
  });

  it('matches the issue example shape', () => {
    const footer = buildGlobalFooter({
      count: 2,
      errors: 1,
      clusterHealthTours: ['T#55'],
      asks: 0,
      proposals: 0,
      blocked: 0,
      wakes: []
    });
    expect(footer).toBe(
      '\n[NOTIF] 2 nouveau(x) sur global depuis ta dernière lecture' +
      '\n        (1 ERROR non résolu, 1 CLUSTER-HEALTH T#55).' +
      '\n        Lire : roosync_dashboard action:"read" type:"global"'
    );
  });

  it('labels multiple tours without per-tour detail', () => {
    const footer = buildGlobalFooter({
      count: 2, errors: 0, clusterHealthTours: ['T#54', 'T#55'], asks: 0, proposals: 0, blocked: 0, wakes: []
    });
    expect(footer).toContain('2 CLUSTER-HEALTH');
    expect(footer).not.toContain('T#54');
  });

  it('pluralizes errors and lists wakes', () => {
    const footer = buildGlobalFooter({
      count: 3, errors: 2, clusterHealthTours: [], asks: 0, proposals: 0, blocked: 0, wakes: ['WAKE-CLAUDE']
    });
    expect(footer).toContain('2 ERROR non résolus');
    expect(footer).toContain('1 WAKE-CLAUDE');
  });
});

describe('cursor persistence', () => {
  let stateDir: string;
  let previousDir: string | undefined;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'global-notif-'));
    previousDir = process.env.GLOBAL_NOTIF_STATE_DIR;
    process.env.GLOBAL_NOTIF_STATE_DIR = stateDir;
    resetGlobalNotifQueueForTests();
  });

  afterEach(async () => {
    if (previousDir === undefined) delete process.env.GLOBAL_NOTIF_STATE_DIR;
    else process.env.GLOBAL_NOTIF_STATE_DIR = previousDir;
    await rm(stateDir, { recursive: true, force: true });
  });

  it('bootstraps to ~now on first read (no backlog replay) and persists it', async () => {
    const before = Date.now();
    const cursor = await getGlobalSeenCursor('myia-po-2024', 'roo-extensions');
    const after = Date.now();
    expect(Date.parse(cursor)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(cursor)).toBeLessThanOrEqual(after);

    const again = await getGlobalSeenCursor('myia-po-2024', 'roo-extensions');
    expect(again).toBe(cursor); // second read returns the persisted value, not a new now

    const raw = JSON.parse(await readFile(path.join(stateDir, 'global-notif-cursor.json'), 'utf8'));
    expect(raw.lastGlobalSeenAt['myia-po-2024|roo-extensions']).toBe(cursor);
  });

  it('advanceGlobalSeenCursor moves the cursor forward', async () => {
    await advanceGlobalSeenCursor('myia-po-2024', 'roo-extensions', '2026-08-25T11:00:00Z');
    expect(await getGlobalSeenCursor('myia-po-2024', 'roo-extensions')).toBe('2026-08-25T11:00:00Z');
  });

  it('is monotonic — a stale advance never moves the cursor backwards', async () => {
    await advanceGlobalSeenCursor('myia-po-2024', 'roo-extensions', '2026-08-25T11:00:00Z');
    await advanceGlobalSeenCursor('myia-po-2024', 'roo-extensions', '2026-08-25T09:00:00Z');
    expect(await getGlobalSeenCursor('myia-po-2024', 'roo-extensions')).toBe('2026-08-25T11:00:00Z');
  });

  it('keeps readers isolated per (machineId, workspace)', async () => {
    await advanceGlobalSeenCursor('myia-po-2024', 'roo-extensions', '2026-08-25T11:00:00Z');
    const other = await getGlobalSeenCursor('myia-po-2024', 'Argumentum');
    expect(other).not.toBe('2026-08-25T11:00:00Z');
  });

  it('survives a corrupt cursor file (treated as empty, re-bootstraps)', async () => {
    await writeFile(path.join(stateDir, 'global-notif-cursor.json'), 'not json at all', 'utf8');
    const cursor = await getGlobalSeenCursor('myia-po-2024', 'roo-extensions');
    expect(Date.parse(cursor)).not.toBeNaN();
  });
});

describe('DEFAULT_ERROR_DELAY_MIN', () => {
  it('defaults to 15 minutes per the issue', () => {
    expect(DEFAULT_ERROR_DELAY_MIN).toBe(15);
  });
});
