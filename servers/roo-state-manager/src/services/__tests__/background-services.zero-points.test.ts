/**
 * #4352 grain code (GO ai-01 c.6795197729, 11/11): a pass that had sub-chunks
 * to embed (pending > 0) and wrote ZERO points must NOT be marked as a
 * success — markIndexingSuccess arms the reindex TTL, and the empty "success"
 * self-perpetuates (web1 canary: session present on old chunks, zero new
 * points landing pass after pass). pending == 0 stays a success: that is the
 * "already indexed" case, not a defect — the guard must not create a retry
 * livelock for up-to-date sessions.
 *
 * The three cases of the ai-01 spec. The first test is RED on the pre-fix
 * base (c50a2fe6): success was unconditional there.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';

// Mock fs module (saveSkeletonToDisk writes through fs.promises)
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      readdir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      stat: vi.fn(),
      access: vi.fn(),
      mkdir: vi.fn(),
    },
  };
});

// Mock RooStorageDetector (path resolution + archive lookup)
vi.mock('../../utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    detectStorageLocations: vi.fn(),
    analyzeConversation: vi.fn(),
  },
}));

// Mock tools index (imported but unused in tested functions)
vi.mock('../../tools/index.js', () => ({}));

// Mock TaskArchiver (dynamically imported on the success path)
vi.mock('../task-archiver/index.js', () => ({
  TaskArchiver: {
    archiveTask: vi.fn().mockResolvedValue(undefined),
  },
}));

// Unlike background-services.test.ts, this harness forwards ALL FOUR
// arguments of indexTask() to the spy: the #4352 zero-points guard reads the
// stats object the watchdog hands over (4th argument), so a test
// implementation must be able to mutate it in place.
vi.mock('../task-indexer.js', () => {
  const indexTaskSpy = vi.fn().mockResolvedValue(undefined);

  class MockTaskIndexer {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async indexTask(taskId: string, source: 'roo' | 'claude-code', metadata: any, options: any) {
      return indexTaskSpy(taskId, source, metadata, options);
    }
  }

  (MockTaskIndexer as any).indexTaskSpy = indexTaskSpy;

  return {
    TaskIndexer: MockTaskIndexer,
    getHostIdentifier: vi.fn().mockReturnValue('test-host'),
  };
});

// #692: Mock unified-store writer-factory so dual-write calls a spy.
vi.mock('../unified-store/writer-factory.js', () => {
  const upsertConversationOnly = vi.fn().mockResolvedValue(undefined);
  return {
    getUnifiedStoreWriter: () => ({
      upsertConversationOnly,
      upsertMessages: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue(true),
    }),
    resetWriterInstance: vi.fn(),
  };
});

// Unmetered link — the indexing decision is not the subject here.
const meteredSpy = vi.hoisted(() => vi.fn(async () => false));
vi.mock('../metered-connection.js', () => ({ isMeteredConnection: meteredSpy }));

import { indexTaskInQdrant } from '../background-services.js';
import type { StoredConversation } from '../unified-store/types.js';
import type { ServerState } from '../state-manager.service.js';
import { TaskIndexer } from '../task-indexer.js';

const TaskIndexerSpy = {
  get indexTask() {
    return (TaskIndexer as any).indexTaskSpy;
  },
};

const mockFs = fs as unknown as {
  readdir: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  access: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockDetector = (await import('../../utils/roo-storage-detector.js')).RooStorageDetector as unknown as {
  detectStorageLocations: ReturnType<typeof vi.fn>;
  analyzeConversation: ReturnType<typeof vi.fn>;
};

function createMockSkeleton(taskId: string, overrides?: Partial<StoredConversation>): StoredConversation {
  return {
    taskId,
    metadata: {
      title: `Task ${taskId}`,
      lastActivity: '2026-02-10T10:00:00Z',
      createdAt: '2026-02-10T09:00:00Z',
      messageCount: 5,
      actionCount: 2,
      totalSize: 1024,
    },
    sequence: [],
    ...overrides,
  };
}

function createMockState(): ServerState {
  return {
    conversationCache: new Map(),
    qdrantIndexQueue: new Set(),
    qdrantIndexInterval: null,
    isQdrantIndexingEnabled: true,
    qdrantIndexCache: new Map(),
    lastQdrantConsistencyCheck: 0,
    indexingDecisionService: {
      shouldIndex: vi.fn().mockReturnValue({ shouldIndex: false, reason: 'skip', action: 'skip', requiresSave: false }),
      migrateLegacyIndexingState: vi.fn().mockReturnValue(false),
      markIndexingSuccess: vi.fn(),
      markIndexingFailure: vi.fn(),
    },
    indexingMetrics: {
      totalTasks: 0,
      skippedTasks: 0,
      indexedTasks: 0,
      failedTasks: 0,
      retryTasks: 0,
      bandwidthSaved: 0,
      lastIndexedAt: undefined,
    },
    xmlExporterService: {} as any,
    exportConfigManager: {} as any,
    traceSummaryService: {} as any,
    llmService: {} as any,
    narrativeContextBuilderService: {} as any,
    synthesisOrchestratorService: {} as any,
  } as unknown as ServerState;
}

/**
 * A state where task `taskId` is ready to index (shouldIndex=true, action
 * 'index'), with the disk mocks resolved so saveSkeletonToDisk succeeds.
 */
