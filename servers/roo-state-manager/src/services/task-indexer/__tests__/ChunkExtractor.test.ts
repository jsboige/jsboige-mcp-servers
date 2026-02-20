/**
 * Tests for ChunkExtractor.ts
 * Focus on splitChunk function (pure, easily testable)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { splitChunk, getHostIdentifier, Chunk } from '../ChunkExtractor.js';

// Reset uuid mock and use real implementation
vi.mock('uuid', () => vi.importActual('uuid'));

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ChunkExtractor', () => {
  describe('getHostIdentifier', () => {
    it('should return a string with hostname, platform and arch', () => {
      const identifier = getHostIdentifier();

      expect(typeof identifier).toBe('string');
      expect(identifier.length).toBeGreaterThan(0);
      // Should contain hyphens as separators
      expect(identifier).toMatch(/.+-.+-.+/);
    });

    it('should return consistent values on repeated calls', () => {
      const id1 = getHostIdentifier();
      const id2 = getHostIdentifier();

      expect(id1).toBe(id2);
    });
  });

  describe('splitChunk', () => {
    const createChunk = (content: string, overrides: Partial<Chunk> = {}): Chunk => ({
      chunk_id: 'test-chunk-id',
      task_id: 'test-task-id',
      parent_task_id: null,
      root_task_id: null,
      chunk_type: 'message_exchange',
      sequence_order: 0,
      timestamp: '2024-01-01T00:00:00Z',
      indexed: true,
      content,
      ...overrides
    });

    it('should return single chunk if content is smaller than maxSize', () => {
      const chunk = createChunk('Short content');
      const result = splitChunk(chunk, 1000);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('Short content');
      expect(result[0].chunk_index).toBe(1);
      expect(result[0].total_chunks).toBe(1);
    });

    it('should return single chunk if content equals maxSize', () => {
      const content = 'x'.repeat(100);
      const chunk = createChunk(content);
      const result = splitChunk(chunk, 100);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(content);
    });

    it('should split content into multiple chunks', () => {
      const content = 'x'.repeat(250);
      const chunk = createChunk(content);
      const result = splitChunk(chunk, 100);

      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('x'.repeat(100));
      expect(result[1].content).toBe('x'.repeat(100));
      expect(result[2].content).toBe('x'.repeat(50));
    });

    it('should set correct chunk_index for each chunk', () => {
      const content = 'x'.repeat(250);
      const chunk = createChunk(content);
      const result = splitChunk(chunk, 100);

      expect(result[0].chunk_index).toBe(1);
      expect(result[1].chunk_index).toBe(2);
      expect(result[2].chunk_index).toBe(3);
    });

    it('should set correct total_chunks for each chunk', () => {
      const content = 'x'.repeat(250);
      const chunk = createChunk(content);
      const result = splitChunk(chunk, 100);

      result.forEach(c => {
        expect(c.total_chunks).toBe(3);
      });
    });

    it('should preserve original_chunk_id', () => {
      const content = 'x'.repeat(200);
      const chunk = createChunk(content, { chunk_id: 'original-id-123' });
      const result = splitChunk(chunk, 100);

      result.forEach(c => {
        expect(c.original_chunk_id).toBe('original-id-123');
      });
    });

    it('should generate valid UUIDs for split chunks', () => {
      const content = 'x'.repeat(200);
      const chunk = createChunk(content);
      const result = splitChunk(chunk, 100);

      // UUID v5 format: xxxxxxxx-xxxx-5xxx-xxxx-xxxxxxxxxxxx
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      result.forEach(c => {
        expect(c.chunk_id).toMatch(uuidPattern);
      });
    });

    it('should preserve other chunk properties', () => {
      const chunk = createChunk('x'.repeat(200), {
        task_id: 'task-abc',
        parent_task_id: 'parent-123',
        workspace: '/test/workspace',
        task_title: 'Test Task',
        chunk_type: 'tool_interaction'
      });
      const result = splitChunk(chunk, 100);

      result.forEach(c => {
        expect(c.task_id).toBe('task-abc');
        expect(c.parent_task_id).toBe('parent-123');
        expect(c.workspace).toBe('/test/workspace');
        expect(c.task_title).toBe('Test Task');
        expect(c.chunk_type).toBe('tool_interaction');
      });
    });

    it('should update content_summary for split chunks', () => {
      const content = 'x'.repeat(250);
      const chunk = createChunk(content);
      const result = splitChunk(chunk, 100);

      expect(result[0].content_summary).toContain('Chunk 1/3');
      expect(result[1].content_summary).toContain('Chunk 2/3');
      expect(result[2].content_summary).toContain('Chunk 3/3');
    });

    it('should handle empty content', () => {
      const chunk = createChunk('');
      const result = splitChunk(chunk, 100);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('');
      expect(result[0].chunk_index).toBe(1);
      expect(result[0].total_chunks).toBe(1);
    });

    it('should handle very small maxSize', () => {
      const content = 'abcde';
      const chunk = createChunk(content);
      const result = splitChunk(chunk, 2);

      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('ab');
      expect(result[1].content).toBe('cd');
      expect(result[2].content).toBe('e');
    });

    it('should handle single character splits', () => {
      const content = 'abc';
      const chunk = createChunk(content);
      const result = splitChunk(chunk, 1);

      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('a');
      expect(result[1].content).toBe('b');
      expect(result[2].content).toBe('c');
    });

    it('should handle content exactly divisible by maxSize', () => {
      const content = 'x'.repeat(300);
      const chunk = createChunk(content);
      const result = splitChunk(chunk, 100);

      expect(result).toHaveLength(3);
      expect(result.every(c => c.content?.length === 100)).toBe(true);
    });

    it('should generate different UUIDs for different chunks', () => {
      const content = 'x'.repeat(250);
      const chunk = createChunk(content);
      const result = splitChunk(chunk, 100);

      const ids = result.map(c => c.chunk_id);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(3);
    });

    it('should preserve sequence_order', () => {
      const chunk = createChunk('x'.repeat(200), { sequence_order: 5 });
      const result = splitChunk(chunk, 100);

      result.forEach(c => {
        expect(c.sequence_order).toBe(5);
      });
    });

    it('should preserve timestamp', () => {
      const chunk = createChunk('x'.repeat(200), { timestamp: '2024-12-25T10:30:00Z' });
      const result = splitChunk(chunk, 100);

      result.forEach(c => {
        expect(c.timestamp).toBe('2024-12-25T10:30:00Z');
      });
    });

    it('should handle content with newlines', () => {
      const content = 'Line1\nLine2\nLine3\nLine4';
      const chunk = createChunk(content);
      const result = splitChunk(chunk, 10);

      expect(result.length).toBeGreaterThan(1);
      const reassembled = result.map(c => c.content).join('');
      expect(reassembled).toBe(content);
    });

    it('should handle content with unicode characters', () => {
      const content = 'Héllo Wörld 日本語 🎉';
      const chunk = createChunk(content);
      const result = splitChunk(chunk, 5);

      expect(result.length).toBeGreaterThan(1);
      const reassembled = result.map(c => c.content).join('');
      expect(reassembled).toBe(content);
    });
  });
});
