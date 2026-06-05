/**
 * Tests for ZooTaskExtractor — #2429
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to create mocks that can be referenced inside vi.mock factories
const { mockReaddir, mockReadFile, mockStat } = vi.hoisted(() => ({
  mockReaddir: vi.fn(),
  mockReadFile: vi.fn(),
  mockStat: vi.fn(),
}));

// Mock fs/promises before importing anything that uses it
vi.mock('fs/promises', () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
  stat: mockStat,
}));

// Mock ZooStorageDetector before importing the extractor
vi.mock('../../../utils/zoo-storage-detector.js', () => ({
  ZooStorageDetector: {
    detectStorageLocations: vi.fn(),
    getStatsForPath: vi.fn(),
    getStorageStats: vi.fn(),
    isZooCodePath: vi.fn(),
    validateCustomPath: vi.fn(),
  },
}));

// Mock RooStorageDetector (format-identical parsing delegation)
vi.mock('../../../utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    analyzeConversation: vi.fn(),
  },
}));

// Don't mock unified-task.js — keep real implementation for toUnifiedTask and computeStorageTier

import { ZooTaskExtractor } from '../zoo-task-extractor.js';
import { ZooStorageDetector } from '../../../utils/zoo-storage-detector.js';
import { RooStorageDetector } from '../../../utils/roo-storage-detector.js';

const mockZoo = vi.mocked(ZooStorageDetector);
const mockRoo = vi.mocked(RooStorageDetector);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ZOO_LOCATION = 'C:/Users/test/AppData/Roaming/Code/User/globalStorage/zoocodeorganization.zoo-code';

const makeTaskMetadata = (overrides: Record<string, any> = {}) => ({
  messageCount: 42,
  dataSource: `${ZOO_LOCATION}/tasks/019d20bb-b7b7-721a-9306-7412f23e85aa`,
  lastActivity: '2026-03-24T16:48:00.039Z',
  workspace: 'd:/Dev/roo-extensions',
  actionCount: 5,
  totalSize: 98252,
  createdAt: '2026-03-24T16:44:26.446Z',
  ...overrides,
});

const makeHistoryItem = (overrides: Record<string, any> = {}) => ({
  number: 1,
  task: 'Lis le fichier et corrige le bug',
  id: '019d20bb-b7b7-721a-9306-7412f23e85aa',
  ts: 1775689528719,
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ZooTaskExtractor', () => {
  let extractor: ZooTaskExtractor;

  beforeEach(() => {
    vi.clearAllMocks();
    extractor = new ZooTaskExtractor();
  });

  test('has sourceName "zoo-code"', () => {
    expect(extractor.sourceName).toBe('zoo-code');
  });

  describe('isAvailable', () => {
    test('returns true when Zoo locations exist', async () => {
      mockZoo.detectStorageLocations.mockResolvedValue([ZOO_LOCATION]);
      await expect(extractor.isAvailable()).resolves.toBe(true);
    });

    test('returns false when no locations', async () => {
      mockZoo.detectStorageLocations.mockResolvedValue([]);
      await expect(extractor.isAvailable()).resolves.toBe(false);
    });

    test('returns false on error', async () => {
      mockZoo.detectStorageLocations.mockRejectedValue(new Error('fail'));
      await expect(extractor.isAvailable()).resolves.toBe(false);
    });
  });

  describe('extractAll', () => {
    test('extracts tasks from Zoo storage locations', async () => {
      const taskId = '019d20bb-b7b7-721a-9306-7412f23e85aa';
      mockZoo.detectStorageLocations.mockResolvedValue([ZOO_LOCATION]);

      // Mock fs.readdir to return task directories
      mockReaddir
        .mockResolvedValueOnce([
          { name: taskId, isDirectory: () => true } as any,
        ] as any)
        .mockResolvedValueOnce([] as any); // files inside task dir (unused)

      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(makeTaskMetadata())) // task_metadata.json
        .mockResolvedValueOnce(JSON.stringify(makeHistoryItem())); // history_item.json

      mockRoo.analyzeConversation.mockResolvedValue(null); // No enrichment

      const result = await extractor.extractAll();

      expect(result.source).toBe('zoo-code');
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe(taskId);
      expect(result.tasks[0].source).toBe('zoo-code');
      expect(result.tasks[0].messageCount).toBe(42);
      expect(result.errors).toHaveLength(0);
    });

    test('normalizes empty workspace to undefined', async () => {
      const taskId = '019d20bb-b7b7-721a-9306-7412f23e85aa';
      mockZoo.detectStorageLocations.mockResolvedValue([ZOO_LOCATION]);

      mockReaddir
        .mockResolvedValueOnce([
          { name: taskId, isDirectory: () => true } as any,
        ] as any)
        .mockResolvedValueOnce([] as any);

      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(makeTaskMetadata({ workspace: '' })))
        .mockResolvedValueOnce(JSON.stringify(makeHistoryItem()));

      mockRoo.analyzeConversation.mockResolvedValue(null);

      const result = await extractor.extractAll();
      expect(result.tasks[0].workspace).toBeUndefined();
    });

    test('skips tasks with missing metadata', async () => {
      const taskId = '019d20bb-b7b7-721a-9306-7412f23e85aa';
      mockZoo.detectStorageLocations.mockResolvedValue([ZOO_LOCATION]);

      mockReaddir
        .mockResolvedValueOnce([
          { name: taskId, isDirectory: () => true } as any,
        ] as any)
        .mockResolvedValueOnce([] as any);

      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const result = await extractor.extractAll();
      expect(result.tasks).toHaveLength(0);
      expect(result.errors).toHaveLength(0); // Skipped silently
    });

    test('handles top-level failure gracefully', async () => {
      mockZoo.detectStorageLocations.mockRejectedValue(new Error('disk error'));

      const result = await extractor.extractAll();
      expect(result.tasks).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Zoo extraction failed');
    });

    test('applies machineId option', async () => {
      const taskId = '019d20bb-b7b7-721a-9306-7412f23e85aa';
      mockZoo.detectStorageLocations.mockResolvedValue([ZOO_LOCATION]);

      mockReaddir
        .mockResolvedValueOnce([
          { name: taskId, isDirectory: () => true } as any,
        ] as any)
        .mockResolvedValueOnce([] as any);

      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(makeTaskMetadata()))
        .mockResolvedValueOnce(JSON.stringify(makeHistoryItem()));

      mockRoo.analyzeConversation.mockResolvedValue(null);

      const result = await extractor.extractAll({ machineId: 'test-machine' });
      expect(result.tasks[0].machineId).toBe('test-machine');
    });

    test('applies includeComputedFields option', async () => {
      const taskId = '019d20bb-b7b7-721a-9306-7412f23e85aa';
      mockZoo.detectStorageLocations.mockResolvedValue([ZOO_LOCATION]);

      mockReaddir
        .mockResolvedValueOnce([
          { name: taskId, isDirectory: () => true } as any,
        ] as any)
        .mockResolvedValueOnce([] as any);

      // Use a recent date so the real computeStorageTier returns 'hot'
      const recentDate = new Date().toISOString();
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(makeTaskMetadata({ lastActivity: recentDate, createdAt: recentDate })))
        .mockResolvedValueOnce(JSON.stringify(makeHistoryItem()));

      mockRoo.analyzeConversation.mockResolvedValue(null);

      const result = await extractor.extractAll({ includeComputedFields: true });
      // With a recent date, real computeStorageTier returns 'hot' (≤7 days)
      expect(result.tasks[0].storageTier).toBe('hot');
    });

    test('enriches with RooStorageDetector skeleton when available', async () => {
      const taskId = '019d20bb-b7b7-721a-9306-7412f23e85aa';
      mockZoo.detectStorageLocations.mockResolvedValue([ZOO_LOCATION]);

      mockReaddir
        .mockResolvedValueOnce([
          { name: taskId, isDirectory: () => true } as any,
        ] as any)
        .mockResolvedValueOnce([] as any);

      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(makeTaskMetadata()))
        .mockResolvedValueOnce(JSON.stringify(makeHistoryItem()));

      mockRoo.analyzeConversation.mockResolvedValue({
        taskId,
        metadata: {
          title: 'Enriched title from skeleton',
          lastActivity: '2026-03-24T16:48:00.039Z',
        },
        truncatedInstruction: 'Full instruction from API history',
        parentTaskId: 'parent-task-uuid',
        isCompleted: true,
      } as any);

      const result = await extractor.extractAll();
      expect(result.tasks[0].title).toBe('Enriched title from skeleton');
      expect(result.tasks[0].instruction).toBe('Full instruction from API history');
      expect(result.tasks[0].parentId).toBe('parent-task-uuid');
      expect(result.tasks[0].status).toBe('completed');
    });
  });

  describe('extractById', () => {
    test('returns task when found', async () => {
      const taskId = '019d20bb-b7b7-721a-9306-7412f23e85aa';
      mockZoo.detectStorageLocations.mockResolvedValue([ZOO_LOCATION]);

      mockStat.mockResolvedValue({ isDirectory: () => true } as any);
      mockReaddir.mockResolvedValue([] as any);
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(makeTaskMetadata()))
        .mockResolvedValueOnce(JSON.stringify(makeHistoryItem()));

      mockRoo.analyzeConversation.mockResolvedValue(null);

      const task = await extractor.extractById(taskId);
      expect(task).not.toBeNull();
      expect(task!.id).toBe(taskId);
      expect(task!.source).toBe('zoo-code');
    });

    test('returns null when not found in any location', async () => {
      const taskId = 'nonexistent-task-id';
      mockZoo.detectStorageLocations.mockResolvedValue([ZOO_LOCATION]);
      mockStat.mockRejectedValue(new Error('ENOENT'));

      const task = await extractor.extractById(taskId);
      expect(task).toBeNull();
    });

    test('returns null on error', async () => {
      mockZoo.detectStorageLocations.mockRejectedValue(new Error('fail'));

      const task = await extractor.extractById('any-id');
      expect(task).toBeNull();
    });
  });
});
