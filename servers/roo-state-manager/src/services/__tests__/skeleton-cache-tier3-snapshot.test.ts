/**
 * #1747 E (requalifié) — Snapshot local des stubs Tier 3.
 *
 * Mesure fondatrice (ai-01, 30/09 ; po-2027 24/09 ; po-204) : le cold load
 * GDrive (listing + lecture de chaque .json.gz) dépasse le budget
 * `waitForArchives` de 45 s — pendant la fenêtre, `list includeArchives` rend
 * 0 + tier3_status=loading. Le snapshot casse la fenêtre : seed immédiat au
 * boot (~1-2 s), scan GDrive en rattrapage arrière-plan.
 *
 * @module services/__tests__/skeleton-cache-tier3-snapshot
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';

const { mockDetectStorageLocations } = vi.hoisted(() => ({
	mockDetectStorageLocations: vi.fn()
}));

vi.mock('../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		detectStorageLocations: mockDetectStorageLocations
	}
}));

const {
	mockReaddir,
	mockReadFile,
	mockStat,
	mockWriteFile,
	mockMkdir,
	mockRename,
	mockAccess,
} = vi.hoisted(() => ({
	mockReaddir: vi.fn(),
	mockReadFile: vi.fn(),
	mockStat: vi.fn(),
	mockWriteFile: vi.fn(),
	mockRename: vi.fn(),
	mockMkdir: vi.fn(),
	mockAccess: vi.fn(),
}));

vi.mock('fs', () => ({
	promises: {
		readdir: mockReaddir,
		readFile: mockReadFile,
		stat: mockStat,
		writeFile: mockWriteFile,
		mkdir: mockMkdir,
		rename: mockRename,
		access: mockAccess,
	}
}));

const {
	mockClaudeDetectLocations,
	mockListArchivedTaskFiles,
	mockReadArchivedTaskFromPath,
} = vi.hoisted(() => ({
	mockClaudeDetectLocations: vi.fn(),
	mockListArchivedTaskFiles: vi.fn(),
	mockReadArchivedTaskFromPath: vi.fn(),
}));

vi.mock('../../utils/claude-storage-detector.js', () => ({
	ClaudeStorageDetector: {
		detectStorageLocations: mockClaudeDetectLocations,
	}
}));

vi.mock('../task-archiver/index.js', () => ({
	TaskArchiver: {
		listArchivedTaskFiles: mockListArchivedTaskFiles,
		readArchivedTaskFromPath: mockReadArchivedTaskFromPath,
	}
}));

import { SkeletonCacheService, TIER3_SNAPSHOT_VERSION } from '../skeleton-cache.service.js';
import { ConversationSkeleton } from '../../types/conversation.js';

// Absolu sur l'OS courant : le service n'honore l'override que s'il passe
// `path.isAbsolute` — un 'C:/...' littéral est relatif sous POSIX (runner CI Linux).
// fs est entièrement mocké : aucun accès disque réel.
const SNAPSHOT_PATH = path.join(os.tmpdir(), 'fake-home', '.roo-state-manager', 'tier3-stub-snapshot.json');

function makeStub(taskId: string, machineId: string): ConversationSkeleton {
	return {
		taskId,
		sequence: [],
		metadata: {
			title: `stub ${taskId}`,
			createdAt: '2026-09-01T00:00:00.000Z',
			lastActivity: '2026-09-02T00:00:00.000Z',
			messageCount: 3,
			actionCount: 0,
			totalSize: 0,
			machineId,
			source: 'roo',
			dataSource: 'gdrive-archive',
			hydrated: false,
			archiveFilePath: `G:/fake/task-archive/${machineId}/${taskId}.json.gz`,
		},
	} as ConversationSkeleton;
}

function snapshotPayload(stubs: ConversationSkeleton[], savedAt = Date.now()): string {
	// #1353 : adossé à la constante — un bump de version doit invalider les
	// snapshots persistés (re-seed), et le test suit sans retoucher la fixture.
	return JSON.stringify({ version: TIER3_SNAPSHOT_VERSION, savedAt, stubs });
}

/** Configure un environnement "machine Claude-only" : aucun storage Roo,
 *  aucun projet Claude — le seed snapshot est la seule source du cache. */
function configureBareHost(): void {
	mockDetectStorageLocations.mockResolvedValue([]);
	mockClaudeDetectLocations.mockResolvedValue([]);
}

