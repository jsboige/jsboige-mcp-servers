import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockCopyFile, mockUnlink, mockAccess, mockReadFile, mockWriteFile, mockExistsSync } = vi.hoisted(() => ({
	mockCopyFile: vi.fn(),
	mockUnlink: vi.fn(),
	mockAccess: vi.fn(),
	mockReadFile: vi.fn(),
	mockWriteFile: vi.fn(),
	mockExistsSync: vi.fn(),
}));

vi.mock('fs/promises', () => ({
	copyFile: mockCopyFile,
	unlink: mockUnlink,
	access: mockAccess,
	readFile: mockReadFile,
	writeFile: mockWriteFile,
}));

vi.mock('fs', () => ({
	existsSync: mockExistsSync,
}));

import { RollbackManager } from '../../../src/services/RollbackManager.js';

function createMockLogger() {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as any;
}

describe('RollbackManager', () => {
	let manager: RollbackManager;
	let logger: ReturnType<typeof createMockLogger>;

	beforeEach(() => {
		vi.clearAllMocks();
		logger = createMockLogger();
		manager = new RollbackManager(logger);
	});

	describe('track', () => {
		it('should track a backup entry', () => {
			manager.track('/path/to/config.json', '/path/to/backup.json');
			expect(manager.size).toBe(1);
			expect(manager.hasTrackedBackups).toBe(true);
		});

		it('should overwrite when tracking same path twice', () => {
			manager.track('/path/to/config.json', '/backup1.json');
			manager.track('/path/to/config.json', '/backup2.json');
			expect(manager.size).toBe(1);
			const entries = manager.listTracked();
			expect(entries[0].backupPath).toBe('/backup2.json');
		});

		it('should track multiple different paths', () => {
			manager.track('/path/a.json', '/backup/a.json');
			manager.track('/path/b.json', '/backup/b.json');
			expect(manager.size).toBe(2);
		});

		it('should log debug message on track', () => {
			manager.track('/config.json', '/backup.json');
			expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('backup.json'));
		});
	});

	describe('createAndTrack', () => {
		it('should create backup and track it', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFile.mockResolvedValue(undefined);

			const backupPath = await manager.createAndTrack('/path/to/config.json');

			expect(backupPath).toMatch(/^\/path\/to\/config\.json\.backup_/);
			expect(mockCopyFile).toHaveBeenCalledWith('/path/to/config.json', backupPath);
			expect(manager.size).toBe(1);
			expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Backup créé'));
		});

		it('should throw if original file does not exist', async () => {
			mockExistsSync.mockReturnValue(false);

			await expect(manager.createAndTrack('/missing.json'))
				.rejects.toThrow('Impossible de créer un backup');
		});
	});

	describe('restoreAll', () => {
		it('should restore all tracked backups', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);

			manager.track('/a.json', '/a.backup.json');
			manager.track('/b.json', '/b.backup.json');

			const result = await manager.restoreAll();

			expect(result.success).toBe(true);
			expect(result.restoredFiles).toEqual(['/a.json', '/b.json']);
			expect(result.failedFiles).toEqual([]);
			expect(mockCopyFile).toHaveBeenCalledTimes(2);
		});

		it('should skip already-restored entries', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFile.mockResolvedValue(undefined);

			manager.track('/a.json', '/a.backup.json');

			await manager.restoreAll();
			mockCopyFile.mockClear();
			const result2 = await manager.restoreAll();

			expect(mockCopyFile).not.toHaveBeenCalled();
			expect(result2.restoredFiles).toEqual([]);
		});

		it('should report failure when backup file is missing', async () => {
			manager.track('/a.json', '/a.backup.json');
			mockExistsSync.mockReturnValue(false);

			const result = await manager.restoreAll();

			expect(result.success).toBe(false);
			expect(result.failedFiles).toHaveLength(1);
			expect(result.failedFiles[0].path).toBe('/a.json');
			expect(result.message).toContain('partiel');
		});

		it('should delete backups when cleanupBackups is true', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);

			manager.track('/a.json', '/a.backup.json');
			await manager.restoreAll(true);

			expect(mockUnlink).toHaveBeenCalledWith('/a.backup.json');
		});

		it('should keep backups when cleanupBackups is false', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFile.mockResolvedValue(undefined);

			manager.track('/a.json', '/a.backup.json');
			await manager.restoreAll(false);

			expect(mockUnlink).not.toHaveBeenCalled();
		});

		it('should continue restoring other files when one fails', async () => {
			mockExistsSync
				.mockReturnValueOnce(true)
				.mockReturnValueOnce(false);

			manager.track('/a.json', '/a.backup.json');
			manager.track('/b.json', '/b.backup.json');

			const result = await manager.restoreAll();

			expect(result.restoredFiles).toEqual(['/a.json']);
			expect(result.failedFiles).toHaveLength(1);
		});

		it('should warn on cleanup failure but not fail', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFile.mockResolvedValue(undefined);
			mockUnlink.mockRejectedValue(new Error('permission denied'));

			manager.track('/a.json', '/a.backup.json');
			const result = await manager.restoreAll();

			expect(result.success).toBe(true);
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Impossible de supprimer'));
		});
	});

	describe('release', () => {
		it('should clear tracked backups without restoring', async () => {
			manager.track('/a.json', '/a.backup.json');
			expect(manager.size).toBe(1);

			await manager.release();

			expect(manager.size).toBe(0);
			expect(manager.hasTrackedBackups).toBe(false);
		});

		it('should delete backup files when cleanupBackups is true', async () => {
			mockExistsSync.mockReturnValue(true);
			mockUnlink.mockResolvedValue(undefined);

			manager.track('/a.json', '/a.backup.json');
			await manager.release(true);

			expect(mockUnlink).toHaveBeenCalledWith('/a.backup.json');
		});

		it('should not delete backup files when cleanupBackups is false', async () => {
			manager.track('/a.json', '/a.backup.json');
			await manager.release(false);

			expect(mockUnlink).not.toHaveBeenCalled();
		});

		it('should warn on cleanup failure during release', async () => {
			mockExistsSync.mockReturnValue(true);
			mockUnlink.mockRejectedValue(new Error('busy'));

			manager.track('/a.json', '/a.backup.json');
			await manager.release(true);

			expect(logger.warn).toHaveBeenCalled();
		});
	});

	describe('listTracked', () => {
		it('should return all tracked entries', () => {
			manager.track('/a.json', '/a.backup.json');
			manager.track('/b.json', '/b.backup.json');

			const entries = manager.listTracked();
			expect(entries).toHaveLength(2);
			expect(entries[0].originalPath).toBe('/a.json');
			expect(entries[1].originalPath).toBe('/b.json');
		});

		it('should include timestamp in entries', () => {
			manager.track('/a.json', '/a.backup.json');
			const entries = manager.listTracked();
			expect(entries[0].timestamp).toBeInstanceOf(Date);
		});
	});

	describe('untrack', () => {
		it('should remove a specific tracked entry', () => {
			manager.track('/a.json', '/a.backup.json');
			manager.track('/b.json', '/b.backup.json');

			const removed = manager.untrack('/a.json');

			expect(removed).toBe(true);
			expect(manager.size).toBe(1);
		});

		it('should return false for non-existent path', () => {
			const removed = manager.untrack('/nonexistent.json');
			expect(removed).toBe(false);
		});
	});

	describe('properties', () => {
		it('size should be 0 initially', () => {
			expect(manager.size).toBe(0);
		});

		it('hasTrackedBackups should be false initially', () => {
			expect(manager.hasTrackedBackups).toBe(false);
		});
	});

	describe('full rollback workflow', () => {
		it('should handle create → failure → restore → release cycle', async () => {
			mockExistsSync.mockReturnValue(true);
			mockCopyFile.mockResolvedValue(undefined);
			mockUnlink.mockResolvedValue(undefined);

			const backupPath = await manager.createAndTrack('/config.json');
			expect(manager.size).toBe(1);

			const result = await manager.restoreAll();
			expect(result.success).toBe(true);
			expect(result.restoredFiles).toEqual(['/config.json']);

			await manager.release();
			expect(manager.size).toBe(0);
		});
	});
});
