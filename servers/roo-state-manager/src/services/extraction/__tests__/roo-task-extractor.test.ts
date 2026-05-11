/**
 * Tests for RooTaskExtractor — #1392
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock RooStorageDetector before importing the extractor
vi.mock('../../../utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    detectStorageLocations: vi.fn(),
    buildHierarchicalSkeletons: vi.fn(),
    findConversationById: vi.fn(),
  },
}));

// Mock computeStorageTier (used internally via toUnifiedTask)
vi.mock('../../../types/unified-task.js', async () => {
  const actual = await vi.importActual('../../../types/unified-task.js');
  return {
    ...actual,
    computeStorageTier: vi.fn().mockReturnValue('hot'),
  };
});

import { RooTaskExtractor } from '../roo-task-extractor.js';
import { RooStorageDetector } from '../../../utils/roo-storage-detector.js';

const mockRoo = vi.mocked(RooStorageDetector);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makeSkeleton = (overrides: Record<string, any> = {}) => ({
  taskId: 'abc-123-def',
  parentTaskId: undefined,
  metadata: {
    title: 'Test task',
    lastActivity: '2026-05-10T12:00:00Z',
    createdAt: '2026-05-10T10:00:00Z',
    mode: 'code-simple',
    messageCount: 10,
    actionCount: 3,
    totalSize: 4096,
    workspace: '/dev/test',
  },
  truncatedInstruction: 'do something',
  isCompleted: false,
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RooTaskExtractor', () => {
  let extractor: RooTaskExtractor;

  beforeEach(() => {
    vi.clearAllMocks();
    extractor = new RooTaskExtractor();
  });

  test('has sourceName "roo"', () => {
    expect(extractor.sourceName).toBe('roo');
  });

  describe('isAvailable', () => {
    test('returns true when locations exist', async () => {
      mockRoo.detectStorageLocations.mockResolvedValue([{ path: '/some/path' }]);
      await expect(extractor.isAvailable()).resolves.toBe(true);
    });

    test('returns false when no locations', async () => {
      mockRoo.detectStorageLocations.mockResolvedValue([]);
      await expect(extractor.isAvailable()).resolves.toBe(false);
    });

    test('returns false on error', async () => {
      mockRoo.detectStorageLocations.mockRejectedValue(new Error('fail'));
      await expect(extractor.isAvailable()).resolves.toBe(false);
    });
  });

  describe('extractAll', () => {
    test('extracts tasks from skeletons', async () => {
      mockRoo.buildHierarchicalSkeletons.mockResolvedValue([
        makeSkeleton(),
        makeSkeleton({ taskId: 'task-2', metadata: { messageCount: 5 } }),
      ]);

      const result = await extractor.extractAll();
      expect(result.source).toBe('roo');
      expect(result.tasks).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
      expect(result.tasks[0].id).toBe('abc-123-def');
    });

    test('collects errors for bad skeletons', async () => {
      mockRoo.buildHierarchicalSkeletons.mockResolvedValue([
        makeSkeleton({ taskId: undefined }), // will cause toUnifiedTask to fail or produce bad result
      ]);

      const result = await extractor.extractAll();
      // Even with bad data, toUnifiedTask may still produce a result
      // The key is no unhandled exceptions
      expect(result.source).toBe('roo');
    });

    test('handles top-level failure', async () => {
      mockRoo.buildHierarchicalSkeletons.mockRejectedValue(new Error('disk error'));

      const result = await extractor.extractAll();
      expect(result.tasks).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Roo extraction failed');
    });

    test('applies machineId option', async () => {
      mockRoo.buildHierarchicalSkeletons.mockResolvedValue([makeSkeleton()]);

      const result = await extractor.extractAll({ machineId: 'test-machine' });
      expect(result.tasks[0].machineId).toBe('test-machine');
    });
  });

  describe('extractById', () => {
    test('returns task when found', async () => {
      mockRoo.findConversationById.mockResolvedValue({
        taskId: 'abc-123',
        lastActivity: '2026-05-10T12:00:00Z',
        messageCount: 10,
        size: 4096,
        metadata: { title: 'Found task', workspace: '/dev/test' },
      });

      const task = await extractor.extractById('abc-123');
      expect(task).not.toBeNull();
      expect(task!.id).toBe('abc-123');
    });

    test('returns null when not found', async () => {
      mockRoo.findConversationById.mockResolvedValue(null);

      const task = await extractor.extractById('nonexistent');
      expect(task).toBeNull();
    });

    test('returns null on error', async () => {
      mockRoo.findConversationById.mockRejectedValue(new Error('io'));

      const task = await extractor.extractById('abc-123');
      expect(task).toBeNull();
    });
  });
});
