/**
 * Tests pour FileLockManager.simple.ts
 * Issue #492 - Couverture du gestionnaire de verrouillage
 *
 * @module services/roosync/__tests__/FileLockManager.simple
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockWriteFile, mockReadFile, mockUnlink, mockAccess, mockCopyFile, mockRename } = vi.hoisted(() => ({
	mockWriteFile: vi.fn(),
	mockReadFile: vi.fn(),
	mockUnlink: vi.fn(),
	mockAccess: vi.fn(),
	mockCopyFile: vi.fn(),
	mockRename: vi.fn()
}));

vi.mock('fs', () => ({
	promises: {
		writeFile: mockWriteFile,
		readFile: mockReadFile,
		unlink: mockUnlink,
		access: mockAccess,
		copyFile: mockCopyFile,
		rename: mockRename
	},
	default: {
		promises: {
			writeFile: mockWriteFile,
			readFile: mockReadFile,
			unlink: mockUnlink,
			access: mockAccess,
			copyFile: mockCopyFile,
			rename: mockRename
		}
	}
}));

// Must import after mock
import { FileLockManager, getFileLockManager } from '../FileLockManager.simple.js';

describe('FileLockManager', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ============================================================
	// Singleton
	// ============================================================

	describe('singleton', () => {
		test('getInstance returns same instance', () => {
			const a = FileLockManager.getInstance();
			const b = FileLockManager.getInstance();
			expect(a).toBe(b);
		});

		test('getFileLockManager returns instance', () => {
			const instance = getFileLockManager();
			expect(instance).toBeInstanceOf(FileLockManager);
		});
	});

	// ============================================================
	// acquireLock
	// ============================================================

	describe('acquireLock', () => {
		test('creates lock file successfully', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			const manager = FileLockManager.getInstance();

			const release = await manager.acquireLock('/test/file.json');
			expect(mockWriteFile).toHaveBeenCalledWith(
				'/test/file.json.lock',
				expect.any(String),
				{ flag: 'wx' }
			);
			expect(typeof release).toBe('function');
		});

		test('release function removes lock file', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);
			const manager = FileLockManager.getInstance();

			const release = await manager.acquireLock('/test/file.json');
			await release();
			expect(mockUnlink).toHaveBeenCalledWith('/test/file.json.lock');
		});

		test('retries when lock file exists (EEXIST) and stale', async () => {
			const eexistError = Object.assign(new Error('File exists'), { code: 'EEXIST' });

			// First attempt: lock exists, stale (old timestamp)
			mockWriteFile
				.mockRejectedValueOnce(eexistError)
				.mockResolvedValueOnce(undefined);

			// Stale lock: old timestamp
			mockReadFile.mockResolvedValueOnce(JSON.stringify({
				pid: 12345,
				timestamp: Date.now() - 20000 // 20s ago, stale > 10000
			}));
			mockUnlink.mockResolvedValue(undefined);

			const manager = FileLockManager.getInstance();
			const release = await manager.acquireLock('/test/file.json', { retries: 3 });
			expect(typeof release).toBe('function');
		});

		test('throws after max retries when lock is held', async () => {
			const eexistError = Object.assign(new Error('File exists'), { code: 'EEXIST' });
			mockWriteFile.mockRejectedValue(eexistError);

			// Lock always fresh (not stale)
			mockReadFile.mockResolvedValue(JSON.stringify({
				pid: 12345,
				timestamp: Date.now() // Fresh timestamp
			}));

			const manager = FileLockManager.getInstance();
			await expect(
				manager.acquireLock('/test/file.json', {
					retries: 2,
					minTimeout: 1,
					maxTimeout: 2
				})
			).rejects.toThrow('acquérir le verrou');
		});
	});

	// ============================================================
	// releaseLock
	// ============================================================

	describe('releaseLock', () => {
		test('removes lock file', async () => {
			mockUnlink.mockResolvedValue(undefined);
			const manager = FileLockManager.getInstance();
			await manager.releaseLock('/test/file.json');
			expect(mockUnlink).toHaveBeenCalledWith('/test/file.json.lock');
		});

		test('ignores ENOENT (file already deleted)', async () => {
			const enoentError = Object.assign(new Error('Not found'), { code: 'ENOENT' });
			mockUnlink.mockRejectedValue(enoentError);
			const manager = FileLockManager.getInstance();
			// Should not throw
			await expect(manager.releaseLock('/test/file.json')).resolves.toBeUndefined();
		});

		test('throws for other unlink errors', async () => {
			const otherError = Object.assign(new Error('Permission denied'), { code: 'EPERM' });
			mockUnlink.mockRejectedValue(otherError);
			const manager = FileLockManager.getInstance();
			await expect(manager.releaseLock('/test/file.json')).rejects.toThrow('Permission denied');
		});
	});

	// ============================================================
	// isLocked
	// ============================================================

	describe('isLocked', () => {
		test('returns true when lock file exists', async () => {
			mockAccess.mockResolvedValue(undefined);
			const manager = FileLockManager.getInstance();
			expect(await manager.isLocked('/test/file.json')).toBe(true);
		});

		test('returns false when lock file does not exist', async () => {
			mockAccess.mockRejectedValue(new Error('ENOENT'));
			const manager = FileLockManager.getInstance();
			expect(await manager.isLocked('/test/file.json')).toBe(false);
		});
	});

	// ============================================================
	// withLock
	// ============================================================

	describe('withLock', () => {
		test('executes operation and returns success', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);
			const manager = FileLockManager.getInstance();

			const result = await manager.withLock('/test/file.json', async () => {
				return 'operation result';
			});

			expect(result.success).toBe(true);
			expect(result.data).toBe('operation result');
		});

		test('returns error on operation failure', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);
			const manager = FileLockManager.getInstance();

			const result = await manager.withLock('/test/file.json', async () => {
				throw new Error('Operation failed');
			});

			expect(result.success).toBe(false);
			expect(result.error!.message).toBe('Operation failed');
		});

		test('always releases lock even on error', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);
			const manager = FileLockManager.getInstance();

			await manager.withLock('/test/file.json', async () => {
				throw new Error('fail');
			});

			// unlink should be called (lock released)
			expect(mockUnlink).toHaveBeenCalledWith('/test/file.json.lock');
		});
	});

	// ============================================================
	// readWithLock
	// ============================================================

	describe('readWithLock', () => {
		test('reads file content with lock', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue('file content');
			const manager = FileLockManager.getInstance();

			const result = await manager.readWithLock('/test/data.json');
			expect(result.success).toBe(true);
			expect(result.data).toBe('file content');
		});
	});

	// ============================================================
	// writeWithLock
	// ============================================================

	describe('writeWithLock', () => {
		test('writes data with lock', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);
			const manager = FileLockManager.getInstance();

			const result = await manager.writeWithLock('/test/data.json', 'new content');
			expect(result.success).toBe(true);
		});
	});

	// ============================================================
	// updateJsonWithLock
	// ============================================================

	describe('updateJsonWithLock', () => {
		test('updates existing JSON file', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);
			mockCopyFile.mockResolvedValue(undefined);
			mockRename.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(JSON.stringify({ count: 1 }));

			const manager = FileLockManager.getInstance();
			const result = await manager.updateJsonWithLock<{ count: number }>(
				'/test/data.json',
				(data) => ({ count: (data?.count ?? 0) + 1 })
			);

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ count: 2 });
			expect(mockCopyFile).toHaveBeenCalledWith(
				'/test/data.json',
				'/test/data.json.bak-1'
			);
		});

		test('creates new JSON when file does not exist', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);
			mockCopyFile.mockResolvedValue(undefined);
			mockRename.mockResolvedValue(undefined);
			const enoentError = Object.assign(new Error('Not found'), { code: 'ENOENT' });
			mockReadFile.mockRejectedValue(enoentError);

			const manager = FileLockManager.getInstance();
			const result = await manager.updateJsonWithLock<{ items: string[] }>(
				'/test/new.json',
				(data) => data ?? { items: ['first'] }
			);

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ items: ['first'] });
		});

		test('auto-repairs corrupt/empty JSON file (#1623)', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);
			mockCopyFile.mockResolvedValue(undefined);
			mockRename.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue('');

			const manager = FileLockManager.getInstance();
			const result = await manager.updateJsonWithLock<{ count: number }>(
				'/test/corrupt.json',
				(data) => data ?? { count: 1 }
			);

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ count: 1 });
			expect(mockWriteFile).toHaveBeenCalledWith(
				'/test/corrupt.json',
				JSON.stringify({ count: 1 }, null, 2),
				'utf-8'
			);
		});

		test('auto-repairs truncated JSON file (#1623)', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);
			mockCopyFile.mockResolvedValue(undefined);
			mockRename.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue('{"count":');

			const manager = FileLockManager.getInstance();
			const result = await manager.updateJsonWithLock<{ count: number }>(
				'/test/truncated.json',
				(data) => data ?? { count: 0 }
			);

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ count: 0 });
		});
	});

	// ============================================================
	// Backup rotation (#1657)
	// ============================================================

	describe('backup rotation (#1657)', () => {
		test('creates .bak-1 on first write', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);
			mockCopyFile.mockResolvedValue(undefined);
			mockRename.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(JSON.stringify({ v: 1 }));

			const manager = FileLockManager.getInstance();
			await manager.updateJsonWithLock('/test/f.json', (d) => ({ v: (d?.v ?? 0) + 1 }));

			expect(mockCopyFile).toHaveBeenCalledWith('/test/f.json', '/test/f.json.bak-1');
		});

		test('rotates .bak-1 -> .bak-2 on second write', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);
			mockCopyFile.mockResolvedValue(undefined);
			mockRename.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(JSON.stringify({ v: 2 }));

			const manager = FileLockManager.getInstance();
			await manager.updateJsonWithLock('/test/f.json', (d) => ({ v: (d?.v ?? 0) + 1 }));

			expect(mockRename).toHaveBeenCalledWith('/test/f.json.bak-1', '/test/f.json.bak-2');
		});

		test('deletes oldest .bak-3 when max backups reached', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);
			mockCopyFile.mockResolvedValue(undefined);
			mockRename.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(JSON.stringify({ v: 3 }));

			const manager = FileLockManager.getInstance();
			await manager.updateJsonWithLock('/test/f.json', (d) => ({ v: (d?.v ?? 0) + 1 }));

			expect(mockUnlink).toHaveBeenCalledWith('/test/f.json.bak-3');
			expect(mockRename).toHaveBeenCalledWith('/test/f.json.bak-2', '/test/f.json.bak-3');
		});

		test('falls back to .bak-1 when main file is corrupt', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);
			mockCopyFile.mockResolvedValue(undefined);
			mockRename.mockResolvedValue(undefined);
			mockReadFile
				.mockResolvedValueOnce('not-json')
				.mockResolvedValueOnce(JSON.stringify({ recovered: true }));

			const manager = FileLockManager.getInstance();
			const result = await manager.updateJsonWithLock<{ recovered: boolean }>(
				'/test/f.json',
				(d) => ({ recovered: d?.recovered ?? false })
			);

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ recovered: true });
		});

		test('cascades fallback through .bak-1 -> .bak-2 -> .bak-3', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);
			mockCopyFile.mockResolvedValue(undefined);
			mockRename.mockResolvedValue(undefined);
			mockReadFile
				.mockResolvedValueOnce('bad')
				.mockResolvedValueOnce('also-bad')
				.mockResolvedValueOnce('still-bad')
				.mockResolvedValueOnce(JSON.stringify({ last: true }));

			const manager = FileLockManager.getInstance();
			const result = await manager.updateJsonWithLock<{ last: boolean }>(
				'/test/f.json',
				(d) => ({ last: d?.last ?? false })
			);

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ last: true });
		});

		test('returns undefined when all files are corrupt', async () => {
			mockWriteFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);
			mockCopyFile.mockResolvedValue(undefined);
			mockRename.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue('bad-json');

			const manager = FileLockManager.getInstance();
			const result = await manager.updateJsonWithLock<{ x: number }>(
				'/test/f.json',
				(d) => ({ x: d?.x ?? 42 })
			);

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ x: 42 });
		});
	});
});
