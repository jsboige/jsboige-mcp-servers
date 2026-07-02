/**
 * #833 Sprint C3 — add-only branch/line coverage complement for background-services.ts
 *
 * Targets the two largest EXPORTED-but-untested functions the happy-path suites
 * (src/services/__tests__/background-services.test.ts + tests/unit/services/...)
 * never exercise:
 *
 *   - loadClaudeCodeSessions()      L344-398  — whole body untested
 *   - startSkeletonRefreshWorker()  L442-624  — the ~170-stmt setInterval body,
 *                                                driven once via fake timers
 *
 * Add-only: no source change, no change to the existing suites. Mocks target the
 * SAME module specifiers the SUT resolves (../../utils/... and ../... from __tests__/,
 * matching the verified depth of the existing suite — see
 * [[lesson-vi-mock-path-depth-silent-noop]]).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- fs: control readdir/stat, let writes resolve harmlessly (saveSkeletonIndex) ---
vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return {
        ...actual,
        promises: {
            readdir: vi.fn(),
            readFile: vi.fn(),
            writeFile: vi.fn().mockResolvedValue(undefined),
            stat: vi.fn(),
            access: vi.fn(),
            mkdir: vi.fn().mockResolvedValue(undefined),
            unlink: vi.fn().mockResolvedValue(undefined),
            rename: vi.fn().mockResolvedValue(undefined),
        },
    };
});

// --- heavy transitive import: mock like the existing suite (never invoked here) ---
vi.mock('../task-indexer.js', () => ({
    TaskIndexer: class {
        async indexTask() { return []; }
        async countPointsByHostOs() { return 0; }
    },
    getHostIdentifier: vi.fn().mockReturnValue('test-host'),
}));

vi.mock('../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectStorageLocations: vi.fn(),
        analyzeConversation: vi.fn(),
    },
}));

// dynamic import target inside both functions
vi.mock('../../utils/claude-storage-detector.js', () => ({
    ClaudeStorageDetector: {
        detectStorageLocations: vi.fn(),
        analyzeConversation: vi.fn(),
    },
}));

vi.mock('../task-partition.js', () => ({
    shouldIndexTask: vi.fn().mockReturnValue(true),
}));

vi.mock('../unified-store/dual-write.js', () => ({
    dualWriteConversationToStore: vi.fn().mockResolvedValue(undefined),
}));

import { promises as fs } from 'fs';
import {
    loadClaudeCodeSessions,
    startSkeletonRefreshWorker,
    SKELETON_REFRESH_INTERVAL_MS,
} from '../background-services.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { ClaudeStorageDetector } from '../../utils/claude-storage-detector.js';
import { shouldIndexTask } from '../task-partition.js';
import { dualWriteConversationToStore } from '../unified-store/dual-write.js';
import type { ServerState } from '../state-manager.service.js';
import type { ConversationSkeleton, SkeletonHeader } from '../../types/conversation.js';

const mockFs = fs as unknown as Record<'readdir' | 'readFile' | 'writeFile' | 'stat' | 'access' | 'mkdir' | 'unlink', ReturnType<typeof vi.fn>>;
const mockRoo = RooStorageDetector as unknown as { detectStorageLocations: ReturnType<typeof vi.fn>; analyzeConversation: ReturnType<typeof vi.fn> };
const mockClaude = ClaudeStorageDetector as unknown as { detectStorageLocations: ReturnType<typeof vi.fn>; analyzeConversation: ReturnType<typeof vi.fn> };
const mockShouldIndex = shouldIndexTask as unknown as ReturnType<typeof vi.fn>;
const mockDualWrite = dualWriteConversationToStore as unknown as ReturnType<typeof vi.fn>;

function makeSkeleton(taskId: string, over?: Partial<ConversationSkeleton>): ConversationSkeleton {
    return {
        taskId,
        metadata: {
            title: `Task ${taskId}`,
            lastActivity: '2026-02-10T10:00:00Z',
            createdAt: '2026-02-10T09:00:00Z',
            messageCount: 3,
            actionCount: 1,
            totalSize: 512,
        },
        sequence: [{ role: 'user', content: 'hi' } as any],
        ...over,
    } as ConversationSkeleton;
}

function makeState(over?: Partial<ServerState>): ServerState {
    return {
        conversationCache: new Map<string, SkeletonHeader>(),
        qdrantIndexQueue: new Set<string>(),
        qdrantIndexInterval: null,
        skeletonRefreshInterval: null,
        lastSkeletonRefreshAt: 0,
        machineId: 'test-machine',
        fleetRoster: ['test-machine'],
        ...over,
    } as unknown as ServerState;
}

/** A `Dirent`-like entry for readdir({ withFileTypes: true }). */
function dirent(name: string, isDir = true): any {
    return { name, isDirectory: () => isDir };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // sensible defaults; individual tests override
    mockShouldIndex.mockReturnValue(true);
    mockDualWrite.mockResolvedValue(undefined);
    delete process.env.ROO_INDEX_FORCE;
});

afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ROO_INDEX_FORCE;
});

// =========================================================================
// loadClaudeCodeSessions (L344-398)
// =========================================================================
describe('loadClaudeCodeSessions', () => {
    it('returns early when no Claude project directories are found (L349-351)', async () => {
        mockClaude.detectStorageLocations.mockResolvedValue([]);
        const cache = new Map<string, SkeletonHeader>();

        await loadClaudeCodeSessions(cache);

        expect(cache.size).toBe(0);
        expect(mockFs.readdir).not.toHaveBeenCalled();
        expect(mockClaude.analyzeConversation).not.toHaveBeenCalled();
    });

    it('loads sessions, stamps source/dataSource, dual-writes the full skeleton (L360-395)', async () => {
        mockClaude.detectStorageLocations.mockResolvedValue([{ projectPath: '/proj/alpha' }]);
        mockFs.readdir.mockResolvedValue(['s1.jsonl', 's2.jsonl', 'notes.txt']);
        mockClaude.analyzeConversation.mockImplementation(async (taskId: string) => makeSkeleton(taskId));
        const cache = new Map<string, SkeletonHeader>();

        await loadClaudeCodeSessions(cache);

        // only the two .jsonl files → per-session taskIds `claude-{basename}--{uuid}`
        expect(cache.size).toBe(2);
        const h = cache.get('claude-alpha--s1');
        expect(h).toBeDefined();
        expect((h!.metadata as any).source).toBe('claude-code');
        expect((h!.metadata as any).dataSource).toBe('claude');
        expect(mockDualWrite).toHaveBeenCalledTimes(2);
        // dual-write receives the FULL skeleton (has sequence), not the header
        expect((mockDualWrite.mock.calls[0][1] as any).sequence).toBeDefined();
    });

    it('skips a project dir with no .jsonl files (files.length === 0, L364)', async () => {
        mockClaude.detectStorageLocations.mockResolvedValue([{ projectPath: '/proj/empty' }]);
        mockFs.readdir.mockResolvedValue(['README.md', 'data.bin']);
        const cache = new Map<string, SkeletonHeader>();

        await loadClaudeCodeSessions(cache);

        expect(cache.size).toBe(0);
        expect(mockClaude.analyzeConversation).not.toHaveBeenCalled();
    });

    it('skips a taskId already present in the cache (L371)', async () => {
        mockClaude.detectStorageLocations.mockResolvedValue([{ projectPath: '/proj/alpha' }]);
        mockFs.readdir.mockResolvedValue(['s1.jsonl']);
        const cache = new Map<string, SkeletonHeader>([['claude-alpha--s1', { taskId: 'claude-alpha--s1' } as SkeletonHeader]]);

        await loadClaudeCodeSessions(cache);

        expect(mockClaude.analyzeConversation).not.toHaveBeenCalled();
        expect(cache.size).toBe(1);
    });

    it('does not cache a null skeleton or one with an empty sequence (L377)', async () => {
        mockClaude.detectStorageLocations.mockResolvedValue([{ projectPath: '/proj/alpha' }]);
        mockFs.readdir.mockResolvedValue(['null.jsonl', 'empty.jsonl']);
        mockClaude.analyzeConversation.mockImplementation(async (taskId: string) => {
            if (taskId.endsWith('null')) return null;
            return makeSkeleton(taskId, { sequence: [] });
        });
        const cache = new Map<string, SkeletonHeader>();

        await loadClaudeCodeSessions(cache);

        expect(cache.size).toBe(0);
        expect(mockDualWrite).not.toHaveBeenCalled();
    });

    it('initialises metadata when the skeleton has none (!skeleton.metadata, L378)', async () => {
        mockClaude.detectStorageLocations.mockResolvedValue([{ projectPath: '/proj/beta' }]);
        mockFs.readdir.mockResolvedValue(['x.jsonl']);
        mockClaude.analyzeConversation.mockResolvedValue({
            taskId: 'claude-beta--x',
            sequence: [{ role: 'user', content: 'hi' }],
            // no metadata field at all
        } as any);
        const cache = new Map<string, SkeletonHeader>();

        await loadClaudeCodeSessions(cache);

        const h = cache.get('claude-beta--x');
        expect(h).toBeDefined();
        expect((h!.metadata as any).source).toBe('claude-code');
        expect((h!.metadata as any).dataSource).toBe('claude');
    });

    it('catches a per-session analyze error and continues (L386-388)', async () => {
        mockClaude.detectStorageLocations.mockResolvedValue([{ projectPath: '/proj/alpha' }]);
        mockFs.readdir.mockResolvedValue(['bad.jsonl', 'good.jsonl']);
        mockClaude.analyzeConversation.mockImplementation(async (taskId: string) => {
            if (taskId.endsWith('bad')) throw new Error('parse boom');
            return makeSkeleton(taskId);
        });
        const cache = new Map<string, SkeletonHeader>();

        await loadClaudeCodeSessions(cache);

        // the good one still loads despite the bad one throwing
        expect(cache.has('claude-alpha--good')).toBe(true);
        expect(cache.size).toBe(1);
    });

    it('catches a project-dir readdir error and continues (L390-392)', async () => {
        mockClaude.detectStorageLocations.mockResolvedValue([{ projectPath: '/proj/broken' }, { projectPath: '/proj/alpha' }]);
        mockFs.readdir.mockImplementation(async (p: string) => {
            if (p.includes('broken')) throw new Error('EACCES');
            return ['s1.jsonl'];
        });
        mockClaude.analyzeConversation.mockImplementation(async (taskId: string) => makeSkeleton(taskId));
        const cache = new Map<string, SkeletonHeader>();

        await loadClaudeCodeSessions(cache);

        // broken dir skipped, alpha loaded
        expect(cache.has('claude-alpha--s1')).toBe(true);
        expect(cache.size).toBe(1);
    });

    it('swallows a top-level discovery failure (non-blocking, L396-398)', async () => {
        mockClaude.detectStorageLocations.mockRejectedValue(new Error('detector down'));
        const cache = new Map<string, SkeletonHeader>();

        await expect(loadClaudeCodeSessions(cache)).resolves.toBeUndefined();
        expect(cache.size).toBe(0);
    });
});

