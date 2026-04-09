/**
 * Tests for roosync_search tool
 * These tests verify the search functionality for the roo-state-manager MCP
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks for ESM compatibility
const { mockSemanticHandler, mockFallbackHandler, mockDiagnoseHandler } = vi.hoisted(() => ({
  mockSemanticHandler: vi.fn(),
  mockFallbackHandler: vi.fn(),
  mockDiagnoseHandler: vi.fn()
}));

// Mock search tools
vi.mock('../search-semantic.tool.js', () => ({
  searchTasksByContentTool: {
    handler: mockSemanticHandler
  },
  // Re-export the type stub
  SearchTasksByContentArgs: {}
}));

vi.mock('../search-fallback.tool.js', () => ({
  handleSearchTasksSemanticFallback: mockFallbackHandler,
  SearchFallbackArgs: {}
}));

vi.mock('../search-diagnose.tool.js', () => ({
  handleDiagnoseIndexTool: mockDiagnoseHandler,
  SearchDiagnoseArgs: {}
}));

import { handleRooSyncSearch, RooSyncSearchArgs } from '../roosync-search.tool.js';
import type { ConversationSkeleton } from '../../types/index.js';

// Helpers
function getTextContent(result: any, index = 0): string {
  const content = result.content[index];
  return content?.type === 'text' ? content.text : '';
}

describe('roosync_search', () => {
  let mockCache: Map<string, ConversationSkeleton>;
  let mockEnsureCache: (args?: { workspace?: string }) => Promise<boolean>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCache = new Map();
    mockEnsureCache = vi.fn(async () => true);

    // Default mock returns
    mockSemanticHandler.mockResolvedValue({
      content: [{ type: 'text', text: 'semantic results' }]
    });
    mockFallbackHandler.mockResolvedValue({
      content: [{ type: 'text', text: 'text results' }]
    });
    mockDiagnoseHandler.mockResolvedValue({
      content: [{ type: 'text', text: 'diagnostic result' }]
    });
  });

  // ============================================================
  // Semantic Search
  // ============================================================

  describe('semantic search', () => {
    test('requires search_query', async () => {
      const result = await handleRooSyncSearch(
        { action: 'semantic' },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
      );
      expect(result.isError).toBe(true);
      expect(getTextContent(result)).toContain('search_query');
    });

    test('works with search_query and workspace', async () => {
      await handleRooSyncSearch(
        { action: 'semantic', search_query: 'test query', workspace: 'd:\\test-workspace' },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
      );

      expect(mockSemanticHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          search_query: 'test query',
          workspace: 'd:\\test-workspace'
        }),
        mockCache,
        mockEnsureCache,
        mockFallbackHandler,
        undefined
      );
    });

    test('works with search_query and optional parameters', async () => {
      await handleRooSyncSearch(
        {
          action: 'semantic',
          search_query: 'test query',
          workspace: 'd:\\test-workspace',
          conversation_id: 'conv-123',
          max_results: 50
        },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
      );

      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.search_query).toBe('test query');
      expect(callArgs.workspace).toBe('d:\\test-workspace');
      expect(callArgs.conversation_id).toBe('conv-123');
      expect(callArgs.max_results).toBe(50);
    });

    test('passes "all" workspace as undefined for text search (should preserve "all")', async () => {
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

    test('text search with source filter preserves "roo" source', async () => {
      await handleRooSyncSearch(
        {
          action: 'text',
          search_query: 'roo tasks only',
          source: 'roo'
        },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
      );

      expect(mockFallbackHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'roo tasks only',
          source: 'roo'
        }),
        mockCache
      );
    });

    test('text search with source filter preserves "claude-code" source', async () => {
      await handleRooSyncSearch(
        {
          action: 'text',
          search_query: 'claude tasks only',
          source: 'claude-code'
        },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
      );

      expect(mockFallbackHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'claude tasks only',
          source: 'claude-code'
        }),
        mockCache
      );
    });
  });

  // ============================================================
  // Text Search
  // ============================================================

  describe('text search', () => {
    test('requires search_query', async () => {
      const result = await handleRooSyncSearch(
        { action: 'text' },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
      );
      expect(result.isError).toBe(true);
      expect(getTextContent(result)).toContain('search_query');
    });

    test('works with search_query', async () => {
      await handleRooSyncSearch(
        { action: 'text', search_query: 'test query' },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
      );

      expect(mockFallbackHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'test query'
        }),
        mockCache
      );
    });

    test('works with search_query and workspace', async () => {
      await handleRooSyncSearch(
        { action: 'text', search_query: 'test query', workspace: 'd:\\test-workspace' },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
      );

      expect(mockFallbackHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'test query',
          workspace: 'd:\\test-workspace'
        }),
        mockCache
      );
    });

    test('passes "all" workspace to fallback handler (should preserve "all")', async () => {
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

    test('works with optional parameters', async () => {
      await handleRooSyncSearch(
        {
          action: 'text',
          search_query: 'test query',
          workspace: 'd:\\test-workspace',
          conversation_id: 'conv-123',
          max_results: 50
        },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
      );

      const callArgs = mockFallbackHandler.mock.calls[0][0];
      expect(callArgs.query).toBe('test query');
      expect(callArgs.workspace).toBe('d:\\test-workspace');
      expect(callArgs.conversation_id).toBe('conv-123');
      expect(callArgs.max_results).toBe(50);
    });
  });

  // ============================================================
  // Diagnose Search
  // ============================================================

  describe('diagnose search', () => {
    test('does not require search_query parameter', async () => {
      const result = await handleRooSyncSearch(
        { action: 'diagnose' },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler,
        mockDiagnoseHandler
      );

      expect(result.isError).toBeFalsy();
    });

    test('calls diagnose handler with diagnose_index: true', async () => {
      await handleRooSyncSearch(
        { action: 'diagnose', search_query: 'diagnose' },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler,
        mockDiagnoseHandler
      );

      expect(mockSemanticHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          search_query: 'diagnose',
          diagnose_index: true
        }),
        mockCache,
        mockEnsureCache,
        mockFallbackHandler,
        mockDiagnoseHandler
      );
    });

    test('returns diagnostic result', async () => {
      mockSemanticHandler.mockResolvedValue({
        content: [{ type: 'text', text: 'Collection: exists, Points: 1234' }]
      });

      const result = await handleRooSyncSearch(
        { action: 'diagnose' },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler,
        mockDiagnoseHandler
      );

      expect(getTextContent(result)).toContain('1234');
    });

    test('diagnose handler is optional', async () => {
      // Call without diagnoseHandler parameter
      const result = await handleRooSyncSearch(
        { action: 'diagnose' },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
        // No diagnoseHandler
      );

      // Should still delegate to semantic handler
      expect(mockSemanticHandler).toHaveBeenCalledWith(
        expect.anything(),
        mockCache,
        mockEnsureCache,
        mockFallbackHandler,
        undefined // diagnoseHandler passed as undefined
      );
    });
  });

  // ============================================================
  // Error handling
  // ============================================================

  describe('error handling', () => {
    test('propagates semantic handler errors', async () => {
      mockSemanticHandler.mockRejectedValue(new Error('Qdrant down'));

      await expect(
        handleRooSyncSearch(
          { action: 'semantic', search_query: 'test', workspace: 'd:\\test-workspace' },
          mockCache,
          mockEnsureCache,
          mockFallbackHandler
        )
      ).rejects.toThrow('Qdrant down');
    });

    test('propagates text handler errors', async () => {
      mockFallbackHandler.mockRejectedValue(new Error('Cache corrupt'));

      await expect(
        handleRooSyncSearch(
          { action: 'text', search_query: 'test' },
          mockCache,
          mockEnsureCache,
          mockFallbackHandler
        )
      ).rejects.toThrow('Cache corrupt');
    });

    test('propagates diagnose handler errors', async () => {
      mockSemanticHandler.mockRejectedValue(new Error('Connection refused'));

      await expect(
        handleRooSyncSearch(
          { action: 'diagnose' },
          mockCache,
          mockEnsureCache,
          mockFallbackHandler,
          mockDiagnoseHandler
        )
      ).rejects.toThrow('Connection refused');
    });
  });

  // ============================================================
  // #636 Phase 2: Temporal filters
  // ============================================================

  describe('#636 Phase 2: temporal filters', () => {
    test('passes start_date and end_date to semantic handler', async () => {
      await handleRooSyncSearch(
        {
          action: 'semantic',
          search_query: 'heartbeat',
          workspace: 'd:\\test-workspace',
          start_date: '2026-03-01',
          end_date: '2026-03-11'
        },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler,
        mockDiagnoseHandler
      );

      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.start_date).toBe('2026-03-01');
      expect(callArgs.end_date).toBe('2026-03-11');
    });

    test('temporal filters are optional (undefined when not provided)', async () => {
      await handleRooSyncSearch(
        { action: 'semantic', search_query: 'test', workspace: 'd:\\test-workspace' },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
      );

      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.start_date).toBeUndefined();
      expect(callArgs.end_date).toBeUndefined();
    });

    test('only start_date can be provided', async () => {
      await handleRooSyncSearch(
        {
          action: 'semantic',
          search_query: 'recent tasks',
          workspace: 'd:\\test-workspace',
          start_date: '2026-03-10'
        },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
      );

      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.start_date).toBe('2026-03-10');
      expect(callArgs.end_date).toBeUndefined();
    });

    test('only end_date can be provided', async () => {
      await handleRooSyncSearch(
        {
          action: 'semantic',
          search_query: 'old tasks',
          workspace: 'd:\\test-workspace',
          end_date: '2026-02-28'
        },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
      );

      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.start_date).toBeUndefined();
      expect(callArgs.end_date).toBe('2026-02-28');
    });
  });

  // ============================================================
  // Optional parameter handling
  // ============================================================

  describe('optional parameters', () => {
    test('#883: semantic with workspace=* does global search (no filter)', async () => {
      await handleRooSyncSearch(
        { action: 'semantic', search_query: 'global query', workspace: '*' },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
      );

      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.workspace).toBeUndefined();
    });

    test('semantic works with only required params (search_query + workspace)', async () => {
      await handleRooSyncSearch(
        { action: 'semantic', search_query: 'minimal query', workspace: 'd:\\test-workspace' },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
      );

      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.search_query).toBe('minimal query');
      // #883: Full paths are passed through — semantic handler does flexible matching
      expect(callArgs.workspace).toBe('d:\\test-workspace');
      expect(callArgs.conversation_id).toBeUndefined();
      expect(callArgs.max_results).toBeUndefined();
    });

    test('text works without workspace', async () => {
      await handleRooSyncSearch(
        { action: 'text', search_query: 'no workspace' },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
      );

      expect(mockFallbackHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'no workspace',
          workspace: undefined
        }),
        mockCache
      );
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
});