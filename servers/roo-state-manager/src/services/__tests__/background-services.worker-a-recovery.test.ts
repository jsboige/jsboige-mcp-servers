/**
 * #2427 — Worker A mid-run leadership recovery (dispatch c0355, GO c.5976330123).
 *
 * The defect (measured live, c.5974617239): `startSkeletonRefreshWorker` was
 * started only in the boot-leader branch of `initializeBackgroundServices`, so
 * the per-tick election in `worker-a-lock.ts` — including its stale-lock steal —
 * was dead code on every follower. A machine whose boot leader died stayed
 * leaderless indefinitely: dead-pid lock never stolen, cursor frozen at the
 * last leader tick, ingestion stops (the 03/10 fleet decrochage).
 *
 * These tests drive the REAL `initializeBackgroundServices` with only the heavy
 * dependencies mocked, and pin the three behaviors the GO decision requires:
 *   T1. a stale lock held by a dead pid is taken by a follower's tick, and the
 *       refresh runs afterwards;
 *   T2. a mid-run leader brings up Worker B exactly once (guarded per process);
 *   T3. a follower's boot leaves the cursor file byte-identical (no write at
 *       all), while a leader's boot persists BOTH cursor fields.
 *
 * The Worker A lock algorithm itself is NOT mocked: the real election runs
 * against the mocked fs, so the steal exercised here is the production path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- fs: path-aware mock. The Worker A lock (roosync-worker-a-leader-*) is
// controlled per test through `workerALockMode` / `workerALockContent`; every
// other write (cursor tmp files, the #2352 indexer lock) succeeds and is
// recorded for the cursor assertions. ---
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
            mkdir: vi.fn().mockResolvedValue(undefined),
            unlink: vi.fn().mockResolvedValue(undefined),
            rename: vi.fn().mockResolvedValue(undefined),
        },
    };
});

vi.mock('../task-indexer.js', () => ({
    TaskIndexer: class {
        async indexTask() { return []; }
        async countPointsByHostOs() { return 0; }
    },
    getHostIdentifier: vi.fn().mockReturnValue('test-host'),
}));

vi.mock('../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: { detectStorageLocations: vi.fn(), analyzeConversation: vi.fn() },
}));

vi.mock('../../utils/claude-storage-detector.js', () => ({
    ClaudeStorageDetector: { detectStorageLocations: vi.fn(), analyzeConversation: vi.fn() },
}));

vi.mock('../task-partition.js', () => ({ shouldIndexTask: vi.fn().mockReturnValue(true) }));

vi.mock('../unified-store/dual-write.js', () => ({
    dualWriteConversationToStore: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../skeleton-cache.service.js', () => ({
    SkeletonCacheService: {
        configure: vi.fn(),
        getInstance: vi.fn(() => ({
            warmCache: vi.fn().mockResolvedValue(undefined),
            getCacheTierStats: vi.fn().mockResolvedValue({ tier1_roo: 0, tier2_claude: 0, tier3_archives: 0, total: 0 }),
        })),
    },
}));

import { promises as fs } from 'fs';
import {
    initializeBackgroundServices,
    SKELETON_REFRESH_INTERVAL_MS,
} from '../background-services.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { ClaudeStorageDetector } from '../../utils/claude-storage-detector.js';
import type { ServerState } from '../state-manager.service.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

const mockFs = fs as unknown as Record<'readdir' | 'readFile' | 'writeFile' | 'stat', ReturnType<typeof vi.fn>>;
const mockRoo = RooStorageDetector as unknown as { detectStorageLocations: ReturnType<typeof vi.fn>; analyzeConversation: ReturnType<typeof vi.fn> };
const mockClaude = ClaudeStorageDetector as unknown as { detectStorageLocations: ReturnType<typeof vi.fn> };

/** > WORKER_A_LOCK_STALE_MS (10 min) — a lock this old is stealable. */
const STALE_MS = 11 * 60 * 1000;

type LockMode = 'acquire' | 'contested';
let workerALockMode: LockMode;
let workerALockContent: { pid: number; timestamp: number };

