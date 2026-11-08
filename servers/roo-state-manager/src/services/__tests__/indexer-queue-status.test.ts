/**
 * Tests for #4352 W4 (file ai-01 2026-11-08a, item 2): leader-published
 * indexer queue observability.
 *
 * The leader's qdrantIndexQueue is an in-memory Set only it drains; a
 * follower's `status` therefore cannot see the machine's real queue. The fix
 * publishes the leader's numbers to a machine-local JSON file
 * (roosync-indexer-status-<machineId>.json, same keying as the leader lock).
 *
 * These tests run against the REAL filesystem (a per-test machineId sandboxed
 * in os.tmpdir()), because the two properties that matter are only provable
 * on disk: the tmp+rename write (a concurrent reader never sees a truncated
 * JSON — no .tmp- leftover means the rename completed) and the never-throws
 * contract of the writer (observability must not kill the indexing tick).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ServerState } from '../state-manager.service.js';
import {
    getIndexerQueueStatusPath,
    noteIndexEnqueue,
    writeIndexerQueueStatus,
    readIndexerQueueStatus,
} from '../background-services.js';

/** Per-run sandbox id: never collides with the status file of any REAL RSM
 *  process on this machine (their machineId is a hostname, never this). */
const BASE_ID = `w4test-pid${process.pid}`;
const usedMachineIds = new Set<string>([BASE_ID]);

function sandboxId(suffix: string): string {
    const id = `${BASE_ID}-${suffix}`;
    usedMachineIds.add(id);
    return id;
}

interface MinimalState {
    machineId: string;
    qdrantIndexQueue: Set<string>;
    qdrantIndexOldestEnqueuedAt?: number | null;
    qdrantIndexLastIndexedAt?: number | null;
}

function makeState(overrides: Partial<MinimalState> = {}): ServerState {
    const state: MinimalState = {
        machineId: BASE_ID,
        qdrantIndexQueue: new Set<string>(),
        qdrantIndexOldestEnqueuedAt: null,
        qdrantIndexLastIndexedAt: null,
        ...overrides,
    };
    // The writer only reads these four fields; ServerState is structural here.
    return state as unknown as ServerState;
}

afterEach(async () => {
    for (const id of usedMachineIds) {
        const statusPath = await getIndexerQueueStatusPath(id);
        // status file, possible .tmp- leftover, or the directory used by the
        // never-throws test — fs.rm handles all three shapes.
        await fs.rm(statusPath, { recursive: true, force: true }).catch(() => {});
        await fs.rm(`${statusPath}.tmp-${process.pid}`, { force: true }).catch(() => {});
    }
});

