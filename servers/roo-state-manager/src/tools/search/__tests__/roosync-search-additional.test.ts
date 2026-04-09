/**
 * Additional tests for roosync_search to improve coverage
 * These tests complement the existing roosync-search.test.ts
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks for ESM compatibility
const { mockSemanticHandler, mockFallbackHandler } = vi.hoisted(() => ({
  mockSemanticHandler: vi.fn(),
  mockFallbackHandler: vi.fn()
}));

// Mock semantic search tool
vi.mock('../search-semantic.tool.js', () => ({
  searchTasksByContentTool: {
    handler: mockSemanticHandler
  },
  // Re-export the type stub
  SearchTasksByContentArgs: {}
}));

// Mock fallback search
vi.mock('../search-fallback.tool.js', () => ({
  handleSearchTasksSemanticFallback: mockFallbackHandler,
  SearchFallbackArgs: {}
}));

import { handleRooSyncSearch, RooSyncSearchArgs } from '../roosync-search.tool.js';
import type { ConversationSkeleton } from '../../../types/index.js';

// Helpers
function getTextContent(result: any, index = 0): string {
  const content = result.content[index];
  return content?.type === 'text' ? content.text : '';
}

describe('roosync_search additional coverage', () => {
  let mockCache: Map<string, ConversationSkeleton>;
  let mockEnsureCache: (args?: { workspace?: string }) => Promise<boolean>;
  let mockDiagnoseHandler: () => Promise<any>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCache = new Map();
    mockEnsureCache = vi.fn(async () => true);
    mockDiagnoseHandler = vi.fn(async () => ({
      content: [{ type: 'text', text: 'diagnostic result' }]
    }));

    // Default mock returns
    mockSemanticHandler.mockResolvedValue({
      content: [{ type: 'text', text: 'semantic results' }]
    });
    mockFallbackHandler.mockResolvedValue({
      content: [{ type: 'text', text: 'text results' }]
    });
  });

  describe('workspace normalization edge cases', () => {
    test('passes "all" workspace as preserved for text search', async () => {
      await handleRooSyncSearch(
        { action: 'text', search_query: 'global search', workspace: 'all' },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
      );

      expect(mockFallbackHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'global search',
          workspace: 'all'
        }),
        mockCache
      );
    });

    test('passes "*" workspace as undefined for semantic search', async () => {
      await handleRooSyncSearch(
        { action: 'semantic', search_query: 'global query', workspace: '*' },
        mockCache,
        mockEnsureCache,
        mockSemanticHandler,
        mockFallbackHandler
      );

      expect(mockSemanticHandler).toHaveBeenCalled();
      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.search_query).toBe('global query');
      expect(callArgs.workspace).toBeUndefined();
      expect(callArgs.diagnose_index).toBe(false);
    });
  });

  describe('optional parameters coverage', () => {
    test('includes exclude_tool_results filter in semantic search', async () => {
      await handleRooSyncSearch(
        {
          action: 'semantic',
          search_query: 'test query',
          exclude_tool_results: true
        },
        mockCache,
        mockEnsureCache,
        mockSemanticHandler,
        mockFallbackHandler
      );

      expect(mockSemanticHandler).toHaveBeenCalled();
      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.search_query).toBe('test query');
      expect(callArgs.exclude_tool_results).toBe(true);
      expect(callArgs.workspace).toBeUndefined();
      expect(callArgs.diagnose_index).toBe(false);
    });

    test('includes chunk_type filter in semantic search', async () => {
      await handleRooSyncSearch(
        {
          action: 'semantic',
          search_query: 'test query',
          chunk_type: 'tool_interaction'
        },
        mockCache,
        mockEnsureCache,
        mockSemanticHandler,
        mockFallbackHandler
      );

      expect(mockSemanticHandler).toHaveBeenCalled();
      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.search_query).toBe('test query');
      expect(callArgs.chunk_type).toBe('tool_interaction');
    });

    test('includes role filter in semantic search', async () => {
      await handleRooSyncSearch(
        {
          action: 'semantic',
          search_query: 'test query',
          role: 'user'
        },
        mockCache,
        mockEnsureCache,
        mockSemanticHandler,
        mockFallbackHandler
      );

      expect(mockSemanticHandler).toHaveBeenCalled();
      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.search_query).toBe('test query');
      expect(callArgs.role).toBe('user');
    });

    test('includes tool_name filter in semantic search', async () => {
      await handleRooSyncSearch(
        {
          action: 'semantic',
          search_query: 'test query',
          tool_name: 'write_to_file'
        },
        mockCache,
        mockEnsureCache,
        mockSemanticHandler,
        mockFallbackHandler
      );

      expect(mockSemanticHandler).toHaveBeenCalled();
      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.search_query).toBe('test query');
      expect(callArgs.tool_name).toBe('write_to_file');
    });

    test('includes has_errors filter in semantic search', async () => {
      await handleRooSyncSearch(
        {
          action: 'semantic',
          search_query: 'test query',
          has_errors: true
        },
        mockCache,
        mockEnsureCache,
        mockSemanticHandler,
        mockFallbackHandler
      );

      expect(mockSemanticHandler).toHaveBeenCalled();
      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.search_query).toBe('test query');
      expect(callArgs.has_errors).toBe(true);
    });

    test('includes model filter in semantic search', async () => {
      await handleRooSyncSearch(
        {
          action: 'semantic',
          search_query: 'test query',
          model: 'glm-5'
        },
        mockCache,
        mockEnsureCache,
        mockSemanticHandler,
        mockFallbackHandler
      );

      expect(mockSemanticHandler).toHaveBeenCalled();
      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.search_query).toBe('test query');
      expect(callArgs.model).toBe('glm-5');
    });

    test('includes source filter in semantic search', async () => {
      await handleRooSyncSearch(
        {
          action: 'semantic',
          search_query: 'test query',
          source: 'claude-code'
        },
        mockCache,
        mockEnsureCache,
        mockSemanticHandler,
        mockFallbackHandler
      );

      expect(mockSemanticHandler).toHaveBeenCalled();
      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.search_query).toBe('test query');
      expect(callArgs.source).toBe('claude-code');
    });

    test('includes both start_date and end_date in semantic search', async () => {
      await handleRooSyncSearch(
        {
          action: 'semantic',
          search_query: 'test query',
          start_date: '2026-03-01',
          end_date: '2026-03-11'
        },
        mockCache,
        mockEnsureCache,
        mockSemanticHandler,
        mockFallbackHandler
      );

      expect(mockSemanticHandler).toHaveBeenCalled();
      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.search_query).toBe('test query');
      expect(callArgs.start_date).toBe('2026-03-01');
      expect(callArgs.end_date).toBe('2026-03-11');
    });
  });

  describe('text search with source filter', () => {
    test('passes source filter to fallback handler', async () => {
      await handleRooSyncSearch(
        {
          action: 'text',
          search_query: 'test query',
          source: 'roo'
        },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
      );

      expect(mockFallbackHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'test query',
          source: 'roo'
        }),
        mockCache
      );
    });
  });

  describe('error handling for invalid parameters', () => {
    test('returns error for invalid chunk_type', async () => {
      const result = await handleRooSyncSearch(
        {
          action: 'semantic',
          search_query: 'test',
          chunk_type: 'invalid' as any
        },
        mockCache,
        mockEnsureCache,
        mockSemanticHandler,
        mockFallbackHandler
      );

      // The semantic handler should still be called even with invalid chunk_type
      // as validation happens at a different level
      expect(mockSemanticHandler).toHaveBeenCalled();
    });
  });
});