function wireWorkerALockFs(): void {
    // Only the O_CREAT|O_EXCL create is subject to `contested`; renew and steal
    // are plain writes and must succeed, exactly like the real algorithm.
    mockFs.writeFile.mockImplementation(async (p: any, data: any, opts?: any) => {
        const s = String(p);
        if (s.includes('worker-a-leader') && workerALockMode === 'contested' && opts && (opts as any).flag === 'wx') {
            const err: any = new Error('EEXIST simulated');
            err.code = 'EEXIST';
            throw err;
        }
        return undefined;
    });
    mockFs.readFile.mockImplementation(async (p: any) => {
        if (String(p).includes('worker-a-leader')) {
            return JSON.stringify(workerALockContent);
        }
        return undefined as any; // cursor/blacklist loads → callers' catch → safe defaults
    });
}

function makeState(over?: Partial<ServerState>): ServerState {
    return {
        conversationCache: new Map(),
        qdrantIndexQueue: new Set(),
        qdrantIndexInterval: null,
        skeletonRefreshInterval: null,
        lastSkeletonRefreshAt: 0,
        lastClaudeRefreshAt: 0,
        machineId: 'test-machine-2427',
        fleetRoster: ['test-machine-2427'],
        isQdrantIndexingEnabled: true,
        isWorkerALeader: false,
        isIndexLeader: false,
        // skip the (mocked-TaskIndexer) consistency pass — not what these tests pin
        lastQdrantConsistencyCheck: Date.now(),
        indexingDecisionService: {
            migrateLegacyIndexingState: vi.fn(() => false),
            shouldIndex: vi.fn(() => ({ shouldIndex: false, requiresSave: false })),
        } as any,
        indexingMetrics: { totalTasks: 0, skippedTasks: 0 } as any,
        ...over,
    } as unknown as ServerState;
}

/** A `Dirent`-like entry for readdir({ withFileTypes: true }). */
function dirent(name: string, isDir = true): any {
    return { name, isDirectory: () => isDir };
}

function makeSkeleton(taskId: string): ConversationSkeleton {
    return {
        taskId,
        metadata: {
            title: `Task ${taskId}`,
            lastActivity: '2026-03-01T00:00:00Z',
            createdAt: '2026-03-01T00:00:00Z',
            messageCount: 1,
            actionCount: 0,
            totalSize: 128,
        },
        sequence: [{ role: 'user', content: 'hi' } as any],
    } as ConversationSkeleton;
}

let logs: string[];

beforeEach(() => {
    vi.useFakeTimers();
    logs = [];
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    // sensible defaults; individual tests override
    mockRoo.detectStorageLocations.mockResolvedValue(['/roo/loc1']);
    mockRoo.analyzeConversation.mockResolvedValue(makeSkeleton('task-X'));
    mockClaude.detectStorageLocations.mockResolvedValue([]);
    mockFs.readdir.mockResolvedValue([] as any);
    mockFs.stat.mockResolvedValue({ mtime: new Date('2026-03-01T00:00:00Z') } as any);
    wireWorkerALockFs();
    workerALockMode = 'contested';
    workerALockContent = { pid: 451444, timestamp: Date.now() }; // a live-looking other-pid lock
    delete process.env.ROO_INDEX_FORCE;
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.ROO_INDEX_FORCE;
});

/** Worker B bootstrap counter — the init banner `initializeQdrantIndexingService` logs. */
function workerBInitCount(): number {
    return logs.filter((l) => l.includes("Initialisation du service d'indexation")).length;
}

/** Cursor-file writes observed through the mocked fs (tmp write, pre-rename). */
function cursorWrites(): { path: string; data: string }[] {
    return (mockFs.writeFile.mock.calls as any[][])
        .map((c) => ({ path: String(c[0]), data: String(c[1]) }))
        .filter((w) => w.path.includes('indexer-state'));
}

