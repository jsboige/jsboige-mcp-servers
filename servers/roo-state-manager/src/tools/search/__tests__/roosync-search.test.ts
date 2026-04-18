/**
 * Tests pour roosync_search (outil actif #2, AUCUN test existant)
 * Issue #492 - Couverture des outils actifs
 *
 * @module tools/search/__tests__/roosync-search
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

describe('roosync_search', () => {
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

	// ============================================================
	// Validation
	// ============================================================

	describe('validation', () => {
		test('rejects missing action', async () => {
			const result = await handleRooSyncSearch(
				{} as RooSyncSearchArgs,
				mockCache,
				mockEnsureCache,
				mockFallbackHandler
			);
			expect(result.isError).toBe(true);
			expect(getTextContent(result)).toContain('action');
			expect(getTextContent(result)).toContain('requis');
		});

		test('rejects invalid action', async () => {
			const result = await handleRooSyncSearch(
				{ action: 'invalid' as any },
				mockCache,
				mockEnsureCache,
				mockFallbackHandler
			);
			expect(result.isError).toBe(true);
			expect(getTextContent(result)).toContain('invalide');
		});

		test('semantic requires search_query', async () => {
			const result = await handleRooSyncSearch(
				{ action: 'semantic' },
				mockCache,
				mockEnsureCache,
				mockFallbackHandler
			);
			expect(result.isError).toBe(true);
			expect(getTextContent(result)).toContain('search_query');
		});

		test('text requires search_query', async () => {
			const result = await handleRooSyncSearch(
				{ action: 'text' },
				mockCache,
				mockEnsureCache,
				mockFallbackHandler
			);
			expect(result.isError).toBe(true);
			expect(getTextContent(result)).toContain('search_query');
		});

		test('#883: semantic works without workspace (global search)', async () => {
			await handleRooSyncSearch(
				{ action: 'semantic', search_query: 'test query' },
				mockCache,
				mockEnsureCache,
				mockFallbackHandler
			);
			// Should NOT error — workspace is optional, searches globally when not provided
			expect(mockSemanticHandler).toHaveBeenCalled();
			const callArgs = mockSemanticHandler.mock.calls[0][0];
			expect(callArgs.workspace).toBeUndefined();
		});

		test('diagnose does not require search_query', async () => {
			const result = await handleRooSyncSearch(
				{ action: 'diagnose' },
				mockCache,
				mockEnsureCache,
				mockFallbackHandler,
				mockDiagnoseHandler
			);
			expect(result.isError).toBeFalsy();
		});
	});

	// ============================================================
	// Action: semantic
	// ============================================================

	describe('action: semantic', () => {
		test('delegates to semantic handler with correct args', async () => {
			await handleRooSyncSearch(
				{
					action: 'semantic',
					search_query: 'rate limiting',
					conversation_id: 'conv-123',
					max_results: 5,
					workspace: 'test-ws'
				},
				mockCache,
				mockEnsureCache,
				mockFallbackHandler,
				mockDiagnoseHandler
			);

			expect(mockSemanticHandler).toHaveBeenCalledWith(
				expect.objectContaining({
					search_query: 'rate limiting',
					conversation_id: 'conv-123',
					max_results: 5,
					workspace: 'test-ws',
					diagnose_index: false,
					// #1496: strict_mode must be passed through so semantic errors
					// propagate to the caller instead of silently falling back to text.
					strict_mode: true
				}),
				mockCache,
				mockEnsureCache,
				mockFallbackHandler,
				mockDiagnoseHandler
			);
		});

		test('#1496: passes strict_mode=true to semantic handler', async () => {
			await handleRooSyncSearch(
				{ action: 'semantic', search_query: 'test', workspace: 'd:\\test-workspace' },
				mockCache,
				mockEnsureCache,
				mockFallbackHandler
			);

			const callArgs = mockSemanticHandler.mock.calls[0][0];
			expect(callArgs.strict_mode).toBe(true);
		});

		test('returns semantic handler result', async () => {
			mockSemanticHandler.mockResolvedValue({
				content: [{ type: 'text', text: '{"results": []}' }]
			});

			const result = await handleRooSyncSearch(
				{ action: 'semantic', search_query: 'test query', workspace: 'd:\\test-workspace' },
				mockCache,
				mockEnsureCache,
				mockFallbackHandler
			);

			expect(getTextContent(result)).toBe('{"results": []}');
		});

		test('passes diagnose_index=false for semantic', async () => {
			await handleRooSyncSearch(
				{ action: 'semantic', search_query: 'test', workspace: 'd:\\test-workspace' },
				mockCache,
				mockEnsureCache,
				mockFallbackHandler
			);

			const callArgs = mockSemanticHandler.mock.calls[0][0];
			expect(callArgs.diagnose_index).toBe(false);
		});
	});

	// ============================================================
	// Action: text
	// ============================================================

	describe('action: text', () => {
		test('refreshes cache before text search', async () => {
			await handleRooSyncSearch(
				{ action: 'text', search_query: 'heartbeat', workspace: 'my-ws' },
				mockCache,
				mockEnsureCache,
				mockFallbackHandler
			);

			expect(mockEnsureCache).toHaveBeenCalledWith({ workspace: 'my-ws' });
		});

		test('calls fallback handler directly (not semantic)', async () => {
			await handleRooSyncSearch(
				{ action: 'text', search_query: 'config sync' },
				mockCache,
				mockEnsureCache,
				mockFallbackHandler
			);

			expect(mockFallbackHandler).toHaveBeenCalledWith(
				expect.objectContaining({
					query: 'config sync'
				}),
				mockCache
			);
			expect(mockSemanticHandler).not.toHaveBeenCalled();
		});

		test('passes workspace filter to fallback', async () => {
			await handleRooSyncSearch(
				{ action: 'text', search_query: 'test', workspace: 'd:\\roo-extensions' },
				mockCache,
				mockEnsureCache,
				mockFallbackHandler
			);

			expect(mockFallbackHandler).toHaveBeenCalledWith(
				expect.objectContaining({
					query: 'test',
					workspace: 'd:\\roo-extensions'
				}),
				mockCache
			);
		});

		test('returns fallback handler result', async () => {
			mockFallbackHandler.mockResolvedValue({
				content: [{ type: 'text', text: '{"success":true,"totalFound":3}' }]
			});

			const result = await handleRooSyncSearch(
				{ action: 'text', search_query: 'query' },
				mockCache,
				mockEnsureCache,
				mockFallbackHandler
			);

			expect(getTextContent(result)).toBe('{"success":true,"totalFound":3}');
		});
	});

	// ============================================================
	// Action: diagnose
	// ============================================================

	describe('action: diagnose', () => {
		test('delegates to semantic handler with diagnose_index=true', async () => {
			await handleRooSyncSearch(
				{ action: 'diagnose' },
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
	});
});
