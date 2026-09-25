/**
 * #3661 AC8 — `view` d'une archive Tier 3 listée (stub hors conversationCache).
 *
 * Régression mesurée en prod po-2024 (comment 5811382263) : après les stubs
 * #1163, `list includeArchives` listait les archives distantes mais `view`
 * d'une d'elles rendait « not found in cache » — les resolvers hydrataient,
 * le chemin `view` non.
 *
 * Ce test exerce le CHEMIN RÉEL : view → (import dynamique) server-helpers →
 * SkeletonCacheService (mocké) → write-back dans conversationCache → rendu.
 *
 * @module tools/__tests__/view-conversation-tree-tier3
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const { peekMock, hydrateMock, detectMock, analyzeMock } = vi.hoisted(() => ({
	peekMock: vi.fn(),
	hydrateMock: vi.fn(),
	detectMock: vi.fn(),
	analyzeMock: vi.fn(),
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

vi.mock('../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		detectStorageLocations: detectMock,
		analyzeConversation: analyzeMock,
	},
}));

import { viewConversationTree } from '../view-conversation-tree.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

const tier3Stub = (taskId: string) => ({
	taskId,
	metadata: {
		title: 'Archive web1',
		dataSource: 'gdrive-archive',
		machineId: 'myia-web1',
		hydrated: false,
		messageCount: 1,
		lastActivity: '2026-09-24T00:00:00.000Z',
		workspace: '/test/workspace',
		firstActivity: '2026-09-24T00:00:00.000Z',
		actionCount: 0,
		totalSize: 100,
	},
	sequence: [],
} as any);

const tier3Body = (taskId: string) => ({
	...tier3Stub(taskId),
	metadata: { ...tier3Stub(taskId).metadata, hydrated: true },
	sequence: [{ role: 'user', content: 'distant archive body', timestamp: '2026-09-24T00:00:00.000Z' }],
} as any);

describe('#3661 AC8 — view d\'une archive Tier 3', () => {
	beforeEach(() => {
		peekMock.mockReset();
		hydrateMock.mockReset();
		detectMock.mockReset();
		analyzeMock.mockReset();
		// Défaut déterministe : aucune location Roo locale (le garde de
		// précédence passe, l'archive n'a pas de dossier local).
		detectMock.mockResolvedValue([]);
	});

	test('stub chaud → view hydrate, publie le corps dans conversationCache et le rend', async () => {
		peekMock.mockReturnValueOnce(tier3Stub('t-web1')).mockReturnValueOnce(tier3Body('t-web1'));
		hydrateMock.mockResolvedValue(true);
		const cache = new Map<string, ConversationSkeleton>();

		const result = await viewConversationTree.handler(
			{ task_id: 't-web1', view_mode: 'single', detail_level: 'full' },
			cache
		);

		expect(hydrateMock).toHaveBeenCalledWith('t-web1');
		expect((result.content[0] as any).text).toContain('distant archive body');
		// Option (2) de la review #1217 : le corps est publié dans le cache partagé,
		// les résolutions suivantes n'ont plus à hydrater.
		expect(cache.get('t-web1')).toBeDefined();
		expect((cache.get('t-web1') as any).sequence.length).toBe(1);
	});

	test('hôte froid (stub absent) → l\'erreur historique « not found » demeure', async () => {
		peekMock.mockReturnValue(undefined);
		const cache = new Map<string, ConversationSkeleton>();

		await expect(
			viewConversationTree.handler({ task_id: 't-web1' }, cache)
		).rejects.toThrow("Task with ID 't-web1' not found");
		expect(hydrateMock).not.toHaveBeenCalled();
	});

	test('hydratation échouée → « not found », jamais une archive vide rendue', async () => {
		peekMock.mockReturnValue(tier3Stub('t-web1'));
		hydrateMock.mockResolvedValue(false);
		const cache = new Map<string, ConversationSkeleton>();

		await expect(
			viewConversationTree.handler({ task_id: 't-web1' }, cache)
		).rejects.toThrow("Task with ID 't-web1' not found");
	});

	test('stub survivant après éviction (hydrated=false) → « not found », pas un arbre vide', async () => {
		peekMock.mockReturnValue(tier3Stub('t-web1'));
		hydrateMock.mockResolvedValue(true);
		const cache = new Map<string, ConversationSkeleton>();

		await expect(
			viewConversationTree.handler({ task_id: 't-web1' }, cache)
		).rejects.toThrow("Task with ID 't-web1' not found");
	});

	// ---- #1217 follow-up 1 (review ai-01) : re-view après éviction LRU ----
	// Le write-back de #1217 stocke la MÊME référence que l'entrée du
	// SkeletonCacheService ; l'éviction la déshydrate in place — conversation
	// Cache tient alors un stub (séquence vide, messageCount > 0) et le view
	// rendait skeleton-only sans jamais ré-hydrater.

	test('re-view après éviction LRU (stub déshydraté dans conversationCache) → ré-hydrate et rend le corps', async () => {
		const evicted = tier3Stub('t-web1');
		const cache = new Map<string, ConversationSkeleton>();
		cache.set('t-web1', evicted);
		peekMock.mockReturnValueOnce(evicted).mockReturnValueOnce(tier3Body('t-web1'));
		hydrateMock.mockResolvedValue(true);

		const result = await viewConversationTree.handler(
			{ task_id: 't-web1', view_mode: 'single', detail_level: 'full' },
			cache
		);

		expect(hydrateMock).toHaveBeenCalledWith('t-web1');
		expect((result.content[0] as any).text).toContain('distant archive body');
	});

	test('ré-hydratation impossible (helper null) sur stub en cache → dégradation skeleton-only, pas de crash', async () => {
		const evicted = tier3Stub('t-web1');
		const cache = new Map<string, ConversationSkeleton>();
		cache.set('t-web1', evicted);
		peekMock.mockReturnValue(tier3Stub('t-web1'));
		hydrateMock.mockResolvedValue(false);

		const result = await viewConversationTree.handler(
			{ task_id: 't-web1', view_mode: 'single', detail_level: 'full' },
			cache
		);

		const text = (result.content[0] as any).text;
		expect(text).toContain('Skeleton Only');
		expect(text).not.toContain('distant archive body');
	});

	test('#1217 follow-up 3 — précédence local > archive : tâche locale UTILISABLE → le local est servi, Tier 3 jamais hydraté', async () => {
		// Vrai mkdir : le garde (existsSync réel dans le helper) et le fs.stat
		// du chemin Roo voient le dossier comme le runtime le verra.
		// #1225 follow-up : le dossier porte un fichier lisible — c'est lui
		// qui signale une tâche locale vivante, pas l'existence du dossier.
		const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'view-tier3-guard-'));
		const taskDir = path.join(tmpBase, 'tasks', 't-web1');
		await fs.mkdir(taskDir, { recursive: true });
		await fs.writeFile(path.join(taskDir, 'ui_messages.json'), '[]');
		try {
			const evicted = tier3Stub('t-web1');
			const cache = new Map<string, ConversationSkeleton>();
			cache.set('t-web1', evicted);
			peekMock.mockReturnValue(tier3Stub('t-web1'));
			hydrateMock.mockResolvedValue(true);
			detectMock.mockResolvedValue([tmpBase]);
			analyzeMock.mockResolvedValue({
				taskId: 't-web1',
				metadata: { ...tier3Stub('t-web1').metadata, dataSource: 'roo', messageCount: 1 },
				sequence: [{ role: 'user', content: 'fresh local body', timestamp: '2026-09-25T00:00:00.000Z' }],
			} as any);

			const result = await viewConversationTree.handler(
				{ task_id: 't-web1', view_mode: 'single', detail_level: 'full' },
				cache
			);

			expect(hydrateMock).not.toHaveBeenCalled();
			expect((result.content[0] as any).text).toContain('fresh local body');
			expect((result.content[0] as any).text).not.toContain('distant archive body');
		} finally {
			await fs.rm(tmpBase, { recursive: true, force: true });
		}
	});

	test('#1225 follow-up — dossier tasks/<id> local VIDE (moitié synchronisé) → l\'archive est servie, pas de throw « corrupted »', async () => {
		// Un dossier sans fichier lisible n'est pas une tâche vivante : sans
		// cette garde, le court-circuit local laissait view finir en throw
		// « may be corrupted » alors que le corps existe dans l'archive
		// (review ai-01 sur #1225, 25/09).
		const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'view-tier3-empty-'));
		await fs.mkdir(path.join(tmpBase, 'tasks', 't-web1'), { recursive: true });
		try {
			const evicted = tier3Stub('t-web1');
			const cache = new Map<string, ConversationSkeleton>();
			cache.set('t-web1', evicted);
			peekMock.mockReturnValueOnce(tier3Stub('t-web1')).mockReturnValueOnce(tier3Body('t-web1'));
			hydrateMock.mockResolvedValue(true);
			detectMock.mockResolvedValue([tmpBase]);

			const result = await viewConversationTree.handler(
				{ task_id: 't-web1', view_mode: 'single', detail_level: 'full' },
				cache
			);

			expect(hydrateMock).toHaveBeenCalledWith('t-web1');
			expect((result.content[0] as any).text).toContain('distant archive body');
		} finally {
			await fs.rm(tmpBase, { recursive: true, force: true });
		}
	});

	test('#1229 follow-up — ui_messages.json local de 0 octet → l\'archive est servie, pas de throw « corrupted »', async () => {
		// Fichier présent mais vide : analyzeConversation ne peut pas le
		// lire (JSON.parse sur chaîne vide) — la garde de précédence ne
		// doit pas le compter comme tâche locale vivante (review ai-01
		// sur #1229, 25/09).
		const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'view-tier3-zero-'));
		const taskDir = path.join(tmpBase, 'tasks', 't-web1');
		await fs.mkdir(taskDir, { recursive: true });
		await fs.writeFile(path.join(taskDir, 'ui_messages.json'), '');
		try {
			const evicted = tier3Stub('t-web1');
			const cache = new Map<string, ConversationSkeleton>();
			cache.set('t-web1', evicted);
			peekMock.mockReturnValueOnce(tier3Stub('t-web1')).mockReturnValueOnce(tier3Body('t-web1'));
			hydrateMock.mockResolvedValue(true);
			detectMock.mockResolvedValue([tmpBase]);

			const result = await viewConversationTree.handler(
				{ task_id: 't-web1', view_mode: 'single', detail_level: 'full' },
				cache
			);

			expect(hydrateMock).toHaveBeenCalledWith('t-web1');
			expect((result.content[0] as any).text).toContain('distant archive body');
		} finally {
			await fs.rm(tmpBase, { recursive: true, force: true });
		}
	});
});