describe('#4352 W4 — writeIndexerQueueStatus / readIndexerQueueStatus', () => {
    it('round-trips the leader queue state and leaves no .tmp- leftover', async () => {
        const oldest = Date.now() - 120_000;
        const last = Date.now() - 30_000;
        const state = makeState({
            qdrantIndexQueue: new Set(['task-a', 'task-b', 'task-c']),
            qdrantIndexOldestEnqueuedAt: oldest,
            qdrantIndexLastIndexedAt: last,
        });
        await writeIndexerQueueStatus(state);

        const read = await readIndexerQueueStatus(BASE_ID);
        expect(read).not.toBeNull();
        expect(read!.pid).toBe(process.pid);
        expect(read!.queueSize).toBe(3);
        expect(read!.oldestEnqueuedAt).toBe(oldest);
        expect(read!.lastIndexedAt).toBe(last);
        expect(read!.machineId).toBe(BASE_ID);
        expect(read!.intervalMs).toBeGreaterThan(0);
        // Freshly written → not stale, and the reader-computed age is small.
        expect(read!.stale).toBe(false);
        expect(read!.ageMs).toBeGreaterThanOrEqual(0);
        expect(read!.ageMs).toBeLessThan(10_000);
        // tmp+rename: the intermediate file must be gone once the write returns.
        const statusPath = await getIndexerQueueStatusPath(BASE_ID);
        await expect(fs.access(`${statusPath}.tmp-${process.pid}`)).rejects.toThrow();
    });

    it('publishes explicit null markers as null (optional fields absent)', async () => {
        await writeIndexerQueueStatus(makeState({
            qdrantIndexQueue: new Set(),
            qdrantIndexOldestEnqueuedAt: null,
            qdrantIndexLastIndexedAt: null,
        }));
        const read = await readIndexerQueueStatus(BASE_ID);
        expect(read).not.toBeNull();
        expect(read!.queueSize).toBe(0);
        expect(read!.oldestEnqueuedAt).toBeNull();
        expect(read!.lastIndexedAt).toBeNull();
    });

    it('returns null when no status file exists (leader on an older build, or none since boot)', async () => {
        expect(await readIndexerQueueStatus(sandboxId('never-written'))).toBeNull();
    });

    it('returns null on a corrupt (unparseable) status file', async () => {
        const id = sandboxId('corrupt');
        const statusPath = await getIndexerQueueStatusPath(id);
        await fs.writeFile(statusPath, '{"pid": 12', 'utf-8'); // truncated JSON
        expect(await readIndexerQueueStatus(id)).toBeNull();
    });

    it('returns null when required fields have the wrong type', async () => {
        const id = sandboxId('badtypes');
        const statusPath = await getIndexerQueueStatusPath(id);
        await fs.writeFile(statusPath, JSON.stringify({
            pid: 'not-a-number',
            queueSize: 1,
            updatedAt: Date.now(),
            intervalMs: 60_000,
        }), 'utf-8');
        expect(await readIndexerQueueStatus(id)).toBeNull();

        await fs.writeFile(statusPath, JSON.stringify({
            pid: 1234,
            // queueSize missing entirely
            updatedAt: Date.now(),
            intervalMs: 60_000,
        }), 'utf-8');
        expect(await readIndexerQueueStatus(id)).toBeNull();
    });

    it('computes stale = ageMs > 3 × intervalMs', async () => {
        const id = sandboxId('stale');
        const statusPath = await getIndexerQueueStatusPath(id);
        const writePayload = async (updatedAt: number) => {
            await fs.writeFile(statusPath, JSON.stringify({
                machineId: id,
                pid: 424242,
                queueSize: 2,
                oldestEnqueuedAt: null,
                lastIndexedAt: null,
                updatedAt,
                intervalMs: 60_000,
            }), 'utf-8');
        };

        // 4 × interval old → stale.
        await writePayload(Date.now() - 4 * 60_000);
        let read = await readIndexerQueueStatus(id);
        expect(read).not.toBeNull();
        expect(read!.stale).toBe(true);

        // 1 × interval old → fresh.
        await writePayload(Date.now() - 60_000);
        read = await readIndexerQueueStatus(id);
        expect(read).not.toBeNull();
        expect(read!.stale).toBe(false);
    });

    it('falls back to a 60s interval when the payload carries intervalMs ≤ 0', async () => {
        const id = sandboxId('zero-interval');
        const statusPath = await getIndexerQueueStatusPath(id);
        const writePayload = async (updatedAt: number) => {
            await fs.writeFile(statusPath, JSON.stringify({
                machineId: id,
                pid: 424242,
                queueSize: 0,
                oldestEnqueuedAt: null,
                lastIndexedAt: null,
                updatedAt,
                intervalMs: 0,
            }), 'utf-8');
        };

        // 61s old: below the 3 × 60s fallback threshold → not stale.
        await writePayload(Date.now() - 61_000);
        let read = await readIndexerQueueStatus(id);
        expect(read).not.toBeNull();
        expect(read!.intervalMs).toBe(60_000);
        expect(read!.stale).toBe(false);

        // 200s old: above the fallback threshold → stale.
        await writePayload(Date.now() - 200_000);
        read = await readIndexerQueueStatus(id);
        expect(read).not.toBeNull();
        expect(read!.stale).toBe(true);
    });

    it('never throws when the target cannot be written (directory in the way)', async () => {
        const id = sandboxId('blocked');
        const statusPath = await getIndexerQueueStatusPath(id);
        await fs.mkdir(statusPath); // rename onto an existing directory fails
        // The writer must resolve (warn internally), never reject — an
        // observability publish must not be able to kill the indexing tick.
        await expect(writeIndexerQueueStatus(makeState({ machineId: id }))).resolves.toBeUndefined();
    });
});

describe('#4352 W4 — noteIndexEnqueue marker semantics', () => {
    it('stamps the marker when the queue was empty', () => {
        const state = makeState({ qdrantIndexOldestEnqueuedAt: null });
        const before = Date.now();
        noteIndexEnqueue(state);
        expect(state.qdrantIndexOldestEnqueuedAt).not.toBeNull();
        expect(state.qdrantIndexOldestEnqueuedAt!).toBeGreaterThanOrEqual(before);
    });

    it('keeps the existing marker when the queue is non-empty (partial drain stays conservative)', () => {
        const original = Date.now() - 300_000; // 5 min old
        const state = makeState({
            qdrantIndexQueue: new Set(['survivor']),
            qdrantIndexOldestEnqueuedAt: original,
        });
        noteIndexEnqueue(state);
        // Not overwritten: the true oldest surviving item is OLDER than the
        // marker, so resetting it would claim younger than reality.
        expect(state.qdrantIndexOldestEnqueuedAt).toBe(original);
    });

    it('re-stamps once the queue has emptied again (after a full drain)', () => {
        const drainedLongAgo = Date.now() - 600_000;
        const state = makeState({
            qdrantIndexQueue: new Set<string>(), // drained
            qdrantIndexOldestEnqueuedAt: drainedLongAgo,
        });
        noteIndexEnqueue(state);
        expect(state.qdrantIndexOldestEnqueuedAt!).toBeGreaterThan(drainedLongAgo);
    });
});
