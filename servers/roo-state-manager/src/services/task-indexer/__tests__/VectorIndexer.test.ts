/**
 * Tests for VectorIndexer.ts
 * Issue #492 - Coverage for QdrantRateLimiter, retryWithBackoff, circuit breaker, ensureCollectionExists
 *
 * @module services/task-indexer/__tests__/VectorIndexer
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';

// Hoisted mock declarations (accessible in vi.mock factories)
const { mockGetCollections, mockCreateCollection, mockCreatePayloadIndex, mockUpsert, mockDeleteCollection, mockCount, mockRetrieve, mockScroll } = vi.hoisted(() => ({
	mockGetCollections: vi.fn(),
	mockCreateCollection: vi.fn(),
	mockCreatePayloadIndex: vi.fn(),
	mockUpsert: vi.fn(),
	mockDeleteCollection: vi.fn(),
	mockCount: vi.fn(),
	mockRetrieve: vi.fn(),
	mockScroll: vi.fn()
}));

const { mockEmbeddingsCreate } = vi.hoisted(() => ({
	mockEmbeddingsCreate: vi.fn().mockResolvedValue({
		data: [{ embedding: new Array(1536).fill(0.1) }],
		model: 'text-embedding-3-small',
		usage: { prompt_tokens: 10, total_tokens: 10 }
	})
}));

/** Re-apply embeddings mock after vi.clearAllMocks() resets return values */
function setupEmbeddingMock() {
	mockEmbeddingsCreate.mockResolvedValue({
		data: [{ embedding: new Array(1536).fill(0.1) }],
		model: 'text-embedding-3-small',
		usage: { prompt_tokens: 10, total_tokens: 10 }
	});
	mockUpsert.mockResolvedValue(undefined);
}

// Mock external dependencies
vi.mock('../../qdrant.js', () => ({
	getQdrantClient: vi.fn(() => ({
		getCollections: mockGetCollections,
		createCollection: mockCreateCollection,
		createPayloadIndex: mockCreatePayloadIndex,
		upsert: mockUpsert,
		deleteCollection: mockDeleteCollection,
		count: mockCount,
		retrieve: mockRetrieve,
		scroll: mockScroll
	}))
}));

vi.mock('../../openai.js', () => ({
	default: vi.fn(() => ({
		embeddings: { create: mockEmbeddingsCreate }
	})),
	getEmbeddingModel: vi.fn(() => 'text-embedding-3-small'),
	getEmbeddingDimensions: vi.fn(() => 1536)
}));

vi.mock('../EmbeddingValidator.js', () => ({
	validateVectorGlobal: vi.fn(),
	sanitizePayload: vi.fn((p: any) => p || {})
}));

vi.mock('../ChunkExtractor.js', () => ({
	extractChunksFromTask: vi.fn().mockResolvedValue([]),
	splitChunk: vi.fn((chunk: any) => [chunk]),
	MAX_CHUNKS_PER_TASK: 5000,
	computeChunkId: vi.fn(() => 'mock-deterministic-uuid')
}));

vi.mock('../QdrantHealthMonitor.js', () => ({
	networkMetrics: { qdrantCalls: 0, bytesTransferred: 0 }
}));

