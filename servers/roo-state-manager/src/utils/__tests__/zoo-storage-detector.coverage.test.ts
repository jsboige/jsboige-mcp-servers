/**
 * Coverage tests for zoo-storage-detector (#2429).
 *
 * Baseline: 0% statements / 0% lines — module has NO direct test; the two
 * importers (zoo-task-extractor, storage-info) mock it, so it is never
 * exercised. This suite drives every public static method + every cold branch.
 *
 * Anchored on real source contract (zoo-storage-detector.ts):
 *   - detectStorageLocations L62-83
 *       * cache HIT (L64-67 globalCacheManager.get → truthy)
 *       * cache MISS → scan 4 COMMON_GLOBAL_STORAGE_PATHS (L71-78)
 *         - existsSync(zooPath)=false  (skip)
 *         - existsSync(zooPath)=true / existsSync(tasksPath)=false (skip)
 *         - existsSync(zooPath)=true / existsSync(tasksPath)=true (push)
 *       * cache SET (L81)
 *   - getStatsForPath L91-122
 *       * readdir tasksPath (L97)
 *       * !entries || !Array.isArray guard (L99-101) → zeros
 *       * entry !isDirectory skip, entry.name==='_index.json' skip (L105)
 *       * readdir taskPath throws → outer try/catch skip (L118-119)
 *       * file stat: isFile=true accumulates size + tracks mtime (L113-115)
 *       * file stat: isFile=false skipped (L114)
 *       * stat throws → inner try/catch skip (L116-117)
 *       * dir mtime tracking (L107, L120-122)
 *   - getStorageStats L129-145 (aggregate over 0/1/N locations)
 *   - isZooCodePath L152-156 (backslash normalization + lowercase + includes neg/pos)
 *   - validateCustomPath L162-170 (existsSync tasks true/false + try/catch→false)
 *
 * Discipline: 0 source touched, add-only *.coverage.test.ts (#1936 anti-churn).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─────────────────── Mocks ───────────────────

const mockReaddir = vi.fn();
const mockStat = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('fs', () => ({
    existsSync: (...args: any[]) => mockExistsSync(...args),
}));

vi.mock('fs/promises', () => ({
    readdir: (...args: any[]) => mockReaddir(...args),
    stat: (...args: any[]) => mockStat(...args),
}));

const cacheGet = vi.fn(() => Promise.resolve(null));
const cacheSet = vi.fn(() => Promise.resolve(undefined));

vi.mock('../cache-manager.js', () => ({
    globalCacheManager: {
        get: (...args: any[]) => cacheGet(...args),
        set: (...args: any[]) => cacheSet(...args),
    },
}));

// Import AFTER mocks are registered.
import { ZooStorageDetector, ZOO_CODE_EXTENSION_ID } from '../zoo-storage-detector.js';

// ─────────────────── Helpers ───────────────────

const dirent = (name: string, isDir = true) => ({
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
});

/** Drive existsSync so that exactly `hitIndices` of COMMON_GLOBAL_STORAGE_PATHS
 *  have BOTH zooPath + tasksPath present. Each path generates 2 existsSync
 *  calls (zooPath, then tasksPath). */
const driveExistsSync = (hitIndices: number[]) => {
    const calls: boolean[] = [];
    for (let i = 0; i < 4; i++) {
        const hit = hitIndices.includes(i);
        calls.push(hit); // zooPath exists?
        // tasksPath is only consulted when zooPath exists — mirror that here so
        // the consumed-call index stays aligned across skipped paths.
        if (hit) calls.push(hit);
    }
    let i = 0;
    mockExistsSync.mockImplementation(() => {
        return calls[i++] ?? false;
    });
};

// ─────────────────── Tests ───────────────────

