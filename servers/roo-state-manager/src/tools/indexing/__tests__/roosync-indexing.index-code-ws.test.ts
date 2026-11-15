/**
 * #4736 P3 review (ai-01, 15/11) — HANDLER-BOUNDARY pins for `index_code_ws`.
 *
 * A mutation that inverts `dry_run` AND removes the no-prefix refusal at the
 * handler survived the service-level suite (603/603 green): the service tests
 * call `runWsIndexWriter` directly, so the tool boundary was unguarded. These
 * two tests assert exactly what the handler passes down and what it refuses
 * before any call.
 *
 * Deliberately a separate file: it mocks `services/qdrant.js`,
 * `utils/workspace-resolver.js` and the ws writer, which the sibling
 * `roosync-indexing.tool.test.ts` does not — isolating them here keeps that
 * suite's real dependencies untouched.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const {
	mockRunWsIndexWriter, mockResolveWorkspace, mockGetQdrantClient,
	mockEmbedCodebaseTexts, mockGetCodebaseEmbeddingModel, mockGetCodebaseEmbeddingEndpoint,
} = vi.hoisted(() => ({
	mockRunWsIndexWriter: vi.fn(),
	mockResolveWorkspace: vi.fn(),
	mockGetQdrantClient: vi.fn(),
	mockEmbedCodebaseTexts: vi.fn(),
	mockGetCodebaseEmbeddingModel: vi.fn(),
	mockGetCodebaseEmbeddingEndpoint: vi.fn(),
}));

// Static imports of the dispatcher — stubbed so this test never loads the real
// storage/Qdrant/gateway modules.
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

// The dynamic imports of the `index_code_ws` case.
vi.mock('../../../utils/workspace-resolver.js', () => ({ resolveWorkspace: mockResolveWorkspace }));
vi.mock('../../../services/qdrant.js', () => ({ getQdrantClient: mockGetQdrantClient }));
vi.mock('../../../services/code-index/embedding-client.js', () => ({
	embedCodebaseTexts: mockEmbedCodebaseTexts,
	getCodebaseEmbeddingModel: mockGetCodebaseEmbeddingModel,
	getCodebaseEmbeddingEndpoint: mockGetCodebaseEmbeddingEndpoint,
}));
vi.mock('../../../services/code-index/ws-index-writer.js', () => ({ runWsIndexWriter: mockRunWsIndexWriter }));

import { handleRooSyncIndexing } from '../roosync-indexing.tool.js';

const PREFIX = 'd:\\dev\\roo-extensions';

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

describe('index_code_ws — HANDLER boundary (#4736 P3 review)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockResolveWorkspace.mockResolvedValue({ workspace: 'C:\\fake\\ws', source: 'test' });
		mockGetQdrantClient.mockReturnValue({});
		mockGetCodebaseEmbeddingModel.mockReturnValue('test-model');
		mockGetCodebaseEmbeddingEndpoint.mockReturnValue('embed.internal');
		mockEmbedCodebaseTexts.mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]);
		mockRunWsIndexWriter.mockResolvedValue({
			status: 'dry_run', dry_run: true, collection: 'ws-aaaaaaaaaaaaaaaa', files_to_index: 0, warnings: [],
		});
	});

	test('refuses WITHOUT hash_path_prefix — the writer is never called', async () => {
		const result: any = await runHandler({ action: 'index_code_ws' });
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0].text);
		expect(payload.status).toBe('ws_writer_refused');
		expect(payload.message).toMatch(/hash_path_prefix is REQUIRED/);
		expect(mockRunWsIndexWriter).not.toHaveBeenCalled();
	});

	test('dry_run is INVERTED at the handler: omitted → dryRun true, passed down', async () => {
		const result: any = await runHandler({ action: 'index_code_ws', hash_path_prefix: PREFIX });
		// the handler sets isError explicitly: only 'failed' is an error
		expect(result.isError).toBe(false);
		expect(mockRunWsIndexWriter).toHaveBeenCalledTimes(1);
		expect(mockRunWsIndexWriter).toHaveBeenCalledWith(expect.objectContaining({
			hashPathPrefix: PREFIX,
			workspaceRoot: 'C:\\fake\\ws',
			dryRun: true,
			takeover: false,
		}));
	});

	test('dry_run: false reaches the writer as dryRun: false — and the hint disappears', async () => {
		mockRunWsIndexWriter.mockResolvedValue({
			status: 'success', dry_run: false, collection: 'ws-aaaaaaaaaaaaaaaa', files_to_index: 1, warnings: [],
		});
		const result: any = await runHandler({ action: 'index_code_ws', hash_path_prefix: PREFIX, dry_run: false });
		expect(result.isError).toBe(false);
		expect(mockRunWsIndexWriter).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
		const payload = JSON.parse(result.content[0].text);
		expect(payload.hint).toBeUndefined();
	});
});