/**
 * Tests for search-codebase.tool.ts
 * Issue #492 - Coverage for codebase search tool helpers
 *
 * @module tools/search/__tests__/search-codebase.tool
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetQdrantClient, mockQdrant, mockEmbeddingCreate, mockExistsSync, mockReaddirSync } = vi.hoisted(() => ({
	mockGetQdrantClient: vi.fn(),
	mockQdrant: { getCollection: vi.fn(), query: vi.fn(), getCollections: vi.fn(), scroll: vi.fn() },
	mockEmbeddingCreate: vi.fn(),
	// #2609/#2554: mock existsSync so dead-path filtering is deterministic.
	// Default true = all files reachable (preserves existing test expectations).
	mockExistsSync: vi.fn(() => true),
	// #2609/#2554 L1: mock readdirSync so content-based collection matching is deterministic.
	// Default: empty array = no workspace dirs = content-match skipped. Individual tests override.
	mockReaddirSync: vi.fn(() => [])
}));

vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return { ...actual, existsSync: mockExistsSync, readdirSync: mockReaddirSync };
});

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
	findCollectionByContent,
	codebaseSearchTool,
	handleCodebaseSearch
} from '../search-codebase.tool.js';

describe('search-codebase.tool', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetQdrantClient.mockReturnValue(mockQdrant);
		// Default: all files reachable. Individual tests override to simulate dead paths.
		mockExistsSync.mockReturnValue(true);
	});

	// ============================================================
	// Tool definition
	// ============================================================

	describe('codebaseSearchTool', () => {
		test('has correct name', () => {
			expect(codebaseSearchTool.name).toBe('codebase_search');
		});

		test('requires only query field (workspace auto-detected)', () => {
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

			test('returns empty array on a non-network error', async () => {
				mockQdrant.getCollections.mockRejectedValue(new Error('connection failed'));
				const collections = await listWorkspaceCollections();
				expect(collections).toEqual([]);
			});

			// #2636: a network/TLS failure (Qdrant outage) must propagate so the codebase_search
			// outer catch classifies it as qdrant_unreachable, instead of being swallowed into []
			// (which the caller reports as collection_not_found — masking the outage).
			test('rethrows network errors so a Qdrant outage reaches the classifier (#2636)', async () => {
				mockQdrant.getCollections.mockRejectedValue(
					Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' })
				);
				await expect(listWorkspaceCollections()).rejects.toThrow();
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

			test('returns collection_not_found with diagnostic info when no hash variant matches (#2455)', async () => {
				// #2455: Phase B no longer blindly selects the first ws-* collection.
				// It returns diagnostic info instead, preventing wrong-workspace results.
				mockQdrant.getCollection.mockImplementation(async (name: string) => {
					if (name === 'ws-fallbackcollection') {
						return { points_count: 5000, status: 'green' };
					}
					throw new Error('not found');
				});

				// Phase B: listCollections returns a ws-* collection (unrelated to workspace)
				mockQdrant.getCollections.mockResolvedValue({
					collections: [{ name: 'ws-fallbackcollection' }]
				});

				const result = await handleCodebaseSearch({ query: 'app', workspace: '/ws' });
				const parsed = JSON.parse(result.content[0].text);
				// Phase B now returns diagnostic info, NOT results from unrelated collection
				expect(parsed.status).toBe('collection_not_found');
				expect(parsed.fallback_list_tried).toBe(true);
				expect(parsed.existing_collections).toBeDefined();
				expect(parsed.troubleshooting).toBeDefined();
				expect(parsed.primary_hash).toMatch(/^ws-[a-f0-9]{16}$/);
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
		test('handles empty workspace gracefully (resolves it or returns workspace-required guidance)', async () => {
			const result = await handleCodebaseSearch({ query: 'test', workspace: '' });
			const text = typeof result.content[0].text === 'string' ? result.content[0].text : '';
			// #2307 Phase 4: when the workspace cannot be auto-detected (no MCP roots, no WORKSPACE_PATH),
			// the tool hard-fails with clear guidance instead of silently searching the MCP server dir.
			// Depending on the environment it may instead resolve and return a JSON payload — accept
			// both outcomes, but the tool must never crash on an empty workspace.
			try {
				const parsed = JSON.parse(text);
				expect(parsed.workspace || parsed.message || parsed.status).toBeDefined();
			} catch {
				expect((result as any).isError).toBe(true);
				expect(text.toLowerCase()).toContain('workspace');
			}
		});

		test('returns error for empty query', async () => {
			const result = await handleCodebaseSearch({ query: '', workspace: '/ws' });
			expect((result as any).isError).toBe(true);
			expect(result.content[0].text).toContain('query');
		});

		test('returns error for whitespace-only query', async () => {
			const result = await handleCodebaseSearch({ query: '   ', workspace: '/ws' });
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

		// #2636: a Qdrant *outage* in the variant loop must surface as qdrant_unreachable,
		// NOT be folded into collection_not_found (which masks an outage as a missing index
		// and steers callers toward a wrong "re-index" remediation).
		test('returns qdrant_unreachable when getCollection fails with a network error (#2636)', async () => {
			mockQdrant.getCollection.mockRejectedValue(
				Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' })
			);

			const result = await handleCodebaseSearch({
				query: 'test',
				workspace: '/ws'
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('qdrant_unreachable');
			expect((result as any).isError).toBe(true);
		});

		// #2636: a Qdrant outage reached via the listWorkspaceCollections() fallback
		// (variant loop sees genuine 404s, then getCollections() is down) must also
		// surface as qdrant_unreachable rather than collection_not_found.
		test('returns qdrant_unreachable when getCollections fails with a network error (#2636)', async () => {
			mockQdrant.getCollection.mockRejectedValue(new Error('Not found')); // genuine 404 per variant
			mockQdrant.getCollections.mockRejectedValue(
				Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6333'), { code: 'ECONNREFUSED' })
			);

			const result = await handleCodebaseSearch({
				query: 'test',
				workspace: '/ws'
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('qdrant_unreachable');
			expect((result as any).isError).toBe(true);
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

		test('returns success with marginal relevance (score 0.45)', async () => {
			mockQdrant.query.mockResolvedValue({
				points: [{
					score: 0.45,
					payload: { filePath: 'src/bar.ts', codeChunk: 'const x = 1;', startLine: 10, endLine: 10 }
				}]
			});

			const result = await handleCodebaseSearch({ query: 'x variable', workspace: '/ws' });
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('success');
			expect(parsed.results[0].relevance).toBe('marginal');
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

		// ============================================================
		// #2609/#2554 — dead-path post-filter (rename-GC gap mitigation)
		// ============================================================

		describe('handleCodebaseSearch - dead-path filtering (#2609/#2554)', () => {
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

			test('filters out hits whose filePath no longer exists on disk', async () => {
				// Simulate a renamed/archived doc: live hit + dead orphan (old path).
				// limit: 2 with 1 live + 1 dead → results_count=1 < limit=2 → the dead-path
				// filter shrank recall below the requested limit, so a partial-shrink warning
				// MUST be emitted (otherwise the caller gets no signal that recall was reduced).
				mockExistsSync.mockImplementation((p: string) =>
					String(p).endsWith('live-doc.ts')
				);
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.82, payload: { filePath: 'src/live-doc.ts', codeChunk: 'live code', startLine: 1, endLine: 5 } },
						{ score: 0.78, payload: { filePath: 'docs/archive/dead-doc.ts', codeChunk: 'orphan', startLine: 1, endLine: 2 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'doc', workspace: '/ws', limit: 2 });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.results_count).toBe(1);
				expect(parsed.results[0].file_path).toBe('src/live-doc.ts');
				expect(parsed.dead_paths_filtered).toBe(1);
				expect(parsed.warning).toMatch(/dead-path filter reduced recall/);
			});

			test('does NOT warn when dead paths exist but recall did not shrink below limit', async () => {
				// Distinguishing test (anti-faux-positif): limit: 1 with 1 live + 1 dead →
				// results_count=1 === limit=1 → recall was NOT shrunk below the limit, so no
				// warning must be emitted. Proves the warning is gated on the recall shrink,
				// not on the mere presence of dead paths.
				mockExistsSync.mockImplementation((p: string) =>
					String(p).endsWith('live-doc.ts')
				);
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.82, payload: { filePath: 'src/live-doc.ts', codeChunk: 'live code', startLine: 1, endLine: 5 } },
						{ score: 0.78, payload: { filePath: 'docs/archive/dead-doc.ts', codeChunk: 'orphan', startLine: 1, endLine: 2 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'doc', workspace: '/ws', limit: 1 });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.results_count).toBe(1);
				expect(parsed.dead_paths_filtered).toBe(1);
				expect(parsed.warning).toBeUndefined();
			});

			test('returns raw hits with warning when ALL paths are dead (degenerate workspace root)', async () => {
				// Every filePath unreachable → likely wrong workspace root or unmounted drive.
				// Don't silently return 0; surface the raw hits + warning instead.
				mockExistsSync.mockReturnValue(false);
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.8, payload: { filePath: 'src/a.ts', codeChunk: 'a', startLine: 1, endLine: 1 } },
						{ score: 0.7, payload: { filePath: 'src/b.ts', codeChunk: 'b', startLine: 1, endLine: 1 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'x', workspace: '/wrong-ws' });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.results_count).toBe(2);
				expect(parsed.dead_paths_filtered).toBeUndefined();
				expect(parsed.warning).toMatch(/all hits resolved to dead paths/);
			});

			test('resolves relative filePath against the workspace root', async () => {
				// existsSync receives the joined absolute path: workspaceRoot + relative filePath.
				const seen: string[] = [];
				mockExistsSync.mockImplementation((p: string) => {
					seen.push(String(p));
					return true;
				});
				mockQdrant.query.mockResolvedValue({
					points: [{ score: 0.8, payload: { filePath: 'src/foo.ts', codeChunk: 'foo', startLine: 1, endLine: 1 } }]
				});

				await handleCodebaseSearch({ query: 'foo', workspace: '/my/ws' });
				// The joined path must contain both the workspace root and the relative filePath.
				expect(seen.some((p) => p.includes('my') && p.includes('foo.ts'))).toBe(true);
			});
		});

		// ============================================================
		// #2609/#2554 L1 — content-based collection matching (hash-mismatch fallback)
		// Root cause: the workspace path hash is fragile cross-agent; when no hash variant
		// matches, the right ws-* collection is identified by its indexed top-level dirs vs
		// the workspace's actual directory structure on disk.
		// ============================================================

		describe('handleCodebaseSearch - content-based collection matching (#2609/#2554 L1)', () => {
			beforeEach(() => {
				process.env.EMBEDDING_API_KEY = 'test-key';
				mockEmbeddingCreate.mockResolvedValue({
					data: [{ embedding: new Array(8).fill(0.1) }]
				});
			});

			afterEach(() => {
				delete process.env.EMBEDDING_API_KEY;
			});

			test('hash miss + strict content-match found → serves results with collection_resolved_by=content-match', async () => {
				// Workspace signature: real dirs on disk, incl. discriminant 'roo-code' + 'mcps'.
				mockReaddirSync.mockReturnValue([
					{ name: 'roo-code', isDirectory: () => true },
					{ name: 'mcps', isDirectory: () => true },
					{ name: 'roo-config', isDirectory: () => true },
					{ name: 'docs', isDirectory: () => true },
					{ name: 'a-file.txt', isDirectory: () => false }
				]);
				mockQdrant.getCollections.mockResolvedValue({
					collections: [{ name: 'ws-contentmatched' }, { name: 'ws-unrelated' }]
				});
				mockQdrant.getCollection.mockImplementation(async (name: string) => {
					if (name === 'ws-contentmatched') return { points_count: 9000, status: 'green' };
					if (name === 'ws-unrelated') return { points_count: 100, status: 'green' };
					throw new Error('not found');
				});
				mockQdrant.scroll.mockImplementation(async (name: string) => {
					if (name === 'ws-contentmatched') {
						// A real collection indexes many top-level dirs. Signature should overlap
						// strongly with the workspace dirs (roo-code, mcps, roo-config, docs).
						return { points: [
							{ payload: { pathSegments: { '0': 'mcps' } } },
							{ payload: { pathSegments: { '0': 'roo-code' } } },
							{ payload: { pathSegments: { '0': 'roo-config' } } },
							{ payload: { pathSegments: { '0': 'docs' } } },
							{ payload: { pathSegments: { '0': 'mcps' } } }
						] };
					}
					return { points: Array.from({ length: 5 }, () => ({
						payload: { pathSegments: { '0': 'src', '1': 'lib' } }
					})) };
				});
				mockQdrant.query.mockResolvedValue({
					points: [{
						score: 0.82,
						payload: { filePath: 'mcps/internal/foo.ts', codeChunk: 'export const foo = 1', startLine: 1, endLine: 2 }
					}]
				});

				const result = await handleCodebaseSearch({ query: 'foo', workspace: '/roo-ext' });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				expect(parsed.collection).toBe('ws-contentmatched');
				expect(parsed.collection_resolved_by).toBe('content-match');
				expect(parsed.content_match.jaccard).toBeGreaterThanOrEqual(0.6);
				expect(parsed.results[0].file_path).toBe('mcps/internal/foo.ts');
			});

			test('hash miss + 0 strict content-match → honest diagnostic with collection_signatures', async () => {
				// Workspace dirs all generic → no discriminant possible → strict gate fails.
				mockReaddirSync.mockReturnValue([
					{ name: 'src', isDirectory: () => true },
					{ name: 'docs', isDirectory: () => true },
					{ name: 'tests', isDirectory: () => true }
				]);
				mockQdrant.getCollections.mockResolvedValue({
					collections: [{ name: 'ws-someone' }]
				});
				// Force hash miss: getCollection throws for hash variants, succeeds only for the real candidate.
				mockQdrant.getCollection.mockImplementation(async (name: string) => {
					if (name === 'ws-someone') return { points_count: 500, status: 'green' };
					throw new Error('not found');
				});
				mockQdrant.scroll.mockResolvedValue({
					points: [{ payload: { pathSegments: { '0': 'src' } } }]
				});

				const result = await handleCodebaseSearch({ query: 'x', workspace: '/generic-ws' });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('collection_not_found');
				expect(parsed.content_match_attempted).toBe(true);
				expect(parsed.collection_signatures).toBeDefined();
				// Discriminant gate: src/docs/tests all generic → must NOT serve a query.
				expect(mockQdrant.query).not.toHaveBeenCalled();
			});

			test('hash miss + readdir fails (workspace unmounted) → skip content-match, no crash', async () => {
				mockReaddirSync.mockImplementation(() => { throw new Error('ENOENT'); });
				mockQdrant.getCollections.mockResolvedValue({
					collections: [{ name: 'ws-anything' }]
				});
				// Force hash miss: getCollection throws for hash variants, succeeds only for the real candidate.
				mockQdrant.getCollection.mockImplementation(async (name: string) => {
					if (name === 'ws-anything') return { points_count: 50, status: 'green' };
					throw new Error('not found');
				});

				const result = await handleCodebaseSearch({ query: 'x', workspace: '/unmounted' });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('collection_not_found');
				expect(parsed.workspace_signature).toBeNull();
				expect(mockQdrant.scroll).not.toHaveBeenCalled();
			});

			test('hash miss + multiple candidates → strict match picks highest Jaccard, rejects low-overlap', async () => {
				mockReaddirSync.mockReturnValue([
					{ name: 'roo-code', isDirectory: () => true },
					{ name: 'mcps', isDirectory: () => true },
					{ name: 'docs', isDirectory: () => true }
				]);
				mockQdrant.getCollections.mockResolvedValue({
					collections: [{ name: 'ws-high' }, { name: 'ws-low' }]
				});
				mockQdrant.getCollection.mockImplementation(async (name: string) => {
					if (name === 'ws-high') return { points_count: 8000, status: 'green' };
					if (name === 'ws-low') return { points_count: 200, status: 'green' };
					throw new Error('not found');
				});
				mockQdrant.scroll.mockImplementation(async (name: string) => {
					if (name === 'ws-high') {
						return { points: [
							{ payload: { pathSegments: { '0': 'roo-code' } } },
							{ payload: { pathSegments: { '0': 'mcps' } } }
						] };
					}
					return { points: [{ payload: { pathSegments: { '0': 'docs' } } }] };
				});
				mockQdrant.query.mockResolvedValue({
					points: [{ score: 0.7, payload: { filePath: 'roo-code/x.ts', codeChunk: 'x', startLine: 1, endLine: 1 } }]
				});

				const result = await handleCodebaseSearch({ query: 'x', workspace: '/multi-ws' });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				expect(parsed.collection).toBe('ws-high');
				expect(parsed.collection_resolved_by).toBe('content-match');
				expect(parsed.collection).not.toBe('ws-low');
			});

			test('hash miss + discriminant dir is a minority in the sample → still matches (large-sample hardening)', async () => {
				// web1 observation: scroll is insertion-ordered; a small biased sample could
				// hide a discriminant dir. The 200-pt sample + Set union must capture the
				// discriminant dir even if it appears rarely among the sampled points.
				mockReaddirSync.mockReturnValue([
					{ name: 'roo-code', isDirectory: () => true },
					{ name: 'mcps', isDirectory: () => true },
					{ name: 'docs', isDirectory: () => true }
				]);
				mockQdrant.getCollections.mockResolvedValue({
					collections: [{ name: 'ws-biased' }]
				});
				mockQdrant.getCollection.mockImplementation(async (name: string) => {
					if (name === 'ws-biased') return { points_count: 50000, status: 'green' };
					throw new Error('not found');
				});
				// The sample is heavily dominated by 'docs' (generic) but contains a few
				// 'mcps' + 'roo-code' (discriminant) points. The signature must include them.
				const biasedSample = [
					...Array.from({ length: 40 }, () => ({ payload: { pathSegments: { '0': 'docs' } } })),
					{ payload: { pathSegments: { '0': 'mcps' } } },
					{ payload: { pathSegments: { '0': 'roo-code' } } }
				];
				mockQdrant.scroll.mockResolvedValue({ points: biasedSample });
				mockQdrant.query.mockResolvedValue({
					points: [{ score: 0.75, payload: { filePath: 'roo-code/y.ts', codeChunk: 'y', startLine: 1, endLine: 1 } }]
				});

				const result = await handleCodebaseSearch({ query: 'y', workspace: '/biased-ws' });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				expect(parsed.collection).toBe('ws-biased');
				expect(parsed.collection_resolved_by).toBe('content-match');
			});

			// ─── Follow-up to #644: blind-spot "collection exists but is EMPTY" ─────────
			// Convergent finding (web1 c.N+4 + po-2026 c.46): the hash resolves to a real
			// collection that was never populated (points_count == 0). Phase B must trigger
			// in this sub-case too, not only when no hash variant matches at all.
			test('hash matches an EMPTY collection (points_count=0) → content-match fallback finds the populated one', async () => {
				mockReaddirSync.mockReturnValue([
					{ name: 'roo-code', isDirectory: () => true },
					{ name: 'mcps', isDirectory: () => true },
					{ name: 'roo-config', isDirectory: () => true },
					{ name: 'docs', isDirectory: () => true }
				]);
				// Compute the REAL hash variant for this workspace so the hash loop actually
				// matches it — this is what reproduces the blind-spot (a hash that resolves
				// to an existing-but-empty collection). Without this, the test would only
				// exercise the generic hash-miss path, not the empty-collection sub-case.
				const emptyCollectionName = getWorkspaceCollectionVariants('/empty-hash-ws')[0];
				mockQdrant.getCollections.mockResolvedValue({
					collections: [
						{ name: emptyCollectionName },
						{ name: 'ws-populated' }
					]
				});
				mockQdrant.getCollection.mockImplementation(async (name: string) => {
					if (name === emptyCollectionName) return { points_count: 0, status: 'green' };
					if (name === 'ws-populated') return { points_count: 446000, status: 'green' };
					throw new Error('not found');
				});
				mockQdrant.scroll.mockImplementation(async (name: string) => {
					if (name === 'ws-populated') {
						return { points: [
							{ payload: { pathSegments: { '0': 'mcps' } } },
							{ payload: { pathSegments: { '0': 'roo-code' } } },
							{ payload: { pathSegments: { '0': 'roo-config' } } },
							{ payload: { pathSegments: { '0': 'docs' } } }
						] };
					}
					// Empty collection → scroll returns no points.
					return { points: [] };
				});
				mockQdrant.query.mockResolvedValue({
					points: [{ score: 0.8, payload: { filePath: 'mcps/internal/bar.ts', codeChunk: 'export const bar = 2', startLine: 1, endLine: 2 } }]
				});

				const result = await handleCodebaseSearch({ query: 'bar', workspace: '/empty-hash-ws' });
				const parsed = JSON.parse(result.content[0].text);
				// Must serve the populated collection, NOT return 0 results on the empty one.
				expect(parsed.status).toBe('success');
				expect(parsed.collection).toBe('ws-populated');
				expect(parsed.collection_resolved_by).toBe('content-match');
				expect(parsed.results[0].file_path).toBe('mcps/internal/bar.ts');
			});

			test('hash matches an EMPTY collection + no strict content-match → diagnostic with hash_matched_empty=true', async () => {
				// Same blind-spot trigger, but no candidate collection matches by content
				// → honest diagnostic must report hash_matched_empty=true so the caller
				// understands the empty-collection nuance (not just "collection not found").
				mockReaddirSync.mockReturnValue([
					{ name: 'roo-code', isDirectory: () => true },
					{ name: 'mcps', isDirectory: () => true }
				]);
				const emptyCollectionName = getWorkspaceCollectionVariants('/empty-hash-ws2')[0];
				mockQdrant.getCollections.mockResolvedValue({
					collections: [
						{ name: emptyCollectionName },
						{ name: 'ws-unrelated' }
					]
				});
				mockQdrant.getCollection.mockImplementation(async (name: string) => {
					if (name === emptyCollectionName) return { points_count: 0, status: 'green' };
					if (name === 'ws-unrelated') return { points_count: 100, status: 'green' };
					throw new Error('not found');
				});
				// The only non-empty candidate has unrelated dirs → strict gate fails.
				mockQdrant.scroll.mockResolvedValue({
					points: [{ payload: { pathSegments: { '0': 'wp-content' } } }]
				});

				const result = await handleCodebaseSearch({ query: 'x', workspace: '/empty-hash-ws2' });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('collection_not_found');
				expect(parsed.hash_matched_empty).toBe(true);
				expect(parsed.content_match_attempted).toBe(true);
			});
		});
	});

	// ============================================================
	// findCollectionByContent — overlap-coefficient fallback (#2554 / Epic #2766)
	// Regression: symmetric Jaccard collapses on "inflated" workspaces that accumulated
	// many top-level dirs the indexer never touched. The indexed dirs are still a clean
	// SUBSET of the workspace, so the overlap coefficient (containment) must accept the
	// match that Jaccard-0.226 rejected. Encodes the exact live ai-01 case.
	// ============================================================

	describe('findCollectionByContent - overlap-coefficient fallback (#2554)', () => {
		test('accepts the real roo-extensions collection that symmetric Jaccard (0.226) rejects', async () => {
			// Live ai-01 workspace signature: 30 top-level dirs, most never indexed
			// (build/temp/logs/node_modules/exports/outputs/profiles/backups/.tmp/...).
			const workspaceSignature = new Set([
				'.claude', '.git', '.github', '.playwright-mcp', '.roo', '.shared-state',
				'.temp', '.tmp', '.vscode', 'archive', 'backups', 'demo-roo-code', 'docker',
				'docs', 'exports', 'logs', 'mcps', 'modules', 'node_modules', 'outputs',
				'profiles', 'roo-code', 'roo-code-customization', 'roo-config',
				'scheduled-tasks', 'scripts', 'temp', 'tests', 'zoo-code', '_archives'
			]);

			// The real index ws-59e7574de63c6e62 (446531 pts) indexed only 8 top-level dirs.
			//   intersection = 7 (mcps, docs, archive, roo-code, demo-roo-code, roo-config, scripts)
			//   union = 31 → Jaccard = 7/31 = 0.226 < 0.6 (would be REJECTED by the old gate)
			//   overlap = 7 / min(30, 8) = 0.875 ≥ 0.6 (ACCEPTED via the containment path)
			//   shared discriminant dirs = mcps, archive, roo-code, demo-roo-code, roo-config = 5 (≥2)
			mockQdrant.scroll.mockImplementation(async (name: string) => {
				if (name === 'ws-59e7574de63c6e62') {
					return { points: [
						{ payload: { pathSegments: { '0': 'mcps' } } },
						{ payload: { pathSegments: { '0': 'docs' } } },
						{ payload: { pathSegments: { '0': 'archive' } } },
						{ payload: { pathSegments: { '0': 'roo-code' } } },
						{ payload: { pathSegments: { '0': 'demo-roo-code' } } },
						{ payload: { pathSegments: { '0': 'roo-config' } } },
						{ payload: { pathSegments: { '0': 'scripts' } } },
						{ payload: { pathSegments: { '0': 'demo-quickfiles' } } }
					] };
				}
				return { points: [] };
			});

			const match = await findCollectionByContent(
				mockQdrant,
				['ws-59e7574de63c6e62'],
				workspaceSignature
			);

			expect(match).not.toBeNull();
			expect(match!.name).toBe('ws-59e7574de63c6e62');
			// Jaccard is below the strict threshold (0.6) — proves the overlap path, not
			// Jaccard, served the collection. (7/31 ≈ 0.226.)
			expect(match!.jaccard).toBeLessThan(0.6);
			expect(match!.overlap).toBeGreaterThanOrEqual(0.6);
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

		test('returns qdrant_unreachable on fetch failed', async () => {
			mockEmbeddingCreate.mockRejectedValue(new Error('fetch failed: connection refused'));

			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect((result as any).isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('qdrant_unreachable');
			expect(parsed.hint).toBeDefined();
		});

		test('returns qdrant_unreachable on ECONNREFUSED', async () => {
			mockEmbeddingCreate.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6333'));

			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect((result as any).isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('qdrant_unreachable');
		});

		test('returns auth_failed on API key error', async () => {
			mockEmbeddingCreate.mockRejectedValue(new Error('API key not valid'));

			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect((result as any).isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('auth_failed');
			expect(parsed.hint).toBeDefined();
		});

		test('returns auth_failed on Unauthorized', async () => {
			mockEmbeddingCreate.mockRejectedValue(new Error('Unauthorized: 401'));

			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect((result as any).isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('auth_failed');
		});

		test('returns generic error on unexpected exception', async () => {
			mockEmbeddingCreate.mockRejectedValue(new Error('Unexpected internal error'));

			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect((result as any).isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('unknown');
			expect(parsed.error).toContain('Unexpected internal error');
		});

		test('handles non-Error thrown values', async () => {
			mockEmbeddingCreate.mockRejectedValue('string error');

			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect((result as any).isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('unknown');
			expect(parsed.error).toBe('string error');
		});
	});
});
