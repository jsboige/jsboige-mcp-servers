/**
 * Tests for search-codebase.tool.ts
 * Issue #492 - Coverage for codebase search tool helpers
 *
 * @module tools/search/__tests__/search-codebase.tool
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetQdrantClient, mockQdrant, mockEmbeddingCreate } = vi.hoisted(() => ({
	mockGetQdrantClient: vi.fn(),
	mockQdrant: { getCollection: vi.fn(), query: vi.fn(), getCollections: vi.fn() },
	mockEmbeddingCreate: vi.fn()
}));

vi.mock('../../../services/qdrant.js', () => ({
	getQdrantClient: mockGetQdrantClient
}));

vi.mock('openai', () => ({
	default: vi.fn(() => ({
		embeddings: { create: mockEmbeddingCreate }
	}))
}));

import {
	getWorkspaceCollectionName,
	getWorkspaceCollectionVariants,
	listWorkspaceCollections,
	codebaseSearchTool,
	handleCodebaseSearch
} from '../search-codebase.tool.js';

describe('search-codebase.tool', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetQdrantClient.mockReturnValue(mockQdrant);
	});

	// ============================================================
	// Tool definition
	// ============================================================

	describe('codebaseSearchTool', () => {
		test('has correct name', () => {
			expect(codebaseSearchTool.name).toBe('codebase_search');
		});

		test('requires query field', () => {
			expect(codebaseSearchTool.inputSchema.required).toEqual(['query']);
		});

		test('has workspace property', () => {
			const props = codebaseSearchTool.inputSchema.properties as any;
			expect(props.workspace.type).toBe('string');
		});

		test('has limit property', () => {
			const props = codebaseSearchTool.inputSchema.properties as any;
			expect(props.limit.type).toBe('number');
		});

		test('has min_score property', () => {
			const props = codebaseSearchTool.inputSchema.properties as any;
			expect(props.min_score.type).toBe('number');
		});
	});

	// ============================================================
	// getWorkspaceCollectionName
	// ============================================================

	describe('getWorkspaceCollectionName', () => {
		test('returns ws- prefixed hash', () => {
			const name = getWorkspaceCollectionName('/home/user/project');
			expect(name).toMatch(/^ws-[a-f0-9]{16}$/);
		});

		test('produces deterministic output', () => {
			const a = getWorkspaceCollectionName('/path/to/workspace');
			const b = getWorkspaceCollectionName('/path/to/workspace');
			expect(a).toBe(b);
		});

		test('different paths produce different names', () => {
			const a = getWorkspaceCollectionName('/path/a');
			const b = getWorkspaceCollectionName('/path/b');
			expect(a).not.toBe(b);
		});

		test('strips trailing slash', () => {
			const withSlash = getWorkspaceCollectionName('/path/to/dir/');
			const withoutSlash = getWorkspaceCollectionName('/path/to/dir');
			expect(withSlash).toBe(withoutSlash);
		});

		test('handles Windows paths with backslashes', () => {
			const name = getWorkspaceCollectionName('C:\\Users\\MYIA\\project');
			expect(name).toMatch(/^ws-[a-f0-9]{16}$/);
		});

		test('cleans double-escaped backslashes', () => {
			const doubleEscaped = getWorkspaceCollectionName('C:\\\\Users\\\\MYIA');
			const singleEscaped = getWorkspaceCollectionName('C:\\Users\\MYIA');
			expect(doubleEscaped).toBe(singleEscaped);
		});
	});

	// ============================================================
	// getWorkspaceCollectionVariants
	// ============================================================

	describe('getWorkspaceCollectionVariants', () => {
		test('returns array of ws- prefixed names', () => {
			const variants = getWorkspaceCollectionVariants('/path/to/workspace');
			expect(variants.length).toBeGreaterThan(0);
			for (const v of variants) {
				expect(v).toMatch(/^ws-[a-f0-9]{16}$/);
			}
		});

		test('includes original path variant', () => {
			const name = getWorkspaceCollectionName('/path/to/workspace');
			const variants = getWorkspaceCollectionVariants('/path/to/workspace');
			expect(variants).toContain(name);
		});

		test('Windows path generates multiple variants', () => {
			const variants = getWorkspaceCollectionVariants('D:\\Roo-Extensions');
			// Should have variants for: original, lowercase, forward slashes, etc.
			expect(variants.length).toBeGreaterThanOrEqual(2);
		});

		test('all variants are unique', () => {
			const variants = getWorkspaceCollectionVariants('C:\\Users\\MYIA\\project');
			const unique = new Set(variants);
			expect(unique.size).toBe(variants.length);
		});

		test('Unix path generates fewer variants (no case changes)', () => {
			const unixVariants = getWorkspaceCollectionVariants('/home/user/project');
			const winVariants = getWorkspaceCollectionVariants('C:\\Users\\MYIA\\Project');
			// Windows paths should have more variants due to case and separator differences
			expect(winVariants.length).toBeGreaterThanOrEqual(unixVariants.length);
		});
	});

		// ============================================================
		// listWorkspaceCollections
		// ============================================================

		describe('listWorkspaceCollections', () => {
			test('returns ws-* collection names', async () => {
				mockQdrant.getCollections.mockResolvedValue({
					collections: [
						{ name: 'ws-abc123' },
						{ name: 'ws-def456' },
						{ name: 'roo_tasks_semantic_index' }
					]
				});

				const collections = await listWorkspaceCollections();
				expect(collections).toEqual(['ws-abc123', 'ws-def456']);
			});

			test('returns empty array on error', async () => {
				mockQdrant.getCollections.mockRejectedValue(new Error('connection failed'));
				const collections = await listWorkspaceCollections();
				expect(collections).toEqual([]);
			});

			test('returns empty array when no ws-* collections exist', async () => {
				mockQdrant.getCollections.mockResolvedValue({
					collections: [{ name: 'roo_tasks_semantic_index' }]
				});
				const collections = await listWorkspaceCollections();
				expect(collections).toEqual([]);
			});
		});

		// ============================================================
		// handleCodebaseSearch - Phase B fallback (#1085)
		// ============================================================

		describe('handleCodebaseSearch - Phase B fallback', () => {
			beforeEach(() => {
				process.env.EMBEDDING_API_KEY = 'test-key';
			});

			afterEach(() => {
				delete process.env.EMBEDDING_API_KEY;
			});

			test('falls back to listWorkspaceCollections when no hash variant matches', async () => {
				// Phase A: all hash variants fail (getCollection rejects for non-fallback names)
				// Phase B: getCollection succeeds for ws-fallbackcollection
				mockQdrant.getCollection.mockImplementation(async (name: string) => {
					if (name === 'ws-fallbackcollection') {
						return { points_count: 5000 };
					}
					throw new Error('not found');
				});

				// Phase B: listCollections returns a ws-* collection
				mockQdrant.getCollections.mockResolvedValue({
					collections: [{ name: 'ws-fallbackcollection' }]
				});

				// Embedding + search succeed
				mockEmbeddingCreate.mockResolvedValue({
					data: [{ embedding: new Array(8).fill(0.1) }]
				});
				mockQdrant.query.mockResolvedValue({
					points: [{
						score: 0.85,
						payload: { filePath: 'src/app.ts', codeChunk: 'const x = 1;', startLine: 1, endLine: 5 }
					}]
				});

				const result = await handleCodebaseSearch({ query: 'app', workspace: '/ws' });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				expect(parsed.collection).toBe('ws-fallbackcollection');
				expect(mockQdrant.getCollections).toHaveBeenCalled();
			});

			test('returns collection_not_found with fallback_list_tried when both phases fail', async () => {
				// Phase A: all hash variants fail
				mockQdrant.getCollection.mockRejectedValue(new Error('not found'));

				// Phase B: no ws-* collections exist
				mockQdrant.getCollections.mockResolvedValue({
					collections: [{ name: 'roo_tasks_semantic_index' }]
				});

				const result = await handleCodebaseSearch({ query: 'test', workspace: '/fake' });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('collection_not_found');
				expect(parsed.fallback_list_tried).toBe(true);
			});
		});

	// ============================================================
	// handleCodebaseSearch - validation
	// ============================================================

	describe('handleCodebaseSearch', () => {
		test('returns error for empty query', async () => {
			const result = await handleCodebaseSearch({ query: '' });
			expect((result as any).isError).toBe(true);
			expect(result.content[0].text).toContain('query');
		});

		test('returns error for whitespace-only query', async () => {
			const result = await handleCodebaseSearch({ query: '   ' });
			expect((result as any).isError).toBe(true);
		});

		test('returns collection_not_found when no collection exists', async () => {
			mockQdrant.getCollection.mockRejectedValue(new Error('Not found'));

			const result = await handleCodebaseSearch({
				query: 'test search',
				workspace: '/fake/workspace'
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('collection_not_found');
			expect(parsed.workspace).toBe('/fake/workspace');
		});

		test('returns collection_not_found when getCollection rejects', async () => {
			// All variant attempts reject, so it's treated as "not found"
			mockQdrant.getCollection.mockRejectedValue(new Error('fetch failed'));

			const result = await handleCodebaseSearch({
				query: 'test',
				workspace: '/ws'
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('collection_not_found');
			expect(parsed.tried_collections.length).toBeGreaterThan(0);
		});
	});

	// ============================================================
	// handleCodebaseSearch - successful search (interpretScore branches)
	// ============================================================

	describe('handleCodebaseSearch - successful search', () => {
		beforeEach(() => {
			process.env.EMBEDDING_API_KEY = 'test-key';
			mockQdrant.getCollection.mockResolvedValue({ status: 'green' });
			mockEmbeddingCreate.mockResolvedValue({
				data: [{ embedding: new Array(8).fill(0.1) }]
			});
		});

		afterEach(() => {
			delete process.env.EMBEDDING_API_KEY;
		});

		test('returns success with moderate relevance (score 0.65)', async () => {
			mockQdrant.query.mockResolvedValue({
				points: [{
					score: 0.65,
					payload: { filePath: 'src/foo.ts', codeChunk: 'export function foo() {}', startLine: 1, endLine: 5 }
				}]
			});

			const result = await handleCodebaseSearch({ query: 'foo function', workspace: '/ws' });
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('success');
			expect(parsed.results[0].relevance).toBe('moderate');
			expect(parsed.results[0].score).toBe(0.65);
		});

		test('returns success with weak relevance (score 0.45)', async () => {
			mockQdrant.query.mockResolvedValue({
				points: [{
					score: 0.45,
					payload: { filePath: 'src/bar.ts', codeChunk: 'const x = 1;', startLine: 10, endLine: 10 }
				}]
			});

			const result = await handleCodebaseSearch({ query: 'x variable', workspace: '/ws' });
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('success');
			expect(parsed.results[0].relevance).toBe('weak');
		});

		test('returns success with marginal relevance (score 0.3)', async () => {
			mockQdrant.query.mockResolvedValue({
				points: [{
					score: 0.3,
					payload: { filePath: 'src/baz.ts', codeChunk: 'let z;', startLine: 1, endLine: 1 }
				}]
			});

			const result = await handleCodebaseSearch({ query: 'z', workspace: '/ws' });
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('success');
			expect(parsed.results[0].relevance).toBe('marginal');
		});

		test('filters out results without filePath or codeChunk', async () => {
			mockQdrant.query.mockResolvedValue({
				points: [
					{ score: 0.8, payload: { filePath: 'src/valid.ts', codeChunk: 'valid code' } },
					{ score: 0.7, payload: { filePath: '', codeChunk: 'no path' } },
					{ score: 0.6, payload: null }
				]
			});

			const result = await handleCodebaseSearch({ query: 'valid', workspace: '/ws' });
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.results_count).toBe(1);
			expect(parsed.results[0].file_path).toBe('src/valid.ts');
		});

		test('applies directory_prefix filter', async () => {
			mockQdrant.query.mockResolvedValue({ points: [] });

			const result = await handleCodebaseSearch({
				query: 'search',
				workspace: '/ws',
				directory_prefix: 'src/tools'
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('success');
			expect(parsed.results_count).toBe(0);
			// Verify qdrant.query was called (directory filter applied)
			expect(mockQdrant.query).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					filter: expect.objectContaining({ must: expect.any(Array) })
				})
			);
		});
	});

	// ============================================================
	// handleCodebaseSearch - outer catch block (embedding errors)
	// ============================================================

	describe('handleCodebaseSearch - embedding error handling', () => {
		beforeEach(() => {
			process.env.EMBEDDING_API_KEY = 'test-key';
			// Collection found successfully
			mockQdrant.getCollection.mockResolvedValue({ status: 'green' });
		});

		afterEach(() => {
			delete process.env.EMBEDDING_API_KEY;
		});

		test('returns qdrant_connection_error on fetch failed', async () => {
			mockEmbeddingCreate.mockRejectedValue(new Error('fetch failed: connection refused'));

			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect((result as any).isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('qdrant_connection_error');
			expect(parsed.hint).toContain('Qdrant');
		});

		test('returns qdrant_connection_error on ECONNREFUSED', async () => {
			mockEmbeddingCreate.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6333'));

			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect((result as any).isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('qdrant_connection_error');
		});

		test('returns auth_error on API key error', async () => {
			mockEmbeddingCreate.mockRejectedValue(new Error('API key not valid'));

			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect((result as any).isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('auth_error');
			expect(parsed.hint).toContain('API');
		});

		test('returns auth_error on Unauthorized', async () => {
			mockEmbeddingCreate.mockRejectedValue(new Error('Unauthorized: 401'));

			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect((result as any).isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('auth_error');
		});

		test('returns generic error on unexpected exception', async () => {
			mockEmbeddingCreate.mockRejectedValue(new Error('Unexpected internal error'));

			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect((result as any).isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('error');
			expect(parsed.error).toContain('Unexpected internal error');
		});

		test('handles non-Error thrown values', async () => {
			mockEmbeddingCreate.mockRejectedValue('string error');

			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect((result as any).isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('error');
			expect(parsed.error).toBe('string error');
		});
	});
});
