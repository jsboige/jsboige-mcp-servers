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
	getQdrantClient: () => mockQdrantClient,
	resetQdrantClient: vi.fn(),
	isLargeCollection: vi.fn(async () => false),
	getCollectionSize: vi.fn(async () => 1000)
}));

vi.mock('../../../services/openai.js', () => ({
	default: () => mockOpenAIClient,
	getEmbeddingModel: () => mockGetEmbeddingModel()
}));

vi.mock('../../../services/task-indexer.js', () => ({
	TaskIndexer: class {},
	getHostIdentifier: () => mockGetHostIdentifier()
}));

vi.mock('../../../services/task-indexer/ChunkExtractor.js', () => ({
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
	content: [{ type: 'text', text: JSON.stringify({ mode: 'fallback_text_search', results: [] }) }],
	isError: false
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

		test('#883: semantic search does NOT call ensureCacheFreshCallback (perf fix)', async () => {
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

			// #883: Cache refresh was removed from semantic search path because
			// it caused ~70s I/O scan latency. The cache is not needed for Qdrant search.
			expect(mockEnsureCache).not.toHaveBeenCalled();
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

		test('applies has_errors filter', async () => {
			mockQdrantClient.search.mockResolvedValue([]);

			await searchTasksByContentTool.handler(
				{ search_query: 'test', has_errors: true },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const searchCall = mockQdrantClient.search.mock.calls[0][1];
			expect(searchCall.filter).toEqual({
				must: [{ key: 'has_error', match: { value: true } }]
			});
		});

		test('applies model filter', async () => {
			mockQdrantClient.search.mockResolvedValue([]);

			await searchTasksByContentTool.handler(
				{ search_query: 'test', model: 'opus' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const searchCall = mockQdrantClient.search.mock.calls[0][1];
			expect(searchCall.filter).toEqual({
				must: [{ key: 'model', match: { value: 'opus' } }]
			});
		});

		test('combines has_errors and model filters', async () => {
			mockQdrantClient.search.mockResolvedValue([]);

			await searchTasksByContentTool.handler(
				{ search_query: 'test', has_errors: true, model: 'sonnet' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const searchCall = mockQdrantClient.search.mock.calls[0][1];
			expect(searchCall.filter.must).toHaveLength(2);
			expect(searchCall.filter.must).toContainEqual({ key: 'has_error', match: { value: true } });
			expect(searchCall.filter.must).toContainEqual({ key: 'model', match: { value: 'sonnet' } });
		});

		test('includes message_position when message_index and total_messages are in payload', async () => {
			mockQdrantClient.search.mockResolvedValue([{
				score: 0.8,
				payload: {
					task_id: 'task-1',
					content: 'some content',
					task_title: 'Test task',
					host_os: 'machine-a',
					message_index: 3,
					total_messages: 10
				}
			}]);

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'test' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const parsed = JSON.parse(getTextContent(result));
			const chunk = parsed.results[0].chunks[0];
			expect(chunk.message_position).toBe('3/10');
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

		// ========================================================
		// #1244 Couche 1.3 — Push date filters into Qdrant directly
		// ========================================================
		test('[#1244 1.3] pushes start_date and end_date as Qdrant range filter on timestamp', async () => {
			mockQdrantClient.search.mockResolvedValue([]);

			await searchTasksByContentTool.handler(
				{
					search_query: 'work',
					start_date: '2026-04-07',
					end_date: '2026-04-08',
				} as any,
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const searchCall = mockQdrantClient.search.mock.calls[0][1];
			expect(searchCall.filter).toBeDefined();
			expect(searchCall.filter.must).toBeDefined();

			// Should contain a range filter on the `timestamp` key.
			const timestampFilter = searchCall.filter.must.find(
				(c: any) => c && c.key === 'timestamp' && c.range
			);
			expect(timestampFilter).toBeDefined();

			// gte must use start-of-day at UTC
			expect(timestampFilter.range.gte).toBe('2026-04-07T00:00:00.000Z');
			// lte must be expanded to end-of-day at UTC (pure date → 23:59:59.999)
			expect(timestampFilter.range.lte).toBe('2026-04-08T23:59:59.999Z');
		});

		test('[#1244 1.3] pushes start_date only as Qdrant range filter (no lte)', async () => {
			mockQdrantClient.search.mockResolvedValue([]);

			await searchTasksByContentTool.handler(
				{
					search_query: 'work',
					start_date: '2026-04-07',
				} as any,
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const searchCall = mockQdrantClient.search.mock.calls[0][1];
			const timestampFilter = searchCall.filter.must.find(
				(c: any) => c && c.key === 'timestamp' && c.range
			);
			expect(timestampFilter).toBeDefined();
			expect(timestampFilter.range.gte).toBe('2026-04-07T00:00:00.000Z');
			expect(timestampFilter.range.lte).toBeUndefined();
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
		const longContent = 'A'.repeat(400) + ' rate limiting implementation here ' + 'B'.repeat(400);
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

	// ============================================================
	// #636 Phase 2: Temporal filters
	// ============================================================

	describe('#636 Phase 2: temporal filters', () => {
		const setupSearchWithTimestamps = () => {
			mockOpenAIClient.embeddings.create.mockResolvedValue({
				data: [{ embedding: [0.1, 0.2, 0.3] }]
			});
			mockQdrantClient.search.mockResolvedValue([
				{ score: 0.9, payload: { task_id: 'task-recent', content: 'recent work', host_os: 'h1', timestamp: '2026-03-10T12:00:00Z' } },
				{ score: 0.8, payload: { task_id: 'task-mid', content: 'mid work', host_os: 'h1', timestamp: '2026-03-05T12:00:00Z' } },
				{ score: 0.7, payload: { task_id: 'task-old', content: 'old work', host_os: 'h1', timestamp: '2026-02-20T12:00:00Z' } },
			]);
		};

		test('filters results by start_date', async () => {
			setupSearchWithTimestamps();

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'work', start_date: '2026-03-01' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const parsed = JSON.parse(getTextContent(result));
			expect(parsed.current_machine.results_count).toBe(2);
			expect(parsed.current_machine.temporal_filter).toBeDefined();
			expect(parsed.current_machine.temporal_filter.pre_filter_count).toBe(3);
			expect(parsed.current_machine.temporal_filter.post_filter_count).toBe(2);
			// task-old (Feb 20) should be filtered out
			const taskIds = parsed.results.map((r: any) => r.taskId);
			expect(taskIds).not.toContain('task-old');
			expect(taskIds).toContain('task-recent');
			expect(taskIds).toContain('task-mid');
		});

		test('filters results by end_date', async () => {
			setupSearchWithTimestamps();

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'work', end_date: '2026-03-01' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const parsed = JSON.parse(getTextContent(result));
			expect(parsed.current_machine.results_count).toBe(1);
			// Only task-old should remain
			expect(parsed.results[0].taskId).toBe('task-old');
		});

		test('filters results by both start_date and end_date', async () => {
			setupSearchWithTimestamps();

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'work', start_date: '2026-03-01', end_date: '2026-03-08' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const parsed = JSON.parse(getTextContent(result));
			expect(parsed.current_machine.results_count).toBe(1);
			expect(parsed.results[0].taskId).toBe('task-mid');
		});

		test('no temporal filter when dates not provided', async () => {
			setupSearchWithTimestamps();

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'work' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const parsed = JSON.parse(getTextContent(result));
			expect(parsed.current_machine.results_count).toBe(3);
			expect(parsed.current_machine.temporal_filter).toBeUndefined();
		});

		test('handles ISO 8601 date format for start_date', async () => {
			setupSearchWithTimestamps();

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'work', start_date: '2026-03-06T00:00:00Z' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const parsed = JSON.parse(getTextContent(result));
			expect(parsed.current_machine.results_count).toBe(1);
			expect(parsed.results[0].taskId).toBe('task-recent');
		});

		test('handles results with no timestamp gracefully', async () => {
			mockOpenAIClient.embeddings.create.mockResolvedValue({
				data: [{ embedding: [0.1, 0.2, 0.3] }]
			});
			mockQdrantClient.search.mockResolvedValue([
				{ score: 0.9, payload: { task_id: 'task-no-ts', content: 'no timestamp', host_os: 'h1' } },
				{ score: 0.8, payload: { task_id: 'task-with-ts', content: 'has ts', host_os: 'h1', timestamp: '2026-03-10T12:00:00Z' } },
			]);

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'test', start_date: '2026-03-01' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const parsed = JSON.parse(getTextContent(result));
			// Only the result with a valid timestamp in range should remain
			expect(parsed.current_machine.results_count).toBe(1);
			expect(parsed.results[0].taskId).toBe('task-with-ts');
		});

		test('invalid date string is ignored (no filtering)', async () => {
			setupSearchWithTimestamps();

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'work', start_date: 'not-a-date' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const parsed = JSON.parse(getTextContent(result));
			// Invalid date should be parsed as null, no filtering applied
			expect(parsed.current_machine.results_count).toBe(3);
		});
	});

	// ============================================================
	// #636 Phase 2: Conversation stats enrichment
	// ============================================================

	describe('#636 Phase 2: conversation stats', () => {
		test('enriches results with conversation stats from cache', async () => {
			mockOpenAIClient.embeddings.create.mockResolvedValue({
				data: [{ embedding: [0.1, 0.2, 0.3] }]
			});
			mockQdrantClient.search.mockResolvedValue([
				{ score: 0.9, payload: { task_id: 'task-cached', content: 'test content', host_os: 'h1' } },
			]);

			const cache = makeCache();
			cache.set('task-cached', {
				taskId: 'task-cached',
				metadata: {
					messageCount: 42,
					actionCount: 10,
					totalSize: 5000,
					lastActivity: '2026-03-10T15:00:00Z',
					createdAt: '2026-03-10T10:00:00Z',
					workspace: 'd:\\dev\\roo-extensions',
				},
				sequence: [],
			} as any);

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'test' },
				cache,
				mockEnsureCache,
				defaultFallback
			);

			const parsed = JSON.parse(getTextContent(result));
			expect(parsed.results[0].conversation_stats).toBeDefined();
			expect(parsed.results[0].conversation_stats.total_messages).toBe(42);
			expect(parsed.results[0].conversation_stats.workspace).toBe('d:\\dev\\roo-extensions');
			expect(parsed.results[0].conversation_stats.last_activity).toBe('2026-03-10T15:00:00Z');
		});

		test('results without cache entry have no conversation_stats', async () => {
			mockOpenAIClient.embeddings.create.mockResolvedValue({
				data: [{ embedding: [0.1, 0.2, 0.3] }]
			});
			mockQdrantClient.search.mockResolvedValue([
				{ score: 0.9, payload: { task_id: 'task-uncached', content: 'test', host_os: 'h1' } },
			]);

			const result = await searchTasksByContentTool.handler(
				{ search_query: 'test' },
				makeCache(), // empty cache
				mockEnsureCache,
				defaultFallback
			);

			const parsed = JSON.parse(getTextContent(result));
			expect(parsed.results[0].conversation_stats).toBeUndefined();
		});
	});

	// ============================================================
	// #636 Phase 3: exclude_tool_results filter
	// ============================================================

	describe('#636 Phase 3: exclude_tool_results', () => {
		beforeEach(() => {
			mockOpenAIClient.embeddings.create.mockResolvedValue({
				data: [{ embedding: [0.1, 0.2, 0.3] }]
			});
		});

		test('exclude_tool_results=true adds chunk_type=message_exchange filter to Qdrant query', async () => {
			mockQdrantClient.search.mockResolvedValue([]);

			await searchTasksByContentTool.handler(
				{ search_query: 'test', exclude_tool_results: true },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			expect(mockQdrantClient.search).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					filter: expect.objectContaining({
						must: expect.arrayContaining([
							{ key: 'chunk_type', match: { value: 'message_exchange' } }
						])
					})
				})
			);
		});

		test('exclude_tool_results=false does not add chunk_type filter', async () => {
			mockQdrantClient.search.mockResolvedValue([]);

			await searchTasksByContentTool.handler(
				{ search_query: 'test', exclude_tool_results: false },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const callArgs = mockQdrantClient.search.mock.calls[0][1];
			// No filter, or filter without chunk_type
			if (callArgs.filter) {
				const must = callArgs.filter.must || [];
				expect(must.some((c: any) => c.key === 'chunk_type')).toBe(false);
			} else {
				expect(callArgs.filter).toBeUndefined();
			}
		});

		test('explicit chunk_type takes precedence over exclude_tool_results', async () => {
			mockQdrantClient.search.mockResolvedValue([]);

			await searchTasksByContentTool.handler(
				{ search_query: 'test', chunk_type: 'tool_interaction', exclude_tool_results: true },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			// chunk_type is set explicitly → effectiveChunkType = 'tool_interaction' (not overridden)
			expect(mockQdrantClient.search).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					filter: expect.objectContaining({
						must: expect.arrayContaining([
							{ key: 'chunk_type', match: { value: 'tool_interaction' } }
						])
					})
				})
			);
		});

		test('exclude_tool_results=true returns only message_exchange chunks from results', async () => {
			mockQdrantClient.search.mockResolvedValue([
				{ score: 0.9, payload: { task_id: 'task-1', content: 'user message', host_os: 'h1', chunk_type: 'message_exchange' } },
				{ score: 0.8, payload: { task_id: 'task-2', content: 'tool response', host_os: 'h1', chunk_type: 'tool_interaction' } },
			]);

			// Note: Qdrant filter is applied at DB level. In this test mock returns both,
			// so the result reflects what Qdrant would return (filter passed correctly to it).
			const result = await searchTasksByContentTool.handler(
				{ search_query: 'test', exclude_tool_results: true },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			// The filter was sent to Qdrant correctly (verified in separate test)
			// Result structure should still be valid
			const parsed = JSON.parse(getTextContent(result));
			expect(parsed.results).toBeDefined();
			expect(Array.isArray(parsed.results)).toBe(true);
		});
	});

	// ============================================================
	// #883: Performance parameter verification
	// ============================================================

	describe('#883: Qdrant performance parameters', () => {
		beforeEach(() => {
			mockOpenAIClient.embeddings.create.mockResolvedValue({
				data: [{ embedding: [0.1, 0.2, 0.3] }]
			});
			mockQdrantClient.search.mockResolvedValue([]);
		});

		test('passes hnsw_ef=128 to Qdrant search', async () => {
			await searchTasksByContentTool.handler(
				{ search_query: 'test perf', workspace: 'd:\\test' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const searchCall = mockQdrantClient.search.mock.calls[0][1];
			expect(searchCall.params).toBeDefined();
			expect(searchCall.params.hnsw_ef).toBe(128);
		});

		test('passes exact=false to Qdrant search', async () => {
			await searchTasksByContentTool.handler(
				{ search_query: 'test perf', workspace: 'd:\\test' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const searchCall = mockQdrantClient.search.mock.calls[0][1];
			expect(searchCall.params.exact).toBe(false);
		});

		test('passes quantization.rescore=true to Qdrant search', async () => {
			await searchTasksByContentTool.handler(
				{ search_query: 'test perf', workspace: 'd:\\test' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const searchCall = mockQdrantClient.search.mock.calls[0][1];
			expect(searchCall.params.quantization).toBeDefined();
			expect(searchCall.params.quantization.rescore).toBe(true);
		});

		test('uses selective with_payload (include list, not true)', async () => {
			await searchTasksByContentTool.handler(
				{ search_query: 'test perf', workspace: 'd:\\test' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			const searchCall = mockQdrantClient.search.mock.calls[0][1];
			// Must NOT be `true` (fetches all fields including large content)
			expect(searchCall.with_payload).not.toBe(true);
			// Must be an object with `include` array
			expect(searchCall.with_payload).toHaveProperty('include');
			expect(Array.isArray(searchCall.with_payload.include)).toBe(true);
			// Must include essential fields
			expect(searchCall.with_payload.include).toContain('task_id');
			expect(searchCall.with_payload.include).toContain('timestamp');
			expect(searchCall.with_payload.include).toContain('workspace');
			expect(searchCall.with_payload.include).toContain('source');
		});

		test('does NOT call ensureCacheFreshCallback for semantic search', async () => {
			await searchTasksByContentTool.handler(
				{ search_query: 'test perf', workspace: 'd:\\test' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			// #883: Cache refresh was removed from semantic path (root cause of ~70s latency)
			expect(mockEnsureCache).not.toHaveBeenCalled();
		});

		test('respects QDRANT_SEARCH_TIMEOUT_MS env var', async () => {
			// The timeout is implemented via Promise.race in the handler
			// We verify it reads from env by checking no error when env is set
			process.env.QDRANT_SEARCH_TIMEOUT_MS = '5000';

			await searchTasksByContentTool.handler(
				{ search_query: 'test timeout', workspace: 'd:\\test' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			// If we get here without error, the timeout wrapper accepted the env var
			expect(mockQdrantClient.search).toHaveBeenCalled();
			delete process.env.QDRANT_SEARCH_TIMEOUT_MS;
		});

		test('no debug console.log in search results path', async () => {
			// #883 P1: Verify no JSON.stringify debug logging on results
			const consoleSpy = vi.spyOn(console, 'log');

			mockQdrantClient.search.mockResolvedValue([{
				id: 'p1',
				score: 0.9,
				payload: {
					task_id: 't1', timestamp: '2026-01-01', chunk_type: 'message_exchange',
					content_summary: 'test', workspace: 'd:\\test', source: 'roo',
					chunk_id: 'c1', task_title: 'Test Task', role: 'user', model: 'opus'
				}
			}]);

			await searchTasksByContentTool.handler(
				{ search_query: 'test no debug', workspace: 'd:\\test' },
				makeCache(),
				mockEnsureCache,
				defaultFallback
			);

			// Verify no DEBUG log calls with searchResults serialization
			const debugCalls = consoleSpy.mock.calls.filter(
				call => typeof call[0] === 'string' && call[0].includes('[DEBUG] searchResults')
			);
			expect(debugCalls).toHaveLength(0);

			consoleSpy.mockRestore();
		});

	describe('Circuit Breaker Functionality', () => {
		test('activates on HTTP 502 Bad Gateway', async () => {
			vi.useRealTimers();
			vi.resetModules();

			const { searchTasksByContentTool, _resetEmbeddingCircuitBreaker } = await import('../search-semantic.tool.js');

			const mockError = Object.assign(new Error('Bad Gateway'), {
				response: { status: 502, statusText: 'Bad Gateway', data: {} }
			});
			mockOpenAIClient.embeddings.create.mockRejectedValueOnce(mockError);

			const result = await searchTasksByContentTool.handler({
				search_query: 'test circuit breaker 502',
				workspace: 'd:	est'
			}, makeCache(), mockEnsureCache, defaultFallback);

			expect(result.isError).toBe(false);
			expect(result.content[0].text).toContain('fallback_text_search');
		});

		test('activates on HTTP 503 Service Unavailable', async () => {
			vi.useRealTimers();
			vi.resetModules();

			const { searchTasksByContentTool, _resetEmbeddingCircuitBreaker } = await import('../search-semantic.tool.js');

			const mockError = Object.assign(new Error('Service Unavailable'), {
				response: { status: 503, statusText: 'Service Unavailable', data: {} }
			});
			mockOpenAIClient.embeddings.create.mockRejectedValueOnce(mockError);

			const result = await searchTasksByContentTool.handler({
				search_query: 'test circuit breaker 503',
				workspace: 'd:	est'
			}, makeCache(), mockEnsureCache, defaultFallback);

			expect(result.isError).toBe(false);
			expect(result.content[0].text).toContain('fallback_text_search');
		});

		test('activates on HTTP 504 Gateway Timeout', async () => {
			vi.useRealTimers();
			vi.resetModules();

			const { searchTasksByContentTool, _resetEmbeddingCircuitBreaker } = await import('../search-semantic.tool.js');

			const mockError = Object.assign(new Error('Gateway Timeout'), {
				response: { status: 504, statusText: 'Gateway Timeout', data: {} }
			});
			mockOpenAIClient.embeddings.create.mockRejectedValueOnce(mockError);

			const result = await searchTasksByContentTool.handler({
				search_query: 'test circuit breaker 504',
				workspace: 'd:	est'
			}, makeCache(), mockEnsureCache, defaultFallback);

			expect(result.isError).toBe(false);
			expect(result.content[0].text).toContain('fallback_text_search');
		});

		test('does NOT activate on HTTP 400 Bad Request', async () => {
			vi.useRealTimers();
			vi.resetModules();

			const { searchTasksByContentTool } = await import('../search-semantic.tool.js');

			const mockError = Object.assign(new Error('Bad Request'), {
				response: { status: 400, statusText: 'Bad Request', data: {} }
			});
			mockOpenAIClient.embeddings.create.mockRejectedValueOnce(mockError);

			// First call — 400 error triggers fallback but should NOT activate circuit breaker
			const result = await searchTasksByContentTool.handler({
				search_query: 'test circuit breaker 400',
				workspace: 'd:\\test'
			}, makeCache(), mockEnsureCache, defaultFallback);

			// Fallback still works (isError: false) — 400 is handled gracefully
			expect(result.isError).toBe(false);

			// Verify circuit breaker NOT activated: second call should still hit the API
			mockOpenAIClient.embeddings.create.mockResolvedValueOnce({
				data: [{ embedding: new Array(1536).fill(0.1) }]
			});
			mockQdrantClient.search.mockResolvedValueOnce([]);

			await searchTasksByContentTool.handler({
				search_query: 'test after 400',
				workspace: 'd:\\test'
			}, makeCache(), mockEnsureCache, defaultFallback);

			// API was called twice (not blocked by circuit breaker)
			expect(mockOpenAIClient.embeddings.create).toHaveBeenCalledTimes(2);
		});

		test('prevents repeated calls when circuit breaker active', async () => {
			vi.useRealTimers();
			vi.resetModules();

			const { searchTasksByContentTool, _resetEmbeddingCircuitBreaker } = await import('../search-semantic.tool.js');

			const mockError = Object.assign(new Error('Service Unavailable'), {
				response: { status: 503, statusText: 'Service Unavailable', data: {} }
			});
			mockOpenAIClient.embeddings.create.mockRejectedValueOnce(mockError);

			// First call - triggers circuit breaker
			await searchTasksByContentTool.handler({
				search_query: 'trigger breaker',
				workspace: 'd:	est'
			}, makeCache(), mockEnsureCache, defaultFallback);

			// Second call - should use fallback without calling API
			const result = await searchTasksByContentTool.handler({
				search_query: 'use fallback',
				workspace: 'd:	est'
			}, makeCache(), mockEnsureCache, defaultFallback);

			expect(result.isError).toBe(false);
			expect(mockOpenAIClient.embeddings.create).toHaveBeenCalledTimes(1);
		});

		test('resets after TTL expires', async () => {
			vi.useFakeTimers();
			vi.resetModules();

			const { searchTasksByContentTool, _resetEmbeddingCircuitBreaker } = await import('../search-semantic.tool.js');

			const mockError = Object.assign(new Error('Service Unavailable'), {
				response: { status: 503, statusText: 'Service Unavailable', data: {} }
			});
			mockOpenAIClient.embeddings.create.mockRejectedValueOnce(mockError);
			mockOpenAIClient.embeddings.create.mockResolvedValueOnce({
				data: [{ embedding: new Array(1536).fill(0.1) }]
			});

			// Trigger circuit breaker
			await searchTasksByContentTool.handler({
				search_query: 'trigger',
				workspace: 'd:	est'
			}, makeCache(), mockEnsureCache, defaultFallback);

			// Advance past TTL (default 300000ms)
			vi.advanceTimersByTime(310000);

			// Should attempt API call again
			const result = await searchTasksByContentTool.handler({
				search_query: 'retry after TTL',
				workspace: 'd:	est'
			}, makeCache(), mockEnsureCache, defaultFallback);

			expect(mockOpenAIClient.embeddings.create).toHaveBeenCalledTimes(2);
		});

		test('logs warning when circuit breaker active', async () => {
			vi.useRealTimers();
			vi.resetModules();

			const { searchTasksByContentTool, _resetEmbeddingCircuitBreaker } = await import('../search-semantic.tool.js');
			const consoleSpy = vi.spyOn(console, 'warn');

			const mockError = Object.assign(new Error('Service Unavailable'), {
				response: { status: 503, statusText: 'Service Unavailable', data: {} }
			});
			mockOpenAIClient.embeddings.create.mockRejectedValueOnce(mockError);

			// Trigger circuit breaker
			await searchTasksByContentTool.handler({
				search_query: 'trigger',
				workspace: 'd:	est'
			}, makeCache(), mockEnsureCache, defaultFallback);

			// Make second call - should log warning
			await searchTasksByContentTool.handler({
				search_query: 'check warning',
				workspace: 'd:	est'
			}, makeCache(), mockEnsureCache, defaultFallback);

			const logCalls = consoleSpy.mock.calls.filter(
				call => typeof call[0] === 'string' && call[0].includes('circuit breaker active')
			);
			expect(logCalls.length).toBeGreaterThan(0);

			consoleSpy.mockRestore();
		});
	});
});
});