/** Run the real boot and settle its fire-and-forget chains (no timer advance). */
async function boot(state: ServerState): Promise<void> {
    await initializeBackgroundServices(state);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('#2427 — Worker A mid-run leadership recovery', () => {
    it('T1: a follower steals a stale (dead-pid) lock on its tick and the refresh runs', async () => {
        // Boot as follower — another pid holds a FRESH lock.
        const state = makeState();
        await boot(state);
        expect(state.isWorkerALeader).toBe(false);

        // RED on current code: the follower branch starts nothing, so there is
        // no interval whose tick could ever steal the lock back.
        expect(state.skeletonRefreshInterval).not.toBeNull();

        // The boot leader dies; its lock goes stale. A task was modified since.
        workerALockContent = { pid: 451444, timestamp: Date.now() - STALE_MS };
        mockFs.readdir.mockResolvedValue([dirent('task-R1')] as any);

        await vi.advanceTimersByTimeAsync(SKELETON_REFRESH_INTERVAL_MS);

        expect(state.isWorkerALeader).toBe(true);
        expect(mockRoo.analyzeConversation).toHaveBeenCalled();
        expect(state.conversationCache.has('task-R1')).toBe(true);
    });

    it('T2: a mid-run leader brings up Worker B exactly once', async () => {
        // Boot as follower, then the boot leader dies → steal on the next tick.
        const state = makeState();
        await boot(state);
        workerALockContent = { pid: 451444, timestamp: Date.now() - STALE_MS };
        await vi.advanceTimersByTimeAsync(SKELETON_REFRESH_INTERVAL_MS);
        expect(state.isWorkerALeader).toBe(true);

        // RED on current code: nothing brings up Worker B on a mid-run leader —
        // it would refresh skeletons forever without ever indexing.
        expect(state.qdrantIndexInterval).not.toBeNull();
        expect(workerBInitCount()).toBe(1);

        // Step down (another live pid renewed over us), then become leader again:
        // the once-per-process guard must not re-pay the startup stack.
        workerALockContent = { pid: 777777, timestamp: Date.now() };
        await vi.advanceTimersByTimeAsync(SKELETON_REFRESH_INTERVAL_MS);
        expect(state.isWorkerALeader).toBe(false);

        workerALockContent = { pid: 777777, timestamp: Date.now() - STALE_MS };
        await vi.advanceTimersByTimeAsync(SKELETON_REFRESH_INTERVAL_MS);
        expect(state.isWorkerALeader).toBe(true);
        expect(workerBInitCount()).toBe(1); // still exactly once
    });

    it('T2b: a boot leader pays the startup stack once — step-down/re-become does not re-pay it', async () => {
        workerALockMode = 'acquire';
        const state = makeState();
        await boot(state);
        expect(state.isWorkerALeader).toBe(true);
        expect(workerBInitCount()).toBe(1);
        expect(state.qdrantIndexInterval).not.toBeNull();

        workerALockMode = 'contested';
        workerALockContent = { pid: 777777, timestamp: Date.now() };
        await vi.advanceTimersByTimeAsync(SKELETON_REFRESH_INTERVAL_MS); // renew fails → stepped down
        expect(state.isWorkerALeader).toBe(false);

        workerALockContent = { pid: 777777, timestamp: Date.now() - STALE_MS };
        await vi.advanceTimersByTimeAsync(SKELETON_REFRESH_INTERVAL_MS); // steal → leader again
        expect(state.isWorkerALeader).toBe(true);
        expect(workerBInitCount()).toBe(1); // guard holds
    });

    it("T3: a follower's boot leaves the cursor file byte-identical — no write at all", async () => {
        const state = makeState();
        await boot(state);
        expect(state.isWorkerALeader).toBe(false);

        // RED on current code: every host (follower included) stamps and
        // persists the cursor at the end of its skeleton load — one-arg, which
        // also erases lastClaudeRefreshAt from the file.
        expect(cursorWrites()).toEqual([]);
    });

    it("T3 companion: a leader's boot persists BOTH cursor fields", async () => {
        workerALockMode = 'acquire';
        const state = makeState();
        await boot(state);
        expect(state.isWorkerALeader).toBe(true);

        const writes = cursorWrites();
        expect(writes.length).toBeGreaterThan(0);
        const payload = JSON.parse(writes[writes.length - 1].data);
        expect(typeof payload.lastSkeletonRefreshAt).toBe('number');
        // RED on current code: the boot persist is one-arg — the Claude cursor
        // field is absent from the payload.
        expect(typeof payload.lastClaudeRefreshAt).toBe('number');
    });
});
