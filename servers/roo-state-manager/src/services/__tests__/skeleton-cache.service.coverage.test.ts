/**
 * Add-only coverage complement for SkeletonCacheService — #833 Sprint C3.
 *
 * The nominal suite (skeleton-cache.service.test.ts) exercises the read/load
 * paths and the full #1244 multi-tier flow, but its `fs` mock stubs only
 * `readdir`/`readFile`/`stat` — never `mkdir`/`writeFile`/`access`. As a result
 * every WRITE / PERSIST / BUILD path short-circuits or throws before its body
 * runs, leaving 7 functions cold: `addOrUpdate`, `dualWriteToStore`,
 * `saveSkeleton`, `saveAllToDisk`, `getCacheSize`, `getSkeletonDir`,
 * `getCacheTierStats`, plus the whole `buildMissingSkeletons` body and the
 * loader's skeleton-dir-absent / outer-catch branches.
 *
 * This file supplies a fuller fs mock (mkdir/writeFile/access added) + mocks
 * for `RooStorageDetector.analyzeConversation` and the unified-store dual-write
 * helper, then drives those cold paths. Tests-only, zero source change.
 *
 * @module services/__tests__/skeleton-cache.service.coverage
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- RooStorageDetector: detectStorageLocations + analyzeConversation ----
const { mockDetectStorageLocations, mockAnalyzeConversation } = vi.hoisted(() => ({
  mockDetectStorageLocations: vi.fn(),
  mockAnalyzeConversation: vi.fn(),
}));
vi.mock('../../utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    detectStorageLocations: mockDetectStorageLocations,
    analyzeConversation: mockAnalyzeConversation,
  },
}));

// ---- fs.promises: full surface the write/build paths touch ----
const { mockMkdir, mockWriteFile, mockReadFile, mockReaddir, mockStat, mockAccess } = vi.hoisted(() => ({
  mockMkdir: vi.fn(),
  mockWriteFile: vi.fn(),
  mockReadFile: vi.fn(),
  mockReaddir: vi.fn(),
  mockStat: vi.fn(),
  mockAccess: vi.fn(),
}));
vi.mock('fs', () => ({
  promises: {
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
    readFile: mockReadFile,
    readdir: mockReaddir,
    stat: mockStat,
    access: mockAccess,
  },
}));

// ---- unified-store dual-write helper (reached via addOrUpdate -> dualWriteToStore) ----
const { mockDualWrite } = vi.hoisted(() => ({ mockDualWrite: vi.fn() }));
vi.mock('../unified-store/dual-write.js', () => ({
  dualWriteConversationToStore: mockDualWrite,
}));

import { SkeletonCacheService } from '../skeleton-cache.service.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

const skel = (taskId: string, extra: any = {}): ConversationSkeleton =>
  ({ taskId, metadata: {}, sequence: [], ...extra } as any);

describe('SkeletonCacheService — write/persist/build coverage (#833 C3)', () => {
  let service: SkeletonCacheService;

  beforeEach(() => {
    vi.clearAllMocks();
    SkeletonCacheService.reset();
    service = SkeletonCacheService.getInstance();
    // sane defaults; individual tests override
    mockDetectStorageLocations.mockResolvedValue(['/storage']);
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue('');
    mockReaddir.mockResolvedValue([]);
    // freeze freshness so ensureFreshCache() never reloads/clears a manually-seeded cache
    (service as any).lastRefreshTime = Date.now();
  });

  afterEach(() => {
    SkeletonCacheService.reset();
    vi.restoreAllMocks();
  });

  describe('getCacheSize', () => {
    test('reflects the number of cached skeletons', () => {
      expect(service.getCacheSize()).toBe(0);
      (service as any).cache.set('a', skel('a'));
      (service as any).cache.set('b', skel('b'));
      expect(service.getCacheSize()).toBe(2);
    });
  });

  describe('getSkeletonDir', () => {
    test('returns null when no storage location is detected', async () => {
      mockDetectStorageLocations.mockResolvedValue([]);
      expect(await (service as any).getSkeletonDir()).toBeNull();
    });

    test('resolves to <storage>/tasks/.skeletons', async () => {
      mockDetectStorageLocations.mockResolvedValue(['/storage']);
      const dir: string = await (service as any).getSkeletonDir();
      expect(dir).toContain('tasks');
      expect(dir).toContain('.skeletons');
    });

    test('returns null when the detector throws', async () => {
      mockDetectStorageLocations.mockRejectedValue(new Error('detect boom'));
      expect(await (service as any).getSkeletonDir()).toBeNull();
    });
  });

  describe('saveSkeleton', () => {
    test('returns false when nothing to save (no arg, not cached)', async () => {
      expect(await service.saveSkeleton('missing')).toBe(false);
    });

    test('returns false when the skeleton dir cannot be resolved', async () => {
      mockDetectStorageLocations.mockResolvedValue([]);
      expect(await service.saveSkeleton('t', skel('t'))).toBe(false);
    });

    test('writes, verifies length, and returns true on success', async () => {
      const s = skel('t1');
      const json = JSON.stringify(s, null, 2);
      mockWriteFile.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(json); // length matches -> verified
      expect(await service.saveSkeleton('t1', s)).toBe(true);
      expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('.skeletons'), { recursive: true });
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
    });

    test('falls back to the cached skeleton when no arg is passed', async () => {
      const s = skel('cached-1');
      (service as any).cache.set('cached-1', s);
      mockReadFile.mockResolvedValue(JSON.stringify(s, null, 2));
      expect(await service.saveSkeleton('cached-1')).toBe(true);
    });

    test('returns false after 3 failed post-write verifications', async () => {
      mockWriteFile.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('SHORT'); // length never matches JSON
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await service.saveSkeleton('t2', skel('t2'))).toBe(false);
      expect(mockReadFile).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalled();
    });

    test('retries on write error then gives up and swallows the final throw', async () => {
      mockWriteFile.mockRejectedValue(new Error('EIO'));
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await service.saveSkeleton('t3', skel('t3'))).toBe(false);
      expect(mockWriteFile).toHaveBeenCalledTimes(3); // attempt 3 rethrows -> outer catch
      expect(err).toHaveBeenCalled();
    });
  });

  describe('saveAllToDisk', () => {
    test('tallies saved vs errors across the cache', async () => {
      (service as any).cache.set('ok', skel('ok'));
      (service as any).cache.set('bad', skel('bad'));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const spy = vi
        .spyOn(service, 'saveSkeleton')
        .mockImplementation(async (id: string) => id === 'ok');
      const res = await service.saveAllToDisk();
      expect(res).toEqual({ saved: 1, errors: 1 });
      expect(spy).toHaveBeenCalledTimes(2);
      log.mockRestore();
    });
  });

  describe('addOrUpdate + dualWriteToStore', () => {
    test('caches, persists, and fires a best-effort dual-write', async () => {
      vi.spyOn(service, 'saveSkeleton').mockResolvedValue(true);
      mockDualWrite.mockResolvedValue(undefined);
      const s = skel('add-1');
      await service.addOrUpdate('add-1', s);
      expect((service as any).cache.get('add-1')).toBe(s);
      expect(service.saveSkeleton).toHaveBeenCalledWith('add-1', s);
      // dual-write is fire-and-forget (dynamic import) — wait for it to land
      await vi.waitFor(() => expect(mockDualWrite).toHaveBeenCalledWith('add-1', s));
    });

    test('swallows a dual-write rejection without failing addOrUpdate', async () => {
      vi.spyOn(service, 'saveSkeleton').mockResolvedValue(true);
      mockDualWrite.mockRejectedValue(new Error('pg down'));
      await expect(service.addOrUpdate('add-2', skel('add-2'))).resolves.toBeUndefined();
      await vi.waitFor(() => expect(mockDualWrite).toHaveBeenCalled());
      // allow the swallowing .catch() microtask to settle
      await Promise.resolve();
    });
  });

  describe('buildMissingSkeletons', () => {
    const tasksDir = '/storage/tasks';
    const skeletonDir = '/storage/tasks/.skeletons';

    test('builds the missing, skips existing, ignores non-dirs and the .skeletons dir', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        { name: '.skeletons', isDirectory: () => true }, // skipped: name === cache dir
        { name: 'notes.txt', isDirectory: () => false }, // skipped: not a directory
        { name: 'conv-exists', isDirectory: () => true }, // access resolves -> skippedCount
        { name: 'conv-new', isDirectory: () => true }, // access rejects -> built
        { name: 'conv-null', isDirectory: () => true }, // analyze -> null -> not built
        { name: 'conv-err', isDirectory: () => true }, // analyze throws -> inner catch
      ] as any);
      mockAccess.mockImplementation(async (p: string) => {
        if (p.includes('conv-exists')) return undefined; // skeleton already present
        throw new Error('ENOENT'); // missing -> build
      });
      mockAnalyzeConversation.mockImplementation(async (id: string) => {
        if (id === 'conv-new') return skel('conv-new');
        if (id === 'conv-null') return null;
        if (id === 'conv-err') throw new Error('analyze fail');
        return null;
      });
      mockWriteFile.mockResolvedValue(undefined);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});

      await (service as any).buildMissingSkeletons(tasksDir, skeletonDir);

      expect(mockWriteFile).toHaveBeenCalledTimes(1); // only conv-new
      expect((service as any).cache.get('conv-new')).toBeTruthy();
      expect(err).toHaveBeenCalled(); // conv-err inner catch logged
      log.mockRestore();
    });

    test('swallows an outer error (mkdir failure)', async () => {
      mockMkdir.mockRejectedValue(new Error('EACCES'));
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect((service as any).buildMissingSkeletons(tasksDir, skeletonDir)).resolves.toBeUndefined();
      expect(err).toHaveBeenCalled();
    });
  });

  describe('loadSkeletonsFromDisk branches (via forceRefresh)', () => {
    test('tasks dir exists but skeleton dir is absent -> auto-create path', async () => {
      mockDetectStorageLocations.mockResolvedValue(['/storage']);
      mockStat.mockImplementation(async (p: string) => {
        if (p.endsWith('.skeletons')) throw new Error('ENOENT'); // skeletonDir absent
        return { isDirectory: () => true } as any; // tasksDir exists
      });
      mockMkdir.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([]); // no conversations to build
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(service.forceRefresh()).resolves.toBeUndefined();
      log.mockRestore();
      warn.mockRestore();
    });

    test('swallows a load error in the outer catch', async () => {
      mockDetectStorageLocations.mockRejectedValue(new Error('detect fail'));
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(service.forceRefresh()).resolves.toBeUndefined();
      expect(err).toHaveBeenCalled();
    });
  });

  describe('getCacheTierStats', () => {
    test('classifies entries by dataSource tier and reports config flags', async () => {
      const c = (service as any).cache;
      c.set('t1', skel('t1')); // undefined dataSource -> tier1
      c.set('t1b', skel('t1b', { metadata: { dataSource: 'roo' } })); // other -> tier1
      c.set('t2', skel('t2', { metadata: { dataSource: 'claude' } })); // tier2
      c.set('t3', skel('t3', { metadata: { dataSource: 'gdrive-archive' } })); // tier3
      (service as any).lastRefreshTime = Date.now(); // keep cache fresh -> no reload
      SkeletonCacheService.configure({ enableClaudeTier: true });

      const stats = await service.getCacheTierStats();

      expect(stats.tier1_roo).toBe(2);
      expect(stats.tier2_claude).toBe(1);
      expect(stats.tier3_archives).toBe(1);
      expect(stats.total).toBe(4);
      expect(stats.config.enableClaudeTier).toBe(true);
      expect(stats.config.enableArchiveTier).toBe(false);
    });
  });
});