describe('ZooStorageDetector — coverage (0% baseline, #2429)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        cacheGet.mockReset();
        cacheGet.mockImplementation(() => Promise.resolve(null));
        cacheSet.mockReset();
        cacheSet.mockImplementation(() => Promise.resolve(undefined));
        mockExistsSync.mockReset();
        mockReaddir.mockReset();
        mockStat.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ─── detectStorageLocations ───

    describe('detectStorageLocations', () => {
        it('returns cached value on cache HIT (no fs scan)', async () => {
            const cached = ['/cached/zoo'];
            cacheGet.mockImplementation(() => Promise.resolve(cached));

            const result = await ZooStorageDetector.detectStorageLocations();

            expect(result).toBe(cached);
            expect(mockExistsSync).not.toHaveBeenCalled();
            expect(cacheSet).not.toHaveBeenCalled();
        });

        it('scans COMMON paths on cache MISS, pushes only paths with tasks/', async () => {
            // Only path index 1 has both zooPath + tasksPath present.
            driveExistsSync([1]);

            const result = await ZooStorageDetector.detectStorageLocations();

            expect(result).toHaveLength(1);
            expect(result[0]).toContain(ZOO_CODE_EXTENSION_ID);
            expect(cacheSet).toHaveBeenCalledWith(
                'zoo_storage_locations',
                expect.any(Array)
            );
        });

        it('skips path where zooPath exists but tasks/ does NOT', async () => {
            // path 0: zooPath=true, tasksPath=false  → existsSync returns [true,false]
            // path 1-3: false
            mockExistsSync
                .mockReturnValueOnce(true)   // path0 zooPath
                .mockReturnValueOnce(false)  // path0 tasksPath → skip
                .mockReturnValueOnce(false)  // path1 zooPath
                .mockReturnValueOnce(false)  // path2 zooPath
                .mockReturnValueOnce(false); // path3 zooPath

            const result = await ZooStorageDetector.detectStorageLocations();

            expect(result).toHaveLength(0);
        });

        it('returns empty when no zoo installation found', async () => {
            driveExistsSync([]);

            const result = await ZooStorageDetector.detectStorageLocations();

            expect(result).toEqual([]);
            expect(cacheSet).toHaveBeenCalledWith('zoo_storage_locations', []);
        });

        it('detects multiple installations across paths', async () => {
            driveExistsSync([0, 2, 3]);

            const result = await ZooStorageDetector.detectStorageLocations();

            expect(result).toHaveLength(3);
            result.forEach((p) => expect(p).toContain(ZOO_CODE_EXTENSION_ID));
        });
    });

    // ─── getStatsForPath ───

    describe('getStatsForPath', () => {
        it('returns zeros when readdir returns a non-array (defensive guard)', async () => {
            mockReaddir.mockResolvedValueOnce(null as any); // tasksPath readdir

            const stats = await ZooStorageDetector.getStatsForPath('/some/zoo');

            expect(stats).toEqual({ conversationCount: 0, totalSize: 0, fileTypes: {} });
        });

        it('skips non-directory entries and the _index.json entry', async () => {
            // tasksPath readdir → [dir, file (non-dir), _index.json (dir but skipped)]
            mockReaddir.mockResolvedValueOnce([
                dirent('task-1', true),
                dirent('not-a-dir.txt', false),
                dirent('_index.json', true),
            ]);
            // task-1 readdir → 1 file
            mockReaddir.mockResolvedValueOnce(['msg.json']);
            mockStat.mockResolvedValueOnce({ isFile: () => true, size: 100, mtime: new Date(10) });

            const stats = await ZooStorageDetector.getStatsForPath('/zoo');

            // Only task-1 counted (not-a-dir + _index.json skipped)
            expect(stats.conversationCount).toBe(1);
            expect(stats.totalSize).toBe(100);
        });

        it('accumulates size + tracks latest mtime across files in a task dir', async () => {
            mockReaddir.mockResolvedValueOnce([dirent('task-A', true)]);
            mockReaddir.mockResolvedValueOnce(['a.json', 'b.json']);
            mockStat
                .mockResolvedValueOnce({ isFile: () => true, size: 50, mtime: new Date(100) })
                .mockResolvedValueOnce({ isFile: () => true, size: 30, mtime: new Date(200) });

            const stats = await ZooStorageDetector.getStatsForPath('/zoo');

            expect(stats.conversationCount).toBe(1);
            expect(stats.totalSize).toBe(80);
        });

        it('skips entries where stat.isFile() is false (subdirectories)', async () => {
            mockReaddir.mockResolvedValueOnce([dirent('task-B', true)]);
            mockReaddir.mockResolvedValueOnce(['subdir', 'real.json']);
            mockStat
                .mockResolvedValueOnce({ isFile: () => false, size: 999, mtime: new Date(1) }) // skipped
                .mockResolvedValueOnce({ isFile: () => true, size: 42, mtime: new Date(2) });

            const stats = await ZooStorageDetector.getStatsForPath('/zoo');

            expect(stats.totalSize).toBe(42); // 999 from subdir excluded
        });

        it('swallows inner stat errors (corrupted file) without aborting', async () => {
            mockReaddir.mockResolvedValueOnce([dirent('task-C', true)]);
            mockReaddir.mockResolvedValueOnce(['bad.json', 'good.json']);
            mockStat
                .mockRejectedValueOnce(new Error('EACCES')) // inner try/catch skip
                .mockResolvedValueOnce({ isFile: () => true, size: 7, mtime: new Date(5) });

            const stats = await ZooStorageDetector.getStatsForPath('/zoo');

            expect(stats.conversationCount).toBe(1);
            expect(stats.totalSize).toBe(7);
        });

        it('keeps the earliest dir mtime when a later task dir is older (false branch L108)', async () => {
            // Two counted task dirs; the 2nd has an older file mtime than the 1st,
            // so the `dirMtime > lastActivity` disjunct is false and L109 is skipped
            // for that iteration. (lastActivity is dead state — never returned at L113
            // — so this exercises the branch purely for coverage completeness.)
            mockReaddir
                .mockResolvedValueOnce([dirent('task-newer', true), dirent('task-older', true)])
                .mockResolvedValueOnce(['a.json'])   // task-newer
                .mockResolvedValueOnce(['b.json']);  // task-older
            mockStat
                .mockResolvedValueOnce({ isFile: () => true, size: 10, mtime: new Date(500) }) // newer
                .mockResolvedValueOnce({ isFile: () => true, size: 5, mtime: new Date(100) }); // older → false arm

            const stats = await ZooStorageDetector.getStatsForPath('/zoo');

            expect(stats.conversationCount).toBe(2);
            expect(stats.totalSize).toBe(15);
        });

        it('swallows outer task-dir readdir errors (corrupted task dir)', async () => {
            mockReaddir
                .mockResolvedValueOnce([dirent('task-broken', true), dirent('task-ok', true)])
                .mockRejectedValueOnce(new Error('EIO')) // task-broken readdir → outer catch
                .mockResolvedValueOnce(['x.json']); // task-ok readdir
            mockStat.mockResolvedValueOnce({ isFile: () => true, size: 11, mtime: new Date(3) });

            const stats = await ZooStorageDetector.getStatsForPath('/zoo');

            // task-broken skipped via outer catch, task-ok counted
            expect(stats.conversationCount).toBe(1);
            expect(stats.totalSize).toBe(11);
        });
    });

    // ─── getStorageStats ───

    describe('getStorageStats', () => {
        it('aggregates over detected locations', async () => {
            // Force detectStorageLocations to find 2 locations (paths 0 + 2)
            driveExistsSync([0, 2]);
            // For each location: tasksPath readdir → 1 task dir → 1 file
            mockReaddir
                // location 0
                .mockResolvedValueOnce([dirent('t1', true)])
                .mockResolvedValueOnce(['f1.json'])
                // location 2
                .mockResolvedValueOnce([dirent('t2', true)])
                .mockResolvedValueOnce(['f2.json']);
            mockStat
                .mockResolvedValueOnce({ isFile: () => true, size: 10, mtime: new Date(1) })
                .mockResolvedValueOnce({ isFile: () => true, size: 20, mtime: new Date(2) });

            const stats = await ZooStorageDetector.getStorageStats();

            expect(stats.totalLocations).toBe(2);
            expect(stats.totalConversations).toBe(2);
            expect(stats.totalSize).toBe(30);
        });

        it('returns zeros when no locations detected', async () => {
            driveExistsSync([]);

            const stats = await ZooStorageDetector.getStorageStats();

            expect(stats).toEqual({ totalLocations: 0, totalConversations: 0, totalSize: 0 });
        });
    });

    // ─── isZooCodePath ───

    describe('isZooCodePath', () => {
        it('returns true for a canonical zoo-code path (lowercase, forward slashes)', () => {
            expect(
                ZooStorageDetector.isZooCodePath(
                    '/home/u/.config/Code/User/globalStorage/zoocodeorganization.zoo-code'
                )
            ).toBe(true);
        });

        it('normalizes backslashes and case before matching', () => {
            expect(
                ZooStorageDetector.isZooCodePath(
                    'C:\\Users\\u\\AppData\\ZOOCODEORGANIZATION.ZOO-CODE'
                )
            ).toBe(true);
        });

        it('returns false for a non-zoo (roo) storage path', () => {
            expect(
                ZooStorageDetector.isZooCodePath(
                    'C:\\Users\\u\\AppData\\Roaming\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline'
                )
            ).toBe(false);
        });

        it('returns false for an arbitrary path', () => {
            expect(ZooStorageDetector.isZooCodePath('/tmp/some/other/dir')).toBe(false);
        });
    });

    // ─── validateCustomPath ───

    describe('validateCustomPath', () => {
        it('returns true when a tasks/ subdirectory exists at the resolved path', async () => {
            mockExistsSync.mockReturnValue(true);

            const ok = await ZooStorageDetector.validateCustomPath('/custom/zoo');

            expect(ok).toBe(true);
            expect(mockExistsSync).toHaveBeenCalledWith(
                expect.stringContaining('tasks')
            );
        });

        it('returns false when tasks/ does NOT exist', async () => {
            mockExistsSync.mockReturnValue(false);

            const ok = await ZooStorageDetector.validateCustomPath('/custom/nope');

            expect(ok).toBe(false);
        });

        it('returns false when path resolution throws (defensive catch)', async () => {
            // path.resolve itself is very tolerant; force existsSync to throw so the
            // try/catch (L163-169) is exercised via the contained call.
            mockExistsSync.mockImplementation(() => {
                throw new Error('ENOTDIR');
            });

            const ok = await ZooStorageDetector.validateCustomPath('/bad/\\0/null');

            expect(ok).toBe(false);
        });
    });

    // ─── exported constant ───

    it('exports the canonical Zoo-Code extension id', () => {
        expect(ZOO_CODE_EXTENSION_ID).toBe('zoocodeorganization.zoo-code');
    });
});
