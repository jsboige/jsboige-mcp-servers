/**
 * Tests pour SkeletonCacheService
 * Issue #492 - Couverture des services non testés
 *
 * @module services/__tests__/skeleton-cache.service
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';

// #3661 — La derivation de la machine locale est celle du writer (TaskArchiver).
const LOCAL_MACHINE = os.hostname().toLowerCase();

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
	mockListArchivedTaskFiles,
	mockReadArchivedTask,
	mockReadArchivedTaskFromPath,
} = vi.hoisted(() => ({
	mockClaudeDetectLocations: vi.fn(),
	mockClaudeAnalyzeConversation: vi.fn(),
	mockListArchivedTasks: vi.fn(),
	mockListArchivedTaskFiles: vi.fn(),
	mockReadArchivedTask: vi.fn(),
	mockReadArchivedTaskFromPath: vi.fn(),
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
		listArchivedTaskFiles: mockListArchivedTaskFiles,
		readArchivedTask: mockReadArchivedTask,
		readArchivedTaskFromPath: mockReadArchivedTaskFromPath,
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

		test('#1747 D: no Roo storage (Claude-only host) — Tier 3 archives still load', async () => {
			// Measured on po-204 (Roo uninstalled): detectStorageLocations → [],
			// the old early return skipped Tiers 2/3 → cache empty forever,
			// tier3.status=loading permanent, cross-machine list unreachable.
			// #3661: le chargement a froid hydrate la machine LOCALE (fixture ci-dessous).
			mockDetectStorageLocations.mockResolvedValue([]);
			mockListArchivedTaskFiles.mockResolvedValue([
				{ taskId: 'task-local', filePath: `/mock/archive/${LOCAL_MACHINE}/task-local.json.gz`, machineId: LOCAL_MACHINE },
			]);
			mockReadArchivedTaskFromPath.mockResolvedValueOnce({
				version: 1,
				taskId: 'task-local',
				machineId: LOCAL_MACHINE,
				hostIdentifier: 'h',
				archivedAt: '2026-04-01T00:00:00Z',
				metadata: { title: 'Remote task', source: 'roo' },
				messages: []
			});

			SkeletonCacheService.configure({ enableArchiveTier: true });
			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();

			expect(mockListArchivedTaskFiles).toHaveBeenCalled();
			expect(cache.size).toBe(1);
			expect(cache.get('task-local')!.metadata.dataSource).toBe('gdrive-archive');
			expect(cache.get('task-local')!.metadata.machineId).toBe(LOCAL_MACHINE);
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

		test('configure({ enableArchiveTier: true }) stubs the FULL index — all machines (#3661)', async () => {
			setupTier1(['roo-1']);
			mockListArchivedTaskFiles.mockResolvedValue([
				{ taskId: 'archived-task-A', filePath: `/mock/archive/${LOCAL_MACHINE}/archived-task-A.json.gz`, machineId: LOCAL_MACHINE },
				{ taskId: 'archived-task-B', filePath: '/mock/archive/myia-web1/archived-task-B.json.gz', machineId: 'myia-web1' },
			]);
			mockReadArchivedTaskFromPath
				.mockResolvedValueOnce({
					version: 1,
					taskId: 'archived-task-A',
					machineId: LOCAL_MACHINE,
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

			expect(mockListArchivedTaskFiles).toHaveBeenCalled();
			// #3661 (stubs) — chaque entrée d'index est lue UNE fois pour la
			// metadata (les DEUX machines), aucun corps retenu.
			expect(mockReadArchivedTaskFromPath).toHaveBeenCalledTimes(2);
			expect(cache.has('roo-1')).toBe(true);
			expect(cache.has('archived-task-A')).toBe(true);
			expect(cache.has('archived-task-B')).toBe(true);
			expect(cache.get('archived-task-A')!.metadata.dataSource).toBe('gdrive-archive');
			expect(cache.get('archived-task-A')!.metadata.machineId).toBe(LOCAL_MACHINE);
			expect(cache.get('archived-task-B')!.metadata.machineId).toBe('myia-web1');
			for (const id of ['archived-task-A', 'archived-task-B']) {
				expect(cache.get(id)!.metadata.hydrated).toBe(false);
				expect(cache.get(id)!.sequence).toEqual([]);
			}
		});

		test('Tier 3 collision with Tier 1: local Roo wins, archive skipped', async () => {
			setupTier1(['shared-id']);
			mockListArchivedTaskFiles.mockResolvedValue([
				{ taskId: 'shared-id', filePath: `/mock/archive/${LOCAL_MACHINE}/shared-id.json.gz`, machineId: LOCAL_MACHINE },
			]);
			// Should NOT be called because Tier 1 already has 'shared-id' (filtered out before read)
			mockReadArchivedTaskFromPath.mockResolvedValue({
				version: 1,
				taskId: 'shared-id',
				machineId: LOCAL_MACHINE,
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
			expect(mockReadArchivedTaskFromPath).not.toHaveBeenCalled();
		});

		test('Tier 3 failure (e.g. ROOSYNC_SHARED_PATH unset) does not break Tier 1', async () => {
			setupTier1(['roo-1']);
			mockListArchivedTaskFiles.mockRejectedValue(new Error('ROOSYNC_SHARED_PATH not set'));

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
			mockListArchivedTaskFiles.mockResolvedValue([]);

			SkeletonCacheService.configure({ enableClaudeTier: true });
			SkeletonCacheService.configure({ enableArchiveTier: true });
			// Both flags should now be active
			const service = SkeletonCacheService.getInstance();
			await service.getCache();

			expect(mockClaudeDetectLocations).toHaveBeenCalled();
			expect(mockListArchivedTaskFiles).toHaveBeenCalled();
		});
			// ============================================================
			// #1747 sub-issue C — Cross-tier integration tests
			// ============================================================

			test('three-way collision: Tier 1 wins over Tier 3 with same taskId', async () => {
				const sharedId = 'shared-task';

				setupTier1([sharedId]);

				mockClaudeDetectLocations.mockResolvedValue([
					{ projectPath: '/home/user/.claude/projects/shared-task' }
				]);
				mockClaudeAnalyzeConversation.mockResolvedValue({
					taskId: 'claude-shared-task',
					metadata: { title: 'Claude version' },
					sequence: [{ role: 'user', content: 'from claude', timestamp: '2026-01-01T00:00:00Z' }]
				});

				mockListArchivedTaskFiles.mockResolvedValue([
					{ taskId: sharedId, filePath: `/mock/archive/${LOCAL_MACHINE}/${sharedId}.json.gz`, machineId: LOCAL_MACHINE },
				]);
				mockReadArchivedTaskFromPath.mockResolvedValue({
					version: 1,
					taskId: sharedId,
					machineId: LOCAL_MACHINE,
					hostIdentifier: 'host-remote',
					archivedAt: '2026-04-01T12:00:00Z',
					metadata: { title: 'Archive version', source: 'roo' },
					messages: [{ role: 'user', content: 'from archive', timestamp: '2026-04-01T11:59:00Z' }]
				});

				SkeletonCacheService.configure({ enableClaudeTier: true, enableArchiveTier: true });
				const service = SkeletonCacheService.getInstance();
				const cache = await service.getCache();

				expect(cache.has(sharedId)).toBe(true);
				expect(cache.get(sharedId)!.metadata.source).toBe('roo');
				expect(cache.get(sharedId)!.metadata.machineId).toBeUndefined();
				expect(mockReadArchivedTaskFromPath).not.toHaveBeenCalled();
				expect(cache.has('claude-shared-task')).toBe(true);
			});

			test('Tier 2 wins over Tier 3 when Tier 1 is absent', async () => {
				setupTier1(['other-roo-task']);

				mockClaudeDetectLocations.mockResolvedValue([
					{ projectPath: '/home/user/.claude/projects/proj-x' }
				]);
				mockClaudeAnalyzeConversation.mockResolvedValue({
					taskId: 'claude-proj-x',
					metadata: { title: 'Claude local' },
					sequence: [{ role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00Z' }]
				});

				mockListArchivedTaskFiles.mockResolvedValue([
					{ taskId: 'claude-proj-x', filePath: `/mock/archive/${LOCAL_MACHINE}/claude-proj-x.json.gz`, machineId: LOCAL_MACHINE },
				]);
				mockReadArchivedTaskFromPath.mockResolvedValue({
					version: 1,
					taskId: 'claude-proj-x',
					machineId: LOCAL_MACHINE,
					hostIdentifier: 'h',
					archivedAt: '2026-04-01T00:00:00Z',
					metadata: { title: 'Archive version', source: 'claude-code' },
					messages: []
				});

				SkeletonCacheService.configure({ enableClaudeTier: true, enableArchiveTier: true });
				const service = SkeletonCacheService.getInstance();
				const cache = await service.getCache();

				expect(cache.has('claude-proj-x')).toBe(true);
				expect(cache.get('claude-proj-x')!.metadata.source).toBe('claude-code');
				expect(cache.get('claude-proj-x')!.metadata.dataSource).toBe('claude');
				expect(mockReadArchivedTaskFromPath).not.toHaveBeenCalled();
			});

			test('forceRefresh reloads all enabled tiers', async () => {
				setupTier1(['roo-1']);
				mockClaudeDetectLocations.mockResolvedValue([]);
				mockListArchivedTaskFiles.mockResolvedValue([]);

				SkeletonCacheService.configure({ enableClaudeTier: true, enableArchiveTier: true });
				const service = SkeletonCacheService.getInstance();
				await service.getCache();

				mockClaudeDetectLocations.mockClear();
				mockListArchivedTaskFiles.mockClear();
				mockReaddir.mockClear();

				await service.forceRefresh();

				expect(mockReaddir).toHaveBeenCalled();
				expect(mockClaudeDetectLocations).toHaveBeenCalled();
				expect(mockListArchivedTaskFiles).toHaveBeenCalled();
			});

			test('#3661 — cold load stubs the WHOLE index (all machines); bodies hydrate on demand via ensureConversationHydrated', async () => {
				setupTier1(['roo-local']);
				mockListArchivedTaskFiles.mockResolvedValue([
					{ taskId: 'task-local', filePath: `/mock/archive/${LOCAL_MACHINE}/task-local.json.gz`, machineId: LOCAL_MACHINE },
					{ taskId: 'task-web1', filePath: '/mock/archive/myia-web1/task-web1.json.gz', machineId: 'myia-web1' },
				]);
				mockReadArchivedTaskFromPath.mockImplementation(async (filePath: string) => {
					if (filePath.includes('task-local')) {
						return {
							version: 1,
							taskId: 'task-local',
							machineId: LOCAL_MACHINE,
							hostIdentifier: 'host-1',
							archivedAt: '2026-04-01T12:00:00Z',
							metadata: { title: 'Local task', source: 'roo', messageCount: 1 },
							messages: [{ role: 'user', content: 'msg1', timestamp: '2026-04-01T11:59:00Z' }]
						};
					}
					return {
						version: 1,
						taskId: 'task-web1',
						machineId: 'myia-web1',
						hostIdentifier: 'host-2',
						archivedAt: '2026-04-02T12:00:00Z',
						metadata: { title: 'Web1 task', source: 'claude-code' },
						messages: []
					};
				});

				SkeletonCacheService.configure({ enableArchiveTier: true });
				const service = SkeletonCacheService.getInstance();
				const cache = await service.getCache();

				// Cold load : stubs pour TOUTES les machines — visibilite integrale,
				// corps absent (sequence vide, hydrated=false).
				expect(cache.size).toBe(3);
				for (const id of ['task-local', 'task-web1']) {
					const stub = cache.get(id)!;
					expect(stub.metadata.dataSource).toBe('gdrive-archive');
					expect(stub.metadata.hydrated).toBe(false);
					expect(stub.sequence).toEqual([]);
					expect(stub.metadata.archiveFilePath).toContain(`${id}.json.gz`);
				}
				expect(cache.get('task-local')!.metadata.machineId).toBe(LOCAL_MACHINE);
				expect(cache.get('task-local')!.metadata.title).toBe('Local task');
				expect(cache.get('task-local')!.metadata.messageCount).toBe(1);

				// On-demand : le corps de task-local s'hydrate, le stub distant reste stub.
				expect(await service.ensureConversationHydrated('task-local')).toBe(true);
				expect(cache.get('task-local')!.metadata.hydrated).toBe(true);
				expect(cache.get('task-local')!.sequence.length).toBe(1);
				expect(cache.get('task-web1')!.metadata.hydrated).toBe(false);
			});

			test('Tier 3 handles null archive gracefully', async () => {
				setupTier1(['roo-1']);
				mockListArchivedTaskFiles.mockResolvedValue([
					{ taskId: 'ghost-task', filePath: `/mock/archive/${LOCAL_MACHINE}/ghost-task.json.gz`, machineId: LOCAL_MACHINE },
					{ taskId: 'valid-task', filePath: `/mock/archive/${LOCAL_MACHINE}/valid-task.json.gz`, machineId: LOCAL_MACHINE },
				]);
				mockReadArchivedTaskFromPath
					.mockResolvedValueOnce(null)
					.mockResolvedValueOnce({
						version: 1,
						taskId: 'valid-task',
						machineId: LOCAL_MACHINE,
						hostIdentifier: 'h',
						archivedAt: '2026-04-01T00:00:00Z',
						metadata: { title: 'Valid', source: 'roo' },
						messages: []
					});

				SkeletonCacheService.configure({ enableArchiveTier: true });
				const service = SkeletonCacheService.getInstance();
				const cache = await service.getCache();

				expect(cache.size).toBe(2);
				expect(cache.has('ghost-task')).toBe(false);
				expect(cache.has('valid-task')).toBe(true);
			});

			test('Tier 2 skips entries with empty sequence', async () => {
				setupTier1(['roo-1']);
				mockClaudeDetectLocations.mockResolvedValue([
					{ projectPath: '/home/user/.claude/projects/empty-proj' },
					{ projectPath: '/home/user/.claude/projects/has-data' }
				]);
				mockClaudeAnalyzeConversation
					.mockResolvedValueOnce({
						taskId: 'claude-empty-proj',
						metadata: { title: 'Empty' },
						sequence: []
					})
					.mockResolvedValueOnce({
						taskId: 'claude-has-data',
						metadata: { title: 'Has data' },
						sequence: [{ role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00Z' }]
					});

				SkeletonCacheService.configure({ enableClaudeTier: true });
				const service = SkeletonCacheService.getInstance();
				const cache = await service.getCache();

				expect(cache.has('claude-empty-proj')).toBe(false);
				expect(cache.has('claude-has-data')).toBe(true);
				expect(cache.size).toBe(2);
			});

			test('all tiers enabled but no external data returns only Tier 1', async () => {
				setupTier1(['roo-a', 'roo-b']);
				mockClaudeDetectLocations.mockResolvedValue([]);
				mockListArchivedTasks.mockResolvedValue([]);

				SkeletonCacheService.configure({ enableClaudeTier: true, enableArchiveTier: true });
				const service = SkeletonCacheService.getInstance();
				const cache = await service.getCache();

				expect(cache.size).toBe(2);
				expect(cache.has('roo-a')).toBe(true);
				expect(cache.has('roo-b')).toBe(true);
			});
	});

	// ============================================================
	// #3661 — Tier 3 stubs (décision 5791190594) : metadata stubs au cold,
	// hydratation on-demand des corps, plafond LRU par ENTRÉE.
	// ============================================================

	describe('#3661 stub-based Tier 3 + per-entry cap LRU', () => {
		beforeEach(() => {
			delete process.env.SKELETON_ARCHIVE_TIER_MAX_MB;
		});

		afterEach(() => {
			delete process.env.SKELETON_ARCHIVE_TIER_MAX_MB;
		});

		const setupArchiveHost = (archives: Array<{ taskId: string; machineId: string; content?: string }>) => {
			mockDetectStorageLocations.mockResolvedValue([]);
			mockListArchivedTaskFiles.mockResolvedValue(
				archives.map(a => ({
					taskId: a.taskId,
					filePath: `/mock/archive/${a.machineId}/${a.taskId}.json.gz`,
					machineId: a.machineId,
				}))
			);
			mockReadArchivedTaskFromPath.mockImplementation(async (filePath: string) => {
				const hit = archives.find(a => filePath.includes(`/${a.machineId}/${a.taskId}.json.gz`));
				if (!hit) return null;
				return {
					version: 1,
					taskId: hit.taskId,
					machineId: hit.machineId,
					hostIdentifier: 'h',
					archivedAt: '2026-04-01T00:00:00Z',
					metadata: { title: hit.taskId, source: 'roo', messageCount: hit.content ? 1 : 0 },
					messages: hit.content
						? [{ role: 'user', content: hit.content, timestamp: '2026-04-01T00:00:00Z' }]
						: [],
				};
			});
		};

		test('cold load stubs every index entry — stub stays small (< 2 KiB fixture bound)', async () => {
			setupArchiveHost([
				{ taskId: 't1', machineId: LOCAL_MACHINE },
				{ taskId: 't2', machineId: 'myia-web1' },
			]);
			SkeletonCacheService.configure({ enableArchiveTier: true });
			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();

			expect(cache.size).toBe(2); // t1 + t2, toutes machines stubées
			for (const stub of cache.values()) {
				expect(stub.metadata.dataSource).toBe('gdrive-archive');
				expect(stub.metadata.hydrated).toBe(false);
				expect(stub.sequence).toEqual([]);
				// La mesure réelle du corpus (~11k archives) vit dans le body de la
				// PR #1205 ; le bound fixture garantit l'ordre de grandeur stub ≪ corps.
				expect(JSON.stringify(stub).length).toBeLessThan(2048);
			}

			const stats = await service.getCacheTierStats();
			expect(stats.tier3_index_count).toBe(2);
			expect(stats.tier3_archives).toBe(2);
			expect(stats.tier3_hydrated_count).toBe(0);
		});

		test('ensureConversationHydrated fills the body on demand and is idempotent (no re-read)', async () => {
			setupArchiveHost([
				{ taskId: 't1', machineId: LOCAL_MACHINE, content: 'needle-in-archive' },
			]);
			SkeletonCacheService.configure({ enableArchiveTier: true });
			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();
			const readsAfterCold = mockReadArchivedTaskFromPath.mock.calls.length;

			expect(await service.ensureConversationHydrated('t1')).toBe(true);
			const hydrated = cache.get('t1')!;
			expect(hydrated.metadata.hydrated).toBe(true);
			expect(hydrated.sequence.length).toBe(1);
			expect(hydrated.sequence[0]).toMatchObject({ role: 'user', content: 'needle-in-archive' });
			const readsAfterHydration = mockReadArchivedTaskFromPath.mock.calls.length;
			expect(readsAfterHydration).toBe(readsAfterCold + 1);

			// Second call: LRU touch only — pas de relecture.
			expect(await service.ensureConversationHydrated('t1')).toBe(true);
			expect(mockReadArchivedTaskFromPath.mock.calls.length).toBe(readsAfterHydration);

			const stats = await service.getCacheTierStats();
			expect(stats.tier3_hydrated_count).toBe(1);
		});

		test('ensureConversationHydrated contract: unknown taskId → false, hot-tier entry → true, archive read failure → false', async () => {
			setupArchiveHost([{ taskId: 'arch-1', machineId: LOCAL_MACHINE }]);
			// Entrée tier chaud via Tier 2 (Claude) — setupTier1 vit dans un autre
			// describe ; une entrée Claude sert le même contrat de sequence native.
			// NB: le loader dérive le taskId de `claude-<basename(projectPath)>`.
			mockClaudeDetectLocations.mockResolvedValue([
				{ projectPath: '/home/user/.claude/projects/hot' }
			]);
			mockClaudeAnalyzeConversation.mockResolvedValue({
				taskId: 'claude-hot',
				metadata: { title: 'Hot tier' },
				sequence: [{ role: 'user', content: 'resident', timestamp: '2026-01-01T00:00:00Z' }]
			});
			SkeletonCacheService.configure({ enableClaudeTier: true, enableArchiveTier: true });
			const service = SkeletonCacheService.getInstance();
			await service.getCache();

			expect(await service.ensureConversationHydrated('no-such-task')).toBe(false);
			// Entree tier chaud : sequence native residente → true sans lecture.
			expect(await service.ensureConversationHydrated('claude-hot')).toBe(true);

			mockReadArchivedTaskFromPath.mockRejectedValueOnce(new Error('gzip corrupt'));
			expect(await service.ensureConversationHydrated('arch-1')).toBe(false);
			// L'échec n'a pas marqué le stub hydraté — retentable.
			const cache = await service.getCache();
			expect(cache.get('arch-1')!.metadata.hydrated).toBe(false);
		});

		test('tier3KnowsMachine — case-insensitive match, unknown machine → false', async () => {
			setupArchiveHost([{ taskId: 't1', machineId: 'myia-web1' }]);
			SkeletonCacheService.configure({ enableArchiveTier: true });
			const service = SkeletonCacheService.getInstance();
			await service.getCache();

			expect(service.tier3KnowsMachine('MYIA-WEB1')).toBe(true);
			expect(service.tier3KnowsMachine('myia-web1')).toBe(true);
			expect(service.tier3KnowsMachine('no-such-machine')).toBe(false);
		});

		test('cap: hydrating past SKELETON_ARCHIVE_TIER_MAX_MB dehydrates the least-recent entry — the STUB survives', async () => {
			process.env.SKELETON_ARCHIVE_TIER_MAX_MB = '1';
			const big = 'x'.repeat(700 * 1024); // ~0,7 Mo de corps par entrée
			setupArchiveHost([
				{ taskId: 'local-big', machineId: LOCAL_MACHINE, content: big },
				{ taskId: 'web1-big', machineId: 'myia-web1', content: big },
			]);
			SkeletonCacheService.configure({ enableArchiveTier: true });
			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();

			// Les DEUX entrées sont visibles dès le cold (stubs, ~Ko).
			expect(cache.has('local-big')).toBe(true);
			expect(cache.has('web1-big')).toBe(true);

			expect(await service.ensureConversationHydrated('local-big')).toBe(true);
			expect(await service.ensureConversationHydrated('web1-big')).toBe(true);
			// ~1,4 Mo > 1 Mo → local-big (le moins récent) est DÉSHYDRATÉ…
			expect(cache.get('local-big')!.metadata.hydrated).toBe(false);
			expect(cache.get('local-big')!.sequence).toEqual([]);
			// …mais le STUB reste : l'entrée n'a pas quitté le cache.
			expect(cache.get('local-big')!.metadata.dataSource).toBe('gdrive-archive');
			expect(cache.get('web1-big')!.metadata.hydrated).toBe(true);

			const stats = await service.getCacheTierStats();
			expect(stats.tier3_archives).toBe(2); // visibilité intacte
			expect(stats.tier3_hydrated_count).toBe(1);
			expect(stats.tier3_cap_mb).toBe(1);
		});

		test('cap: a single body larger than the cap stays hydrated (soft floor, WARN logged)', async () => {
			process.env.SKELETON_ARCHIVE_TIER_MAX_MB = '1';
			const huge = 'y'.repeat(1500 * 1024);
			setupArchiveHost([{ taskId: 'local-huge', machineId: LOCAL_MACHINE, content: huge }]);
			SkeletonCacheService.configure({ enableArchiveTier: true });
			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();

			expect(await service.ensureConversationHydrated('local-huge')).toBe(true);
			const stats = await service.getCacheTierStats();
			expect(stats.tier3_hydrated_count).toBe(1);
			expect(stats.tier3_estimated_mb).toBeGreaterThanOrEqual(1);
		});

		test('cap stays armed after a cache refresh — hydration accounting is re-counted from the resident cache (#3661 review pt 7)', async () => {
			process.env.SKELETON_ARCHIVE_TIER_MAX_MB = '1';
			const med = 'm'.repeat(400 * 1024); // ~0,4 Mo de corps par entrée : 2 entrées = 0,8 Mo < cap
			setupArchiveHost([
				{ taskId: 'local-med', machineId: LOCAL_MACHINE, content: med },
				{ taskId: 'web1-med', machineId: 'myia-web1', content: med },
				{ taskId: 'web2-med', machineId: 'myia-web2', content: med },
			]);
			SkeletonCacheService.configure({ enableArchiveTier: true });
			const service = SkeletonCacheService.getInstance();
			const cache = await service.getCache();

			// 2 corps hydratés — les deux restent sous le cap (0,8 Mo ≤ 1 Mo).
			expect(await service.ensureConversationHydrated('local-med')).toBe(true);
			expect(await service.ensureConversationHydrated('web1-med')).toBe(true);

			// Refresh : AVANT le fix, il clear()ait l'accounting hydraté
			// → total=0 → plafond inerte. Il doit survivre au refresh.
			await service.forceRefresh();

			// 3e corps → ~1,2 Mo > 1 Mo : la déshydratation LRU doit TOUJOURS se
			// déclencher. local-med porte le tick le plus ancien (hydraté en
			// premier, jamais re-touché) → déshydraté mais STUB conservé.
			expect(await service.ensureConversationHydrated('web2-med')).toBe(true);
			expect(cache.get('web2-med')!.metadata.hydrated).toBe(true);
			expect(cache.get('local-med')!.metadata.hydrated).toBe(false);
			expect(cache.get('local-med')!.metadata.dataSource).toBe('gdrive-archive'); // stub vivant
			expect(cache.get('web1-med')!.metadata.hydrated).toBe(true);
		});

		test('archive tier disabled → ensureConversationHydrated returns false without reading', async () => {
			setupArchiveHost([{ taskId: 't1', machineId: LOCAL_MACHINE }]);
			const service = SkeletonCacheService.getInstance();

			expect(await service.ensureConversationHydrated('t1')).toBe(false);
			expect(mockReadArchivedTaskFromPath).not.toHaveBeenCalled();
			expect(mockListArchivedTaskFiles).not.toHaveBeenCalled();
		});
	});
});
