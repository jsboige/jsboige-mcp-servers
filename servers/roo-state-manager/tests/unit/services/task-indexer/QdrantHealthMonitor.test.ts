import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QdrantHealthMonitor, networkMetrics, logNetworkMetrics } from '../../../../src/services/task-indexer/QdrantHealthMonitor.js';
import { getQdrantClient } from '../../../../src/services/qdrant.js';

// Mock qdrant client
vi.mock('../../../../src/services/qdrant.js', () => ({
  getQdrantClient: vi.fn()
}));

describe('QdrantHealthMonitor', () => {
  let monitor: QdrantHealthMonitor;
  let mockQdrantClient: any;

  beforeEach(() => {
    mockQdrantClient = {
      getCollection: vi.fn(),
      getCollections: vi.fn()
    };
    vi.mocked(getQdrantClient).mockReturnValue(mockQdrantClient);
    monitor = new QdrantHealthMonitor();
  });

  afterEach(() => {
    vi.clearAllMocks();
    monitor.stopHealthCheck();
  });

  describe('checkCollectionHealth', () => {
    it('should return metrics when collection is healthy', async () => {
      mockQdrantClient.getCollection.mockResolvedValue({
        status: 'green',
        points_count: 100,
        segments_count: 2,
        indexed_vectors_count: 100,
        optimizer_status: 'ok'
      });

      const metrics = await monitor.checkCollectionHealth();

      expect(metrics.status).toBe('green');
      expect(metrics.points_count).toBe(100);
    });

    it('should handle unhealthy collection', async () => {
      mockQdrantClient.getCollection.mockResolvedValue({
        status: 'red',
        points_count: 0,
        segments_count: 0,
        indexed_vectors_count: 0,
        optimizer_status: { error: 'failed' }
      });

      const metrics = await monitor.checkCollectionHealth();

      expect(metrics.status).toBe('red');
      expect(metrics.optimizer_status).toBe('failed');
    });

    it('should throw error if getCollection fails', async () => {
      mockQdrantClient.getCollection.mockRejectedValue(new Error('Connection failed'));

      await expect(monitor.checkCollectionHealth()).rejects.toThrow('Connection failed');
    });
  });

  describe('getCollectionStatus', () => {
    it('should return exists=true if collection exists', async () => {
      mockQdrantClient.getCollections.mockResolvedValue({
        collections: [{ name: 'roo_tasks_semantic_index' }]
      });
      mockQdrantClient.getCollection.mockResolvedValue({ points_count: 50 });

      const status = await monitor.getCollectionStatus();

      expect(status.exists).toBe(true);
      expect(status.count).toBe(50);
    });

    it('should return exists=false if collection does not exist', async () => {
      mockQdrantClient.getCollections.mockResolvedValue({
        collections: [{ name: 'other_collection' }]
      });

      const status = await monitor.getCollectionStatus();

      expect(status.exists).toBe(false);
      expect(status.count).toBe(0);
    });
  });

  describe('startHealthCheck / stopHealthCheck', () => {
    it('should start interval', () => {
      vi.useFakeTimers();
      const spy = vi.spyOn(global, 'setInterval');
      monitor.startHealthCheck();
      
      expect(spy).toHaveBeenCalled();
      
      vi.useRealTimers();
    });

    it('should stop interval', () => {
      vi.useFakeTimers();
      const spy = vi.spyOn(global, 'clearInterval');
      monitor.startHealthCheck();
      monitor.stopHealthCheck();
      
      expect(spy).toHaveBeenCalled();
      
      vi.useRealTimers();
    });
  });

  describe('networkMetrics', () => {
    it('should export networkMetrics object', () => {
      expect(networkMetrics).toBeDefined();
      expect(networkMetrics.qdrantCalls).toBe(0);
    });

    it('should log metrics', () => {
      const consoleSpy = vi.spyOn(console, 'log');
      logNetworkMetrics();
      expect(consoleSpy).toHaveBeenCalled();
    });
  });
});