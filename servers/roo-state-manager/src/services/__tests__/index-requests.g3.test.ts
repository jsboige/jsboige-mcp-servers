/**
 * #4352 g3 — follower → leader persisted index requests.
 *
 * Review (ai-01, 27/10): `qdrantIndexQueue` and `deadLetterQueue` are in-memory
 * Sets, per process, and ONLY the leader drains. A follower that enqueued
 * locally handed the task to a queue nobody drains, and its
 * `deadLetterQueue.delete()` emptied a Set the leader never reads — a lying
 * success receipt, and precisely the canonical case (5.5 MB session
 * dead-lettered on the leader) went unrepaired.
 *
 * The fix: the follower PERSISTS the request (machine-local file next to the
 * leader lock); the leader's tick consumes it, lifting ITS OWN pin and
 * enqueueing on the queue it actually drains. This test exercises the real
 * primitives against a real file and asserts the LEADER's END STATE — the test
 * the review asked for.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    getIndexRequestsPath,
    requestQueuedIndex,
    hasPendingIndexRequests,
    consumePendingIndexRequests,
} from '../background-services.js';

// Unique per run → no residue from a previous run, no cross-run interference.
const MACHINE_ID = `g3-test-${process.pid}`;

const leaderState = (): any => ({
    machineId: MACHINE_ID,
    // #4352 g6b (ms#1546 review): the consumer now DEFERS a line whose task is
    // absent from the leader's cache instead of losing it (the indexing worker
    // skips absent tasks with no retry). The leader in this scenario holds the
    // tasks — their skeletons are deliberately state-less (`metadata: {}`) so
    // the status guard never fires: this suite is about TRANSPORT, and a
    // failed state would trigger a real saveSkeletonIndex (the storage
    // detector is not mocked here). Deferral itself is covered by
    // reset-requests.g6.test.ts.
    conversationCache: new Map<string, any>([
        ['big-1', { taskId: 'big-1', metadata: {}, sequence: [] }],
        ['other', { taskId: 'other', metadata: {}, sequence: [] }],
    ]),
    qdrantIndexQueue: new Set<string>(),
    deadLetterQueue: new Set<string>(['big-1', 'other']),
    deadLetterDetails: new Map([[
        'big-1',
        {
            taskId: 'big-1', error: 'embedding timeout', errorClass: 'embedding_timeout',
            retryCount: 3, lastAttempt: '2026-10-27T00:00:00.000Z', movedAt: '2026-10-27T00:00:00.000Z',
        },
    ]]),
});

describe('#4352 g3 — persisted index requests (follower → leader)', () => {
    let requestsPath: string;

    beforeEach(async () => {
        requestsPath = await getIndexRequestsPath(MACHINE_ID);
        await fs.promises.unlink(requestsPath).catch(() => {});
    });

    afterEach(async () => {
        await fs.promises.unlink(requestsPath).catch(() => {});
        // Defensive: the consumer unlinks its own .consuming-* in a finally, but
        // a failed assertion mid-test must not leave residue in os.tmpdir().
        const dir = path.dirname(requestsPath);
        const base = path.basename(requestsPath);
        for (const f of await fs.promises.readdir(dir)) {
            if (f.startsWith(`${base}.consuming-`)) {
                await fs.promises.unlink(path.join(dir, f)).catch(() => {});
            }
        }
    });

    test('END STATE: the leader lifts ITS dead-letter pin and enqueues the task the follower requested', async () => {
        // 1. Follower persists the request — it cannot touch the leader's Sets.
        await requestQueuedIndex('big-1', MACHINE_ID);
        expect(await hasPendingIndexRequests(MACHINE_ID)).toBe(true);

        // 2. Leader tick consumes.
        const state = leaderState();
        const consumed = await consumePendingIndexRequests(state);

        expect(consumed).toEqual(['big-1']);
        expect(state.deadLetterQueue.has('big-1')).toBe(false);   // pin lifted ON THE LEADER
        expect(state.deadLetterDetails.has('big-1')).toBe(false);
        expect(state.qdrantIndexQueue.has('big-1')).toBe(true);   // queue the leader actually drains
        expect(state.deadLetterQueue.has('other')).toBe(true);    // unrelated pins survive
        expect(await hasPendingIndexRequests(MACHINE_ID)).toBe(false);
    });

    test('two followers requesting the same task: consumed once, one queue entry', async () => {
        await requestQueuedIndex('big-1', MACHINE_ID);
        await requestQueuedIndex('big-1', MACHINE_ID);

        const state = leaderState();
        const consumed = await consumePendingIndexRequests(state);

        expect(consumed).toEqual(['big-1']);
        expect(state.qdrantIndexQueue.size).toBe(1);
    });

    test('a corrupt line is skipped, the rest of the file still applies (a tick must not die)', async () => {
        await fs.promises.appendFile(requestsPath, '{not json}\n');
        await requestQueuedIndex('big-1', MACHINE_ID);

        const state = leaderState();
        const consumed = await consumePendingIndexRequests(state);

        expect(consumed).toEqual(['big-1']);
        expect(state.qdrantIndexQueue.has('big-1')).toBe(true);
        expect(state.deadLetterQueue.has('big-1')).toBe(false);
    });

    test('no pending file: consumption is a no-op, never a throw', async () => {
        const state = leaderState();
        await expect(consumePendingIndexRequests(state)).resolves.toEqual([]);
        expect(state.qdrantIndexQueue.size).toBe(0);
        expect(state.deadLetterQueue.has('big-1')).toBe(true); // untouched
        expect(await hasPendingIndexRequests(MACHINE_ID)).toBe(false);
    });

    test('the request file is machine-local, under os.tmpdir() (never GDrive-synced)', async () => {
        expect(path.dirname(requestsPath)).toBe(os.tmpdir());
        expect(path.basename(requestsPath)).toContain(MACHINE_ID.toLowerCase());
    });
});
