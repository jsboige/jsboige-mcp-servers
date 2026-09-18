import { describe, it, expect, beforeEach, vi } from 'vitest';
import { evictGoneLocalTasks } from '../../../../src/tools/task/disk-scanner.js';
import { SkeletonHeader } from '../../../../src/types/conversation.js';

// disk-scanner imports fs from 'fs/promises' (separate module id from 'fs').
const { mockReaddir } = vi.hoisted(() => ({
    mockReaddir: vi.fn(),
}));

vi.mock('fs/promises', () => ({
    readdir: mockReaddir,
    default: { readdir: mockReaddir },
}));

vi.mock('../../../../src/utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectStorageLocations: vi.fn(),
    },
}));

vi.mock('../../../../src/utils/claude-storage-detector.js', () => ({
    ClaudeStorageDetector: {
        detectStorageLocations: vi.fn(),
    },
}));

import { RooStorageDetector } from '../../../../src/utils/roo-storage-detector.js';
import { ClaudeStorageDetector } from '../../../../src/utils/claude-storage-detector.js';

const makeHeader = (taskId: string, dataSource?: string): SkeletonHeader =>
    ({
        taskId,
        metadata: {
            title: taskId,
            lastActivity: '2026-06-21T00:00:00Z',
            createdAt: '2026-06-01T00:00:00Z',
            messageCount: 10,
            actionCount: 0,
            totalSize: 1000,
            ...(dataSource ? { dataSource } : {}),
        },
    }) as SkeletonHeader;

const dir = (name: string) => ({ name, isDirectory: () => true });
const file = (name: string) => ({ name, isDirectory: () => false });
// Real path.join on win32 produces backslashes — normalize before matching.
const norm = (p: unknown) => String(p).replace(/\\/g, '/');