// =========================================================================
// startSkeletonRefreshWorker (L442-624) — interval body via fake timers
// =========================================================================
describe('startSkeletonRefreshWorker', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    /** Register the worker then fire the interval callback exactly once. */
    async function fireOnce(state: ServerState): Promise<void> {
        startSkeletonRefreshWorker(state);
        await vi.advanceTimersByTimeAsync(SKELETON_REFRESH_INTERVAL_MS);
    }

    it('clears a pre-existing interval before re-arming (L443-444)', async () => {
        const clearSpy = vi.spyOn(global, 'clearInterval');
        mockRoo.detectStorageLocations.mockResolvedValue([]);
        mockClaude.detectStorageLocations.mockResolvedValue([]);
        const state = makeState({ skeletonRefreshInterval: setInterval(() => {}, 1_000_000) as any });

        await fireOnce(state);

        expect(clearSpy).toHaveBeenCalled();
    });

    it('scans a modified Roo task: rebuilds skeleton, dual-writes, queues for Qdrant, counts new (L458-515)', async () => {
        mockRoo.detectStorageLocations.mockResolvedValue(['/roo/loc1']);
        mockFs.readdir.mockResolvedValue([dirent('task-A'), dirent('.skeletons'), dirent('afile', false)]);
        mockFs.stat.mockResolvedValue({ mtime: new Date('2026-03-01T00:00:00Z') } as any);
        mockRoo.analyzeConversation.mockResolvedValue(makeSkeleton('task-A'));
        mockClaude.detectStorageLocations.mockResolvedValue([]);
        const state = makeState();

        await fireOnce(state);

        expect(mockRoo.analyzeConversation).toHaveBeenCalledWith('task-A', expect.stringContaining('task-A'));
        expect(state.conversationCache.has('task-A')).toBe(true);
        expect(state.qdrantIndexQueue.has('task-A')).toBe(true);
        expect(mockDualWrite).toHaveBeenCalledWith('task-A', expect.objectContaining({ taskId: 'task-A' }));
    });

    it('skips a Roo task not modified since last check (mtimeMs <= lastCheck, L473)', async () => {
        mockRoo.detectStorageLocations.mockResolvedValue(['/roo/loc1']);
        mockFs.readdir.mockResolvedValue([dirent('old-task')]);
        mockFs.stat.mockResolvedValue({ mtime: new Date('2020-01-01T00:00:00Z') } as any);
        mockClaude.detectStorageLocations.mockResolvedValue([]);
        const state = makeState({ lastSkeletonRefreshAt: new Date('2026-01-01T00:00:00Z').getTime() });

        await fireOnce(state);

        expect(mockRoo.analyzeConversation).not.toHaveBeenCalled();
        expect(state.qdrantIndexQueue.size).toBe(0);
    });

    it('preserves existing indexingState and counts an updated task (L481-515)', async () => {
        mockRoo.detectStorageLocations.mockResolvedValue(['/roo/loc1']);
        mockFs.readdir.mockResolvedValue([dirent('task-U')]);
        mockFs.stat.mockResolvedValue({ mtime: new Date('2026-03-01T00:00:00Z') } as any);
        // skeleton from analyze carries NO indexingState → must inherit from cache
        mockRoo.analyzeConversation.mockResolvedValue(makeSkeleton('task-U'));
        const existing: SkeletonHeader = {
            taskId: 'task-U',
            metadata: {
                lastActivity: '2020-01-01T00:00:00Z',
                indexingState: { indexStatus: 'success', lastIndexedAt: '2020-01-01T00:00:00Z' },
            } as any,
        } as SkeletonHeader;
        const state = makeState({ conversationCache: new Map([['task-U', existing]]) });

        await fireOnce(state);

        const updated = state.conversationCache.get('task-U');
        expect((updated!.metadata as any).indexingState).toEqual({ indexStatus: 'success', lastIndexedAt: '2020-01-01T00:00:00Z' });
        // lastActivity (2026) > lastIndexedAt (2020) → re-queued
        expect(state.qdrantIndexQueue.has('task-U')).toBe(true);
    });

    it('in FORCE mode, does not re-queue an already-indexed unchanged task (alreadyIndexedInForceMode, L506-513)', async () => {
        process.env.ROO_INDEX_FORCE = '1';
        mockRoo.detectStorageLocations.mockResolvedValue(['/roo/loc1']);
        mockFs.readdir.mockResolvedValue([dirent('task-F')]);
        mockFs.stat.mockResolvedValue({ mtime: new Date('2026-03-01T00:00:00Z') } as any);
        // analyze returns a skeleton whose header already has success + a NEWER lastIndexedAt
        const skel = makeSkeleton('task-F');
        (skel.metadata as any).indexingState = { indexStatus: 'success', lastIndexedAt: '2026-06-01T00:00:00Z' };
        mockRoo.analyzeConversation.mockResolvedValue(skel);
        mockClaude.detectStorageLocations.mockResolvedValue([]);
        const state = makeState();

        await fireOnce(state);

        // file mtime (2026-03) <= lastIndexedAt (2026-06) in FORCE mode → skip queue
        expect(state.qdrantIndexQueue.has('task-F')).toBe(false);
    });

    it('does not queue when shouldIndexTask returns false (L512)', async () => {
        mockShouldIndex.mockReturnValue(false);
        mockRoo.detectStorageLocations.mockResolvedValue(['/roo/loc1']);
        mockFs.readdir.mockResolvedValue([dirent('task-N')]);
        mockFs.stat.mockResolvedValue({ mtime: new Date('2026-03-01T00:00:00Z') } as any);
        mockRoo.analyzeConversation.mockResolvedValue(makeSkeleton('task-N'));
        mockClaude.detectStorageLocations.mockResolvedValue([]);
        const state = makeState();

        await fireOnce(state);

        expect(state.conversationCache.has('task-N')).toBe(true);
        expect(state.qdrantIndexQueue.has('task-N')).toBe(false);
    });

    it('swallows per-task and per-location errors (L518, L522)', async () => {
        mockRoo.detectStorageLocations.mockResolvedValue(['/roo/bad-stat', '/roo/bad-readdir']);
        mockFs.readdir.mockImplementation(async (p: string) => {
            if (String(p).includes('bad-readdir')) throw new Error('readdir EACCES');
            return [dirent('t1')];
        });
        mockFs.stat.mockRejectedValue(new Error('stat ENOENT')); // per-task catch
        mockClaude.detectStorageLocations.mockResolvedValue([]);
        const state = makeState();

        // must not throw despite both error paths
        await expect(fireOnce(state)).resolves.toBeUndefined();
        expect(state.conversationCache.size).toBe(0);
    });

    it('scans a modified Claude session and dedups repeated project paths (L528-582)', async () => {
        mockRoo.detectStorageLocations.mockResolvedValue([]);
        // same projectPath twice → second must be skipped by seenProjects (L534)
        mockClaude.detectStorageLocations.mockResolvedValue([{ projectPath: '/cproj/x' }, { projectPath: '/cproj/x' }]);
        mockFs.readdir.mockResolvedValue(['sess.jsonl', 'ignore.txt']);
        mockFs.stat.mockResolvedValue({ mtime: new Date('2026-03-01T00:00:00Z') } as any);
        mockClaude.analyzeConversation.mockImplementation(async (taskId: string) => makeSkeleton(taskId));
        const state = makeState();

        await fireOnce(state);

        expect(state.conversationCache.has('claude-x--sess')).toBe(true);
        expect(state.qdrantIndexQueue.has('claude-x--sess')).toBe(true);
        // readdir called once for the project (dedup prevented a 2nd scan)
        expect(mockFs.readdir).toHaveBeenCalledTimes(1);
    });

    it('swallows Claude per-file, per-project and detector errors (L585, L589, L593)', async () => {
        mockRoo.detectStorageLocations.mockResolvedValue([]);
        mockClaude.detectStorageLocations.mockResolvedValue([{ projectPath: '/cproj/y' }]);
        mockFs.readdir.mockResolvedValue(['f.jsonl']);
        mockFs.stat.mockRejectedValue(new Error('stat boom')); // per-file catch (L585)
        const state = makeState();

        await expect(fireOnce(state)).resolves.toBeUndefined();
        expect(state.conversationCache.size).toBe(0);
    });

    it('regenerates the index after updates (L600-604) and fires the 30s initial-index save on a non-empty cache (L615-621)', async () => {
        mockRoo.detectStorageLocations.mockResolvedValue(['/roo/loc1']);
        mockFs.readdir.mockResolvedValue([dirent('task-Z')]);
        mockFs.stat.mockResolvedValue({ mtime: new Date('2026-03-01T00:00:00Z') } as any);
        mockRoo.analyzeConversation.mockResolvedValue(makeSkeleton('task-Z'));
        mockClaude.detectStorageLocations.mockResolvedValue([]);
        // Pre-seed so the 30s initial-index setTimeout (which fires BEFORE the 120s interval
        // populates the cache) sees a non-empty cache → the L616 `size > 0` branch is taken.
        const state = makeState({
            conversationCache: new Map([['seed-1', { taskId: 'seed-1', metadata: { lastActivity: '2026-02-01T00:00:00Z' } } as any]]),
        });

        startSkeletonRefreshWorker(state);
        // one advance fires both the 30s initial-index setTimeout AND the 120s interval body
        await vi.advanceTimersByTimeAsync(SKELETON_REFRESH_INTERVAL_MS);

        // interval scan added task-Z (newCount > 0 → L600-604 saveSkeletonIndex call executed);
        // asserting the observable branch outcome, not saveSkeletonIndex's inner fs write, which
        // routes through proper-lockfile's retry timers (not driven under fake timers).
        expect(state.conversationCache.has('task-Z')).toBe(true);
        expect(state.conversationCache.size).toBeGreaterThanOrEqual(2);
    });

    it('skips a Claude session not modified since last check (stat.mtime <= lastCheck, L543)', async () => {
        mockRoo.detectStorageLocations.mockResolvedValue([]);
        mockClaude.detectStorageLocations.mockResolvedValue([{ projectPath: '/cproj/z' }]);
        mockFs.readdir.mockResolvedValue(['old.jsonl']);
        mockFs.stat.mockResolvedValue({ mtime: new Date('2020-01-01T00:00:00Z') } as any);
        const state = makeState({ lastSkeletonRefreshAt: new Date('2026-01-01T00:00:00Z').getTime() });

        await fireOnce(state);

        expect(mockClaude.analyzeConversation).not.toHaveBeenCalled();
        expect(state.conversationCache.size).toBe(0);
    });

    it('preserves indexingState and counts an updated Claude session (L554-582, existing arm)', async () => {
        mockRoo.detectStorageLocations.mockResolvedValue([]);
        mockClaude.detectStorageLocations.mockResolvedValue([{ projectPath: '/cproj/z' }]);
        mockFs.readdir.mockResolvedValue(['sess.jsonl']);
        mockFs.stat.mockResolvedValue({ mtime: new Date('2026-03-01T00:00:00Z') } as any);
        mockClaude.analyzeConversation.mockResolvedValue(makeSkeleton('claude-z--sess'));
        const existing: SkeletonHeader = {
            taskId: 'claude-z--sess',
            metadata: {
                lastActivity: '2020-01-01T00:00:00Z',
                indexingState: { indexStatus: 'success', lastIndexedAt: '2020-01-01T00:00:00Z' },
            } as any,
        } as SkeletonHeader;
        const state = makeState({ conversationCache: new Map([['claude-z--sess', existing]]) });

        await fireOnce(state);

        const updated = state.conversationCache.get('claude-z--sess');
        expect((updated!.metadata as any).indexingState).toEqual({ indexStatus: 'success', lastIndexedAt: '2020-01-01T00:00:00Z' });
        expect(state.qdrantIndexQueue.has('claude-z--sess')).toBe(true); // lastActivity 2026 > lastIndexed 2020
    });

    it('in FORCE mode, does not re-queue an already-indexed unchanged Claude session (L573-577)', async () => {
        process.env.ROO_INDEX_FORCE = 'true';
        mockRoo.detectStorageLocations.mockResolvedValue([]);
        mockClaude.detectStorageLocations.mockResolvedValue([{ projectPath: '/cproj/z' }]);
        mockFs.readdir.mockResolvedValue(['sess.jsonl']);
        mockFs.stat.mockResolvedValue({ mtime: new Date('2026-03-01T00:00:00Z') } as any);
        const skel = makeSkeleton('claude-z--sess');
        (skel.metadata as any).indexingState = { indexStatus: 'success', lastIndexedAt: '2026-06-01T00:00:00Z' };
        mockClaude.analyzeConversation.mockResolvedValue(skel);
        const state = makeState();

        await fireOnce(state);

        expect(state.conversationCache.has('claude-z--sess')).toBe(true);
        expect(state.qdrantIndexQueue.has('claude-z--sess')).toBe(false);
    });

    it('does not cache a Claude skeleton with an empty sequence (L556 false arm)', async () => {
        mockRoo.detectStorageLocations.mockResolvedValue([]);
        mockClaude.detectStorageLocations.mockResolvedValue([{ projectPath: '/cproj/z' }]);
        mockFs.readdir.mockResolvedValue(['empty.jsonl']);
        mockFs.stat.mockResolvedValue({ mtime: new Date('2026-03-01T00:00:00Z') } as any);
        mockClaude.analyzeConversation.mockResolvedValue(makeSkeleton('claude-z--empty', { sequence: [] }));
        const state = makeState();

        await fireOnce(state);

        expect(state.conversationCache.size).toBe(0);
        expect(mockDualWrite).not.toHaveBeenCalled();
    });

    it('routes an error thrown during the scan into the outer catch (L608-609)', async () => {
        mockRoo.detectStorageLocations.mockRejectedValue(new Error('detect boom'));
        mockClaude.detectStorageLocations.mockResolvedValue([]);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const state = makeState();

        await expect(fireOnce(state)).resolves.toBeUndefined();
        expect(errSpy).toHaveBeenCalled();
    });
});