describe('VectorIndexer', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// ============================================================
	// QdrantRateLimiter
	// ============================================================

	describe('QdrantRateLimiter', () => {
		test('executes a single async function', async () => {
			const { QdrantRateLimiter } = await import('../VectorIndexer.js');
			const limiter = new QdrantRateLimiter();

			const result = await limiter.execute(async () => 42);
			expect(result).toBe(42);
		});

		test('queues multiple operations sequentially', async () => {
			vi.useRealTimers();
			const { QdrantRateLimiter } = await import('../VectorIndexer.js');
			const limiter = new QdrantRateLimiter();
			const order: number[] = [];

			const p1 = limiter.execute(async () => { order.push(1); return 1; });
			const p2 = limiter.execute(async () => { order.push(2); return 2; });
			const p3 = limiter.execute(async () => { order.push(3); return 3; });

			const results = await Promise.all([p1, p2, p3]);

			expect(results).toEqual([1, 2, 3]);
			expect(order).toEqual([1, 2, 3]);
		});

		test('propagates errors from async function', async () => {
			const { QdrantRateLimiter } = await import('../VectorIndexer.js');
			const limiter = new QdrantRateLimiter();

			await expect(
				limiter.execute(async () => { throw new Error('test error'); })
			).rejects.toThrow('test error');
		});
	});

	// ============================================================
	// retryWithBackoff
	// ============================================================

	describe('retryWithBackoff', () => {
		test('succeeds on first attempt', async () => {
			vi.useRealTimers();
			const { retryWithBackoff } = await import('../VectorIndexer.js');

			const fn = vi.fn().mockResolvedValue('success');
			const result = await retryWithBackoff(fn, 'testOp', 3);

			expect(result).toBe('success');
			expect(fn).toHaveBeenCalledTimes(1);
		});

		test('retries on failure and succeeds eventually', async () => {
			vi.useRealTimers();
			const { retryWithBackoff } = await import('../VectorIndexer.js');

			const fn = vi.fn()
				.mockRejectedValueOnce(new Error('fail1'))
				.mockResolvedValue('ok');

			const result = await retryWithBackoff(fn, 'testOp', 3);
			expect(result).toBe('ok');
			expect(fn).toHaveBeenCalledTimes(2);
		});

		test('throws after max retries exhausted', async () => {
			vi.useRealTimers();
			const { retryWithBackoff } = await import('../VectorIndexer.js');

			const fn = vi.fn().mockRejectedValue(new Error('persistent failure'));

			await expect(retryWithBackoff(fn, 'testOp', 2)).rejects.toThrow('persistent failure');
			expect(fn).toHaveBeenCalledTimes(2);
		});

		test('uses default maxRetries of 3', async () => {
			vi.useRealTimers();
			const { retryWithBackoff } = await import('../VectorIndexer.js');

			const fn = vi.fn().mockRejectedValue(new Error('fail'));

			await expect(retryWithBackoff(fn, 'testOp')).rejects.toThrow('fail');
			expect(fn).toHaveBeenCalledTimes(3);
		});
	});

	// ============================================================
	// ensureCollectionExists
	// ============================================================

	describe('ensureCollectionExists', () => {
		test('does nothing if collection already exists', async () => {
			const { ensureCollectionExists } = await import('../VectorIndexer.js');
			const expectedCollection = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

			mockGetCollections.mockResolvedValue({
				collections: [{ name: expectedCollection }]
			});

			await ensureCollectionExists();
			expect(mockCreateCollection).not.toHaveBeenCalled();
		});

		test('creates collection if not found', async () => {
			const { ensureCollectionExists } = await import('../VectorIndexer.js');
			const expectedCollection = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

			mockGetCollections.mockResolvedValue({
				collections: [{ name: 'other_collection' }]
			});

			await ensureCollectionExists();
			expect(mockCreateCollection).toHaveBeenCalledWith(
				expectedCollection,
				expect.objectContaining({
					vectors: expect.objectContaining({
						size: 1536,
						distance: 'Cosine'
					})
				})
			);
			// #2700: payload index on task_id must be created alongside the collection
			expect(mockCreatePayloadIndex).toHaveBeenCalledWith(
				expectedCollection,
				expect.objectContaining({
					field_name: 'task_id',
					field_schema: 'keyword'
				})
			);
		});

		test('creates collection with correct hnsw config', async () => {
			const { ensureCollectionExists } = await import('../VectorIndexer.js');

			mockGetCollections.mockResolvedValue({ collections: [] });

			await ensureCollectionExists();
			expect(mockCreateCollection).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					hnsw_config: { max_indexing_threads: 2 }
				})
			);
		});

		test('throws on Qdrant connection error', async () => {
			const { ensureCollectionExists } = await import('../VectorIndexer.js');

			mockGetCollections.mockRejectedValue(new Error('Connection refused'));

			await expect(ensureCollectionExists()).rejects.toThrow('Connection refused');
		});
	});

	// ============================================================
	// safeQdrantUpsert
	// ============================================================

	describe('safeQdrantUpsert', () => {
		test('upserts points successfully', async () => {
			vi.useRealTimers();
			const { safeQdrantUpsert } = await import('../VectorIndexer.js');

			mockUpsert.mockResolvedValue(undefined);
			const vector = new Array(1536).fill(0.1);
			const points = [{
				id: 'test-id',
				vector,
				payload: { task_id: 'task-1', content: 'test' }
			}];

			const result = await safeQdrantUpsert(points);
			expect(result).toBe(true);
			expect(mockUpsert).toHaveBeenCalled();
		});

		test('returns false on HTTP 400 error without retry', async () => {
			vi.useRealTimers();
			// Need fresh module for circuit breaker state
			vi.resetModules();
			const { safeQdrantUpsert } = await import('../VectorIndexer.js');

			const error = Object.assign(new Error('Bad Request'), {
				response: { status: 400, statusText: 'Bad Request', data: {} }
			});
			mockUpsert.mockRejectedValue(error);
			const vector = new Array(1536).fill(0.1);

			const result = await safeQdrantUpsert([{
				id: 'test-id',
				vector,
				payload: { task_id: 'task-1' }
			}]);
			expect(result).toBe(false);
			// Should NOT retry on 400
			expect(mockUpsert).toHaveBeenCalledTimes(1);
		});
	});

	// ============================================================
	// resetCollection
	// ============================================================

	describe('resetCollection', () => {
		test('deletes and recreates collection', async () => {
			const { resetCollection } = await import('../VectorIndexer.js');
			const expectedCollection = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

			mockDeleteCollection.mockResolvedValue(undefined);
			mockCreateCollection.mockResolvedValue(undefined);

			await resetCollection();

			expect(mockDeleteCollection).toHaveBeenCalledWith(expectedCollection);
			expect(mockCreateCollection).toHaveBeenCalledWith(
				expectedCollection,
				expect.objectContaining({
					vectors: expect.objectContaining({
						size: 1536,
						distance: 'Cosine'
					})
				})
			);
			// #2700: recreated collection must also get the task_id payload index
			expect(mockCreatePayloadIndex).toHaveBeenCalledWith(
				expectedCollection,
				expect.objectContaining({
					field_name: 'task_id',
					field_schema: 'keyword'
				})
			);
		});

		test('recreates even if delete fails (collection did not exist)', async () => {
			const { resetCollection } = await import('../VectorIndexer.js');

			mockDeleteCollection.mockRejectedValue(new Error('Not found'));
			mockCreateCollection.mockResolvedValue(undefined);

			await resetCollection();
			expect(mockCreateCollection).toHaveBeenCalled();
		});

		test('throws if create fails after delete', async () => {
			const { resetCollection } = await import('../VectorIndexer.js');

			mockDeleteCollection.mockResolvedValue(undefined);
			mockCreateCollection.mockRejectedValue(new Error('Create failed'));

			await expect(resetCollection()).rejects.toThrow('Create failed');
		});
	});

	// ============================================================
	// countPointsByHostOs
	// ============================================================

	describe('countPointsByHostOs', () => {
		test('returns count for given hostOs', async () => {
			vi.useRealTimers();
			const { countPointsByHostOs } = await import('../VectorIndexer.js');

			mockCount.mockResolvedValue({ count: 42 });

			const result = await countPointsByHostOs('win32-x64-MYHOST');
			expect(result).toBe(42);
			const expectedCollection = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
			expect(mockCount).toHaveBeenCalledWith(
				expectedCollection,
				expect.objectContaining({
					filter: expect.objectContaining({
						must: expect.arrayContaining([
							expect.objectContaining({
								key: 'host_os',
								match: { value: 'win32-x64-MYHOST' }
							})
						])
					})
				})
			);
		});

		test('returns 0 on error', async () => {
			vi.useRealTimers();
			const { countPointsByHostOs } = await import('../VectorIndexer.js');

			mockCount.mockRejectedValue(new Error('Qdrant down'));

			const result = await countPointsByHostOs('test-os');
			expect(result).toBe(0);
		});
	});

	// ============================================================
	// indexTask
	// ============================================================

	describe('indexTask', () => {
		test('returns empty array when no chunks extracted', async () => {
			const { indexTask } = await import('../VectorIndexer.js');
			const { extractChunksFromTask } = await import('../ChunkExtractor.js');
			const expectedCollection = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

			// Restore the mock after clearAllMocks
			(extractChunksFromTask as any).mockResolvedValue([]);

			mockGetCollections.mockResolvedValue({
				collections: [{ name: expectedCollection }]
			});

			const result = await indexTask('task-123', '/fake/path');
			expect(result).toEqual([]);
		});

		test('propagates errors instead of swallowing them (#1273)', async () => {
			const { indexTask } = await import('../VectorIndexer.js');
			const { extractChunksFromTask } = await import('../ChunkExtractor.js');
			const expectedCollection = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

			mockGetCollections.mockResolvedValue({
				collections: [{ name: expectedCollection }]
			});

			// Simulate a real error from chunk extraction
			(extractChunksFromTask as any).mockRejectedValue(new Error('Qdrant connection refused'));

			await expect(indexTask('task-fail', '/fake/path')).rejects.toThrow('Qdrant connection refused');
		});
	});

	// ============================================================
	// updateSkeletonIndexTimestamp
	// ============================================================

	describe('updateSkeletonIndexTimestamp', () => {
		test('is an exported function', async () => {
			const mod = await import('../VectorIndexer.js');
			expect(typeof mod.updateSkeletonIndexTimestamp).toBe('function');
		});
	});

	// ============================================================
	// #2018 Phase 2 — preflightDedupByChunkId tests
	// ============================================================

	describe('#2018 Phase 2: preflightDedupByChunkId', () => {
		test('skips chunks that already exist with same contentHash', async () => {
			const { indexTask } = await import('../VectorIndexer.js');
			const { extractChunksFromTask } = await import('../ChunkExtractor.js');
			const { splitChunk } = await import('../ChunkExtractor.js');
			const expectedCollection = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

			const chunkContent = 'Hello world test content';
			const contentHash = crypto.createHash('sha256').update(chunkContent).digest('hex');
			const chunkId = 'test-chunk-id-1';

			(extractChunksFromTask as any).mockResolvedValue([{
				chunk_id: chunkId, content: chunkContent, indexed: true,
				sequence_order: 0, chunk_type: 'message_exchange', role: 'user',
				total_chunks: 1, chunk_index: 0
			}]);
			(splitChunk as any).mockImplementation((c: any) => [c]);

			mockGetCollections.mockResolvedValue({ collections: [{ name: expectedCollection }] });

			// Simulate: Qdrant retrieve finds the chunk already exists
			mockRetrieve.mockResolvedValue([{
				id: chunkId,
				payload: { contentHash }
			}]);

			const result = await indexTask('task-dedup-1', '/fake/path');

			// Should skip embedding entirely (no upsert needed)
			expect(mockUpsert).not.toHaveBeenCalled();
			expect(result).toEqual([]);
		});

		test('indexes chunks not present in Qdrant', async () => {
			vi.useRealTimers();
			const { indexTask } = await import('../VectorIndexer.js');
			const { extractChunksFromTask } = await import('../ChunkExtractor.js');
			const { splitChunk } = await import('../ChunkExtractor.js');
			const expectedCollection = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

			setupEmbeddingMock();

			(extractChunksFromTask as any).mockResolvedValue([{
				chunk_id: 'new-chunk-1', content: 'New content to index', indexed: true,
				sequence_order: 0, chunk_type: 'message_exchange', role: 'user',
				total_chunks: 1, chunk_index: 0
			}]);
			(splitChunk as any).mockImplementation((c: any) => [c]);

			mockGetCollections.mockResolvedValue({ collections: [{ name: expectedCollection }] });

			// Simulate: Qdrant retrieve finds nothing
			mockRetrieve.mockResolvedValue([]);

			const result = await indexTask('task-new-1', '/fake/path');

			expect(mockUpsert).toHaveBeenCalled();
			expect(result.length).toBeGreaterThan(0);
		});

		test('re-indexes chunks with changed contentHash (content edit)', async () => {
			vi.useRealTimers();
			const { indexTask } = await import('../VectorIndexer.js');
			const { extractChunksFromTask } = await import('../ChunkExtractor.js');
			const { splitChunk } = await import('../ChunkExtractor.js');
			const expectedCollection = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

			setupEmbeddingMock();

			(extractChunksFromTask as any).mockResolvedValue([{
				chunk_id: 'chunk-edit-1', content: 'Updated content after edit', indexed: true,
				sequence_order: 0, chunk_type: 'message_exchange', role: 'user',
				total_chunks: 1, chunk_index: 0
			}]);
			(splitChunk as any).mockImplementation((c: any) => [c]);

			mockGetCollections.mockResolvedValue({ collections: [{ name: expectedCollection }] });

			// Qdrant has old version with different contentHash
			mockRetrieve.mockResolvedValue([{
				id: 'chunk-edit-1',
				payload: { contentHash: 'old-hash-different-from-current' }
			}]);

			const result = await indexTask('task-edit-1', '/fake/path');

			expect(mockUpsert).toHaveBeenCalled();
		});

		test('#2165: backs off WITHOUT embedding when pre-flight dedup cannot reach Qdrant', async () => {
			vi.useRealTimers();
			const { indexTask, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			const { extractChunksFromTask } = await import('../ChunkExtractor.js');
			const { splitChunk } = await import('../ChunkExtractor.js');
			const expectedCollection = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

			resetCircuitBreakerForTest();
			setupEmbeddingMock();

			(extractChunksFromTask as any).mockResolvedValue([{
				chunk_id: 'chunk-fail-1', content: 'Content despite failure', indexed: true,
				sequence_order: 0, chunk_type: 'message_exchange', role: 'user',
				total_chunks: 1, chunk_index: 0
			}]);
			(splitChunk as any).mockImplementation((c: any) => [c]);

			mockGetCollections.mockResolvedValue({ collections: [{ name: expectedCollection }] });

			// Qdrant retrieve throws — pre-flight dedup cannot determine what is already indexed.
			mockRetrieve.mockRejectedValue(new Error('Network unreachable'));

			// #2165: Previously this fell through and re-embedded everything (the hammering bug).
			// Now it must throw a CIRCUIT_BREAKER_OPEN error and burn ZERO embeddings.
			await expect(indexTask('task-fail-1', '/fake/path')).rejects.toMatchObject({
				code: 'CIRCUIT_BREAKER_OPEN'
			});

			// The whole point of the fix: no embedding API call, no upsert.
			expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
			expect(mockUpsert).not.toHaveBeenCalled();
		});
	});

	// ============================================================
	// #2165 — Circuit breaker observability + pre-embedding short-circuit
	// ============================================================

	describe('#2165: circuit breaker observability', () => {
		test('getCircuitBreakerState exposes a readable snapshot', async () => {
			const { getCircuitBreakerState, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();

			const snap = getCircuitBreakerState();
			expect(snap.state).toBe('CLOSED');
			expect(snap.failureCount).toBe(0);
			expect(snap.msUntilHalfOpen).toBe(0);
		});

		test('isCircuitBreakerBlocking is false when CLOSED', async () => {
			const { isCircuitBreakerBlocking, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();
			expect(isCircuitBreakerBlocking()).toBe(false);
		});

		test('breaker opens after repeated upsert failures and then blocks', async () => {
			vi.useRealTimers();
			vi.resetModules();
			const { safeQdrantUpsert, isCircuitBreakerBlocking, getCircuitBreakerState, resetCircuitBreakerForTest } =
				await import('../VectorIndexer.js');
			resetCircuitBreakerForTest();

			const networkError = Object.assign(new Error('ECONNREFUSED'), {
				response: { status: 503, statusText: 'Service Unavailable', data: {} }
			});
			mockUpsert.mockRejectedValue(networkError);

			const points = [{ id: 'cb-test-1', vector: new Array(1536).fill(0.1), payload: { task_id: 't1' } }];

			// 3 failed attempts trip the breaker (MAX_RETRY_ATTEMPTS)
			await safeQdrantUpsert(points);
			await safeQdrantUpsert(points);
			await safeQdrantUpsert(points);

			const snap = getCircuitBreakerState();
			expect(snap.state).toBe('OPEN');
			expect(isCircuitBreakerBlocking()).toBe(true);
			expect(snap.msUntilHalfOpen).toBeGreaterThan(0);
		}, 30000);

		test('#2165: indexTask short-circuits BEFORE embedding when breaker is OPEN', async () => {
			vi.useRealTimers();
			vi.resetModules();
			const { indexTask, safeQdrantUpsert, resetCircuitBreakerForTest } = await import('../VectorIndexer.js');
			const { extractChunksFromTask, splitChunk } = await import('../ChunkExtractor.js');
			const expectedCollection = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

			resetCircuitBreakerForTest();
			setupEmbeddingMock();
			mockGetCollections.mockResolvedValue({ collections: [{ name: expectedCollection }] });

			// Trip the breaker via 3 failed upserts.
			const netErr = Object.assign(new Error('ECONNREFUSED'), {
				response: { status: 503, statusText: 'Service Unavailable', data: {} }
			});
			mockUpsert.mockRejectedValue(netErr);
			const pts = [{ id: 'cb-x', vector: new Array(1536).fill(0.1), payload: { task_id: 'tx' } }];
			await safeQdrantUpsert(pts);
			await safeQdrantUpsert(pts);
			await safeQdrantUpsert(pts);

			// Now the breaker is OPEN. indexTask must NOT extract/embed anything.
			mockEmbeddingsCreate.mockClear();
			(extractChunksFromTask as any).mockResolvedValue([{
				chunk_id: 'c1', content: 'should never be embedded', indexed: true,
				sequence_order: 0, chunk_type: 'message_exchange', role: 'user',
				total_chunks: 1, chunk_index: 0
			}]);
			(splitChunk as any).mockImplementation((c: any) => [c]);

			await expect(indexTask('task-breaker-open', '/fake/path')).rejects.toMatchObject({
				code: 'CIRCUIT_BREAKER_OPEN'
			});

			// Zero GPU burned — this is the core #2165 fix.
			expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
			// And it bailed before even touching the chunk extractor.
			expect(extractChunksFromTask).not.toHaveBeenCalled();
		}, 30000);
	});
});
