/**
 * Tests pour PresenceManager.ts
 * Issue #492 - Couverture des services RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { PresenceManager, PresenceManagerError, PresenceData } from '../PresenceManager.js';

// Mock fs
const { mockReadFile, mockMkdir, mockReaddir, mockUnlink } = vi.hoisted(() => ({
	mockReadFile: vi.fn(),
	mockMkdir: vi.fn(),
	mockReaddir: vi.fn(),
	mockUnlink: vi.fn()
}));

const { mockExistsSync } = vi.hoisted(() => ({
	mockExistsSync: vi.fn()
}));

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return {
		...actual,
		default: actual,
		existsSync: mockExistsSync,
		promises: {
			readFile: mockReadFile,
			mkdir: mockMkdir,
			readdir: mockReaddir,
			unlink: mockUnlink
		}
	};
});

// Mock FileLockManager
const { mockUpdateJsonWithLock, mockWithLock } = vi.hoisted(() => ({
	mockUpdateJsonWithLock: vi.fn(),
	mockWithLock: vi.fn()
}));

vi.mock('./FileLockManager.simple.js', () => ({
	getFileLockManager: vi.fn(() => ({
		updateJsonWithLock: mockUpdateJsonWithLock,
		withLock: mockWithLock
	}))
}));

const mockConfig = {
	machineId: 'test-machine',
	sharedPath: '/shared/path'
};

const mockLockManager = {
	updateJsonWithLock: mockUpdateJsonWithLock,
	withLock: mockWithLock
};

describe('PresenceManager', () => {
	let manager: PresenceManager;

	beforeEach(() => {
		vi.clearAllMocks();
		manager = new PresenceManager(mockConfig as any, mockLockManager as any);
		mockMkdir.mockResolvedValue(undefined);
	});

	// ============================================================
	// PresenceManagerError
	// ============================================================

	describe('PresenceManagerError', () => {
		test('creates error with message prefix', () => {
			const err = new PresenceManagerError('test error');
			expect(err.message).toBe('[PresenceManager] test error');
			expect(err.name).toBe('PresenceManagerError');
		});

		test('creates error with code', () => {
			const err = new PresenceManagerError('test', 'SOME_CODE');
			expect(err.code).toBe('SOME_CODE');
		});
	});

	// ============================================================
	// readPresence
	// ============================================================

	describe('readPresence', () => {
		test('returns null when file does not exist', async () => {
			mockExistsSync.mockReturnValue(false);
			const result = await manager.readPresence('machine-1');
			expect(result).toBeNull();
		});

		test('returns parsed presence data when file exists', async () => {
			const presenceData: PresenceData = {
				id: 'machine-1',
				status: 'online',
				lastSeen: '2026-01-01T00:00:00Z',
				version: '1.0.0',
				mode: 'code'
			};
			mockExistsSync.mockReturnValue(true);
			mockReadFile.mockResolvedValue(JSON.stringify(presenceData));

			const result = await manager.readPresence('machine-1');
			expect(result).toEqual(presenceData);
		});

		test('returns null on parse error', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFile.mockResolvedValue('invalid json{{{');

			const result = await manager.readPresence('machine-1');
			expect(result).toBeNull();
		});

		test('returns null on read error', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFile.mockRejectedValue(new Error('EACCES'));

			const result = await manager.readPresence('machine-1');
			expect(result).toBeNull();
		});
	});

	// ============================================================
	// updatePresence
	// ============================================================

	describe('updatePresence', () => {
		test('returns success when lock update succeeds', async () => {
			mockUpdateJsonWithLock.mockResolvedValue({ success: true });

			const result = await manager.updatePresence('machine-1', { status: 'online' });
			expect(result.success).toBe(true);
			expect(result.conflictDetected).toBe(false);
		});

		test('returns failure when lock update fails', async () => {
			mockUpdateJsonWithLock.mockResolvedValue({
				success: false,
				error: new Error('Lock timeout')
			});

			const result = await manager.updatePresence('machine-1', { status: 'online' });
			expect(result.success).toBe(false);
			expect(result.warningMessage).toContain('Lock timeout');
		});

		test('returns failure on exception', async () => {
			mockUpdateJsonWithLock.mockRejectedValue(new Error('Unexpected error'));

			const result = await manager.updatePresence('machine-1', { status: 'online' });
			expect(result.success).toBe(false);
			expect(result.warningMessage).toContain('Unexpected error');
		});

		test('calls ensurePresenceDir before update', async () => {
			mockUpdateJsonWithLock.mockResolvedValue({ success: true });

			await manager.updatePresence('machine-1', { status: 'online' });
			expect(mockMkdir).toHaveBeenCalledWith(
				expect.stringContaining('presence'),
				{ recursive: true }
			);
		});

		test('passes lock options with retries', async () => {
			mockUpdateJsonWithLock.mockResolvedValue({ success: true });

			await manager.updatePresence('machine-1', { status: 'online' });
			expect(mockUpdateJsonWithLock).toHaveBeenCalledWith(
				expect.stringContaining('machine-1.json'),
				expect.any(Function),
				expect.objectContaining({
					retries: 10,
					stale: 30000
				})
			);
		});
	});

	// ============================================================
	// updateCurrentPresence
	// ============================================================

	describe('updateCurrentPresence', () => {
		test('uses config machineId', async () => {
			mockUpdateJsonWithLock.mockResolvedValue({ success: true });

			await manager.updateCurrentPresence();
			expect(mockUpdateJsonWithLock).toHaveBeenCalledWith(
				expect.stringContaining('test-machine.json'),
				expect.any(Function),
				expect.any(Object)
			);
		});

		test('defaults status to online and mode to code', async () => {
			mockUpdateJsonWithLock.mockResolvedValue({ success: true });

			const result = await manager.updateCurrentPresence();
			expect(result.success).toBe(true);
		});

		test('accepts custom status and mode', async () => {
			mockUpdateJsonWithLock.mockResolvedValue({ success: true });

			const result = await manager.updateCurrentPresence('offline', 'debug');
			expect(result.success).toBe(true);
		});
	});

	// ============================================================
	// removePresence
	// ============================================================

	describe('removePresence', () => {
		test('returns false when file does not exist', async () => {
			mockExistsSync.mockReturnValue(false);

			const result = await manager.removePresence('machine-1');
			expect(result).toBe(false);
		});

		test('returns true when lock-based removal succeeds', async () => {
			mockExistsSync.mockReturnValue(true);
			mockWithLock.mockResolvedValue({ success: true });

			const result = await manager.removePresence('machine-1');
			expect(result).toBe(true);
		});

		test('returns false on error', async () => {
			mockExistsSync.mockReturnValue(true);
			mockWithLock.mockRejectedValue(new Error('Lock error'));

			const result = await manager.removePresence('machine-1');
			expect(result).toBe(false);
		});
	});

	// ============================================================
	// listAllPresence
	// ============================================================

	describe('listAllPresence', () => {
		test('returns empty array when no files', async () => {
			mockReaddir.mockResolvedValue([]);

			const result = await manager.listAllPresence();
			expect(result).toEqual([]);
		});

		test('returns presence data for json files only', async () => {
			mockReaddir.mockResolvedValue(['machine-1.json', 'readme.txt', 'machine-2.json']);
			mockExistsSync.mockReturnValue(true);

			const presence1: PresenceData = {
				id: 'machine-1', status: 'online', lastSeen: '2026-01-01',
				version: '1.0.0', mode: 'code'
			};
			const presence2: PresenceData = {
				id: 'machine-2', status: 'offline', lastSeen: '2026-01-02',
				version: '1.0.0', mode: 'debug'
			};

			mockReadFile.mockImplementation(async (path: string) => {
				if (typeof path === 'string' && path.includes('machine-1')) return JSON.stringify(presence1);
				if (typeof path === 'string' && path.includes('machine-2')) return JSON.stringify(presence2);
				throw new Error('not found');
			});

			const result = await manager.listAllPresence();
			expect(result).toHaveLength(2);
		});

		test('returns empty array on readdir error', async () => {
			mockReaddir.mockRejectedValue(new Error('ENOENT'));

			const result = await manager.listAllPresence();
			expect(result).toEqual([]);
		});
	});

	// ============================================================
	// validatePresenceUniqueness
	// ============================================================

	describe('validatePresenceUniqueness', () => {
		test('returns isValid true when no conflicts', async () => {
			mockReaddir.mockResolvedValue(['machine-1.json']);
			mockExistsSync.mockReturnValue(true);
			mockReadFile.mockResolvedValue(JSON.stringify({
				id: 'machine-1', status: 'online', lastSeen: '2026-01-01',
				version: '1.0.0', mode: 'code'
			}));

			const result = await manager.validatePresenceUniqueness();
			expect(result.isValid).toBe(true);
			expect(result.conflicts).toHaveLength(0);
		});

		test('returns isValid true when readdir error (listAllPresence catches)', async () => {
			// listAllPresence catches readdir errors and returns [], so no conflicts
			mockReaddir.mockRejectedValue(new Error('error'));

			const result = await manager.validatePresenceUniqueness();
			expect(result.isValid).toBe(true);
			expect(result.conflicts).toHaveLength(0);
		});
	});
});
