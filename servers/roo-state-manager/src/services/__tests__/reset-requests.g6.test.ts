/**
 * #4352 g6 — cleanup_failed resets must reach the leader.
 *
 * Measured defect (ai-01, 28/10, c.6460088328): a cleanup_failed reset lived
 * only in the memory of the process that ran it. `saveSkeletonToDisk` returns
 * silently for claude-* skeletons (guard #1325 — header-only, no per-task
 * file), and the leader rewrites `_skeleton_index.json` from ITS OWN cache,
 * where the task is still `failed`. The requeue of 01:43Z reported
 * `[EXECUTED] reset=100`; only 1 of 100 was retried, retry_count stayed 3-6.
 *
 * The fix rides the g3 transport: the reset is persisted as a `reset` request
 * in the machine-local request file; the leader's tick consumes it, resets ITS
 * OWN cache copy, lifts ITS OWN dead-letter pin, and persists the reset into
 * `_skeleton_index.json` (direct saveSkeletonIndex — the refresh-path save is
 * conditional on updatedCount>0 and cannot be waited on).
 *
 * This test runs the REAL follower→leader path against real files — no mocked
 * saveSkeletonCallback, no mocked request primitives — and asserts the END
 * STATE the dispatch asked for: the leader's cache is reset, the pin is
 * lifted, the index file on disk carries the reset.
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

describe('#4352 g6 — cleanup_failed resets via the request file (follower → leader)', () => {
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

    test('END STATE: leader cache reset, pin lifted, NOT enqueued, reset persisted into _skeleton_index.json', async () => {
        // 1. Follower (another process) persists a reset request — the batch
        //    flavour one cleanup_failed actually uses.
        await requestQueuedIndexBatch(['big-1'], MACHINE_ID, 'reset');
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
        // Reset ≠ enqueue: the refresh scan requeues transient classes itself.
        expect(state.qdrantIndexQueue.size).toBe(0);
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

    test('a legacy line WITHOUT kind (pre-g6, in flight during the rollout) is consumed as an index request', async () => {
        await fs.promises.appendFile(
            requestsPath,
            JSON.stringify({ taskId: 'legacy-1', requestedAt: Date.now(), requestedByPid: 1 }) + '\n'
        );

        const state = leaderState();
        const consumed = await consumePendingIndexRequests(state);

        expect(consumed).toEqual(['legacy-1']);
        // Index semantics: enqueued, and the dead-letter pin lifted.
        expect(state.qdrantIndexQueue.has('legacy-1')).toBe(true);
        expect(state.deadLetterQueue.has('big-1')).toBe(true); // untouched — this was not its request
    });

    test('a reset for a task absent from the leader cache is skipped, never thrown', async () => {
        await requestQueuedIndex('ghost-1', MACHINE_ID, 'reset');

        const state = leaderState();
        const consumed = await consumePendingIndexRequests(state);

        expect(consumed).toEqual(['ghost-1']); // consumed (file cleared)…
        expect(state.conversationCache.has('ghost-1')).toBe(false); // …but nothing to apply
        expect(state.qdrantIndexQueue.size).toBe(0);
        expect(state.deadLetterQueue.has('big-1')).toBe(true); // unrelated state intact
    });

    test('the batch flavour writes N lines in ONE append (cleanup_failed of 100 must not do 100 writes)', async () => {
        await requestQueuedIndexBatch(['r-1', 'r-2', 'r-3'], MACHINE_ID, 'reset');
        const content = await fs.promises.readFile(requestsPath, 'utf8');
        const lines = content.trim().split('\n');
        expect(lines).toHaveLength(3);
        for (const line of lines) {
            const parsed = JSON.parse(line);
            expect(parsed.kind).toBe('reset');
            expect(typeof parsed.taskId).toBe('string');
        }
    });
});
