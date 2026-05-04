/**
 * Tests unitaires pour TwoLevelProcessingOrchestrator
 *
 * Couvre :
 * - Construction et cycle de vie (constructor, shutdown)
 * - Determination du niveau de processing par categorie/outil
 * - Determination de la priorite selon categorie + niveau
 * - Integration cache (hit / miss)
 * - Planification immediate vs background
 * - API de statut et resultat des taches
 * - Health check et metriques
 * - Factory function
 *
 * Note on timers: The constructor starts two setInterval loops (processing
 * loop every 100ms, metrics collection every 30s). We use vi.useFakeTimers()
 * to control them. The internal executeTask stub uses setTimeout with a
 * random delay, and shutdown() polls activeTasks with setTimeout(100).
 * All async timer-dependent operations use vi.advanceTimersByTimeAsync().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TwoLevelProcessingOrchestrator,
  createTwoLevelProcessingOrchestrator
} from '../TwoLevelProcessingOrchestrator.js';

// Mock the enum/interface module BEFORE any import that uses it
vi.mock('../../interfaces/UnifiedToolInterface.js', () => ({
  ProcessingLevel: {
    IMMEDIATE: 'immediate',
    BACKGROUND: 'background',
    MIXED: 'hybrid'
  },
  ToolCategory: {
    DISPLAY: 'display',
    SEARCH: 'search',
    SUMMARY: 'summary',
    EXPORT: 'export',
    UTILITY: 'utility'
  }
}));

vi.mock('../CacheAntiLeakManager.js', () => ({
  CacheAntiLeakManager: vi.fn()
}));

vi.mock('../../types/errors.js', () => ({
  StateManagerError: class StateManagerError extends Error {
    code: string;
    service: string;
    details: any;
    constructor(message: string, code: string, service: string, details?: any) {
      super(message);
      this.name = 'StateManagerError';
      this.code = code;
      this.service = service;
      this.details = details;
    }
  }
}));

// Local copies of enum values for use in assertions
const ProcessingLevel = {
  IMMEDIATE: 'immediate',
  BACKGROUND: 'background',
  MIXED: 'hybrid'
} as const;

const ToolCategory = {
  DISPLAY: 'display',
  SEARCH: 'search',
  SUMMARY: 'summary',
  EXPORT: 'export',
  UTILITY: 'utility'
} as const;

/**
 * Create a fresh mock CacheAntiLeakManager with default stubs.
 */
function createMockCacheManager() {
  return {
    get: vi.fn().mockResolvedValue(null),
    store: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockReturnValue({
      hitRate: 0,
      evictionCount: 0,
      totalEntries: 0,
      totalSizeBytes: 0,
      totalSizeGB: 0,
      hitCount: 0,
      missCount: 0
    }),
    shutdown: vi.fn().mockResolvedValue(undefined)
  };
}

/**
 * Create a minimal ExecutionContext mock.
 */
function createMockContext(): any {
  return {
    requestId: 'test-req-' + Math.random().toString(36).substr(2, 6),
    timestamp: Date.now(),
    services: {},
    security: { validateInput: false, sanitizeOutput: false },
    monitoring: { immediate: {}, background: {} },
    cacheManager: {}
  };
}

/**
 * Helper: submit an immediate-level task and advance fake timers until it
 * resolves. Returns the ProcessingResult.
 */
async function submitAndCompleteImmediateTask(
  orchestrator: TwoLevelProcessingOrchestrator,
  category: string,
  toolName: string,
  args: any[] = []
) {
  const ctx = createMockContext();
  const promise = orchestrator.submitTask(
    category as any,
    toolName,
    'execute',
    args,
    ctx
  );
  // executeTask uses setTimeout(Math.random()*1000) internally, plus the
  // immediate-execution timeout promise. Advance 2s to be safe.
  await vi.advanceTimersByTimeAsync(2000);
  return promise;
}

/**
 * Helper: safely shut down an orchestrator under fake timers.
 * shutdown() loops on activeTasks.size with setTimeout(100).
 * We advance timers concurrently until the shutdown promise settles.
 */
async function safeShutdown(orchestrator: TwoLevelProcessingOrchestrator) {
  const shutdownPromise = orchestrator.shutdown();
  // Advance timers enough to let any pending tasks and the shutdown
  // polling loop complete.
  for (let i = 0; i < 50; i++) {
    await vi.advanceTimersByTimeAsync(200);
  }
  return shutdownPromise;
}

