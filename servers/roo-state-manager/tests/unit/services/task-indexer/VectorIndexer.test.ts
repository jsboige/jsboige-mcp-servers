import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { indexTask, safeQdrantUpsert, QdrantRateLimiter, qdrantRateLimiter } from '../../../../src/services/task-indexer/VectorIndexer.js';
import { getQdrantClient } from '../../../../src/services/qdrant.js';
import getOpenAIClient from '../../../../src/services/openai.js';
import { extractChunksFromTask, splitChunk } from '../../../../src/services/task-indexer/ChunkExtractor.js';
import { validateVectorGlobal, sanitizePayload } from '../../../../src/services/task-indexer/EmbeddingValidator.js';

// Mock dependencies
vi.mock('../../../../src/services/qdrant.js', () => ({
  getQdrantClient: vi.fn()
}));

vi.mock('../../../../src/services/openai.js', () => ({
  default: vi.fn(),
  getEmbeddingModel: vi.fn(() => 'text-embedding-3-small'),
  getEmbeddingDimensions: vi.fn(() => 1536)
}));

vi.mock('../../../../src/services/task-indexer/ChunkExtractor.js', () => ({
  extractChunksFromTask: vi.fn(),
  splitChunk: vi.fn()
}));

vi.mock('../../../../src/services/task-indexer/EmbeddingValidator.js', () => ({
  validateVectorGlobal: vi.fn(),
  sanitizePayload: vi.fn((p) => p)
}));

describe('VectorIndexer', () => {
  let mockQdrantClient: any;
  let mockOpenAIClient: any;

  beforeEach(() => {
    mockQdrantClient = {
      getCollections: vi.fn(),
      createCollection: vi.fn(),
      upsert: vi.fn()
    };
    vi.mocked(getQdrantClient).mockReturnValue(mockQdrantClient);

    mockOpenAIClient = {
      embeddings: {
        create: vi.fn()
      }
    };
    vi.mocked(getOpenAIClient).mockReturnValue(mockOpenAIClient);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('QdrantRateLimiter', () => {
    it('should execute tasks sequentially with delay', async () => {
      const limiter = new QdrantRateLimiter();
      const start = Date.now();
      const task1 = vi.fn().mockResolvedValue(1);
      const task2 = vi.fn().mockResolvedValue(2);

      const p1 = limiter.execute(task1);
      const p2 = limiter.execute(task2);

      await Promise.all([p1, p2]);
      const end = Date.now();

      expect(task1).toHaveBeenCalled();
      expect(task2).toHaveBeenCalled();
      // Should be at least 100ms between tasks
      expect(end - start).toBeGreaterThanOrEqual(100);
    });
  });

  describe('safeQdrantUpsert', () => {
    it('should upsert points successfully', async () => {
      const points = [{ id: '1', vector: [0.1], payload: { a: 1 } }];
      mockQdrantClient.upsert.mockResolvedValue({});

      const result = await safeQdrantUpsert(points as any);

      expect(result).toBe(true);
      expect(mockQdrantClient.upsert).toHaveBeenCalled();
      expect(sanitizePayload).toHaveBeenCalled();
      expect(validateVectorGlobal).toHaveBeenCalled();
    });

    it('should handle empty points array', async () => {
      const result = await safeQdrantUpsert([]);
      expect(result).toBe(true);
      expect(mockQdrantClient.upsert).not.toHaveBeenCalled();
    });

    it('should retry on failure', async () => {
      const points = [{ id: '1', vector: [0.1], payload: { a: 1 } }];
      mockQdrantClient.upsert
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue({});

      const result = await safeQdrantUpsert(points as any);

      expect(result).toBe(true);
      expect(mockQdrantClient.upsert).toHaveBeenCalledTimes(2);
    });

    it('should not retry on 400 error', async () => {
      const points = [{ id: '1', vector: [0.1], payload: { a: 1 } }];
      const error: any = new Error('Bad Request');
      error.status = 400;
      mockQdrantClient.upsert.mockRejectedValue(error);

      const result = await safeQdrantUpsert(points as any);

      expect(result).toBe(false);
      expect(mockQdrantClient.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('indexTask', () => {
    it('should index task successfully', async () => {
      const taskId = 'task-1';
      const taskPath = '/path/to/task';
      const chunks = [{ chunk_id: 'c1', content: 'content', indexed: true }];
      const subChunks = [{ chunk_id: 'c1', content: 'content' }];

      vi.mocked(extractChunksFromTask).mockResolvedValue(chunks as any);
      vi.mocked(splitChunk).mockReturnValue(subChunks as any);
      mockQdrantClient.getCollections.mockResolvedValue({ collections: [{ name: 'roo_tasks_semantic_index' }] });
      mockOpenAIClient.embeddings.create.mockResolvedValue({ data: [{ embedding: [0.1] }] });
      mockQdrantClient.upsert.mockResolvedValue({});

      const result = await indexTask(taskId, taskPath);

      expect(result).toHaveLength(1);
      expect(extractChunksFromTask).toHaveBeenCalledWith(taskId, taskPath);
      expect(mockOpenAIClient.embeddings.create).toHaveBeenCalled();
      expect(mockQdrantClient.upsert).toHaveBeenCalled();
    });

    it('should skip indexing if no chunks found', async () => {
      vi.mocked(extractChunksFromTask).mockResolvedValue([]);
      mockQdrantClient.getCollections.mockResolvedValue({ collections: [{ name: 'roo_tasks_semantic_index' }] });

      const result = await indexTask('task-1', '/path');

      expect(result).toHaveLength(0);
      expect(mockOpenAIClient.embeddings.create).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(extractChunksFromTask).mockRejectedValue(new Error('Extraction failed'));

      const result = await indexTask('task-1', '/path');

      expect(result).toHaveLength(0);
    });
  });
});