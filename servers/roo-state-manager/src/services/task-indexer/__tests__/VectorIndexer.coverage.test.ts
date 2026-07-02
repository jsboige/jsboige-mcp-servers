/**
 * Coverage complement for VectorIndexer.ts (#833 Sprint C3).
 *
 * Add-only, tests-only. The nominal VectorIndexer.test.ts drives the public API happy
 * paths (rate limiter, retry, ensureCollectionExists, resetCollection, the circuit-breaker
 * observability, the single-chunk indexTask flow). It leaves cold the internal dedup /
 * embedding machinery reached only with specific Qdrant/embedding mock shapes:
 *
 *  - dedupByContentHash (L551-625): post-index scroll dedup + pagination + non-blocking catch
 *  - preflightDedupByContentHash (L741-813): #2369 pre-embedding scroll dedup + pagination
 *  - embedSingle (L845-872): the EMBEDDING_BATCH_SIZE<=1 legacy path (env-gated at load)
 *  - embedBatch (L876-940): multi-item batch success + per-item validation + split-on-failure
 *  - buildBatches token-limit split (L827-834)
 *  - indexTask stages: cache-hit (L1050-1052), legacy single-embed (L1069-1076),
 *    dedup-reduced log (L1110-1112), upsert-failure throw (L1126-1134),
 *    claude-code source dispatch (L976), MAX_CHUNKS truncation (L986-989),
 *    empty sub-chunk skip (L998), non-Error final catch (L1160-1163)
 *  - preflightDedupByChunkId edge cases: >5M skip (L660-663), retrieve timeout (L696-699)
 *  - safeQdrantUpsert internals: validate-throw rethrow (L389-392), payload-cleaned log
 *    (L395-398), multi-batch batching + inter-batch pause (L421-423, L530-532), verbose (L443-448)
 *  - cleanupOldVectors: empty-scroll loop termination (L1421-1424), workspace-filtered logs
 *
 * Same mock strategy as the nominal suite (hoisted Qdrant/OpenAI/validator/chunk mocks).
 * Every assertion anchors on a real uncovered source line. 0 source change.
 *
 * @module services/task-indexer/__tests__/VectorIndexer.coverage
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';

const { mockGetCollections, mockCreateCollection, mockCreatePayloadIndex, mockUpsert, mockDeleteCollection, mockCount, mockRetrieve, mockScroll, mockDelete } = vi.hoisted(() => ({
	mockGetCollections: vi.fn(),
	mockCreateCollection: vi.fn(),
	mockCreatePayloadIndex: vi.fn(),
	mockUpsert: vi.fn(),
	mockDeleteCollection: vi.fn(),
	mockCount: vi.fn(),
	mockRetrieve: vi.fn(),
	mockScroll: vi.fn(),
	mockDelete: vi.fn(),
}));

const { mockEmbeddingsCreate } = vi.hoisted(() => ({ mockEmbeddingsCreate: vi.fn() }));
const { mockExtractTask, mockExtractClaude, mockSplitChunk } = vi.hoisted(() => ({
	mockExtractTask: vi.fn(),
	mockExtractClaude: vi.fn(),
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
		deleteCollection: mockDeleteCollection,
		count: mockCount,
		retrieve: mockRetrieve,
		scroll: mockScroll,
		delete: mockDelete,
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

// MAX_CHUNKS_PER_TASK kept small (3) so the truncation branch is reachable without 5000 chunks.
vi.mock('../ChunkExtractor.js', () => ({
	extractChunksFromTask: mockExtractTask,
	extractChunksFromClaudeSession: mockExtractClaude,
	splitChunk: mockSplitChunk,
	MAX_CHUNKS_PER_TASK: 3,
	computeChunkId: vi.fn(() => 'mock-deterministic-uuid'),
}));

vi.mock('../QdrantHealthMonitor.js', () => ({
	networkMetrics: { qdrantCalls: 0, bytesTransferred: 0 },
}));

const COLLECTION = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
const DIM = 1536;

/** sha256(content) — mirrors the SUT's per-sub-chunk contentHash (VectorIndexer.ts:999). */
function hashOf(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex');
}

