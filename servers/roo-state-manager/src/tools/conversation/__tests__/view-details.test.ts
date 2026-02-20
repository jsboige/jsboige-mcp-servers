/**
 * Tests for view-details.tool.ts
 * Coverage target: 21.66% → 70%+
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { viewTaskDetailsTool } from '../view-details.tool.js';
import { ConversationSkeleton } from '../../../types/conversation.js';

// Mock console.error
vi.spyOn(console, 'error').mockImplementation(() => {});

describe('view-details.tool', () => {
  let conversationCache: Map<string, ConversationSkeleton>;

  beforeEach(() => {
    vi.clearAllMocks();
    conversationCache = new Map();

    // Add sample conversation with actions
    conversationCache.set('task-with-actions', {
      taskId: 'task-with-actions',
      parentTaskId: undefined,
      metadata: {
        createdAt: '2024-01-01T10:00:00Z',
        lastActivity: '2024-01-01T12:00:00Z',
        messageCount: 10,
        actionCount: 3,
        totalSize: 2048,
        workspace: '/test/workspace',
        title: 'Test Task with Actions'
      },
      sequence: [
        { role: 'user', content: 'Hello' },
        {
          type: 'tool_use',
          name: 'read_file',
          status: 'success',
          timestamp: '2024-01-01T10:01:00Z',
          parameters: { path: '/test/file.txt' },
          result: { content: 'file contents' }
        },
        { role: 'assistant', content: 'Response' },
        {
          type: 'command',
          name: 'execute_command',
          status: 'success',
          timestamp: '2024-01-01T10:02:00Z',
          parameters: { command: 'ls -la' },
          result: 'file1.txt\nfile2.txt',
          metadata: { exitCode: 0 }
        },
        {
          type: 'tool_use',
          name: 'write_file',
          status: 'error',
          timestamp: '2024-01-01T10:03:00Z',
          parameters: { path: '/test/output.txt' },
          error: 'Permission denied'
        }
      ]
    } as unknown as ConversationSkeleton);

    // Task with no actions
    conversationCache.set('task-no-actions', {
      taskId: 'task-no-actions',
      metadata: {
        createdAt: '2024-01-01T00:00:00Z',
        lastActivity: '2024-01-01T01:00:00Z',
        messageCount: 5,
        actionCount: 0,
        totalSize: 1024
      },
      sequence: [
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Answer' }
      ]
    } as unknown as ConversationSkeleton);
  });

  describe('definition', () => {
    it('should have correct name', () => {
      expect(viewTaskDetailsTool.definition.name).toBe('view_task_details');
    });

    it('should have description', () => {
      expect(viewTaskDetailsTool.definition.description).toContain('détails');
    });

    it('should require task_id', () => {
      expect(viewTaskDetailsTool.definition.inputSchema.required).toContain('task_id');
    });

    it('should have optional action_index and truncate', () => {
      const props = viewTaskDetailsTool.definition.inputSchema.properties;
      expect(props.action_index).toBeDefined();
      expect(props.truncate).toBeDefined();
    });
  });

  describe('handler - success cases', () => {
    it('should return task details with actions', async () => {
      const result = await viewTaskDetailsTool.handler(
        { task_id: 'task-with-actions' },
        conversationCache
      );

      expect(result.content).toHaveLength(1);
      const text = result.content[0].text as string;
      expect(text).toContain('task-with-actions');
      expect(text).toContain('Test Task with Actions');
      expect(text).toContain('Actions techniques trouvées: 3');
    });

    it('should display all actions by default', async () => {
      const result = await viewTaskDetailsTool.handler(
        { task_id: 'task-with-actions' },
        conversationCache
      );

      const text = result.content[0].text as string;
      expect(text).toContain('read_file');
      expect(text).toContain('execute_command');
      expect(text).toContain('write_file');
    });

    it('should display specific action when action_index is provided', async () => {
      const result = await viewTaskDetailsTool.handler(
        { task_id: 'task-with-actions', action_index: 1 },
        conversationCache
      );

      const text = result.content[0].text as string;
      expect(text).toContain('execute_command');
      expect(text).not.toContain('read_file'); // Other actions not shown
    });

    it('should include action parameters in output', async () => {
      const result = await viewTaskDetailsTool.handler(
        { task_id: 'task-with-actions' },
        conversationCache
      );

      const text = result.content[0].text as string;
      expect(text).toContain('Paramètres:');
      expect(text).toContain('/test/file.txt');
    });

    it('should include action result when available', async () => {
      const result = await viewTaskDetailsTool.handler(
        { task_id: 'task-with-actions' },
        conversationCache
      );

      const text = result.content[0].text as string;
      expect(text).toContain('Résultat:');
      expect(text).toContain('file contents');
    });

    it('should include error when action has error', async () => {
      const result = await viewTaskDetailsTool.handler(
        { task_id: 'task-with-actions' },
        conversationCache
      );

      const text = result.content[0].text as string;
      expect(text).toContain('❌ Erreur:');
      expect(text).toContain('Permission denied');
    });

    it('should include action metadata when available', async () => {
      const result = await viewTaskDetailsTool.handler(
        { task_id: 'task-with-actions' },
        conversationCache
      );

      const text = result.content[0].text as string;
      expect(text).toContain('Métadonnées:');
    });

    it('should include action timestamp when available', async () => {
      const result = await viewTaskDetailsTool.handler(
        { task_id: 'task-with-actions' },
        conversationCache
      );

      const text = result.content[0].text as string;
      expect(text).toContain('Timestamp:');
    });
  });

  describe('handler - truncate option', () => {
    it('should truncate content when truncate > 0', async () => {
      // Create task with long content
      const longContent = Array(100).fill('line').join('\n');
      conversationCache.set('task-long', {
        taskId: 'task-long',
        metadata: {
          createdAt: '2024-01-01T00:00:00Z',
          lastActivity: '2024-01-01T01:00:00Z',
          messageCount: 1,
          actionCount: 1,
          totalSize: 5000
        },
        sequence: [{
          type: 'tool_use',
          name: 'test',
          status: 'success',
          parameters: {},
          result: longContent
        }]
      } as unknown as ConversationSkeleton);

      const result = await viewTaskDetailsTool.handler(
        { task_id: 'task-long', truncate: 5 },
        conversationCache
      );

      const text = result.content[0].text as string;
      expect(text).toContain('lignes omises');
    });

    it('should not truncate when truncate is 0', async () => {
      const longContent = Array(10).fill('line').join('\n');
      conversationCache.set('task-notrunc', {
        taskId: 'task-notrunc',
        metadata: {
          createdAt: '2024-01-01T00:00:00Z',
          lastActivity: '2024-01-01T01:00:00Z',
          messageCount: 1,
          actionCount: 1,
          totalSize: 500
        },
        sequence: [{
          type: 'tool_use',
          name: 'test',
          status: 'success',
          parameters: {},
          result: longContent
        }]
      } as unknown as ConversationSkeleton);

      const result = await viewTaskDetailsTool.handler(
        { task_id: 'task-notrunc', truncate: 0 },
        conversationCache
      );

      const text = result.content[0].text as string;
      expect(text).not.toContain('omises');
    });
  });

  describe('handler - edge cases', () => {
    it('should return error when task not found', async () => {
      const result = await viewTaskDetailsTool.handler(
        { task_id: 'non-existent' },
        conversationCache
      );

      const text = result.content[0].text as string;
      expect(text).toContain('❌');
      expect(text).toContain('non-existent');
    });

    it('should handle task with no actions', async () => {
      const result = await viewTaskDetailsTool.handler(
        { task_id: 'task-no-actions' },
        conversationCache
      );

      const text = result.content[0].text as string;
      expect(text).toContain('Aucune action technique trouvée');
    });

    it('should handle invalid action_index', async () => {
      const result = await viewTaskDetailsTool.handler(
        { task_id: 'task-with-actions', action_index: 99 },
        conversationCache
      );

      const text = result.content[0].text as string;
      expect(text).toContain('Index 99 invalide');
    });

    it('should handle negative action_index', async () => {
      const result = await viewTaskDetailsTool.handler(
        { task_id: 'task-with-actions', action_index: -1 },
        conversationCache
      );

      const text = result.content[0].text as string;
      expect(text).toContain('Index -1 invalide');
    });

    it('should use taskId as title when no title in metadata', async () => {
      conversationCache.set('task-no-title', {
        taskId: 'task-no-title',
        metadata: {
          createdAt: '2024-01-01T00:00:00Z',
          lastActivity: '2024-01-01T01:00:00Z',
          messageCount: 1,
          actionCount: 0,
          totalSize: 100
        },
        sequence: []
      } as unknown as ConversationSkeleton);

      const result = await viewTaskDetailsTool.handler(
        { task_id: 'task-no-title' },
        conversationCache
      );

      const text = result.content[0].text as string;
      expect(text).toContain('task-no-title');
    });
  });

  describe('handler - action types', () => {
    it('should show command icon for command type', async () => {
      const result = await viewTaskDetailsTool.handler(
        { task_id: 'task-with-actions', action_index: 1 },
        conversationCache
      );

      const text = result.content[0].text as string;
      expect(text).toContain('⚙️'); // Command icon
    });

    it('should show tool icon for tool_use type', async () => {
      const result = await viewTaskDetailsTool.handler(
        { task_id: 'task-with-actions', action_index: 0 },
        conversationCache
      );

      const text = result.content[0].text as string;
      expect(text).toContain('🛠️'); // Tool icon
    });
  });
});