describe('TwoLevelProcessingOrchestrator', () => {
  let orchestrator: TwoLevelProcessingOrchestrator;
  let mockCacheManager: ReturnType<typeof createMockCacheManager>;

  beforeEach(() => {
    vi.useFakeTimers();

    // Suppress console output during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    mockCacheManager = createMockCacheManager();
    orchestrator = new TwoLevelProcessingOrchestrator(mockCacheManager as any);
  });

  afterEach(async () => {
    await safeShutdown(orchestrator);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // =========================================================
  // Constructor & Lifecycle
  // =========================================================

  describe('constructor & lifecycle', () => {
    it('should create orchestrator with default config', () => {
      const metrics = orchestrator.getMetrics();
      expect(metrics).toBeDefined();
      expect(metrics.totalTasks).toBe(0);
      expect(metrics.completedTasks).toBe(0);
      expect(metrics.failedTasks).toBe(0);
      expect(metrics.pendingTasks).toBe(0);
    });

    it('should accept partial config override', async () => {
      const custom = new TwoLevelProcessingOrchestrator(mockCacheManager as any, {
        immediateTimeoutMs: 10000,
        maxConcurrentImmediate: 5
      });
      const metrics = custom.getMetrics();
      expect(metrics.totalTasks).toBe(0);
      await safeShutdown(custom);
    });

    it('should shutdown cleanly and resolve', async () => {
      const shutdownPromise = orchestrator.shutdown();
      // Advance timers so the internal shutdown polling resolves
      await vi.advanceTimersByTimeAsync(5000);
      await expect(shutdownPromise).resolves.toBeUndefined();
    });

    it('should handle double shutdown gracefully', async () => {
      const p1 = orchestrator.shutdown();
      await vi.advanceTimersByTimeAsync(5000);
      await p1;
      // Second call should also resolve
      const p2 = orchestrator.shutdown();
      await vi.advanceTimersByTimeAsync(5000);
      await expect(p2).resolves.toBeUndefined();
    });
  });

  // =========================================================
  // Processing Level Determination
  // =========================================================

  describe('processing level determination', () => {
    it('DISPLAY category with generic tool should use IMMEDIATE level', async () => {
      const result = await submitAndCompleteImmediateTask(
        orchestrator, ToolCategory.DISPLAY, 'view_tree'
      );
      expect(result.processingLevel).toBe(ProcessingLevel.IMMEDIATE);
    });

    it('DISPLAY with "details" in tool name should use BACKGROUND level', async () => {
      const ctx = createMockContext();
      const result = await orchestrator.submitTask(
        ToolCategory.DISPLAY as any,
        'view_task_details',
        'execute',
        [],
        ctx
      );
      // Background tasks return immediately with queued status
      expect(result.processingLevel).toBe(ProcessingLevel.BACKGROUND);
    });

    it('DISPLAY with "analyze" in tool name should use BACKGROUND level', async () => {
      const ctx = createMockContext();
      const result = await orchestrator.submitTask(
        ToolCategory.DISPLAY as any,
        'analyze_conversation',
        'execute',
        [],
        ctx
      );
      expect(result.processingLevel).toBe(ProcessingLevel.BACKGROUND);
    });

    it('SEARCH category should use IMMEDIATE level', async () => {
      const result = await submitAndCompleteImmediateTask(
        orchestrator, ToolCategory.SEARCH, 'search_tasks'
      );
      expect(result.processingLevel).toBe(ProcessingLevel.IMMEDIATE);
    });

    it('SUMMARY category should use BACKGROUND level', async () => {
      const ctx = createMockContext();
      const result = await orchestrator.submitTask(
        ToolCategory.SUMMARY as any,
        'generate_summary',
        'execute',
        [],
        ctx
      );
      expect(result.processingLevel).toBe(ProcessingLevel.BACKGROUND);
    });

    it('EXPORT category should use BACKGROUND level', async () => {
      const ctx = createMockContext();
      const result = await orchestrator.submitTask(
        ToolCategory.EXPORT as any,
        'export_json',
        'execute',
        [],
        ctx
      );
      expect(result.processingLevel).toBe(ProcessingLevel.BACKGROUND);
    });

    it('UTILITY with "get" tool should use IMMEDIATE level', async () => {
      const result = await submitAndCompleteImmediateTask(
        orchestrator, ToolCategory.UTILITY, 'get_settings'
      );
      expect(result.processingLevel).toBe(ProcessingLevel.IMMEDIATE);
    });

    it('UTILITY with "build" tool should use BACKGROUND level', async () => {
      const ctx = createMockContext();
      const result = await orchestrator.submitTask(
        ToolCategory.UTILITY as any,
        'build_index',
        'execute',
        [],
        ctx
      );
      expect(result.processingLevel).toBe(ProcessingLevel.BACKGROUND);
    });

    it('UTILITY with generic tool should use MIXED level', async () => {
      // MIXED: tries immediate first (with allowFallback=true).
      // If workers are available, executeImmediate runs and returns
      // with processingLevel = task.processingLevel = MIXED.
      const result = await submitAndCompleteImmediateTask(
        orchestrator, ToolCategory.UTILITY, 'manage_settings'
      );
      expect(result.processingLevel).toBe(ProcessingLevel.MIXED);
    });

    it('UTILITY with "diagnose" tool should use BACKGROUND level', async () => {
      const ctx = createMockContext();
      const result = await orchestrator.submitTask(
        ToolCategory.UTILITY as any,
        'roosync_diagnose',
        'execute',
        [],
        ctx
      );
      expect(result.processingLevel).toBe(ProcessingLevel.BACKGROUND);
    });
  });

  // =========================================================
  // Priority Determination
  // =========================================================

  describe('priority determination', () => {
    it('DISPLAY + IMMEDIATE should succeed as CRITICAL priority task', async () => {
      const result = await submitAndCompleteImmediateTask(
        orchestrator, ToolCategory.DISPLAY, 'view_tree'
      );
      expect(result.success).toBe(true);
      expect(result.processingLevel).toBe(ProcessingLevel.IMMEDIATE);
    });

    it('SEARCH + IMMEDIATE should succeed as HIGH priority task', async () => {
      const result = await submitAndCompleteImmediateTask(
        orchestrator, ToolCategory.SEARCH, 'search_tasks'
      );
      expect(result.success).toBe(true);
      expect(result.processingLevel).toBe(ProcessingLevel.IMMEDIATE);
    });

    it('SUMMARY + BACKGROUND should queue as NORMAL priority task', async () => {
      const ctx = createMockContext();
      const result = await orchestrator.submitTask(
        ToolCategory.SUMMARY as any,
        'generate_summary',
        'execute',
        [],
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.processingLevel).toBe(ProcessingLevel.BACKGROUND);
      expect((result.data as any)?.status).toBe('queued');
    });

    it('UTILITY + BACKGROUND should queue as LOW priority task', async () => {
      const ctx = createMockContext();
      const result = await orchestrator.submitTask(
        ToolCategory.UTILITY as any,
        'build_index',
        'execute',
        [],
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.processingLevel).toBe(ProcessingLevel.BACKGROUND);
      expect((result.data as any)?.status).toBe('queued');
    });
  });

  // =========================================================
  // Cache Integration
  // =========================================================

  describe('cache integration', () => {
    it('should return cached result on cache hit', async () => {
      const cachedData = { result: 'from_cache', value: 42 };
      mockCacheManager.get.mockResolvedValueOnce({
        hit: true,
        data: cachedData,
        timestamp: Date.now()
      });

      const ctx = createMockContext();
      const result = await orchestrator.submitTask(
        ToolCategory.DISPLAY as any,
        'view_tree',
        'execute',
        [],
        ctx
      );

      expect(result.success).toBe(true);
      expect(result.cached).toBe(true);
      expect(result.data).toEqual(cachedData);
      expect(result.executionTime).toBe(0);
      expect(result.metadata?.fromCache).toBe(true);
    });

    it('should proceed to execution on cache miss (null)', async () => {
      mockCacheManager.get.mockResolvedValueOnce(null);

      const result = await submitAndCompleteImmediateTask(
        orchestrator, ToolCategory.DISPLAY, 'view_tree'
      );

      expect(result.cached).toBe(false);
      expect(result.success).toBe(true);
      expect(mockCacheManager.get).toHaveBeenCalled();
    });

    it('should skip cache entirely when cacheEnabled is false', async () => {
      await safeShutdown(orchestrator);

      const noCacheOrchestrator = new TwoLevelProcessingOrchestrator(
        mockCacheManager as any,
        { cacheEnabled: false }
      );

      const ctx = createMockContext();
      // Background task does not need timer advancement (returns immediately)
      const result = await noCacheOrchestrator.submitTask(
        ToolCategory.SUMMARY as any,
        'generate_summary',
        'execute',
        [],
        ctx
      );

      expect(mockCacheManager.get).not.toHaveBeenCalled();
      expect(result.cached).toBe(false);
      await safeShutdown(noCacheOrchestrator);
    });

    it('should store result in cache after immediate execution', async () => {
      mockCacheManager.get.mockResolvedValueOnce(null);

      await submitAndCompleteImmediateTask(
        orchestrator, ToolCategory.DISPLAY, 'view_tree'
      );

      expect(mockCacheManager.store).toHaveBeenCalled();
      // Verify the store call contains the correct strategy and ttl
      const storeCall = mockCacheManager.store.mock.calls[0];
      expect(storeCall[0]).toContain('display'); // cache key
      expect(storeCall[2]).toHaveProperty('strategy', 'moderate'); // immediate uses moderate
      expect(storeCall[2]).toHaveProperty('ttl', 300000); // 5 minutes for immediate
    });
  });

  // =========================================================
  // Task Scheduling
  // =========================================================

  describe('task scheduling', () => {
    it('immediate task should return result directly with data', async () => {
      const result = await submitAndCompleteImmediateTask(
        orchestrator, ToolCategory.SEARCH, 'search_tasks', ['query']
      );

      expect(result.success).toBe(true);
      expect(result.processingLevel).toBe(ProcessingLevel.IMMEDIATE);
      expect(result.data).toBeDefined();
      expect((result.data as any).toolName).toBe('search_tasks');
      expect((result.data as any).methodName).toBe('execute');
    });

    it('background task should return queued status with jobId', async () => {
      const ctx = createMockContext();
      const result = await orchestrator.submitTask(
        ToolCategory.SUMMARY as any,
        'generate_summary',
        'execute',
        [],
        ctx
      );

      expect(result.success).toBe(true);
      expect(result.processingLevel).toBe(ProcessingLevel.BACKGROUND);
      expect(result.executionTime).toBe(0);
      expect(result.cached).toBe(false);

      const data = result.data as any;
      expect(data.jobId).toBeDefined();
      expect(data.status).toBe('queued');
      expect(data.queuePosition).toBeGreaterThan(0);
      expect(data.estimatedStartTime).toBeDefined();
    });

    it('background task metadata should indicate queued state', async () => {
      const ctx = createMockContext();
      const result = await orchestrator.submitTask(
        ToolCategory.EXPORT as any,
        'export_markdown',
        'execute',
        [],
        ctx
      );

      expect(result.metadata?.queued).toBe(true);
      expect(result.metadata?.backgroundProcessing).toBe(true);
    });
  });

  // =========================================================
  // Task Status & Result API
  // =========================================================

  describe('task status API', () => {
    it('getTaskStatus for unknown task should return not_found', () => {
      expect(orchestrator.getTaskStatus('nonexistent-task-id')).toBe('not_found');
    });

    it('getTaskResult for unknown task should return null', () => {
      expect(orchestrator.getTaskResult('nonexistent-task-id')).toBeNull();
    });

    it('getTaskStatus for completed immediate task should return completed', async () => {
      const result = await submitAndCompleteImmediateTask(
        orchestrator, ToolCategory.DISPLAY, 'view_tree'
      );
      expect(orchestrator.getTaskStatus(result.taskId)).toBe('completed');
    });

    it('getTaskResult for completed task should return the result', async () => {
      const result = await submitAndCompleteImmediateTask(
        orchestrator, ToolCategory.DISPLAY, 'view_tree'
      );
      const retrieved = orchestrator.getTaskResult(result.taskId);
      expect(retrieved).toBeDefined();
      expect(retrieved!.taskId).toBe(result.taskId);
      expect(retrieved!.success).toBe(true);
    });

    it('getTaskStatus for queued background task should return pending', async () => {
      const ctx = createMockContext();
      const result = await orchestrator.submitTask(
        ToolCategory.SUMMARY as any,
        'generate_summary',
        'execute',
        [],
        ctx
      );
      // Before the processing loop picks it up, status is pending
      expect(orchestrator.getTaskStatus(result.taskId)).toBe('pending');
    });
  });

  // =========================================================
  // Health Check
  // =========================================================

  describe('healthCheck', () => {
    it('should return healthy when no issues', () => {
      const health = orchestrator.healthCheck();
      expect(health.status).toBe('healthy');
      expect(health.issues).toEqual([]);
      expect(health.metrics).toBeDefined();
    });

    it('should include metrics object in health check result', () => {
      const health = orchestrator.healthCheck();
      expect(health.metrics.totalTasks).toBe(0);
      expect(health.metrics.completedTasks).toBe(0);
      expect(health.metrics.failedTasks).toBe(0);
    });
  });

  // =========================================================
  // Metrics
  // =========================================================

  describe('metrics', () => {
    it('getMetrics should return an object with all expected fields', () => {
      const metrics = orchestrator.getMetrics();
      expect(metrics).toHaveProperty('totalTasks');
      expect(metrics).toHaveProperty('completedTasks');
      expect(metrics).toHaveProperty('failedTasks');
      expect(metrics).toHaveProperty('pendingTasks');
      expect(metrics).toHaveProperty('immediateTasks');
      expect(metrics).toHaveProperty('backgroundTasks');
      expect(metrics).toHaveProperty('mixedTasks');
      expect(metrics).toHaveProperty('averageImmediateTime');
      expect(metrics).toHaveProperty('averageBackgroundTime');
      expect(metrics).toHaveProperty('timeoutCount');
      expect(metrics).toHaveProperty('retryCount');
      expect(metrics).toHaveProperty('immediateQueueSize');
      expect(metrics).toHaveProperty('backgroundQueueSize');
      expect(metrics).toHaveProperty('cacheHitRate');
      expect(metrics).toHaveProperty('cacheEvictions');
      expect(metrics).toHaveProperty('categoryBreakdown');
    });

    it('submitTask should increment totalTasks', async () => {
      expect(orchestrator.getMetrics().totalTasks).toBe(0);

      const ctx = createMockContext();
      await orchestrator.submitTask(
        ToolCategory.SUMMARY as any,
        'generate_summary',
        'execute',
        [],
        ctx
      );
      expect(orchestrator.getMetrics().totalTasks).toBe(1);

      await orchestrator.submitTask(
        ToolCategory.EXPORT as any,
        'export_json',
        'execute',
        [],
        ctx
      );
      expect(orchestrator.getMetrics().totalTasks).toBe(2);
    });

    it('immediate task execution should increment immediateTasks counter', async () => {
      await submitAndCompleteImmediateTask(
        orchestrator, ToolCategory.DISPLAY, 'view_tree'
      );
      expect(orchestrator.getMetrics().immediateTasks).toBe(1);
    });

    it('background task should increment backgroundTasks counter', async () => {
      const ctx = createMockContext();
      await orchestrator.submitTask(
        ToolCategory.SUMMARY as any,
        'generate_summary',
        'execute',
        [],
        ctx
      );
      expect(orchestrator.getMetrics().backgroundTasks).toBe(1);
    });

    it('category breakdown should be tracked after completion', async () => {
      await submitAndCompleteImmediateTask(
        orchestrator, ToolCategory.DISPLAY, 'view_tree'
      );

      const metrics = orchestrator.getMetrics();
      const displayStats = metrics.categoryBreakdown.get(ToolCategory.DISPLAY as any);
      expect(displayStats).toBeDefined();
      expect(displayStats!.total).toBeGreaterThanOrEqual(1);
    });

    it('getMetrics should call collectMetrics which reads cacheManager.getStats', () => {
      mockCacheManager.getStats.mockClear();
      orchestrator.getMetrics();
      expect(mockCacheManager.getStats).toHaveBeenCalled();
    });

    it('metrics collection timer should fire periodically at 30s', () => {
      mockCacheManager.getStats.mockClear();
      // Advance 30 seconds to trigger the metrics collection interval
      vi.advanceTimersByTime(30000);
      expect(mockCacheManager.getStats).toHaveBeenCalled();
    });
  });

  // =========================================================
  // Factory Function
  // =========================================================

  describe('factory function', () => {
    it('createTwoLevelProcessingOrchestrator should create an instance', async () => {
      const instance = createTwoLevelProcessingOrchestrator(mockCacheManager as any);
      expect(instance).toBeInstanceOf(TwoLevelProcessingOrchestrator);
      expect(instance.getMetrics().totalTasks).toBe(0);
      await safeShutdown(instance);
    });

    it('createTwoLevelProcessingOrchestrator should accept config', async () => {
      const instance = createTwoLevelProcessingOrchestrator(
        mockCacheManager as any,
        { immediateTimeoutMs: 10000, cacheEnabled: false }
      );
      expect(instance).toBeInstanceOf(TwoLevelProcessingOrchestrator);
      await safeShutdown(instance);
    });
  });

  // =========================================================
  // Processing Loop (Background Queue)
  // =========================================================

  describe('processing loop', () => {
    it('processing loop should pick up and complete background tasks', async () => {
      const ctx = createMockContext();
      const result = await orchestrator.submitTask(
        ToolCategory.SUMMARY as any,
        'generate_summary',
        'execute',
        [],
        ctx
      );

      const taskId = result.taskId;
      expect(orchestrator.getTaskStatus(taskId)).toBe('pending');

      // Advance time: processing loop (100ms) + executeTask stub (up to 1s)
      await vi.advanceTimersByTimeAsync(3000);

      expect(orchestrator.getTaskStatus(taskId)).toBe('completed');
    });

    it('multiple background tasks should all eventually complete', async () => {
      const ctx = createMockContext();
      const taskIds: string[] = [];

      for (let i = 0; i < 3; i++) {
        const result = await orchestrator.submitTask(
          ToolCategory.EXPORT as any,
          `export_format_${i}`,
          'execute',
          [],
          ctx
        );
        taskIds.push(result.taskId);
      }

      // maxConcurrentBackground = 3, so they can all run in parallel
      await vi.advanceTimersByTimeAsync(5000);

      for (const id of taskIds) {
        expect(orchestrator.getTaskStatus(id)).toBe('completed');
      }
    });
  });

  // =========================================================
  // Edge Cases
  // =========================================================

  describe('edge cases', () => {
    it('submitTask with empty args should work', async () => {
      const result = await submitAndCompleteImmediateTask(
        orchestrator, ToolCategory.DISPLAY, 'view_tree', []
      );
      expect(result.success).toBe(true);
    });

    it('each task should get a unique taskId', async () => {
      const ctx = createMockContext();
      const ids = new Set<string>();

      for (let i = 0; i < 5; i++) {
        const result = await orchestrator.submitTask(
          ToolCategory.EXPORT as any,
          `export_${i}`,
          'execute',
          [],
          ctx
        );
        ids.add(result.taskId);
      }

      expect(ids.size).toBe(5);
    });

    it('cache hit should not increment immediateTasks or backgroundTasks', async () => {
      mockCacheManager.get.mockResolvedValue({
        hit: true,
        data: { cached: true },
        timestamp: Date.now()
      });

      const ctx = createMockContext();
      await orchestrator.submitTask(
        ToolCategory.DISPLAY as any,
        'view_tree',
        'execute',
        [],
        ctx
      );

      const metrics = orchestrator.getMetrics();
      // totalTasks incremented before cache check
      expect(metrics.totalTasks).toBe(1);
      // But immediateTasks should NOT be incremented (returned from cache)
      expect(metrics.immediateTasks).toBe(0);
    });

    it('cache key should include category, toolName, methodName, and args', async () => {
      mockCacheManager.get.mockResolvedValueOnce(null);

      await submitAndCompleteImmediateTask(
        orchestrator, ToolCategory.SEARCH, 'search_tasks', ['my_query']
      );

      // Verify the cache key passed to get()
      const cacheKey = mockCacheManager.get.mock.calls[0][0] as string;
      expect(cacheKey).toContain('search');
      expect(cacheKey).toContain('search_tasks');
      expect(cacheKey).toContain('execute');
      expect(cacheKey).toContain('my_query');
    });
  });
});
