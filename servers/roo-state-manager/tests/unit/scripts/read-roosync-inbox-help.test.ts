/**
 * #4131 B14 — smoke test for the read-roosync-inbox.mjs CLI shell.
 *
 * The read logic is covered by cli-inbox-read-4131.test.ts (in-process,
 * mocked reader factory). What only a subprocess can pin is the shell
 * contract the PowerShell worker will rely on: --help exits 0 with usage,
 * missing --machine exits 1 with a stderr message. Both paths exit BEFORE
 * the build/ import, so this test needs no build and no PG.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../../../scripts/read-roosync-inbox.mjs');

function run(args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      timeout: 30_000,
      // --help and the arg guard read nothing from the environment that
      // matters; a clean env keeps the test hermetic.
      env: { ...process.env, UNIFIED_STORE_CHANNEL_READ_PG: undefined, UNIFIED_STORE_PG_URL: undefined },
    });
    return { status: 0, stdout };
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? '' };
  }
}

describe('read-roosync-inbox.mjs shell (#4131 B14)', () => {
  it('--help exits 0 and prints usage with the exit-code contract', () => {
    const { status, stdout } = run(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: node scripts/read-roosync-inbox.mjs --machine');
    expect(stdout).toContain("3 = {source:'file',reason:...}");
  });

  it('missing --machine exits 1 before any PG or build dependency', () => {
    const { status } = run([]);
    expect(status).toBe(1);
  });
});
