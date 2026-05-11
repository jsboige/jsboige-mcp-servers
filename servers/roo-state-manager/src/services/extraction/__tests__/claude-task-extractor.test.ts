/**
 * Tests for ClaudeTaskExtractor — #1392
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/claude-storage-detector.js', () => ({
  ClaudeStorageDetector: {
    detectStorageLocations: vi.fn(),
    listProjects: vi.fn(),
    analyzeConversation: vi.fn(),
    findConversationById: vi.fn(),
  },
}));

vi.mock('../../../types/unified-task.js', async () => {
  const actual = await vi.importActual('../../../types/unified-task.js');
  return {
    ...actual,
    computeStorageTier: vi.fn().mockReturnValue('warm'),
  };
});

import { ClaudeTaskExtractor } from '../claude-task-extractor.js';
import { ClaudeStorageDetector } from '../../../utils/claude-storage-detector.js';

const mockClaude = vi.mocked(ClaudeStorageDetector);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ClaudeTaskExtractor', () => {
  let extractor: ClaudeTaskExtractor;

  beforeEach(() => {
    vi.clearAllMocks();
    extractor = new ClaudeTaskExtractor();
  });

  test('has sourceName "claude-code"', () => {
    expect(extractor.sourceName).toBe('claude-code');
  });

  describe('isAvailable', () => {
    test('returns true when locations exist', async () => {
      mockClaude.detectStorageLocations.mockResolvedValue([{ path: '~/.claude' }]);
      await expect(extractor.isAvailable()).resolves.toBe(true);
    });

    test('returns false when no locations', async () => {
      mockClaude.detectStorageLocations.mockResolvedValue([]);
      await expect(extractor.isAvailable()).resolves.toBe(false);
    });

    test('returns false on error', async () => {
      mockClaude.detectStorageLocations.mockRejectedValue(new Error('fail'));
      await expect(extractor.isAvailable()).resolves.toBe(false);
    });
  });

  describe('extractAll', () => {
    test('extracts tasks from projects', async () => {
      mockClaude.detectStorageLocations.mockResolvedValue([
        { path: '~/.claude', projectPath: '~/.claude/projects/proj1' },
      ]);
      mockClaude.listProjects.mockResolvedValue(['proj1', 'proj2']);
      mockClaude.analyzeConversation.mockResolvedValue({
        taskId: 'claude-proj1',
        metadata: {
          title: 'Claude session',
          lastActivity: '2026-05-10T14:00:00Z',
          createdAt: '2026-05-10T13:00:00Z',
          messageCount: 20,
          actionCount: 5,
          totalSize: 8192,
          workspace: '/dev/test',
        },
      });

      const result = await extractor.extractAll();
      expect(result.source).toBe('claude-code');
      expect(result.tasks).toHaveLength(2); // 2 projects
      expect(result.errors).toHaveLength(0);
    });

    test('handles per-project errors gracefully', async () => {
      mockClaude.detectStorageLocations.mockResolvedValue([
        { path: '~/.claude', projectPath: '~/.claude/projects/proj1' },
      ]);
      mockClaude.listProjects.mockResolvedValue(['proj1']);
      mockClaude.analyzeConversation.mockRejectedValue(new Error('corrupt'));

      const result = await extractor.extractAll();
      expect(result.tasks).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].taskId).toBe('claude-proj1');
    });

    test('handles top-level failure', async () => {
      mockClaude.detectStorageLocations.mockRejectedValue(new Error('no disk'));

      const result = await extractor.extractAll();
      expect(result.tasks).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Claude extraction failed');
    });

    test('skips null skeletons', async () => {
      mockClaude.detectStorageLocations.mockResolvedValue([
        { path: '~/.claude', projectPath: '~/.claude/projects/p1' },
      ]);
      mockClaude.listProjects.mockResolvedValue(['p1']);
      mockClaude.analyzeConversation.mockResolvedValue(null);

      const result = await extractor.extractAll();
      expect(result.tasks).toHaveLength(0);
    });

    test('applies machineId option', async () => {
      mockClaude.detectStorageLocations.mockResolvedValue([
        { path: '~/.claude', projectPath: '~/.claude/projects/p1' },
      ]);
      mockClaude.listProjects.mockResolvedValue(['p1']);
      mockClaude.analyzeConversation.mockResolvedValue({
        taskId: 'claude-p1',
        metadata: {
          lastActivity: '2026-05-10T14:00:00Z',
          messageCount: 5,
        },
      });

      const result = await extractor.extractAll({ machineId: 'test-box' });
      expect(result.tasks[0].machineId).toBe('test-box');
    });
  });

  describe('extractById', () => {
    test('returns task when found', async () => {
      mockClaude.findConversationById.mockResolvedValue({
        taskId: 'claude-proj1',
        metadata: {
          title: 'Found session',
          lastActivity: '2026-05-10T14:00:00Z',
          messageCount: 10,
        },
      });

      const task = await extractor.extractById('claude-proj1');
      expect(task).not.toBeNull();
      expect(task!.id).toBe('claude-proj1');
    });

    test('returns null when not found', async () => {
      mockClaude.findConversationById.mockResolvedValue(null);
      const task = await extractor.extractById('claude-nope');
      expect(task).toBeNull();
    });

    test('returns null on error', async () => {
      mockClaude.findConversationById.mockRejectedValue(new Error('boom'));
      const task = await extractor.extractById('claude-x');
      expect(task).toBeNull();
    });
  });
});
