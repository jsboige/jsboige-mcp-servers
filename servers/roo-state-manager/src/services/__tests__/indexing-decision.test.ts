/**
 * Tests unitaires pour IndexingDecisionService
 *
 * Couvre :
 * - shouldIndex : toutes les branches de décision
 * - Force mode, migration d'index, échecs permanents, retry backoff
 * - TTL actif, contenu inchangé, legacy migration
 * - markIndexingSuccess / markIndexingFailure
 * - resetIndexingState / migrateLegacyIndexingState
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IndexingDecisionService } from '../indexing-decision.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

function createSkeleton(overrides?: Partial<ConversationSkeleton>): ConversationSkeleton {
  return {
    taskId: 'test-task-001',
    metadata: {
      title: 'Test',
      lastActivity: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      messageCount: 5,
      actionCount: 2,
      totalSize: 1024,
    },
    sequence: [],
    ...overrides,
  };
}

describe('IndexingDecisionService', () => {
  let service: IndexingDecisionService;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env = { ...originalEnv };
    delete process.env.ROO_INDEX_FORCE;
    delete process.env.ROO_INDEX_VERSION;
    service = new IndexingDecisionService();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  // === shouldIndex ===

  describe('shouldIndex', () => {
    it('should index new tasks without indexing state', () => {
      const skeleton = createSkeleton();
      const decision = service.shouldIndex(skeleton);

      expect(decision.shouldIndex).toBe(true);
      expect(decision.action).toBe('index');
      expect(decision.reason).toContain('Première indexation');
    });

    it('should force reindex when ROO_INDEX_FORCE is set', () => {
      process.env.ROO_INDEX_FORCE = '1';
      const forceService = new IndexingDecisionService();

      const skeleton = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          indexingState: { indexStatus: 'success', lastIndexedAt: new Date().toISOString() },
        },
      });

      const decision = forceService.shouldIndex(skeleton);

      expect(decision.shouldIndex).toBe(true);
      expect(decision.reason).toContain('FORCE_REINDEX');
    });

    it('should reindex on version migration', () => {
      const skeleton = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          indexingState: { indexVersion: '0.9', indexStatus: 'success' },
        },
      });

      const decision = service.shouldIndex(skeleton);

      expect(decision.shouldIndex).toBe(true);
      expect(decision.reason).toContain('Migration');
    });

    it('should skip failed tasks', () => {
      const skeleton = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          indexingState: { indexStatus: 'failed', indexError: 'permission denied' },
        },
      });

      const decision = service.shouldIndex(skeleton);

      expect(decision.shouldIndex).toBe(false);
      expect(decision.action).toBe('skip');
      expect(decision.reason).toContain('permanent');
    });

    it('should skip when max retry attempts reached', () => {
      const skeleton = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          indexingState: { indexStatus: 'retry', indexRetryCount: 3 },
        },
      });

      const decision = service.shouldIndex(skeleton);

      expect(decision.shouldIndex).toBe(false);
      expect(decision.reason).toContain('Maximum');
    });

    it('should skip during backoff period', () => {
      const recentAttempt = new Date().toISOString();
      const skeleton = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          indexingState: {
            indexStatus: 'retry',
            indexRetryCount: 1,
            lastIndexAttempt: recentAttempt,
          },
        },
      });

      const decision = service.shouldIndex(skeleton);

      expect(decision.shouldIndex).toBe(false);
      expect(decision.reason).toContain('Backoff');
    });

    it('should retry after backoff expires', () => {
      const pastAttempt = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(); // 10 hours ago
      const skeleton = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          indexingState: {
            indexStatus: 'retry',
            indexRetryCount: 0,
            lastIndexAttempt: pastAttempt,
          },
        },
      });

      const decision = service.shouldIndex(skeleton);

      expect(decision.shouldIndex).toBe(true);
      expect(decision.action).toBe('retry');
    });

    it('should skip when TTL is active', () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const skeleton = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          indexingState: {
            indexStatus: 'success',
            nextReindexAfter: futureDate,
          },
        },
      });

      const decision = service.shouldIndex(skeleton);

      expect(decision.shouldIndex).toBe(false);
      expect(decision.reason).toContain('TTL');
    });

    it('should skip when content unchanged since last index', () => {
      const lastActivity = '2026-02-01T10:00:00Z';
      const indexedLater = '2026-02-05T10:00:00Z';

      const skeleton = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          lastActivity,
          indexingState: {
            indexStatus: 'success',
            lastIndexedAt: indexedLater,
          },
        },
      });

      const decision = service.shouldIndex(skeleton);

      expect(decision.shouldIndex).toBe(false);
      expect(decision.reason).toContain('inchangé');
    });

    it('should handle legacy qdrantIndexedAt migration', () => {
      const skeleton = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          lastActivity: '2026-01-01T10:00:00Z',
          qdrantIndexedAt: '2026-02-01T10:00:00Z',
        },
      });

      const decision = service.shouldIndex(skeleton);

      expect(decision.shouldIndex).toBe(false);
      expect(decision.reason).toContain('legacy');
      expect(decision.requiresSave).toBe(true);
    });

    it('should index when content modified after success', () => {
      const skeleton = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          lastActivity: '2026-02-10T12:00:00Z',
          indexingState: {
            indexStatus: 'success',
            lastIndexedAt: '2026-02-01T10:00:00Z',
            // No nextReindexAfter or expired
          },
        },
      });

      const decision = service.shouldIndex(skeleton);

      expect(decision.shouldIndex).toBe(true);
      expect(decision.reason).toContain('modifié');
    });
  });

  // === markIndexingSuccess ===

  describe('markIndexingSuccess', () => {
    it('should set status to success', () => {
      const skeleton = createSkeleton();
      service.markIndexingSuccess(skeleton);

      expect(skeleton.metadata.indexingState).toBeDefined();
      expect(skeleton.metadata.indexingState!.indexStatus).toBe('success');
      expect(skeleton.metadata.indexingState!.lastIndexedAt).toBeDefined();
      expect(skeleton.metadata.indexingState!.nextReindexAfter).toBeDefined();
    });

    it('should clear error fields', () => {
      const skeleton = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          indexingState: {
            indexStatus: 'retry',
            indexError: 'some error',
            indexRetryCount: 2,
          },
        },
      });

      service.markIndexingSuccess(skeleton);

      expect(skeleton.metadata.indexingState!.indexError).toBeUndefined();
      expect(skeleton.metadata.indexingState!.indexRetryCount).toBeUndefined();
    });

    it('should remove legacy qdrantIndexedAt', () => {
      const skeleton = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          qdrantIndexedAt: '2026-01-01T00:00:00Z',
        },
      });

      service.markIndexingSuccess(skeleton);

      expect(skeleton.metadata.qdrantIndexedAt).toBeUndefined();
    });
  });

  // === markIndexingFailure ===

  describe('markIndexingFailure', () => {
    it('should set status to retry for temporary failures', () => {
      const skeleton = createSkeleton();
      service.markIndexingFailure(skeleton, 'timeout error', false);

      expect(skeleton.metadata.indexingState!.indexStatus).toBe('retry');
      expect(skeleton.metadata.indexingState!.indexError).toBe('timeout error');
      expect(skeleton.metadata.indexingState!.indexRetryCount).toBe(1);
    });

    it('should set status to failed for permanent failures', () => {
      const skeleton = createSkeleton();
      service.markIndexingFailure(skeleton, 'file not found', true);

      expect(skeleton.metadata.indexingState!.indexStatus).toBe('failed');
    });

    it('should set status to failed when max retries reached', () => {
      const skeleton = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          indexingState: { indexRetryCount: 2 },
        },
      });

      // MAX_RETRY_ATTEMPTS = 3, so retryCount=2 + 1 = 3 >= 3-1+1
      service.markIndexingFailure(skeleton, 'still failing', false);

      expect(skeleton.metadata.indexingState!.indexStatus).toBe('failed');
    });

    it('should increment retry count', () => {
      const skeleton = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          indexingState: { indexRetryCount: 0 },
        },
      });

      service.markIndexingFailure(skeleton, 'error 1', false);
      expect(skeleton.metadata.indexingState!.indexRetryCount).toBe(1);

      service.markIndexingFailure(skeleton, 'error 2', false);
      expect(skeleton.metadata.indexingState!.indexRetryCount).toBe(2);
    });
  });

  // === resetIndexingState ===

  describe('resetIndexingState', () => {
    it('should reset indexing state', () => {
      const skeleton = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          indexingState: {
            indexStatus: 'success',
            lastIndexedAt: '2026-01-01T00:00:00Z',
            indexRetryCount: 3,
          },
        },
      });

      service.resetIndexingState(skeleton);

      expect(skeleton.metadata.indexingState!.indexStatus).toBeUndefined();
      expect(skeleton.metadata.indexingState!.lastIndexedAt).toBeUndefined();
      expect(skeleton.metadata.indexingState!.indexVersion).toBeDefined();
    });

    it('should clean legacy qdrantIndexedAt', () => {
      const skeleton = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          indexingState: { indexStatus: 'success' },
          qdrantIndexedAt: '2026-01-01T00:00:00Z',
        },
      });

      service.resetIndexingState(skeleton);

      expect(skeleton.metadata.qdrantIndexedAt).toBeUndefined();
    });

    it('should do nothing if no indexing state', () => {
      const skeleton = createSkeleton();
      // No indexingState set
      service.resetIndexingState(skeleton);

      // Should not throw or create state
      expect(skeleton.metadata.indexingState).toBeUndefined();
    });
  });

  // === migrateLegacyIndexingState ===

  describe('migrateLegacyIndexingState', () => {
    it('should migrate from qdrantIndexedAt to new format', () => {
      const legacyDate = '2026-01-15T10:00:00Z';
      const skeleton = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          qdrantIndexedAt: legacyDate,
        },
      });

      const migrated = service.migrateLegacyIndexingState(skeleton);

      expect(migrated).toBe(true);
      expect(skeleton.metadata.indexingState).toBeDefined();
      expect(skeleton.metadata.indexingState!.lastIndexedAt).toBe(legacyDate);
      expect(skeleton.metadata.indexingState!.indexStatus).toBe('success');
      expect(skeleton.metadata.qdrantIndexedAt).toBeUndefined();
    });

    it('should not migrate if already has indexing state', () => {
      const skeleton = createSkeleton({
        metadata: {
          ...createSkeleton().metadata,
          indexingState: { indexStatus: 'success' },
          qdrantIndexedAt: '2026-01-01T00:00:00Z',
        },
      });

      const migrated = service.migrateLegacyIndexingState(skeleton);
      expect(migrated).toBe(false);
    });

    it('should not migrate if no legacy field', () => {
      const skeleton = createSkeleton();
      const migrated = service.migrateLegacyIndexingState(skeleton);
      expect(migrated).toBe(false);
    });
  });
});
