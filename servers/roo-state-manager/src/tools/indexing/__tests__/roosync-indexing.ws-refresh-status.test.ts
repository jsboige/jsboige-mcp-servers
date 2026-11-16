/**
 * #4736 P4 — HANDLER-BOUNDARY pins for `ws_refresh_status`.
 *
 * Same rationale as the P3 handler suite (roosync-indexing.index-code-ws):
 * a mutation at the tool boundary — status action returning an error, the
 * state swallowed, the loop flag hardcoded — would survive the service-level
 * suite, which never crosses the dispatcher. These tests pin exactly what the
 * handler reads and returns.
 *
 * Deliberately a separate file (same convention): it mocks
 * `services/code-index/ws-refresh-loop.js`, keeping the sibling suites' real
 * dependencies untouched.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockIsRunning, mockReadState, mockDefaultStatePath } = vi.hoisted(() => ({
	mockIsRunning: vi.fn(),
	mockReadState: vi.fn(),
	mockDefaultStatePath: vi.fn(),
}));

vi.mock('../../../utils/shared-state-path.js', () => ({
	getSharedStatePath: () => '',
	tryGetSharedStatePath: () => '',
	ensureStoreSubdir: () => '',
	assertSharedStoreAccessible: () => {},
}));
vi.mock('../../../services/task-archiver/index.js', () => ({
	TaskArchiver: { archiveTask: vi.fn(), archiveClaudeCodeSessions: vi.fn(), listArchivedTasks: vi.fn() },
}));
vi.mock('../../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: { findConversationById: vi.fn(), detectStorageLocations: vi.fn() },
}));
vi.mock('../index-task.tool.js', () => ({ indexTaskSemanticTool: { handler: vi.fn() } }));
vi.mock('../reset-collection.tool.js', () => ({ resetQdrantCollectionTool: { handler: vi.fn() } }));
vi.mock('../diagnose-index.tool.js', () => ({ handleDiagnoseSemanticIndex: vi.fn() }));
vi.mock('../../../services/task-indexer/VectorIndexer.js', () => ({ cleanupOldVectors: vi.fn() }));
vi.mock('../cleanup-orphans.js', () => ({ detectAndCleanupOrphans: vi.fn() }));
vi.mock('../../../services/background-services.js', () => ({
	classifyIndexingError: vi.fn(() => 'unknown'),
	reconcileErrorClass: vi.fn(),
	readLeaderLockInfo: vi.fn(),
	readIndexerQueueStatus: vi.fn(),
	noteIndexEnqueue: vi.fn(),
}));
vi.mock('../../../services/indexing-decision.js', () => ({
	IndexingDecisionService: class { resetIndexingState = vi.fn(); armHeadlessRepair = vi.fn(); },
}));

// The dynamic import of the `ws_refresh_status` case.
vi.mock('../../../services/code-index/ws-refresh-loop.js', () => ({
	isWsRefreshLoopRunning: mockIsRunning,
	readWsRefreshState: mockReadState,
	defaultWsRefreshStatePath: mockDefaultStatePath,
}));

import { handleRooSyncIndexing } from '../roosync-indexing.tool.js';

function runHandler(args: Record<string, unknown>) {
	return handleRooSyncIndexing(
		args as any,
		new Map(),
		vi.fn().mockResolvedValue(true),
		vi.fn().mockResolvedValue(undefined),
		new Set<string>(),
		vi.fn(),
		vi.fn(),
	);
}

const SAMPLE_STATE = {
	workspace_root: 'C:\\dev\\roo-extensions',
	writer: 'myia-web1:roo-extensions',
	poll_seconds: 120,
	indexed_head: '42358fb0123456789012345678901234567890ab',
	last_run: {
		started_at: '2026-11-15T20:00:00Z',
		finished_at: '2026-11-15T20:00:42Z',
		head: '42358fb0123456789012345678901234567890ab',
		status: 'success',
		files_indexed: 3,
		files_removed: 1,
		points_written: 34,
		points_deleted: 12,
		elapsed_ms: 42_000,
	},
	last_error: null,
	consecutive_failures: 0,
	retry_not_before_ms: 0,
	announced_delay_s: 162,
	last_refresh_ms: 41_800,
	updated_at: '2026-11-15T20:00:42Z',
};

describe('ws_refresh_status — HANDLER boundary (#4736 P4)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDefaultStatePath.mockReturnValue('C:\\Users\\t\\.roo-state-manager\\ws-refresh-state.json');
		mockIsRunning.mockReturnValue(true);
		mockReadState.mockReturnValue(SAMPLE_STATE);
		process.env.WS_INDEX_REFRESH_ENABLED = 'true';
		process.env.WS_INDEX_REFRESH_WORKSPACE = 'C:\\dev\\roo-extensions';
		process.env.WS_INDEX_REFRESH_HASH_PREFIX = 'd:\\dev\\roo-extensions';
		delete process.env.WS_INDEX_REFRESH_POLL_SECONDS;
	});

	test('returns the loop flag, the state and the ANNOUNCED delay — read-only, never an error', async () => {
		const result: any = await runHandler({ action: 'ws_refresh_status' });
		expect(result.isError).toBe(false);
		const payload = JSON.parse(result.content[0].text);
		expect(payload.loop_running).toBe(true);
		expect(payload.announced_delay_s).toBe(162);
		expect(payload.state.indexed_head).toBe(SAMPLE_STATE.indexed_head);
		expect(payload.state.last_run.points_deleted).toBe(12);
		// The SLO's meaning is served WITH the number — a delay without its
		// formula is not an announced delay.
		expect(payload.announced_delay_meaning).toMatch(/poll_seconds \+ ceil/);
		// No hint when the loop runs.
		expect(payload.hint).toBeUndefined();
	});

	test('no state file yet → still a success, with the arming hint', async () => {
		mockIsRunning.mockReturnValue(false);
		mockReadState.mockReturnValue(null);
		const result: any = await runHandler({ action: 'ws_refresh_status' });
		expect(result.isError).toBe(false);
		const payload = JSON.parse(result.content[0].text);
		expect(payload.loop_running).toBe(false);
		expect(payload.state).toBeNull();
		expect(payload.hint).toMatch(/WS_INDEX_REFRESH_ENABLED=true/);
	});

	test('loop stopped but state present → the resume hint, not the arming one', async () => {
		mockIsRunning.mockReturnValue(false);
		const result: any = await runHandler({ action: 'ws_refresh_status' });
		const payload = JSON.parse(result.content[0].text);
		expect(payload.hint).toMatch(/resumes from indexed_head/);
	});

	test('the host env config is reported — the reader sees WHY the loop runs', async () => {
		const result: any = await runHandler({ action: 'ws_refresh_status' });
		const payload = JSON.parse(result.content[0].text);
		expect(payload.host_config).toEqual({
			enabled: true,
			workspace: 'C:\\dev\\roo-extensions',
			hash_path_prefix: 'd:\\dev\\roo-extensions',
			poll_seconds: 120,
		});
	});

	test('poll_seconds is reported CLAMPED like the loop runs it (ms#1782, same-push)', async () => {
		// The loop clamps (Math.max(10, parseInt||120)) in initializeWsRefreshLoop —
		// the status must report the cadence that actually runs, not the raw env.
		// A sub-floor or unparseable env therefore reports 10/120, never 2 or NaN.
		for (const [env, expected] of [['2', 10], ['garbage', 120], ['600', 600]] as const) {
			process.env.WS_INDEX_REFRESH_POLL_SECONDS = env;
			const result: any = await runHandler({ action: 'ws_refresh_status' });
			const payload = JSON.parse(result.content[0].text);
			expect(payload.host_config.poll_seconds, `env=${env}`).toBe(expected);
		}
	});
});

afterEach(() => {
	delete process.env.WS_INDEX_REFRESH_ENABLED;
	delete process.env.WS_INDEX_REFRESH_WORKSPACE;
	delete process.env.WS_INDEX_REFRESH_HASH_PREFIX;
	delete process.env.WS_INDEX_REFRESH_POLL_SECONDS;
});
