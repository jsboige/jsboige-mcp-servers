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
 * `build/` holds three doubles (store, dashboard module, markdown parser) and a
 * fake clock (`--import`, pinned Date + randomInt) so ids and the stamp are
 * deterministic. The call journal records ordering, and every PG attempt
 * records whether the target file ALREADY carries the appended message id:
 * that flag is the ordering witness, not an inference.
 *
 * The GOLDEN constant was captured from the base CLI (commit 30348860) in this
 * same harness with gate=closed/pg=ok and is frozen here: the gate-closed
 * output must never drift. The real `buildDashboardMarkdown` stamp contract is
 * pinned separately by dashboard-export-stamp.test.ts.
 *
 * Re-review of #4915 (po-2028 04:48Z point 2, po-2024 05:00Z addendum): the PG
 * attempt runs BETWEEN the base read and the full file rewrite and can outlive
 * the append lock TTL (30 s, never renewed). The CLI re-takes the lock and
 * RE-READS its base before rewriting — a concurrent append that landed during
 * the attempt survives — and a lock that cannot be re-taken degrades to the
 * fail-open `unserialized` path instead of dropping the escalation.
 *
 * Review ms#1919 (ai-01, 25/11 — CHANGES_REQUESTED on 7eca4d8c): the read
 * double above used to answer from a fixed witness, so the harness could not
 * show what the review measured — `readDashboardFile` answers from PG as soon
 * as the key has a readable row there (dashboard.ts:2651-2669). An append
 * whose own PG attempt failed exists ONLY in the file, and that read does not
 * see it. Two ways to lose it, two regression witnesses:
 *   1. fallback after a PG failure — the re-read base comes from PG, not from
 *      the file; the rewrite must still keep the file-only append. The double
 *      now has a real PG view (`pgRead: 'pg'`) that never carries the
 *      concurrent message, so the two sources are DISTINGUISHED here.
 *   2. PG success — the attempt can be LATE (past the lock TTL): the mirror
 *      must not be rewritten, nor stamped, from the pre-attempt base when the
 *      file carries a message PG does not hold (`gdriveSkipped: true`).
 * Every witness of those describes is RED on 7eca4d8c and GREEN on the fixed
 * head; the mutations listed in the PR body prove it.
 *
 * Tier-2 review ms#1919 (ai-01, 26/11 15:59Z — CHANGES_REQUESTED on 2cb4e0bb):
 *   1. a STATUS change writes no message, so `fileOnlyMessages` is blind to it
 *      — after a PG success the mirror compared the intercom only. The witness
 *      lands a status change on the file during the attempt and requires the
 *      mirror to be skipped, not stamped. Its control keeps a file that is
 *      merely BEHIND PG mirrored (otherwise the mirror would freeze forever).
 *   2. `readDashboardFile` can answer `null` after a PG failure: a retired key,
 *      an absent file — or an UNDETERMINED absence. The witness seeds a
 *      file-only append, makes the re-read answer `null` and requires the file
 *      to be left untouched. The explicit-retirement case (#3782) stays a fresh
 *      file and now states its mark. Both are RED on 2cb4e0bb; the PR comment
 *      lists the mutations.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER_ROOT = path.resolve(__dirname, '../../../..');
const FIXTURES = path.join(__dirname, 'fixtures', 'rsm-dashboard-append-pg-primary');

const NEW_ID = 'myia-po-2023:listener:ic-20261124T120000-0000';
const STAMP = '2026-11-24T12:00:00.000Z';
const KEY = 'machine-myia-po-2023';
const OUR_CONTENT = '[WARN][LISTENER][#3761] Reveil non delivrable pour myia-po-2024.';

const WITNESS_ID = 'myia-po-2023:listener:ic-20261123T080000-ab12';
const WITNESS_STAMP = '2026-11-23T08:00:00.000Z';
const CONCURRENT_ID = 'myia-po-2024:listener:ic-20261124T115959-0000';
const CONCURRENT_STAMP = '2026-11-24T11:59:59.000Z';
const FILE_ONLY_ID = 'myia-po-2025:listener:ic-20261124T100000-0000';

// One intercom block, as the renderer twin emits it (trailing newline).
const block = (timestamp: string, machineId: string, id: string, content: string) =>
  `### [${timestamp}] ${machineId}|listener\n[msg: ${id}]\n${content}\n`;

const WITNESS_BLOCK = block(WITNESS_STAMP, 'myia-po-2023', WITNESS_ID, '[WARN][LISTENER][#3761] temoin.');
const OUR_BLOCK = block(STAMP, 'myia-po-2023', NEW_ID, OUR_CONTENT);
const concurrentBlock = (id: string = CONCURRENT_ID) =>
  block(CONCURRENT_STAMP, 'myia-po-2024', id, '[WARN][LISTENER][#3761] temoin concurrent.');
const FILE_ONLY_BLOCK = block(
  '2026-11-24T10:00:00.000Z',
  'myia-po-2025',
  FILE_ONLY_ID,
  '[WARN][LISTENER][#3761] ajout uniquement fichier.'
);

// Joined on '\n': a multi-line literal would turn CRLF under core.autocrlf
// and stop matching the CLI's LF bytes. Each block ends with its own '\n', so
// the join leaves exactly one blank line between two blocks.
// `status` (optional) emits the `## Status` section the real renderer writes
// (dashboard.ts `buildDashboardMarkdown`); without it the bytes are unchanged.
const dashboardFile = (
  lastModified: string,
  totalMessages: number,
  blocks: string[],
  status?: string
) =>
  [
    '---',
    'type: machine',
    `lastModified: ${lastModified}`,
    `totalMessages: ${totalMessages}`,
    '---',
    '',
    ...(status === undefined ? [] : ['## Status', '', status, '']),
    '## Intercom',
    '',
    ...blocks,
  ].join('\n');

const withStamp = (file: string, totalMessages: number) =>
  file.replace(
    `totalMessages: ${totalMessages}\n---`,
    `totalMessages: ${totalMessages}\nmirrorExportAt: ${STAMP}\n---`
  );

/** The target before the run: one existing message. */
const SEED_FILE = dashboardFile(WITNESS_STAMP, 1, [WITNESS_BLOCK]);

/** Gate-closed bytes (frozen — captured from the base CLI). */
const GOLDEN = dashboardFile(STAMP, 2, [WITNESS_BLOCK, OUR_BLOCK]);

const STAMPED = withStamp(GOLDEN, 2);

/** The target as the OTHER writer leaves it (store-stub lands exactly these bytes). */
const CONCURRENT_FILE = dashboardFile(CONCURRENT_STAMP, 2, [WITNESS_BLOCK, concurrentBlock()]);

/** The fallback rewrite keeps the concurrent message: witness + concurrent + ours. */
const RACE_FILE = dashboardFile(STAMP, 3, [WITNESS_BLOCK, concurrentBlock(), OUR_BLOCK]);

/** A message that exists only in the file BEFORE our run even starts. */
const FILE_ONLY_SEED = dashboardFile('2026-11-24T10:00:00.000Z', 2, [WITNESS_BLOCK, FILE_ONLY_BLOCK]);

/** Ours alone: the base of a key that was absent or retired at the re-read. */
const FRESH_FILE = dashboardFile(STAMP, 1, [OUR_BLOCK]);

// ── Tier-2 review ms#1919 (ai-01, 26/11) — the two formal blockers ──────────

const OLD_STATUS = '*Statut d’avant l’essai PG.*';

/**
 * The target carries a status: what a mirror would render over. Used both by
 * the status-change witness (the file moves AHEAD of the base) and by its
 * control (the file is BEHIND a PG that is ahead — the ordinary state of a
 * mirror between two exports).
 */
const STATUS_SEED = dashboardFile(WITNESS_STAMP, 1, [WITNESS_BLOCK], OLD_STATUS);

/**
 * The target as a STATUS update leaves it during our PG attempt: the SAME
 * intercom (blocker 1 — "sans ajout de message"), a different status, a newer
 * `lastModified`. The store stub lands exactly these bytes.
 */
const STATUS_CHANGED_FILE = dashboardFile(
  CONCURRENT_STAMP,
  1,
  [WITNESS_BLOCK],
  '*Statut changé pendant l’essai PG.*'
);

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
  writeFail?: boolean; // target is a DIRECTORY: unreadable file half AND a failing write
  // Re-review #4915 knobs (see the fixture docstrings).
  concurrent?: 'during-pg' | 'same-id' | 'status';
  relock?: 'deny';
  key?: string;       // dashboard key, when argv selects another surface
  argv?: string[];    // full CLI args, replacing the escalation defaults
  // Review ms#1919 knobs.
  readOnly?: boolean; // seeded, then write-protected: the read succeeds, the write throws
  pgRead?: 'pg' | 'pg-ahead'; // PG answers the reads (dashboard.ts PG-first) — never the concurrent append
  retired?: 'reread'; // readDashboardFile answers null from the re-read on
  retirementMark?: boolean; // …and a retirement mark CONFIRMS it (#3782); unset = unconfirmed
  absentFirst?: boolean; // pre-review 26/11 (1): the FIRST read answers null, the file exists
  // Re-review ms#1919 (web1, 27/11): each PG attempt journals the message ids it carries.
  syncIds?: boolean;
  seed?: string | null; // file state before the run (default SEED_FILE; null = no file)
};

