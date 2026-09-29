/**
 * #2191 — `view` d'une conversation sans source locale, servie par le store unifié (PG).
 *
 * `list` affichait déjà les conversations PG-only (tier opt-in
 * UNIFIED_STORE_CONVERSATION_READ_PG) mais `view` les rendait « not found » ou
 * « skeleton only » : aucun chemin de lecture du corps depuis PG. Ce test
 * exerce les quatre points où `view` abandonnait faute de fichiers locaux, et
 * vérifie qu'un store muet (gate off, ligne absente, pas de messages) laisse la
 * dégradation historique inchangée.
 *
 * Le chargeur PG est mocké : sa logique (gate, pagination, mapping) est
 * couverte par conversation-list-store.test.ts.
 *
 * @module tools/__tests__/view-conversation-tree-unified-store
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';

const { loadPgMock, peekMock, rooDetectMock, claudeDetectMock, claudeAnalyzeMock } = vi.hoisted(() => ({
	loadPgMock: vi.fn(),
	peekMock: vi.fn(),
	rooDetectMock: vi.fn(),
	claudeDetectMock: vi.fn(),
	claudeAnalyzeMock: vi.fn(),
}));

vi.mock('../../services/unified-store/conversation-list-store.js', () => ({
	loadPgConversationSkeleton: loadPgMock,
}));

vi.mock('../../services/skeleton-cache.service.js', () => ({
	SkeletonCacheService: {
		getInstance: () => ({ peekSkeleton: peekMock, ensureConversationHydrated: vi.fn() }),
		reset: vi.fn(),
		configure: vi.fn(),
	},
}));

vi.mock('../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		detectStorageLocations: rooDetectMock,
		analyzeConversation: vi.fn(),
	},
}));

vi.mock('../../utils/claude-storage-detector.js', () => ({
	ClaudeStorageDetector: {
		detectStorageLocations: claudeDetectMock,
		analyzeConversation: claudeAnalyzeMock,
	},
}));

import { viewConversationTree } from '../view-conversation-tree.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

const CLAUDE_ID = 'claude-d--dev-CoursIA--0f1e2d3c-aaaa-bbbb-cccc-111122223333';

const pgBody = (taskId: string): ConversationSkeleton => ({
	taskId,
	metadata: {
		title: 'question from po-2025',
		lastActivity: '2026-09-06T03:37:15.817Z',
		createdAt: '2026-09-05T12:14:55.368Z',
		messageCount: 2,
		actionCount: 0,
		totalSize: 0,
		machineId: 'myia-po-2025',
		dataSource: 'unified-store',
	} as any,
	sequence: [
		{ role: 'user', content: 'question from po-2025', timestamp: '2026-09-05T12:14:55.368Z', isTruncated: false },
		{ role: 'assistant', content: 'answer stored in PG', timestamp: '2026-09-05T12:15:00.000Z', isTruncated: false },
	],
});

/** Discovery stub: listed, messageCount > 0, body never loaded. */
const stub = (taskId: string, extra: Record<string, unknown> = {}): ConversationSkeleton => ({
	taskId,
	metadata: {
		title: 'listed elsewhere',
		lastActivity: '2026-09-06T03:37:15.817Z',
		createdAt: '2026-09-05T12:14:55.368Z',
		messageCount: 12,
		actionCount: 0,
		totalSize: 100,
		machineId: 'myia-po-2025',
		...extra,
	} as any,
	sequence: [],
});

const textOf = (result: any): string => result.content[0].text;

