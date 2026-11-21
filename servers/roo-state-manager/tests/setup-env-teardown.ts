// Maintenance#358 — lifecycle of the per-worker rsm-test-* temp dirs.
//
// Two teardown vectors, because no single one covers all platforms:
//  1. IN-PROCESS: 'exit' (normal exits, process.exit()) + SIGTERM/SIGINT
//     handlers (POSIX signal kills — the vitest forks pool terminates
//     workers by signal on Linux). On Windows, child.kill() is
//     TerminateProcess semantics: NO handler can run, ever.
//  2. MAIN-PROCESS SWEEP: sweepRsmTestWorkerDirs(sinceMs), called from the
//     vitest globalSetup returned teardown, removes the three setup-env
//     prefixes created since the run started — this is the only vector that
//     works on Windows-hard-killed fork workers (measured: 2 913 dirs
//     survived one CI-config run with the in-process handler alone).
//
// Sweep scope is deliberately narrow — exactly the three prefixes setup-env
// creates (rsm-test-locks-, rsm-test-scan-locks-, rsm-test-tus-cache-) —
// never the broader rsm-test-* namespace, parts of which belong to suites
// that manage their own dirs.
//
// Concurrency caveat: two simultaneous runs of this suite on the same host
// would let one run's sweep delete the other run's live worker dirs (their
// mtime also >= sinceMs). Not a supported scenario (CI isolates runners;
// local lanes run sequentially) — documented rather than locked.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const RSM_TEST_DIR_PREFIXES = [
  'rsm-test-locks-',
  'rsm-test-scan-locks-',
  'rsm-test-tus-cache-',
] as const;

const ownedDirs: string[] = [];
let handlersInstalled = false;

const cleanupOwnedDirs = (): void => {
  for (const dir of ownedDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort: a dir held by a stray child process leaks once, silently
    }
  }
};

/** Register a dir created by THIS process to be removed at process end. */
export function registerRsmTestTempDir(dir: string): void {
  ownedDirs.push(dir);
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('exit', cleanupOwnedDirs);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    // POSIX only: on Windows these never fire for TerminateProcess kills —
    // the globalSetup sweep covers that vector.
    process.on(sig, () => {
      cleanupOwnedDirs();
      process.exit(0);
    });
  }
}

/** Remove setup-env worker dirs (three prefixes) created since `sinceMs`.
 * Returns the number of dirs removed. Never throws.
 *
 * Back-date `sinceMs` by >= 1s: kernel inode timestamps use the coarse
 * clock (jiffy granularity) and can trail the userspace clock Date.now()
 * reads by a few ms — measured on Linux CI, a dir created AFTER a
 * zero-slack sinceMs sample carried an mtime below it and was skipped
 * (ms#1831 first CI run). `baseDir` defaults to os.tmpdir(); tests pass an
 * isolated dir so a mid-run sweep cannot touch other workers' live dirs. */
export function sweepRsmTestWorkerDirs(sinceMs: number, baseDir: string = os.tmpdir()): number {
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!RSM_TEST_DIR_PREFIXES.some((p) => entry.name.startsWith(p))) continue;
    const full = path.join(baseDir, entry.name);
    try {
      if (fs.statSync(full).mtimeMs < sinceMs) continue; // pre-run stock: not ours
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // already gone or held: skip, never fail the teardown
    }
  }
  return removed;
}
