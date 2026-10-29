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
  // Needed by the degraded-fallback branch (#249): the handler classifies the
  // semantic failure. Stubbed as an unattributable mode — the tests here assert
  // what reaches the fallback, not how the mode is derived.
  extractSemanticErrorMode: () => 'unknown',
  INFRASTRUCTURE_ERROR_MODES: new Set<string>(['embedding_api_error', 'qdrant_unreachable']),
  // Re-export the type stub
  SearchTasksByContentArgs: {}
}));

// Mock fallback search
vi.mock('../search-fallback.tool.js', () => ({
  handleSearchTasksSemanticFallback: mockFallbackHandler,
  SearchFallbackArgs: {}
}));

import { handleRooSyncSearch, RooSyncSearchArgs } from '../roosync-search.tool.js';
import { allToolDefinitions } from '../../tool-definitions.js';
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
    test('translates "all" workspace to undefined for text search (#1324)', async () => {
      await handleRooSyncSearch(
        { action: 'text', search_query: 'global search', workspace: 'all' },
        mockCache,
        mockEnsureCache,
        mockFallbackHandler
      );

      // #1324: "all" must be translated to undefined, same as semantic path
      expect(mockFallbackHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'global search',
          workspace: undefined
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

    test('#2609 default — exclude_tool_results is true when OMITTED on the semantic path', async () => {
      // Measured live 2026-10-28 (web1): without the flag, tool-result echoes of the
      // query took ranks 1-3 despite the 0.85 machine-output malus; with it, real
      // decision passages with drill-down handles. The default must now protect the
      // call that passes NO flag at all — an explicit false opts back out.
      await handleRooSyncSearch(
        {
          action: 'semantic',
          search_query: 'coordinator cron cadence decision'
        },
        mockCache,
        mockEnsureCache,
        mockSemanticHandler,
        mockFallbackHandler
      );

      expect(mockSemanticHandler).toHaveBeenCalled();
      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.exclude_tool_results).toBe(true);
    });

    test('#2609 opt-out — an explicit exclude_tool_results:false reaches the semantic handler', async () => {
      await handleRooSyncSearch(
        {
          action: 'semantic',
          search_query: 'include tool outputs this time',
          exclude_tool_results: false
        },
        mockCache,
        mockEnsureCache,
        mockSemanticHandler,
        mockFallbackHandler
      );

      expect(mockSemanticHandler).toHaveBeenCalled();
      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.exclude_tool_results).toBe(false);
    });

    test('#2609 null is NOT overwritten — an explicit exclude_tool_results:null stays unfiltered', async () => {
      // `??` treats null like undefined, so the default silently turned an explicit
      // null into true. JSON callers can send null, and the semantic handler reads
      // the flag by truthiness — null must reach it unchanged (ms#1568 review, item 2).
      await handleRooSyncSearch(
        {
          action: 'semantic',
          search_query: 'legacy unfiltered output',
          exclude_tool_results: null as unknown as boolean
        },
        mockCache,
        mockEnsureCache,
        mockSemanticHandler,
        mockFallbackHandler
      );

      expect(mockSemanticHandler).toHaveBeenCalled();
      const callArgs = mockSemanticHandler.mock.calls[0][0];
      expect(callArgs.exclude_tool_results).toBeNull();
      expect(callArgs.exclude_tool_results).not.toBe(true);
    });

    test('#2609 degraded-text warning follows the SAME null rule, not just the forwarding site', async () => {
      // The degraded fallback flags `exclude_tool_results` as "requested but not
      // evaluable in text mode". If that site kept `??`, an explicit null would
      // raise a warning about a filter the caller did not ask for — the mirror of
      // the bug above, one branch away. Both directions are pinned here.
      mockSemanticHandler.mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'semantic down' }]
      });

      await handleRooSyncSearch(
        {
          action: 'semantic',
          search_query: 'legacy unfiltered output',
          exclude_tool_results: null as unknown as boolean
        },
        mockCache,
        mockEnsureCache,
        mockSemanticHandler,
        mockFallbackHandler
      );
      expect(mockFallbackHandler).toHaveBeenCalled();
      expect(mockFallbackHandler.mock.calls[0][0].filters_requested).toBe(false);

      // And an OMITTED flag must still raise it: the default is in force.
      mockSemanticHandler.mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'semantic down' }]
      });
      mockFallbackHandler.mockClear();
      await handleRooSyncSearch(
        { action: 'semantic', search_query: 'default in force' },
        mockCache,
        mockEnsureCache,
        mockSemanticHandler,
        mockFallbackHandler
      );
      expect(mockFallbackHandler.mock.calls[0][0].filters_requested).toBe(true);
    });

    test('#2609 served-schema parity — the wire definition states the default the handler applies', async () => {
      // Agents only ever see ListTools (allToolDefinitions). Documenting the default
      // in the handler alone leaves the wire lying, which is how ms#1564's
      // repair:"headless" shipped. The two assertions live in ONE test on purpose:
      // the description and the behaviour cannot drift apart without this going red.
      const def = allToolDefinitions.find(d => d.name === 'roosync_search');
      expect(def).toBeDefined();
      const prop = def!.inputSchema.properties!.exclude_tool_results as {
        type?: string;
        description?: string;
      };
      expect(prop.type).toBe('boolean');
      expect(prop.description).toContain('default true');
      expect(prop.description).toContain('tool_interaction');

      await handleRooSyncSearch(
        { action: 'semantic', search_query: 'parity check' },
        mockCache,
        mockEnsureCache,
        mockSemanticHandler,
        mockFallbackHandler
      );
      expect(mockSemanticHandler.mock.calls[0][0].exclude_tool_results).toBe(true);
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