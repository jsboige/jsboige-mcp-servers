/**
 * Tests for roosync-indexing.tool.ts
 * Issue #492 - Coverage for unified indexing dispatcher
 * Issue #611 - Claude Code session archiving support
 *
 * @module tools/indexing/__tests__/roosync-indexing.tool
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mutable shared-state path so trend_report tests can point at a temp dir.
// vi.mock is hoisted, so the factory must reference this hoisted holder.
const { sharedStatePathHolder } = vi.hoisted(() => ({
	sharedStatePathHolder: { value: '' as string },
}));

const { mockIndexHandler, mockResetHandler, mockDiagnoseHandler, mockRebuildHandler,
	mockArchiveTask, mockArchiveClaudeCodeSessions, mockListArchivedTasks, mockFindConversationById,
	mockDetectStorageLocations, mockFsReadDir, mockFsReadFile, mockFsStat
} = vi.hoisted(() => ({
	mockIndexHandler: vi.fn(),
	mockResetHandler: vi.fn(),
	mockDiagnoseHandler: vi.fn(),
	mockRebuildHandler: vi.fn(),
	mockArchiveTask: vi.fn(),
	mockArchiveClaudeCodeSessions: vi.fn(),
	mockListArchivedTasks: vi.fn(),
	mockFindConversationById: vi.fn(),
	mockDetectStorageLocations: vi.fn(),
	mockFsReadDir: vi.fn(),
	mockFsReadFile: vi.fn(),
	mockFsStat: vi.fn()
}));

// Default mock for shared-state-path — returns '' unless a test sets the holder.
vi.mock('../../../utils/shared-state-path.js', () => ({
	getSharedStatePath: () => sharedStatePathHolder.value,
	tryGetSharedStatePath: () => sharedStatePathHolder.value,
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
		findConversationById: mockFindConversationById,
		detectStorageLocations: mockDetectStorageLocations
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

	test('has action enum with 13 values', () => {
		const actionProp = (roosyncIndexingTool.inputSchema.properties as any).action;
		expect(actionProp.enum).toEqual(['index', 'reset', 'rebuild', 'diagnose', 'archive', 'status', 'cleanup', 'garbage_scan', 'cleanup_orphans', 'repair_gaps', 'tool_usage_stats', 'save_snapshot', 'trend_report']);
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

		expect(mockDiagnoseHandler).toHaveBeenCalledWith(cache, {
			deep: undefined,
			sample_size: undefined,
			top_n_workspaces: undefined,
		});
		expect(result).toBe(expected);
	});

	test('diagnose action with deep=true forwards options to handleDiagnoseSemanticIndex', async () => {
		const expected = { content: [{ type: 'text', text: 'diagnosed deep' }] };
		mockDiagnoseHandler.mockResolvedValue(expected);

		const result = await handleRooSyncIndexing(
			{ action: 'diagnose', deep: true, sample_size: 500, top_n_workspaces: 10 },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);

		expect(mockDiagnoseHandler).toHaveBeenCalledWith(cache, {
			deep: true,
			sample_size: 500,
			top_n_workspaces: 10,
		});
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

	test('archive action with claude_code_sessions=true returns error (sanctuary protection)', async () => {
		// Sanctuary protection prevents this path from being reached

		const result = await handleRooSyncIndexing(
			{ action: 'archive', claude_code_sessions: true },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);

		expect(mockArchiveClaudeCodeSessions).not.toHaveBeenCalled();
		expect((result as any).isError).toBe(true);
		expect(result.content[0].text).toContain('SANCTUAIRES');
		expect(result.content[0].text).toContain('Reinforcement Learning futur');
	});

	test('archive action with claude_code_sessions and max_sessions returns error (sanctuary protection)', async () => {
		// Sanctuary protection prevents this path from being reached

		const result = await handleRooSyncIndexing(
			{ action: 'archive', claude_code_sessions: true, max_sessions: 10 },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);

		expect(mockArchiveClaudeCodeSessions).not.toHaveBeenCalled();
		expect((result as any).isError).toBe(true);
			expect(result.content[0].text).toContain('SANCTUAIRES');
		expect(result.content[0].text).toContain('Reinforcement Learning futur');
	});

	test('archive action with claude_code_sessions=true returns error (sanctuary protection)', async () => {
		const result = await handleRooSyncIndexing(
			{ action: 'archive', claude_code_sessions: true },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);

		expect(mockArchiveClaudeCodeSessions).not.toHaveBeenCalled();
		expect((result as any).isError).toBe(true);
		expect(result.content[0].text).toContain('SANCTUAIRES');
		expect(result.content[0].text).toContain('Reinforcement Learning futur');
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
				bandwidthSaved: 1024000,
				lastIndexedAt: '2026-05-24T10:00:00.000Z'
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
			indexingMetrics: { totalTasks: 0, skippedTasks: 0, indexedTasks: 0, failedTasks: 0, retryTasks: 0, bandwidthSaved: 0, lastIndexedAt: undefined }
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

// ============================================================
// trend_report action — #2623 schema-drift robustness
// Older snapshots lack a `.tools` array; trend_report must not crash.
// ============================================================

describe('roosync_indexing trend_report action', () => {
	const cache = new Map();
	const ensureFresh = vi.fn().mockResolvedValue(true);
	const saveSkeleton = vi.fn();
	const setEnabled = vi.fn();
	const mockRebuildHandler = vi.fn();

	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsm-trend-'));
		sharedStatePathHolder.value = tmpDir;
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		sharedStatePathHolder.value = '';
	});

	test('does not crash when previous snapshot has no .tools array (schema drift)', async () => {
		const snapshotsDir = path.join(tmpDir, 'tool-usage-snapshots');
		fs.mkdirSync(snapshotsDir, { recursive: true });

		// Old-shape snapshot: no `.tools`, no `.weekly_trend` (pre per-tool breakdown).
		const oldShape = {
			action: 'tool_usage_stats', method: 'jsonl_scan',
			date_range: { start: '2026-05-19', end: '2026-06-04', weeks: 2 },
			files_scanned: 150, total_tool_calls: 25499, unique_tools: 38,
			summary: '25499 calls across 38 tools',
		};
		// New-shape snapshot: has `.tools` + `.weekly_trend`.
		const newShape = {
			action: 'tool_usage_stats', method: 'jsonl_scan',
			date_range: { start: '2026-05-19', end: '2026-06-17', weeks: 5 },
			files_scanned: 194, total_tool_calls: 45181, unique_tools: 55,
			tools: [
				{ tool_name: 'Bash', calls: 15314, errors: 1042, error_rate: 6.8, retries: 11430, retry_rate: 74.6, downstream_actions: 9214, downstream_action_rate: 60.2 },
				{ tool_name: 'Read', calls: 2808, errors: 44, error_rate: 1.6, retries: 874, retry_rate: 31.1, downstream_actions: 1836, downstream_action_rate: 65.4 },
			],
			weekly_trend: [],
			summary: '45181 calls across 55 tools',
		};
		fs.writeFileSync(path.join(snapshotsDir, 'myia-po-2026-2026-06-04.json'), JSON.stringify(oldShape));
		fs.writeFileSync(path.join(snapshotsDir, 'myia-po-2026-2026-06-17.json'), JSON.stringify(newShape));

		const result: any = await handleRooSyncIndexing(
			{ action: 'trend_report' },
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);

		// Pre-#2623 this crashed with "Cannot read properties of undefined (reading 'map')".
		expect(result.isError).toBe(false);
		const text: string = result.content[0].text;
		// Summary comparison still works (total_tool_calls present on both).
		expect(text).toContain('| Total calls | 25499 | 45181');
		// Schema-drift note surfaced.
		expect(text).toContain('older schema');
		// Latest per-tool table still rendered (baseline-only fallback).
		expect(text).toContain('Bash');
		expect(text).toContain('15314');
	});

	test('renders full per-tool trend when both snapshots have .tools', async () => {
		const snapshotsDir = path.join(tmpDir, 'tool-usage-snapshots');
		fs.mkdirSync(snapshotsDir, { recursive: true });

		const prev = {
			action: 'tool_usage_stats', total_tool_calls: 1000, unique_tools: 10, files_scanned: 50,
			tools: [{ tool_name: 'Bash', calls: 500, errors: 10, error_rate: 2.0, retries: 50, retry_rate: 10.0, downstream_actions: 300, downstream_action_rate: 60.0 }],
		};
		const curr = {
			action: 'tool_usage_stats', total_tool_calls: 2000, unique_tools: 12, files_scanned: 80,
			tools: [{ tool_name: 'Bash', calls: 900, errors: 90, error_rate: 10.0, retries: 600, retry_rate: 66.7, downstream_actions: 600, downstream_action_rate: 66.7 }],
		};
		fs.writeFileSync(path.join(snapshotsDir, 'm-2026-06-10.json'), JSON.stringify(prev));
		fs.writeFileSync(path.join(snapshotsDir, 'm-2026-06-17.json'), JSON.stringify(curr));

		const result: any = await handleRooSyncIndexing(
			{ action: 'trend_report' },
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);

		expect(result.isError).toBe(false);
		const text: string = result.content[0].text;
		// Files-scanned row present (both have it).
		expect(text).toContain('| Files scanned | 50 | 80');
		// No schema-drift note.
		expect(text).not.toContain('older schema');
	});
});

