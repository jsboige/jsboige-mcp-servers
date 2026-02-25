/**
 * Tests pour SkeletonCacheService
 * Issue #492 - Couverture des services non testés
 *
 * @module services/__tests__/skeleton-cache.service
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mocks
const { mockDetectStorageLocations } = vi.hoisted(() => ({
	mockDetectStorageLocations: vi.fn()
}));

vi.mock('../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		detectStorageLocations: mockDetectStorageLocations
	}
}));

const { mockReaddir, mockReadFile, mockStat } = vi.hoisted(() => ({
	mockReaddir: vi.fn(),
	mockReadFile: vi.fn(),
	mockStat: vi.fn()
}));

vi.mock('fs', () => ({
	promises: {
		readdir: mockReaddir,
		readFile: mockReadFile,
		stat: mockStat
	}
}));

import { SkeletonCacheService } from '../skeleton-cache.service.js';

describe('SkeletonCacheService', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		SkeletonCacheService.reset();
	});

	afterEach(() => {
		SkeletonCacheService.reset();
	});

	// ============================================================
	// Singleton pattern
	// ============================================================

	describe('singleton pattern', () => {
		test('returns same instance on multiple calls', () => {
			const a = SkeletonCacheService.getInstance();
			const b = SkeletonCacheService.getInstance();
			expect(a).toBe(b);
		});

		test('reset creates new instance', () => {
			const a = SkeletonCacheService.getInstance();
			SkeletonCacheService.reset();
			const b = SkeletonCacheService.getInstance();
			expect(a).not.toBe(b);
		});
	});

	// ============================================================
	// getCache
	// ============================================================

	describe('getCache', () => {
		test('returns empty map when no storage locations', async () => {
			mockDetectStorageLocations.mockResolvedValue([]);
			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();
			expect(cache).toBeInstanceOf(Map);
			expect(cache.size).toBe(0);
		});

		test('loads skeletons from disk', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockStat.mockResolvedValue({ isDirectory: () => true });
			mockReaddir.mockResolvedValue(['task-001.json', 'task-002.json']);
			mockReadFile
				.mockResolvedValueOnce(JSON.stringify({ taskId: 'task-001', metadata: {} }))
				.mockResolvedValueOnce(JSON.stringify({ taskId: 'task-002', metadata: {} }));

			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();
			expect(cache.size).toBe(2);
			expect(cache.has('task-001')).toBe(true);
			expect(cache.has('task-002')).toBe(true);
		});

		test('filters non-json files', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockStat.mockResolvedValue({ isDirectory: () => true });
			mockReaddir.mockResolvedValue(['task-001.json', 'readme.txt', 'task-002.json']);
			mockReadFile
				.mockResolvedValueOnce(JSON.stringify({ taskId: 'task-001' }))
				.mockResolvedValueOnce(JSON.stringify({ taskId: 'task-002' }));

			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();
			expect(cache.size).toBe(2);
		});

		test('uses cache on second call within TTL', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockStat.mockResolvedValue({ isDirectory: () => true });
			mockReaddir.mockResolvedValue(['task-001.json']);
			mockReadFile.mockResolvedValue(JSON.stringify({ taskId: 'task-001' }));

			const service = SkeletonCacheService.getInstance();
			await service.getCache();
			await service.getCache();

			// Should only call readdir once (cached)
			expect(mockReaddir).toHaveBeenCalledTimes(1);
		});
	});

	// ============================================================
	// getSkeleton
	// ============================================================

	describe('getSkeleton', () => {
		test('returns specific skeleton by taskId', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockStat.mockResolvedValue({ isDirectory: () => true });
			mockReaddir.mockResolvedValue(['task-abc.json']);
			mockReadFile.mockResolvedValue(JSON.stringify({ taskId: 'task-abc', metadata: { title: 'Test' } }));

			const service = SkeletonCacheService.getInstance();
			const skeleton = await service.getSkeleton('task-abc');
			expect(skeleton).toBeDefined();
			expect(skeleton!.taskId).toBe('task-abc');
		});

		test('returns undefined for non-existent taskId', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockStat.mockResolvedValue({ isDirectory: () => true });
			mockReaddir.mockResolvedValue([]);

			const service = SkeletonCacheService.getInstance();
			const skeleton = await service.getSkeleton('nonexistent');
			expect(skeleton).toBeUndefined();
		});
	});

	// ============================================================
	// has
	// ============================================================

	describe('has', () => {
		test('returns true for existing task', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockStat.mockResolvedValue({ isDirectory: () => true });
			mockReaddir.mockResolvedValue(['task-001.json']);
			mockReadFile.mockResolvedValue(JSON.stringify({ taskId: 'task-001' }));

			const service = SkeletonCacheService.getInstance();
			expect(await service.has('task-001')).toBe(true);
		});

		test('returns false for non-existing task', async () => {
			mockDetectStorageLocations.mockResolvedValue([]);

			const service = SkeletonCacheService.getInstance();
			expect(await service.has('missing')).toBe(false);
		});
	});

	// ============================================================
	// getAllSkeletons
	// ============================================================

	describe('getAllSkeletons', () => {
		test('returns all skeletons as array', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockStat.mockResolvedValue({ isDirectory: () => true });
			mockReaddir.mockResolvedValue(['t1.json', 't2.json']);
			mockReadFile
				.mockResolvedValueOnce(JSON.stringify({ taskId: 't1' }))
				.mockResolvedValueOnce(JSON.stringify({ taskId: 't2' }));

			const service = SkeletonCacheService.getInstance();
			const all = await service.getAllSkeletons();
			expect(all).toHaveLength(2);
			expect(all.map(s => s.taskId)).toEqual(expect.arrayContaining(['t1', 't2']));
		});
	});

	// ============================================================
	// forceRefresh
	// ============================================================

	describe('forceRefresh', () => {
		test('reloads cache from disk', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockStat.mockResolvedValue({ isDirectory: () => true });
			mockReaddir.mockResolvedValue(['t1.json']);
			mockReadFile.mockResolvedValue(JSON.stringify({ taskId: 't1' }));

			const service = SkeletonCacheService.getInstance();
			await service.getCache(); // First load
			await service.forceRefresh(); // Force reload

			// readdir called twice (initial + refresh)
			expect(mockReaddir).toHaveBeenCalledTimes(2);
		});
	});

	// ============================================================
	// Error handling
	// ============================================================

	describe('error handling', () => {
		test('handles skeleton directory not existing', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockStat.mockRejectedValue(new Error('ENOENT'));

			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();
			expect(cache.size).toBe(0);
		});

		test('handles non-directory stat result', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockStat.mockResolvedValue({ isDirectory: () => false });

			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();
			expect(cache.size).toBe(0);
		});

		test('skips files with invalid JSON', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockStat.mockResolvedValue({ isDirectory: () => true });
			mockReaddir.mockResolvedValue(['good.json', 'bad.json']);
			mockReadFile
				.mockResolvedValueOnce(JSON.stringify({ taskId: 'good' }))
				.mockResolvedValueOnce('not valid json{{{');

			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();
			expect(cache.size).toBe(1);
			expect(cache.has('good')).toBe(true);
		});

		test('skips skeletons without taskId', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockStat.mockResolvedValue({ isDirectory: () => true });
			mockReaddir.mockResolvedValue(['no-id.json']);
			mockReadFile.mockResolvedValue(JSON.stringify({ metadata: {} }));

			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();
			expect(cache.size).toBe(0);
		});
	});
});
