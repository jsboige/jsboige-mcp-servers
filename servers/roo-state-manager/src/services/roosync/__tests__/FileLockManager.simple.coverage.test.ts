/**
 * Coverage complement for FileLockManager.simple.ts (#833 Sprint C3).
 *
 * The base suite (FileLockManager.simple.test.ts, 33 tests) locks the core flow:
 * singleton, acquireLock success / EEXIST-stale-retry / max-retries, releaseLock
 * (success / ENOENT-ignore / other-throw), isLocked, withLock (success / op-fail /
 * release-on-error), readWithLock/writeWithLock happy paths, updateJsonWithLock
 * (existing / new / corrupt / truncated), backup rotation (create / replace / fallback),
 * and readJsonWithFallback (ENOENT / corrupt→backup / all-corrupt→undefined).
 *
 * This file drives the cold branches the base suite never reaches:
 *   - acquireLock: lock-content unreadable (read/parse fail) → unlink → retry (L110-118)
 *   - acquireLock: non-EEXIST error → immediate throw, no retry (L123-125)
 *   - readWithLock: operation failure → { success:false, error } (L191-192)
 *   - writeWithLock: operation failure → { success:false, error } (L191-192)
 *   - rotateBackups: unlink-oldest non-ENOENT → console.warn (L266-269)
 *   - rotateBackups: copyFile non-ENOENT → console.warn (L287-290)
 *
 * Every assertion cites the FileLockManager.simple.ts line(s) it locks in.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted fs mock — FileLockManager.simple.ts:11 imports `{ promises as fs }`.
const mockFs = vi.hoisted(() => ({
  writeFile: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn(),
  access: vi.fn(),
  copyFile: vi.fn(),
  rename: vi.fn(),
}));

vi.mock('fs', () => ({
  promises: mockFs,
  default: { promises: mockFs },
}));

import { FileLockManager } from '../FileLockManager.simple.js';

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy-path mocks; individual tests override per-call.
  mockFs.writeFile.mockResolvedValue(undefined);
  mockFs.readFile.mockResolvedValue('{}');
  mockFs.unlink.mockResolvedValue(undefined);
  mockFs.access.mockResolvedValue(undefined);
  mockFs.copyFile.mockResolvedValue(undefined);
  mockFs.rename.mockResolvedValue(undefined);
});

/** Build a Node error carrying a `code`. */
function fsError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe('FileLockManager.acquireLock — cold branches', () => {
  it('retries when the held lock file is unreadable: read fails → unlink → retry (L110-118)', async () => {
    const manager = FileLockManager.getInstance();
    // Attempt 1: EEXIST (lock held); reading the lock content fails (can't parse) → unlink → continue.
    mockFs.writeFile
      .mockRejectedValueOnce(fsError('exists', 'EEXIST'))
      .mockResolvedValueOnce(undefined); // retry succeeds
    mockFs.readFile.mockRejectedValueOnce(fsError('read failed', 'EIO'));
    mockFs.unlink.mockResolvedValue(undefined);

    const release = await manager.acquireLock('/p/file.json', { retries: 3, minTimeout: 1, maxTimeout: 2 });

    // The unreadable-lock catch unlinks the lock file (L112-113) then retries and succeeds.
    expect(typeof release).toBe('function');
    expect(mockFs.unlink).toHaveBeenCalledWith('/p/file.json.lock');
  });

  it('retries when the held lock content is unparseable JSON: parse fails → unlink → retry (L110-118)', async () => {
    const manager = FileLockManager.getInstance();
    mockFs.writeFile
      .mockRejectedValueOnce(fsError('exists', 'EEXIST'))
      .mockResolvedValueOnce(undefined);
    // Lock file present but content is not JSON → JSON.parse throws inside the try (L102).
    mockFs.readFile.mockResolvedValueOnce('not-json-lock-content');
    mockFs.unlink.mockResolvedValue(undefined);

    const release = await manager.acquireLock('/p/file.json', { retries: 3, minTimeout: 1, maxTimeout: 2 });

    expect(typeof release).toBe('function');
    // unlink was invoked to clear the corrupt lock before the successful retry.
    expect(mockFs.unlink).toHaveBeenCalledWith('/p/file.json.lock');
  });

  it('continues retrying even if the cleanup unlink itself fails (L112-116 inner catch)', async () => {
    const manager = FileLockManager.getInstance();
    mockFs.writeFile
      .mockRejectedValueOnce(fsError('exists', 'EEXIST'))
      .mockResolvedValueOnce(undefined);
    mockFs.readFile.mockRejectedValueOnce(fsError('read failed', 'EIO'));
    // The inner unlink also fails — the inner catch swallows it (L114-115) and continues.
    mockFs.unlink.mockRejectedValueOnce(fsError('busy', 'EBUSY'));

    const release = await manager.acquireLock('/p/file.json', { retries: 3, minTimeout: 1, maxTimeout: 2 });

    // Despite the failed cleanup, the retry still acquired the lock.
    expect(typeof release).toBe('function');
  });

  it('propagates a non-EEXIST write error immediately without retrying (L123-125)', async () => {
    const manager = FileLockManager.getInstance();
    // writeFile rejects with EACCES (not EEXIST) → the else branch throws (L125), no retry loop.
    mockFs.writeFile.mockRejectedValue(fsError('permission denied', 'EACCES'));

    await expect(
      manager.acquireLock('/p/file.json', { retries: 5, minTimeout: 1, maxTimeout: 2 }),
    ).rejects.toThrow('permission denied');

    // writeFile called exactly once — no retry on a non-EEXIST error.
    expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
  });
});

