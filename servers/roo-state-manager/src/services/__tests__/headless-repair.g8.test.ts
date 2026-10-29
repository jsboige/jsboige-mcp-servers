/**
 * #4352 g8 — headless repair: a `success` task named by the g7 scan can be
 * re-indexed without wiping its success state.
 *
 * Measured defect (po-2023, 28/10, #4352 c.6474732107): a requeue via
 * `roosync_indexing(index)` healed exactly the `was_failed:true` tasks of the
 * sample and moved ZERO points on the `was_failed:false` ones. The path is
 * two-guarded: the consumer resets only `failed`/`retry` (ms#1546 review
 * guard — a delegated index on a healthy task must not wipe its success
 * state), and shouldIndex then skips a `success` task on active TTL or
 * unchanged content (indexing-decision.ts). The headless holes living on
 * `success` tasks were therefore permanent.
 *
 * The fix rides the g3/g6 transport with a request marker `repair:"headless"`:
 * the consumer ARMS a one-shot bypass (armHeadlessRepair — success state kept,
 * `lastResetAt` refreshed so the armed state is provably newer than a stale
 * writer's, same two-writer arbitration g6 relies on), shouldIndex honours the
 * marker exactly once, and both completion markers delete it.
 *
 * These tests run the REAL follower→leader path against real files (no mocked
 * saveSkeletonCallback) and assert the exact cases the dispatch asked for:
 * - the marker survives a stale Worker A rewrite (two writers, like g6);
 * - positive control: the bypass flips the skip to index, once;
 * - negative control: a task WITHOUT the marker stays skipped.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    getIndexRequestsPath,
    requestQueuedIndex,
    hasPendingIndexRequests,
    consumePendingIndexRequests,
    saveSkeletonIndex,
} from '../background-services.js';
import { IndexingDecisionService } from '../indexing-decision.js';

// Point the storage detector at a per-run tmpdir so the test never touches
// this machine's real _skeleton_index.json (same harness as the g6 tests).
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `g8-repair-${process.pid}-`));
vi.mock('../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectStorageLocations: async () => [TEST_DIR],
    },
}));

const MACHINE_ID = `g8-test-${process.pid}`;

/**
 * The exact shape the c.643 sample measured immobile: `success`, TTL active,
 * content unchanged since lastIndexedAt — both success skips fire, and the
 * task is NOT noise (messageCount/size above the noise thresholds).
 */
const headlessSuccessSkeleton = (taskId: string) => ({
    taskId,
    metadata: {
        lastActivity: '2026-09-20T10:00:00.000Z',
        createdAt: '2026-09-19T10:00:00.000Z',
        messageCount: 42,
        actionCount: 12,
        totalSize: 512000,
        indexingState: {
            indexStatus: 'success',
            // lastIndexedAt AFTER lastActivity → "contenu inchangé"
            lastIndexedAt: '2026-10-01T10:00:00.000Z',
            lastIndexAttempt: '2026-10-01T10:00:00.000Z',
            // TTL actif — far future
            nextReindexAfter: '2999-01-01T00:00:00.000Z',
        },
    },
    sequence: [],
});

const leaderState = () => ({
    machineId: MACHINE_ID,
    conversationCache: new Map<string, any>([
        ['head-1', headlessSuccessSkeleton('head-1')],
        ['head-2', headlessSuccessSkeleton('head-2')],
    ]),
    qdrantIndexQueue: new Set<string>(),
    deadLetterQueue: new Set<string>(),
    deadLetterDetails: new Map(),
});