describe('#2191 — view falls back to the unified store', () => {
	beforeEach(() => {
		loadPgMock.mockReset();
		peekMock.mockReset();
		rooDetectMock.mockReset();
		claudeDetectMock.mockReset();
		claudeAnalyzeMock.mockReset();
		// No local source anywhere: no Roo location, no Claude project, no Tier 3 stub.
		peekMock.mockReturnValue(undefined);
		rooDetectMock.mockResolvedValue([]);
		claudeDetectMock.mockResolvedValue([]);
		loadPgMock.mockResolvedValue(null);
	});

	test('task absent from the cache → PG body rendered, labelled with its provenance, cached', async () => {
		loadPgMock.mockResolvedValue(pgBody('t-pg-only'));
		const cache = new Map<string, ConversationSkeleton>();

		const result = await viewConversationTree.handler(
			{ task_id: 't-pg-only', view_mode: 'single', detail_level: 'full' },
			cache
		);

		const text = textOf(result);
		expect(text).toContain('Source: unified store (PG, machine myia-po-2025)');
		expect(text).toContain('Messages only: tool/command actions are not stored.');
		expect(text).toContain('answer stored in PG');
		expect(cache.get('t-pg-only')?.sequence).toHaveLength(2);
		expect(loadPgMock).toHaveBeenCalledTimes(1);
	});

	test('task absent from the cache, store silent → historical « not found »', async () => {
		const cache = new Map<string, ConversationSkeleton>();

		await expect(
			viewConversationTree.handler({ task_id: 't-nowhere' }, cache)
		).rejects.toThrow("Task with ID 't-nowhere' not found");
		expect(loadPgMock).toHaveBeenCalledWith('t-nowhere');
	});

	test('Roo stub without a local task directory → PG body instead of skeleton-only', async () => {
		loadPgMock.mockResolvedValue(pgBody('t-roo'));
		const cache = new Map<string, ConversationSkeleton>([['t-roo', stub('t-roo')]]);

		const result = await viewConversationTree.handler(
			{ task_id: 't-roo', view_mode: 'single', detail_level: 'full' },
			cache
		);

		expect(textOf(result)).toContain('answer stored in PG');
		expect(textOf(result)).not.toContain('Skeleton Only');
	});

	test('Roo stub without a local task directory, store silent → historical skeleton-only', async () => {
		const cache = new Map<string, ConversationSkeleton>([['t-roo', stub('t-roo')]]);

		const result = await viewConversationTree.handler({ task_id: 't-roo' }, cache);

		expect(textOf(result)).toContain('Skeleton Only (Files Not Available Locally)');
		expect(textOf(result)).not.toContain('unified store');
	});

	test('Claude stub whose project dir is absent here → PG body instead of skeleton-only', async () => {
		loadPgMock.mockResolvedValue(pgBody(CLAUDE_ID));
		const cache = new Map<string, ConversationSkeleton>([[CLAUDE_ID, stub(CLAUDE_ID, { source: 'claude-code' })]]);

		const result = await viewConversationTree.handler(
			{ task_id: CLAUDE_ID, view_mode: 'single', detail_level: 'full' },
			cache
		);

		expect(textOf(result)).toContain('answer stored in PG');
		expect(claudeAnalyzeMock).not.toHaveBeenCalled();
	});

	test('Claude ghost (project here, session file gone) → PG body instead of the ghost error', async () => {
		const projectPath = path.join(os.tmpdir(), `rsm-2191-absent-${process.pid}`, 'd--dev-CoursIA');
		claudeDetectMock.mockResolvedValue([{ projectPath }]);
		loadPgMock.mockResolvedValue(pgBody(CLAUDE_ID));
		const cache = new Map<string, ConversationSkeleton>([[CLAUDE_ID, stub(CLAUDE_ID, { source: 'claude-code' })]]);

		const result = await viewConversationTree.handler(
			{ task_id: CLAUDE_ID, view_mode: 'single', detail_level: 'full' },
			cache
		);

		expect(textOf(result)).toContain('answer stored in PG');
		expect(claudeAnalyzeMock).not.toHaveBeenCalled();
	});

	test('Claude ghost, store silent → the #3721 ghost error is unchanged', async () => {
		const projectPath = path.join(os.tmpdir(), `rsm-2191-absent-${process.pid}`, 'd--dev-CoursIA');
		claudeDetectMock.mockResolvedValue([{ projectPath }]);
		const cache = new Map<string, ConversationSkeleton>([[CLAUDE_ID, stub(CLAUDE_ID, { source: 'claude-code' })]]);

		await expect(
			viewConversationTree.handler({ task_id: CLAUDE_ID }, cache)
		).rejects.toThrow('stale cache entry (ghost)');
	});

	test('a task with a loaded body never queries the store', async () => {
		const cache = new Map<string, ConversationSkeleton>([['t-local', pgBody('t-local')]]);

		await viewConversationTree.handler({ task_id: 't-local', view_mode: 'single' }, cache);

		expect(loadPgMock).not.toHaveBeenCalled();
	});
});