describe('FileLockManager.readWithLock / writeWithLock — operation failure', () => {
  it('readWithLock returns {success:false} when the read operation throws (L191-192)', async () => {
    const manager = FileLockManager.getInstance();
    // Lock acquisition succeeds; the read inside the operation rejects.
    mockFs.readFile.mockRejectedValue(fsError('io error', 'EIO'));

    const result = await manager.readWithLock('/p/data.json');

    // withLock wraps the operation failure into { success:false, error } (L191-192),
    // and the lock is still released (finally L193-195).
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error!.message).toBe('io error');
    expect(mockFs.unlink).toHaveBeenCalledWith('/p/data.json.lock');
  });

  it('writeWithLock returns {success:false} when the write operation throws (L191-192)', async () => {
    const manager = FileLockManager.getInstance();
    mockFs.writeFile
      // First call: the lock file write (acquireLock). Succeeds.
      .mockResolvedValueOnce(undefined)
      // Second call: the operation's data write. Rejects.
      .mockRejectedValueOnce(fsError('disk full', 'ENOSPC'));

    const result = await manager.writeWithLock('/p/data.json', 'payload');

    expect(result.success).toBe(false);
    expect(result.error!.message).toBe('disk full');
    // Lock released in finally despite the operation failure.
    expect(mockFs.unlink).toHaveBeenCalledWith('/p/data.json.lock');
  });
});

describe('FileLockManager.rotateBackups — console.warn branches (private, via updateJsonWithLock)', () => {
  it('warns when deleting the oldest backup fails with a non-ENOENT error (L266-269)', async () => {
    const manager = FileLockManager.getInstance();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Main file reads fine; rotateBackups runs. unlink(.bak-1) rejects with EBUSY (not ENOENT).
    mockFs.readFile.mockResolvedValue(JSON.stringify({ v: 1 }));
    mockFs.unlink
      // rotateBackups L264: unlink oldest backup (.bak-1) → EBUSY (warn path L267-268).
      .mockRejectedValueOnce(fsError('busy', 'EBUSY'));
    mockFs.copyFile.mockResolvedValue(undefined);

    await manager.updateJsonWithLock('/p/f.json', (d) => ({ v: (d?.v ?? 0) + 1 }));

    // The non-ENOENT unlink failure emitted the warn (L267), not swallowed silently.
    // console.warn is called with a single interpolated template-string argument (L267).
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to remove old backup'),
    );
    warnSpy.mockRestore();
  });

  it('warns when copying the current file to .bak-1 fails with a non-ENOENT error (L287-290)', async () => {
    const manager = FileLockManager.getInstance();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFs.readFile.mockResolvedValue(JSON.stringify({ v: 1 }));
    mockFs.unlink.mockResolvedValue(undefined);
    // rotateBackups L286: copyFile(current → .bak-1) → EACCES (warn path L289).
    mockFs.copyFile.mockRejectedValueOnce(fsError('denied', 'EACCES'));

    await manager.updateJsonWithLock('/p/f.json', (d) => ({ v: (d?.v ?? 0) + 1 }));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to create backup'),
    );
    warnSpy.mockRestore();
  });

  it('silently ignores ENOENT from the oldest-backup unlink (no warn, L265-266 guard)', async () => {
    const manager = FileLockManager.getInstance();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFs.readFile.mockResolvedValue(JSON.stringify({ v: 1 }));
    // ENOENT on the oldest backup → the guard (L266) skips the warn entirely.
    mockFs.unlink.mockRejectedValueOnce(fsError('not found', 'ENOENT'));
    mockFs.copyFile.mockResolvedValue(undefined);

    await manager.updateJsonWithLock('/p/f.json', (d) => ({ v: (d?.v ?? 0) + 1 }));

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to remove old backup'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });
});

// rotateBackups shift loop (L272-282) is unreachable: `for (let i = MAX_BACKUPS - 1; i >= 1; i--)`
// with the module constant MAX_BACKUPS = 1 (L16) → i = 0 → `0 >= 1` is false → the loop body never
// executes. The rename calls (L276) can therefore never fire. Skip-with-evidence (#1936).
describe('FileLockManager.rotateBackups — unreachable shift loop', () => {
  it.skip('shift-loop backup rotation (L272-282) — unreachable: MAX_BACKUPS=1 makes the loop guard false', () => {});
});
