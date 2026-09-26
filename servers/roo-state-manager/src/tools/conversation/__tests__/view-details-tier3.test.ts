/**
 * #3661 (arbitrage 5828790877) — `view_task_details` d'une archive Tier 3.
 *
 * Même nature que `view` (PR submod #1217/#1225) : lecture explicite par-id.
 * Deux sites couverts, miroir de view-conversation-tree :
 *  - archive listée par le scanner mais absente de conversationCache (le
 *    resolver hydratait, le chemin view_task_details rendait « Aucune tâche ») ;
 *  - stub déshydraté IN PLACE par éviction LRU (séquence vide, messageCount > 0,
 *    dataSource gdrive-archive) — re-view déclenchait un rendu vide.
 *
 * Chemin réel exercé : view_task_details → (import dynamique) server-helpers →
 * SkeletonCacheService (mocké) → write-back conversationCache → rendu.
 *
 * @module tools/conversation/__tests__/view-details-tier3
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const { peekMock, hydrateMock, detectMock, analyzeMock } = vi.hoisted(() => ({
	peekMock: vi.fn(),
	hydrateMock: vi.fn(),
	detectMock: vi.fn(),
	analyzeMock: vi.fn(),
}));

vi.mock('../../../services/skeleton-cache.service.js', () => ({
	SkeletonCacheService: {
		getInstance: () => ({
			peekSkeleton: peekMock,
			ensureConversationHydrated: hydrateMock,
		}),
		reset: vi.fn(),
		configure: vi.fn(),
	},
}));

vi.mock('../../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		detectStorageLocations: detectMock,
		analyzeConversation: analyzeMock,
	},
}));

import { viewTaskDetailsTool } from '../view-details.tool.js';
import type { ConversationSkeleton } from '../../../types/conversation.js';

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
		actionCount: 1,
		totalSize: 100,
	},
	sequence: [],
} as any);

const tier3Body = (taskId: string) => ({
	...tier3Stub(taskId),
	metadata: { ...tier3Stub(taskId).metadata, hydrated: true },
	sequence: [{
		type: 'tool',
		name: 'archive_action_read',
		status: 'completed',
		parameters: { file: 'distant archive file' },
	}],
} as any);

let tmpRoot: string;

describe('#3661 — view_task_details d\'une archive Tier 3', () => {
	beforeEach(() => {
		peekMock.mockReset();
		hydrateMock.mockReset();
		detectMock.mockReset();
		analyzeMock.mockReset();
		// Défaut déterministe : aucune location Roo locale (le garde de
		// précédence passe, l'archive n'a pas de dossier local).
		detectMock.mockResolvedValue([]);
	});

	afterEach(async () => {
		if (tmpRoot) {
			await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
			tmpRoot = undefined as any;
		}
	});

	test('archive hors conversationCache → hydrate, publie le corps dans le cache et le rend', async () => {
		peekMock.mockReturnValueOnce(tier3Stub('t-web1')).mockReturnValueOnce(tier3Body('t-web1'));
		hydrateMock.mockResolvedValue(true);
		const cache = new Map<string, ConversationSkeleton>();

		const result = await viewTaskDetailsTool.handler({ task_id: 't-web1' }, cache);

		expect(hydrateMock).toHaveBeenCalledWith('t-web1');
		expect((result.content[0] as any).text).toContain('archive_action_read');
		// Miroir #1217 option (2) : le corps est publié dans le cache partagé,
		// les lectures suivantes n'ont plus à hydrater.
		expect(cache.get('t-web1')).toBeDefined();
		expect((cache.get('t-web1') as any).sequence.length).toBe(1);
	});

	test('re-view après éviction LRU (stub déshydraté dans conversationCache) → ré-hydrate et rend le corps', async () => {
		const evicted = tier3Stub('t-web1');
		const cache = new Map<string, ConversationSkeleton>();
		cache.set('t-web1', evicted);
		peekMock.mockReturnValueOnce(evicted).mockReturnValueOnce(tier3Body('t-web1'));
		hydrateMock.mockResolvedValue(true);

		const result = await viewTaskDetailsTool.handler({ task_id: 't-web1' }, cache);

		expect(hydrateMock).toHaveBeenCalledWith('t-web1');
		expect((result.content[0] as any).text).toContain('archive_action_read');
	});

	test('hydratation échouée → « Aucune tâche trouvée », jamais une archive vide rendue', async () => {
		peekMock.mockReturnValue(tier3Stub('t-web1'));
		hydrateMock.mockResolvedValue(false);
		const cache = new Map<string, ConversationSkeleton>();

		const result = await viewTaskDetailsTool.handler({ task_id: 't-web1' }, cache);

		expect((result.content[0] as any).text).toContain('Aucune tâche trouvée');
		expect(cache.size).toBe(0);
	});

	test('précédence local > archive : tâche locale vivante → PAS d\'hydratation, comportement inchangé', async () => {
		// Location locale réelle avec un ui_messages.json lisible (> 0 octet) :
		// le garde du helper court-circuite AVANT ensureConversationHydrated.
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vtd-tier3-prec-'));
		const taskDir = path.join(tmpRoot, 'tasks', 't-web1');
		await fs.mkdir(taskDir, { recursive: true });
		await fs.writeFile(path.join(taskDir, 'ui_messages.json'), '[{"role":"user","content":"local body"}]');
		detectMock.mockResolvedValue([tmpRoot]);

		const evicted = tier3Stub('t-web1');
		const cache = new Map<string, ConversationSkeleton>();
		cache.set('t-web1', evicted);
		peekMock.mockReturnValue(evicted);

		const result = await viewTaskDetailsTool.handler({ task_id: 't-web1' }, cache);

		expect(hydrateMock).not.toHaveBeenCalled();
		// Le stub local reste rendu tel quel (aucune action dans la séquence vide).
		expect((result.content[0] as any).text).toContain('Aucune action technique trouvée');
	});

	test('id inconnu du SkeletonCacheService (peek undefined) → « Aucune tâche », hydratation jamais tentée', async () => {
		peekMock.mockReturnValue(undefined);
		const cache = new Map<string, ConversationSkeleton>();

		const result = await viewTaskDetailsTool.handler({ task_id: 't-unknown' }, cache);

		expect((result.content[0] as any).text).toContain('Aucune tâche trouvée');
		expect(hydrateMock).not.toHaveBeenCalled();
		expect(detectMock).not.toHaveBeenCalled();
	});
});
