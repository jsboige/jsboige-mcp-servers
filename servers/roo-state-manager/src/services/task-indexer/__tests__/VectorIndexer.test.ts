/**
 * Tests for VectorIndexer.ts
 * Issue #492 - Coverage for QdrantRateLimiter, retryWithBackoff, circuit breaker, ensureCollectionExists
 *
 * @module services/task-indexer/__tests__/VectorIndexer
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock external dependencies
const mockGetCollections = vi.fn();
const mockCreateCollection = vi.fn();
const mockUpsert = vi.fn();
const mockDeleteCollection = vi.fn();
const mockCount = vi.fn();

vi.mock('../../qdrant.js', () => ({
	getQdrantClient: vi.fn(() => ({
		getCollections: mockGetCollections,
		createCollection: mockCreateCollection,
		upsert: mockUpsert,
		deleteCollection: mockDeleteCollection,
		count: mockCount
	}))
}));

vi.mock('../../openai.js', () => ({
	default: vi.fn(),
	getEmbeddingModel: vi.fn(() => 'text-embedding-3-small'),
	getEmbeddingDimensions: vi.fn(() => 1536)
}));

vi.mock('../EmbeddingValidator.js', () => ({
	validateVectorGlobal: vi.fn(),
	sanitizePayload: vi.fn((p: any) => p || {})
}));

vi.mock('../ChunkExtractor.js', () => ({
	extractChunksFromTask: vi.fn().mockResolvedValue([]),
	splitChunk: vi.fn((chunk: any) => [chunk])
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
			const expectedCollection = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

			mockGetCollections.mockResolvedValue({
				collections: [{ name: expectedCollection }]
			});

			const result = await indexTask('task-123', '/fake/path');
			expect(result).toEqual([]);
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
});
