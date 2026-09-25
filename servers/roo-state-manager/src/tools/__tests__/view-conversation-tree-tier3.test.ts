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
});