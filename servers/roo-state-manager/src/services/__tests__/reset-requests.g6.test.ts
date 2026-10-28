/**
 * #4352 g6 — delegated resets must reach the leader (extended, c.6460303351).
 *
 * Measured defect (ai-01, 28/10, c.6460088328): a cleanup_failed reset lived
 * only in the memory of the process that ran it. `saveSkeletonToDisk` returns
 * silently for claude-* skeletons (guard #1325 — header-only, no per-task
 * file), and the leader rewrites `_skeleton_index.json` from ITS OWN cache,
 * where the task is still `failed`. The requeue of 01:43Z reported
 * `[EXECUTED] reset=100`; only 1 of 100 was retried, retry_count stayed 3-6.
 *
 * Extension (c.6460303351): the DELEGATED INDEX path had the same hole. A
 * follower `index` on a failed session consumed the request and enqueued the
 * task, but the leader's decision skips every `failed` task
 * (indexing-decision.ts:72-77) — 6/6 sessions still `failed` 15 min later.
 *
 * The fix rides the g3 transport with ONE request type: the leader's tick
 * consumes each request, resets ITS OWN cache copy, persists the reset into
 * `_skeleton_index.json` (direct saveSkeletonIndex — the refresh-path save is
 * conditional on updatedCount>0 and cannot be waited on), lifts ITS OWN
 * dead-letter pin, and only then enqueues. `index` from a follower and
 * `cleanup_failed` use the same request type.
 *
 * This test runs the REAL follower→leader path against real files — no mocked
 * saveSkeletonCallback, no mocked request primitives — and asserts the END
 * STATE the dispatch asked for: the leader's cache is reset, the pin is
 * lifted, the task is enqueued, the index file on disk carries the reset.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    getIndexRequestsPath,
    requestQueuedIndex,
    requestQueuedIndexBatch,
    hasPendingIndexRequests,
    consumePendingIndexRequests,
} from '../background-services.js';

// The leader-side reset persists via the REAL saveSkeletonIndex. Point the
// storage detector at a per-run tmpdir so the test (a) never touches this
// machine's real _skeleton_index.json, and (b) can assert the index file
// content itself — the end of the chain the defect broke.
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `g6-reset-${process.pid}-`));
vi.mock('../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectStorageLocations: async () => [TEST_DIR],
    },
}));

// Unique per run → no residue from a previous run, no cross-run interference.
const MACHINE_ID = `g6-test-${process.pid}`;

const failedSkeleton = (taskId: string) => ({
    taskId,
    metadata: {
        indexingState: {
            indexStatus: 'failed',
            indexError: 'Indexing timeout after 300000ms — session too large',
            errorClass: 'embedding_timeout',
            indexRetryCount: 6,
            lastErrorAt: '2026-10-25T15:47:00.345Z',
        },
    },
    sequence: [],
});

const leaderState = () => ({
    machineId: MACHINE_ID,
    conversationCache: new Map<string, any>([
        ['big-1', failedSkeleton('big-1')],
        ['unrelated', failedSkeleton('unrelated')],
    ]),
    qdrantIndexQueue: new Set<string>(),
    deadLetterQueue: new Set<string>(['big-1', 'other']),
    deadLetterDetails: new Map([
        ['big-1', { taskId: 'big-1', error: 'embedding timeout', errorClass: 'embedding_timeout', retryCount: 6 }],
        ['other', { taskId: 'other', error: 'x', errorClass: 'unknown', retryCount: 3 }],
    ]),
});

describe('#4352 g6 — delegated reset+requeue via the request file (follower → leader)', () => {
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

    test('END STATE: leader cache reset, pin lifted, enqueued, reset persisted into _skeleton_index.json', async () => {
        // 1. Follower (another process) persists the request — the batch
        //    flavour one cleanup_failed actually uses.
        await requestQueuedIndexBatch(['big-1'], MACHINE_ID);
        expect(await hasPendingIndexRequests(MACHINE_ID)).toBe(true);

        // 2. Leader tick consumes.
        const state = leaderState();
        const consumed = await consumePendingIndexRequests(state);

        expect(consumed).toEqual(['big-1']);
        // Leader's OWN cache copy is reset: no status, no error, no retry count.
        const reset = (state.conversationCache.get('big-1') as any).metadata.indexingState;
        expect(reset.indexStatus).toBeUndefined();
        expect(reset.indexError).toBeUndefined();
        expect(reset.indexRetryCount).toBeUndefined();
        // The pin is lifted on the leader; the unrelated one survives.
        expect(state.deadLetterQueue.has('big-1')).toBe(false);
        expect(state.deadLetterDetails.has('big-1')).toBe(false);
        expect(state.deadLetterQueue.has('other')).toBe(true);
        // Reset BEFORE enqueue: without the reset, the leader's decision drops
        // the task as `failed` (indexing-decision.ts:72-77) — the hole g6b
        // measured (6/6 sessions still failed 15 min after a delegated index).
        expect(state.qdrantIndexQueue.has('big-1')).toBe(true);
        expect(state.qdrantIndexQueue.size).toBe(1);
        // The request file is gone.
        expect(await hasPendingIndexRequests(MACHINE_ID)).toBe(false);

        // 3. The reset reached `_skeleton_index.json` — the leader's cache is
        //    what gets rewritten there, and it now carries the reset. The save
        //    is fire-and-forget inside the consumer, so wait briefly for it.
        const indexPath = path.join(TEST_DIR, 'tasks', '.skeletons', '_skeleton_index.json');
        await vi.waitFor(async () => {
            const raw = await fs.promises.readFile(indexPath, 'utf8');
            const index = JSON.parse(raw);
            const entry = index.entries.find((e: any) => e.taskId === 'big-1');
            expect(entry).toBeDefined();
            expect(entry.metadata.indexingState.indexStatus).toBeUndefined();
            expect(entry.metadata.indexingState.indexRetryCount).toBeUndefined();
        });
    });

    test('a line for a task ALREADY healthy (no indexingState) is a plain requeue', async () => {
        const state = {
            ...leaderState(),
            conversationCache: new Map<string, any>([['clean-1', { taskId: 'clean-1', metadata: {}, sequence: [] }]]),
        };
        await requestQueuedIndex('clean-1', MACHINE_ID);

        const consumed = await consumePendingIndexRequests(state);

        expect(consumed).toEqual(['clean-1']);
        expect(state.qdrantIndexQueue.has('clean-1')).toBe(true);
        // No indexingState → nothing to reset, and the (absent) state must not
        // be invented.
        expect((state.conversationCache.get('clean-1') as any).metadata.indexingState).toBeUndefined();
    });

    test('a request for a task absent from the leader cache is consumed and enqueued, never thrown', async () => {
        await requestQueuedIndex('ghost-1', MACHINE_ID);

        const state = leaderState();
        const consumed = await consumePendingIndexRequests(state);

        expect(consumed).toEqual(['ghost-1']); // consumed (file cleared)…
        expect(state.conversationCache.has('ghost-1')).toBe(false); // …nothing to reset in cache
        expect(state.qdrantIndexQueue.has('ghost-1')).toBe(true); // …but the requeue stands
        expect(state.deadLetterQueue.has('big-1')).toBe(true); // unrelated state intact
    });

    test('the batch flavour writes N lines in ONE append (cleanup_failed of 100 must not do 100 writes)', async () => {
        await requestQueuedIndexBatch(['r-1', 'r-2', 'r-3'], MACHINE_ID);
        const content = await fs.promises.readFile(requestsPath, 'utf8');
        const lines = content.trim().split('\n');
        expect(lines).toHaveLength(3);
        for (const line of lines) {
            const parsed = JSON.parse(line);
            expect(typeof parsed.taskId).toBe('string');
            expect(typeof parsed.requestedAt).toBe('number');
            expect(typeof parsed.requestedByPid).toBe('number');
        }
    });
});
