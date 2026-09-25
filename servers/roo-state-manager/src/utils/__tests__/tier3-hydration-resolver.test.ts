/**
 * #3661 AC8 — Branchement de l'hydratation Tier 3 dans les resolvers.
 * Avant ce branchement, `ensureConversationHydrated` n'avait aucun appelant
 * prod : le view d'une archive Tier 3 (stub, séquence vide) rendait null alors
 * qu'elle apparaissait dans `list includeArchives` (régression post-stubs,
 * mesurée en prod po-2024 le 24/09 — issue #3661, comment 5811382263).
 *
 * @module utils/__tests__/tier3-hydration-resolver
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const { peekMock, hydrateMock } = vi.hoisted(() => ({
	peekMock: vi.fn(),
	hydrateMock: vi.fn(),
}));

vi.mock('../../services/skeleton-cache.service.js', () => ({
	SkeletonCacheService: {
		getInstance: () => ({
			peekSkeleton: peekMock,
			ensureConversationHydrated: hydrateMock,
		}),
		reset: vi.fn(),
		configure: vi.fn(),
	},
}));

const { mockDetectStorageLocations } = vi.hoisted(() => ({
	mockDetectStorageLocations: vi.fn(),
}));

vi.mock('../roo-storage-detector.js', () => ({
	RooStorageDetector: {
		detectStorageLocations: mockDetectStorageLocations,
	},
}));

import { hydrateTier3SkeletonFromCache, resolveFullConversationSkeleton } from '../server-helpers.js';

const tier3Stub = (taskId: string) => ({
	taskId,
	metadata: { dataSource: 'gdrive-archive', machineId: 'myia-web1', hydrated: false, messageCount: 12 },
	sequence: [],
} as any);

const tier3Body = (taskId: string) => ({
	taskId,
	metadata: { dataSource: 'gdrive-archive', machineId: 'myia-web1', hydrated: true, messageCount: 12 },
	sequence: [{ role: 'user', content: 'distant body', timestamp: '2026-09-24T00:00:00Z' }],
} as any);

describe('#3661 AC8 — hydrateTier3SkeletonFromCache', () => {
	beforeEach(() => {
		peekMock.mockReset();
		hydrateMock.mockReset();
		// #1217 follow-up 3 : le garde de précédence sonde les locations Roo —
		// défaut déterministe « aucune location » (l'archive n'a jamais de
		// dossier local).
		mockDetectStorageLocations.mockReset();
		mockDetectStorageLocations.mockResolvedValue([]);
	});

	test('Tier 3 stub hot → hydrates on demand and returns the body', async () => {
		peekMock.mockReturnValueOnce(tier3Stub('t-web1')).mockReturnValueOnce(tier3Body('t-web1'));
		hydrateMock.mockResolvedValue(true);

		const result = await hydrateTier3SkeletonFromCache('t-web1');
		expect(hydrateMock).toHaveBeenCalledWith('t-web1');
		expect(result).not.toBeNull();
		expect(result!.taskId).toBe('t-web1');
		expect((result as any).metadata.hydrated).toBe(true);
		expect(result!.sequence.length).toBe(1);
	});

	test('cold host (peek undefined) → null, hydration never attempted', async () => {
		peekMock.mockReturnValue(undefined);
		expect(await hydrateTier3SkeletonFromCache('t-web1')).toBeNull();
		expect(hydrateMock).not.toHaveBeenCalled();
	});

	test('non-Tier 3 entry (claude tier) → null, hydration never attempted', async () => {
		peekMock.mockReturnValue({ taskId: 'claude-x', metadata: { dataSource: 'claude' }, sequence: [] } as any);
		expect(await hydrateTier3SkeletonFromCache('claude-x')).toBeNull();
		expect(hydrateMock).not.toHaveBeenCalled();
	});

	test('hydration failure (archive unreadable) → null', async () => {
		peekMock.mockReturnValue(tier3Stub('t-web1'));
		hydrateMock.mockResolvedValue(false);
		expect(await hydrateTier3SkeletonFromCache('t-web1')).toBeNull();
	});

	test('hydration throws → null (never propagates)', async () => {
		peekMock.mockReturnValue(tier3Stub('t-web1'));
		hydrateMock.mockRejectedValue(new Error('GDrive down'));
		expect(await hydrateTier3SkeletonFromCache('t-web1')).toBeNull();
	});

	test('stub survivant après éviction (re-peek hydrated=false) → null, jamais rendu comme résolu', async () => {
		// ensureConversationHydrated peut rendre true alors qu'une éviction LRU
		// concurrente a déjà re-stubbé l'entrée : un corps vide ne doit pas
		// passer pour la résolution de l'archive.
		peekMock.mockReturnValue(tier3Stub('t-web1'));
		hydrateMock.mockResolvedValue(true);
		expect(await hydrateTier3SkeletonFromCache('t-web1')).toBeNull();
	});

	test('write-back : le corps hydraté est publié dans le cache appelant', async () => {
		peekMock.mockReturnValueOnce(tier3Stub('t-web1')).mockReturnValueOnce(tier3Body('t-web1'));
		hydrateMock.mockResolvedValue(true);
		const cache = new Map();

		const result = await hydrateTier3SkeletonFromCache('t-web1', cache as any);
		expect(result).not.toBeNull();
		expect(cache.get('t-web1')).toBeDefined();
		expect((cache.get('t-web1') as any).sequence.length).toBe(1);
	});

	test('#1217 follow-up 3 — précédence local > archive : une tâche locale UTILISABLE court-circuite la branche, hydratation jamais tentée', async () => {
		// Vrai mkdir (pas un mock de existsSync) : le garde doit voir le dossier
		// comme le runtime le verra. #1225 follow-up : le dossier doit porter un
		// fichier qu'analyzeConversation sait lire — c'est lui, pas le dossier,
		// qui signale une tâche locale vivante.
		const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'tier3-guard-'));
		const taskDir = path.join(tmpBase, 'tasks', 't-web1');
		await fs.mkdir(taskDir, { recursive: true });
		await fs.writeFile(path.join(taskDir, 'ui_messages.json'), '[]');
		try {
			peekMock.mockReturnValue(tier3Stub('t-web1'));
			mockDetectStorageLocations.mockResolvedValue([tmpBase]);
			hydrateMock.mockResolvedValue(true);

			expect(await hydrateTier3SkeletonFromCache('t-web1')).toBeNull();
			expect(hydrateMock).not.toHaveBeenCalled();
		} finally {
			await fs.rm(tmpBase, { recursive: true, force: true });
		}
	});

	test('#1225 follow-up — dossier tasks/<id> local VIDE (moitié synchronisé) : PAS de court-circuit, l\'archive est servie', async () => {
		// Un dossier sans fichier lisible n'est pas une tâche vivante : la
		// précédence ne doit pas s'appliquer, sinon view finit en throw
		// « may be corrupted » alors que le corps existe dans l'archive
		// (review ai-01 sur #1225, 25/09).
		const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'tier3-guard-empty-'));
		await fs.mkdir(path.join(tmpBase, 'tasks', 't-web1'), { recursive: true });
		try {
			peekMock.mockReturnValueOnce(tier3Stub('t-web1')).mockReturnValueOnce(tier3Body('t-web1'));
			mockDetectStorageLocations.mockResolvedValue([tmpBase]);
			hydrateMock.mockResolvedValue(true);

			const result = await hydrateTier3SkeletonFromCache('t-web1');
			expect(hydrateMock).toHaveBeenCalledWith('t-web1');
			expect(result).not.toBeNull();
			expect(result!.sequence.length).toBe(1);
		} finally {
			await fs.rm(tmpBase, { recursive: true, force: true });
		}
	});

	test('#1229 follow-up — ui_messages.json local de 0 octet : PAS de court-circuit, l\'archive est servie', async () => {
		// Fichier présent mais vide : le JSON.parse d'analyzeConversation
		// échoue au même titre qu'une absence — la garde ne doit pas le
		// compter comme tâche locale vivante (review ai-01 sur #1229, 25/09).
		const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'tier3-guard-zero-'));
		const taskDir = path.join(tmpBase, 'tasks', 't-web1');
		await fs.mkdir(taskDir, { recursive: true });
		await fs.writeFile(path.join(taskDir, 'ui_messages.json'), '');
		try {
			peekMock.mockReturnValueOnce(tier3Stub('t-web1')).mockReturnValueOnce(tier3Body('t-web1'));
			mockDetectStorageLocations.mockResolvedValue([tmpBase]);
			hydrateMock.mockResolvedValue(true);

			const result = await hydrateTier3SkeletonFromCache('t-web1');
			expect(hydrateMock).toHaveBeenCalledWith('t-web1');
			expect(result).not.toBeNull();
			expect(result!.sequence.length).toBe(1);
		} finally {
			await fs.rm(tmpBase, { recursive: true, force: true });
		}
	});
});

describe('#3661 AC8 — resolveFullConversationSkeleton Tier 3 branch', () => {
	beforeEach(() => {
		peekMock.mockReset();
		hydrateMock.mockReset();
		mockDetectStorageLocations.mockReset();
		mockDetectStorageLocations.mockResolvedValue([]);
	});

	test('local cache miss + hot Tier 3 stub → returns the hydrated archive body, no disk scan', async () => {
		peekMock.mockReturnValueOnce(tier3Stub('t-web1')).mockReturnValueOnce(tier3Body('t-web1'));
		hydrateMock.mockResolvedValue(true);
		const cache = new Map();

		const result = await resolveFullConversationSkeleton('t-web1', cache as any);
		expect(result).not.toBeNull();
		expect((result as any).metadata.dataSource).toBe('gdrive-archive');
		expect(result!.sequence.length).toBe(1);
		// Write-back : les résolutions suivantes voient le corps dans le cache.
		expect((cache.get('t-web1') as any).sequence.length).toBe(1);
		// #1217 follow-up 3 : le garde de précédence sonde UNE fois les
		// locations (listing + existsSync, pas le scan complet) — c'est le
		// nouveau contrat de la branche. Le disk scan proprement dit
		// (analyzeConversation) ne s'exécute pas : pas de dossier local.
		expect(mockDetectStorageLocations).toHaveBeenCalledTimes(1);
	});

	test('cold host + no local entry → unchanged behavior: null via empty disk scan', async () => {
		peekMock.mockReturnValue(undefined);
		mockDetectStorageLocations.mockResolvedValue([]);
		const cache = new Map();

		expect(await resolveFullConversationSkeleton('t-web1', cache as any)).toBeNull();
		expect(mockDetectStorageLocations).toHaveBeenCalledTimes(1);
	});
});
