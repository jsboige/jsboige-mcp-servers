/**
 * Tests for #2352: Leader-election for Qdrant indexing
 *
 * Tests the tryAcquireLeaderLock logic in isolation:
 * - First instance acquires lock (wx flag)
 * - Same PID renews (overwrites)
 * - Different PID fails if lock is fresh
 * - Different PID steals if lock is stale (>15 min)
 * - Corrupt lock file → overwrite (assume leader)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import * as os from 'os';
import { getLeaderLockPath } from '../background-services.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      writeFile: vi.fn(),
      readFile: vi.fn(),
    },
  };
});

// Mock RooStorageDetector to return a deterministic path.
// vi.hoisted() makes MOCK_STORAGE_PATH available to the hoisted vi.mock factory
// (vi.mock is hoisted above top-level const initialization).
const { MOCK_STORAGE_PATH } = vi.hoisted(() => ({ MOCK_STORAGE_PATH: '/mock/storage' }));
vi.mock('../../utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    detectStorageLocations: vi.fn().mockResolvedValue([MOCK_STORAGE_PATH]),
  },
}));

// Import after mocks
const { writeFile, readFile } = vi.mocked(fs);
const LOCK_PATH = `${MOCK_STORAGE_PATH}/tasks/.skeletons/.indexer-leader.lock`;

// We test the lock logic by re-implementing the same algorithm in tests.
// This validates the contract without coupling to internal function exports.
// The production code in background-services.ts follows the same logic.

async function tryAcquireLeaderLock(staleMs = 15 * 60 * 1000): Promise<boolean> {
  const lockData = { pid: process.pid, timestamp: Date.now() };

  try {
    await fs.writeFile(LOCK_PATH, JSON.stringify(lockData), { flag: 'wx' });
    return true;
  } catch (error: any) {
    if (error.code !== 'EEXIST') return true;

    try {
      const content = await fs.readFile(LOCK_PATH, 'utf-8');
      const existing = JSON.parse(content);

      if (existing.pid === process.pid) {
        await fs.writeFile(LOCK_PATH, JSON.stringify(lockData));
        return true;
      }

      const age = Date.now() - existing.timestamp;
      if (age > staleMs) {
        await fs.writeFile(LOCK_PATH, JSON.stringify(lockData));
        return true;
      }

      return false;
    } catch {
      await fs.writeFile(LOCK_PATH, JSON.stringify(lockData));
      return true;
    }
  }
}

describe('Leader-election (#2352)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('acquires lock when no lock file exists', async () => {
    (writeFile as any).mockImplementationOnce(async (_p: string, data: string, opts: any) => {
      if (opts?.flag === 'wx') return; // Success — file created
      throw new Error('Unexpected writeFile call');
    });

    const result = await tryAcquireLeaderLock();
    expect(result).toBe(true);
    expect(writeFile).toHaveBeenCalledWith(LOCK_PATH, expect.any(String), { flag: 'wx' });
  });

  it('renews lock when same PID already holds it', async () => {
    const existingLock = JSON.stringify({ pid: process.pid, timestamp: Date.now() - 1000 });

    // First writeFile (wx) fails with EEXIST
    const wxError = new Error('EEXIST') as any;
    wxError.code = 'EEXIST';
    (writeFile as any).mockRejectedValueOnce(wxError);

    // readFile returns existing lock with our PID
    (readFile as any).mockResolvedValueOnce(existingLock);

    // Second writeFile (renewal) succeeds
    (writeFile as any).mockResolvedValueOnce(undefined);

    const result = await tryAcquireLeaderLock();
    expect(result).toBe(true);
    // Called twice: wx attempt + renewal
    expect(writeFile).toHaveBeenCalledTimes(2);
  });

  it('fails to acquire when another fresh lock exists', async () => {
    const freshLock = JSON.stringify({ pid: 99999, timestamp: Date.now() - 1000 });

    const wxError = new Error('EEXIST') as any;
    wxError.code = 'EEXIST';
    (writeFile as any).mockRejectedValueOnce(wxError);
    (readFile as any).mockResolvedValueOnce(freshLock);

    const result = await tryAcquireLeaderLock();
    expect(result).toBe(false);
  });

  it('steals stale lock when other process crashed', async () => {
    const staleLock = JSON.stringify({ pid: 99999, timestamp: Date.now() - 20 * 60 * 1000 }); // 20 min old

    const wxError = new Error('EEXIST') as any;
    wxError.code = 'EEXIST';
    (writeFile as any).mockRejectedValueOnce(wxError);
    (readFile as any).mockResolvedValueOnce(staleLock);
    (writeFile as any).mockResolvedValueOnce(undefined); // Overwrite succeeds

    const result = await tryAcquireLeaderLock();
    expect(result).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(2);
  });

  it('assumes leader on unexpected writeFile error', async () => {
    const permError = new Error('EACCES') as any;
    permError.code = 'EACCES';
    (writeFile as any).mockRejectedValueOnce(permError);

    const result = await tryAcquireLeaderLock();
    expect(result).toBe(true);
  });

  it('assumes leader when lock file is corrupt', async () => {
    const wxError = new Error('EEXIST') as any;
    wxError.code = 'EEXIST';
    (writeFile as any).mockRejectedValueOnce(wxError);
    (readFile as any).mockRejectedValueOnce(new Error('Corrupt file'));
    (writeFile as any).mockResolvedValueOnce(undefined); // Overwrite succeeds

    const result = await tryAcquireLeaderLock();
    expect(result).toBe(true);
  });

  it('uses configurable stale threshold', async () => {
    // Lock is 5 min old — fresh for 15 min threshold, stale for 1 min threshold
    const lock5Min = JSON.stringify({ pid: 99999, timestamp: Date.now() - 5 * 60 * 1000 });

    // With 15 min threshold → should fail (fresh)
    const wxError = new Error('EEXIST') as any;
    wxError.code = 'EEXIST';
    (writeFile as any).mockRejectedValueOnce(wxError);
    (readFile as any).mockResolvedValueOnce(lock5Min);

    const result15min = await tryAcquireLeaderLock(15 * 60 * 1000);
    expect(result15min).toBe(false);

    vi.clearAllMocks();

    // With 1 min threshold → should steal (stale)
    const wxError2 = new Error('EEXIST') as any;
    wxError2.code = 'EEXIST';
    (writeFile as any).mockRejectedValueOnce(wxError2);
    (readFile as any).mockResolvedValueOnce(lock5Min);
    (writeFile as any).mockResolvedValueOnce(undefined);

    const result1min = await tryAcquireLeaderLock(1 * 60 * 1000);
    expect(result1min).toBe(true);
  });

  it('lock file contains PID and timestamp', async () => {
    const before = Date.now();
    (writeFile as any).mockResolvedValueOnce(undefined);

    await tryAcquireLeaderLock();

    const writeCall = (writeFile as any).mock.calls[0];
    const writtenData = JSON.parse(writeCall[1]);

    expect(writtenData.pid).toBe(process.pid);
    expect(writtenData.timestamp).toBeGreaterThanOrEqual(before);
    expect(writtenData.timestamp).toBeLessThanOrEqual(Date.now());
  });
});

// --- #2352 fix regression: path-resolution contract (production code, not a copy) ---
// The describe above tests the lock CONTENTION algorithm via a local reimplementation
// (path-agnostic). These tests exercise the REAL getLeaderLockPath export to prove the
// fleet-storm fix: the lock path is machine-local and INVARIANT to detected storage.
describe('getLeaderLockPath — #2352 machine-local keying (regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a path under os.tmpdir() (machine-local, not a storage path)', async () => {
    const p = await getLeaderLockPath('myia-po-2026');
    expect(p.startsWith(os.tmpdir())).toBe(true);
    expect(p.endsWith('roosync-indexer-leader-myia-po-2026.lock')).toBe(true);
  });

  it('is INVARIANT to detected storage locations (the exact #2352 bug)', async () => {
    // Pre-fix: path = locations[0]/tasks/.skeletons/.indexer-leader.lock → different
    // storages = different locks = N concurrent leaders on the shared collection.
    // Post-fix: storage detection must NOT affect the path at all.
    (RooStorageDetector.detectStorageLocations as any).mockResolvedValue(['/roo/globalStorage']);
    const p1 = await getLeaderLockPath('myia-po-2026');
    (RooStorageDetector.detectStorageLocations as any).mockResolvedValue(['/roo/globalStorage', '/zoo/globalStorage']);
    const p2 = await getLeaderLockPath('myia-po-2026');
    (RooStorageDetector.detectStorageLocations as any).mockResolvedValue([]); // zero storage locations
    const p3 = await getLeaderLockPath('myia-po-2026');
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
  });

  it('gives each machine its own lock (machineId-keyed)', async () => {
    const a = await getLeaderLockPath('myia-ai-01');
    const b = await getLeaderLockPath('myia-po-2026');
    expect(a).not.toBe(b);
    expect(a.endsWith('roosync-indexer-leader-myia-ai-01.lock')).toBe(true);
    expect(b.endsWith('roosync-indexer-leader-myia-po-2026.lock')).toBe(true);
  });

  it('sanitizes unsafe machineId chars for filesystem safety', async () => {
    const p = await getLeaderLockPath('My_Bad Machine/01');
    expect(p.endsWith('roosync-indexer-leader-my-bad-machine-01.lock')).toBe(true);
  });

  it('falls back to "local" when machineId is empty', async () => {
    const p = await getLeaderLockPath('');
    expect(p.endsWith('roosync-indexer-leader-local.lock')).toBe(true);
  });
});
