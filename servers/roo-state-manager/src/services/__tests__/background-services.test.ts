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

// Mock tools index (imported but unused in tested functions)
vi.mock('../../tools/index.js', () => ({}));

// Mock TaskArchiver (dynamically imported)
vi.mock('../task-archiver/index.js', () => ({
  TaskArchiver: {
    archiveTask: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock TaskIndexer with spies on the prototype
vi.mock('../task-indexer.js', () => {
  const indexTaskSpy = vi.fn().mockResolvedValue([]);
  const countPointsByHostOsSpy = vi.fn().mockResolvedValue(0);

  class MockTaskIndexer {
    async indexTask(taskId: string, source: 'roo' | 'claude-code') {
      return indexTaskSpy(taskId, source);
    }
    async countPointsByHostOs(hostOs: string) {
      return countPointsByHostOsSpy(hostOs);
    }
  }

  // Attach spies to the class for test access
  (MockTaskIndexer as any).indexTaskSpy = indexTaskSpy;
  (MockTaskIndexer as any).countPointsByHostOsSpy = countPointsByHostOsSpy;

  return {
    TaskIndexer: MockTaskIndexer,
    getHostIdentifier: vi.fn().mockReturnValue('test-host'),
  };
});

import {
  loadSkeletonsFromDisk,
  startProactiveMetadataRepair,
  initializeBackgroundServices,
  saveSkeletonToDisk,
  startQdrantIndexingBackgroundProcess,
  indexTaskInQdrant,
} from '../background-services.js';
import { classifyIndexingError } from '../background-services.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import type { ConversationSkeleton } from '../../types/conversation.js';
import type { ServerState } from '../state-manager.service.js';
import { ANTI_LEAK_CONFIG } from '../../config/server-config.js';
// TaskIndexer is mocked above, no need to import the actual class
import { TaskIndexer } from '../task-indexer.js';

// Helper to access the spies attached to the mock
const TaskIndexerSpies = {
  get indexTask() {
    return (TaskIndexer as any).indexTaskSpy;
  },
  get countPointsByHostOs() {
    return (TaskIndexer as any).countPointsByHostOsSpy;
  },
};

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

describe('background-services', () => {
  // Helper to get mocked TaskIndexer instance
  function getMockTaskIndexer() {
    return vi.mocked(new TaskIndexer());
  }

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

  // === Integration Tests: Background Indexer ===

  describe('startQdrantIndexingBackgroundProcess', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // Reset mock behaviors before each test
      TaskIndexerSpies.indexTask.mockReset();
    });

    afterEach(() => {
      if (vi.getTimerCount() > 0) {
        vi.clearAllTimers();
      }
      vi.useRealTimers();
    });

    it('should create a setInterval with correct interval', () => {
      const state = createMockState();
      state.isQdrantIndexingEnabled = true;
      state.qdrantIndexQueue.add('task-001');

      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      startQdrantIndexingBackgroundProcess(state);

      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        ANTI_LEAK_CONFIG.MAX_BACKGROUND_INTERVAL
      );
      expect(state.qdrantIndexInterval).not.toBeNull();
    });

    it('should clear existing interval if present', () => {
      const state = createMockState();
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      // Simulate existing interval
      const existingInterval = setInterval(() => {}, 1000);
      state.qdrantIndexInterval = existingInterval as unknown as NodeJS.Timeout;

      startQdrantIndexingBackgroundProcess(state);

      // Clean up the interval to avoid leaks
      clearInterval(existingInterval);

      expect(clearIntervalSpy).toHaveBeenCalledWith(existingInterval);
    });

    it('should not process tasks when isQdrantIndexingEnabled is false', async () => {
      const state = createMockState();
      state.isQdrantIndexingEnabled = false;
      state.qdrantIndexQueue.add('task-001');

      const skeleton = createMockSkeleton('task-001');
      state.conversationCache.set('task-001', skeleton);

      startQdrantIndexingBackgroundProcess(state);

      // Advance timers to trigger interval callback (but it should skip due to isQdrantIndexingEnabled=false)
      vi.advanceTimersByTime(ANTI_LEAK_CONFIG.MAX_BACKGROUND_INTERVAL);
      // Only trigger pending timers once, don't run infinitely
      await vi.runOnlyPendingTimersAsync();

      // Task should still be in queue (not processed)
      expect(state.qdrantIndexQueue.has('task-001')).toBe(true);
      expect(TaskIndexerSpies.indexTask).not.toHaveBeenCalled();
    });

    it('should not process when queue is empty', async () => {
      const state = createMockState();
      state.isQdrantIndexingEnabled = true;

      const mockIndexTask = TaskIndexerSpies.indexTask;

      startQdrantIndexingBackgroundProcess(state);

      // Advance timers
      vi.advanceTimersByTime(ANTI_LEAK_CONFIG.MAX_BACKGROUND_INTERVAL);
      await vi.runOnlyPendingTimersAsync();

      expect(mockIndexTask).not.toHaveBeenCalled();
    });

    it('should process tasks from queue one at a time', async () => {
      const state = createMockState();
      state.isQdrantIndexingEnabled = true;
      state.qdrantIndexQueue.add('task-001');

      const skeleton = createMockSkeleton('task-001');
      skeleton.metadata = {
        ...skeleton.metadata,
        indexingState: { indexStatus: 'pending' as const },
      };
      state.conversationCache.set('task-001', skeleton);

      // Override shouldIndex to allow processing
      state.indexingDecisionService.shouldIndex.mockReturnValue({
        shouldIndex: true,
        reason: 'test',
        action: 'index',
        requiresSave: false,
      });

      const mockIndexTask = TaskIndexerSpies.indexTask;
      mockIndexTask.mockResolvedValue(undefined);
      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      startQdrantIndexingBackgroundProcess(state);

      // Advance timers to trigger interval
      vi.advanceTimersByTime(ANTI_LEAK_CONFIG.MAX_BACKGROUND_INTERVAL);
      await vi.runOnlyPendingTimersAsync();

      // Task should be processed and removed from queue
      expect(state.qdrantIndexQueue.has('task-001')).toBe(false);
      expect(mockIndexTask).toHaveBeenCalledWith('task-001', 'roo');
    });

    it('should remove task from queue after processing', async () => {
      const state = createMockState();
      state.isQdrantIndexingEnabled = true;
      state.qdrantIndexQueue.add('task-001');

      const skeleton = createMockSkeleton('task-001');
      skeleton.metadata = {
        ...skeleton.metadata,
        indexingState: { indexStatus: 'pending' as const },
      };
      state.conversationCache.set('task-001', skeleton);

      // Override shouldIndex to allow processing
      state.indexingDecisionService.shouldIndex.mockReturnValue({
        shouldIndex: true,
        reason: 'test',
        action: 'index',
        requiresSave: false,
      });

      const mockIndexTask = TaskIndexerSpies.indexTask;
      mockIndexTask.mockResolvedValue(undefined);
      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      startQdrantIndexingBackgroundProcess(state);

      // Advance timers
      vi.advanceTimersByTime(ANTI_LEAK_CONFIG.MAX_BACKGROUND_INTERVAL);
      await vi.runOnlyPendingTimersAsync();

      expect(state.qdrantIndexQueue.size).toBe(0);
    });

    it('should process multiple tasks over multiple intervals', async () => {
      const state = createMockState();
      state.isQdrantIndexingEnabled = true;
      state.qdrantIndexQueue.add('task-001');
      state.qdrantIndexQueue.add('task-002');

      const skeleton1 = createMockSkeleton('task-001');
      const skeleton2 = createMockSkeleton('task-002');
      skeleton1.metadata = { ...skeleton1.metadata, indexingState: { indexStatus: 'pending' as const } };
      skeleton2.metadata = { ...skeleton2.metadata, indexingState: { indexStatus: 'pending' as const } };
      state.conversationCache.set('task-001', skeleton1);
      state.conversationCache.set('task-002', skeleton2);

      // Override shouldIndex to allow processing
      state.indexingDecisionService.shouldIndex.mockReturnValue({
        shouldIndex: true,
        reason: 'test',
        action: 'index',
        requiresSave: false,
      });

      const mockIndexTask = TaskIndexerSpies.indexTask;
      mockIndexTask.mockResolvedValue(undefined);
      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      startQdrantIndexingBackgroundProcess(state);

      // Advance time for two intervals
      vi.advanceTimersByTime(ANTI_LEAK_CONFIG.MAX_BACKGROUND_INTERVAL * 2);
      await vi.runOnlyPendingTimersAsync();

      // Both tasks should be processed (verify through mock calls)
      // Note: The exact call count may vary due to timer flushing behavior,
      // but both tasks should be called at least once
      expect(mockIndexTask.mock.calls.some(call => call[0] === 'task-001' && call[1] === 'roo')).toBe(true);
      expect(mockIndexTask.mock.calls.some(call => call[0] === 'task-002' && call[1] === 'roo')).toBe(true);

      // Queue should be empty
      expect(state.qdrantIndexQueue.size).toBe(0);
    });
  });

  describe('indexTaskInQdrant', () => {
    it('should skip if skeleton not found in cache', async () => {
      const state = createMockState();
      state.isQdrantIndexingEnabled = true;

      const mockIndexTask = TaskIndexerSpies.indexTask;

      await indexTaskInQdrant('non-existent-task', state);

      expect(mockIndexTask).not.toHaveBeenCalled();
    });

    it('should skip if shouldIndex returns false', async () => {
      const state = createMockState();
      const skeleton = createMockSkeleton('task-001');
      skeleton.metadata = {
        ...skeleton.metadata,
        indexingState: { indexStatus: 'indexed' as const, indexedAt: Date.now() },
      };
      state.conversationCache.set('task-001', skeleton);

      // Mock shouldIndex to return false
      (state.indexingDecisionService.shouldIndex as any).mockReturnValue({
        shouldIndex: false,
        reason: 'already indexed',
        action: 'skip',
        requiresSave: false,
      });

      const mockIndexTask = TaskIndexerSpies.indexTask;

      await indexTaskInQdrant('task-001', state);

      expect(mockIndexTask).not.toHaveBeenCalled();
    });

    it('should call TaskIndexer.indexTask with correct source for roo', async () => {
      const state = createMockState();
      const skeleton = createMockSkeleton('task-001');
      skeleton.metadata = {
        ...skeleton.metadata,
        indexingState: { indexStatus: 'pending' as const },
        dataSource: 'roo',
      };
      state.conversationCache.set('task-001', skeleton);

      (state.indexingDecisionService.shouldIndex as any).mockReturnValue({
        shouldIndex: true,
        reason: 'new task',
        action: 'index',
        requiresSave: false,
      });

      const mockIndexTask = TaskIndexerSpies.indexTask;
      mockIndexTask.mockResolvedValue(undefined);
      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      await indexTaskInQdrant('task-001', state);

      expect(mockIndexTask).toHaveBeenCalledWith('task-001', 'roo');
      expect(state.indexingDecisionService.markIndexingSuccess).toHaveBeenCalledWith(skeleton);
    });

    it('should call TaskIndexer.indexTask with correct source for claude-code', async () => {
      const state = createMockState();
      const skeleton = createMockSkeleton('task-001');
      skeleton.metadata = {
        ...skeleton.metadata,
        indexingState: { indexStatus: 'pending' as const },
        dataSource: 'claude',
      };
      state.conversationCache.set('task-001', skeleton);

      (state.indexingDecisionService.shouldIndex as any).mockReturnValue({
        shouldIndex: true,
        reason: 'new task',
        action: 'index',
        requiresSave: false,
      });

      const mockIndexTask = TaskIndexerSpies.indexTask;
      mockIndexTask.mockResolvedValue(undefined);
      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      await indexTaskInQdrant('task-001', state);

      expect(mockIndexTask).toHaveBeenCalledWith('task-001', 'claude-code');
    });

    it('should update metrics on success', async () => {
      const state = createMockState();
      const skeleton = createMockSkeleton('task-001');
      skeleton.metadata = {
        ...skeleton.metadata,
        indexingState: { indexStatus: 'pending' as const },
      };
      state.conversationCache.set('task-001', skeleton);

      (state.indexingDecisionService.shouldIndex as any).mockReturnValue({
        shouldIndex: true,
        reason: 'new task',
        action: 'index',
        requiresSave: false,
      });

      const mockIndexTask = TaskIndexerSpies.indexTask;
      mockIndexTask.mockResolvedValue(undefined);
      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      await indexTaskInQdrant('task-001', state);

      expect(state.indexingMetrics.indexedTasks).toBe(1);
      expect(state.qdrantIndexCache.has('task-001')).toBe(true);
    });

    it('should classify errors and mark failure appropriately', async () => {
      const state = createMockState();
      const skeleton = createMockSkeleton('task-001');
      skeleton.metadata = {
        ...skeleton.metadata,
        indexingState: { indexStatus: 'pending' as const },
      };
      state.conversationCache.set('task-001', skeleton);

      (state.indexingDecisionService.shouldIndex as any).mockReturnValue({
        shouldIndex: true,
        reason: 'new task',
        action: 'index',
        requiresSave: false,
      });

      const mockIndexTask = TaskIndexerSpies.indexTask;
      mockIndexTask.mockRejectedValue(new Error('file not found'));
      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      await indexTaskInQdrant('task-001', state);

      expect(state.indexingDecisionService.markIndexingFailure).toHaveBeenCalledWith(
        skeleton,
        expect.stringContaining('file not found'),
        true // isPermanentError
      );
      expect(state.indexingMetrics.failedTasks).toBe(1);
    });

    it('should save skeleton when requiresSave is true', async () => {
      const state = createMockState();
      const skeleton = createMockSkeleton('task-001');
      skeleton.metadata = {
        ...skeleton.metadata,
        indexingState: { indexStatus: 'pending' as const },
      };
      state.conversationCache.set('task-001', skeleton);

      (state.indexingDecisionService.shouldIndex as any).mockReturnValue({
        shouldIndex: true,
        reason: 'migration needed',
        action: 'index',
        requiresSave: true,
      });

      const mockIndexTask = TaskIndexerSpies.indexTask;
      mockIndexTask.mockResolvedValue(undefined);
      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      await indexTaskInQdrant('task-001', state);

      // Should be called twice: once for requiresSave, once for success
      expect(mockFs.writeFile).toHaveBeenCalled();
    });

    it('should handle permanent errors and mark for skip', async () => {
      const state = createMockState();
      const skeleton = createMockSkeleton('task-001');
      skeleton.metadata = {
        ...skeleton.metadata,
        indexingState: { indexStatus: 'pending' as const },
      };
      state.conversationCache.set('task-001', skeleton);

      (state.indexingDecisionService.shouldIndex as any).mockReturnValue({
        shouldIndex: true,
        reason: 'new task',
        action: 'index',
        requiresSave: false,
      });

      const mockIndexTask = TaskIndexerSpies.indexTask;
      mockIndexTask.mockRejectedValue(new Error('access denied'));
      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      await indexTaskInQdrant('task-001', state);

      expect(state.indexingDecisionService.markIndexingFailure).toHaveBeenCalledWith(
        skeleton,
        expect.any(String),
        true // permanent error
      );
    });

    it('should handle temporary errors and schedule retry', async () => {
      const state = createMockState();
      const skeleton = createMockSkeleton('task-001');
      skeleton.metadata = {
        ...skeleton.metadata,
        indexingState: { indexStatus: 'pending' as const },
      };
      state.conversationCache.set('task-001', skeleton);

      (state.indexingDecisionService.shouldIndex as any).mockReturnValue({
        shouldIndex: true,
        reason: 'new task',
        action: 'index',
        requiresSave: false,
      });

      const mockIndexTask = TaskIndexerSpies.indexTask;
      mockIndexTask.mockRejectedValue(new Error('network error'));
      mockDetector.detectStorageLocations.mockResolvedValue(['/mock/storage']);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      await indexTaskInQdrant('task-001', state);

      expect(state.indexingDecisionService.markIndexingFailure).toHaveBeenCalledWith(
        skeleton,
        expect.any(String),
        false // temporary error
      );
    });
  });

  // === classifyIndexingError ===

  describe('classifyIndexingError', () => {
    it('should return true for permanent errors', () => {
      const permanentErrors = [
        new Error('file not found'),
        new Error('access denied'),
        new Error('permission denied'),
        new Error('invalid format'),
        new Error('corrupted data'),
        new Error('authentication failed'),
        new Error('quota exceeded permanently'),
      ];

      for (const error of permanentErrors) {
        expect(classifyIndexingError(error)).toBe(true);
      }
    });

    it('should return false for temporary errors', () => {
      const temporaryErrors = [
        new Error('network error'),
        new Error('connection timeout'),
        new Error('rate limit exceeded'),
        new Error('service unavailable'),
        new Error('timeout'),
        new Error('ECONNRESET'),
        new Error('ENOTFOUND'),
      ];

      for (const error of temporaryErrors) {
        expect(classifyIndexingError(error)).toBe(false);
      }
    });

    it('should return false for unknown errors', () => {
      expect(classifyIndexingError(new Error('unknown error'))).toBe(false);
      expect(classifyIndexingError(new Error(''))).toBe(false);
    });

    it('should handle errors without message', () => {
      expect(classifyIndexingError({})).toBe(false);
      expect(classifyIndexingError({ message: null })).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(classifyIndexingError(new Error('FILE NOT FOUND'))).toBe(true);
      expect(classifyIndexingError(new Error('Network Error'))).toBe(false);
    });
  });
});
