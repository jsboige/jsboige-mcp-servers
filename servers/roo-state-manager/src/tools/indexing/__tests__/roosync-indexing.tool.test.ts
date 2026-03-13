/**
 * Tests for roosync-indexing.tool.ts
 * Issue #492 - Coverage for unified indexing dispatcher
 * Issue #611 - Claude Code session archiving support
 *
 * @module tools/indexing/__tests__/roosync-indexing.tool
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockIndexHandler, mockResetHandler, mockDiagnoseHandler, mockRebuildHandler,
	mockArchiveTask, mockArchiveClaudeCodeSessions, mockListArchivedTasks, mockFindConversationById
} = vi.hoisted(() => ({
	mockIndexHandler: vi.fn(),
	mockResetHandler: vi.fn(),
	mockDiagnoseHandler: vi.fn(),
	mockRebuildHandler: vi.fn(),
	mockArchiveTask: vi.fn(),
	mockArchiveClaudeCodeSessions: vi.fn(),
	mockListArchivedTasks: vi.fn(),
	mockFindConversationById: vi.fn()
}));

vi.mock('../../../services/task-archiver/index.js', () => ({
	TaskArchiver: {
		archiveTask: mockArchiveTask,
		archiveClaudeCodeSessions: mockArchiveClaudeCodeSessions,
		listArchivedTasks: mockListArchivedTasks
	}
}));

vi.mock('../../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		findConversationById: mockFindConversationById
	}
}));

vi.mock('../index-task.tool.js', () => ({
	indexTaskSemanticTool: {
		handler: mockIndexHandler
	}
}));

vi.mock('../reset-collection.tool.js', () => ({
	resetQdrantCollectionTool: {
		handler: mockResetHandler
	}
}));

vi.mock('../diagnose-index.tool.js', () => ({
	handleDiagnoseSemanticIndex: mockDiagnoseHandler
}));

import { roosyncIndexingTool, handleRooSyncIndexing } from '../roosync-indexing.tool.js';

describe('roosyncIndexingTool', () => {
	const cache = new Map();
	const ensureFresh = vi.fn().mockResolvedValue(true);
	const saveSkeleton = vi.fn().mockResolvedValue(undefined);
	const indexQueue = new Set<string>();
	const setEnabled = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ============================================================
	// Tool definition
	// ============================================================

	test('has correct tool name', () => {
		expect(roosyncIndexingTool.name).toBe('roosync_indexing');
	});

	test('has required action field', () => {
		expect(roosyncIndexingTool.inputSchema.required).toEqual(['action']);
	});

	test('has action enum with 6 values', () => {
		const actionProp = (roosyncIndexingTool.inputSchema.properties as any).action;
		expect(actionProp.enum).toEqual(['index', 'reset', 'rebuild', 'diagnose', 'archive', 'status']);
	});

	// ============================================================
	// Action validation
	// ============================================================

	test('returns error when action is missing', async () => {
		const result = await handleRooSyncIndexing(
			{} as any,
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);
		expect((result as any).isError).toBe(true);
		expect(result.content[0].text).toContain('action');
	});

	test('returns error for invalid action', async () => {
		const result = await handleRooSyncIndexing(
			{ action: 'invalid' as any },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);
		expect((result as any).isError).toBe(true);
		expect(result.content[0].text).toContain('invalid');
	});

	// ============================================================
	// Index action
	// ============================================================

	test('index action requires task_id', async () => {
		const result = await handleRooSyncIndexing(
			{ action: 'index' },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);
		expect((result as any).isError).toBe(true);
		expect(result.content[0].text).toContain('task_id');
	});

	test('index action delegates to indexTaskSemanticTool', async () => {
		const expected = { content: [{ type: 'text', text: 'indexed' }] };
		mockIndexHandler.mockResolvedValue(expected);

		const result = await handleRooSyncIndexing(
			{ action: 'index', task_id: 'abc-123' },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);

		expect(mockIndexHandler).toHaveBeenCalledWith(
			{ task_id: 'abc-123' },
			cache,
			ensureFresh
		);
		expect(result).toBe(expected);
	});

	// ============================================================
	// Reset action
	// ============================================================

	test('reset action delegates to resetQdrantCollectionTool', async () => {
		const expected = { content: [{ type: 'text', text: 'reset' }] };
		mockResetHandler.mockResolvedValue(expected);

		const result = await handleRooSyncIndexing(
			{ action: 'reset', confirm: true },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);

		expect(mockResetHandler).toHaveBeenCalledWith(
			{ confirm: true },
			cache,
			saveSkeleton,
			indexQueue,
			setEnabled
		);
		expect(result).toBe(expected);
	});

	// ============================================================
	// Rebuild action
	// ============================================================

	test('rebuild action delegates to rebuildHandler', async () => {
		const expected = { content: [{ type: 'text', text: 'rebuilt' }] };
		mockRebuildHandler.mockResolvedValue(expected);

		const result = await handleRooSyncIndexing(
			{ action: 'rebuild', workspace_filter: '/ws', max_tasks: 10, dry_run: true },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);

		expect(mockRebuildHandler).toHaveBeenCalledWith({
			workspace_filter: '/ws',
			max_tasks: 10,
			dry_run: true
		});
		expect(result).toBe(expected);
	});

	// ============================================================
	// Diagnose action
	// ============================================================

	test('diagnose action delegates to handleDiagnoseSemanticIndex', async () => {
		const expected = { content: [{ type: 'text', text: 'diagnosed' }] };
		mockDiagnoseHandler.mockResolvedValue(expected);

		const result = await handleRooSyncIndexing(
			{ action: 'diagnose' },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);

		expect(mockDiagnoseHandler).toHaveBeenCalledWith(cache);
		expect(result).toBe(expected);
	});

	// ============================================================
	// Archive action - Roo tasks
	// ============================================================

	test('archive action with task_id archives Roo task', async () => {
		const conversation = { path: '/path/to/task' };
		mockFindConversationById.mockResolvedValue(conversation);
		mockArchiveTask.mockResolvedValue(undefined);

		const skeleton = {
			metadata: { title: 'Test Task' },
			isCompleted: true
		};
		cache.set('task-123', skeleton as any);

		const result = await handleRooSyncIndexing(
			{ action: 'archive', task_id: 'task-123' },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);

		expect(mockArchiveTask).toHaveBeenCalledWith('task-123', '/path/to/task', skeleton);
		expect((result as any).isError).toBe(false);
	});

	test('archive action without task_id lists archived tasks', async () => {
		mockListArchivedTasks.mockResolvedValue(['task-1', 'task-2']);

		const result = await handleRooSyncIndexing(
			{ action: 'archive' },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);

		expect(mockListArchivedTasks).toHaveBeenCalledWith(undefined);
		expect((result as any).isError).toBe(false);
		const response = JSON.parse(result.content[0].text);
		expect(response.action).toBe('archive_list');
		expect(response.total).toBe(2);
	});

	test('archive action with machine_id filters by machine', async () => {
		mockListArchivedTasks.mockResolvedValue(['task-1']);

		const result = await handleRooSyncIndexing(
			{ action: 'archive', machine_id: 'myia-po-2023' },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);

		expect(mockListArchivedTasks).toHaveBeenCalledWith('myia-po-2023');
	});

	// ============================================================
	// Archive action - Claude Code sessions (#611)
	// ============================================================

	test('archive action with claude_code_sessions=true archives Claude Code sessions', async () => {
		mockArchiveClaudeCodeSessions.mockResolvedValue({
			archived: 5,
			failed: 1
		});

		const result = await handleRooSyncIndexing(
			{ action: 'archive', claude_code_sessions: true },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);

		expect(mockArchiveClaudeCodeSessions).toHaveBeenCalled();
		expect((result as any).isError).toBe(false);
		expect(result.content[0].text).toContain('Sessions Claude Code archivées');
		expect(result.content[0].text).toContain('5 réussies');
		expect(result.content[0].text).toContain('1 échecs');
	});

	test('archive action with claude_code_sessions and max_sessions limits archiving', async () => {
		mockArchiveClaudeCodeSessions.mockResolvedValue({
			archived: 10,
			failed: 0
		});

		const result = await handleRooSyncIndexing(
			{ action: 'archive', claude_code_sessions: true, max_sessions: 10 },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);

		expect(mockArchiveClaudeCodeSessions).toHaveBeenCalledWith(expect.any(String), 10);
		expect(result.content[0].text).toContain('Sessions Claude Code archivées');
		expect(result.content[0].text).toContain('10 réussies');
		expect(result.content[0].text).toContain('0 échecs');
	});

	test('archive action returns error on Claude Code archiving failure', async () => {
		let errorCaught = false;
		mockArchiveClaudeCodeSessions.mockRejectedValueOnce(new Error('Directory not found'));

		try {
			await handleRooSyncIndexing(
				{ action: 'archive', claude_code_sessions: true },
				cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
			);
		} catch (e) {
			errorCaught = true;
			expect(e).toBeInstanceOf(Error);
			expect((e as Error).message).toContain('Directory not found');
		}

		expect(errorCaught).toBe(true);
	});
});

// ============================================================
// status action
// ============================================================

describe('roosync_indexing status action', () => {
	const cache = new Map();
	const ensureFresh = vi.fn().mockResolvedValue(true);
	const saveSkeleton = vi.fn();
	const setEnabled = vi.fn();
	const mockRebuildHandler = vi.fn();

	test('returns background indexer status with all fields', async () => {
		const indexingState = {
			qdrantIndexQueue: new Set(['task-1', 'task-2']),
			qdrantIndexInterval: {} as NodeJS.Timeout,
			isQdrantIndexingEnabled: true,
			indexingMetrics: {
				totalTasks: 100,
				skippedTasks: 10,
				indexedTasks: 85,
				failedTasks: 5,
				retryTasks: 2,
				bandwidthSaved: 1024000
			}
		};

		const result = await handleRooSyncIndexing(
			{ action: 'status' },
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler,
			indexingState
		);

		expect(result.isError).toBe(false);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.background_indexer.is_running).toBe(true);
		expect(parsed.background_indexer.is_enabled).toBe(true);
		expect(parsed.background_indexer.queue_size).toBe(2);
		expect(parsed.background_indexer.metrics.total_tasks).toBe(100);
		expect(parsed.background_indexer.metrics.indexed).toBe(85);
		expect(parsed.background_indexer.metrics.skipped).toBe(10);
		expect(parsed.background_indexer.metrics.failed).toBe(5);
	});

	test('shows is_running=false when interval is null', async () => {
		const indexingState = {
			qdrantIndexQueue: new Set<string>(),
			qdrantIndexInterval: null,
			isQdrantIndexingEnabled: false,
			indexingMetrics: { totalTasks: 0, skippedTasks: 0, indexedTasks: 0, failedTasks: 0, retryTasks: 0, bandwidthSaved: 0 }
		};

		const result = await handleRooSyncIndexing(
			{ action: 'status' },
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler,
			indexingState
		);

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.background_indexer.is_running).toBe(false);
		expect(parsed.background_indexer.queue_size).toBe(0);
	});

	test('falls back to qdrantIndexQueue param when no indexingState provided', async () => {
		const queue = new Set(['task-a']);

		const result = await handleRooSyncIndexing(
			{ action: 'status' },
			cache, ensureFresh, saveSkeleton, queue, setEnabled, mockRebuildHandler
		);

		expect(result.isError).toBe(false);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.background_indexer.queue_size).toBe(1);
	});
});
