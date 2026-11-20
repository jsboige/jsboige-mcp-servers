import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sweepRsmTestWorkerDirs } from '../setup-env-teardown.ts';

export default async function () {
  // Maintenance#358 — sweep anchor: worker dirs created from this moment on
  // belong to THIS run. The returned teardown sweeps them: on Windows the
  // forks pool hard-kills workers (TerminateProcess semantics — no in-process
  // handler can run), so the main process is the only reliable reaper there.
  // Grace of 5 s covers workers spawned during globalSetup.
  const runStartMs = Date.now() - 5_000;

  // Create a unique temp storage directory for tests
  const storagePath = path.join(os.tmpdir(), `vitest-roo-e2e-${process.hrtime().join('-')}`);
  fs.mkdirSync(storagePath, { recursive: true });

  // Provide ROO_STORAGE_PATH for all tests that depend on VS Code globalStorage-like paths
  process.env.ROO_STORAGE_PATH = storagePath;

  // Expose to global so teardown can clean it up
  (global as any).E2E_STORAGE_PATH = storagePath;

  // Vitest v3: retourner une fonction de teardown
  return async () => {
    try {
      const storagePathToClean = (global as any).E2E_STORAGE_PATH as string | undefined;
      if (storagePathToClean && fs.existsSync(storagePathToClean)) {
        // Node 18+: prefer rmSync over deprecated rmdir
        fs.rmSync(storagePathToClean, { recursive: true, force: true });
      }
      sweepRsmTestWorkerDirs(runStartMs);
    } catch {
      // best effort cleanup; ignore errors in teardown
    }
  };
}