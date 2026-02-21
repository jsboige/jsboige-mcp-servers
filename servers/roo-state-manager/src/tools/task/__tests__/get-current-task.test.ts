/**
 * Tests for get-current-task.tool.ts
 * Coverage target: 17.59% → 70%+
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCurrentTaskTool } from '../get-current-task.tool.js';
import { ConversationSkeleton } from '../../../types/conversation.js';

// Mock disk-scanner
vi.mock('../disk-scanner.js', () => ({
  scanDiskForNewTasks: vi.fn()
}));

// Mock path-normalizer
vi.mock('../../../utils/path-normalizer.js', () => ({
  normalizePath: (path: string) => path.replace(/\\/g, '/')
}));

// Mock console
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

describe('get-current-task.tool', () => {
  let conversationCache: Map<string, ConversationSkeleton>;

  beforeEach(() => {
    vi.clearAllMocks();
    conversationCache = new Map();

    // Add sample conversations to cache
    conversationCache.set('task-1', {
      taskId: 'task-1',
      parentTaskId: undefined,
      metadata: {
        createdAt: '2024-01-01T10:00:00Z',
        lastActivity: '2024-01-01T12:00:00Z',
        messageCount: 10,
        actionCount: 5,
        totalSize: 1024,
        workspace: '/workspace/test'
      }
    } as ConversationSkeleton);

    conversationCache.set('task-2', {
      taskId: 'task-2',
      parentTaskId: 'task-1',
      metadata: {
        createdAt: '2024-01-02T10:00:00Z',
        lastActivity: '2024-01-02T14:00:00Z',
        messageCount: 20,
        actionCount: 10,
        totalSize: 2048,
        workspace: '/workspace/test',
        title: 'Test Task',
        mode: 'code-simple'
      }
    } as ConversationSkeleton);

    conversationCache.set('task-3', {
      taskId: 'task-3',
      parentTaskId: undefined,
      metadata: {
        createdAt: '2024-01-03T10:00:00Z',
        lastActivity: '2024-01-03T09:00:00Z',
        messageCount: 5,
        actionCount: 2,
        totalSize: 512,
        workspace: '/workspace/other'
      }
    } as ConversationSkeleton);
  });

  describe('definition', () => {
    it('should have correct name', () => {
      expect(getCurrentTaskTool.definition.name).toBe('get_current_task');
    });

    it('should have description', () => {
      expect(getCurrentTaskTool.definition.description).toContain('workspace');
    });

    it('should have workspace property in inputSchema', () => {
      expect(getCurrentTaskTool.definition.inputSchema.properties.workspace).toBeDefined();
    });
  });

  describe('handler - success cases', () => {
    it('should return the most recent task for a workspace', async () => {
      const result = await getCurrentTaskTool.handler(
        { workspace: '/workspace/test' },
        conversationCache,
        undefined,
        undefined
      );

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const data = JSON.parse((result.content[0] as any).text as string);
      expect(data.task_id).toBe('task-2'); // Most recent in /workspace/test
      expect(data.title).toBe('Test Task');
      expect(data.mode).toBe('code-simple');
    });

    it('should use context workspace if args workspace not provided', async () => {
      const result = await getCurrentTaskTool.handler(
        {},
        conversationCache,
        '/workspace/other',
        undefined
      );

      const data = JSON.parse((result.content[0] as any).text as string);
      expect(data.task_id).toBe('task-3'); // Only task in /workspace/other
    });

    it('should prefer args workspace over context workspace', async () => {
      const result = await getCurrentTaskTool.handler(
        { workspace: '/workspace/test' },
        conversationCache,
        '/workspace/other',
        undefined
      );

      const data = JSON.parse((result.content[0] as any).text as string);
      expect(data.task_id).toBe('task-2'); // From args workspace
    });

    it('should return task with all expected fields', async () => {
      const result = await getCurrentTaskTool.handler(
        { workspace: '/workspace/test' },
        conversationCache,
        undefined,
        undefined
      );

      const data = JSON.parse((result.content[0] as any).text as string);

      expect(data).toHaveProperty('task_id');
      expect(data).toHaveProperty('created_at');
      expect(data).toHaveProperty('updated_at');
      expect(data).toHaveProperty('message_count');
      expect(data).toHaveProperty('action_count');
      expect(data).toHaveProperty('total_size');
      expect(data).toHaveProperty('parent_task_id');
    });
  });

  describe('handler - error cases', () => {
    it('should throw error when no workspace provided', async () => {
      await expect(
        getCurrentTaskTool.handler({}, conversationCache, undefined, undefined)
      ).rejects.toThrow('Workspace non fourni');
    });

    it('should throw error when no tasks found in workspace', async () => {
      const emptyCache = new Map<string, ConversationSkeleton>();

      await expect(
        getCurrentTaskTool.handler({ workspace: '/empty/workspace' }, emptyCache, undefined, undefined)
      ).rejects.toThrow('Aucune tâche trouvée');
    });
  });

  describe('handler - with ensureSkeletonCacheIsFresh', () => {
    it('should call ensureSkeletonCacheIsFresh if provided', async () => {
      const ensureFresh = vi.fn();

      await getCurrentTaskTool.handler(
        { workspace: '/workspace/test' },
        conversationCache,
        undefined,
        ensureFresh
      );

      expect(ensureFresh).toHaveBeenCalled();
    });
  });

  describe('handler - with disk scan', () => {
    it('should scan disk for new tasks', async () => {
      const { scanDiskForNewTasks } = await import('../disk-scanner.js');
      const mockScan = vi.mocked(scanDiskForNewTasks);
      mockScan.mockResolvedValue([]);

      await getCurrentTaskTool.handler(
        { workspace: '/workspace/test' },
        conversationCache,
        undefined,
        undefined
      );

      expect(mockScan).toHaveBeenCalledWith(conversationCache, '/workspace/test');
    });

    it('should add new tasks from disk scan to cache', async () => {
      const { scanDiskForNewTasks } = await import('../disk-scanner.js');
      const mockScan = vi.mocked(scanDiskForNewTasks);

      const newTask: ConversationSkeleton = {
        taskId: 'new-task-from-disk',
        metadata: {
          createdAt: '2024-01-04T10:00:00Z',
          lastActivity: '2024-01-04T15:00:00Z',
          messageCount: 15,
          actionCount: 8,
          totalSize: 1500,
          workspace: '/workspace/test'
        }
      } as ConversationSkeleton;

      mockScan.mockResolvedValue([newTask]);

      const result = await getCurrentTaskTool.handler(
        { workspace: '/workspace/test' },
        conversationCache,
        undefined,
        undefined
      );

      const data = JSON.parse((result.content[0] as any).text as string);
      expect(data.task_id).toBe('new-task-from-disk'); // Newest task wins
    });

    it('should continue if disk scan fails', async () => {
      const { scanDiskForNewTasks } = await import('../disk-scanner.js');
      const mockScan = vi.mocked(scanDiskForNewTasks);
      mockScan.mockRejectedValue(new Error('Disk scan error'));

      // Should not throw, should fall back to cache
      const result = await getCurrentTaskTool.handler(
        { workspace: '/workspace/test' },
        conversationCache,
        undefined,
        undefined
      );

      expect(result.content).toHaveLength(1);
    });
  });

  describe('handler - edge cases', () => {
    it('should handle cache with only invalid tasks', async () => {
      const invalidCache = new Map<string, ConversationSkeleton>();
      invalidCache.set('invalid', {
        taskId: 'invalid',
        metadata: {} as any, // Missing lastActivity
        sequence: []
      });

      await expect(
        getCurrentTaskTool.handler({ workspace: '/workspace/test' }, invalidCache, undefined, undefined)
      ).rejects.toThrow('Aucune tâche trouvée');
    });

    it('should handle tasks without optional fields', async () => {
      const minimalCache = new Map<string, ConversationSkeleton>();
      minimalCache.set('minimal', {
        taskId: 'minimal',
        metadata: {
          createdAt: '2024-01-01T00:00:00Z',
          lastActivity: '2024-01-01T01:00:00Z',
          messageCount: 1,
          actionCount: 0,
          totalSize: 100,
          workspace: '/workspace/minimal'
        }
      } as ConversationSkeleton);

      const result = await getCurrentTaskTool.handler(
        { workspace: '/workspace/minimal' },
        minimalCache,
        undefined,
        undefined
      );

      const data = JSON.parse((result.content[0] as any).text as string);
      expect(data.task_id).toBe('minimal');
      expect(data.title).toBeUndefined();
      expect(data.parent_task_id).toBeUndefined();
    });
  });
});
