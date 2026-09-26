/**
 * #2818 / #3782: Tests for the cross-process condensation lock (layered).
 *
 * The lock is what makes N concurrent agents on a saturated dashboard NOT each
 * run the multi-minute LLM condense: the first appender wins the lock and
 * condenses; the others see a fresh lock and skip (their append-first message is
 * later stitched back in by applyCondensedWithMerge / #2328). A crashed holder is
 * recovered after CONDENSE_LOCK_TTL_MS.
 *
 * #3782 locks-off-Drive: layer 1 is a PG consultative row (mocked here with
 * spies defaulting to 'unavailable' so the FILE layer tests below exercise the
 * machine-local fallback exactly as a host without PG sees it); layer 2 is the
 * tmpdir file lock asserted directly — that is where the cross-process contract
 * actually lives, and it is deterministic to assert here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, access, mkdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// La couche PG est espionnée : défaut 'unavailable' (= hôte sans PG / PG
// injoignable) pour les tests fichier ; pilotable pour les tests de couche PG.
const { pgAcquireSpy, pgReleaseSpy } = vi.hoisted(() => ({
  pgAcquireSpy: vi.fn(),
  pgReleaseSpy: vi.fn(),
}));
vi.mock('../../../services/unified-store/roosync-dashboard-store.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    acquireDashboardSharedLock: pgAcquireSpy,
    releaseDashboardSharedLock: pgReleaseSpy,
  };
});

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

describe('condense lock — couche fichier (fallback machine-local #3782)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    // #3782 : le verrou fichier vit dans un tmpdir dédié (ROOSYNC_LOCK_DIR),
    // PLUS dans dashboards/ du store GDrive.
    process.env.ROOSYNC_LOCK_DIR = path.join(tmpDir, 'locks');
    await mkdir(process.env.ROOSYNC_LOCK_DIR, { recursive: true });
    pgAcquireSpy.mockReset();
    pgAcquireSpy.mockResolvedValue('unavailable');
    pgReleaseSpy.mockReset();
    pgReleaseSpy.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_LOCK_DIR;
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

  it('hashes the key into the filename — no raw key, no traversal surface (#3782)', () => {
    const p = getCondenseLockPath('../../evil/key with spaces');
    expect(p).not.toContain('evil');
    expect(path.basename(p)).toMatch(/^[0-9a-f]{64}\.condense\.lock$/);
    // Deux clés distinctes → deux fichiers distincts.
    expect(getCondenseLockPath('a')).not.toBe(getCondenseLockPath('b'));
  });

  it('does NOT steal a lock past the TTL but inside the clock-skew tolerance', async () => {
    // TTL 900s + 120s skew. A holder whose clock lags by ~1 min would otherwise
    // have its LIVE lock stolen mid-condense. Pre-change this returned true.
    const lockPath = getCondenseLockPath(KEY);
    const laggingClock = holder({
      machineId: 'machine-lagging',
      pid: 3333,
      acquiredAt: new Date(Date.now() - (900 + 60) * 1000).toISOString(),
    });
    await writeFile(lockPath, JSON.stringify(laggingClock), 'utf8');

    expect(await tryAcquireCondenseLock(KEY, holder({ machineId: 'machine-B', pid: 2222 }))).toBe(false);
    const still = JSON.parse(await readFile(lockPath, 'utf8')) as CondenseLockInfo;
    expect(still.pid).toBe(3333);
  });

  it('still steals once the age clears TTL + skew', async () => {
    const lockPath = getCondenseLockPath(KEY);
    await writeFile(lockPath, JSON.stringify(holder({
      machineId: 'machine-crashed', pid: 9999,
      acquiredAt: new Date(Date.now() - (900 + 120 + 60) * 1000).toISOString(),
    })), 'utf8');

    expect(await tryAcquireCondenseLock(KEY, holder({ machineId: 'machine-B', pid: 2222 }))).toBe(true);
    const now = JSON.parse(await readFile(lockPath, 'utf8')) as CondenseLockInfo;
    expect(now.pid).toBe(2222);
  });
});

describe('condense lock — couche PG (#3782 locks-off-Drive)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_LOCK_DIR = path.join(tmpDir, 'locks');
    await mkdir(process.env.ROOSYNC_LOCK_DIR, { recursive: true });
    pgAcquireSpy.mockReset();
    pgReleaseSpy.mockReset();
    pgReleaseSpy.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_LOCK_DIR;
  });

  it("PG 'acquired' → true, AUCUN fichier verrou créé (la couche fichier dort)", async () => {
    pgAcquireSpy.mockResolvedValue('acquired');
    const h = holder({ pid: 4242 });

    expect(await tryAcquireCondenseLock(KEY, h)).toBe(true);

    expect(pgAcquireSpy).toHaveBeenCalledTimes(1);
    expect(pgAcquireSpy).toHaveBeenCalledWith(
      `condense:${KEY}`,
      JSON.stringify(h),
      // TTL passé au wrapper = TTL condense + tolérance d'horloge.
      expect.any(Number)
    );
    // La couche fichier n'a JAMAIS couru : aucun verrou tmpdir.
    expect(await exists(getCondenseLockPath(KEY))).toBe(false);
  });

  it("PG 'held' → false (skip), AUCUN fichier verrou créé", async () => {
    pgAcquireSpy.mockResolvedValue('held');
    const h = holder();

    expect(await tryAcquireCondenseLock(KEY, h)).toBe(false);
    expect(await exists(getCondenseLockPath(KEY))).toBe(false);
  });

  it("release relâche la couche PG (rowKey préfixé condense:, holder identique)", async () => {
    pgAcquireSpy.mockResolvedValue('acquired');
    const h = holder({ pid: 5151 });
    expect(await tryAcquireCondenseLock(KEY, h)).toBe(true);

    await releaseCondenseLock(KEY, h);
    expect(pgReleaseSpy).toHaveBeenCalledWith(`condense:${KEY}`, JSON.stringify(h));
  });

  it("PG 'unavailable' → dégradation SILENCIEUSE vers la couche fichier", async () => {
    pgAcquireSpy.mockResolvedValue('unavailable');
    const h = holder({ pid: 6161 });

    expect(await tryAcquireCondenseLock(KEY, h)).toBe(true);
    // C'est bien le fallback fichier qui détient le verrou.
    const raw = JSON.parse(await readFile(getCondenseLockPath(KEY), 'utf8')) as CondenseLockInfo;
    expect(raw.pid).toBe(6161);
    expect(pgAcquireSpy).toHaveBeenCalledTimes(1);
  });
});