function chunk(id: string, content: string, indexed = true): any {
	return {
		chunk_id: id, content, indexed,
		sequence_order: 0, chunk_type: 'message_exchange', role: 'user',
		total_chunks: 1, chunk_index: 0,
	};
}

/** Embedding mock that sizes its `data` array to the request `input` (string OR string[]). */
function embedOk(dim = DIM) {
	return ({ input }: any) => {
		const arr = Array.isArray(input) ? input : [input];
		return Promise.resolve({
			data: arr.map(() => ({ embedding: new Array(dim).fill(0.1) })),
			model: 'text-embedding-3-small',
			usage: { prompt_tokens: 1, total_tokens: 1 },
		});
	};
}

/** Reset mock return values to permissive defaults after clearAllMocks(). */
function applyDefaults() {
	mockGetCollections.mockResolvedValue({ collections: [{ name: COLLECTION }] });
	mockCreateCollection.mockResolvedValue(undefined);
	mockCreatePayloadIndex.mockResolvedValue({ result: { status: 'acknowledged' } });
	mockUpsert.mockResolvedValue(undefined);
	mockCount.mockResolvedValue({ count: 100 });          // small collection → preflight proceeds
	mockRetrieve.mockResolvedValue([]);                    // chunk_id preflight: nothing exists
	mockScroll.mockResolvedValue({ points: [], next_page_offset: null }); // contentHash scrolls: empty
	mockDelete.mockResolvedValue(undefined);
	mockValidateVector.mockReset().mockImplementation(() => {});
	mockSanitizePayload.mockReset().mockImplementation((p: any) => p || {});
	mockEmbeddingsCreate.mockReset().mockImplementation(embedOk());
	mockSplitChunk.mockReset().mockImplementation((c: any) => [c]);
	mockExtractTask.mockReset().mockResolvedValue([]);
	mockExtractClaude.mockReset().mockResolvedValue([]);
}

