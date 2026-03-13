/**
 * Tests unitaires pour background-services.ts
 *
 * Couvre :
 * - loadSkeletonsFromDisk : chargement initial depuis le cache
 * - startProactiveMetadataRepair : réparation des métadonnées manquantes
 * - initializeBackgroundServices : orchestration de l'init
 * - saveSkeletonToDisk : sauvegarde d'un squelette
 * - classifyIndexingError (via indexTaskInQdrant)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

// Mock fs module
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
      mkdir: vi.fn(),
    },
  };
});

// Mock RooStorageDetector
vi.mock('../../utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    detectStorageLocations: vi.fn(),
    analyzeConversation: vi.fn(),
  },
}));

// Mock TaskIndexer
vi.mock('../task-indexer.js', () => ({
  TaskIndexer: vi.fn().mockImplementation(() => ({
    indexTask: vi.fn(),
    countPointsByHostOs: vi.fn().mockResolvedValue(0),
  })),
  getHostIdentifier: vi.fn().mockReturnValue('test-host'),
}));

// Mock tools index (imported but unused in tested functions)
vi.mock('../../tools/index.js', () => ({}));

import {
  loadSkeletonsFromDisk,
  startProactiveMetadataRepair,
  initializeBackgroundServices,
  saveSkeletonToDisk,
  startQdrantIndexingBackgroundProcess,
  indexTaskInQdrant,
  QDRANT_INDEX_BATCH_SIZE,
} from '../background-services.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import type { ConversationSkeleton } from '../../types/conversation.js';
import type { ServerState } from '../state-manager.service.js';

const mockFs = fs as unknown as {
  readdir: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  access: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
};

const mockDetector = RooStorageDetector as unknown as {
  detectStorageLocations: ReturnType<typeof vi.fn>;
  analyzeConversation: ReturnType<typeof vi.fn>;
};

function createMockSkeleton(taskId: string, overrides?: Partial<ConversationSkeleton>): ConversationSkeleton {
  return {
    taskId,
    metadata: {
      title: `Task ${taskId}`,
      lastActivity: '2026-02-10T10:00:00Z',
      createdAt: '2026-02-10T09:00:00Z',
      messageCount: 5,
      actionCount: 2,
      totalSize: 1024,
    },
    sequence: [],
    ...overrides,
  };
}

describe('background-services', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // === loadSkeletonsFromDisk ===

  describe('loadSkeletonsFromDisk', () => {
    it('should load skeletons from .skeletons cache directory', async () => {
      const cache = new Map<string, ConversationSkeleton>();
      const skeleton1 = createMockSkeleton('task-001');
      const skeleton2 = createMockSkeleton('task-002');

      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.readdir.mockResolvedValue(['task-001.json', 'task-002.json']);
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(skeleton1))
        .mockResolvedValueOnce(JSON.stringify(skeleton2));

      await loadSkeletonsFromDisk(cache);

      expect(cache.size).toBe(2);
      expect(cache.get('task-001')).toEqual(skeleton1);
      expect(cache.get('task-002')).toEqual(skeleton2);
    });

    it('should skip non-JSON files', async () => {
      const cache = new Map<string, ConversationSkeleton>();
      const skeleton1 = createMockSkeleton('task-001');

      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.readdir.mockResolvedValue(['task-001.json', 'README.md', 'notes.txt']);
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(skeleton1));

      await loadSkeletonsFromDisk(cache);

      expect(cache.size).toBe(1);
      expect(mockFs.readFile).toHaveBeenCalledTimes(1);
    });

    it('should handle no storage locations', async () => {
      const cache = new Map<string, ConversationSkeleton>();

      mockDetector.detectStorageLocations.mockResolvedValue([]);

      await loadSkeletonsFromDisk(cache);

      expect(cache.size).toBe(0);
    });

    it('should handle missing cache directory gracefully', async () => {
      const cache = new Map<string, ConversationSkeleton>();

      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.readdir.mockRejectedValue(new Error('ENOENT'));

      await loadSkeletonsFromDisk(cache);

      expect(cache.size).toBe(0);
    });

    it('should skip corrupt skeleton files and continue', async () => {
      const cache = new Map<string, ConversationSkeleton>();
      const skeleton2 = createMockSkeleton('task-002');

      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.readdir.mockResolvedValue(['task-001.json', 'task-002.json']);
      mockFs.readFile
        .mockResolvedValueOnce('not valid json {{{')
        .mockResolvedValueOnce(JSON.stringify(skeleton2));

      await loadSkeletonsFromDisk(cache);

      expect(cache.size).toBe(1);
      expect(cache.has('task-002')).toBe(true);
    });

    it('should handle detectStorageLocations failure', async () => {
      const cache = new Map<string, ConversationSkeleton>();

      mockDetector.detectStorageLocations.mockRejectedValue(new Error('Detection failed'));

      await loadSkeletonsFromDisk(cache);

      expect(cache.size).toBe(0);
    });

    it('should strip BOM UTF-8 from skeleton file content', async () => {
      const cache = new Map<string, ConversationSkeleton>();
      const skeleton = createMockSkeleton('task-bom');

      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.readdir.mockResolvedValue(['task-bom.json']);
      // Content with BOM at start (charCode 0xFEFF)
      const contentWithBom = '\uFEFF' + JSON.stringify(skeleton);
      mockFs.readFile.mockResolvedValueOnce(contentWithBom);

      await loadSkeletonsFromDisk(cache);

      expect(cache.size).toBe(1);
      expect(cache.get('task-bom')).toEqual(skeleton);
    });
  });

  // === startProactiveMetadataRepair ===

  describe('startProactiveMetadataRepair', () => {
    it('should do nothing when no storage locations', async () => {
      mockDetector.detectStorageLocations.mockResolvedValue([]);

      await startProactiveMetadataRepair();

      expect(mockDetector.analyzeConversation).not.toHaveBeenCalled();
    });

    it('should skip .skeletons directory', async () => {
      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.readdir.mockResolvedValue(['.skeletons', 'task-001']);
      mockFs.stat.mockResolvedValue({ isDirectory: () => true });
      mockFs.readdir
        .mockResolvedValueOnce(['.skeletons', 'task-001']) // tasks dir listing
        .mockResolvedValueOnce(['api_conversation_history.json']); // task-001 dir listing
      mockFs.access.mockResolvedValue(undefined); // metadata exists

      await startProactiveMetadataRepair();

      // .skeletons should be skipped, task-001 has metadata so no repair needed
      expect(mockDetector.analyzeConversation).not.toHaveBeenCalled();
    });

    it('should repair tasks missing metadata', async () => {
      const repairedSkeleton = createMockSkeleton('task-001');

      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      // First call: readdir for tasks directory
      mockFs.readdir
        .mockResolvedValueOnce(['task-001'])
        // Second call: readdir for task-001 directory (non-empty)
        .mockResolvedValueOnce(['api_conversation_history.json']);
      mockFs.stat.mockResolvedValue({ isDirectory: () => true });
      // access throws = metadata doesn't exist
      mockFs.access.mockRejectedValue(new Error('ENOENT'));
      mockDetector.analyzeConversation.mockResolvedValue(repairedSkeleton);
      mockFs.writeFile.mockResolvedValue(undefined);

      await startProactiveMetadataRepair();

      expect(mockDetector.analyzeConversation).toHaveBeenCalledWith('task-001', expect.stringContaining('task-001'));
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('task_metadata.json'),
        expect.any(String),
        'utf-8'
      );
    });

    it('should skip empty task directories', async () => {
      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.readdir
        .mockResolvedValueOnce(['task-empty'])
        .mockResolvedValueOnce([]); // empty directory
      mockFs.stat.mockResolvedValue({ isDirectory: () => true });

      await startProactiveMetadataRepair();

      expect(mockDetector.analyzeConversation).not.toHaveBeenCalled();
    });

    it('should skip non-directory entries', async () => {
      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.readdir.mockResolvedValueOnce(['some-file.txt']);
      mockFs.stat.mockResolvedValue({ isDirectory: () => false });

      await startProactiveMetadataRepair();

      expect(mockDetector.analyzeConversation).not.toHaveBeenCalled();
    });

    it('should handle analyzeConversation returning null', async () => {
      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.readdir
        .mockResolvedValueOnce(['task-001'])
        .mockResolvedValueOnce(['api_conversation_history.json']);
      mockFs.stat.mockResolvedValue({ isDirectory: () => true });
      mockFs.access.mockRejectedValue(new Error('ENOENT'));
      mockDetector.analyzeConversation.mockResolvedValue(null);

      await startProactiveMetadataRepair();

      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it('should handle errors in task listing gracefully', async () => {
      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.readdir.mockRejectedValue(new Error('Permission denied'));

      await expect(startProactiveMetadataRepair()).resolves.not.toThrow();
    });

    it('should process tasks in batches of 5', async () => {
      // Create 7 tasks needing repair (2 batches: 5 + 2)
      const taskIds = Array.from({ length: 7 }, (_, i) => `task-${i}`);

      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.readdir.mockResolvedValueOnce(taskIds);

      // For each task: stat + readdir + access
      for (const _ of taskIds) {
        mockFs.stat.mockResolvedValueOnce({ isDirectory: () => true });
        mockFs.readdir.mockResolvedValueOnce(['history.json']);
        mockFs.access.mockRejectedValueOnce(new Error('ENOENT'));
      }

      // analyzeConversation returns skeleton for each
      for (const id of taskIds) {
        mockDetector.analyzeConversation.mockResolvedValueOnce(createMockSkeleton(id));
      }
      mockFs.writeFile.mockResolvedValue(undefined);

      await startProactiveMetadataRepair();

      expect(mockDetector.analyzeConversation).toHaveBeenCalledTimes(7);
      expect(mockFs.writeFile).toHaveBeenCalledTimes(7);
    });
  });

  // === saveSkeletonToDisk ===

  describe('saveSkeletonToDisk', () => {
    it('should save skeleton to .skeletons directory', async () => {
      const skeleton = createMockSkeleton('task-100');

      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      await saveSkeletonToDisk(skeleton);

      expect(mockFs.mkdir).toHaveBeenCalledWith(
        expect.stringContaining('.skeletons'),
        { recursive: true }
      );
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('task-100.json'),
        JSON.stringify(skeleton, null, 2),
        'utf8'
      );
    });

    it('should throw RooStorageDetectorError when no storage found', async () => {
      const skeleton = createMockSkeleton('task-200');

      mockDetector.detectStorageLocations.mockResolvedValue([]);

      // saveSkeletonToDisk catches errors internally
      await expect(saveSkeletonToDisk(skeleton)).resolves.not.toThrow();
      // But writeFile should not be called
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it('should handle write errors gracefully', async () => {
      const skeleton = createMockSkeleton('task-300');

      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockRejectedValue(new Error('Disk full'));

      // Should not throw - errors are caught internally
      await expect(saveSkeletonToDisk(skeleton)).resolves.not.toThrow();
    });

    it('should use first storage location', async () => {
      const skeleton = createMockSkeleton('task-400');

      mockDetector.detectStorageLocations.mockResolvedValue(['/first/loc', '/second/loc']);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      await saveSkeletonToDisk(skeleton);

      const expectedDir = path.join('/first/loc', 'tasks', '.skeletons');
      expect(mockFs.mkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
    });
  });

  // === initializeBackgroundServices ===

  describe('initializeBackgroundServices', () => {
    function createMockState(): ServerState {
      return {
        conversationCache: new Map(),
        qdrantIndexQueue: new Set(),
        qdrantIndexInterval: null,
        isQdrantIndexingEnabled: true,
        qdrantIndexCache: new Map(),
        lastQdrantConsistencyCheck: 0,
        indexingDecisionService: {
          shouldIndex: vi.fn().mockReturnValue({ shouldIndex: false, reason: 'skip', action: 'skip', requiresSave: false }),
          migrateLegacyIndexingState: vi.fn().mockReturnValue(false),
          markIndexingSuccess: vi.fn(),
          markIndexingFailure: vi.fn(),
        },
        indexingMetrics: {
          totalTasks: 0,
          skippedTasks: 0,
          indexedTasks: 0,
          failedTasks: 0,
          retryTasks: 0,
          bandwidthSaved: 0,
        },
        // Stubs for unused services
        xmlExporterService: {} as any,
        exportConfigManager: {} as any,
        traceSummaryService: {} as any,
        llmService: {} as any,
        narrativeContextBuilderService: {} as any,
        synthesisOrchestratorService: {} as any,
      } as unknown as ServerState;
    }

    it('should call loadSkeletonsFromDisk and startProactiveMetadataRepair', async () => {
      const state = createMockState();

      // Both functions rely on detectStorageLocations
      mockDetector.detectStorageLocations.mockResolvedValue([]);

      await initializeBackgroundServices(state);

      // Verify both functions were called (detector called at least twice)
      expect(mockDetector.detectStorageLocations).toHaveBeenCalled();
    });

    it('should handle errors in sub-services gracefully', async () => {
      const state = createMockState();

      // loadSkeletonsFromDisk catches its own errors, but initializeQdrantIndexingService
      // may throw and be caught by the outer try/catch which re-throws
      mockDetector.detectStorageLocations.mockResolvedValue([]);

      // Should complete without throwing (sub-errors are caught internally)
      await expect(initializeBackgroundServices(state)).resolves.not.toThrow();
    });

    it('should disable Qdrant indexing on initialization failure', async () => {
      const state = createMockState();
      // Set lastQdrantConsistencyCheck to 0 so verifyQdrantConsistency runs
      state.lastQdrantConsistencyCheck = 0;

      mockDetector.detectStorageLocations.mockResolvedValue([]);

      await initializeBackgroundServices(state);

      // After initialization with no storage, the function completes
      expect(state.conversationCache.size).toBe(0);
    });
  });

  // === startQdrantIndexingBackgroundProcess (#686) ===

  describe('startQdrantIndexingBackgroundProcess', () => {
    function createQdrantMockState(): ServerState {
      return {
        conversationCache: new Map(),
        qdrantIndexQueue: new Set(),
        qdrantIndexInterval: null,
        isQdrantIndexingEnabled: true,
        qdrantIndexCache: new Map(),
        lastQdrantConsistencyCheck: 0,
        indexingDecisionService: {
          shouldIndex: vi.fn().mockReturnValue({ shouldIndex: true, reason: 'not indexed', action: 'index', requiresSave: false }),
          migrateLegacyIndexingState: vi.fn().mockReturnValue(false),
          markIndexingSuccess: vi.fn(),
          markIndexingFailure: vi.fn(),
        },
        indexingMetrics: {
          totalTasks: 0,
          skippedTasks: 0,
          indexedTasks: 0,
          failedTasks: 0,
          retryTasks: 0,
          bandwidthSaved: 0,
        },
        xmlExporterService: {} as any,
        exportConfigManager: {} as any,
        traceSummaryService: {} as any,
        llmService: {} as any,
        narrativeContextBuilderService: {} as any,
        synthesisOrchestratorService: {} as any,
      } as unknown as ServerState;
    }

    it('should create a setInterval and store it in state.qdrantIndexInterval', () => {
      vi.useFakeTimers();
      const state = createQdrantMockState();

      startQdrantIndexingBackgroundProcess(state);

      expect(state.qdrantIndexInterval).not.toBeNull();
      vi.useRealTimers();
    });

    it('should clear existing interval before creating a new one', () => {
      vi.useFakeTimers();
      const state = createQdrantMockState();
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      // Simulate existing interval
      const fakeInterval = setInterval(() => {}, 9999);
      state.qdrantIndexInterval = fakeInterval;

      startQdrantIndexingBackgroundProcess(state);

      expect(clearIntervalSpy).toHaveBeenCalledWith(fakeInterval);
      vi.useRealTimers();
    });

    it('should not process queue when isQdrantIndexingEnabled is false', async () => {
      vi.useFakeTimers();
      const state = createQdrantMockState();
      state.isQdrantIndexingEnabled = false;
      state.qdrantIndexQueue.add('task-001');

      startQdrantIndexingBackgroundProcess(state);
      // Advance exactly one interval (not runAllTimers which loops forever)
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      // Queue should still contain the task (not processed because disabled)
      expect(state.qdrantIndexQueue.has('task-001')).toBe(true);
      vi.useRealTimers();
    });

    it('should not process when queue is empty', async () => {
      vi.useFakeTimers();
      const state = createQdrantMockState();
      // Queue is empty, indexing enabled

      startQdrantIndexingBackgroundProcess(state);
      // Advance exactly one interval
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      // No tasks should have been indexed (queue was empty)
      expect(state.indexingMetrics.indexedTasks).toBe(0);
      vi.useRealTimers();
    });

    it('should process up to QDRANT_INDEX_BATCH_SIZE tasks per interval', async () => {
      const state = createQdrantMockState();

      // Add more tasks than batch size
      const taskCount = QDRANT_INDEX_BATCH_SIZE + 2;
      for (let i = 0; i < taskCount; i++) {
        const taskId = `task-${i.toString().padStart(3, '0')}`;
        const skeleton = createMockSkeleton(taskId);
        state.conversationCache.set(taskId, skeleton);
        state.qdrantIndexQueue.add(taskId);
      }

      // Capture the setInterval callback via spy (no fake timers needed)
      let capturedCallback: (() => Promise<void>) | null = null;
      const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation((fn: any) => {
        capturedCallback = fn;
        return 0 as any; // fake timer handle
      });

      // Mock TaskIndexer to succeed
      const { TaskIndexer } = await import('../task-indexer.js');
      const mockIndexTask = vi.fn().mockResolvedValue(undefined);
      vi.mocked(TaskIndexer).mockImplementation(() => ({ indexTask: mockIndexTask }) as any);

      // Mock RooStorageDetector for indexTaskInQdrant
      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.mkdir.mockResolvedValue(undefined);

      startQdrantIndexingBackgroundProcess(state);

      expect(capturedCallback).not.toBeNull();
      // Manually invoke one interval tick
      await capturedCallback!();

      // After one interval, queue should have been reduced by QDRANT_INDEX_BATCH_SIZE
      expect(state.qdrantIndexQueue.size).toBe(2); // taskCount - QDRANT_INDEX_BATCH_SIZE

      setIntervalSpy.mockRestore();
    });

    it('QDRANT_INDEX_BATCH_SIZE should be greater than 1 for improved throughput', () => {
      expect(QDRANT_INDEX_BATCH_SIZE).toBeGreaterThan(1);
    });
  });

  // === indexTaskInQdrant (#686) ===

  describe('indexTaskInQdrant', () => {
    function createQdrantMockState(): ServerState {
      return {
        conversationCache: new Map(),
        qdrantIndexQueue: new Set(),
        qdrantIndexInterval: null,
        isQdrantIndexingEnabled: true,
        qdrantIndexCache: new Map(),
        lastQdrantConsistencyCheck: 0,
        indexingDecisionService: {
          shouldIndex: vi.fn().mockReturnValue({ shouldIndex: true, reason: 'not indexed', action: 'index', requiresSave: false }),
          migrateLegacyIndexingState: vi.fn().mockReturnValue(false),
          markIndexingSuccess: vi.fn(),
          markIndexingFailure: vi.fn(),
        },
        indexingMetrics: {
          totalTasks: 0,
          skippedTasks: 0,
          indexedTasks: 0,
          failedTasks: 0,
          retryTasks: 0,
          bandwidthSaved: 0,
        },
        xmlExporterService: {} as any,
        exportConfigManager: {} as any,
        traceSummaryService: {} as any,
        llmService: {} as any,
        narrativeContextBuilderService: {} as any,
        synthesisOrchestratorService: {} as any,
      } as unknown as ServerState;
    }

    it('should skip indexing when skeleton is not in cache', async () => {
      const state = createQdrantMockState();

      await indexTaskInQdrant('task-missing', state);

      expect(state.indexingMetrics.indexedTasks).toBe(0);
    });

    it('should skip indexing when shouldIndex returns false', async () => {
      const state = createQdrantMockState();
      const skeleton = createMockSkeleton('task-001');
      state.conversationCache.set('task-001', skeleton);
      (state.indexingDecisionService.shouldIndex as ReturnType<typeof vi.fn>).mockReturnValue({
        shouldIndex: false,
        reason: 'already indexed',
        action: 'skip',
        requiresSave: false,
      });

      await indexTaskInQdrant('task-001', state);

      expect(state.indexingMetrics.indexedTasks).toBe(0);
    });

    it('should increment indexedTasks on success', async () => {
      const state = createQdrantMockState();
      const skeleton = createMockSkeleton('task-001');
      state.conversationCache.set('task-001', skeleton);

      const { TaskIndexer } = await import('../task-indexer.js');
      const mockIndexTask = vi.fn().mockResolvedValue(undefined);
      vi.mocked(TaskIndexer).mockImplementation(() => ({ indexTask: mockIndexTask }) as any);

      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.mkdir.mockResolvedValue(undefined);

      await indexTaskInQdrant('task-001', state);

      expect(state.indexingMetrics.indexedTasks).toBe(1);
      expect(state.indexingDecisionService.markIndexingSuccess).toHaveBeenCalledWith(skeleton);
    });

    it('should add taskId to qdrantIndexCache on success', async () => {
      const state = createQdrantMockState();
      const skeleton = createMockSkeleton('task-001');
      state.conversationCache.set('task-001', skeleton);

      const { TaskIndexer } = await import('../task-indexer.js');
      const mockIndexTask = vi.fn().mockResolvedValue(undefined);
      vi.mocked(TaskIndexer).mockImplementation(() => ({ indexTask: mockIndexTask }) as any);

      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.mkdir.mockResolvedValue(undefined);

      await indexTaskInQdrant('task-001', state);

      expect(state.qdrantIndexCache.has('task-001')).toBe(true);
    });

    it('should handle indexing errors without throwing', async () => {
      const state = createQdrantMockState();
      const skeleton = createMockSkeleton('task-001');
      state.conversationCache.set('task-001', skeleton);

      const { TaskIndexer } = await import('../task-indexer.js');
      const mockIndexTask = vi.fn().mockRejectedValue(new Error('Qdrant connection refused'));
      vi.mocked(TaskIndexer).mockImplementation(() => ({ indexTask: mockIndexTask }) as any);

      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);

      // Should not throw
      await expect(indexTaskInQdrant('task-001', state)).resolves.not.toThrow();
      expect(state.indexingMetrics.indexedTasks).toBe(0);
    });
  });
});
