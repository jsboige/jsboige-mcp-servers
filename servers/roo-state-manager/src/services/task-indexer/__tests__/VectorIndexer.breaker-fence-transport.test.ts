/**
 * #4352 g5 follow-up (ai-01 queue 20261028f, approval 5680633495) — a backend
 * that HANGS never opened the seat breaker.
 *
 * The sequence the fleet hit: an embed call pends past the 180 s inactivity
 * budget; the watchdog aborts the run; the call finally fails as a TRANSPORT
 * error ("Connection error.", a 502, a 300 s timeout). The batch loop breaks
 * on `embedFailures.transport` (L1254), and the next window's fence (L1233)
 * throws the marked watchdog error BEFORE the `missingVectors` throw (L1326)
 * could carry `transport: true` — so the g5 carve-out (review ms#1548 B2)
 * skipped `recordFailure()`. Net effect: the sickest backend possible (one
 * that hangs) was the ONLY failure mode that never debited the breaker, and
 * every task kept paying the full 180 s budget against it, forever.
 *
 * This file pins the corrected contract: a fence debits nothing ONLY when the
 * run was otherwise healthy (`embedFailures.transport === false`). The
 * healthy-fence side of the contract stays pinned by the three-fence test in
 * `src/services/__tests__/inactivity-watchdog.test.ts`.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

// Same pacer pin as VectorIndexer.coverage.test.ts (see its header comment):
// MAX_OPERATIONS_PER_WINDOW is read ONCE at module load; a production seat's
// `.env` would otherwise throttle this suite's embedding calls.
process.env.EMBEDDING_OPS_PER_MINUTE = '0';

const {
	mockGetCollections, mockCreateCollection, mockCreatePayloadIndex,
	mockUpsert, mockCount, mockRetrieve, mockScroll,
} = vi.hoisted(() => ({
		mockGetCollections: vi.fn(),
		mockCreateCollection: vi.fn(),
		mockCreatePayloadIndex: vi.fn(),
		mockUpsert: vi.fn(),
		mockCount: vi.fn(),
		mockRetrieve: vi.fn(),
		mockScroll: vi.fn(),
}));
const { mockEmbeddingsCreate } = vi.hoisted(() => ({ mockEmbeddingsCreate: vi.fn() }));
const { mockExtractTask, mockSplitChunk } = vi.hoisted(() => ({
	mockExtractTask: vi.fn(),
	mockSplitChunk: vi.fn(),
}));
const { mockValidateVector, mockSanitizePayload } = vi.hoisted(() => ({
	mockValidateVector: vi.fn(),
	mockSanitizePayload: vi.fn((p: any) => p || {}),
}));

vi.mock('../../qdrant.js', () => ({
	getQdrantClient: vi.fn(() => ({
		getCollections: mockGetCollections,
		createCollection: mockCreateCollection,
		createPayloadIndex: mockCreatePayloadIndex,
		upsert: mockUpsert,
		count: mockCount,
		retrieve: mockRetrieve,
		scroll: mockScroll,
	})),
}));

vi.mock('../../openai.js', () => ({
	default: vi.fn(() => ({ embeddings: { create: mockEmbeddingsCreate } })),
	getEmbeddingModel: vi.fn(() => 'text-embedding-3-small'),
	getEmbeddingDimensions: vi.fn(() => 1536),
}));

vi.mock('../EmbeddingValidator.js', () => ({
	validateVectorGlobal: mockValidateVector,
	sanitizePayload: mockSanitizePayload,
}));

vi.mock('../ChunkExtractor.js', () => ({
	extractChunksFromTask: mockExtractTask,
	extractChunksFromClaudeSession: vi.fn(),
	splitChunk: mockSplitChunk,
	MAX_CHUNKS_PER_TASK: 50000,
	computeChunkId: vi.fn(() => 'mock-deterministic-uuid'),
}));

vi.mock('../QdrantHealthMonitor.js', () => ({
	networkMetrics: { qdrantCalls: 0, bytesTransferred: 0 },
}));

const COLLECTION = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

function chunkOf(i: number): any {
	return {
		chunk_id: `c-hang-${i}`,
		content: `content-${i}-${'x'.repeat(12)}`,
		indexed: true,
		task_id: 't-hang',
		sequence_order: i,
		chunk_type: 'message_exchange',
		role: 'user',
		total_chunks: 1,
		chunk_index: i + 1,
	};
}

describe('VectorIndexer — fence + transport failure still debits the breaker (#4352 g5 follow-up)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetCollections.mockResolvedValue({ collections: [{ name: COLLECTION }] });
		mockCreateCollection.mockResolvedValue(undefined);
		mockCreatePayloadIndex.mockResolvedValue({ result: { status: 'acknowledged' } });
		mockUpsert.mockResolvedValue(undefined);
		mockCount.mockResolvedValue({ count: 100 });   // small collection → preflight proceeds
		mockRetrieve.mockResolvedValue([]);             // chunk_id preflight: nothing exists
		mockScroll.mockResolvedValue({ points: [], next_page_offset: null });
		mockValidateVector.mockReset().mockImplementation(() => {});
		mockSanitizePayload.mockReset().mockImplementation((p: any) => p || {});
		mockSplitChunk.mockReset().mockImplementation((c: any) => [c]);
		mockExtractTask.mockReset().mockResolvedValue([]);
	});

	test('an embed that hangs then fails as TRANSPORT debits the breaker when the fence fires', async () => {
		vi.resetModules();
		const { indexTask, resetCircuitBreakerForTest, getCircuitBreakerState } = await import('../VectorIndexer.js');
		resetCircuitBreakerForTest();

		// 260 sub-chunks > UPSERT_WINDOW_SUBCHUNKS (256) ⇒ two windows. The hang
		// happens in window 1's first batch; the fence must then fire at window
		// 2's entry checkpoint — exactly the preemption order that used to lose
		// the transport signal before the `missingVectors` throw could carry it.
		mockExtractTask.mockResolvedValue(Array.from({ length: 260 }, (_, i) => chunkOf(i)));

		const controller = new AbortController();
		let embedCalls = 0;
		mockEmbeddingsCreate.mockImplementation(() => {
			embedCalls++;
			// The backend hung past the 180 s budget: the watchdog fired DURING
			// the call, then the call itself failed as a transport error.
			controller.abort(new Error(
				'Indexing timeout for t-hang — no batch acknowledged for 180000ms (inactivity watchdog #4352 g5)'
			));
			return Promise.reject(new Error('Connection error.'));
		});

		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		let thrown: any = null;
		try {
			await indexTask('t-hang', '/nowhere', 'roo', undefined, { signal: controller.signal });
		} catch (e) {
			thrown = e;
		}

		try {
			// the fence did throw (marked, classifiable wording)…
			expect(thrown).not.toBeNull();
			expect(thrown.details?.watchdogAbort).toBe(true);
			expect(String(thrown.message)).toMatch(/Indexing timeout for t-hang/);
			// …after exactly one batch: the batch loop broke on transport
			expect(embedCalls).toBe(1);
			// THE contract: the fence still debits. A backend that hangs is the
			// failure mode the breaker exists to stop the fleet from paying for.
			expect(getCircuitBreakerState().failureCount).toBe(1);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});
});
