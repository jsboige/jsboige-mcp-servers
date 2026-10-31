/**
 * #2191 — a PG-served `view` must render the actions ms#1396 stores.
 *
 * Unlike view-conversation-tree-unified-store.test.ts, which mocks the PG
 * LOADER, this file mocks only the READER FACTORY and lets the REAL
 * `loadPgConversationSkeleton` run — gate resolution, row paging, mapping,
 * tool_calls unfolding — feeding the REAL renderer through `view`'s unified
 * store fallback.
 *
 * The defect this guards: the loader mapped user/assistant rows and DROPPED
 * `messages.tool_calls`, so a PG-served body rendered messages-only while the
 * provenance banner claimed « tool/command actions are not stored » — false
 * as a storage statement since ms#1396 (the live store held 327k action rows
 * when this was measured, 2026-10-31). The fix unfolds the folded actions
 * back into the sequence and the banner carries provenance only.
 *
 * @module tools/__tests__/view-conversation-tree-pg-actions
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Reader double (the only PG seam mocked — the loader runs for real) ──

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockGetConversation = vi.fn().mockResolvedValue(null);
const mockGetMessages = vi.fn().mockResolvedValue([]);

vi.mock('../../services/unified-store/reader-factory.js', () => ({
	getUnifiedStoreReader: () => ({
		isNull: () => false,
		init: mockInit,
		getConversation: mockGetConversation,
		getMessages: mockGetMessages,
	}),
	resetReaderInstance: vi.fn(),
}));

// ─── No local source anywhere (same stubs as the loader-mocked sibling) ──

const { peekMock, rooDetectMock, claudeDetectMock, claudeAnalyzeMock } = vi.hoisted(() => ({
	peekMock: vi.fn(),
	rooDetectMock: vi.fn(),
	claudeDetectMock: vi.fn(),
	claudeAnalyzeMock: vi.fn(),
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

const TASK = 'claude-d--dev-roo-extensions--2191-actions';

const convRow = {
	task_id: TASK,
	machine_id: 'myia-po-2027',
	harness: 'claude',
	workspace: 'd:/dev/roo-extensions',
	parent_task_id: null,
	title: null,
	first_ts: '2026-10-31T06:00:00.000Z',
	last_ts: '2026-10-31T06:05:00.000Z',
	msg_count: 3,
	metadata: null,
} as unknown as Parameters<typeof mockGetConversation.mockResolvedValue>[0];

const messagesWithActions = [
	{ seq: 0, role: 'user', content: 'grep the logs', tool_calls: null, ts: '2026-10-31T06:00:00.000Z' },
	{
		seq: 1,
		role: 'assistant',
		content: 'searching',
		tool_calls: [
			// The exact shape mapSequenceToMessageRows folds at write time.
			{ type: 'tool', name: 'Grep', parameters: { pattern: 'channel-pg' }, status: 'success', timestamp: '2026-10-31T06:00:05.000Z' },
			{ type: 'command', name: 'npm', parameters: { cmd: 'test' }, status: 'failure', timestamp: '2026-10-31T06:00:07.000Z' },
		],
		ts: '2026-10-31T06:00:05.000Z',
	},
	{ seq: 2, role: 'user', content: 'thanks', tool_calls: null, ts: '2026-10-31T06:05:00.000Z' },
];

const preMs1396Messages = [
	{ seq: 0, role: 'user', content: 'old question', tool_calls: null, ts: '2026-09-01T06:00:00.000Z' },
	{ seq: 1, role: 'assistant', content: 'old answer', tool_calls: null, ts: '2026-09-01T06:00:05.000Z' },
];

const textOf = (result: any): string => result.content[0].text;

const ORIGINAL_ENV = { ...process.env };

describe('#2191 — PG-served view renders stored actions (real loader path)', () => {
	beforeEach(() => {
		mockInit.mockClear();
		mockGetConversation.mockReset().mockResolvedValue(null);
		mockGetMessages.mockReset().mockResolvedValue([]);
		peekMock.mockReset().mockReturnValue(undefined);
		rooDetectMock.mockReset().mockResolvedValue([]);
		claudeDetectMock.mockReset().mockResolvedValue([]);
		claudeAnalyzeMock.mockClear();
		// Default-ON regime (#4131): a postgres:// URL arms the gate; the
		// conversation read flag must not be an explicit OFF spelling.
		process.env.UNIFIED_STORE_PG_URL = 'postgres://test:test@localhost:5432/test';
		delete process.env.UNIFIED_STORE_CONVERSATION_READ_PG;
	});

	afterEach(() => {
		process.env.UNIFIED_STORE_PG_URL = ORIGINAL_ENV.UNIFIED_STORE_PG_URL;
		if (ORIGINAL_ENV.UNIFIED_STORE_CONVERSATION_READ_PG === undefined) {
			delete process.env.UNIFIED_STORE_CONVERSATION_READ_PG;
		} else {
			process.env.UNIFIED_STORE_CONVERSATION_READ_PG = ORIGINAL_ENV.UNIFIED_STORE_CONVERSATION_READ_PG;
		}
	});

	test('a row with tool_calls renders its actions inline — no « not stored » disclaimer', async () => {
		mockGetConversation.mockResolvedValue(convRow);
		mockGetMessages.mockResolvedValue(messagesWithActions);
		const cache = new Map<string, ConversationSkeleton>();

		const result = await viewConversationTree.handler(
			{ task_id: TASK, view_mode: 'single', detail_level: 'full' },
			cache
		);

		const text = textOf(result);
		// Provenance banner is kept…
		expect(text).toContain('Source: unified store (PG, machine myia-po-2027)');
		// …the false fidelity claim is gone…
		expect(text).not.toContain('not stored');
		// …and the stored actions actually render, like a local load would.
		expect(text).toContain('Grep');
		expect(text).toContain('→ success');
		expect(text).toContain('npm');
		expect(text).toContain('→ failure');
		// The cached skeleton carries the actions for later views.
		const cached = cache.get(TASK)!;
		expect(cached.sequence.filter(item => 'name' in item)).toHaveLength(2);
		expect(cached.metadata.actionCount).toBe(2);
		// The real loader ran: init before read (#2816), one paged read.
		expect(mockInit).toHaveBeenCalledTimes(1);
		expect(mockGetConversation).toHaveBeenCalledWith(TASK);
		expect(mockGetMessages).toHaveBeenCalledWith(TASK, { limit: 1000, offset: 0 });
	});

	test('a pre-ms#1396 row (tool_calls null) renders messages-only, banner unchanged', async () => {
		mockGetConversation.mockResolvedValue(convRow);
		mockGetMessages.mockResolvedValue(preMs1396Messages);
		const cache = new Map<string, ConversationSkeleton>();

		const result = await viewConversationTree.handler(
			{ task_id: TASK, view_mode: 'single', detail_level: 'full' },
			cache
		);

		const text = textOf(result);
		expect(text).toContain('old answer');
		expect(text).toContain('Source: unified store (PG, machine myia-po-2027)');
		expect(text).not.toContain('not stored');
		expect(cache.get(TASK)!.metadata.actionCount).toBe(0);
	});
});
