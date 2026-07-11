/**
 * Smoke tests for runBackfill (#2581 volet 1).
 *
 * The iteration/counting logic is unit-tested with a mocked writeFn (no DB, no env).
 * A final dry-run test exercises the REAL dualWriteConversationToStore against a
 * NullUnifiedStoreWriter (env-gate off) → confirms the wiring is safe to run with
 * no Postgres reachable, which is exactly how the CLI is validated pre-merge.
 *
 * Pure test, no pg, no real DB.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { runBackfill } from '../backfill.js';
import { dualWriteConversationToStore } from '../dual-write.js';
import {
  NullUnifiedStoreWriter,
  getUnifiedStoreWriter,
  resetWriterInstance,
} from '../index.js';
import type { ConversationSkeleton } from '../../../../types/conversation.js';

function makeSkeleton(id: string | undefined): ConversationSkeleton {
  return {
    taskId: id,
    metadata: {
      lastActivity: '2026-07-11T00:00:00Z',
      createdAt: '2026-07-10T00:00:00Z',
      messageCount: 5,
      actionCount: 1,
      totalSize: 1000,
      source: 'roo',
      workspace: 'roo-extensions',
      machineId: 'myia-po-2023',
    },
    sequence: [],
  } as ConversationSkeleton;
}

describe('runBackfill (#2581 volet 1)', () => {
  test('iterates N skeletons and reports correct counts', async () => {
    const skeletons = [makeSkeleton('t1'), makeSkeleton('t2'), makeSkeleton('t3')];
    const writeFn = vi.fn().mockResolvedValue(undefined);

    const result = await runBackfill(skeletons, writeFn);

    expect(result).toEqual({ total: 3, processed: 3, skipped: 0, errors: 0 });
    expect(writeFn).toHaveBeenCalledTimes(3);
    expect(writeFn).toHaveBeenCalledWith('t1', skeletons[0]);
    expect(writeFn).toHaveBeenCalledWith('t2', skeletons[1]);
    expect(writeFn).toHaveBeenCalledWith('t3', skeletons[2]);
  });

  test('counts a rejected writeFn as error and continues iteration', async () => {
    const skeletons = [makeSkeleton('t1'), makeSkeleton('t2'), makeSkeleton('t3')];
    const writeFn = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(undefined);

    const result = await runBackfill(skeletons, writeFn);

    expect(result).toEqual({ total: 3, processed: 2, skipped: 0, errors: 1 });
    expect(writeFn).toHaveBeenCalledTimes(3);
  });

  test('skips skeletons missing taskId (does not call writeFn)', async () => {
    const skeletons = [
      makeSkeleton('t1'),
      { ...makeSkeleton('t2'), taskId: undefined } as ConversationSkeleton,
      makeSkeleton('t3'),
    ];
    const writeFn = vi.fn().mockResolvedValue(undefined);

    const result = await runBackfill(skeletons, writeFn);

    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(2);
    expect(result.total).toBe(3);
    expect(writeFn).toHaveBeenCalledTimes(2);
  });

  test('respects the limit option (stops early, total unchanged)', async () => {
    const skeletons = Array.from({ length: 10 }, (_, i) => makeSkeleton(`t${i}`));
    const writeFn = vi.fn().mockResolvedValue(undefined);

    const result = await runBackfill(skeletons, writeFn, { limit: 3 });

    expect(result.total).toBe(10);
    expect(result.processed).toBe(3);
    expect(writeFn).toHaveBeenCalledTimes(3);
  });

  test('empty input returns zero counts', async () => {
    const writeFn = vi.fn().mockResolvedValue(undefined);
    const result = await runBackfill([], writeFn);
    expect(result).toEqual({ total: 0, processed: 0, skipped: 0, errors: 0 });
    expect(writeFn).not.toHaveBeenCalled();
  });

  describe('dry-run against real NullUnifiedStoreWriter (env gate off)', () => {
    beforeEach(() => {
      // Force the env-gate off → writer-factory returns NullUnifiedStoreWriter.
      delete process.env.UNIFIED_STORE_DUAL_WRITE;
      delete process.env.UNIFIED_STORE_PG_URL;
      resetWriterInstance();
    });

    test('dualWriteConversationToStore is a no-op (no DB reachable) and runBackfill counts it', async () => {
      const writer = getUnifiedStoreWriter();
      expect(writer).toBeInstanceOf(NullUnifiedStoreWriter);
      // Null writer never persists anything: ping() === false confirms no real DB.
      expect(await writer.ping()).toBe(false);

      const skeletons = [makeSkeleton('dry-1'), makeSkeleton('dry-2')];
      // Use the REAL dualWriteConversationToStore (not a mock): with a Null writer
      // it resolves without throwing and without writing.
      const result = await runBackfill(skeletons, dualWriteConversationToStore);

      expect(result).toEqual({ total: 2, processed: 2, skipped: 0, errors: 0 });
    });
  });
});
