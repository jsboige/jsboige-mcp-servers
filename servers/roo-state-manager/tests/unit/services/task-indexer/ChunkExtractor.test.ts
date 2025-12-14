import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractChunksFromTask, splitChunk, Chunk } from '../../../../src/services/task-indexer/ChunkExtractor.js';
import { promises as fs } from 'fs';
import * as path from 'path';

// Mock fs
vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    access: vi.fn()
  }
}));

// Mock os
vi.mock('os', () => ({
  hostname: vi.fn().mockReturnValue('test-host'),
  platform: vi.fn().mockReturnValue('test-platform'),
  arch: vi.fn().mockReturnValue('test-arch')
}));

// Mock uuid
vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('uuid-v4'),
  v5: vi.fn().mockReturnValue('uuid-v5')
}));

describe('ChunkExtractor', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('extractChunksFromTask', () => {
    const taskId = 'task-123';
    const taskPath = '/path/to/task';

    it('should extract chunks from api_conversation_history.json', async () => {
      const metadata = JSON.stringify({
        parentTaskId: 'parent-123',
        workspace: 'test-workspace',
        title: 'Test Task'
      });
      const apiHistory = JSON.stringify([
        { role: 'user', content: 'Hello', timestamp: '2023-01-01T00:00:00Z' },
        { role: 'assistant', content: 'Hi there', timestamp: '2023-01-01T00:00:01Z' }
      ]);

      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if (filePath.toString().endsWith('task_metadata.json')) return metadata;
        if (filePath.toString().endsWith('api_conversation_history.json')) return apiHistory;
        if (filePath.toString().endsWith('ui_messages.json')) throw new Error('File not found');
        return '';
      });

      const chunks = await extractChunksFromTask(taskId, taskPath);

      expect(chunks).toHaveLength(2);
      expect(chunks[0].content).toBe('Hello');
      expect(chunks[0].role).toBe('user');
      expect(chunks[0].parent_task_id).toBe('parent-123');
      expect(chunks[1].content).toBe('Hi there');
      expect(chunks[1].role).toBe('assistant');
    });

    it('should handle tool calls', async () => {
      const metadata = JSON.stringify({});
      const apiHistory = JSON.stringify([
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ function: { name: 'test_tool', arguments: '{"arg":"val"}' } }],
          timestamp: '2023-01-01T00:00:00Z'
        }
      ]);

      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if (filePath.toString().endsWith('task_metadata.json')) return metadata;
        if (filePath.toString().endsWith('api_conversation_history.json')) return apiHistory;
        return '';
      });

      const chunks = await extractChunksFromTask(taskId, taskPath);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].chunk_type).toBe('tool_interaction');
      expect(chunks[0].tool_details?.tool_name).toBe('test_tool');
      expect(chunks[0].tool_details?.parameters).toEqual({ arg: 'val' });
    });

    it('should handle ui_messages.json', async () => {
      const metadata = JSON.stringify({});
      const apiHistory = JSON.stringify([]);
      const uiMessages = JSON.stringify([
        { author: 'user', text: 'UI Message', timestamp: '2023-01-01T00:00:00Z' }
      ]);

      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if (filePath.toString().endsWith('task_metadata.json')) return metadata;
        if (filePath.toString().endsWith('api_conversation_history.json')) return apiHistory;
        if (filePath.toString().endsWith('ui_messages.json')) return uiMessages;
        return '';
      });

      const chunks = await extractChunksFromTask(taskId, taskPath);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe('UI Message');
      expect(chunks[0].participants).toContain('user');
    });

    it('should handle missing metadata gracefully', async () => {
      const apiHistory = JSON.stringify([
        { role: 'user', content: 'Hello', timestamp: '2023-01-01T00:00:00Z' }
      ]);

      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if (filePath.toString().endsWith('task_metadata.json')) throw new Error('File not found');
        if (filePath.toString().endsWith('api_conversation_history.json')) return apiHistory;
        return '';
      });

      const chunks = await extractChunksFromTask(taskId, taskPath);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe('Hello');
      expect(chunks[0].parent_task_id).toBeNull();
    });
  });

  describe('splitChunk', () => {
    it('should not split chunk if content is smaller than maxSize', () => {
      const chunk: Chunk = {
        chunk_id: '1',
        task_id: 't1',
        parent_task_id: null,
        root_task_id: null,
        chunk_type: 'message_exchange',
        sequence_order: 1,
        timestamp: '2023-01-01',
        indexed: true,
        content: 'Short content'
      };

      const result = splitChunk(chunk, 100);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('Short content');
      expect(result[0].chunk_index).toBe(1);
      expect(result[0].total_chunks).toBe(1);
    });

    it('should split chunk if content is larger than maxSize', () => {
      const chunk: Chunk = {
        chunk_id: '1',
        task_id: 't1',
        parent_task_id: null,
        root_task_id: null,
        chunk_type: 'message_exchange',
        sequence_order: 1,
        timestamp: '2023-01-01',
        indexed: true,
        content: '1234567890'
      };

      const result = splitChunk(chunk, 4);

      expect(result).toHaveLength(3); // '1234', '5678', '90'
      expect(result[0].content).toBe('1234');
      expect(result[1].content).toBe('5678');
      expect(result[2].content).toBe('90');
      
      expect(result[0].chunk_index).toBe(1);
      expect(result[0].total_chunks).toBe(3);
      expect(result[0].original_chunk_id).toBe('1');
    });
  });
});