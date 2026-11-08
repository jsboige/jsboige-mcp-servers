/**
 * #4352 — phase B2 (contentHash preflight) must ACKNOWLEDGE progress and
 * honor the fence, like every other pre-embedding phase (g5, review ms#1548).
 *
 * The leader-indexes-nothing incident on ai-01 (07/11 16:36Z→, 70×
 * `embedding_timeout`, all `last_attempt_written: 0`) has this shape: on a
 * collection past #2209's 5M-point threshold the chunk_id preflight (B) is
 * SKIPPED, so B2 inherits every sub-chunk and runs scroll batch after scroll
 * batch — with zero `onProgress` acks, the 180 s inactivity watchdog fenced
 * healthy big sessions before the first embedding call. This file pins:
 *   1. each answered B2 scroll batch acknowledges (count at the FIRST
 *      embeddings.create call proves the pre-embedding phases all acked);
 *   2. a watchdog abort during B2 fences at the next scroll batch — the run
 *      rejects with the marked watchdog error and never reaches embedding.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

// Same pacer pin as VectorIndexer.coverage.test.ts: MAX_OPERATIONS_PER_WINDOW
// is read ONCE at module load; a production seat's `.env` would otherwise
// throttle this suite's embedding calls.
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
		chunk_id: `c-b2-${i}`,
		content: `content-${i}-${'x'.repeat(12)}`,
		indexed: true,
		task_id: 't-b2',
		sequence_order: i,
		chunk_type: 'message_exchange',
		role: 'user',
		total_chunks: 1,
		chunk_index: i + 1,
	};
}

describe('VectorIndexer — B2 contentHash preflight acks + fence (#4352)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetCollections.mockResolvedValue({ collections: [{ name: COLLECTION }] });
		mockCreateCollection.mockResolvedValue(undefined);
		mockCreatePayloadIndex.mockResolvedValue({ result: { status: 'acknowledged' } });
		mockUpsert.mockResolvedValue(undefined);
		mockCount.mockResolvedValue({ count: 100 });   // small collection → chunk_id preflight proceeds
		mockRetrieve.mockResolvedValue([]);             // chunk_id preflight: nothing exists
		mockScroll.mockResolvedValue({ points: [], next_page_offset: null }); // B2: nothing exists
		mockValidateVector.mockReset().mockImplementation(() => {});
		mockSanitizePayload.mockReset().mockImplementation((p: any) => p || {});
		mockSplitChunk.mockReset().mockImplementation((c: any) => [c]);
		mockExtractTask.mockReset().mockResolvedValue([]);
	});

	test('every pre-embedding phase acks: onProgress count at the first embeddings.create call', async () => {
		vi.resetModules();
		const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
		resetCircuitBreakerForTest();

		// 250 distinct contents → 250 unique hashes, one task.
		mockExtractTask.mockResolvedValue(Array.from({ length: 250 }, (_, i) => chunkOf(i)));

		let acksAtFirstEmbed: number | null = null;
		let scrollsAtFirstEmbed: number | null = null;
		let embedCalls = 0;
		mockEmbeddingsCreate.mockImplementation(async (req: any) => {
			embedCalls++;
			if (embedCalls === 1) {
				acksAtFirstEmbed = ackCount;
				scrollsAtFirstEmbed = mockScroll.mock.calls.length;
			}
			const n = Array.isArray(req.input) ? req.input.length : 1;
			return { data: Array.from({ length: n }, () => ({ embedding: Array(1536).fill(0.1) })) };
		});

		let ackCount = 0;
		const onProgress = () => { ackCount++; };
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await indexTask('t-b2', '/nowhere', 'roo', undefined, { onProgress });
		} finally {
			logSpy.mockRestore(); warnSpy.mockRestore(); errorSpy.mockRestore();
		}

		// Extraction: 1 ack. Phase B (chunk_id): ceil(250/100) = 3 retrieve
		// batches → 3 acks. Phase B2 (contentHash): ceil(250/100) = 3 scroll
		// batches → 3 acks. Before the fix, B2 acked ZERO of these — the 180 s
		// watchdog saw silence between extraction and the first embed batch.
		expect(acksAtFirstEmbed).toBe(7);
		// Sanity: the B2 scroll preflight really ran before embedding —
		// ceil(250/100) = 3 batched scroll calls (the post-index dedup adds
		// its own 3 AFTER embedding, hence scoping at the first embed call).
		expect(scrollsAtFirstEmbed).toBe(3);
	});

	test('a watchdog abort during B2 fences at the next scroll batch — marked error, no embedding', async () => {
		vi.resetModules();
		const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
		resetCircuitBreakerForTest();

		// 350 unique hashes → 4 B2 scroll batches.
		mockExtractTask.mockResolvedValue(Array.from({ length: 350 }, (_, i) => chunkOf(i)));

		const controller = new AbortController();
		mockScroll.mockImplementation(async () => {
			// The watchdog fires DURING the 2nd answered batch: the deadline
			// expired with no ack (the pre-fix world), or a scroll stalled.
			if (mockScroll.mock.calls.length === 2) {
				controller.abort(new Error(
					'Indexing timeout for t-b2 — no batch acknowledged for 180000ms (inactivity watchdog #4352 g5)'
				));
			}
			return { points: [], next_page_offset: null };
		});

		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		let thrown: any = null;
		try {
			await indexTask('t-b2', '/nowhere', 'roo', undefined, { signal: controller.signal });
		} catch (e) {
			thrown = e;
		} finally {
			logSpy.mockRestore(); warnSpy.mockRestore(); errorSpy.mockRestore();
		}

		// The fence threw between scroll batches 2 and 3 — the marked,
		// classifiable watchdog error (not a raw scroll failure).
		expect(thrown).not.toBeNull();
		expect(thrown.details?.watchdogAbort).toBe(true);
		expect(String(thrown.message)).toMatch(/Indexing timeout for t-b2/);
		expect(mockScroll.mock.calls.length).toBe(2);
		// The run never reached the embedding phase.
		expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
	});
});
