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
import { ConversationSkeleton } from '../../../types/conversation.js';

// Mutable shared-state path so trend_report tests can point at a temp dir.
// vi.mock is hoisted, so the factory must reference this hoisted holder.
const { sharedStatePathHolder } = vi.hoisted(() => ({
	sharedStatePathHolder: { value: '' as string },
}));

const { mockIndexHandler, mockResetHandler, mockDiagnoseHandler, mockRebuildHandler,
	mockArchiveTask, mockArchiveClaudeCodeSessions, mockListArchivedTasks, mockFindConversationById,
	mockDetectStorageLocations, mockFsReadDir, mockFsReadFile, mockFsStat,
	mockCleanupOldVectors, mockDetectAndCleanupOrphans,
	mockResetIndexingState, mockClassifyIndexingError
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
	mockFsStat: vi.fn(),
	mockCleanupOldVectors: vi.fn(),
	mockDetectAndCleanupOrphans: vi.fn(),
	mockResetIndexingState: vi.fn(),
	mockClassifyIndexingError: vi.fn()
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

// Mocks for dynamically-imported modules (cleanup, cleanup_orphans) — deep-queue COVERAGE
vi.mock('../../../services/task-indexer/VectorIndexer.js', () => ({
	cleanupOldVectors: mockCleanupOldVectors,
}));
vi.mock('../cleanup-orphans.js', () => ({
	detectAndCleanupOrphans: mockDetectAndCleanupOrphans,
}));
// #2766 S2+ P1 follow-up — mock the static imports for classifier + dead-letter bookkeeping.
// The dispatcher imports `classifyIndexingError` at module load for status fallback AND
// cleanup_failed, so this must be a static (hoisted) vi.mock — not just for dynamic imports.
vi.mock('../../../services/background-services.js', () => ({
	// Sync inline classifier mirroring the real ERROR_PATTERNS contract from
	// background-services.ts:1420. We deliberately don't `vi.importActual` here
	// because that's async and the dispatcher consumes the function synchronously
	// from the static import. Substring match on lowercased message.
	classifyIndexingError: (error: any) => {
		const msg = String(error?.message ?? '').toLowerCase();
		if (!msg) return { isPermanent: false, errorClass: 'unknown' };
		if (msg.includes('claude code session') || msg.includes('claude session')) {
			return { isPermanent: true, errorClass: 'claude_session_not_found' };
		}
		if (msg.includes('file not found') || msg.includes('enoent')) {
			return { isPermanent: true, errorClass: 'file_not_found' };
		}
		if (msg.includes('authentication failed') || msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid api key')) {
			return { isPermanent: true, errorClass: 'auth_failed' };
		}
		if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests')) {
			return { isPermanent: false, errorClass: 'rate_limit' };
		}
		if (msg.includes('service unavailable') || msg.includes('503') || msg.includes('502') || msg.includes('500 internal')) {
			return { isPermanent: false, errorClass: 'service_503' };
		}
		if (msg.includes('network error') || msg.includes('connection timeout') || msg.includes('network timeout')) {
			return { isPermanent: false, errorClass: 'network_timeout' };
		}
		if (msg.includes('econnreset') || msg.includes('connection reset')) {
			return { isPermanent: false, errorClass: 'connection_reset' };
		}
		if (msg.includes('enotfound') || msg.includes('getaddrinfo')) {
			return { isPermanent: false, errorClass: 'dns_failure' };
		}
		if (msg.includes('indexing timeout') || msg.includes('embedding timeout') || msg.includes('timeout waiting') || msg.includes('task timeout')) {
			return { isPermanent: false, errorClass: 'embedding_timeout' };
		}
		return { isPermanent: false, errorClass: 'unknown' };
	},
}));
vi.mock('../../../services/indexing-decision.js', () => ({
	IndexingDecisionService: class {
		resetIndexingState = mockResetIndexingState;
	},
}));

