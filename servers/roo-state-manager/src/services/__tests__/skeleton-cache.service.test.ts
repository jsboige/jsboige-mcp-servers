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

// #1244 Couche 1.1 — Mocks pour les tiers multi-source
const {
	mockClaudeDetectLocations,
	mockClaudeAnalyzeConversation,
	mockListArchivedTasks,
	mockReadArchivedTask,
} = vi.hoisted(() => ({
	mockClaudeDetectLocations: vi.fn(),
	mockClaudeAnalyzeConversation: vi.fn(),
	mockListArchivedTasks: vi.fn(),
	mockReadArchivedTask: vi.fn(),
}));

vi.mock('../../utils/claude-storage-detector.js', () => ({
	ClaudeStorageDetector: {
		detectStorageLocations: mockClaudeDetectLocations,
		analyzeConversation: mockClaudeAnalyzeConversation,
	}
}));

vi.mock('../task-archiver/index.js', () => ({
	TaskArchiver: {
		listArchivedTasks: mockListArchivedTasks,
		readArchivedTask: mockReadArchivedTask,
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

			// FIX #1123: BOM in skeleton file should be stripped before JSON.parse
			test("loads skeleton files with UTF-8 BOM prefix", async () => {
				mockDetectStorageLocations.mockResolvedValue(["/mock/storage"]);
				mockStat.mockResolvedValue({ isDirectory: () => true });
				mockReaddir.mockResolvedValue(["bom-skeleton.json"]);
				// BOM char (0xFEFF) + valid JSON
				const bomJson = "﻿" + JSON.stringify({ taskId: "bom-test", metadata: { mode: "code-simple" } });
				mockReadFile.mockResolvedValue(bomJson);

				const service = SkeletonCacheService.getInstance();
				const cache = await service.getCache();
				expect(cache.size).toBe(1);
				expect(cache.has("bom-test")).toBe(true);
			});
	});

	// ============================================================
	// #1244 Couche 1.1 — Multi-tier cache (Claude local + archives GDrive)
	// ============================================================

	describe('#1244 multi-tier cache', () => {
		// Tier 1 baseline shared by all tier tests below
		const setupTier1 = (taskIds: string[] = []) => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockStat.mockResolvedValue({ isDirectory: () => true });
			mockReaddir.mockResolvedValue(taskIds.map(id => `${id}.json`));
			for (const id of taskIds) {
				mockReadFile.mockResolvedValueOnce(JSON.stringify({ taskId: id, metadata: { source: 'roo' } }));
			}
		};

		test('default config: neither Claude tier nor archive tier are loaded', async () => {
			setupTier1(['roo-1']);
			// Even if the mocks would return data, opt-in is required
			mockClaudeDetectLocations.mockResolvedValue([{ projectPath: '/home/user/.claude/projects/proj-x' }]);
			mockListArchivedTasks.mockResolvedValue(['archived-1']);

			const service = SkeletonCacheService.getInstance();
			await service.getCache();

			expect(mockClaudeDetectLocations).not.toHaveBeenCalled();
			expect(mockListArchivedTasks).not.toHaveBeenCalled();
		});

		test('configure({ enableClaudeTier: true }) loads Tier 2', async () => {
			setupTier1(['roo-1']);
			mockClaudeDetectLocations.mockResolvedValue([
				{ projectPath: '/home/user/.claude/projects/proj-alpha' }
			]);
			mockClaudeAnalyzeConversation.mockResolvedValue({
				taskId: 'claude-proj-alpha',
				metadata: { title: 'Alpha session' },
				sequence: [{ role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00Z' }]
			});

			SkeletonCacheService.configure({ enableClaudeTier: true });
			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();

			expect(mockClaudeDetectLocations).toHaveBeenCalled();
			expect(mockClaudeAnalyzeConversation).toHaveBeenCalledWith(
				'claude-proj-alpha',
				'/home/user/.claude/projects/proj-alpha'
			);
			expect(cache.has('roo-1')).toBe(true);
			expect(cache.has('claude-proj-alpha')).toBe(true);
			expect(cache.get('claude-proj-alpha')!.metadata.source).toBe('claude-code');
			expect(cache.get('claude-proj-alpha')!.metadata.dataSource).toBe('claude');
		});

		test('Tier 2 collision with Tier 1: local Roo wins', async () => {
			// Tier 1 already has 'claude-proj-alpha' (unusual but possible if user names it that way)
			setupTier1(['claude-proj-alpha']);
			mockClaudeDetectLocations.mockResolvedValue([
				{ projectPath: '/home/user/.claude/projects/proj-alpha' }
			]);
			// Should NOT be called because cache.has('claude-proj-alpha') is already true
			mockClaudeAnalyzeConversation.mockResolvedValue({
				taskId: 'claude-proj-alpha',
				metadata: { title: 'SHOULD NOT OVERWRITE' },
				sequence: [{ role: 'user', content: 'x', timestamp: '2026-01-01T00:00:00Z' }]
			});

			SkeletonCacheService.configure({ enableClaudeTier: true });
			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();

			expect(cache.has('claude-proj-alpha')).toBe(true);
			// Tier 1 metadata preserved (source roo, not the Claude title)
			expect(cache.get('claude-proj-alpha')!.metadata.source).toBe('roo');
			expect(mockClaudeAnalyzeConversation).not.toHaveBeenCalled();
		});

		test('Tier 2 failure does not break Tier 1 loading', async () => {
			setupTier1(['roo-1']);
			mockClaudeDetectLocations.mockRejectedValue(new Error('Claude detector boom'));

			SkeletonCacheService.configure({ enableClaudeTier: true });
			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();

			// Tier 1 still works despite Tier 2 failure
			expect(cache.has('roo-1')).toBe(true);
			expect(cache.size).toBe(1);
		});

		test('configure({ enableArchiveTier: true }) loads Tier 3', async () => {
			setupTier1(['roo-1']);
			mockListArchivedTasks.mockResolvedValue(['archived-task-A', 'archived-task-B']);
			mockReadArchivedTask
				.mockResolvedValueOnce({
					version: 1,
					taskId: 'archived-task-A',
					machineId: 'myia-po-2025',
					hostIdentifier: 'host-1',
					archivedAt: '2026-04-01T12:00:00Z',
					metadata: { title: 'Archived A', source: 'roo' },
					messages: [{ role: 'user', content: 'archived msg', timestamp: '2026-04-01T11:59:00Z' }]
				})
				.mockResolvedValueOnce({
					version: 1,
					taskId: 'archived-task-B',
					machineId: 'myia-web1',
					hostIdentifier: 'host-2',
					archivedAt: '2026-04-02T12:00:00Z',
					metadata: { title: 'Archived B', source: 'claude-code' },
					messages: []
				});

			SkeletonCacheService.configure({ enableArchiveTier: true });
			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();

			expect(mockListArchivedTasks).toHaveBeenCalled();
			expect(mockReadArchivedTask).toHaveBeenCalledTimes(2);
			expect(cache.has('roo-1')).toBe(true);
			expect(cache.has('archived-task-A')).toBe(true);
			expect(cache.has('archived-task-B')).toBe(true);
			expect(cache.get('archived-task-A')!.metadata.dataSource).toBe('archive');
			expect(cache.get('archived-task-A')!.metadata.machineId).toBe('myia-po-2025');
		});

		test('Tier 3 collision with Tier 1: local Roo wins, archive skipped', async () => {
			setupTier1(['shared-id']);
			mockListArchivedTasks.mockResolvedValue(['shared-id']);
			// Should NOT be called because Tier 1 already has 'shared-id'
			mockReadArchivedTask.mockResolvedValue({
				version: 1,
				taskId: 'shared-id',
				machineId: 'remote-machine',
				hostIdentifier: 'h',
				archivedAt: '2026-04-01T00:00:00Z',
				metadata: { title: 'SHOULD NOT OVERWRITE' },
				messages: []
			});

			SkeletonCacheService.configure({ enableArchiveTier: true });
			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();

			expect(cache.has('shared-id')).toBe(true);
			// Tier 1 entry preserved — no machineId from archive
			expect(cache.get('shared-id')!.metadata.machineId).toBeUndefined();
			expect(mockReadArchivedTask).not.toHaveBeenCalled();
		});

		test('Tier 3 failure (e.g. ROOSYNC_SHARED_PATH unset) does not break Tier 1', async () => {
			setupTier1(['roo-1']);
			mockListArchivedTasks.mockRejectedValue(new Error('ROOSYNC_SHARED_PATH not set'));

			SkeletonCacheService.configure({ enableArchiveTier: true });
			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();

			expect(cache.has('roo-1')).toBe(true);
			expect(cache.size).toBe(1);
		});

		test('reset() clears the static config (so next test starts clean)', async () => {
			setupTier1([]);
			mockClaudeDetectLocations.mockResolvedValue([]);

			SkeletonCacheService.configure({ enableClaudeTier: true });
			SkeletonCacheService.reset();

			const service = SkeletonCacheService.getInstance();
			await service.getCache();

			// After reset, config is empty → Claude tier should NOT have been called
			expect(mockClaudeDetectLocations).not.toHaveBeenCalled();
		});

		test('configure() merges flags across calls (idempotent)', async () => {
			setupTier1(['roo-1']);
			mockClaudeDetectLocations.mockResolvedValue([]);
			mockListArchivedTasks.mockResolvedValue([]);

			SkeletonCacheService.configure({ enableClaudeTier: true });
			SkeletonCacheService.configure({ enableArchiveTier: true });
			// Both flags should now be active
			const service = SkeletonCacheService.getInstance();
			await service.getCache();

			expect(mockClaudeDetectLocations).toHaveBeenCalled();
			expect(mockListArchivedTasks).toHaveBeenCalled();
		});
	});
});