type Run = {
  status: number | null;
  stdout: string;
  stderr: string;
  journal: string[];
  file: string | null;
  parsed: Record<string, unknown> | null;
};

const isRegularFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

function runScenario(scenario: Scenario): Run {
  const root = mkdtempSync(path.join(tmpdir(), 'rsm-append-4915-'));
  const target = path.join(root, 'out', `${scenario.key ?? KEY}.md`);
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
    copyFileSync(
      path.join(FIXTURES, 'dashboard-markdown-stub.mjs'),
      path.join(root, 'build', 'tools', 'roosync', 'dashboard-markdown.js')
    );
    copyFileSync(path.join(FIXTURES, 'fake-clock.mjs'), path.join(root, 'fake-clock.mjs'));

    const journalPath = path.join(root, 'journal.log');
    if (scenario.writeFail) {
      mkdirSync(target, { recursive: true }); // a directory: readFile and writeFile must throw
    } else if (scenario.seed !== null) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, scenario.seed ?? SEED_FILE, 'utf8');
      if (scenario.readOnly) chmodSync(target, 0o444); // the read still works, the write throws
    }

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
      RSM_APPEND_TEST_PG_READ: scenario.pgRead ?? '',
      RSM_APPEND_TEST_RETIRED: scenario.retired ?? '',
      RSM_APPEND_TEST_RETIRED_MARK: scenario.retirementMark ? '1' : '',
      RSM_APPEND_TEST_ABSENT: scenario.absentFirst ? 'first' : '',
      RSM_APPEND_TEST_SYNC_IDS: scenario.syncIds ? '1' : '',
    });

    const res = spawnSync(
      process.execPath,
      [
        '--import', pathToFileURL(path.join(root, 'fake-clock.mjs')).href,
        path.join(root, 'scripts', 'rsm-dashboard-append.mjs'),
        ...(scenario.argv ?? ['--machine', 'myia-po-2023', '--content', OUR_CONTENT]),
      ],
      { encoding: 'utf8', env, timeout: 30000 }
    );

    return {
      status: res.status,
      stdout: res.stdout,
      stderr: res.stderr,
      journal: existsSync(journalPath)
        ? readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)
        : [],
      file: isRegularFile(target) ? readFileSync(target, 'utf8') : null,
      parsed: res.stdout.trim() ? (JSON.parse(res.stdout) as Record<string, unknown>) : null,
    };
  } finally {
    if (scenario.readOnly) {
      try {
        chmodSync(target, 0o666); // restore the attribute before the recursive removal
      } catch {
        // nothing to restore (the harness is about to remove the root anyway)
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const LOCK = `lock:acquire:${KEY}:listener`;
const UNLOCK = `lock:release:${KEY}`;
const REFUSED = `lock:acquire:refused:${KEY}:listener`;
const STAMP_LINE = `markdown:stamp:${STAMP}`;
const sync = (fileHasNew: boolean, attempt: number, messages = 2) =>
  `pg:sync:fileHasNew=${fileHasNew}:messages=${messages}:attempt=${attempt}`;
const withoutGate = (journal: string[]) => journal.filter((l) => !l.startsWith('gate:'));
const pgSyncLines = (journal: string[]) => journal.filter((l) => l.startsWith('pg:sync:'));

describe('#4915 gate closed — the pre-existing behaviour, byte for byte', () => {
  it('writes the file first (the PG sync sees the id on disk), no stamp, output unchanged', () => {
    const run = runScenario({ gate: 'closed', pg: 'ok' });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.file).toBe(GOLDEN);
    expect(run.parsed).toEqual(EXPECTED_OUTPUT);
    // No second lock take and no second read: the gate-closed path is untouched.
    expect(withoutGate(run.journal)).toEqual([
      LOCK,
      'read:file',
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
    expect(withoutGate(run.journal)).toEqual([LOCK, 'read:unreadable', 'markdown:none', 'path', UNLOCK]);
  }, 15000);

  it('consults the gate (isDashboardPgPrimary) after the base read, before the fold', () => {
    // The gate line sits between the read and the markdown build: the stamp is
    // part of the bytes, so the decision cannot come after the rendering.
    const run = runScenario({ gate: 'closed', pg: 'ok' });

    expect(run.journal).toEqual([
      LOCK,
      'read:file',
      'gate:closed',
      'markdown:none',
      'path',
      sync(true, 1),
      UNLOCK,
    ]);
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
      'read:file',
      'gate:open',
      sync(false, 1), // the file did NOT yet carry the id → PG went first
      UNLOCK, // review ms#1919: the pre-attempt lock is dropped on SUCCESS too…
      LOCK, // …and re-taken before anything is read from or written to the file
      'path', // resolved once, under the re-taken lock
      STAMP_LINE,
      UNLOCK,
    ]);
  }, 15000);

  it('a key that was absent and has NO file gets its mirror: nothing on disk to preserve', () => {
    // Pre-review 26/11: "absent" alone no longer means "nothing to preserve" —
    // see the pre-review describe for a key whose file exists.
    const run = runScenario({ gate: 'open', pg: 'ok', seed: null });

    expect(run.status).toBe(0);
    expect(run.file).toBe(withStamp(FRESH_FILE, 1));
    expect(run.parsed).toEqual({ ...EXPECTED_OUTPUT, base: 'created', totalMessages: 1 });
    expect(run.journal).toEqual([
      LOCK,
      'read:null',
      'gate:open',
      sync(false, 1, 1),
      UNLOCK,
      LOCK,
      'path',
      STAMP_LINE,
      UNLOCK,
    ]);
  }, 15000);

  it('a failed mirror is a WARN, not a lost message: exit 0 with gdriveDegraded', () => {
    // The file half reads fine (nothing file-only), the WRITE alone fails.
    const run = runScenario({ gate: 'open', pg: 'ok', readOnly: true });

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).not.toBe('');
    expect(run.parsed).toEqual({ ...EXPECTED_OUTPUT, gdriveDegraded: expect.any(String) });
    expect(run.stderr).toContain('WARN');
    expect(run.stderr).toContain('miroir');
    expect(run.stderr).not.toContain('ERREUR');
    expect(run.file).toBe(SEED_FILE); // write-protected: nothing landed
    // One PG attempt only (it succeeded): no post-write re-sync in mirror mode.
    expect(pgSyncLines(run.journal)).toEqual([sync(false, 1)]);
    expect(run.journal.at(-1)).toBe(UNLOCK);
  }, 15000);

  it('an unreadable file half is NOT overwritten: no mirror, no stamp, gdriveSkipped', () => {
    // Directory target: reading the file half fails, so the CLI cannot know
    // whether the file holds an append PG lacks. It writes nothing at all.
    const run = runScenario({ gate: 'open', pg: 'ok', writeFail: true });

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).not.toBe('');
    expect(run.parsed).toEqual({ ...EXPECTED_OUTPUT, gdriveSkipped: true });
    expect(run.stderr).toContain('WARN');
    expect(run.stderr).toContain('miroir');
    expect(run.stderr).toContain('illisible');
    expect(run.stderr).not.toContain('ERREUR');
    expect(run.journal).toEqual([
      LOCK,
      'read:unreadable',
      'gate:open',
      sync(false, 1),
      UNLOCK,
      LOCK,
      'path',
      UNLOCK, // no markdown line: the file was never rendered
    ]);
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
      'read:file',
      'gate:open',
      sync(false, 1), // primary attempt, before the file
      UNLOCK, // re-review: the pre-attempt lock is dropped…
      LOCK, // …and re-taken under a fresh TTL before the base is re-read
      'path',
      'read:file',
      'markdown:none',
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
    expect(pgSyncLines(run.journal)).toEqual([sync(false, 1), sync(true, 2)]);
  }, 15000);

  it('a store that THROWS on the primary attempt is a PG failure too: same fallback', () => {
    const run = runScenario({ gate: 'open', pg: 'throw' });

    expect(run.status).toBe(0);
    expect(run.file).toBe(GOLDEN);
    expect(run.parsed).toEqual({ ...EXPECTED_OUTPUT, pgSynced: false });
    expect(run.journal).toEqual([
      LOCK,
      'read:file',
      'gate:open',
      sync(false, 1),
      UNLOCK,
      LOCK,
      'path',
      'read:file',
      'markdown:none',
      sync(true, 2),
      UNLOCK,
    ]);
    expect(run.stderr).toContain('WARN');
    expect(run.stderr).not.toContain('ERREUR');
  }, 15000);

  it('PG failed AND the file half unreadable → rewrite refused, exit 1 when PG fails again', () => {
    // Pre-review 26/11 constat 2: the file half cannot be read, so a whole-file
    // rewrite would blind-overwrite it. It is refused (no `markdown` line at
    // all) and the message is offered to PG one more time; that second attempt
    // is the only surface left, and when it fails nothing holds the message.
    const run = runScenario({ gate: 'open', pg: 'fail', writeFail: true });

    expect(run.status).toBe(1);
    expect(run.stdout.trim()).toBe('');
    expect(run.stderr).toContain('ERREUR');
    expect(run.stderr).toContain('repli fichier refusé');
    expect(run.stderr).toContain('aucune surface ne tient le message');
    expect(run.journal).toEqual([
      LOCK,
      'read:unreadable',
      'gate:open',
      sync(false, 1), // the failed primary attempt
      UNLOCK,
      LOCK,
      'path',
      'read:unreadable', // the re-read, then the file half fails
      sync(false, 2), // the only surface left — and it fails too
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
      'read:file',
      'gate:open',
      sync(false, 1), // primary attempt, on the pre-attempt base
      'concurrent:append', // the other writer completes DURING that attempt
      UNLOCK, // the possibly-stale lock is dropped…
      LOCK, // …and re-taken before anything is rewritten
      'path',
      'read:file', // base re-read under the fresh lock: it carries the concurrent message
      'markdown:none',
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
      'read:file',
      'gate:open',
      sync(false, 1),
      UNLOCK, // the release attempt on the stolen lock is a no-op in the API
      REFUSED,
      'path',
      'read:file', // the re-read still runs: it is what makes the rewrite safe
      'markdown:none',
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
    // Nothing is written: the base carries our stable id, and the file is
    // exactly what the other writer left (it landed OUR id — that is what makes
    // this the re-post case).
    expect(run.file).toBe(
      dashboardFile(CONCURRENT_STAMP, 2, [WITNESS_BLOCK, concurrentBlock(NEW_ID)])
    );
    expect(run.journal).toEqual([
      L,
      'read:file',
      'gate:open',
      sync(false, 1),
      'concurrent:append',
      U,
      L,
      'path',
      'read:file',
      U,
    ]);
  }, 15000);
});

// ── Review ms#1919, item 1 ─────────────────────────────────────────────────
describe('ms#1919 (1) — the fallback keeps an append that exists only in the FILE', () => {
  it('a PG-answered re-read does not hide the concurrent append: the rewrite keeps it', () => {
    // `pgRead: 'pg'` = the real priority: the re-read answers from PG, which
    // never received the concurrent append (its own attempt failed too). Only
    // the direct read of the file half can see it — and the rewrite must keep it.
    const run = runScenario({ gate: 'open', pg: 'fail', pgRead: 'pg', concurrent: 'during-pg' });

    expect(run.status).toBe(0);
    expect(run.file).toBe(RACE_FILE); // RED on 7eca4d8c: GOLDEN there (append erased)
    expect(run.parsed).toEqual({ ...EXPECTED_OUTPUT, totalMessages: 3, pgSynced: false });
    expect(run.journal).toEqual([
      LOCK,
      'read:pg', // the base comes from PG, without the concurrent message
      'gate:open',
      sync(false, 1),
      'concurrent:append', // it lands in the FILE only
      UNLOCK,
      LOCK,
      'path',
      'read:pg', // the re-read answers from PG again — same blind spot
      'markdown:none', // …but the file half was read directly: the append survives
      sync(true, 2, 3), // and the post-write sync carries it to PG
      UNLOCK,
    ]);
    expect(run.stderr).toContain('WARN');
  }, 15000);

  it('a key retired before the re-read is not rebuilt from its file (#3782 guard kept)', () => {
    const run = runScenario({
      gate: 'open',
      pg: 'fail',
      pgRead: 'pg',
      concurrent: 'during-pg',
      retired: 'reread',
      // The EXPLICIT retirement case (tier-2 review): the null is confirmed by
      // an active mark, which is what authorises ignoring the file.
      retirementMark: true,
    });

    expect(run.status).toBe(0);
    // Nothing from the file half is resurrected: the base is a fresh dashboard.
    expect(run.file).toBe(FRESH_FILE);
    expect(run.parsed).toEqual({
      ...EXPECTED_OUTPUT,
      base: 'created',
      totalMessages: 1,
      pgSynced: false,
    });
    expect(run.journal).toEqual([
      LOCK,
      'read:pg',
      'gate:open',
      sync(false, 1),
      'concurrent:append',
      UNLOCK,
      LOCK,
      'path',
      'read:retired', // null → the file half is not FOLDED, but it is read…
      'retirement:mark', // …and only the confirmed mark lets it be ignored
      'markdown:none',
      sync(true, 2, 1),
      UNLOCK,
    ]);
  }, 15000);
});

// ── Review ms#1919, item 2 ─────────────────────────────────────────────────
describe('ms#1919 (2) — a LATE PG success never rewrites nor stamps a stale mirror', () => {
  it('a concurrent append landed during the attempt → no mirror write, no stamp, gdriveSkipped', () => {
    const run = runScenario({ gate: 'open', pg: 'ok', concurrent: 'during-pg' });

    expect(run.status).toBe(0);
    // The file is exactly what the other writer left: untouched, unstamped.
    expect(run.file).toBe(CONCURRENT_FILE);
    expect(run.parsed).toEqual({ ...EXPECTED_OUTPUT, gdriveSkipped: true });
    expect(run.stderr).toContain('WARN');
    expect(run.stderr).toContain('miroir');
    expect(run.stderr).toContain('ajout');
    expect(run.stderr).not.toContain('ERREUR');
    expect(pgSyncLines(run.journal)).toEqual([sync(false, 1)]);
    expect(run.journal).toEqual([
      LOCK,
      'read:file',
      'gate:open',
      sync(false, 1),
      'concurrent:append',
      UNLOCK,
      LOCK,
      'path',
      UNLOCK, // no markdown line: the mirror was skipped, and nothing was stamped
    ]);
  }, 15000);

  it('a file-only append that predates the attempt is not erased either', () => {
    // No concurrent writer during OUR attempt: the file already held a message
    // from another lane (its PG attempt failed). The mirror would drop it.
    const run = runScenario({ gate: 'open', pg: 'ok', pgRead: 'pg', seed: FILE_ONLY_SEED });

    expect(run.status).toBe(0);
    expect(run.file).toBe(FILE_ONLY_SEED); // untouched
    expect(run.parsed).toEqual({ ...EXPECTED_OUTPUT, gdriveSkipped: true });
    expect(run.stderr).toContain('ajout');
    expect(run.journal).toEqual([
      LOCK,
      'read:pg',
      'gate:open',
      sync(false, 1),
      UNLOCK,
      LOCK,
      'path',
      UNLOCK,
    ]);
  }, 15000);

  it('a lock that cannot be re-taken after a PG success leaves the mirror alone', () => {
    const run = runScenario({ gate: 'open', pg: 'ok', relock: 'deny' });

    expect(run.status).toBe(0);
    expect(run.file).toBe(SEED_FILE); // untouched
    expect(run.parsed).toEqual({ ...EXPECTED_OUTPUT, gdriveSkipped: true });
    expect(run.stderr).toContain('miroir');
    expect(run.journal).toEqual([
      LOCK,
      'read:file',
      'gate:open',
      sync(false, 1),
      UNLOCK,
      REFUSED,
      'path',
    ]);
  }, 15000);
});

// ── Pre-review ms#1919 (ai-01, 26/11 04:03Z — two constats) ────────────────
describe('ms#1919 pre-review — the two constats on the previous head', () => {
  it('a key PG answers null for still guards its file: no mirror, no erase', () => {
    // Constat 1: the first read answers null (absent/retired key) while the
    // file holds another lane's messages. ON 808b809d this path skipped the
    // file half entirely and mirrored a ONE-message state over it.
    const run = runScenario({ gate: 'open', pg: 'ok', absentFirst: true, seed: FILE_ONLY_SEED });

    expect(run.status).toBe(0);
    expect(run.file).toBe(FILE_ONLY_SEED); // untouched — nothing was mirrored over it
    expect(run.parsed).toEqual({
      ok: true,
      key: KEY,
      base: 'created',
      unserialized: false,
      messageId: NEW_ID,
      totalMessages: 1,
      pgSynced: true,
      gdriveSkipped: true,
    });
    expect(run.stderr).toContain('miroir');
    expect(run.stderr).toContain('ajout');
    expect(run.stderr).not.toContain('ERREUR');
    expect(run.journal).toEqual([
      LOCK,
      'read:absent',
      'gate:open',
      sync(false, 1, 1),
      UNLOCK,
      LOCK,
      'path',
      UNLOCK, // no markdown line: the mirror was skipped
    ]);
  }, 15000);

  it('an unreadable file half refuses the fallback rewrite and holds the message in PG', () => {
    // Constat 2: PG failed AND the file half cannot be read. A whole-file
    // rewrite would blind-overwrite it. Refused; the PG retry carries it.
    const run = runScenario({ gate: 'open', pg: 'fail-once', writeFail: true });

    expect(run.status).toBe(0);
    expect(run.file).toBeNull(); // the directory was never replaced by a file
    expect(run.parsed).toEqual({
      ...EXPECTED_OUTPUT,
      gdriveSkipped: true,
      fileRewriteSkipped: expect.any(String),
    });
    expect(run.stderr).toContain('repli fichier refusé');
    expect(run.stderr).toContain('illisible');
    expect(run.stderr).not.toContain('ERREUR');
    expect(pgSyncLines(run.journal)).toEqual([sync(false, 1), sync(false, 2)]);
    expect(run.journal).toEqual([
      LOCK,
      'read:unreadable',
      'gate:open',
      sync(false, 1), // the failed primary attempt
      UNLOCK,
      LOCK,
      'path',
      'read:unreadable', // the re-read, then the file half fails
      sync(false, 2), // the only surface left: PG, second bounded attempt
      UNLOCK,
    ]);
  }, 15000);
});

// ── Tier-2 review ms#1919 (ai-01, 26/11 15:59Z — the two formal blockers) ────
describe('ms#1919 tier-2 review — a status change during the attempt, an undetermined absence', () => {
  it('blocker 1 — a STATUS change that landed during the PG attempt, intercom identical: no mirror, no stamp', () => {
    // No message comparison can see this write: the intercom is the same. On
    // 2cb4e0bb the mirror renders the pre-attempt status over the newer one
    // and stamps the result `mirrorExportAt` — "export à jour" while it is not.
    const run = runScenario({ gate: 'open', pg: 'ok', concurrent: 'status', seed: STATUS_SEED });

    expect(run.status).toBe(0);
    // The file is exactly what the status writer left: untouched, unstamped.
    expect(run.file).toBe(STATUS_CHANGED_FILE); // RED on 2cb4e0bb: status replaced, then stamped
    expect(run.parsed).toEqual({ ...EXPECTED_OUTPUT, gdriveSkipped: true });
    expect(run.stderr).toContain('WARN');
    expect(run.stderr).toContain('miroir');
    expect(run.stderr).toContain('statut');
    expect(run.stderr).not.toContain('ERREUR');
    expect(pgSyncLines(run.journal)).toEqual([sync(false, 1)]);
    expect(run.journal).toEqual([
      LOCK,
      'read:file',
      'gate:open',
      sync(false, 1),
      'concurrent:status', // a status only: no message lands
      UNLOCK,
      LOCK,
      'path',
      UNLOCK, // no markdown line: the mirror was skipped, and nothing was stamped
    ]);
  }, 15000);

  it('blocker 1, control — a file merely BEHIND PG (older status, older stamp) still gets its mirror', () => {
    // The ordinary state of a mirror between two exports: PG holds a newer
    // status than the file. Refusing here would freeze the file for good — the
    // file is not "newer", it is stale, and the mirror is the catch-up.
    const run = runScenario({ gate: 'open', pg: 'ok', pgRead: 'pg-ahead', seed: STATUS_SEED });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.file).toBe(STAMPED); // the catch-up mirror IS written, and stamped
    expect(run.parsed).toEqual(EXPECTED_OUTPUT);
    expect(run.journal).toEqual([
      LOCK,
      'read:pg',
      'gate:open',
      sync(false, 1),
      UNLOCK,
      LOCK,
      'path',
      STAMP_LINE,
      UNLOCK,
    ]);
  }, 15000);

  it('blocker 2 — a NULL re-read while the file EXISTS and no retirement confirms it: rewrite refused', () => {
    // `readDashboardFile` answered null, the file holds another lane's
    // messages, and NOTHING says the key is retired. On 2cb4e0bb the empty
    // state is written over the file: its content is erased. An unconfirmed
    // absence is an unknown base, not an empty one.
    // Re-review ms#1919 (web1, 27/11): the refusal protects the FILE, not the
    // PG half — the retry carries the base of the first attempt (id for id in
    // the re-review block below), so the output names that base.
    const run = runScenario({ gate: 'open', pg: 'fail-once', seed: FILE_ONLY_SEED, retired: 'reread' });

    expect(run.status).toBe(0);
    expect(run.file).toBe(FILE_ONLY_SEED); // RED on 2cb4e0bb: replaced by FRESH_FILE
    expect(run.parsed).toEqual({
      ok: true,
      key: KEY,
      base: 'file',
      unserialized: false,
      messageId: NEW_ID,
      totalMessages: 3,
      pgSynced: true,
      gdriveSkipped: true,
      fileRewriteSkipped: expect.any(String),
    });
    expect(run.stderr).toContain('repli fichier refusé');
    expect(run.stderr).toContain('indétermin');
    expect(run.stderr).not.toContain('ERREUR');
    expect(run.journal).toEqual([
      LOCK,
      'read:file',
      'gate:open',
      sync(false, 1, 3), // the failed primary attempt: the file's two messages + ours
      UNLOCK,
      LOCK,
      'path',
      'read:undetermined', // null, while the file is there…
      'retirement:none', // …and nothing confirms a retirement
      sync(false, 2, 3), // no markdown line: the file is not rewritten; PG holds the same three
      UNLOCK,
    ]);
  }, 15000);

  it('blocker 2, control — a NULL re-read with NO file still writes the escalation (nothing to preserve)', () => {
    // The #3761 promise on a brand-new machine key while PG is down: with no
    // file, the empty base is the TRUE base and the write must happen.
    const run = runScenario({ gate: 'open', pg: 'fail', seed: null });

    expect(run.status).toBe(0);
    expect(run.file).toBe(FRESH_FILE);
    expect(run.parsed).toEqual({
      ...EXPECTED_OUTPUT,
      base: 'created',
      totalMessages: 1,
      pgSynced: false,
    });
    expect(run.journal).toEqual([
      LOCK,
      'read:null',
      'gate:open',
      sync(false, 1, 1),
      UNLOCK,
      LOCK,
      'path',
      'read:null',
      // no `retirement:` line: with no file there is nothing a mark would change
      'markdown:none',
      sync(true, 2, 1),
      UNLOCK,
    ]);
  }, 15000);
});

// ── Re-review ms#1919 (web1, 27/11 00:17Z — the residue on head 3be4fce1) ────
describe('ms#1919 re-review (web1) — a refused rewrite still owes PG the base of the first attempt', () => {
  it('the second attempt carries the first one’s payload, id for id', () => {
    // On 3be4fce1 the refusal rebuilt `next` from an EMPTY state: the file was
    // protected, but the retry sent PG a one-message state in place of the
    // three-message one the failed attempt carried — and the store replaces
    // `content`/`status_json` en bloc. The base read under the lock before the
    // attempt is still in hand: it is the payload to replay.
    const ids = `pg:sync-ids:${WITNESS_ID},${FILE_ONLY_ID},${NEW_ID}`;
    const run = runScenario({
      gate: 'open',
      pg: 'fail-once',
      seed: FILE_ONLY_SEED,
      retired: 'reread',
      syncIds: true,
    });

    expect(run.status).toBe(0);
    expect(run.file).toBe(FILE_ONLY_SEED); // the file is still not rewritten
    expect(run.journal.filter((l) => l.startsWith('pg:sync'))).toEqual([
      sync(false, 1, 3),
      ids,
      sync(false, 2, 3),
      ids, // the retry: the same three ids, in the same order
    ]);
  }, 15000);

  it('the same for an unreadable file half reached through a null re-read', () => {
    // The other refusal kind, same duty: the first read answered (the file
    // half is a directory), the re-read is null and the file half still
    // cannot be read.
    const run = runScenario({ gate: 'open', pg: 'fail-once', writeFail: true, retired: 'reread' });

    expect(run.status).toBe(0);
    expect(run.file).toBeNull(); // the directory was never replaced by a file
    expect(run.parsed).toEqual({
      ok: true,
      key: KEY,
      base: 'file',
      unserialized: false,
      messageId: NEW_ID,
      totalMessages: 2,
      pgSynced: true,
      gdriveSkipped: true,
      fileRewriteSkipped: expect.any(String),
    });
    expect(run.stderr).toContain('illisible');
    expect(run.stderr).not.toContain('ERREUR');
    expect(run.journal).toEqual([
      LOCK,
      'read:unreadable', // the first read: the witness view
      'gate:open',
      sync(false, 1),
      UNLOCK,
      LOCK,
      'path',
      'read:undetermined', // null on the re-read…
      // no `retirement:` line: the file half already failed to read
      sync(false, 2), // …and the retry still carries the witness + our message
      UNLOCK,
    ]);
  }, 15000);
});