function primeState(taskId: string): { state: ServerState; skeleton: StoredConversation } {
  const state = createMockState();
  const skeleton = createMockSkeleton(taskId);
  skeleton.metadata = {
    ...skeleton.metadata,
    indexingState: { indexStatus: 'pending' as const },
  };
  state.conversationCache.set(taskId, skeleton);

  (state.indexingDecisionService.shouldIndex as any).mockReturnValue({
    shouldIndex: true,
    reason: 'new task',
    action: 'index',
    requiresSave: false,
  });

  mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
  mockFs.mkdir.mockResolvedValue(undefined);
  mockFs.writeFile.mockResolvedValue(undefined);

  return { state, skeleton };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StatsBag = { stats?: any };

describe('#4352 zero-points guard — pending > 0 && pointsIndexed === 0', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('RED on pre-fix base: pending>0 with 0 points written is NOT a success — retry_fail [zero_points_written], no TTL armed', async () => {
    const { state, skeleton } = primeState('task-001');
    // The run reports 134 sub-chunks pending after both pre-flight dedups,
    // but nothing landed in Qdrant and nothing failed loudly — the web1
    // canary signature.
    TaskIndexerSpy.indexTask.mockImplementation(async (_id: string, _src: unknown, _meta: unknown, options: StatsBag) => {
      options.stats.pending = 134;
      options.stats.pointsIndexed = 0;
      options.stats.missingVectors = 0;
      options.stats.batchesAcked = 0;
    });

    const outcome = await indexTaskInQdrant('task-001', state);

    expect(outcome.outcome).toBe('retry_fail');
    expect(outcome.errorClass).toBe('zero_points_written');
    // The TTL lives on markIndexingSuccess — it must NOT fire.
    expect(state.indexingDecisionService.markIndexingSuccess).not.toHaveBeenCalled();
    // Transient failure: retry budget charged, backoff applies.
    expect(state.indexingDecisionService.markIndexingFailure).toHaveBeenCalledTimes(1);
    expect(state.indexingDecisionService.markIndexingFailure).toHaveBeenCalledWith(
      skeleton, expect.stringContaining('Zero points written'), false
    );
    expect(state.indexingMetrics.failedTasks).toBe(1);
    // #2766 S2+ parity: the granular class rides the skeleton for the status tool.
    expect(skeleton.metadata?.indexingState?.errorClass).toBe('zero_points_written');
    // The counters travel with the outcome so the drain-loop line can print them.
    expect(outcome.stats?.pending).toBe(134);
    expect(outcome.stats?.pointsIndexed).toBe(0);
  });

  it('pending == 0 stays a success (already indexed) — the guard must not fire', async () => {
    const { state } = primeState('task-002');
    TaskIndexerSpy.indexTask.mockImplementation(async (_id: string, _src: unknown, _meta: unknown, options: StatsBag) => {
      options.stats.pending = 0;
      options.stats.pointsIndexed = 0;
    });

    const outcome = await indexTaskInQdrant('task-002', state);

    expect(outcome.outcome).toBe('indexed');
    expect(state.indexingDecisionService.markIndexingSuccess).toHaveBeenCalledTimes(1);
    expect(state.indexingDecisionService.markIndexingFailure).not.toHaveBeenCalled();
    expect(state.indexingMetrics.failedTasks).toBe(0);
  });

  it('pending > 0 with points written stays a success', async () => {
    const { state } = primeState('task-003');
    TaskIndexerSpy.indexTask.mockImplementation(async (_id: string, _src: unknown, _meta: unknown, options: StatsBag) => {
      options.stats.pending = 100;
      options.stats.pointsIndexed = 42;
      options.stats.batchesAcked = 7;
    });

    const outcome = await indexTaskInQdrant('task-003', state);

    expect(outcome.outcome).toBe('indexed');
    expect(state.indexingDecisionService.markIndexingSuccess).toHaveBeenCalledTimes(1);
    expect(state.indexingDecisionService.markIndexingFailure).not.toHaveBeenCalled();
    expect(state.indexingMetrics.failedTasks).toBe(0);
  });

  // ms#1736 review suite 1 (ai-01): postEmbedDedupSkipped >= pending with 0
  // points is the "already indexed" case — the pre-flight contentHash dedup
  // let already-indexed sub-chunks through, they were embedded, then the
  // post-embedding dedup removed every one of them. NOT a defect. RED on the
  // pre-suite base (5375d0cb): the guard there fired on pending alone. The
  // guard keys on postEmbedDedupSkipped (== pending here), NOT on
  // dedupSkipped — see the pre-flight-dominant test below for why.
  it('RED on pre-suite base: post-embedding dedup covered every pending sub-chunk with 0 points written IS a success — already indexed', async () => {
    const { state } = primeState('task-004');
    TaskIndexerSpy.indexTask.mockImplementation(async (_id: string, _src: unknown, _meta: unknown, options: StatsBag) => {
      options.stats.pending = 134;
      options.stats.pointsIndexed = 0;
      options.stats.dedupSkipped = 284; // 150 pre-flight + 134 post-embedding
      options.stats.postEmbedDedupSkipped = 134; // == pending: every pending sub-chunk was deduped
      options.stats.batchesAcked = 9;
    });

    const outcome = await indexTaskInQdrant('task-004', state);

    expect(outcome.outcome).toBe('indexed');
    expect(state.indexingDecisionService.markIndexingSuccess).toHaveBeenCalledTimes(1);
    expect(state.indexingDecisionService.markIndexingFailure).not.toHaveBeenCalled();
    expect(state.indexingMetrics.failedTasks).toBe(0);
  });

  // ms#1736 review suite 1 (ai-01): dedupSkipped accumulates the PRE-FLIGHT
  // dedups too, which run before `pending` is fixed. The web1 canary pass
  // (c.6806908470): 30 266 sub-chunks removed pre-flight, 516 pending, 0
  // points written, 0 removed post-embedding — dedupSkipped (30 266) >=
  // pending (516), so a guard keyed on dedupSkipped counts the empty pass as
  // "already indexed" and disarms exactly when the anomaly it exists to catch
  // shows up. postEmbedDedupSkipped (0) < pending (516) tells the truth.
  // RED on dbccb6c5: the guard there keys on dedupSkipped >= pending.
  it('RED on dbccb6c5: pre-flight dedup >= pending with 0 points written and 0 post-embedding dedup is NOT a success — retry_fail [zero_points_written]', async () => {
    const { state, skeleton } = primeState('task-007');
    TaskIndexerSpy.indexTask.mockImplementation(async (_id: string, _src: unknown, _meta: unknown, options: StatsBag) => {
      options.stats.pending = 516;
      options.stats.pointsIndexed = 0;
      options.stats.dedupSkipped = 30266; // all pre-flight, none post-embedding
      options.stats.postEmbedDedupSkipped = 0;
      options.stats.missingVectors = 0;
      options.stats.batchesAcked = 0;
    });

    const outcome = await indexTaskInQdrant('task-007', state);

    expect(outcome.outcome).toBe('retry_fail');
    expect(outcome.errorClass).toBe('zero_points_written');
    expect(state.indexingDecisionService.markIndexingSuccess).not.toHaveBeenCalled();
    expect(state.indexingDecisionService.markIndexingFailure).toHaveBeenCalledTimes(1);
    expect(skeleton.metadata?.indexingState?.errorClass).toBe('zero_points_written');
  });

  // ms#1734 review suite 2 (ai-01): once the zero-write retry budget is
  // exhausted (3rd attempt), markIndexingFailure flips the skeleton to
  // 'failed' and the task must land in the dead-letter, like the throw path
  // does for permanent errors. RED on the pre-suite base: the guard never
  // registered a dead-letter entry.
  it('RED on pre-suite base: 3rd zero-points failure lands in the dead-letter', async () => {
    const { state, skeleton } = primeState('task-005');
    // Budget already at the ceiling: the next markIndexingFailure call (this
    // attempt) flips indexStatus to 'failed' — mock the real decision's effect.
    skeleton.metadata = {
      ...skeleton.metadata,
      indexingState: { indexStatus: 'retry' as const, indexRetryCount: 2 },
    };
    (state.indexingDecisionService.markIndexingFailure as any).mockImplementation(
      (sk: any, _msg: string) => {
        sk.metadata.indexingState = {
          ...sk.metadata.indexingState,
          indexStatus: 'failed',
        };
      }
    );
    TaskIndexerSpy.indexTask.mockImplementation(async (_id: string, _src: unknown, _meta: unknown, options: StatsBag) => {
      options.stats.pending = 50;
      options.stats.pointsIndexed = 0;
      options.stats.dedupSkipped = 0;
    });

    const outcome = await indexTaskInQdrant('task-005', state);

    expect(outcome.outcome).toBe('retry_fail');
    // The dead-letter is lazily initialized by registerDeadLetter (#2766 S2+).
    expect(state.deadLetterQueue?.has('task-005')).toBe(true);
    expect(state.deadLetterDetails?.get('task-005')?.errorClass).toBe('zero_points_written');
  });

  // Symmetry for suite 2: a FIRST zero-points failure (budget not exhausted)
  // must NOT dead-letter — the task is still in its retry window.
  it('1st zero-points failure does NOT dead-letter — retry window still open', async () => {
    const { state } = primeState('task-006');
    (state.indexingDecisionService.markIndexingFailure as any).mockImplementation(
      (sk: any, _msg: string) => {
        sk.metadata.indexingState = {
          ...sk.metadata.indexingState,
          indexStatus: 'retry',
        };
      }
    );
    TaskIndexerSpy.indexTask.mockImplementation(async (_id: string, _src: unknown, _meta: unknown, options: StatsBag) => {
      options.stats.pending = 50;
      options.stats.pointsIndexed = 0;
      options.stats.dedupSkipped = 0;
    });

    const outcome = await indexTaskInQdrant('task-006', state);

    expect(outcome.outcome).toBe('retry_fail');
    expect(state.deadLetterQueue?.has('task-006') ?? false).toBe(false);
  });
});
