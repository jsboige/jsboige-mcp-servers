/**
 * #4915 — the listener append CLI must follow the SAME PG-primary gate as the
 * MCP writer (`writeDashboardFile`, dashboard.ts l.3586):
 *
 *   - gate open, PG ok  → PG is written FIRST (checked variant), then the G:
 *     file is a bounded mirror stamped `mirrorExportAt` (the Phase D marker);
 *     a failed mirror is a WARN — PG holds the message — exit 0;
 *   - PG fails (or gate closed) → the file-first path runs UNCHANGED, no
 *     stamp, and PG is retried after the write (an escalation is never lost);
 *   - gate closed → byte-for-byte the pre-#4915 output.
 *
 * Method: the real CLI runs as a child process against a temp RSM root whose
 * `build/` holds two doubles (store + dashboard module) and a fake clock
 * (`--import`, pinned Date + randomInt) so ids and the stamp are deterministic.
 * The call journal records ordering, and every PG attempt records whether the
 * target file ALREADY carries the appended message id: that flag is the
 * ordering witness, not an inference.
 *
 * The GOLDEN constant was captured from the base CLI (commit 30348860) in this
 * same harness with gate=closed/pg=ok and is frozen here: the gate-closed
 * output must never drift. The real `buildDashboardMarkdown` stamp contract is
 * pinned separately by dashboard-export-stamp.test.ts.
 *
 * Re-review of #4915 (po-2028 04:48Z point 2, po-2024 05:00Z addendum): the PG
 * attempt runs BETWEEN the base read and the full file rewrite and can outlive
 * the append lock TTL (30 s, never renewed). The last describe proves the
 * fallback re-takes the lock and RE-READS its base before rewriting — a
 * concurrent append that landed during the attempt survives — and that a lock
 * that cannot be re-taken degrades to the fail-open `unserialized` path
 * instead of dropping the escalation.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER_ROOT = path.resolve(__dirname, '../../../..');
const FIXTURES = path.join(__dirname, 'fixtures', 'rsm-dashboard-append-pg-primary');

const NEW_ID = 'myia-po-2023:listener:ic-20261124T120000-0000';
const STAMP = '2026-11-24T12:00:00.000Z';
const KEY = 'machine-myia-po-2023';

// Built line by line and joined on '\n': a multi-line literal would turn CRLF
// under core.autocrlf and stop matching the CLI's LF bytes.
const GOLDEN = [
  '---',
  'type: machine',
  `lastModified: ${STAMP}`,
  'totalMessages: 2',
  '---',
  '',
  '## Intercom',
  '',
  '### [2026-11-23T08:00:00.000Z] myia-po-2023|listener',
  '[msg: myia-po-2023:listener:ic-20261123T080000-ab12]',
  '[WARN][LISTENER][#3761] temoin.',
  '',
  `### [${STAMP}] myia-po-2023|listener`,
  `[msg: ${NEW_ID}]`,
  '[WARN][LISTENER][#3761] Reveil non delivrable pour myia-po-2024.',
  '',
].join('\n');

const STAMPED = GOLDEN.replace(
  `totalMessages: 2\n---`,
  `totalMessages: 2\nmirrorExportAt: ${STAMP}\n---`
);

// Re-review #4915: the message another lane appends while our PG attempt runs.
const CONCURRENT_ID = 'myia-po-2024:listener:ic-20261124T115959-0000';

// The target file as the OTHER writer leaves it (store-stub lands exactly
// these bytes during our first PG attempt).
const CONCURRENT_FILE = [
  '---',
  'type: machine',
  '---',
  '',
  '## Intercom',
  '',
  '### [2026-11-24T11:59:59.000Z] myia-po-2024|listener',
  `[msg: ${CONCURRENT_ID}]`,
  '[WARN][LISTENER][#3761] temoin concurrent.',
  '',
].join('\n');

// The fallback rewrite must keep the concurrent message: witness + concurrent
// + ours, counter 3.
const RACE_FILE = [
  '---',
  'type: machine',
  `lastModified: ${STAMP}`,
  'totalMessages: 3',
  '---',
  '',
  '## Intercom',
  '',
  '### [2026-11-23T08:00:00.000Z] myia-po-2023|listener',
  '[msg: myia-po-2023:listener:ic-20261123T080000-ab12]',
  '[WARN][LISTENER][#3761] temoin.',
  '',
  '### [2026-11-24T11:59:59.000Z] myia-po-2024|listener',
  `[msg: ${CONCURRENT_ID}]`,
  '[WARN][LISTENER][#3761] temoin concurrent.',
  '',
  `### [${STAMP}] myia-po-2023|listener`,
  `[msg: ${NEW_ID}]`,
  '[WARN][LISTENER][#3761] Reveil non delivrable pour myia-po-2024.',
  '',
].join('\n');

const EXPECTED_OUTPUT = {
  ok: true,
  key: KEY,
  base: 'file',
  unserialized: false,
  messageId: NEW_ID,
  totalMessages: 2,
  pgSynced: true,
};

type Scenario = {
  gate: 'open' | 'closed';
  pg: 'ok' | 'fail' | 'fail-once' | 'throw';
  writeFail?: boolean;
  // Re-review #4915 knobs (see the fixture docstrings).
  concurrent?: 'during-pg' | 'same-id';
  relock?: 'deny';
  key?: string;       // dashboard key, when argv selects another surface
  argv?: string[];    // full CLI args, replacing the escalation defaults
};

type Run = {
  status: number | null;
  stdout: string;
  stderr: string;
  journal: string[];
  file: string | null;
  parsed: Record<string, unknown> | null;
};

function runScenario(scenario: Scenario): Run {
  const root = mkdtempSync(path.join(tmpdir(), 'rsm-append-4915-'));
  try {
    mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
    copyFileSync(
      path.join(SERVER_ROOT, 'scripts', 'rsm-dashboard-append.mjs'),
      path.join(root, 'scripts', 'rsm-dashboard-append.mjs')
    );
    for (const lib of ['dashboard-journal.mjs', 'resolve-build-dir.mjs']) {
      copyFileSync(
        path.join(SERVER_ROOT, 'scripts', 'lib', lib),
        path.join(root, 'scripts', 'lib', lib)
      );
    }
    mkdirSync(path.join(root, 'build', 'services', 'unified-store'), { recursive: true });
    mkdirSync(path.join(root, 'build', 'tools', 'roosync'), { recursive: true });
    copyFileSync(
      path.join(FIXTURES, 'store-stub.mjs'),
      path.join(root, 'build', 'services', 'unified-store', 'roosync-dashboard-store.js')
    );
    copyFileSync(
      path.join(FIXTURES, 'dashboard-stub.mjs'),
      path.join(root, 'build', 'tools', 'roosync', 'dashboard.js')
    );
    copyFileSync(path.join(FIXTURES, 'fake-clock.mjs'), path.join(root, 'fake-clock.mjs'));

    const journalPath = path.join(root, 'journal.log');
    const key = scenario.key ?? KEY;
    const target = path.join(root, 'out', `${key}.md`);
    if (scenario.writeFail) mkdirSync(target, { recursive: true }); // a directory: writeFile must throw

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('UNIFIED_STORE_')) delete env[k];
    Object.assign(env, {
      RSM_APPEND_TEST_JOURNAL: journalPath,
      RSM_APPEND_TEST_GATE: scenario.gate,
      RSM_APPEND_TEST_PG: scenario.pg,
      RSM_APPEND_TEST_TARGET: target,
      RSM_APPEND_TEST_NEW_ID: NEW_ID,
      RSM_APPEND_TEST_CONCURRENT: scenario.concurrent ?? '',
      RSM_APPEND_TEST_RELOCK: scenario.relock ?? '',
    });

    const res = spawnSync(
      process.execPath,
      [
        '--import', pathToFileURL(path.join(root, 'fake-clock.mjs')).href,
        path.join(root, 'scripts', 'rsm-dashboard-append.mjs'),
        ...(scenario.argv ?? [
          '--machine', 'myia-po-2023',
          '--content', '[WARN][LISTENER][#3761] Reveil non delivrable pour myia-po-2024.',
        ]),
      ],
      { encoding: 'utf8', env, timeout: 30000 }
    );

    const file = !scenario.writeFail && existsSync(target) ? readFileSync(target, 'utf8') : null;
    return {
      status: res.status,
      stdout: res.stdout,
      stderr: res.stderr,
      journal: existsSync(journalPath)
        ? readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)
        : [],
      file,
      parsed: res.stdout.trim() ? (JSON.parse(res.stdout) as Record<string, unknown>) : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const LOCK = `lock:acquire:${KEY}:listener`;
const UNLOCK = `lock:release:${KEY}`;
const sync = (fileHasNew: boolean, attempt: number, messages = 2) =>
  `pg:sync:fileHasNew=${fileHasNew}:messages=${messages}:attempt=${attempt}`;
const withoutGate = (journal: string[]) => journal.filter((l) => !l.startsWith('gate:'));

describe('#4915 gate closed — the pre-existing behaviour, byte for byte', () => {
  it('writes the file first (the PG sync sees the id on disk), no stamp, output unchanged', () => {
    const run = runScenario({ gate: 'closed', pg: 'ok' });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.file).toBe(GOLDEN);
    expect(run.parsed).toEqual(EXPECTED_OUTPUT);
    expect(withoutGate(run.journal)).toEqual([
      LOCK,
      'read',
      'markdown:none',
      'path',
      sync(true, 1),
      UNLOCK,
    ]);
  }, 15000);

  it('a failed file write still exits 1 with no stdout (nothing posted anywhere)', () => {
    const run = runScenario({ gate: 'closed', pg: 'ok', writeFail: true });

    expect(run.status).toBe(1);
    expect(run.stdout.trim()).toBe('');
    expect(run.stderr).toContain('ERREUR');
    expect(withoutGate(run.journal)).toEqual([LOCK, 'read', 'markdown:none', 'path', UNLOCK]);
  }, 15000);

  it('consults the gate (isDashboardPgPrimary) after the base read, before the fold', () => {
    // The gate line sits between the read and the markdown build: the stamp is
    // part of the bytes, so the decision cannot come after the rendering.
    const run = runScenario({ gate: 'closed', pg: 'ok' });

    expect(run.journal).toEqual([LOCK, 'read', 'gate:closed', 'markdown:none', 'path', sync(true, 1), UNLOCK]);
  }, 15000);
});

describe('#4915 gate open + PG ok — PG first, G: is a stamped mirror', () => {
  it('calls PG before the file write and stamps mirrorExportAt in the frontmatter', () => {
    const run = runScenario({ gate: 'open', pg: 'ok' });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.parsed).toEqual(EXPECTED_OUTPUT);
    // Only the stamp line differs from the gate-closed bytes.
    expect(run.file).toBe(STAMPED);
    expect(run.journal).toEqual([
      LOCK,
      'read',
      'gate:open',
      sync(false, 1), // the file did NOT yet carry the id → PG went first
      `markdown:stamp:${STAMP}`,
      'path',
      UNLOCK,
    ]);
  }, 15000);

  it('a failed mirror is a WARN, not a lost message: exit 0 with gdriveDegraded', () => {
    const run = runScenario({ gate: 'open', pg: 'ok', writeFail: true });

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).not.toBe('');
    expect(run.parsed).toEqual({ ...EXPECTED_OUTPUT, gdriveDegraded: expect.any(String) });
    expect(run.stderr).toContain('WARN');
    expect(run.stderr).toContain('miroir');
    expect(run.stderr).not.toContain('ERREUR');
    // One PG attempt only (it succeeded): no post-write re-sync in mirror mode.
    expect(run.journal.filter((l) => l.startsWith('pg:sync:'))).toEqual([sync(false, 1)]);
    expect(run.journal.at(-1)).toBe(UNLOCK);
  }, 15000);
});

describe('#4915 gate open + PG failure — the unchanged file-first fallback', () => {
  it('writes the file first without a stamp, retries PG after the write, exits 0', () => {
    const run = runScenario({ gate: 'open', pg: 'fail' });

    expect(run.status).toBe(0);
    expect(run.file).toBe(GOLDEN); // no stamp: the file is the PRIMARY surface here
    expect(run.parsed).toEqual({ ...EXPECTED_OUTPUT, pgSynced: false });
    expect(run.journal).toEqual([
      LOCK,
      'read',
      'gate:open',
      sync(false, 1), // primary attempt, before the file
      UNLOCK, // re-review: the pre-attempt lock is dropped…
      LOCK, // …and re-taken under a fresh TTL before the base is re-read
      'read',
      'markdown:none',
      'path',
      sync(true, 2), // fallback retry, after the file — the pre-#4915 path
      UNLOCK,
    ]);
    expect(run.stderr).toContain('WARN');
    expect(run.stderr).not.toContain('ERREUR');
  }, 15000);

  it('a single PG miss does not stop the fallback retry from succeeding (pgSynced true)', () => {
    const run = runScenario({ gate: 'open', pg: 'fail-once' });

    expect(run.status).toBe(0);
    expect(run.file).toBe(GOLDEN);
    expect(run.parsed).toEqual(EXPECTED_OUTPUT);
    expect(run.journal.filter((l) => l.startsWith('pg:sync:'))).toEqual([sync(false, 1), sync(true, 2)]);
  }, 15000);

  it('a store that THROWS on the primary attempt is a PG failure too: same fallback', () => {
    const run = runScenario({ gate: 'open', pg: 'throw' });

    expect(run.status).toBe(0);
    expect(run.file).toBe(GOLDEN);
    expect(run.parsed).toEqual({ ...EXPECTED_OUTPUT, pgSynced: false });
    expect(run.journal).toEqual([
      LOCK,
      'read',
      'gate:open',
      sync(false, 1),
      UNLOCK,
      LOCK,
      'read',
      'markdown:none',
      'path',
      sync(true, 2),
      UNLOCK,
    ]);
    expect(run.stderr).toContain('WARN');
    expect(run.stderr).not.toContain('ERREUR');
  }, 15000);

  it('PG failed AND the file write failed → nothing holds the message, exit 1', () => {
    const run = runScenario({ gate: 'open', pg: 'fail', writeFail: true });

    expect(run.status).toBe(1);
    expect(run.stdout.trim()).toBe('');
    expect(run.stderr).toContain('ERREUR');
    expect(run.journal).toEqual([
      LOCK,
      'read',
      'gate:open',
      sync(false, 1),
      UNLOCK,
      LOCK,
      'read',
      'markdown:none',
      'path',
      UNLOCK,
    ]);
  }, 15000);
});

describe('#4915 re-review — the fallback re-takes the lock and re-reads its base', () => {
  it('a concurrent append that landed during the PG attempt survives the fallback rewrite', () => {
    const run = runScenario({ gate: 'open', pg: 'fail', concurrent: 'during-pg' });

    expect(run.status).toBe(0);
    // Witness + concurrent + ours: the rewrite folded on the FRESH base.
    expect(run.file).toBe(RACE_FILE);
    expect(run.parsed).toEqual({ ...EXPECTED_OUTPUT, totalMessages: 3, pgSynced: false });
    expect(run.journal).toEqual([
      LOCK,
      'read',
      'gate:open',
      sync(false, 1), // primary attempt, on the pre-attempt base
      'concurrent:append', // the other writer completes DURING that attempt
      UNLOCK, // the possibly-stale lock is dropped…
      LOCK, // …and re-taken before anything is rewritten
      'read', // base re-read under the fresh lock: it carries the concurrent message
      'markdown:none',
      'path',
      sync(true, 2, 3), // post-write retry, three messages folded
      UNLOCK,
    ]);
    expect(run.stderr).toContain('WARN');
  }, 15000);

  it('a lock that cannot be re-taken proceeds unserialized (fail-open) and never drops the escalation', () => {
    const run = runScenario({ gate: 'open', pg: 'fail', relock: 'deny' });

    expect(run.status).toBe(0);
    expect(run.file).toBe(GOLDEN); // no concurrent writer: the escalation is written anyway
    expect(run.parsed).toEqual({ ...EXPECTED_OUTPUT, pgSynced: false, unserialized: true });
    expect(run.journal).toEqual([
      LOCK,
      'read',
      'gate:open',
      sync(false, 1),
      UNLOCK, // release attempt on the stolen lock is a no-op in the API
      `lock:acquire:refused:${KEY}:listener`,
      'read', // the re-read still runs: it is what makes the rewrite safe
      'markdown:none',
      'path',
      sync(true, 2),
    ]);
    expect(run.journal.at(-1)).not.toBe(UNLOCK); // never owned → never released
  }, 15000);

  it('a stable id that landed during the PG attempt is a dedup, not a second message (#4090)', () => {
    const K = 'workspace-myia-po-2023-roo-extensions';
    const L = `lock:acquire:${K}:listener`;
    const U = `lock:release:${K}`;
    const run = runScenario({
      gate: 'open',
      pg: 'fail',
      concurrent: 'same-id',
      key: K,
      argv: [
        '--machine', 'myia-po-2023',
        '--dashboard', 'workspace:roo-extensions',
        '--message-id', NEW_ID,
        '--author-workspace', 'roo-extensions',
        '--content', '[WARN] temoin id stable.',
      ],
    });

    expect(run.status).toBe(0);
    expect(run.parsed).toEqual({
      ok: true,
      key: K,
      base: 'file',
      deduplicated: true,
      messageId: NEW_ID,
      totalMessages: 2,
    });
    // Nothing is written: the fresh base already carries our stable id, and the
    // file is exactly what the other writer left (it landed OUR id — that is
    // what makes this the re-post case).
    expect(run.file).toBe(CONCURRENT_FILE.replace(`[msg: ${CONCURRENT_ID}]`, `[msg: ${NEW_ID}]`));
    expect(run.journal).toEqual([L, 'read', 'gate:open', sync(false, 1), 'concurrent:append', U, L, 'read', U]);
  }, 15000);
});