// getISOWeek is a pure module-local helper (not exported). We exercise it indirectly via
// tool_usage_stats weekly bucketing; for direct unit coverage we re-implement the reference
// contract here against the source implementation imported below.
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

	test('has action enum with 14 values', () => {
		const actionProp = (roosyncIndexingTool.inputSchema.properties as any).action;
		expect(actionProp.enum).toEqual(['index', 'reset', 'rebuild', 'diagnose', 'archive', 'status', 'cleanup', 'garbage_scan', 'cleanup_orphans', 'repair_gaps', 'cleanup_failed', 'tool_usage_stats', 'save_snapshot', 'trend_report']);
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

// ============================================================
// NEW coverage (deep-queue COVERAGE Cluster B): genuinely non-covered
// branches of roosync_indexing dispatcher. Anchored on real source
// contract (roosync-indexing.tool.ts):
//   archive L352-420 (5 branches), status hints L430-454 (3 branches),
//   cleanup L480-513, cleanup_orphans L594-644, tool_usage_stats L806-808.
// ============================================================

describe('roosync_indexing archive action', () => {
	const ensureFresh = vi.fn().mockResolvedValue(true);
	const saveSkeleton = vi.fn();
	const setEnabled = vi.fn();
	const mockRebuildHandler = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('blocks claude_code_sessions with sanctuary error (#1621, L358-366)', async () => {
		const result: any = await handleRooSyncIndexing(
			{ action: 'archive', claude_code_sessions: true } as any,
			new Map(), ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('SANCTUAIRES');
		// The unreachable 2nd claude_code_sessions block (L369) must NOT execute
		expect(mockArchiveClaudeCodeSessions).not.toHaveBeenCalled();
	});

	test('returns error when task_id not found locally (L389-393)', async () => {
		mockFindConversationById.mockResolvedValue(null);
		const result: any = await handleRooSyncIndexing(
			{ action: 'archive', task_id: 'ghost-task' } as any,
			new Map(), ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('non trouvée localement');
	});

	test('returns error when skeleton missing from cache (L396-401)', async () => {
		mockFindConversationById.mockResolvedValue({ path: '/some/path', taskId: 't1' });
		const result: any = await handleRooSyncIndexing(
			{ action: 'archive', task_id: 't1' } as any,
			new Map(), ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('non trouvé dans le cache');
	});

	test('archives task successfully when conversation + skeleton present (L402-406)', async () => {
		mockFindConversationById.mockResolvedValue({ path: '/p/t1', taskId: 't1' });
		mockArchiveTask.mockResolvedValue(undefined);
		const cache = new Map();
		cache.set('t1', { taskId: 't1' } as any);

		const result: any = await handleRooSyncIndexing(
			{ action: 'archive', task_id: 't1' } as any,
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		expect(result.isError).toBe(false);
		expect(mockArchiveTask).toHaveBeenCalledWith('t1', '/p/t1', expect.objectContaining({ taskId: 't1' }));
		expect(result.content[0].text).toContain('archivée avec succès');
	});

	test('lists archives when no task_id provided (L407-419)', async () => {
		mockListArchivedTasks.mockResolvedValue(['task-a', 'task-b']);
		const result: any = await handleRooSyncIndexing(
			{ action: 'archive', machine_id: 'myia-web1' } as any,
			new Map(), ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		expect(result.isError).toBe(false);
		expect(mockListArchivedTasks).toHaveBeenCalledWith('myia-web1');
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.action).toBe('archive_list');
		expect(parsed.total).toBe(2);
		expect(parsed.machine_filter).toBe('myia-web1');
	});
});

describe('roosync_indexing status hints (non-covered branches)', () => {
	const ensureFresh = vi.fn().mockResolvedValue(true);
	const saveSkeleton = vi.fn();
	const setEnabled = vi.fn();
	const mockRebuildHandler = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('emits disabled hint when isQdrantIndexingEnabled=false (L431-433)', async () => {
		const indexingState = {
			qdrantIndexQueue: new Set<string>(),
			qdrantIndexInterval: null,
			isQdrantIndexingEnabled: false,
			indexingMetrics: { totalTasks: 0, skippedTasks: 0, indexedTasks: 0, failedTasks: 0, retryTasks: 0, bandwidthSaved: 0, lastIndexedAt: undefined }
		};
		const result: any = await handleRooSyncIndexing(
			{ action: 'status' }, new Map(), ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler, indexingState
		);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.diagnostic_hints).toBeDefined();
		expect(parsed.diagnostic_hints.some((h: string) => h.includes('Indexation Qdrant désactivée'))).toBe(true);
	});

	test('emits queue-stalled hint when queue non-empty but no interval (L434-436)', async () => {
		const indexingState = {
			qdrantIndexQueue: new Set(['task-stuck']),
			qdrantIndexInterval: null,
			isQdrantIndexingEnabled: true,
			indexingMetrics: { totalTasks: 0, skippedTasks: 0, indexedTasks: 0, failedTasks: 0, retryTasks: 0, bandwidthSaved: 0, lastIndexedAt: undefined }
		};
		const result: any = await handleRooSyncIndexing(
			{ action: 'status' }, new Map(), ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler, indexingState
		);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.diagnostic_hints.some((h: string) => h.includes('Queue non vide mais worker non démarré'))).toBe(true);
	});

	test('collects failed_task_details from cache (#2307, L438-454)', async () => {
		const cache = new Map();
		cache.set('failed-1', {
			metadata: { indexingState: { indexStatus: 'failed', indexError: 'timeout 300s', indexRetryCount: 2, lastIndexAttempt: '2026-07-01T10:00:00Z' } }
		} as any);
		cache.set('ok-1', { metadata: { indexingState: { indexStatus: 'success' } } } as any);

		const indexingState = {
			qdrantIndexQueue: new Set<string>(),
			qdrantIndexInterval: null,
			isQdrantIndexingEnabled: true,
			indexingMetrics: { totalTasks: 0, skippedTasks: 0, indexedTasks: 0, failedTasks: 0, retryTasks: 0, bandwidthSaved: 0, lastIndexedAt: undefined }
		};
		const result: any = await handleRooSyncIndexing(
			{ action: 'status' }, cache, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler, indexingState
		);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.failed_task_details).toHaveLength(1);
		expect(parsed.failed_task_details[0]).toMatchObject({ task_id: 'failed-1', error: 'timeout 300s', retry_count: 2 });
	});
});

describe('roosync_indexing cleanup action', () => {
	const ensureFresh = vi.fn().mockResolvedValue(true);
	const saveSkeleton = vi.fn();
	const setEnabled = vi.fn();
	const mockRebuildHandler = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('returns cleanup JSON on success with vectors_affected (L485-503)', async () => {
		mockCleanupOldVectors.mockResolvedValue({ deletedCount: 42, cutoffDate: '2026-04-01', workspaceFilter: null });
		const result: any = await handleRooSyncIndexing(
			{ action: 'cleanup', max_age_days: 90 } as any,
			new Map(), ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		expect(result.isError).toBe(false);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.action).toBe('cleanup');
		expect(parsed.mode).toBe('executed');
		expect(parsed.vectors_affected).toBe(42);
		expect(mockCleanupOldVectors).toHaveBeenCalledWith(90, false, undefined);
	});

	test('returns error when cleanupOldVectors throws (L504-512)', async () => {
		mockCleanupOldVectors.mockRejectedValue(new Error('qdrant unreachable'));
		const result: any = await handleRooSyncIndexing(
			{ action: 'cleanup' } as any,
			new Map(), ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Erreur lors du cleanup');
		expect(result.content[0].text).toContain('qdrant unreachable');
	});

	test('uses dry_run mode when dry_run=true (L483, L488)', async () => {
		mockCleanupOldVectors.mockResolvedValue({ deletedCount: 5, cutoffDate: '2026-04-01', workspaceFilter: null });
		const result: any = await handleRooSyncIndexing(
			{ action: 'cleanup', dry_run: true } as any,
			new Map(), ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.mode).toBe('dry_run');
		expect(mockCleanupOldVectors).toHaveBeenCalledWith(90, true, undefined);
	});
});

describe('roosync_indexing cleanup_orphans needs_confirm path', () => {
	const ensureFresh = vi.fn().mockResolvedValue(true);
	const saveSkeleton = vi.fn();
	const setEnabled = vi.fn();
	const mockRebuildHandler = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('dry_run=true reports detected orphans without deletion (L599-634)', async () => {
		mockDetectAndCleanupOrphans.mockResolvedValue({
			orphans: ['orphan-1', 'orphan-2'], total_task_ids_in_qdrant: 100, in_cache: 98, on_disk: 98, vectors_deleted: 0, errors: []
		});
		const result: any = await handleRooSyncIndexing(
			{ action: 'cleanup_orphans', dry_run: true } as any,
			new Map(), ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		expect(result.isError).toBe(false);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.mode).toBe('dry_run');
		expect(parsed.scan.orphans_detected).toBe(2);
		expect(parsed.cleanup).toBeNull();
		expect(mockDetectAndCleanupOrphans).toHaveBeenCalledWith(expect.any(Map), true, false);
	});

	test('dry_run=false without confirm → needs_confirm mode (L606-611, L619)', async () => {
		mockDetectAndCleanupOrphans.mockResolvedValue({
			orphans: ['o-1'], total_task_ids_in_qdrant: 50, in_cache: 49, on_disk: 49, vectors_deleted: 0, errors: []
		});
		const result: any = await handleRooSyncIndexing(
			{ action: 'cleanup_orphans', dry_run: false, confirm_orphan_cleanup: false } as any,
			new Map(), ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.mode).toBe('needs_confirm');
		expect(parsed.summary).toContain('confirmation requise');
		expect(mockDetectAndCleanupOrphans).toHaveBeenCalledWith(expect.any(Map), false, false);
	});

	test('returns error when detectAndCleanupOrphans throws (L635-643)', async () => {
		mockDetectAndCleanupOrphans.mockRejectedValue(new Error('qdrant count failed'));
		const result: any = await handleRooSyncIndexing(
			{ action: 'cleanup_orphans' } as any,
			new Map(), ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Erreur lors du cleanup orphelins');
	});
});

describe('roosync_indexing tool_usage_stats validation', () => {
	const ensureFresh = vi.fn().mockResolvedValue(true);
	const saveSkeleton = vi.fn();
	const setEnabled = vi.fn();
	const mockRebuildHandler = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('rejects invalid start_date before any scan (L806-808)', async () => {
		const result: any = await handleRooSyncIndexing(
			{ action: 'tool_usage_stats', start_date: 'not-a-date' } as any,
			new Map(), ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Invalid start_date');
		// detectStorageLocations must NOT have been called (early return before scan)
		expect(mockDetectStorageLocations).not.toHaveBeenCalled();
	});

	test('rejects invalid end_date before any scan (L806-808)', async () => {
		const result: any = await handleRooSyncIndexing(
			{ action: 'tool_usage_stats', end_date: '2026-13-45' } as any,
			new Map(), ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Invalid');
		expect(mockDetectStorageLocations).not.toHaveBeenCalled();
	});
});

// ============================================================
// #2766 S2+ P1 follow-up — cleanup_failed action + status retrofit fallback
// ============================================================
describe('roosync_indexing cleanup_failed + status retrofit (#2766 S2+ P1 follow-up)', () => {
	// Build a minimal ConversationSkeleton shape for these tests. We only need
	// `metadata.indexingState` to drive the failedTasks scan and the
	// cleanup_failed candidate scan.
	const makeSkeleton = (idx: any): ConversationSkeleton => ({
		taskId: 'stub',
		metadata: { indexingState: idx },
		sequence: [],
	} as any);

	const ensureFresh = vi.fn().mockResolvedValue(true);
	const saveSkeleton = vi.fn().mockResolvedValue(undefined);
	const setEnabled = vi.fn();
	const mockRebuildHandler = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		// Reset static mock state — resetIndexingState no-op default.
		mockResetIndexingState.mockClear();
	});

	test('status retrofit: legacy idx with no errorClass is re-classified via 15-class classifier', async () => {
		// Legacy failure persisted BEFORE #886 — idx.errorClass is undefined.
		// The status tool must run the message through classifyIndexingError so
		// the operator sees a real class instead of 'unknown'.
		const cache = new Map<string, ConversationSkeleton>([
			['legacy-1', makeSkeleton({
				indexStatus: 'failed',
				indexError: 'Claude Code session abc-123 not found',
				indexRetryCount: 3,
				lastIndexAttempt: '2026-07-20T00:00:00Z',
				// NB: NO errorClass — legacy shape.
			})],
		]);

		const result: any = await handleRooSyncIndexing(
			{ action: 'status' } as any,
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.failed_task_details).toHaveLength(1);
		expect(parsed.failed_task_details[0].error_class).toBe('claude_session_not_found');
		// failed_by_class reflects the retrofit classification.
		expect(parsed.failed_by_class).toEqual([{ error_class: 'claude_session_not_found', count: 1 }]);
	});

	test('status surfaces stuck-retry tasks via isStuckRetry helper (pre-#886 livelock era)', async () => {
		// Stuck retry: indexStatus='retry' AND retryCount >= MAX_RETRY_ATTEMPTS (3).
		// These tasks pre-date #886 — they never flipped to 'failed' but the
		// operator needs to see them. isStuckRetry() is the single source of truth.
		const cache = new Map<string, ConversationSkeleton>([
			['stuck-1', makeSkeleton({
				indexStatus: 'retry',
				indexError: 'Indexing timeout 300000ms',
				indexRetryCount: 5, // way past MAX_RETRY_ATTEMPTS=3
				errorClass: 'embedding_timeout',
			})],
			['not-stuck', makeSkeleton({
				indexStatus: 'retry',
				indexError: 'Indexing timeout 300000ms',
				indexRetryCount: 1, // still in retry budget
				errorClass: 'embedding_timeout',
			})],
		]);

		const result: any = await handleRooSyncIndexing(
			{ action: 'status' } as any,
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		const parsed = JSON.parse(result.content[0].text);
		// Only stuck-1 should appear in failed_task_details.
		expect(parsed.failed_task_details).toHaveLength(1);
		expect(parsed.failed_task_details[0].task_id).toBe('stuck-1');
		expect(parsed.failed_task_details[0].retry_count).toBe(5);
	});

	test('status stall hint: queue=0 but failed>0 nudges operator to cleanup_failed', async () => {
		const cache = new Map<string, ConversationSkeleton>([
			['failed-1', makeSkeleton({
				indexStatus: 'failed',
				indexError: 'quota exceeded',
				indexRetryCount: 3,
				errorClass: 'quota_exceeded',
			})],
		]);
		const indexingState = {
			qdrantIndexQueue: new Set<string>(), // drained
			qdrantIndexInterval: null,
			isQdrantIndexingEnabled: true,
			indexingMetrics: { totalTasks: 0, skippedTasks: 0, indexedTasks: 0, failedTasks: 0, retryTasks: 0, bandwidthSaved: 0 },
			deadLetterQueue: new Set<string>(),
			deadLetterDetails: new Map<string, any>(),
		};

		const result: any = await handleRooSyncIndexing(
			{ action: 'status' } as any,
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler,
			indexingState
		);
		const parsed = JSON.parse(result.content[0].text);
		const hints = parsed.diagnostic_hints as string[];
		expect(hints).toBeDefined();
		expect(hints.some(h => h.includes('cleanup_failed'))).toBe(true);
	});

	test('cleanup_failed dry_run=true (default) reports candidates without reset', async () => {
		const cache = new Map<string, ConversationSkeleton>([
			['f-1', makeSkeleton({
				indexStatus: 'failed',
				indexError: 'Claude Code session not found',
				indexRetryCount: 3,
				errorClass: 'claude_session_not_found',
			})],
			['f-2', makeSkeleton({
				indexStatus: 'failed',
				indexError: 'rate limit exceeded',
				indexRetryCount: 3,
				errorClass: 'rate_limit',
			})],
		]);

		const result: any = await handleRooSyncIndexing(
			{ action: 'cleanup_failed' } as any,
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.mode).toBe('dry_run');
		expect(parsed.candidates_count).toBe(2);
		expect(parsed.by_class).toEqual({ claude_session_not_found: 1, rate_limit: 1 });
		expect(parsed.reset_count).toBe(0);
		expect(parsed.reset_task_ids).toBeUndefined();
		// No reset/mutation calls.
		expect(mockResetIndexingState).not.toHaveBeenCalled();
		expect(saveSkeleton).not.toHaveBeenCalled();
	});

	test('cleanup_failed error_class filter narrows to matching class', async () => {
		const cache = new Map<string, ConversationSkeleton>([
			['f-1', makeSkeleton({
				indexStatus: 'failed',
				indexError: 'Claude Code session not found',
				indexRetryCount: 3,
				errorClass: 'claude_session_not_found',
			})],
			['f-2', makeSkeleton({
				indexStatus: 'failed',
				indexError: 'rate limit exceeded',
				indexRetryCount: 3,
				errorClass: 'rate_limit',
			})],
		]);

		const result: any = await handleRooSyncIndexing(
			{ action: 'cleanup_failed', error_class: 'claude_session_not_found' } as any,
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.candidates_count).toBe(1);
		expect(parsed.by_class).toEqual({ claude_session_not_found: 1 });
	});

	test('cleanup_failed dry_run=false executes reset + dead-letter + save', async () => {
		const cache = new Map<string, ConversationSkeleton>([
			['f-1', makeSkeleton({
				indexStatus: 'failed',
				indexError: 'Claude Code session not found',
				indexRetryCount: 3,
				errorClass: 'claude_session_not_found',
			})],
		]);
		const deadLetterQueue = new Set<string>();
		const deadLetterDetails = new Map<string, any>();
		const indexingState = {
			qdrantIndexQueue: new Set<string>(),
			qdrantIndexInterval: null,
			isQdrantIndexingEnabled: true,
			indexingMetrics: { totalTasks: 0, skippedTasks: 0, indexedTasks: 0, failedTasks: 0, retryTasks: 0, bandwidthSaved: 0 },
			deadLetterQueue,
			deadLetterDetails,
		};

		const result: any = await handleRooSyncIndexing(
			{ action: 'cleanup_failed', dry_run: false } as any,
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler,
			indexingState
		);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.mode).toBe('executed');
		expect(parsed.reset_count).toBe(1);
		expect(parsed.reset_task_ids).toEqual(['f-1']);
		// resetIndexingState must have been called.
		expect(mockResetIndexingState).toHaveBeenCalledTimes(1);
		// saveSkeleton callback must have been called (NOT direct disk write).
		expect(saveSkeleton).toHaveBeenCalledTimes(1);
		// Dead-letter bookkeeping was mirrored.
		expect(deadLetterQueue.has('f-1')).toBe(true);
		expect(deadLetterDetails.has('f-1')).toBe(true);
	});

	test('cleanup_failed skips non-failed and non-stuck-retry tasks', async () => {
		const cache = new Map<string, ConversationSkeleton>([
			['healthy', makeSkeleton({
				indexStatus: 'success',
				indexError: undefined,
				indexRetryCount: 0,
				errorClass: undefined,
			})],
			['in-progress', makeSkeleton({
				indexStatus: 'retry',
				indexError: 'transient',
				indexRetryCount: 1, // below MAX_RETRY_ATTEMPTS — not stuck
				errorClass: 'network_timeout',
			})],
			['failed', makeSkeleton({
				indexStatus: 'failed',
				indexError: 'must be cleaned',
				indexRetryCount: 3,
				errorClass: 'corrupted_data',
			})],
		]);

		const result: any = await handleRooSyncIndexing(
			{ action: 'cleanup_failed' } as any,
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.candidates_count).toBe(1);
		expect(parsed.by_class).toEqual({ corrupted_data: 1 });
	});

	test('cleanup_failed auth_failed emits operator warning note (anti-#1767-self-helix guard)', async () => {
		const cache = new Map<string, ConversationSkeleton>([
			['auth-1', makeSkeleton({
				indexStatus: 'failed',
				indexError: '401 Unauthorized',
				indexRetryCount: 3,
				errorClass: 'auth_failed',
			})],
		]);

		const result: any = await handleRooSyncIndexing(
			{ action: 'cleanup_failed', error_class: 'auth_failed', dry_run: false } as any,
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler
		);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.note).toBeDefined();
		expect(parsed.note).toContain('auth_failed');
		expect(parsed.note).toContain('API key');
		expect(parsed.reset_count).toBe(1);
	});

	// #2766 S3: dead-letter mirror is class-conditional. Transient errors must NOT be
	// dead-lettered (they should re-enter the queue to retry), only permanent ones park.
	test('cleanup_failed #2766 S3: transient error (rate_limit) is reset-only, NOT dead-lettered', async () => {
		const cache = new Map<string, ConversationSkeleton>([
			['t-1', makeSkeleton({
				indexStatus: 'failed',
				indexError: 'rate limit exceeded',
				indexRetryCount: 3,
				errorClass: 'rate_limit',
			})],
		]);
		const deadLetterQueue = new Set<string>();
		const deadLetterDetails = new Map<string, any>();
		const indexingState = {
			qdrantIndexQueue: new Set<string>(),
			qdrantIndexInterval: null,
			isQdrantIndexingEnabled: true,
			indexingMetrics: { totalTasks: 0, skippedTasks: 0, indexedTasks: 0, failedTasks: 0, retryTasks: 0, bandwidthSaved: 0 },
			deadLetterQueue,
			deadLetterDetails,
		};

		const result: any = await handleRooSyncIndexing(
			{ action: 'cleanup_failed', dry_run: false } as any,
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler,
			indexingState
		);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.mode).toBe('executed');
		expect(parsed.reset_count).toBe(1);
		// Transient candidate counts surfaced for operator visibility.
		expect(parsed.transient_candidates).toBe(1);
		expect(parsed.permanent_candidates).toBe(0);
		expect(parsed.reset_for_retry_count).toBe(1);
		expect(parsed.dead_lettered_count).toBe(0);
		// #2766 S3: rate_limit is transient → NOT parked in dead-letter.
		expect(deadLetterQueue.has('t-1')).toBe(false);
		expect(deadLetterDetails.has('t-1')).toBe(false);
	});

	test('cleanup_failed #2766 S3: mixed permanent + transient splits dead-letter vs reset-for-retry', async () => {
		const cache = new Map<string, ConversationSkeleton>([
			['perm-1', makeSkeleton({
				indexStatus: 'failed',
				indexError: 'Claude Code session not found',
				indexRetryCount: 3,
				errorClass: 'claude_session_not_found',
			})],
			['trans-1', makeSkeleton({
				indexStatus: 'failed',
				indexError: 'rate limit exceeded',
				indexRetryCount: 3,
				errorClass: 'rate_limit',
			})],
		]);
		const deadLetterQueue = new Set<string>();
		const deadLetterDetails = new Map<string, any>();
		const indexingState = {
			qdrantIndexQueue: new Set<string>(),
			qdrantIndexInterval: null,
			isQdrantIndexingEnabled: true,
			indexingMetrics: { totalTasks: 0, skippedTasks: 0, indexedTasks: 0, failedTasks: 0, retryTasks: 0, bandwidthSaved: 0 },
			deadLetterQueue,
			deadLetterDetails,
		};

		const result: any = await handleRooSyncIndexing(
			{ action: 'cleanup_failed', dry_run: false } as any,
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, mockRebuildHandler,
			indexingState
		);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.candidates_count).toBe(2);
		expect(parsed.permanent_candidates).toBe(1);
		expect(parsed.transient_candidates).toBe(1);
		expect(parsed.reset_count).toBe(2);
		expect(parsed.dead_lettered_count).toBe(1);
		expect(parsed.reset_for_retry_count).toBe(1);
		// Permanent → dead-lettered; transient → reset-only.
		expect(deadLetterQueue.has('perm-1')).toBe(true);
		expect(deadLetterQueue.has('trans-1')).toBe(false);
	});
});