describe('#3721 evictGoneLocalTasks', () => {
    let cache: Map<string, SkeletonHeader>;

    const healthyStorage = () => {
        // Roo: two live task dirs (+ .skeletons which must be ignored)
        vi.mocked(RooStorageDetector.detectStorageLocations).mockResolvedValue(['/roo-storage']);
        // Claude: one project dir with two live sessions
        vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([
            { projectName: 'c--dev-CoursIA', projectPath: '/home/u/.claude/projects/c--dev-CoursIA' },
        ] as any);

        mockReaddir.mockImplementation(async (target: string, opts?: any) => {
            const p = norm(target);
            if (p === '/roo-storage/tasks') {
                return opts?.withFileTypes
                    ? [dir('t-live-1'), dir('t-live-2'), dir('.skeletons'), file('stray.txt')]
                    : ['t-live-1', 't-live-2', '.skeletons', 'stray.txt'];
            }
            if (p === '/home/u/.claude/projects/c--dev-CoursIA') {
                return ['aaa.jsonl', 'bbb.jsonl', 'notes.txt'];
            }
            throw new Error(`ENOENT: ${target}`);
        });
    };

    beforeEach(() => {
        vi.clearAllMocks();
        cache = new Map<string, SkeletonHeader>();
    });

    it('evicts ghosts (roo task dir gone, claude session jsonl gone, claude project gone) and keeps live entries', async () => {
        healthyStorage();
        cache.set('t-live-1', makeHeader('t-live-1'));
        cache.set('t-ghost', makeHeader('t-ghost')); // roo dir deleted
        cache.set('claude-c--dev-CoursIA--aaa', makeHeader('claude-c--dev-CoursIA--aaa')); // jsonl live
        cache.set('claude-c--dev-CoursIA--zzz', makeHeader('claude-c--dev-CoursIA--zzz')); // jsonl deleted
        cache.set('claude-c--dev-CoursIA', makeHeader('claude-c--dev-CoursIA')); // legacy per-project format, dir live
        cache.set('claude-c--dev-GONE--aaa', makeHeader('claude-c--dev-GONE--aaa')); // whole project deleted

        const result = await evictGoneLocalTasks(cache);

        expect(result.evicted.sort()).toEqual([
            'claude-c--dev-GONE--aaa',
            'claude-c--dev-CoursIA--zzz',
            't-ghost',
        ].sort());
        expect(cache.has('t-live-1')).toBe(true);
        expect(cache.has('claude-c--dev-CoursIA--aaa')).toBe(true);
        expect(cache.has('claude-c--dev-CoursIA')).toBe(true);
        expect(result.failOpenRoo).toBe(false);
        expect(result.failOpenClaude).toBe(false);
    });

    it('spares remote entries (gdrive-archive and archive dataSource)', async () => {
        healthyStorage();
        cache.set('arch-gdrive', makeHeader('arch-gdrive', 'gdrive-archive'));
        cache.set('arch-cold', makeHeader('arch-cold', 'archive'));

        const result = await evictGoneLocalTasks(cache);

        expect(result.evicted).toEqual([]);
        expect(result.skippedRemote).toBe(2);
        expect(cache.size).toBe(2);
    });

    it('fail-open: roo storage detection unavailable keeps roo entries, claude eviction still runs', async () => {
        vi.mocked(RooStorageDetector.detectStorageLocations).mockResolvedValue([]);
        vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([
            { projectName: 'c--dev-CoursIA', projectPath: '/home/u/.claude/projects/c--dev-CoursIA' },
        ] as any);
        mockReaddir.mockImplementation(async (target: string) => {
            if (norm(target) === '/home/u/.claude/projects/c--dev-CoursIA') return ['aaa.jsonl'];
            throw new Error(`ENOENT: ${target}`);
        });

        cache.set('t-ghost', makeHeader('t-ghost')); // unverifiable → must stay
        cache.set('claude-c--dev-CoursIA--zzz', makeHeader('claude-c--dev-CoursIA--zzz')); // verifiable ghost

        const result = await evictGoneLocalTasks(cache);

        expect(result.failOpenRoo).toBe(true);
        expect(result.failOpenClaude).toBe(false);
        expect(result.evicted).toEqual(['claude-c--dev-CoursIA--zzz']);
        expect(cache.has('t-ghost')).toBe(true);
    });

    it('fail-open: one unreadable storage root skips roo eviction entirely (no mass-evict on I/O error)', async () => {
        vi.mocked(RooStorageDetector.detectStorageLocations).mockResolvedValue(['/roo-a', '/roo-b']);
        vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([]);
        mockReaddir.mockImplementation(async (target: string, opts?: any) => {
            if (norm(target) === '/roo-a/tasks') {
                return opts?.withFileTypes ? [dir('t-live-1')] : ['t-live-1'];
            }
            throw new Error('EACCES: permission denied'); // /roo-b/tasks unreadable
        });

        cache.set('t-ghost', makeHeader('t-ghost'));

        const result = await evictGoneLocalTasks(cache);

        expect(result.failOpenRoo).toBe(true);
        expect(result.evicted).toEqual([]);
        expect(cache.has('t-ghost')).toBe(true);
    });

    it('fail-open: unreadable claude project dir skips claude eviction entirely', async () => {
        vi.mocked(RooStorageDetector.detectStorageLocations).mockResolvedValue([]);
        vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([
            { projectName: 'c--dev-CoursIA', projectPath: '/home/u/.claude/projects/c--dev-CoursIA' },
        ] as any);
        mockReaddir.mockRejectedValue(new Error('EACCES: permission denied'));

        cache.set('claude-c--dev-CoursIA--zzz', makeHeader('claude-c--dev-CoursIA--zzz'));

        const result = await evictGoneLocalTasks(cache);

        expect(result.failOpenClaude).toBe(true);
        expect(result.evicted).toEqual([]);
        expect(cache.has('claude-c--dev-CoursIA--zzz')).toBe(true);
    });

    it('both sources unavailable → nothing evicted', async () => {
        vi.mocked(RooStorageDetector.detectStorageLocations).mockResolvedValue([]);
        vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([]);
        cache.set('t-ghost', makeHeader('t-ghost'));
        cache.set('claude-x--y', makeHeader('claude-x--y'));

        const result = await evictGoneLocalTasks(cache);

        expect(result.evicted).toEqual([]);
        expect(cache.size).toBe(2);
    });
});
