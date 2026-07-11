/**
 * #2818: Tests for the cross-process condensation file-lock.
 *
 * The lock is what makes N concurrent agents on a saturated dashboard NOT each
 * run the multi-minute LLM condense: the first appender wins the lock and
 * condenses; the others see a fresh lock and skip (their append-first message is
 * later stitched back in by applyCondensedWithMerge / #2328). A crashed holder is
 * recovered after CONDENSE_LOCK_TTL_MS.
 *
 * These tests exercise the lock primitives directly (pure filesystem) rather than
 * driving the full append+LLM path — that is where the cross-process contract
 * actually lives, and it is deterministic to assert here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, access, mkdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  tryAcquireCondenseLock,
  releaseCondenseLock,
  getCondenseLockPath,
  type CondenseLockInfo,
} from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'condense-lock-test-');
const KEY = 'workspace-test';

function holder(overrides: Partial<CondenseLockInfo> = {}): CondenseLockInfo {
  return {
    machineId: 'machine-A',
    workspace: 'ws-A',
    pid: 1111,
    acquiredAt: new Date().toISOString(),
    ...overrides,
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('condense file-lock #2818', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    // The lock lives under <shared>/dashboards/. That dir exists in production
    // (the dashboard file is written before condense); create it here too.
    await mkdir(path.join(tmpDir, 'dashboards'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
  });

  it('acquires on a free key and creates the lock file', async () => {
    const h = holder();
    const got = await tryAcquireCondenseLock(KEY, h);
    expect(got).toBe(true);

    const lockPath = getCondenseLockPath(KEY);
    expect(await exists(lockPath)).toBe(true);
    const written = JSON.parse(await readFile(lockPath, 'utf8')) as CondenseLockInfo;
    expect(written.machineId).toBe('machine-A');
    expect(written.pid).toBe(1111);
  });

  it('skips (returns false) when a FRESH lock is already held by another holder', async () => {
    const first = holder({ machineId: 'machine-A', pid: 1111 });
    expect(await tryAcquireCondenseLock(KEY, first)).toBe(true);

    // A different agent tries to condense the same key while the holder is fresh.
    const second = holder({ machineId: 'machine-B', pid: 2222 });
    expect(await tryAcquireCondenseLock(KEY, second)).toBe(false);

    // The original holder's lock must be untouched.
    const lockPath = getCondenseLockPath(KEY);
    const still = JSON.parse(await readFile(lockPath, 'utf8')) as CondenseLockInfo;
    expect(still.pid).toBe(1111);
  });

  it('steals (returns true) when the existing lock is STALE (holder crashed)', async () => {
    // Seed a lock timestamped well beyond any plausible TTL (1 hour ago).
    const lockPath = getCondenseLockPath(KEY);
    const staleHolder = holder({
      machineId: 'machine-crashed',
      pid: 9999,
      acquiredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    await writeFile(lockPath, JSON.stringify(staleHolder), 'utf8');

    const fresh = holder({ machineId: 'machine-B', pid: 2222 });
    expect(await tryAcquireCondenseLock(KEY, fresh)).toBe(true);

    // The lock is now owned by the stealer.
    const now = JSON.parse(await readFile(lockPath, 'utf8')) as CondenseLockInfo;
    expect(now.pid).toBe(2222);
    expect(now.machineId).toBe('machine-B');
  });

  it('release removes the lock only when we still own it', async () => {
    const h = holder({ pid: 1111 });
    expect(await tryAcquireCondenseLock(KEY, h)).toBe(true);
    const lockPath = getCondenseLockPath(KEY);
    expect(await exists(lockPath)).toBe(true);

    await releaseCondenseLock(KEY, h);
    expect(await exists(lockPath)).toBe(false);
  });

  it('release is a no-op when the lock was stolen by another holder', async () => {
    const original = holder({ machineId: 'machine-A', pid: 1111 });
    expect(await tryAcquireCondenseLock(KEY, original)).toBe(true);

    // Simulate a stealer overwriting the lock after the TTL (different pid).
    const lockPath = getCondenseLockPath(KEY);
    const stealer = holder({ machineId: 'machine-B', pid: 2222 });
    await writeFile(lockPath, JSON.stringify(stealer), 'utf8');

    // The original holder finishing late must NOT delete the stealer's lock.
    await releaseCondenseLock(KEY, original);
    expect(await exists(lockPath)).toBe(true);
    const still = JSON.parse(await readFile(lockPath, 'utf8')) as CondenseLockInfo;
    expect(still.pid).toBe(2222);
  });

  it('release is a no-op when pid+acquiredAt collide but machineId differs (cross-machine)', async () => {
    // Belt-and-suspenders: two machines could in theory produce the same pid at
    // the same acquiredAt millisecond. The owner-check must also match machineId
    // so machine-A's late release cannot delete machine-B's live lock.
    const same = { pid: 1234, acquiredAt: new Date().toISOString() };
    const machineB = holder({ machineId: 'machine-B', ...same });
    const lockPath = getCondenseLockPath(KEY);
    await writeFile(lockPath, JSON.stringify(machineB), 'utf8');

    const machineA = holder({ machineId: 'machine-A', ...same });
    await releaseCondenseLock(KEY, machineA);

    // machine-B's lock must survive.
    expect(await exists(lockPath)).toBe(true);
    const still = JSON.parse(await readFile(lockPath, 'utf8')) as CondenseLockInfo;
    expect(still.machineId).toBe('machine-B');
  });

  it('a full acquire→release cycle leaves the key re-acquirable', async () => {
    const a = holder({ machineId: 'machine-A', pid: 1111 });
    expect(await tryAcquireCondenseLock(KEY, a)).toBe(true);
    await releaseCondenseLock(KEY, a);

    // Next agent can now win it cleanly.
    const b = holder({ machineId: 'machine-B', pid: 2222 });
    expect(await tryAcquireCondenseLock(KEY, b)).toBe(true);
    const now = JSON.parse(await readFile(getCondenseLockPath(KEY), 'utf8')) as CondenseLockInfo;
    expect(now.pid).toBe(2222);
  });

  it('reclaims a corrupt/unparseable lock rather than wedging condensation', async () => {
    const lockPath = getCondenseLockPath(KEY);
    await writeFile(lockPath, 'not-json-garbage{{{', 'utf8');

    const h = holder({ machineId: 'machine-B', pid: 2222 });
    // Fail-open: a garbage lock must never permanently block condensation.
    expect(await tryAcquireCondenseLock(KEY, h)).toBe(true);
    const now = JSON.parse(await readFile(lockPath, 'utf8')) as CondenseLockInfo;
    expect(now.pid).toBe(2222);
  });

  it('uses a .condense.lock extension so *.md dashboard scans ignore it', () => {
    const lockPath = getCondenseLockPath(KEY);
    expect(lockPath.endsWith('.condense.lock')).toBe(true);
    expect(lockPath.endsWith('.md')).toBe(false);
  });
});
