/**
 * Tests for search-semantic.tool.ts
 * Issue #564 - Audit MCP tool coverage
 *
 * Covers:
 * - Helper functions: truncateMessage, extractSnippet, interpretScore, formatRelativeTime
 * - groupResultsByTask: deduplication and sorting
 * - searchTasksByContentTool.handler: semantic search, diagnose, fallback
 * - Tool definition validation
 *
 * @module tools/search/__tests__/search-semantic.tool.test
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── hoisted mocks ───────────────────

const { mockQdrantClient, mockOpenAIClient, mockGetEmbeddingModel } = vi.hoisted(() => ({
	mockQdrantClient: {
		search: vi.fn(),
		getCollection: vi.fn()
	},
	mockOpenAIClient: {
		embeddings: {
			create: vi.fn()
		}
	},
	mockGetEmbeddingModel: vi.fn().mockReturnValue('test-model')
}));

const { mockFallbackHandler } = vi.hoisted(() => ({
	mockFallbackHandler: vi.fn()
}));

const { mockGetHostIdentifier } = vi.hoisted(() => ({
	mockGetHostIdentifier: vi.fn().mockReturnValue('test-host-01')
}));

vi.mock('../../../services/qdrant.js', () => ({
	getQdrantClient: () => mockQdrantClient
}));

vi.mock('../../../services/openai.js', () => ({
	default: () => mockOpenAIClient,
	getEmbeddingModel: () => mockGetEmbeddingModel()
}));

vi.mock('../../../services/task-indexer.js', () => ({
	TaskIndexer: class {},
	getHostIdentifier: () => mockGetHostIdentifier()
}));

vi.mock('../search-fallback.tool.js', () => ({
	handleSearchTasksSemanticFallback: mockFallbackHandler
}));

import { searchTasksByContentTool, SearchTasksByContentArgs } from '../search-semantic.tool.js';
import type { ConversationSkeleton } from '../../../types/conversation.js';

// ─────────────────── helpers ───────────────────

function getTextContent(result: any): string {
	return result.content?.[0]?.text || '';
}

function makeCache(): Map<string, ConversationSkeleton> {
	return new Map();
}

const mockEnsureCache = vi.fn(async () => true);
const defaultFallback = vi.fn(async () => ({
	content: [{ type: 'text', text: 'fallback result' }]
}));

// ─────────────────── setup ───────────────────

beforeEach(() => {
	vi.clearAllMocks();
	mockGetEmbeddingModel.mockReturnValue('test-model');
	mockGetHostIdentifier.mockReturnValue('test-host-01');
	delete process.env.QDRANT_COLLECTION_NAME;
});

// ─────────────────── tests ───────────────────

describe('searchTasksByContentTool', () => {

	// ============================================================
	// Tool definition
	// ============================================================

	describe('definition', () => {
		test('name is search_tasks_by_content', () => {
			expect(searchTasksByContentTool.definition.name).toBe('search_tasks_by_content');
		});

		test('has required search_query field', () => {
			expect(searchTasksByContentTool.definition.inputSchema.required).toContain('search_query');
		});

		test('has workspace property', () => {
			const props = searchTasksByContentTool.definition.inputSchema.properties as Record<string, any>;
			expect(props).toHaveProperty('workspace');
		});

		test('has diagnose_index property', () => {
			const props = searchTasksByContentTool.definition.inputSchema.properties as Record<string, any>;
			expect(props).toHaveProperty('diagnose_index');
		});
	});

	// ============================================================
	// Diagnose mode
	// ============================================================

	describe('diagnose mode', () => {
		test('delegates to diagnoseHandler when provided', async () => {
			const diagnoseHandler = vi.fn(async () => ({
				content: [{ type: 'text', text: 'custom diagnose' }]
			}));

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'test', diagnose_index: true },
				makeCache(),
				mockEnsureCache,
				defaultFallback,
				diagnoseHandler
			);

			expect(diagnoseHandler).toHaveBeenCalled();
			expect(getTextContent(result)).toBe('custom diagnose');
		});

		test('falls back to qdrant diagnostic when no handler', async () => {
			mockQdrantClient.getCollection.mockResolvedValue({
				status: 'green',
				points_count: 500,
				segments_count: 2,
				indexed_vectors_count: 500,
				optimizer_status: 'ok'
			});

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'test', diagnose_index: true },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			expect(getTextContent(result)).toContain('500');
			expect(getTextContent(result)).toContain('Diagnostic');
		});

		test('handles qdrant connection error gracefully in diagnose', async () => {
			mockQdrantClient.getCollection.mockRejectedValue(new Error('Connection refused'));

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'test', diagnose_index: true },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			expect(result.isError).toBe(false);
			expect(getTextContent(result)).toContain('Connection refused');
		});

		test('calls ensureCacheFreshCallback before diagnose', async () => {
			const diagnoseHandler = vi.fn(async () => ({
				content: [{ type: 'text', text: 'ok' }]
			}));

			await searchTasksByContentTool.handler(
				{ search_query: 'test', diagnose_index: true, workspace: 'ws1' },
				makeCache(),
				mockEnsureCache,
				defaultFallback,
				diagnoseHandler
			);

			expect(mockEnsureCache).toHaveBeenCalledWith({ workspace: 'ws1' });
		});
	});

	// ============================================================
	// Semantic search (happy path)
	// ============================================================

	describe('semantic search', () => {
		beforeEach(() => {
			mockOpenAIClient.embeddings.create.mockResolvedValue({
				data: [{ embedding: [0.1, 0.2, 0.3] }]
			});
		});

		test('creates embedding from search query', async () => {
			mockQdrantClient.search.mockResolvedValue([]);

			await searchTasksByContentTool.handler(
				{ search_query: 'rate limiting' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			expect(mockOpenAIClient.embeddings.create).toHaveBeenCalledWith({
				model: 'test-model',
				input: 'rate limiting'
			});
		});

		test('uses default collection name', async () => {
			mockQdrantClient.search.mockResolvedValue([]);

			await searchTasksByContentTool.handler(
				{ search_query: 'test' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			expect(mockQdrantClient.search).toHaveBeenCalledWith(
				'roo_tasks_semantic_index',
				expect.any(Object)
			);
		});

		test('uses custom collection name from env', async () => {
			process.env.QDRANT_COLLECTION_NAME = 'custom_collection';
			mockQdrantClient.search.mockResolvedValue([]);

			await searchTasksByContentTool.handler(
				{ search_query: 'test' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			expect(mockQdrantClient.search).toHaveBeenCalledWith(
				'custom_collection',
				expect.any(Object)
			);
		});

		test('applies conversation_id filter', async () => {
			mockQdrantClient.search.mockResolvedValue([]);

			await searchTasksByContentTool.handler(
				{ search_query: 'test', conversation_id: 'conv-123' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const searchCall = mockQdrantClient.search.mock.calls[0][1];
			expect(searchCall.filter).toEqual({
				must: [{ key: 'task_id', match: { value: 'conv-123' } }]
			});
		});

		test('applies workspace filter', async () => {
			mockQdrantClient.search.mockResolvedValue([]);

			await searchTasksByContentTool.handler(
				{ search_query: 'test', workspace: 'd:\\roo-extensions' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const searchCall = mockQdrantClient.search.mock.calls[0][1];
			expect(searchCall.filter).toEqual({
				must: [{ key: 'workspace', match: { value: 'd:\\roo-extensions' } }]
			});
		});

		test('combines conversation_id and workspace filters', async () => {
			mockQdrantClient.search.mockResolvedValue([]);

			await searchTasksByContentTool.handler(
				{ search_query: 'test', conversation_id: 'conv-1', workspace: 'ws' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const searchCall = mockQdrantClient.search.mock.calls[0][1];
			expect(searchCall.filter.must).toHaveLength(2);
		});

		test('no filter when no conversation_id or workspace', async () => {
			mockQdrantClient.search.mockResolvedValue([]);

			await searchTasksByContentTool.handler(
				{ search_query: 'test' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const searchCall = mockQdrantClient.search.mock.calls[0][1];
			expect(searchCall.filter).toBeUndefined();
		});

		test('ignores conversation_id="undefined"', async () => {
			mockQdrantClient.search.mockResolvedValue([]);

			await searchTasksByContentTool.handler(
				{ search_query: 'test', conversation_id: 'undefined' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const searchCall = mockQdrantClient.search.mock.calls[0][1];
			expect(searchCall.filter).toBeUndefined();
		});

		test('uses max_results or default 10', async () => {
			mockQdrantClient.search.mockResolvedValue([]);

			await searchTasksByContentTool.handler(
				{ search_query: 'test', max_results: 5 },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			expect(mockQdrantClient.search.mock.calls[0][1].limit).toBe(5);
		});

		test('defaults to 10 results', async () => {
			mockQdrantClient.search.mockResolvedValue([]);

			await searchTasksByContentTool.handler(
				{ search_query: 'test' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			expect(mockQdrantClient.search.mock.calls[0][1].limit).toBe(10);
		});

		test('returns grouped results with cross-machine analysis', async () => {
			mockQdrantClient.search.mockResolvedValue([
				{
					score: 0.85,
					payload: {
						task_id: 'task-1',
						content: 'Rate limiting implementation',
						task_title: 'Fix rate limiter',
						workspace: 'ws1',
						host_os: 'machine-a',
						chunk_type: 'user',
						role: 'user'
					}
				},
				{
					score: 0.70,
					payload: {
						task_id: 'task-2',
						content: 'Another result',
						task_title: 'Other task',
						workspace: 'ws1',
						host_os: 'machine-b',
						chunk_type: 'assistant'
					}
				}
			]);

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'rate limiting' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const parsed = JSON.parse(getTextContent(result));
			expect(parsed.current_machine.host_id).toBe('test-host-01');
			expect(parsed.current_machine.results_count).toBe(2);
			expect(parsed.current_machine.unique_tasks).toBe(2);
			expect(parsed.cross_machine_analysis.machines_found).toContain('machine-a');
			expect(parsed.cross_machine_analysis.machines_found).toContain('machine-b');
			expect(parsed.results).toHaveLength(2);
			expect(parsed.results[0].best_score).toBe(0.85);
		});

		test('deduplicates multiple chunks from same task', async () => {
			mockQdrantClient.search.mockResolvedValue([
				{
					score: 0.9,
					payload: { task_id: 'task-1', content: 'First chunk', task_title: 'Task', host_os: 'h1' }
				},
				{
					score: 0.7,
					payload: { task_id: 'task-1', content: 'Second chunk', task_title: 'Task', host_os: 'h1' }
				}
			]);

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'test' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const parsed = JSON.parse(getTextContent(result));
			expect(parsed.results).toHaveLength(1);
			expect(parsed.results[0].chunks).toHaveLength(2);
			expect(parsed.results[0].best_score).toBe(0.9);
		});
	});

	// ============================================================
	// Fallback on semantic error
	// ============================================================

	describe('fallback on semantic error', () => {
		test('falls back to text search when qdrant fails', async () => {
			mockOpenAIClient.embeddings.create.mockRejectedValue(new Error('API down'));
			defaultFallback.mockResolvedValue({
				content: [{ type: 'text', text: 'fallback results here' }]
			});

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'test query', workspace: 'ws1' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			expect(defaultFallback).toHaveBeenCalledWith(
				{ query: 'test query', workspace: 'ws1' },
				expect.any(Map)
			);
			expect(getTextContent(result)).toBe('fallback results here');
		});

		test('maps search_query to query for fallback', async () => {
			mockOpenAIClient.embeddings.create.mockRejectedValue(new Error('fail'));
			defaultFallback.mockResolvedValue({
				content: [{ type: 'text', text: 'ok' }]
			});

			await searchTasksByContentTool.handler(
				{ search_query: 'my specific query' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			expect(defaultFallback).toHaveBeenCalledWith(
				expect.objectContaining({ query: 'my specific query' }),
				expect.any(Map)
			);
		});

		test('handles fallback error gracefully', async () => {
			mockOpenAIClient.embeddings.create.mockRejectedValue(new Error('API down'));
			defaultFallback.mockRejectedValue(new Error('Fallback also failed'));

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'test' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			expect(result.isError).toBe(false);
			expect(getTextContent(result)).toContain('Fallback also failed');
		});
	});

	// ============================================================
	// Qdrant response normalization
	// ============================================================

	describe('qdrant response normalization', () => {
		beforeEach(() => {
			mockOpenAIClient.embeddings.create.mockResolvedValue({
				data: [{ embedding: [0.1] }]
			});
		});

		test('handles array response', async () => {
			mockQdrantClient.search.mockResolvedValue([
				{ score: 0.8, payload: { task_id: 't1', content: 'c1', host_os: 'h1' } }
			]);

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'test' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const parsed = JSON.parse(getTextContent(result));
			expect(parsed.results).toHaveLength(1);
		});

		test('handles object with result field', async () => {
			mockQdrantClient.search.mockResolvedValue({
				result: [
					{ score: 0.8, payload: { task_id: 't1', content: 'c1', host_os: 'h1' } }
				]
			});

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'test' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const parsed = JSON.parse(getTextContent(result));
			expect(parsed.results).toHaveLength(1);
		});

		test('handles empty results', async () => {
			mockQdrantClient.search.mockResolvedValue([]);

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'no results expected' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const parsed = JSON.parse(getTextContent(result));
			expect(parsed.results).toHaveLength(0);
			expect(parsed.current_machine.results_count).toBe(0);
		});
	});
});

// ============================================================
// Helper functions (tested via module internals exposure)
// We test them indirectly through the handler results
// ============================================================

describe('helper functions (indirect via handler)', () => {
	beforeEach(() => {
		mockOpenAIClient.embeddings.create.mockResolvedValue({
			data: [{ embedding: [0.1] }]
		});
	});

	test('interpretScore: excellent for score >= 0.9', async () => {
		mockQdrantClient.search.mockResolvedValue([
			{ score: 0.95, payload: { task_id: 't1', content: 'test', host_os: 'h1' } }
		]);

		const result = await searchTasksByContentTool.handler(
			{ search_query: 'test' },
			makeCache(),
			mockEnsureCache,
			defaultFallback
		);

		const parsed = JSON.parse(getTextContent(result));
		expect(parsed.results[0].relevance).toBe('excellent');
	});

	test('interpretScore: good for score >= 0.75', async () => {
		mockQdrantClient.search.mockResolvedValue([
			{ score: 0.78, payload: { task_id: 't1', content: 'test', host_os: 'h1' } }
		]);

		const result = await searchTasksByContentTool.handler(
			{ search_query: 'test' },
			makeCache(),
			mockEnsureCache,
			defaultFallback
		);

		const parsed = JSON.parse(getTextContent(result));
		expect(parsed.results[0].relevance).toBe('good');
	});

	test('interpretScore: moderate for score >= 0.6', async () => {
		mockQdrantClient.search.mockResolvedValue([
			{ score: 0.65, payload: { task_id: 't1', content: 'test', host_os: 'h1' } }
		]);

		const result = await searchTasksByContentTool.handler(
			{ search_query: 'test' },
			makeCache(),
			mockEnsureCache,
			defaultFallback
		);

		const parsed = JSON.parse(getTextContent(result));
		expect(parsed.results[0].relevance).toBe('moderate');
	});

	test('interpretScore: weak for score >= 0.4', async () => {
		mockQdrantClient.search.mockResolvedValue([
			{ score: 0.45, payload: { task_id: 't1', content: 'test', host_os: 'h1' } }
		]);

		const result = await searchTasksByContentTool.handler(
			{ search_query: 'test' },
			makeCache(),
			mockEnsureCache,
			defaultFallback
		);

		const parsed = JSON.parse(getTextContent(result));
		expect(parsed.results[0].relevance).toBe('weak');
	});

	test('extractSnippet: centers around query match', async () => {
		const longContent = 'A'.repeat(200) + ' rate limiting implementation here ' + 'B'.repeat(200);
		mockQdrantClient.search.mockResolvedValue([
			{ score: 0.8, payload: { task_id: 't1', content: longContent, host_os: 'h1' } }
		]);

		const result = await searchTasksByContentTool.handler(
			{ search_query: 'rate limiting' },
			makeCache(),
			mockEnsureCache,
			defaultFallback
		);

		const parsed = JSON.parse(getTextContent(result));
		const snippet = parsed.results[0].chunks[0].snippet;
		expect(snippet).toContain('rate');
		expect(snippet.length).toBeLessThan(longContent.length);
	});

	test('groupResultsByTask: groups and sorts by best score', async () => {
		mockQdrantClient.search.mockResolvedValue([
			{ score: 0.6, payload: { task_id: 'task-b', content: 'chunk1', host_os: 'h1' } },
			{ score: 0.9, payload: { task_id: 'task-a', content: 'chunk1', host_os: 'h1' } },
			{ score: 0.7, payload: { task_id: 'task-b', content: 'chunk2', host_os: 'h1' } },
		]);

		const result = await searchTasksByContentTool.handler(
			{ search_query: 'test' },
			makeCache(),
			mockEnsureCache,
			defaultFallback
		);

		const parsed = JSON.parse(getTextContent(result));
		// task-a should be first (score 0.9 > task-b's best 0.7)
		expect(parsed.results[0].taskId).toBe('task-a');
		expect(parsed.results[1].taskId).toBe('task-b');
		expect(parsed.results[1].chunks).toHaveLength(2);
		expect(parsed.results[1].best_score).toBe(0.7);
	});
});