describe('VectorIndexer — coverage complement (#833 C3)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		applyDefaults();
	});
	afterEach(() => { vi.useRealTimers(); });

	// ────────────────────────────────────────────────────────────────
	// dedupByContentHash — post-index scroll dedup (L551-625)
	// ────────────────────────────────────────────────────────────────
	describe('dedupByContentHash (post-index, via indexTask)', () => {
		test('drops points whose contentHash already exists in Qdrant (L611-620 + indexTask L1110-1112)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			const content = 'dedup-existing-content';
			mockExtractTask.mockResolvedValue([chunk('c-dedup', content)]);
			// preflightDedupByContentHash scroll → empty (embed proceeds); dedup scroll → existing hash.
			mockScroll
				.mockResolvedValueOnce({ points: [], next_page_offset: null })
				.mockResolvedValue({ points: [{ id: 'x', payload: { contentHash: hashOf(content) } }], next_page_offset: null });

			const result = await indexTask('t-dedup-existing', '/p');

			expect(result).toEqual([]);          // every point deduped away
			expect(mockUpsert).not.toHaveBeenCalled();
		});

		test('paginates the dedup scroll via next_page_offset (L587-605)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			const content = 'dedup-paginated-content';
			mockExtractTask.mockResolvedValue([chunk('c-page', content)]);
			mockScroll
				.mockResolvedValueOnce({ points: [], next_page_offset: null })            // preflight contentHash: empty
				.mockResolvedValueOnce({ points: [{ payload: { contentHash: 'other' } }], next_page_offset: 'page-2' }) // dedup p1
				.mockResolvedValueOnce({ points: [{ payload: { contentHash: hashOf(content) } }], next_page_offset: null }); // dedup p2 → match

			const result = await indexTask('t-dedup-page', '/p');

			expect(result).toEqual([]);
			// preflight(1) + dedup page1 + dedup page2 = 3 scroll calls
			expect(mockScroll).toHaveBeenCalledTimes(3);
		});

		test('keeps all points when the dedup scroll throws (non-blocking catch L606-608)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			const content = 'dedup-scroll-throws';
			mockExtractTask.mockResolvedValue([chunk('c-throw', content)]);
			mockScroll
				.mockResolvedValueOnce({ points: [], next_page_offset: null }) // preflight: empty
				.mockRejectedValue(new Error('scroll boom'));                  // dedup scroll fails → keep points

			const result = await indexTask('t-dedup-throw', '/p');

			expect(result.length).toBe(1);          // point survived → indexed
			expect(mockUpsert).toHaveBeenCalled();
		});
	});

	// ────────────────────────────────────────────────────────────────
	// preflightDedupByContentHash — #2369 pre-embedding scroll dedup (L741-813)
	// ────────────────────────────────────────────────────────────────
	describe('preflightDedupByContentHash (#2369, via indexTask)', () => {
		test('skips sub-chunks whose content already exists BEFORE embedding (L799-808)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			const content = 'preflight-existing';
			mockExtractTask.mockResolvedValue([chunk('c-pf', content)]);
			// chunk_id preflight (retrieve) → empty; contentHash preflight scroll → existing.
			mockScroll.mockResolvedValue({ points: [{ payload: { contentHash: hashOf(content) } }], next_page_offset: null });

			const result = await indexTask('t-preflight-existing', '/p');

			expect(result).toEqual([]);
			expect(mockEmbeddingsCreate).not.toHaveBeenCalled(); // embedding skipped entirely
			expect(mockUpsert).not.toHaveBeenCalled();
		});

		test('paginates the preflight scroll via next_page_offset (L774-792)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			const content = 'preflight-paginated';
			mockExtractTask.mockResolvedValue([chunk('c-pfp', content)]);
			mockScroll
				.mockResolvedValueOnce({ points: [{ payload: { contentHash: 'noise' } }], next_page_offset: 'pf-2' })
				.mockResolvedValueOnce({ points: [{ payload: { contentHash: hashOf(content) } }], next_page_offset: null });

			const result = await indexTask('t-preflight-page', '/p');

			expect(result).toEqual([]);
			expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
		});

		test('keeps sub-chunks when the preflight scroll throws (non-blocking catch L793-794)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			const content = 'preflight-scroll-throws';
			mockExtractTask.mockResolvedValue([chunk('c-pft', content)]);
			// preflight scroll throws (kept), then post-index dedup scroll → empty (kept).
			mockScroll
				.mockRejectedValueOnce(new Error('preflight scroll boom'))
				.mockResolvedValue({ points: [], next_page_offset: null });

			const result = await indexTask('t-preflight-throw', '/p');

			expect(result.length).toBe(1);
			expect(mockEmbeddingsCreate).toHaveBeenCalled(); // fell through to embedding
		});
	});

	// ────────────────────────────────────────────────────────────────
	// embedBatch — multi-item batch + per-item validation + split (L876-940)
	// ────────────────────────────────────────────────────────────────
	describe('embedBatch (default EMBEDDING_BATCH_SIZE=16, via indexTask)', () => {
		test('embeds a multi-item batch in one API call (L905-928)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			mockExtractTask.mockResolvedValue([
				chunk('m1', 'multi content one'),
				chunk('m2', 'multi content two'),
			]);

			const result = await indexTask('t-batch-multi', '/p');

			expect(result.length).toBe(2);
			// one batched embeddings.create call for both chunks (input is an array)
			const batchCall = mockEmbeddingsCreate.mock.calls.find(c => Array.isArray(c[0].input));
			expect(batchCall).toBeDefined();
			expect(batchCall![0].input).toHaveLength(2);
			expect(mockUpsert).toHaveBeenCalled();
		});

		test('skips a batch item whose embedding has the wrong dimension (L921-924)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			mockExtractTask.mockResolvedValue([chunk('wd1', 'wrongdim a'), chunk('wd2', 'wrongdim b')]);
			// batch call returns one correct + one wrong-dim vector.
			mockEmbeddingsCreate.mockImplementation(({ input }: any) => {
				if (Array.isArray(input)) {
					return Promise.resolve({ data: [{ embedding: new Array(DIM).fill(0.1) }, { embedding: new Array(5).fill(0.1) }] });
				}
				return embedOk()({ input });
			});

			const result = await indexTask('t-batch-wrongdim', '/p');

			expect(result.length).toBe(1); // only the correctly-sized vector became a point
		});

		test('splits a failing multi-item batch into halves and retries each (L930-939)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			mockExtractTask.mockResolvedValue([chunk('s1', 'split content one'), chunk('s2', 'split content two')]);
			// First call = full batch of 2 → reject; recursive single-item halves → resolve.
			mockEmbeddingsCreate.mockImplementation(({ input }: any) => {
				if (Array.isArray(input) && input.length > 1) return Promise.reject(new Error('batch too big'));
				return embedOk()({ input });
			});

			const result = await indexTask('t-batch-split', '/p');

			expect(result.length).toBe(2); // both recovered via split
		});

		test('splits token-heavy sub-chunks into separate batches (buildBatches L827-834)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			const big = 'x'.repeat(30000); // ~7500 est tokens each → exceeds EMBEDDING_BATCH_MAX_TOKENS=7000
			mockExtractTask.mockResolvedValue([chunk('b1', big + '-1'), chunk('b2', big + '-2')]);

			const result = await indexTask('t-buildbatches', '/p');

			expect(result.length).toBe(2);
			// two separate batched (or single) create calls, one per token-split batch
			expect(mockEmbeddingsCreate.mock.calls.length).toBeGreaterThanOrEqual(2);
		});

		test('single-item batch: wrong dimension → null point (L893-896)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			// one chunk → embedBatch single-item path (default EMBEDDING_BATCH_SIZE=16)
			mockExtractTask.mockResolvedValue([chunk('sb-wd', 'single-batch wrong dim')]);
			mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: new Array(9).fill(0.1) }] });

			const result = await indexTask('t-singlebatch-wrongdim', '/p');

			expect(result).toEqual([]);
			expect(mockUpsert).not.toHaveBeenCalled();
		});

		test('single-item batch: embedding API throws → null point (L898-901)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			mockExtractTask.mockResolvedValue([chunk('sb-err', 'single-batch error')]);
			mockEmbeddingsCreate.mockRejectedValue(new Error('embedding service down'));

			const result = await indexTask('t-singlebatch-error', '/p');

			expect(result).toEqual([]); // caught → [null] → no point
		});

		test('multi-item batch: a null/invalid embedding is skipped (L917-920)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			mockExtractTask.mockResolvedValue([chunk('mn1', 'multi null a'), chunk('mn2', 'multi null b')]);
			mockEmbeddingsCreate.mockImplementation(({ input }: any) => {
				if (Array.isArray(input)) {
					return Promise.resolve({ data: [{ embedding: new Array(DIM).fill(0.1) }, { embedding: null }] });
				}
				return embedOk()({ input });
			});

			const result = await indexTask('t-batch-nullvec', '/p');

			expect(result.length).toBe(1); // only the valid vector became a point
		});
	});

	// ────────────────────────────────────────────────────────────────
	// embedSingle — legacy EMBEDDING_BATCH_SIZE<=1 path (L845-872, indexTask L1069-1076)
	// ────────────────────────────────────────────────────────────────
	describe('embedSingle (EMBEDDING_BATCH_SIZE=1 legacy path)', () => {
		const prev = process.env.EMBEDDING_BATCH_SIZE;
		beforeEach(() => { process.env.EMBEDDING_BATCH_SIZE = '1'; });
		afterEach(() => { if (prev === undefined) delete process.env.EMBEDDING_BATCH_SIZE; else process.env.EMBEDDING_BATCH_SIZE = prev; });

		test('embeds each chunk individually and indexes it (L852-871 + indexTask L1069-1076)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			mockExtractTask.mockResolvedValue([chunk('single-1', 'legacy single content')]);

			const result = await indexTask('t-single', '/p');

			expect(result.length).toBe(1);
			// legacy path calls embeddings.create with a string input (not an array)
			expect(mockEmbeddingsCreate).toHaveBeenCalledWith(expect.objectContaining({ input: 'legacy single content' }));
		});

		test('returns null (skips point) when the embedding has the wrong dimension (L863-867)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			mockExtractTask.mockResolvedValue([chunk('single-wd', 'legacy wrong dim')]);
			mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: new Array(7).fill(0.1) }] });

			const result = await indexTask('t-single-wrongdim', '/p');

			expect(result).toEqual([]); // wrong dim → null → no point built
			expect(mockUpsert).not.toHaveBeenCalled();
		});

		test('returns null when the embedding is not an array (L859-862)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			mockExtractTask.mockResolvedValue([chunk('single-nan', 'legacy not array')]);
			mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: null }] });

			const result = await indexTask('t-single-notarray', '/p');

			expect(result).toEqual([]);
		});
	});

	// ────────────────────────────────────────────────────────────────
	// indexTask — remaining branches
	// ────────────────────────────────────────────────────────────────
	describe('indexTask branches', () => {
		test('serves the second identical index from the embedding cache (L1050-1052)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			const content = 'cache-hit-content';
			mockExtractTask.mockResolvedValue([chunk('cache-1', content)]);

			await indexTask('t-cache-1', '/p');           // 1st: embeds + caches
			mockEmbeddingsCreate.mockClear();
			const result = await indexTask('t-cache-2', '/p'); // 2nd: same content → cache hit

			expect(result.length).toBe(1);
			expect(mockEmbeddingsCreate).not.toHaveBeenCalled(); // served from cache, no API call
		});

		test('dispatches to the claude-code chunk extractor when source=claude-code (L976)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			mockExtractClaude.mockResolvedValue([chunk('cc-1', 'claude session content')]);

			const result = await indexTask('t-claude', '/p', 'claude-code', { workspace: 'ws' });

			expect(mockExtractClaude).toHaveBeenCalledWith('t-claude', '/p', { workspace: 'ws' });
			expect(mockExtractTask).not.toHaveBeenCalled();
			expect(result.length).toBe(1);
		});

		test('truncates chunks exceeding MAX_CHUNKS_PER_TASK (L986-989)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			// MAX_CHUNKS_PER_TASK mocked to 3 → 5 chunks truncated to 3.
			mockExtractTask.mockResolvedValue([
				chunk('t1', 'c1'), chunk('t2', 'c2'), chunk('t3', 'c3'), chunk('t4', 'c4'), chunk('t5', 'c5'),
			]);

			const result = await indexTask('t-truncate', '/p');

			expect(result.length).toBe(3); // only the first 3 chunks were indexed
		});

		test('skips sub-chunks with empty/whitespace content (L998)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			mockExtractTask.mockResolvedValue([chunk('empty-1', 'whatever')]);
			mockSplitChunk.mockReturnValue([
				chunk('sub-empty', '   '),          // whitespace only → skipped
				chunk('sub-real', 'real content'),  // kept
			]);

			const result = await indexTask('t-empty-subchunk', '/p');

			expect(result.length).toBe(1); // only the non-empty sub-chunk indexed
		});

		test('skips chunks that are not marked indexed (L995 false arm)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			mockExtractTask.mockResolvedValue([chunk('noindex', 'not indexed', /* indexed */ false)]);

			const result = await indexTask('t-noindex', '/p');

			expect(result).toEqual([]);
			expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
		});

		test('throws NETWORK_ERROR when the upsert ultimately fails (L1126-1134)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			mockExtractTask.mockResolvedValue([chunk('fail-upsert', 'content that fails upsert')]);
			// HTTP 400 makes safeQdrantUpsert return false without retry (permanent error, no breaker trip).
			mockUpsert.mockRejectedValue(Object.assign(new Error('Bad Request'), { response: { status: 400, data: {} } }));

			await expect(indexTask('t-upsert-fail', '/p')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
		});

		test('wraps a non-Error thrown during extraction (String(error) arms L1160-1163)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			mockExtractTask.mockRejectedValue('plain string failure'); // non-Error throw

			await expect(indexTask('t-nonerror', '/p')).rejects.toMatchObject({
				code: 'NETWORK_ERROR',
				message: expect.stringContaining('plain string failure'),
			});
		});
	});

	// ────────────────────────────────────────────────────────────────
	// preflightDedupByChunkId — edge cases (L648-731)
	// ────────────────────────────────────────────────────────────────
	describe('preflightDedupByChunkId edge cases', () => {
		test('skips preflight for very large collections (>5M points, L659-663)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			mockCount.mockResolvedValue({ count: 6_000_000 }); // > 5M → preflight skipped
			mockExtractTask.mockResolvedValue([chunk('big-coll', 'big collection content')]);

			const result = await indexTask('t-bigcoll', '/p');

			expect(mockRetrieve).not.toHaveBeenCalled(); // preflight retrieve bypassed
			expect(result.length).toBe(1);               // still indexed (post-index dedup only)
		});

		test('treats a retrieve timeout as non-fatal and proceeds to embed (L695-699)', async () => {
			vi.resetModules();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			mockExtractTask.mockResolvedValue([chunk('rt', 'retrieve timeout content')]);
			mockRetrieve.mockRejectedValue(new Error('Preflight retrieve timeout after 5000ms'));

			const result = await indexTask('t-retrieve-timeout', '/p');

			// timeout ≠ unreachable → qdrantReachable stays true → embedding proceeds → indexed
			expect(result.length).toBe(1);
			expect(mockEmbeddingsCreate).toHaveBeenCalled();
		});
	});

	// ────────────────────────────────────────────────────────────────
	// safeQdrantUpsert — internal branches
	// ────────────────────────────────────────────────────────────────
	describe('safeQdrantUpsert internals', () => {
		function point(id = 'p'): any {
			return { id, vector: new Array(DIM).fill(0.1), payload: { task_id: id, content: 'x' } };
		}

		test('rethrows when vector validation fails (L389-392)', async () => {
			vi.resetModules();
			const { safeQdrantUpsert, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			mockValidateVector.mockImplementation(() => { throw new Error('invalid vector'); });

			await expect(safeQdrantUpsert([point()])).rejects.toThrow('invalid vector');
			expect(mockUpsert).not.toHaveBeenCalled();
		});

		test('logs cleaned payload fields when sanitize removes keys (L395-398)', async () => {
			vi.resetModules();
			const { safeQdrantUpsert, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			// original payload has 3 keys, sanitize returns 1 → payloadChanges > 0.
			mockSanitizePayload.mockImplementation(() => ({ task_id: 'p' }));
			const p = { id: 'p', vector: new Array(DIM).fill(0.1), payload: { task_id: 'p', a: 1, b: 2 } };

			const result = await safeQdrantUpsert([p as any]);

			expect(result).toBe(true);
			expect(mockUpsert).toHaveBeenCalled();
		});

		test('logs verbose sample diagnostics when QDRANT_VERBOSE=true (L443-448)', async () => {
			const prev = process.env.QDRANT_VERBOSE;
			process.env.QDRANT_VERBOSE = 'true';
			try {
				vi.resetModules();
				const { safeQdrantUpsert, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
				resetCircuitBreakerForTest();
				const result = await safeQdrantUpsert([point('verbose')]);
				expect(result).toBe(true);
				expect(mockUpsert).toHaveBeenCalled();
			} finally {
				if (prev === undefined) delete process.env.QDRANT_VERBOSE; else process.env.QDRANT_VERBOSE = prev;
			}
		});

		test('returns false on an HTTP 400 that lacks error.response (L482 status arm + L496-499)', async () => {
			vi.resetModules();
			const { safeQdrantUpsert, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			// 400 signalled via error.status (not error.response.status) → the `|| error?.status===400`
			// right-arm at L482, and the no-response else branch at L496-499.
			mockUpsert.mockRejectedValue(Object.assign(new Error('Bad Request'), { status: 400 }));

			const result = await safeQdrantUpsert([{ id: 'p', vector: new Array(DIM).fill(0.1), payload: { task_id: 'p' } } as any]);

			expect(result).toBe(false);
		});
	});

	describe('safeQdrantUpsert batching (INDEXING_BATCH_SIZE=1)', () => {
		const prev = process.env.INDEXING_BATCH_SIZE;
		beforeEach(() => { process.env.INDEXING_BATCH_SIZE = '1'; });
		afterEach(() => { if (prev === undefined) delete process.env.INDEXING_BATCH_SIZE; else process.env.INDEXING_BATCH_SIZE = prev; });

		test('splits into multiple batches and pauses between them (L421-423, L530-532)', async () => {
			vi.resetModules();
			const { safeQdrantUpsert, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			const points = [
				{ id: 'a', vector: new Array(DIM).fill(0.1), payload: { task_id: 'a' } },
				{ id: 'b', vector: new Array(DIM).fill(0.1), payload: { task_id: 'b' } },
			];

			const result = await safeQdrantUpsert(points as any);

			expect(result).toBe(true);
			expect(mockUpsert).toHaveBeenCalledTimes(2); // one upsert per single-point batch
		}, 15000);
	});

	// ────────────────────────────────────────────────────────────────
	// upsertPointsBatch — validation throw (L1294-1302)
	// ────────────────────────────────────────────────────────────────
	describe('upsertPointsBatch validation', () => {
		test('propagates a vector-validation failure without retrying (L1298-1301)', async () => {
			vi.resetModules();
			const { upsertPointsBatch } = await import('../VectorIndexer.js');
			mockValidateVector.mockImplementation(() => { throw new Error('bad batch vector'); });

			await expect(
				upsertPointsBatch([{ id: 'a', vector: new Array(DIM).fill(0.1), payload: {} }], { maxRetries: 1 }),
			).rejects.toThrow('bad batch vector');
		});
	});

	// ────────────────────────────────────────────────────────────────
	// cleanupOldVectors — loop termination + workspace-filtered logs
	// ────────────────────────────────────────────────────────────────
	describe('cleanupOldVectors', () => {
		test('terminates the delete loop when a scroll batch is empty (L1421-1424)', async () => {
			vi.resetModules();
			const { cleanupOldVectors } = await import('../VectorIndexer.js');
			mockCount.mockResolvedValue({ count: 5 });                 // candidates exist → enters loop
			mockScroll.mockResolvedValue({ points: [], next_page_offset: null }); // but scroll returns none

			const result = await cleanupOldVectors(90, false);

			expect(result.deletedCount).toBe(0);
			expect(mockDelete).not.toHaveBeenCalled();
		});

		test('renders the workspace filter in the dry-run log (L1397 workspace arm)', async () => {
			vi.resetModules();
			const { cleanupOldVectors } = await import('../VectorIndexer.js');
			mockCount.mockResolvedValue({ count: 4 });

			const result = await cleanupOldVectors(30, true, 'proj-ws');

			expect(result.deletedCount).toBe(4);
			expect(result.workspaceFilter).toBe('proj-ws');
			expect(mockDelete).not.toHaveBeenCalled();
		});

		test('renders the workspace filter in the completion log after a live delete (L1448 workspace arm)', async () => {
			vi.resetModules();
			const { cleanupOldVectors } = await import('../VectorIndexer.js');
			mockCount.mockResolvedValue({ count: 2 });
			mockScroll.mockResolvedValue({ points: [{ id: 'p1' }, { id: 'p2' }], next_page_offset: null });

			const result = await cleanupOldVectors(90, false, 'proj-ws');

			expect(result.deletedCount).toBe(2);
			expect(result.workspaceFilter).toBe('proj-ws');
			expect(mockDelete).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ points: ['p1', 'p2'], wait: true }),
			);
		});
	});
});
