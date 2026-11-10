/**
 * #4352 g9 — operator requests take priority over the scan backlog.
 *
 * Measured defect (ai-01, 09/11, c.6747563570): a consumed operator request
 * was re-filed at the BACK of `qdrantIndexQueue` (`Set.add` appends), while
 * each drain pass takes only `QDRANT_INDEX_BATCH_SIZE` (5) tasks in insertion
 * order — behind a backlog of k, the operator task waited ~k/5 passes of ~5 h.
 *
 * The g9 fix places the consumed IDs at the FRONT of the queue once, after the
 * consume loop: `new Set([...consumed, ...backlog])`. These tests run the REAL
 * `consumePendingIndexRequests` against real files (same harness as g6) and
 * assert the END STATE: the operator task is in the FIRST drained batch, even
 * behind 500 backlog items.
 *
 * @module services/__tests__/operator-priority.g9
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    getIndexRequestsPath,
    requestQueuedIndexBatch,
    hasPendingIndexRequests,
    consumePendingIndexRequests,
    QDRANT_INDEX_BATCH_SIZE,
} from '../background-services.js';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `g9-opri-${process.pid}-`));
vi.mock('../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectStorageLocations: async () => [TEST_DIR],
    },
}));

const MACHINE_ID = `g9-test-${process.pid}`;

const failedSkeleton = (taskId: string) => ({
    taskId,
    metadata: {
        indexingState: {
            indexStatus: 'failed',
            indexError: 'qdrant upsert failed',
            errorClass: 'qdrant_upsert_failed',
            indexRetryCount: 3,
            lastErrorAt: '2026-11-09T08:16:00.000Z',
        },
    },
    sequence: [],
});

// A leader carrying a 500-task scan backlog — the scenario of c.6747563570.
const BACKLOG_SIZE = 500;
const backlogIds = Array.from({ length: BACKLOG_SIZE }, (_, i) => `backlog-${i}`);

const leaderState = () => ({
    machineId: MACHINE_ID,
    conversationCache: new Map<string, any>([['d5be00ef', failedSkeleton('d5be00ef')]]),
    qdrantIndexQueue: new Set<string>(backlogIds),
    deadLetterQueue: new Set<string>(['d5be00ef']),
    deadLetterDetails: new Map([
        ['d5be00ef', { taskId: 'd5be00ef', error: 'upsert', errorClass: 'qdrant_upsert_failed', retryCount: 3 }],
    ]),
});

describe('#4352 g9 — operator priority: consumed requests at the FRONT of the index queue', () => {
    let requestsPath: string;

    beforeEach(async () => {
        requestsPath = await getIndexRequestsPath(MACHINE_ID);
        await fs.promises.unlink(requestsPath).catch(() => {});
    });

    afterEach(async () => {
        await fs.promises.unlink(requestsPath).catch(() => {});
        const dir = path.dirname(requestsPath);
        const base = path.basename(requestsPath);
        for (const f of await fs.promises.readdir(dir)) {
            if (f.startsWith(`${base}.consuming-`)) {
                await fs.promises.unlink(path.join(dir, f)).catch(() => {});
            }
        }
    });

    test('END STATE: an operator request behind 500 backlog tasks is in the FIRST drained batch', async () => {
        // 1. Operator (another process) persists the request — the requeue of
        //    d5be00ef behind a 500-task backlog, exactly the measured incident.
        await requestQueuedIndexBatch(['d5be00ef'], MACHINE_ID);
        expect(await hasPendingIndexRequests(MACHINE_ID)).toBe(true);

        // 2. Leader tick consumes with the backlog already queued.
        const state = leaderState();
        // ms#1721 review (ai-01): the rebuild must happen IN PLACE — tool
        // handlers hold this very Set object as a parameter and .add() on it
        // after awaits; a reassignment orphans them and silently loses tasks.
        const queueBefore = state.qdrantIndexQueue;
        const drainedBefore = Array.from(state.qdrantIndexQueue.values())
            .slice(0, QDRANT_INDEX_BATCH_SIZE);
        expect(drainedBefore).not.toContain('d5be00ef'); // the defect's premise

        const consumed = await consumePendingIndexRequests(state);

        expect(state.qdrantIndexQueue).toBe(queueBefore); // same object, always

        expect(consumed).toEqual(['d5be00ef']);

        // 3. The next drain (production: slice(0, QDRANT_INDEX_BATCH_SIZE) in
        //    insertion order) now carries the operator task FIRST.
        const nextBatch = Array.from(state.qdrantIndexQueue.values())
            .slice(0, QDRANT_INDEX_BATCH_SIZE);
        expect(nextBatch[0]).toBe('d5be00ef');
        expect(nextBatch).toEqual(['d5be00ef', 'backlog-0', 'backlog-1', 'backlog-2', 'backlog-3']);

        // 4. Full ordering: consumed at the front, the backlog behind — intact,
        //    nothing dropped or duplicated.
        const order = Array.from(state.qdrantIndexQueue.values());
        expect(order).toHaveLength(BACKLOG_SIZE + 1);
        expect(order[0]).toBe('d5be00ef');
        expect(order.slice(1)).toEqual(backlogIds);
    });

    test('a task already in the backlog keeps ONE position — its consumed (front) one', async () => {
        // An operator requeue of a task the scan already queued.
        await requestQueuedIndexBatch(['backlog-499'], MACHINE_ID);

        const state = leaderState();
        state.conversationCache.set('backlog-499', failedSkeleton('backlog-499'));

        const consumed = await consumePendingIndexRequests(state);
        expect(consumed).toEqual(['backlog-499']);

        const order = Array.from(state.qdrantIndexQueue.values());
        // No duplicate: 500 entries, not 501 — the consumed position wins.
        expect(order).toHaveLength(BACKLOG_SIZE);
        expect(order[0]).toBe('backlog-499');
        expect(order.filter(id => id === 'backlog-499')).toHaveLength(1);
    });

    test('no consumed request → queue untouched (no reorder, no log noise path)', async () => {
        const state = leaderState();
        // Requests file exists but its task is unknown → deferred, not consumed.
        await requestQueuedIndexBatch(['ghost-task'], MACHINE_ID);

        const consumed = await consumePendingIndexRequests(state);
        expect(consumed).toEqual([]);

        // The backlog keeps its exact order — nothing was re-filed.
        expect(Array.from(state.qdrantIndexQueue.values())).toEqual(backlogIds);
    });
});