describe('#4352 g8 — headless repair marker (decision + consume + two writers)', () => {
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

    describe('decision — the bypass flips the skip, exactly once', () => {
        let service: IndexingDecisionService;

        beforeEach(() => {
            // Same env hygiene as indexing-decision.test.ts: ROO_INDEX_FORCE
            // would bypass everything and void the negative control.
            delete process.env.ROO_INDEX_FORCE;
            delete process.env.ROO_INDEX_VERSION;
            service = new IndexingDecisionService();
        });

        test('NEGATIVE CONTROL: no marker → the success task stays skipped (TTL actif)', () => {
            const decision = service.shouldIndex(headlessSuccessSkeleton('head-1'));
            expect(decision.shouldIndex).toBe(false);
            expect(decision.action).toBe('skip');
            expect(decision.reason).toMatch(/TTL/);
        });

        test('POSITIVE CONTROL: repair:"headless" armed → index, and the success skips are the ones bypassed', () => {
            const skeleton = headlessSuccessSkeleton('head-1');
            service.armHeadlessRepair(skeleton);
            const decision = service.shouldIndex(skeleton);
            expect(decision.shouldIndex).toBe(true);
            expect(decision.action).toBe('index');
            expect(decision.reason).toMatch(/g8 repair/);
        });

        test('ONE-SHOT: markIndexingSuccess consumes the marker — the next decision skips again', () => {
            const skeleton = headlessSuccessSkeleton('head-1');
            service.armHeadlessRepair(skeleton);
            service.markIndexingSuccess(skeleton);
            const st = skeleton.metadata.indexingState;
            expect(st.repair).toBeUndefined();
            expect(st.indexStatus).toBe('success');
            // And the task is back under the normal rules.
            expect(service.shouldIndex(skeleton).shouldIndex).toBe(false);
        });

        test('ONE-SHOT on failure too: markIndexingFailure consumes the marker', () => {
            const skeleton = headlessSuccessSkeleton('head-1');
            service.armHeadlessRepair(skeleton);
            service.markIndexingFailure(skeleton, 'boom', true);
            expect(skeleton.metadata.indexingState.repair).toBeUndefined();
            expect(skeleton.metadata.indexingState.indexStatus).toBe('failed');
        });

        test('armHeadlessRepair does NOT wipe the success state (the anti-reset property)', () => {
            const skeleton = headlessSuccessSkeleton('head-1');
            service.armHeadlessRepair(skeleton);
            const st = skeleton.metadata.indexingState;
            expect(st.indexStatus).toBe('success');
            expect(st.lastIndexedAt).toBe('2026-10-01T10:00:00.000Z');
            expect(st.repair).toBe('headless');
            expect(typeof st.lastResetAt).toBe('string');
        });
    });

    describe('consume — the leader arms ITS OWN cache, persists, enqueues', () => {
        test('END STATE: marked request → success kept, repair armed, persisted to _skeleton_index.json, enqueued', async () => {
            await requestQueuedIndex('head-1', MACHINE_ID, 'headless');
            expect(await hasPendingIndexRequests(MACHINE_ID)).toBe(true);

            const state = leaderState();
            const consumed = await consumePendingIndexRequests(state);

            expect(consumed).toEqual(['head-1']);
            expect(state.qdrantIndexQueue.has('head-1')).toBe(true);
            const st = (state.conversationCache.get('head-1') as any).metadata.indexingState;
            expect(st.indexStatus).toBe('success');      // NOT reset
            expect(st.repair).toBe('headless');          // bypass armed
            expect(typeof st.lastResetAt).toBe('string');

            // The armed marker reached the index file (fire-and-forget save → wait).
            const indexPath = path.join(TEST_DIR, 'tasks', '.skeletons', '_skeleton_index.json');
            await vi.waitFor(async () => {
                const index = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
                const entry = index.entries.find((e: any) => e.taskId === 'head-1');
                expect(entry?.metadata?.indexingState?.repair).toBe('headless');
                expect(entry?.metadata?.indexingState?.indexStatus).toBe('success');
            });
        });

        test('NEGATIVE CONTROL: unmarked request on the same-shaped task → state untouched, still enqueued', async () => {
            await requestQueuedIndex('head-2', MACHINE_ID);
            const state = leaderState();
            const consumed = await consumePendingIndexRequests(state);

            expect(consumed).toEqual(['head-2']);
            expect(state.qdrantIndexQueue.has('head-2')).toBe(true);
            const st = (state.conversationCache.get('head-2') as any).metadata.indexingState;
            expect(st.indexStatus).toBe('success');
            expect(st.repair).toBeUndefined();
            expect(st.lastResetAt).toBeUndefined();
            expect(st.lastIndexedAt).toBe('2026-10-01T10:00:00.000Z');
        });

        test('the marker survives a DEFERRED request (task not yet in the leader cache)', async () => {
            await requestQueuedIndex('ghost-1', MACHINE_ID, 'headless');
            const state = leaderState();
            const consumed = await consumePendingIndexRequests(state);

            expect(consumed).toEqual([]);
            const lines = (await fs.promises.readFile(requestsPath, 'utf8')).trim().split('\n');
            expect(lines).toHaveLength(1);
            const parsed = JSON.parse(lines[0]);
            expect(parsed.taskId).toBe('ghost-1');
            expect(parsed.repair).toBe('headless'); // the deferred line keeps the marker
        });
    });

    describe('two writers — the armed marker must not be dropped', () => {
        test('a stale Worker A save (old success, no marker) does not undo the armed repair on disk', async () => {
            // 1. The indexing leader consumes the marked request and persists it.
            await requestQueuedIndex('head-1', MACHINE_ID, 'headless');
            const cacheA = leaderState();
            await consumePendingIndexRequests(cacheA);

            const indexPath = path.join(TEST_DIR, 'tasks', '.skeletons', '_skeleton_index.json');
            await vi.waitFor(async () => {
                const index = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
                const entry = index.entries.find((e: any) => e.taskId === 'head-1');
                expect(entry?.metadata?.indexingState?.repair).toBe('headless');
            });

            // 2. Worker A still holds the OLD success state (no marker, older
            //    lastIndexedAt) and rewrites the whole file from its own cache —
            //    the exact second-writer clobber g6 measured on ai-01.
            const staleA = new Map<string, any>([
                ['head-1', headlessSuccessSkeleton('head-1')],
            ]);
            await saveSkeletonIndex(staleA);

            // 3. The armed marker survived: the on-disk state is newer than A's cache.
            const after = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
            const kept = after.entries.find((e: any) => e.taskId === 'head-1');
            expect(kept.metadata.indexingState.repair).toBe('headless');
            expect(typeof kept.metadata.indexingState.lastResetAt).toBe('string');
        });

        test('no resurrection: a CONSUMED marker (cache newer) beats a stale disk copy still carrying it', async () => {
            // 1. Arm on disk (as above).
            await requestQueuedIndex('head-1', MACHINE_ID, 'headless');
            const cacheA = leaderState();
            await consumePendingIndexRequests(cacheA);
            const indexPath = path.join(TEST_DIR, 'tasks', '.skeletons', '_skeleton_index.json');
            await vi.waitFor(async () => {
                const index = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
                expect(index.entries.find((e: any) => e.taskId === 'head-1')?.metadata?.indexingState?.repair).toBe('headless');
            });

            // 2. The drain happens: completion consumes the marker (newer
            //    lastIndexAttempt than the armed state).
            const completed = cacheA.conversationCache.get('head-1') as any;
            new IndexingDecisionService().markIndexingSuccess(completed);
            await saveSkeletonIndex(cacheA.conversationCache);

            // 3. On-disk: marker gone, success state fresh — a stale reader that
            //    later re-saves the OLD armed copy cannot resurrect the bypass,
            //    because the completed state is newer.
            const after = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
            const kept = after.entries.find((e: any) => e.taskId === 'head-1');
            expect(kept.metadata.indexingState.repair).toBeUndefined();
            expect(kept.metadata.indexingState.indexStatus).toBe('success');
        });

        // ai-01 CHANGES (28/10): the test above re-reads the file it just saved —
        // it never exercises a stale writer that CARRIES the marker re-saving
        // after completion. This is that direction: Worker B still holds the
        // armed copy, completion already won on disk, B saves last — recency
        // (not write order) must keep the consumed state.
        test('no resurrection, REAL direction: a stale writer still carrying the armed marker saves AFTER completion', async () => {
            // 1. Arm on disk and snapshot the armed entry — Worker B's cache.
            await requestQueuedIndex('head-1', MACHINE_ID, 'headless');
            const cacheA = leaderState();
            await consumePendingIndexRequests(cacheA);
            const indexPath = path.join(TEST_DIR, 'tasks', '.skeletons', '_skeleton_index.json');
            await vi.waitFor(async () => {
                const index = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
                expect(index.entries.find((e: any) => e.taskId === 'head-1')?.metadata?.indexingState?.repair).toBe('headless');
            });
            const workerBCache = new Map<string, any>([
                ['head-1', JSON.parse(JSON.stringify(cacheA.conversationCache.get('head-1')))],
            ]);
            // Determinism, not realism surgery: a stale writer's state is
            // definitionally OLDER, but the ISO stamps are millisecond-granular
            // and arm→complete can land in the same ms (the merge then keeps
            // the writer's own copy by the `<=` branch). Backdating B's stamps
            // by 1s pins the race direction the invariant is about.
            const bState = workerBCache.get('head-1').metadata.indexingState;
            bState.lastResetAt = new Date(Date.parse(bState.lastResetAt) - 1000).toISOString();

            // 2. Completion consumes the marker and persists (recency = now).
            const completed = cacheA.conversationCache.get('head-1') as any;
            new IndexingDecisionService().markIndexingSuccess(completed);
            await saveSkeletonIndex(cacheA.conversationCache);
            const afterCompletion = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
            expect(afterCompletion.entries.find((e: any) => e.taskId === 'head-1')?.metadata?.indexingState?.repair).toBeUndefined();

            // 3. Worker B re-saves its armed copy LAST — the marker must not
            //    come back: the on-disk completed state is strictly newer.
            await saveSkeletonIndex(workerBCache);
            const final = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
            const kept = final.entries.find((e: any) => e.taskId === 'head-1');
            expect(kept.metadata.indexingState.repair).toBeUndefined();
            expect(kept.metadata.indexingState.indexStatus).toBe('success');
        });
    });
});
