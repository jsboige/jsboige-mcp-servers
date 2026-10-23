/**
 * B16 (#4131) — host-local G: scan lock.
 *
 * Exercised against the REAL lock file on disk (proper-lockfile's `<target>.lock`
 * directory under `ROOSYNC_SCAN_LOCK_DIR`): the contract under test is mutual
 * exclusion between processes on one host, so a mocked filesystem would prove
 * nothing. Scope names are unique per run to keep the suite off the production
 * 'inbox-pool' / 'channel-reconcile' locks.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireGdriveScanLock } from '../gdrive-scan-lock.js';

describe('gdrive-scan-lock (#4131 B16)', () => {
  let lockDir: string;
  let savedEnv: string | undefined;
  let scope: string;
  let scopeCount = 0;

  beforeEach(() => {
    lockDir = mkdtempSync(join(tmpdir(), 'rsm-b16-lock-'));
    savedEnv = process.env.ROOSYNC_SCAN_LOCK_DIR;
    process.env.ROOSYNC_SCAN_LOCK_DIR = lockDir;
    scope = `test-scope-${process.pid}-${++scopeCount}`;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ROOSYNC_SCAN_LOCK_DIR;
    else process.env.ROOSYNC_SCAN_LOCK_DIR = savedEnv;
    rmSync(lockDir, { recursive: true, force: true });
  });

  test('excludes a second acquirer while held, and release frees it', async () => {
    const release = await acquireGdriveScanLock(scope);
    expect(release).not.toBeNull();
    try {
      // Second process on the same host: same real lock file → refused.
      const second = await acquireGdriveScanLock(scope);
      expect(second).toBeNull();

      // Distinct scopes do not collide (inbox-pool vs channel-reconcile).
      const other = await acquireGdriveScanLock(`${scope}-other`);
      expect(other).not.toBeNull();
      await other!();
    } finally {
      await release!();
    }

    // Released: the lock is acquirable again.
    const third = await acquireGdriveScanLock(scope);
    expect(third).not.toBeNull();
    await third!();
  });

  test('a stale lock left by a crashed holder is taken over', async () => {
    // A holder that died without releasing: proper-lockfile's lock is a
    // `<target>.lock` DIRECTORY; backdate it past stale (15 min) to model it.
    const target = join(lockDir, `gdrive-scan-${scope}.lock`);
    mkdirSync(target, { recursive: true });
    const longAgo = new Date(Date.now() - 20 * 60_000);
    utimesSync(target, longAgo, longAgo);

    const release = await acquireGdriveScanLock(scope);
    expect(release).not.toBeNull();
    await release!();
    expect(existsSync(target)).toBe(true); // target file stays; only the sibling lock is released
  });

  test('the lock is a real file under the resolved directory (not a mock)', async () => {
    const release = await acquireGdriveScanLock(scope);
    expect(release).not.toBeNull();
    try {
      expect(existsSync(join(lockDir, `gdrive-scan-${scope}.lock`))).toBe(true);
      expect(existsSync(join(lockDir, `gdrive-scan-${scope}.lock.lock`))).toBe(true);
    } finally {
      await release!();
    }
  });
});
