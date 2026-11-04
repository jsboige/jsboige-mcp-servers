/**
 * #4531 — the retry budget must not ignore progress.
 *
 * A long session over a flaky link writes points on every attempt and dies on
 * one transport blip, three times, then sits `failed` with holes (web2, 04/11:
 * task 8f8167a7, `588/2167 sub-chunks without a vector (1089 points written)`).
 * An attempt that wrote new deduplicated points is progress, not a failure.
 *
 * Cases 1-4 mirror the issue's acceptance list.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IndexingDecisionService } from '../indexing-decision.js';
import { MAX_RETRY_ATTEMPTS } from '../../types/indexing.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

function createSkeleton(retryCount?: number): ConversationSkeleton {
  return {
    taskId: 'test-task-4531',
    metadata: {
      title: 'Test #4531',
      lastActivity: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      messageCount: 5,
      actionCount: 2,
      totalSize: 1024,
      ...(retryCount === undefined
        ? {}
        : { indexingState: { indexStatus: 'retry' as const, indexRetryCount: retryCount } }),
    },
    sequence: [],
  };
}

/** The exact error shape VectorIndexer throws for a partial attempt. */
function partialAttemptError(written: number): Error & { details: any } {
  const error = new Error(
    `Embedding incomplete for task test-task-4531: 588/2167 sub-chunks without a vector ` +
    `(${written} points written, kept for the retry)`
  ) as Error & { details: any };
  error.details = { taskId: 'test-task-4531', missingVectors: 588, written, transport: true };
  return error;
}

describe('#4531 — progress-aware retry budget', () => {
  let service: IndexingDecisionService;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env = { ...originalEnv };
    delete process.env.INDEX_PROGRESS_AWARE_RETRY;
    service = new IndexingDecisionService();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('case 1: an attempt that wrote points does not consume the budget, even at the ceiling', () => {
    const error = partialAttemptError(1089);
    const skeleton = createSkeleton(MAX_RETRY_ATTEMPTS - 1);

    service.markIndexingFailure(skeleton, error.message, false, error.details.written);

    const state = skeleton.metadata.indexingState!;
    expect(state.indexStatus).toBe('retry');
    expect(state.indexRetryCount).toBe(MAX_RETRY_ATTEMPTS - 1);
    expect(state.lastAttemptWritten).toBe(1089);
    expect(state.indexError).toContain('kept for the retry');
  });

  it('case 1b: repeated progressing attempts never reach failed', () => {
    const skeleton = createSkeleton(0);

    for (let pass = 0; pass < MAX_RETRY_ATTEMPTS + 3; pass++) {
      service.markIndexingFailure(skeleton, partialAttemptError(500).message, false, 500);
    }

    expect(skeleton.metadata.indexingState!.indexStatus).toBe('retry');
    expect(skeleton.metadata.indexingState!.indexRetryCount).toBe(0);
  });

  it('case 2: an attempt that wrote nothing is counted and fails at the budget, as today', () => {
    const skeleton = createSkeleton(MAX_RETRY_ATTEMPTS - 1);

    service.markIndexingFailure(skeleton, partialAttemptError(0).message, false, 0);

    const state = skeleton.metadata.indexingState!;
    expect(state.indexStatus).toBe('failed');
    expect(state.indexRetryCount).toBe(MAX_RETRY_ATTEMPTS);
    expect(state.lastAttemptWritten).toBe(0);
  });

  it('case 2b: an absent `written` detail (e.g. a timeout) keeps the old arithmetic', () => {
    const skeleton = createSkeleton(0);

    service.markIndexingFailure(skeleton, 'embedding request timed out after 300000ms', false);

    const state = skeleton.metadata.indexingState!;
    expect(state.indexStatus).toBe('retry');
    expect(state.indexRetryCount).toBe(1);
  });

  it('case 3: INDEX_PROGRESS_AWARE_RETRY=0 restores the old behaviour', () => {
    process.env.INDEX_PROGRESS_AWARE_RETRY = '0';
    const skeleton = createSkeleton(MAX_RETRY_ATTEMPTS - 1);

    service.markIndexingFailure(skeleton, partialAttemptError(1089).message, false, 1089);

    const state = skeleton.metadata.indexingState!;
    expect(state.indexStatus).toBe('failed');
    expect(state.indexRetryCount).toBe(MAX_RETRY_ATTEMPTS);
  });

  it('case 4: a task that cannot progress still terminates in failed', () => {
    const skeleton = createSkeleton(0);

    for (let pass = 0; pass < MAX_RETRY_ATTEMPTS; pass++) {
      service.markIndexingFailure(skeleton, partialAttemptError(0).message, false, 0);
    }

    expect(skeleton.metadata.indexingState!.indexStatus).toBe('failed');
  });

  it('case 4b: alternating 0-write and progress attempts terminate on the zero-writes', () => {
    const skeleton = createSkeleton(0);

    // progress, zero, progress, zero, ... — only the zero-writes may count, and
    // a progressing attempt revives a failed task. Termination comes from the
    // zero-writes piling up: progress is finite (a task has finitely many
    // sub-chunks), so the sequence always reaches the ceiling.
    for (let pass = 0; pass < 8; pass++) {
      const written = pass % 2 === 0 ? 1200 : 0;
      service.markIndexingFailure(skeleton, partialAttemptError(written).message, false, written);
    }

    const state = skeleton.metadata.indexingState!;
    expect(state.indexStatus).toBe('failed');
    expect(state.indexRetryCount).toBeGreaterThanOrEqual(MAX_RETRY_ATTEMPTS);
  });

  it('case 4c: a repair attempt that writes points revives a failed task instead of re-failing it', () => {
    // #4352 g8 gives one repair shot; before this fix a partial repair came back
    // 'failed' and needed another manual repair, one per pass (web2, 4e13fb8f).
    const skeleton = createSkeleton(MAX_RETRY_ATTEMPTS);
    skeleton.metadata.indexingState!.indexStatus = 'failed';

    service.markIndexingFailure(skeleton, partialAttemptError(1089).message, false, 1089);

    const state = skeleton.metadata.indexingState!;
    expect(state.indexStatus).toBe('retry');
    expect(state.indexRetryCount).toBe(MAX_RETRY_ATTEMPTS);
  });

  it('case 5: a permanent error is never made free by progress', () => {
    const skeleton = createSkeleton(0);

    service.markIndexingFailure(skeleton, 'auth_failed: 401', true, 1089);

    const state = skeleton.metadata.indexingState!;
    expect(state.indexStatus).toBe('failed');
  });
});