describe('SkeletonCacheService — Tier 3 stub snapshot (#1747 E)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		SkeletonCacheService.reset();
		process.env.SKELETON_TIER3_SNAPSHOT = SNAPSHOT_PATH;
		SkeletonCacheService.configure({ enableArchiveTier: true });
	});

	afterEach(() => {
		delete process.env.SKELETON_TIER3_SNAPSHOT;
		SkeletonCacheService.reset();
	});

	test('seed depuis le snapshot : service immédiat pendant que le scan GDrive pend', async () => {
		configureBareHost();
		const stubs = [makeStub('task-a', 'myia-po-2025'), makeStub('task-b', 'myia-po-2024')];
		mockReadFile.mockImplementation(async (p: string) => {
			if (p === SNAPSHOT_PATH) return snapshotPayload(stubs);
			throw new Error(`unexpected read: ${p}`);
		});
		// Le scan GDrive de rattrapage ne résout JAMAIS : sans le fast-path
		// seed, awaitFreshnessWithBudget(0) rendrait false (loading).
		mockListArchivedTaskFiles.mockImplementation(() => new Promise(() => { }));

		const instance = SkeletonCacheService.getInstance();
		// Prewarm boot (fire-and-forget, comme background-services) :
		const warming = instance.warmCache();
		await new Promise(r => setTimeout(r, 50)); // laisse le seed se poser

		expect(await instance.awaitFreshnessWithBudget(0)).toBe(true);
		const cache = instance.getCacheImmediate();
		expect(cache.size).toBe(2);
		expect(cache.get('task-a')?.metadata?.machineId).toBe('myia-po-2025');
		expect(instance.tier3KnowsMachine('myia-po-2024')).toBe(true);
		expect(instance.tier3KnowsMachine('myia-unknown')).toBe(false);

		const stats = await instance.getCacheTierStats();
		expect(stats.tier3_snapshot.seeded).toBe(true);
		expect(stats.tier3_snapshot.entries).toBe(2);
		expect(stats.tier3_snapshot.savedAt).toBeTypeOf('number');
		expect(stats.tier3_archives).toBe(2);

		// Le warming reste pendants (scan jamais résolu) — ne pas l'attendre.
		void warming;
	});

	test('seed défensif : un stub portant un corps hydraté est re-stubbé', async () => {
		configureBareHost();
		const bloated = makeStub('task-a', 'myia-po-2025');
		(bloated as any).sequence = [{ role: 'user', content: 'body' }];
		bloated.metadata!.hydrated = true;
		mockReadFile.mockResolvedValue(snapshotPayload([bloated]));
		mockListArchivedTaskFiles.mockResolvedValue([]);

		const instance = SkeletonCacheService.getInstance();
		await instance.warmCache();

		const entry = instance.getCacheImmediate().get('task-a');
		expect(entry?.sequence).toEqual([]);
		expect(entry?.metadata?.hydrated).toBe(false);
	});

	test('cold load complet : snapshot persisté (atomic write), stubs sans corps', async () => {
		configureBareHost();
		mockReadFile.mockRejectedValue({ code: 'ENOENT' }); // pas de snapshot
		mockListArchivedTaskFiles.mockResolvedValue([
			{ taskId: 'task-a', filePath: 'G:/fake/task-archive/myia-po-2025/task-a.json.gz', machineId: 'myia-po-2025' },
			{ taskId: 'task-b', filePath: 'G:/fake/task-archive/myia-po-2024/task-b.json.gz', machineId: 'myia-po-2024' },
		]);
		mockReadArchivedTaskFromPath.mockImplementation(async (p: string) => ({
			// Attention : 'task-archive' contient 'task-a' — matcher sur le nom de fichier.
			taskId: p.includes('task-a.json.gz') ? 'task-a' : 'task-b',
			machineId: p.includes('myia-po-2025') ? 'myia-po-2025' : 'myia-po-2024',
			archivedAt: '2026-09-28T00:00:00.000Z',
			metadata: { title: 'arch', createdAt: '2026-09-01T00:00:00.000Z', lastActivity: '2026-09-02T00:00:00.000Z', messageCount: 2 },
			messages: [
				{ role: 'user', content: 'hello', timestamp: '2026-09-01T00:00:00.000Z' },
				{ role: 'assistant', content: 'world', timestamp: '2026-09-01T00:00:01.000Z' },
			],
		}));

		const instance = SkeletonCacheService.getInstance();
		await instance.warmCache();

		expect(mockWriteFile).toHaveBeenCalledTimes(1);
		const tmpPath = mockWriteFile.mock.calls[0][0] as string;
		expect(tmpPath).toContain('.tmp-');
		const payload = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
		expect(payload.version).toBe(TIER3_SNAPSHOT_VERSION);
		expect(payload.stubs).toHaveLength(2);
		for (const stub of payload.stubs) {
			expect(stub.sequence).toEqual([]);
			expect(stub.metadata.hydrated).toBe(false);
			expect(stub.metadata.archiveFilePath).toContain('task-archive');
		}
		expect(mockRename).toHaveBeenCalledWith(tmpPath, SNAPSHOT_PATH);
		expect(mockMkdir).toHaveBeenCalled();
	});

	test('persist sanitarise les corps hydratés résidents', async () => {
		configureBareHost();
		mockListArchivedTaskFiles.mockResolvedValue([
			{ taskId: 'task-a', filePath: 'G:/fake/task-archive/myia-po-2025/task-a.json.gz', machineId: 'myia-po-2025' },
		]);
		const archive = {
			taskId: 'task-a',
			machineId: 'myia-po-2025',
			archivedAt: '2026-09-28T00:00:00.000Z',
			metadata: { createdAt: '2026-09-01T00:00:00.000Z', lastActivity: '2026-09-02T00:00:00.000Z', messageCount: 2 },
			messages: [
				{ role: 'user', content: 'hello', timestamp: '2026-09-01T00:00:00.000Z' },
				{ role: 'assistant', content: 'world', timestamp: '2026-09-01T00:00:01.000Z' },
			],
		};
		mockReadArchivedTaskFromPath.mockResolvedValue(archive);
		mockReadFile.mockRejectedValue({ code: 'ENOENT' });

		const instance = SkeletonCacheService.getInstance();
		await instance.warmCache();
		// Hydrater le corps (résident en mémoire)...
		mockWriteFile.mockClear();
		mockReadArchivedTaskFromPath.mockClear();
		expect(await instance.ensureConversationHydrated('task-a')).toBe(true);
		expect(instance.getCacheImmediate().get('task-a')?.sequence?.length).toBeGreaterThan(0);
		// ...puis persister : le snapshot ne doit PAS emporter le corps. Le stub
		// sanitisé est identique à celui déjà écrit au warm → aucune réécriture.
		const internals = instance as unknown as {
			persistTier3Snapshot(): Promise<void>;
			tier3SnapshotSignature: string | null;
		};
		await internals.persistTier3Snapshot();
		expect(mockWriteFile).not.toHaveBeenCalled();
		// Forcer l'écriture pour inspecter ce qui serait persisté.
		internals.tier3SnapshotSignature = null;
		await internals.persistTier3Snapshot();
		expect(mockWriteFile).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
		const persisted = payload.stubs.find((s: any) => s.taskId === 'task-a');
		expect(persisted.sequence).toEqual([]);
		expect(persisted.metadata.hydrated).toBe(false);
		// Le corps reste résident en mémoire (la persistance ne déshydrate pas).
		expect(instance.getCacheImmediate().get('task-a')?.sequence?.length).toBeGreaterThan(0);
	});

	test('snapshot corrompu : no-op silencieux, cold load GDrive comme avant', async () => {
		configureBareHost();
		mockReadFile.mockResolvedValue('{not json');
		mockListArchivedTaskFiles.mockResolvedValue([]);

		const instance = SkeletonCacheService.getInstance();
		await expect(instance.warmCache()).resolves.toBeUndefined();
		expect(await instance.awaitFreshnessWithBudget(0)).toBe(false);
		const stats = await instance.getCacheTierStats();
		expect(stats.tier3_snapshot.seeded).toBe(false);
		expect(stats.tier3_snapshot.entries).toBe(0);
	});

	test('SKELETON_TIER3_SNAPSHOT vide : snapshot désactivé (comportement pré-E)', async () => {
		process.env.SKELETON_TIER3_SNAPSHOT = '';
		configureBareHost();
		mockListArchivedTaskFiles.mockResolvedValue([]);

		const instance = SkeletonCacheService.getInstance();
		await instance.warmCache();
		expect(mockReadFile).not.toHaveBeenCalledWith(SNAPSHOT_PATH, 'utf-8');
		expect(mockWriteFile).not.toHaveBeenCalled();
	});

	test('collision local-first : le skeleton Tier 1 local écrase le stub semé', async () => {
		// Storage Roo présent avec un skeleton local pour task-a.
		mockDetectStorageLocations.mockResolvedValue(['C:/fake/roo/storage']);
		mockClaudeDetectLocations.mockResolvedValue([]);
		const localSkeleton = {
			taskId: 'task-a',
			sequence: [],
			metadata: {
				title: 'local wins',
				createdAt: '2026-09-01T00:00:00.000Z',
				lastActivity: '2026-09-03T00:00:00.000Z',
				messageCount: 5,
			},
		};
		mockStat.mockImplementation(async (p: string) => ({
			isDirectory: () => !p.endsWith('.json'),
		}));
		mockReaddir.mockImplementation(async (p: string) => {
			// path.join produit des backslashes sur win32 — normaliser avant de matcher.
			if (p.replace(/\\/g, '/').includes('tasks/.skeletons')) return ['task-a.json'];
			return []; // tasks/ : aucun dossier de conversation à builder
		});
		mockReadFile.mockImplementation(async (p: string) => {
			if (p === SNAPSHOT_PATH) return snapshotPayload([makeStub('task-a', 'myia-po-2025')]);
			if (p.endsWith('task-a.json')) return JSON.stringify(localSkeleton);
			throw new Error(`unexpected read: ${p}`);
		});
		mockListArchivedTaskFiles.mockResolvedValue([]);

		const instance = SkeletonCacheService.getInstance();
		await instance.warmCache();

		const entry = instance.getCacheImmediate().get('task-a');
		// L'entree locale fait foi (le stub semé n'a pas survécu à la collision).
		expect(entry?.metadata?.title).toBe('local wins');
		expect(entry?.metadata?.dataSource).toBeUndefined();
	});

	test('GDrive indisponible au load : le seed reste servi (stale > vide), pas de persist', async () => {
		configureBareHost();
		const stubs = [makeStub('task-a', 'myia-po-2025')];
		mockReadFile.mockImplementation(async (p: string) => {
			if (p === SNAPSHOT_PATH) return snapshotPayload(stubs);
			throw new Error(`unexpected read: ${p}`);
		});
		mockListArchivedTaskFiles.mockRejectedValue(new Error('GDrive down'));

		const instance = SkeletonCacheService.getInstance();
		await instance.warmCache();
		expect(await instance.awaitFreshnessWithBudget(0)).toBe(true);
		expect(instance.getCacheImmediate().size).toBe(1);
		// Aucun persist : un GDrive indisponible ne doit pas réécrire le snapshot.
		expect(mockWriteFile).not.toHaveBeenCalled();
	});

	test('scan sans nouveauté : pas de réécriture ; nouvelle archive : réécriture', async () => {
		configureBareHost();
		const stubs = [makeStub('task-a', 'myia-po-2025'), makeStub('task-b', 'myia-po-2024')];
		mockReadFile.mockImplementation(async (p: string) => {
			if (p === SNAPSHOT_PATH) return snapshotPayload(stubs);
			throw new Error(`unexpected read: ${p}`);
		});
		// Le scan GDrive ne trouve rien de plus que le snapshot.
		mockListArchivedTaskFiles.mockResolvedValue([
			{ taskId: 'task-a', filePath: 'G:/fake/task-archive/myia-po-2025/task-a.json.gz', machineId: 'myia-po-2025' },
			{ taskId: 'task-b', filePath: 'G:/fake/task-archive/myia-po-2024/task-b.json.gz', machineId: 'myia-po-2024' },
		]);

		const instance = SkeletonCacheService.getInstance();
		await instance.warmCache();
		expect(instance.getCacheImmediate().size).toBe(2);
		expect(mockWriteFile).not.toHaveBeenCalled();

		// Une archive apparaît : le contenu change, le snapshot est réécrit.
		instance.getCacheImmediate().set('task-c', makeStub('task-c', 'myia-po-2023'));
		await (instance as unknown as { persistTier3Snapshot(): Promise<void> }).persistTier3Snapshot();
		expect(mockWriteFile).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
		expect(payload.stubs.map((s: any) => s.taskId)).toEqual(['task-a', 'task-b', 'task-c']);
		expect(mockRename).toHaveBeenCalledWith(mockWriteFile.mock.calls[0][0], SNAPSHOT_PATH);
	});
});
