/**
 * Tests for get-raw.tool.ts
 * Coverage target: 28% → 70%+
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRawConversationTool } from '../get-raw.tool.js';
import { GenericError, GenericErrorCode } from '../../../types/errors.js';

// Mock fs/promises
const mockAccess = vi.fn();
const mockReadFile = vi.fn();
const mockStat = vi.fn();

vi.mock('fs', () => ({
  promises: {
    access: (...args: any[]) => mockAccess(...args),
    readFile: (...args: any[]) => mockReadFile(...args),
    stat: (...args: any[]) => mockStat(...args)
  }
}));

// Mock RooStorageDetector
vi.mock('../../../utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    detectStorageLocations: vi.fn()
  }
}));

// Mock console.debug
vi.spyOn(console, 'debug').mockImplementation(() => {});

describe('get-raw.tool', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    // Setup default mock for storage detector
    const { RooStorageDetector } = await import('../../../utils/roo-storage-detector.js');
    vi.mocked(RooStorageDetector.detectStorageLocations).mockResolvedValue(['/test/storage']);
  });

  describe('definition', () => {
    it('should have correct name', () => {
      expect(getRawConversationTool.definition.name).toBe('get_raw_conversation');
    });

    it('should have description', () => {
      expect(getRawConversationTool.definition.description).toContain('brut');
    });

    it('should require taskId', () => {
      expect(getRawConversationTool.definition.inputSchema.required).toContain('taskId');
    });
  });

  describe('handler - success cases', () => {
    it('should return raw conversation data', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes('api_conversation_history.json')) {
          return Promise.resolve(JSON.stringify([{ role: 'user', content: 'test' }]));
        }
        if (path.includes('ui_messages.json')) {
          return Promise.resolve(JSON.stringify([{ type: 'text', text: 'response' }]));
        }
        if (path.includes('task_metadata.json')) {
          return Promise.resolve(JSON.stringify({ taskId: 'test-task', mode: 'test' }));
        }
        return Promise.resolve('{}');
      });
      mockStat.mockResolvedValue({
        birthtime: '2024-01-01T00:00:00Z',
        mtime: '2024-01-02T00:00:00Z',
        size: 1024
      });

      const result = await getRawConversationTool.handler({ taskId: 'test-task-123' });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const data = JSON.parse(result.content[0].text as string);
      expect(data.taskId).toBe('test-task-123');
      expect(data.api_conversation_history).toBeDefined();
      expect(data.ui_messages).toBeDefined();
    });

    it('should handle BOM UTF-8 in files', async () => {
      mockAccess.mockResolvedValue(undefined);

      // Return content with BOM
      const bomContent = '\uFEFF' + JSON.stringify([{ role: 'user', content: 'test' }]);
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes('.json')) {
          return Promise.resolve(bomContent);
        }
        return Promise.resolve('{}');
      });
      mockStat.mockResolvedValue({
        birthtime: '2024-01-01T00:00:00Z',
        mtime: '2024-01-02T00:00:00Z',
        size: 1024
      });

      const result = await getRawConversationTool.handler({ taskId: 'test-task' });

      const data = JSON.parse(result.content[0].text as string);
      // Should parse successfully despite BOM
      expect(data.api_conversation_history).toEqual([{ role: 'user', content: 'test' }]);
    });

    it('should handle missing metadata file gracefully', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes('api_conversation_history.json')) {
          return Promise.resolve(JSON.stringify([{ role: 'user', content: 'test' }]));
        }
        if (path.includes('ui_messages.json')) {
          return Promise.resolve(JSON.stringify([]));
        }
        if (path.includes('task_metadata.json')) {
          return Promise.reject(new Error('File not found'));
        }
        return Promise.resolve('{}');
      });
      mockStat.mockResolvedValue({
        birthtime: '2024-01-01T00:00:00Z',
        mtime: '2024-01-02T00:00:00Z',
        size: 1024
      });

      const result = await getRawConversationTool.handler({ taskId: 'test-task' });

      const data = JSON.parse(result.content[0].text as string);
      expect(data.metadata).toBeNull();
    });

    it('should handle stat errors gracefully', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify({ test: 'data' }));
      mockStat.mockRejectedValue(new Error('Stat error'));

      const result = await getRawConversationTool.handler({ taskId: 'test-task' });

      const data = JSON.parse(result.content[0].text as string);
      expect(data.taskStats).toBeNull();
    });
  });

  describe('handler - error cases', () => {
    it('should throw error when taskId is empty', async () => {
      await expect(
        getRawConversationTool.handler({ taskId: '' })
      ).rejects.toThrow(GenericError);
    });

    it('should throw error when taskId is not provided', async () => {
      await expect(
        getRawConversationTool.handler({ taskId: undefined as any })
      ).rejects.toThrow('taskId is required');
    });

    it('should throw error when task not found in any location', async () => {
      mockAccess.mockRejectedValue(new Error('Not found'));

      await expect(
        getRawConversationTool.handler({ taskId: 'non-existent-task' })
      ).rejects.toThrow('not found in any storage location');
    });
  });

  describe('handler - multiple storage locations', () => {
    it('should search all locations until task is found', async () => {
      const { RooStorageDetector } = await import('../../../utils/roo-storage-detector.js');
      vi.mocked(RooStorageDetector.detectStorageLocations).mockResolvedValue([
        '/storage/primary',
        '/storage/secondary'
      ]);

      // First location fails
      mockAccess.mockRejectedValueOnce(new Error('Not found in primary'));
      // Second location succeeds
      mockAccess.mockResolvedValueOnce(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify({ found: true }));
      mockStat.mockResolvedValue({
        birthtime: '2024-01-01T00:00:00Z',
        mtime: '2024-01-02T00:00:00Z',
        size: 1024
      });

      const result = await getRawConversationTool.handler({ taskId: 'test-task' });

      expect(mockAccess).toHaveBeenCalledTimes(2);
      const data = JSON.parse(result.content[0].text as string);
      expect(data.location).toContain('secondary');
    });
  });

  describe('handler - return structure', () => {
    it('should include all expected fields in response', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify({ test: 'data' }));
      mockStat.mockResolvedValue({
        birthtime: '2024-01-01T00:00:00Z',
        mtime: '2024-01-02T00:00:00Z',
        size: 1024
      });

      const result = await getRawConversationTool.handler({ taskId: 'test-task' });
      const data = JSON.parse(result.content[0].text as string);

      expect(data).toHaveProperty('taskId');
      expect(data).toHaveProperty('location');
      expect(data).toHaveProperty('taskStats');
      expect(data).toHaveProperty('metadata');
      expect(data).toHaveProperty('api_conversation_history');
      expect(data).toHaveProperty('ui_messages');
    });
  });
});
