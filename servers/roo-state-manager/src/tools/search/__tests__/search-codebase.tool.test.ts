/**
 * Tests for search-codebase.tool.ts
 * Issue #492 - Coverage for codebase search tool helpers
 *
 * @module tools/search/__tests__/search-codebase.tool
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockGetQdrantClient, mockQdrant } = vi.hoisted(() => ({
	mockGetQdrantClient: vi.fn(),
	mockQdrant: { getCollection: vi.fn(), query: vi.fn() }
}));

vi.mock('../../../services/qdrant.js', () => ({
	getQdrantClient: mockGetQdrantClient
}));

import {
	getWorkspaceCollectionName,
	getWorkspaceCollectionVariants,
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
});
