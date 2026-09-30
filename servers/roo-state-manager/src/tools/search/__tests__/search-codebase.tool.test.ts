/**
 * Tests for search-codebase.tool.ts
 * Issue #492 - Coverage for codebase search tool helpers
 *
 * @module tools/search/__tests__/search-codebase.tool
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetQdrantClient, mockQdrant, mockEmbeddingCreate, mockExistsSync, mockReaddirSync, mockReadFileSync, mockStatSync } = vi.hoisted(() => ({
	mockGetQdrantClient: vi.fn(),
	mockQdrant: { getCollection: vi.fn(), query: vi.fn(), getCollections: vi.fn(), scroll: vi.fn() },
	mockEmbeddingCreate: vi.fn(),
	// #2609/#2554: mock existsSync so dead-path filtering is deterministic.
	// Default true = all files reachable (preserves existing test expectations).
	mockExistsSync: vi.fn(() => true),
	// #2609/#2554 L1: mock readdirSync so content-based collection matching is deterministic.
	// Default: empty array = no workspace dirs = content-match skipped. Individual tests override.
	mockReaddirSync: vi.fn(() => []),
	// #2609 V2(a): mock readFileSync/statSync so block expansion is deterministic.
	// Defaults simulate an absent file (statSync throws ENOENT) → expansion safely
	// skips to the raw chunk snippet — the existing tests' expectations hold.
	mockReadFileSync: vi.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
	mockStatSync: vi.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); })
}));

vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		existsSync: mockExistsSync,
		readdirSync: mockReaddirSync,
		readFileSync: mockReadFileSync,
		statSync: mockStatSync
	};
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
	handleCodebaseSearch,
	resetCodebaseEmbeddingBreaker,
	resetCodebaseEmbeddingClient,
	computeBlockRange,
	verifyAnchor,
	renderBlock,
	expandHitBlock,
	evaluateCoverage,
	clearCoverageCache,
	getServedBuildId,
	dropOverlappingWindows
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

		test('drive-letter case convergence: d:\\ and D:\\ inputs generate the SAME variant set (mixed-case rest)', () => {
			// Fleet investigation 2026-09-12 (CoursIA-2 collection_not_found): an
			// uppercase-drive input never generated the lowercase-drive spellings
			// (rest preserved), so D:\ queries could not reach an index hashed under
			// d:\ when the path carries uppercase past the drive. The mirror branch
			// makes both inputs converge on one variant set.
			const upper = getWorkspaceCollectionVariants('D:\\dev\\CoursIA-2');
			const lower = getWorkspaceCollectionVariants('d:\\dev\\CoursIA-2');
			expect(new Set(upper)).toEqual(new Set(lower));
			expect(upper).toContain(getWorkspaceCollectionName('d:\\dev\\CoursIA-2'));
			expect(lower).toContain(getWorkspaceCollectionName('D:\\dev\\CoursIA-2'));
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
			// #3344: the classifier now probes /healthz to distinguish outage vs client
			// failure — stub the probe as dead so this test asserts the outage branch
			// deterministically (independent of a real Qdrant reachable from CI/dev).
			vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('probe refused')));
			try {
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
			} finally {
				vi.unstubAllGlobals();
			}
		});

		// #2636: a Qdrant outage reached via the listWorkspaceCollections() fallback
		// (variant loop sees genuine 404s, then getCollections() is down) must also
		// surface as qdrant_unreachable rather than collection_not_found.
		test('returns qdrant_unreachable when getCollections fails with a network error (#2636)', async () => {
			// #3344: stub the /healthz probe as dead — outage branch, deterministic.
			vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('probe refused')));
			try {
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
			} finally {
				vi.unstubAllGlobals();
			}
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
			// Explicit low min_score: this test exercises the relevance labeling at a sub-default
			// score (0.45 < DEFAULT_MIN_SCORE 0.5). Without it, the post-malus min_score filter
			// (re-applied on the adjusted score, PR #972) would drop the hit before labeling.
			mockQdrant.query.mockResolvedValue({
				points: [{
					score: 0.45,
					payload: { filePath: 'src/bar.ts', codeChunk: 'const x = 1;', startLine: 10, endLine: 10 }
				}]
			});

			const result = await handleCodebaseSearch({ query: 'x variable', workspace: '/ws', min_score: 0.2 });
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

			const result = await handleCodebaseSearch({ query: 'z', workspace: '/ws', min_score: 0.2 });
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
		// tests-rank-reranking (po-2024 c.194, GO ai-01 c.197) — test-files-rank-above-source re-ranking (malus B + diversification A)
		// text-embedding-3-small scores descriptive test titles higher than the source they
		// test (natural-language intent vs syntactic noise). Two post-retrieval correctives:
		// B = test-file malus (×0.95), A = per-file diversification cap (2 chunks/file) +
		// over-fetch so backfill has cross-file candidates to draw from.
		// ============================================================

		describe('handleCodebaseSearch - test-file re-ranking (tests-rank-reranking)', () => {
			test('B — source outranks a higher-scoring test file after the ×0.95 malus', async () => {
				// Raw cosine: test 0.72 > source 0.70 (the measured asymmetry). After malus the
				// test drops to 0.684 < 0.70 → the source must take rank 1, the test rank 2,
				// and the test's exposed score must be the adjusted value (not the raw 0.72).
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.72, payload: { filePath: 'src/__tests__/foo.test.ts', codeChunk: "test('should send message', () => {})", startLine: 1, endLine: 3 } },
						{ score: 0.70, payload: { filePath: 'src/services/foo.ts', codeChunk: 'export async function send(msg: Msg): Promise<void> {}', startLine: 10, endLine: 12 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'send message', workspace: '/ws' });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				expect(parsed.results[0].file_path).toBe('src/services/foo.ts');
				expect(parsed.results[1].file_path).toBe('src/__tests__/foo.test.ts');
				expect(parsed.results[1].score).toBeCloseTo(0.684, 5);
				expect(parsed.test_file_malus_applied).toBe(1);
			});

			test('A — per-file diversification caps a noisy file so a second file gets promoted', async () => {
				// A single source file would occupy all 3 slots (scores 0.80/0.79/0.78) and
				// evict bar.ts (0.77). The cap (2/file) frees the 3rd slot for bar.ts.
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.80, payload: { filePath: 'src/foo.ts', codeChunk: 'a', startLine: 1, endLine: 1 } },
						{ score: 0.79, payload: { filePath: 'src/foo.ts', codeChunk: 'b', startLine: 2, endLine: 2 } },
						{ score: 0.78, payload: { filePath: 'src/foo.ts', codeChunk: 'c', startLine: 3, endLine: 3 } },
						{ score: 0.77, payload: { filePath: 'src/bar.ts', codeChunk: 'd', startLine: 1, endLine: 1 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'foo bar', workspace: '/ws', limit: 3 });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				expect(parsed.results_count).toBe(3);
				const paths = parsed.results.map((r: any) => r.file_path);
				expect(paths).toContain('src/bar.ts');
				// foo.ts capped at 2 entries (not 3) — the 3rd foo chunk was demoted to a leftover.
				expect(paths.filter((p: string) => p === 'src/foo.ts').length).toBe(2);
			});

			test('non-test files are unaffected — score and order preserved (regression guard)', async () => {
				// Two source files: no malus, no cap effect. The exact raw scores must surface
				// and order by raw cosine. Guards against the malus firing on ordinary source
				// paths or the diversification reordering single-chunk files.
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.65, payload: { filePath: 'src/foo.ts', codeChunk: 'export function foo() {}', startLine: 1, endLine: 5 } },
						{ score: 0.60, payload: { filePath: 'src/bar.ts', codeChunk: 'export function bar() {}', startLine: 1, endLine: 5 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'functions', workspace: '/ws' });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.results[0].score).toBe(0.65);
				expect(parsed.results[1].score).toBe(0.60);
				expect(parsed.test_file_malus_applied).toBeUndefined();
			});

			test('test-file detection covers .spec. and Windows __tests__ separators', async () => {
				// The malus regex must catch all three conventions: __tests__/ dir, .test.,
				// and .spec. — on both POSIX and Windows separators. A missed form would let
				// that test variant keep ranking above source undegraded.
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.80, payload: { filePath: 'src\\__tests__\\widget.spec.ts', codeChunk: 'spec', startLine: 1, endLine: 1 } },
						{ score: 0.78, payload: { filePath: 'src/widget.ts', codeChunk: 'export class Widget {}', startLine: 1, endLine: 5 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'widget', workspace: '/ws' });
				const parsed = JSON.parse(result.content[0].text);
				// spec at 0.80 → malused to 0.76 < source 0.78 → source ranks first.
				expect(parsed.results[0].file_path).toBe('src/widget.ts');
				expect(parsed.test_file_malus_applied).toBe(1);
			});

			test('min_score is re-applied on the post-malus score — a borderline test hit is dropped', async () => {
				// Qdrant filters on the RAW score (score_threshold). A test file at raw 0.71
				// passes a 0.70 raw threshold, but the ×0.95 malus drops it to 0.6745 < 0.70.
				// Without re-applying min_score on the adjusted score, this hit would be returned
				// with score 0.6745 while the response announces min_score_used: 0.70 — a
				// self-contradiction (CHANGES_REQUESTED ai-01 on PR #972). The borderline test
				// must be ABSENT; a clear test (raw 0.80 → 0.76) and a source must remain, proving
				// the filter is surgical, not a blanket removal of test files.
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.71, payload: { filePath: 'src/__tests__/borderline.test.ts', codeChunk: "test('borderline', () => {})", startLine: 1, endLine: 3 } },
						{ score: 0.80, payload: { filePath: 'src/__tests__/clear.test.ts', codeChunk: "test('clear', () => {})", startLine: 1, endLine: 3 } },
						{ score: 0.72, payload: { filePath: 'src/services/foo.ts', codeChunk: 'export function foo() {}', startLine: 10, endLine: 12 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'foo', workspace: '/ws', min_score: 0.70 });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				expect(parsed.min_score_used).toBe(0.70);
				const paths = parsed.results.map((r: any) => r.file_path);
				// The borderline test (raw 0.71 → 0.6745) falls below the announced threshold → absent.
				expect(paths).not.toContain('src/__tests__/borderline.test.ts');
				// The clear test (raw 0.80 → 0.76) and the source survive the threshold.
				expect(paths).toContain('src/__tests__/clear.test.ts');
				expect(paths).toContain('src/services/foo.ts');
				// Invariant: no returned result contradicts its own announced min_score_used.
				for (const r of parsed.results) {
					expect(r.score).toBeGreaterThanOrEqual(0.70);
				}
			});
		});

		// ============================================================
		// #3172 — fixture-file re-ranking (follow-up of tests-rank-reranking)
		// tests/fixtures/** captures embed source code as JSON strings, so they match
		// code queries as well as the code itself and outrank the original (measured
		// ai-01 2026-08-19: fixture 0.702 / test 0.696 / fixture 0.696 all above the
		// real source). Fixture malus ×0.8 (stronger than test ×0.95 — a fixture is
		// never the actionable answer), multiplicative when both classifications hit,
		// and the JSON-container line fields ("1-1") are omitted as non-navigable.
		// ============================================================

		describe('handleCodebaseSearch - fixture-file re-ranking (#3172)', () => {
			test('repro — two fixtures + a test outranking the source all sink below it after the malus', async () => {
				// Exact shape of the ai-01 repro (limit 3): fixture 0.702 and 0.696 embed the
				// source as JSON, test 0.6961 describes it, source sits at 0.65. Adjusted:
				// test 0.6613 > source 0.65 > fixture 0.5616 — the source must rank ABOVE
				// both fixtures, which the raw cosine ordering denied.
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.702, payload: { filePath: 'mcps\\internal\\servers\\roo-state-manager\\tests\\fixtures\\real-tasks\\ac8aa7b4\\api_conversation_history.json', codeChunk: '876 | truncate = Math.max(2, Math.floor(max_output_length / estimatedSize))', startLine: 1, endLine: 1 } },
						{ score: 0.6961, payload: { filePath: 'mcps\\internal\\servers\\roo-state-manager\\src\\tools\\smart-truncation\\__tests__\\content-truncator.test.ts', codeChunk: "test('formatTruncatedOutput - ratio', () => {})", startLine: 427, endLine: 427 } },
						{ score: 0.696, payload: { filePath: 'mcps\\internal\\servers\\roo-state-manager\\tests\\fixtures\\real-tasks\\ac8aa7b4\\ui_messages.json', codeChunk: 'n876 | truncate = Math.max(2, ...)', startLine: 1, endLine: 1 } },
						{ score: 0.65, payload: { filePath: 'mcps\\internal\\servers\\roo-state-manager\\src\\tools\\view-conversation-tree.ts', codeChunk: 'truncate = Math.max(2, Math.floor(max_output_length / (estimatedSize / Math.max(1, totalMessages * 20))));', startLine: 749, endLine: 749 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'smart truncation compute final output size ratio', workspace: '/ws', limit: 3 });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				const paths = parsed.results.map((r: any) => r.file_path);
				// Source ranks above both fixtures (rank 2 here, behind the malused test).
				const sourceIdx = paths.indexOf('mcps\\internal\\servers\\roo-state-manager\\src\\tools\\view-conversation-tree.ts');
				expect(sourceIdx).toBe(1);
				expect(paths.indexOf('mcps\\internal\\servers\\roo-state-manager\\tests\\fixtures\\real-tasks\\ac8aa7b4\\api_conversation_history.json')).toBe(2);
				// The second fixture (0.696 × 0.8 = 0.5568) falls off the limit-3 slice.
				expect(paths).not.toContain('mcps\\internal\\servers\\roo-state-manager\\tests\\fixtures\\real-tasks\\ac8aa7b4\\ui_messages.json');
				// Adjusted scores surface: fixture 0.702 × 0.8 = 0.5616.
				expect(parsed.results[2].score).toBeCloseTo(0.5616, 5);
				expect(parsed.fixture_malus_applied).toBe(1);
				expect(parsed.test_file_malus_applied).toBe(1);
			});

			test('fixture hits omit the non-navigable JSON-container line fields — never "1-1"', async () => {
				// A fixture chunk stores startLine/endLine of the one-line JSON container,
				// not of the embedded code shown in the snippet. Rendering "1-1" sends the
				// caller to a line that leads nowhere — the fields must be absent instead.
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.70, payload: { filePath: 'tests/fixtures/real-tasks/abc/ui_messages.json', codeChunk: '876 | truncate = Math.max(2, ...)', startLine: 1, endLine: 1 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'truncate ratio', workspace: '/ws' });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				expect(parsed.results[0].file_path).toBe('tests/fixtures/real-tasks/abc/ui_messages.json');
				expect(parsed.results[0].score).toBeCloseTo(0.56, 5);
				expect(parsed.results[0]).not.toHaveProperty('lines');
				expect(parsed.results[0]).not.toHaveProperty('start_line');
				expect(parsed.results[0]).not.toHaveProperty('end_line');
				expect(parsed.fixture_malus_applied).toBe(1);
				expect(parsed.test_file_malus_applied).toBeUndefined();
			});

			test('min_score is re-applied on the post-fixture-malus score — a borderline fixture is dropped', async () => {
				// Same invariant as the test-file malus: no returned result may contradict
				// its own announced min_score_used. Fixture raw 0.58 passes a 0.5 raw
				// threshold but lands at 0.464 after ×0.8 → absent; source 0.52 remains.
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.58, payload: { filePath: 'tests\\fixtures\\real-tasks\\abc\\api_conversation_history.json', codeChunk: 'embedded code', startLine: 1, endLine: 1 } },
						{ score: 0.52, payload: { filePath: 'src/tools/view-conversation-tree.ts', codeChunk: 'export function buildTree() {}', startLine: 10, endLine: 20 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'build tree', workspace: '/ws', min_score: 0.5 });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.min_score_used).toBe(0.5);
				const paths = parsed.results.map((r: any) => r.file_path);
				expect(paths).not.toContain('tests\\fixtures\\real-tasks\\abc\\api_conversation_history.json');
				expect(paths).toContain('src/tools/view-conversation-tree.ts');
				for (const r of parsed.results) {
					expect(r.score).toBeGreaterThanOrEqual(0.5);
				}
			});
		});

		// ============================================================
		// #2609 V2 — data/config-file re-ranking
		// V2 names three confusable classes: "data / config / fixtures". Tests and
		// fixtures were demoted (#3172); data/config files were not, and a config VALUE
		// quotes the query vocabulary verbatim, so they won. Measured po-2024 2026-09-21
		// on the Epic's own golden query: two `roo-config/baselines/*.json` at 0.8849 took
		// ranks 1-2 ABOVE every source chunk, with zero hit on the implementing file.
		// ============================================================

		describe('handleCodebaseSearch - data/config-file re-ranking (#2609 V2)', () => {
			test('repro — two config baselines that took ranks 1-2 now sink below every code hit', async () => {
				// Exact shape of the live measurement, query
				// `unified store Postgres join filters Qdrant semantic search results`.
				// Raw cosine order: baseline, baseline, manual .js, .ts source, test file.
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.8848748, payload: { filePath: 'roo-config\\baselines\\myia-ai-01-settings-baseline.json', codeChunk: '"codebaseIndexQdrantUrl": "https://qdrant.myia.io"', startLine: 700, endLine: 700 } },
						{ score: 0.8848748, payload: { filePath: 'roo-config\\baselines\\myia-web1-settings-baseline.json', codeChunk: '"codebaseIndexQdrantUrl": "https://qdrant.myia.io"', startLine: 891, endLine: 891 } },
						{ score: 0.8454334, payload: { filePath: 'mcps\\internal\\servers\\roo-state-manager\\tests\\manual\\validate-batch-handlers.js', codeChunk: "['search_tasks_semantic', 'index_task_semantic']", startLine: 41, endLine: 41 } },
						{ score: 0.82117, payload: { filePath: 'mcps\\internal\\servers\\roo-state-manager\\src\\tools\\tool-definitions.ts', codeChunk: 'JOIN unified store filters', startLine: 148, endLine: 156 } },
						{ score: 0.786130985, payload: { filePath: 'mcps\\internal\\servers\\roo-state-manager\\src\\tools\\search\\__tests__\\search-semantic.tool.test.ts', codeChunk: 'exclude_tool_results=true adds chunk_type filter', startLine: 1003, endLine: 1003 } }
					]
				});

				const result = await handleCodebaseSearch({
					query: 'unified store Postgres join filters Qdrant semantic search results',
					workspace: '/ws',
					limit: 5
				});
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				expect(parsed.results_count).toBe(5);
				const paths = parsed.results.map((r: any) => r.file_path);

				// The code hit the query was actually about now leads.
				expect(paths[0]).toBe('mcps\\internal\\servers\\roo-state-manager\\tests\\manual\\validate-batch-handlers.js');

				// Both config baselines are pushed to the tail — they held ranks 0 and 1 before.
				const ai01Idx = paths.indexOf('roo-config\\baselines\\myia-ai-01-settings-baseline.json');
				expect(ai01Idx).toBeGreaterThanOrEqual(3);
				expect(paths.indexOf('roo-config\\baselines\\myia-web1-settings-baseline.json')).toBeGreaterThanOrEqual(3);

				// Adjusted score: 0.8848748 × 0.75 = 0.6636561.
				const ai01 = parsed.results[ai01Idx];
				expect(ai01.score).toBeCloseTo(0.6636561, 5);
				expect(parsed.data_file_malus_applied).toBe(2);

				// V2 point (c): the label must stop calling a config baseline "good".
				expect(ai01.relevance).toBe('moderate');

				// A .ts source is not a data extension — no malus, rank order unchanged.
				const ts = parsed.results.find((r: any) => String(r.file_path).endsWith('tool-definitions.ts'));
				expect(ts.score).toBeCloseTo(0.82117, 5);
				expect(ts.relevance).toBe('good');
			});

			test('precedence — a fixture keeps its single ×0.8 malus, never compounded with ×0.75', async () => {
				// Compounding would give 0.70 × 0.8 × 0.75 = 0.42, under min_score 0.5 — i.e.
				// silently removing fixtures from recall and breaking the #3172 contract that
				// fixtures stay VISIBLE (degraded, not removed). Precedence, not product.
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.70, payload: { filePath: 'tests\\fixtures\\real-tasks\\abc\\api_conversation_history.json', codeChunk: 'embedded code', startLine: 1, endLine: 1 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'embedded code', workspace: '/ws', min_score: 0.5 });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.results_count).toBe(1);
				expect(parsed.results[0].score).toBeCloseTo(0.56, 5);
				expect(parsed.fixture_malus_applied).toBe(1);
				expect(parsed.data_file_malus_applied).toBeUndefined();
			});

			test('scope — source and markdown hits are untouched; the malus targets data/config extensions only', async () => {
				// A documentation file is a legitimate answer (Epic golden scenario 4 is
				// doc-driven), so `.md` must NOT be swept into the data class.
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.80, payload: { filePath: '.claude\\rules\\sddd-grounding.md', codeChunk: '## Retrieval', startLine: 1, endLine: 12 } },
						{ score: 0.78, payload: { filePath: 'src\\tools\\search\\search-codebase.tool.ts', codeChunk: 'export async function handleCodebaseSearch', startLine: 689, endLine: 700 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'retrieval sddd', workspace: '/ws' });
				const parsed = JSON.parse(result.content[0].text);
				const md = parsed.results.find((r: any) => String(r.file_path).endsWith('.md'));
				const ts = parsed.results.find((r: any) => String(r.file_path).endsWith('search-codebase.tool.ts'));
				expect(md.score).toBeCloseTo(0.80, 5);
				expect(ts.score).toBeCloseTo(0.78, 5);
				expect(parsed.data_file_malus_applied).toBeUndefined();
				expect(parsed.test_file_malus_applied).toBeUndefined();
				expect(parsed.fixture_malus_applied).toBeUndefined();
			});
		});

		// ============================================================
		// #3174 (defect 3) — archive-file re-ranking
		// docs/archive/** carries stale-by-design reports that quote current
		// vocabulary verbatim, so they outrank the living code on fresh queries
		// (measured po-2025 2026-09-22: 2 docs/archive/reports/** hits in the
		// top-8 of the MAX_DASHBOARD_SIZE_BYTES probe, 0 hit on the source;
		// corroborated web1 c.287/c.488). Malus ×0.7 — degraded, not removed:
		// the measured archive hits (0.72-0.75) stay above min_score 0.5 where
		// the ×0.5 floated in the issue would silently drop them from recall.
		//
		// #2609 V2(b) follow-up (po-2025, 2026-09-28) — measured verdict: the probe's
		// negative is a CORPUS defect, not a ranking one. Same query, two collections
		// of this workspace: the hash-resolved one (ws-d2ffd…) holds zero dashboard.ts /
		// src/tools/roosync chunk — the file is absent from that corpus, so no lever
		// (malus or bonus) can surface it; a fresh twin of the same repo returns the
		// DEFINING source rank 1 (DashboardSizes interface — the declaration site of
		// the threshold; 0.7607 vs 0.7587 for the tools-list script, docs/data/build
		// malussed below). The `const MAX_DASHBOARD_SIZE_BYTES` line itself is never
		// chunked (the indexer drops nodes under MIN_BLOCK_CHARS=50, roo-code
		// parser.ts:180/226; the const is 43 chars) — "definition in top-3" can only
		// mean the declaration site, and ranks only on a corpus that holds the file.
		// The live-shape describe below pins that contract.
		// ============================================================

			describe('handleCodebaseSearch - compiled-build re-ranking (#2609 V2(a))', () => {
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

			test('repro — a stale build-<hash> vintage that outranked every living source chunk sinks below it', async () => {
				// Exact shape of the live measurement (2026-09-27, golden scenario 3 re-run):
				// the TOP source hit was …/build-80b4b9a14965a403/…compare-config.js, a dead
				// compiled vintage, above every living .ts source chunk.
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.83, payload: { filePath: 'mcps\\internal\\servers\\roo-state-manager\\build-80b4b9a14965a403\\tools\\roosync\\compare-config.js', codeChunk: 'const divergent_value = [];', startLine: 199, endLine: 199 } },
						{ score: 0.80, payload: { filePath: 'mcps\\internal\\servers\\roo-state-manager\\src\\tools\\search\\search-semantic.tool.ts', codeChunk: 'const joined = await postgres.query(SQL);', startLine: 300, endLine: 300 } }
					]
				});

				const result = await handleCodebaseSearch({
					query: 'unified store Postgres join filters Qdrant semantic search results',
					workspace: '/ws',
					limit: 2
				});
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				const paths = parsed.results.map((r: any) => r.file_path);

				// The living source now leads; the stale vintage stays visible, degraded.
				expect(paths[0]).toBe('mcps\\internal\\servers\\roo-state-manager\\src\\tools\\search\\search-semantic.tool.ts');
				expect(parsed.results[0].score).toBeCloseTo(0.80, 5);
				expect(parsed.results[1].score).toBeCloseTo(0.83 * 0.7, 5);
				expect(parsed.build_dir_malus_applied).toBe(1);
			});

			test('precedence — build dir wins over the data class, never compounded with ×0.75', async () => {
				// build-x/foo.json is first a compiled artifact: 0.70 × 0.7 = 0.49, still above
				// the min_score floor used here; compounding to 0.7 × 0.75 = 0.3675 would push
				// a 0.70 hit far under any threshold — silently removing it from recall.
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.70, payload: { filePath: 'mcps\\internal\\build-abc123def4567890\\config.json', codeChunk: '{"x": 1}', startLine: 1, endLine: 1 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'config', workspace: '/ws', limit: 1, min_score: 0.2 });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.results_count).toBe(1);
				// ×0.7 (build) only — NOT ×0.7 × 0.75 (build × data).
				expect(parsed.results[0].score).toBeCloseTo(0.70 * 0.7, 5);
				expect(parsed.build_dir_malus_applied).toBe(1);
				expect(parsed.data_file_malus_applied).toBeUndefined();
			});

			test('scope — source dirs named `build-<word>/` (build-tools, build-helpers) are NOT compiled output', async () => {
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.70, payload: { filePath: 'src\\build-tools\\hammer.ts', codeChunk: 'x', startLine: 1, endLine: 1 } },
						{ score: 0.70, payload: { filePath: 'src\\build-helpers\\util.ts', codeChunk: 'y', startLine: 1, endLine: 1 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'module', workspace: '/ws', limit: 2, min_score: 0.2 });
				const parsed = JSON.parse(result.content[0].text);
				const byPath = Object.fromEntries(parsed.results.map((r: any) => [r.file_path, r.score]));
				expect(byPath['src\\build-tools\\hammer.ts']).toBeCloseTo(0.70, 5);
				expect(byPath['src\\build-helpers\\util.ts']).toBeCloseTo(0.70, 5);
				expect(parsed.build_dir_malus_applied).toBeUndefined();
			});

			test('cap key — compiled copies of one logical file share ONE budget; a `build-helpers/` source keeps its own', async () => {
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.99, payload: { filePath: 'src\\util.ts', codeChunk: 'a1', startLine: 1, endLine: 1 } },
						{ score: 0.98, payload: { filePath: 'src\\util.ts', codeChunk: 'a2', startLine: 20, endLine: 20 } },
						{ score: 0.97, payload: { filePath: 'src\\build-helpers\\util.ts', codeChunk: 'b1', startLine: 1, endLine: 1 } },
						{ score: 0.96, payload: { filePath: 'lib\\build\\mod.js', codeChunk: 'c1', startLine: 1, endLine: 1 } },
						{ score: 0.95, payload: { filePath: 'lib\\build-out\\mod.js', codeChunk: 'c2', startLine: 20, endLine: 20 } },
						{ score: 0.94, payload: { filePath: 'lib\\build-80b4b9a14965a403\\mod.js', codeChunk: 'c3', startLine: 40, endLine: 40 } },
						{ score: 0.30, payload: { filePath: 'src\\other.ts', codeChunk: 'd1', startLine: 1, endLine: 1 } }
					]
				});

				// limit 5 < eligible picks: no backfill can rescue a capped hit, so the cap key decides.
				const result = await handleCodebaseSearch({ query: 'module', workspace: '/ws', limit: 5, min_score: 0.2 });
				const parsed = JSON.parse(result.content[0].text);
				const paths = parsed.results.map((r: any) => r.file_path);
				// build-helpers/util.ts is its own file: NOT capped against src/util.ts's two chunks
				// (the old `build(-[a-z0-9]+)?` key stripped it to src/util.ts and dropped it).
				expect(paths).toContain('src\\build-helpers\\util.ts');
				// The three compiled copies of lib/mod.js share one budget of 2. Their line
				// ranges are DISJOINT (post-#2609-follow-up, same-range copies of one
				// logical file are folded by the overlap merge BEFORE the cap — the
				// cross-vintage merge has its own unit test).
				const compiled = paths.filter((p: string) => p.endsWith('mod.js'));
				expect(compiled).toHaveLength(2);
				expect(paths).not.toContain('lib\\build-80b4b9a14965a403\\mod.js');
			});

			test('scope — bare `build/`, hashed `build-<hex>/` and the `build-out/` staging dir match; src/ is untouched', async () => {
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.70, payload: { filePath: 'frontend\\build\\bundle.js', codeChunk: 'x', startLine: 1, endLine: 1 } },
						{ score: 0.70, payload: { filePath: 'mcps\\internal\\servers\\roo-state-manager\\build-out\\tools\\roosync\\compare-config.js', codeChunk: 'x', startLine: 1, endLine: 1 } },
						{ score: 0.70, payload: { filePath: 'src\\plain\\module.ts', codeChunk: 'y', startLine: 1, endLine: 1 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'module', workspace: '/ws', limit: 3, min_score: 0.2 });
				const parsed = JSON.parse(result.content[0].text);
				const byPath = Object.fromEntries(parsed.results.map((r: any) => [r.file_path, r.score]));
				expect(byPath['frontend\\build\\bundle.js']).toBeCloseTo(0.70 * 0.7, 5);
				expect(byPath['mcps\\internal\\servers\\roo-state-manager\\build-out\\tools\\roosync\\compare-config.js']).toBeCloseTo(0.70 * 0.7, 5);
				expect(byPath['src\\plain\\module.ts']).toBeCloseTo(0.70, 5);
			});
		});

		describe('handleCodebaseSearch - archive-file re-ranking (#3174 defect 3)', () => {
			test('repro — archived reports outranking the source sink below it after the malus, staying visible', async () => {
				// Shape of the po-2025 22/09 probe: two docs/archive/reports/** hits above
				// the source. Raw: 0.748 / 0.736 > source 0.70. Adjusted: source 0.70 >
				// 0.748×0.7=0.5236 > 0.736×0.7=0.5152 — both above min_score 0.5 (visible).
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.748, payload: { filePath: 'docs\\archive\\reports\\2026-03-03-issue-543-validation-framework.md', codeChunk: 'autoCondenseContextPercent CRITICAL drift', startLine: 74, endLine: 75 } },
						{ score: 0.736, payload: { filePath: 'docs\\archive\\reports\\2026-03-03-issue-543-validation-framework.md', codeChunk: 'condensation threshold drift report', startLine: 66, endLine: 67 } },
						{ score: 0.70, payload: { filePath: 'mcps\\internal\\servers\\roo-state-manager\\src\\tools\\roosync\\dashboard.ts', codeChunk: 'const MAX_DASHBOARD_SIZE_BYTES = 50 * 1024;', startLine: 129, endLine: 129 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'dashboard auto-condensation threshold MAX_DASHBOARD_SIZE_BYTES', workspace: '/ws', limit: 3 });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				const paths = parsed.results.map((r: any) => r.file_path);
				// The source the query was actually about now leads.
				expect(paths[0]).toBe('mcps\\internal\\servers\\roo-state-manager\\src\\tools\\roosync\\dashboard.ts');
				// Both archived reports stay in the result set — degraded, not removed.
				expect(paths.filter((p: string) => p.startsWith('docs\\archive\\')).length).toBe(2);
				expect(parsed.results[1].score).toBeCloseTo(0.5236, 5);
				expect(parsed.results[2].score).toBeCloseTo(0.5152, 5);
				expect(parsed.archive_malus_applied).toBe(2);
			});

			test('precedence — an archived config keeps its single ×0.7 malus, never compounded with ×0.75', async () => {
				// docs/archive/foo.json is both an archive and a data extension. Compounding
				// 0.7 × 0.75 = 0.525 would drop a 0.80 hit to 0.42 — under min_score,
				// silently removed from recall. The archive class wins alone.
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.80, payload: { filePath: 'docs\\archive\\reports\\2026-01-01-baseline-snapshot.json', codeChunk: '"condensationThreshold": 51200', startLine: 12, endLine: 12 } },
						{ score: 0.55, payload: { filePath: 'src\\tools\\roosync\\dashboard.ts', codeChunk: 'export function condense()', startLine: 10, endLine: 20 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'condensation threshold snapshot', workspace: '/ws', limit: 2 });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				const archived = parsed.results.find((r: any) => String(r.file_path).includes('docs\\archive\\'));
				expect(archived.score).toBeCloseTo(0.56, 5);
				expect(parsed.archive_malus_applied).toBe(1);
				expect(parsed.data_file_malus_applied).toBeUndefined();
			});

			test('scope — living documentation is untouched; the malus targets docs/archive/ only', async () => {
				// docs/harness/reference/** is curated current documentation — a legitimate
				// answer that must keep its raw score. Only the archive subtree demotes.
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.80, payload: { filePath: 'docs\\harness\\reference\\roosync-tools-guide.md', codeChunk: '## Dashboard', startLine: 198, endLine: 207 } },
						{ score: 0.78, payload: { filePath: 'src\\tools\\roosync\\dashboard.ts', codeChunk: 'export function readDashboard()', startLine: 100, endLine: 110 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'dashboard read guide', workspace: '/ws' });
				const parsed = JSON.parse(result.content[0].text);
				const md = parsed.results.find((r: any) => String(r.file_path).endsWith('.md'));
				expect(md.score).toBeCloseTo(0.80, 5);
				expect(parsed.archive_malus_applied).toBeUndefined();
				expect(parsed.data_file_malus_applied).toBeUndefined();
			});
		});

		// ============================================================
		// #2609 V2(b) — defining source vs tools-lists / docs (the :889 probe).
		// Live shape measured 2026-09-28 (po-2025): on a corpus that holds the
		// file, the SAME query returns the defining source rank 1 — the tools-list
		// script 0.2% behind, data/build artifacts malussed below. The production
		// negative on po-2025 is a corpus defect (the hash-resolved collection has
		// no src/tools/roosync chunk at all), not a ranking one. These tests pin
		// the ranking contract the probe checks, plus the doc case (item 3).
		// ============================================================

		describe('handleCodebaseSearch - #2609 V2(b) probe — defining source vs tools-lists (live shape 28/09)', () => {
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

			test('live shape — the defining source leads; the tools-list script stays below; data/build sinks after their malus', async () => {
				// Raw scores = measured response ÷ the malus where one applied, so the
				// ADJUSTED values reproduce the live run (0.7607 / 0.7587 / 0.7484 /
				// 0.7162 / 0.5914 / 0.5781 / 0.5204 / 0.5185).
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.7607, payload: { filePath: 'mcps\\internal\\servers\\roo-state-manager\\src\\tools\\roosync\\dashboard.ts', codeChunk: 'export interface DashboardSizes {', startLine: 4173, endLine: 4189 } },
						{ score: 0.7587, payload: { filePath: 'scripts\\validation\\e2e-test-tools.js', codeChunk: "{ name: 'roosync_refresh_dashboard', params: {}, description: 'Refresh dashboard' },", startLine: 50, endLine: 51 } },
						{ score: 0.7484, payload: { filePath: 'mcps\\internal\\servers\\roo-state-manager\\src\\tools\\roosync\\dashboard.ts', codeChunk: '// The dashboard should stay under 50KB thanks to size-based condensation,', startLine: 4779, endLine: 4779 } },
						{ score: 0.7539, payload: { filePath: 'mcps\\internal\\servers\\roo-state-manager\\src\\tools\\roosync\\__tests__\\dashboard.test.ts', codeChunk: "it('auto-condensation triggers based on size, not message count', async () => {", startLine: 677, endLine: 680 } },
						{ score: 0.7885, payload: { filePath: 'docs\\harness\\reference\\superseded-by-closed-issues-audit-table-2026-07-21.json', codeChunk: '"improve(dashboard): condensation status prompt — long-term state memory"', startLine: 10654, endLine: 10654 } },
						{ score: 0.7708, payload: { filePath: 'docs\\harness\\reference\\superseded-by-closed-issues-audit-table-2026-07-21.json', codeChunk: '"title": "improve(dashboard): condensation status prompt"', startLine: 10654, endLine: 10654 } },
						{ score: 0.7434, payload: { filePath: 'mcps\\internal\\servers\\roo-state-manager\\build-out\\tools\\tool-definitions.js', codeChunk: "task_id: { type: 'string', description: 'Required for action=index' },", startLine: 174, endLine: 194 } },
						{ score: 0.7407, payload: { filePath: 'mcps\\internal\\servers\\roo-state-manager\\build-out\\tools\\indexing\\roosync-indexing.tool.d.ts', codeChunk: 'export interface RooSyncIndexingArgs {', startLine: 42, endLine: 88 } }
					]
				});

				const result = await handleCodebaseSearch({
					query: 'dashboard auto-condensation threshold MAX_DASHBOARD_SIZE_BYTES',
					workspace: '/ws',
					limit: 8
				});
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				const paths = parsed.results.map((r: any) => r.file_path);

				// The defining source leads — above the tools-list script (raw 0.7607 vs
				// 0.7587) and above the two malussed data/build hits that Qdrant ranked
				// FIRST on raw score (0.7885, 0.7708).
				expect(paths[0]).toBe('mcps\\internal\\servers\\roo-state-manager\\src\\tools\\roosync\\dashboard.ts');
				expect(parsed.results[0].score).toBeCloseTo(0.7607, 4);
				expect(paths.indexOf('scripts\\validation\\e2e-test-tools.js')).toBeGreaterThan(0);
				// Both dashboard.ts chunks survive (cap 2) — the second still ahead of the test file.
				expect(paths.filter((p: string) => p.endsWith('roosync\\dashboard.ts'))).toHaveLength(2);
				expect(paths[2]).toBe('mcps\\internal\\servers\\roo-state-manager\\src\\tools\\roosync\\dashboard.ts');
				// #2609 V2 follow-up: the two audit-JSON chunks were BOTH pinned to line
				// 10654 of the same file — same passage stored twice in the live corpus.
				// The overlap merge folds the echo (overlapping_chunks_merged=1): ONE
				// data hit renders, and every rank below shifts up by one.
				expect(paths.filter((p: string) => p.endsWith('audit-table-2026-07-21.json'))).toHaveLength(1);
				expect(parsed.overlapping_chunks_merged).toBe(1);
				// Malus arithmetic agrees with the rendering (single source of truth).
				expect(parsed.results[3].score).toBeCloseTo(0.7162, 4);   // test ×0.95
				expect(parsed.results[4].score).toBeCloseTo(0.5914, 4);   // data ×0.75 (single copy)
				expect(parsed.results[5].score).toBeCloseTo(0.5204, 4);   // build ×0.7
				expect(parsed.results[6].score).toBeCloseTo(0.5185, 4);   // build ×0.7
				expect(parsed.test_file_malus_applied).toBe(1);
				expect(parsed.data_file_malus_applied).toBe(1);
				expect(parsed.build_dir_malus_applied).toBe(2);
			});

			test('doc case — a conceptual question keeps the living doc as the answer, untouched by any malus', async () => {
				// #2609 V2(b) dispatch item 3: the source-first levers must never bury
				// the doc when the doc IS the answer. Conceptual intent, no identifier
				// in the query → nothing demotes the guide; the source stays second.
				mockQdrant.query.mockResolvedValue({
					points: [
						{ score: 0.80, payload: { filePath: 'docs\\harness\\reference\\roosync-tools-guide.md', codeChunk: '### Key Actions\n\n| Action | Purpose |\n| `append` | Post an intercom message |', startLine: 198, endLine: 207 } },
						{ score: 0.70, payload: { filePath: 'mcps\\internal\\servers\\roo-state-manager\\src\\tools\\roosync\\dashboard.ts', codeChunk: 'async function handleAppend(dashboard: Dashboard): Promise<void> {', startLine: 3000, endLine: 3020 } }
					]
				});

				const result = await handleCodebaseSearch({ query: 'how to post a message on the workspace dashboard', workspace: '/ws' });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				expect(parsed.results[0].file_path).toBe('docs\\harness\\reference\\roosync-tools-guide.md');
				expect(parsed.results[0].score).toBeCloseTo(0.80, 5);
				expect(parsed.archive_malus_applied).toBeUndefined();
				expect(parsed.data_file_malus_applied).toBeUndefined();
				expect(parsed.test_file_malus_applied).toBeUndefined();
			});
		});

		// ============================================================
		// #2609 V2(c)(b) — partial-collection detection at resolution time
		// V2(b) verdict: ws-d2ffdbaa832aed16 was served PARTIAL (883/5013,
		// src/tools/roosync absent) while hash-matching — silence read as coverage.
		// V2(c) exposes `coverage` + `coverage_warning` below a named threshold.
		// ============================================================

		describe('handleCodebaseSearch - partial-collection coverage (#2609 V2(c)(b)/(c))', () => {
			beforeEach(() => {
				clearCoverageCache();
				process.env.EMBEDDING_API_KEY = 'test-key';
				mockQdrant.getCollection.mockResolvedValue({ status: 'green', points_count: 100 });
				mockEmbeddingCreate.mockResolvedValue({
					data: [{ embedding: new Array(8).fill(0.1) }]
				});
				mockQdrant.query.mockResolvedValue({ points: [] });
			});

			afterEach(() => {
				delete process.env.EMBEDDING_API_KEY;
				// Restore the hoisted default so later suites stay deterministic.
				mockReaddirSync.mockReturnValue([]);
			});

			// The exact shape measured on ws-d2ffdbaa832aed16 at V2(b) time
			// (c.5869551111) — the dispatch's named fixture.
			test('evaluateCoverage: 883/5013 → ratio 0.176, below threshold 0.8 (V2(b) fixture)', () => {
				const c = evaluateCoverage(883, 5013);
				expect(c).not.toBeNull();
				expect(c!.indexed_files).toBe(883);
				expect(c!.eligible_files).toBe(5013);
				expect(c!.coverage_ratio).toBeCloseTo(0.176, 2);
				expect(c!.warn_threshold).toBe(0.8);
				expect(c!.below_threshold).toBe(true);
			});

			test('evaluateCoverage: full coverage does not breach the threshold', () => {
				const c = evaluateCoverage(5013, 5013)!;
				expect(c.coverage_ratio).toBe(1);
				expect(c.below_threshold).toBe(false);
			});

			test('evaluateCoverage: null on an undecidable denominator', () => {
				expect(evaluateCoverage(883, 0)).toBeNull();
				expect(evaluateCoverage(Number.NaN, 10)).toBeNull();
			});

			test('response carries coverage + coverage_warning when the collection is partial (mocked scroll + disk)', async () => {
				// 2 distinct indexed files, 10 eligible on disk → 0.2 < 0.8.
				mockQdrant.scroll.mockResolvedValue({
					points: [
						{ payload: { filePath: 'src/a.ts' } },
						{ payload: { filePath: 'src/b.ts' } }
					]
				});
				mockReaddirSync.mockImplementation(() => Array.from({ length: 10 }, (_, i) => ({
					name: `file${i}.ts`,
					isDirectory: () => false,
					isFile: () => true
				})));

				const result = await handleCodebaseSearch({
					query: 'coverage probe',
					workspace: '/ws/v2c-partial'
				});
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				expect(parsed.coverage).toBeDefined();
				expect(parsed.coverage.indexed_files).toBe(2);
				expect(parsed.coverage.eligible_files).toBe(10);
				expect(parsed.coverage.coverage_ratio).toBe(0.2);
				expect(parsed.coverage.below_threshold).toBe(true);
				expect(parsed.coverage_warning).toContain('PARTIAL');
				expect(parsed.coverage_warning).toContain('/10');
			});

			test('full coverage: coverage block present, no coverage_warning', async () => {
				mockQdrant.scroll.mockResolvedValue({
					points: [
						{ payload: { filePath: 'a.ts' } },
						{ payload: { filePath: 'b.ts' } }
					]
				});
				mockReaddirSync.mockImplementation(() => [
					{ name: 'a.ts', isDirectory: () => false, isFile: () => true },
					{ name: 'b.ts', isDirectory: () => false, isFile: () => true },
					{ name: 'node_modules', isDirectory: () => true, isFile: () => false }
				]);

				const result = await handleCodebaseSearch({
					query: 'coverage probe',
					workspace: '/ws/v2c-full'
				});
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				expect(parsed.coverage.coverage_ratio).toBe(1);
				expect(parsed.coverage.below_threshold).toBe(false);
				expect(parsed.coverage_warning).toBeUndefined();
			});

			test('no coverage block when the workspace is not on disk (denominator undecidable)', async () => {
				mockQdrant.scroll.mockResolvedValue({
					points: [{ payload: { filePath: 'a.ts' } }]
				});
				mockReaddirSync.mockImplementation(() => {
					throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				});

				const result = await handleCodebaseSearch({
					query: 'coverage probe',
					workspace: '/ws/v2c-nodisk'
				});
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				expect(parsed.coverage).toBeUndefined();
				expect(parsed.coverage_warning).toBeUndefined();
			});

			test('coverage is cached per collection: a second search does not re-scroll', async () => {
				mockQdrant.scroll.mockResolvedValue({
					points: [{ payload: { filePath: 'a.ts' } }]
				});
				mockReaddirSync.mockImplementation(() => [
					{ name: 'a.ts', isDirectory: () => false, isFile: () => true },
					{ name: 'b.ts', isDirectory: () => false, isFile: () => true }
				]);

				await handleCodebaseSearch({ query: 'one', workspace: '/ws/v2c-cache' });
				await handleCodebaseSearch({ query: 'two', workspace: '/ws/v2c-cache' });
				expect(mockQdrant.scroll).toHaveBeenCalledTimes(1);
			});

			test('served_build pins the running build dir on every success response (#2609 V2(c)(c))', async () => {
				mockQdrant.scroll.mockResolvedValue({ points: [] });

				const result = await handleCodebaseSearch({
					query: 'served build probe',
					workspace: '/ws/v2c-build'
				});
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				expect(typeof parsed.served_build).toBe('string');
				expect(parsed.served_build.length).toBeGreaterThan(0);
			});

			test('getServedBuildId: deterministic, never empty', () => {
				const id = getServedBuildId();
				expect(typeof id).toBe('string');
				expect(id.length).toBeGreaterThan(0);
				expect(getServedBuildId()).toBe(id);
			});

			// #2609 V2(c)(b) follow-up (ai-01, 2026-09-30): the denominator must mirror
			// the Roo/Zoo indexer's DIRS_TO_IGNORE — every hidden dir (the ".*" pattern),
			// its explicit names, its two path patterns — while COUNTING compiled dirs
			// (build/, build-<hash>/, build-out/) the indexer does index. Measured on
			// D:/roo-extensions: .claude/worktrees/** alone was 47% of the old denominator
			// (8390/17992 files, 3 agent worktrees) yet ZERO dotdir paths exist in the
			// corpus — coverage read 0.348 where the indexer-aligned ratio is ~0.60.
			test('denominator mirrors the indexer: hidden dirs skipped, build dirs counted, target/dependency pair skipped', async () => {
				mockQdrant.scroll.mockResolvedValue({ points: [{ payload: { filePath: 'a.ts' } }] });
				const F = (name: string) => ({ name, isDirectory: () => false, isFile: () => true });
				const D = (name: string) => ({ name, isDirectory: () => true, isFile: () => false });
				mockReaddirSync.mockImplementation((p: any) => {
					const n = String(p).replace(/\\/g, '/');
					if (n.endsWith('/target')) return [D('dependency')];
					if (n.endsWith('/dependency')) return [F('dep.java')];
					if (n.endsWith('/build-out')) return [F('compiled.js')];
					if (n.endsWith('.claude/worktrees/wt1')) return [F('file.ts')];
					// Root listing — also served for any UNEXPECTED directory: a wrongly
					// descended skip-dir replays this listing and breaks the exact count.
					return [F('a.ts'), D('.claude'), D('build-out'), D('target'), D('node_modules')];
				});

				const result = await handleCodebaseSearch({ query: 'walk probe', workspace: '/ws/v2f-walk' });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				// Eligible = a.ts (root) + compiled.js (build-out IS indexed by Roo).
				// NOT eligible: .claude/** (hidden — never indexed, worktrees included),
				// node_modules, target/dependency (indexer path-pattern skip).
				expect(parsed.coverage.eligible_files).toBe(2);
				expect(parsed.coverage.indexed_files).toBe(1);
				expect(parsed.coverage.coverage_ratio).toBe(0.5);
				expect(parsed.coverage_warning).toContain('PARTIAL');
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
				// #2609 follow-up: the accepting criterion is named in the response — a
				// reader must not re-derive the gate to interpret a low jaccard.
				expect(parsed.content_match.accepted_via).toBe('jaccard');
				expect(parsed.content_match.shared_discriminant_dirs).toBeGreaterThanOrEqual(1);
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

			// #3174 (defect 4): the worktree/hash-mismatch path leaves workspaceSignature
			// null, and the old payload rendered collection_signatures ONLY when the
			// workspace dirs could be read — so exactly the caller who most needs to
			// self-identify (their hash mismatched, their dirs are unreadable to us) got
			// a bare collection list with no directory hints. top_dirs now rides on every
			// existing_collections entry unconditionally.
			test('existing_collections entries carry top_dirs even when the workspace dirs could not be read (#3174 defect 4)', async () => {
				// Workspace root unreadable (unmounted drive / worktree hash mismatch) →
				// workspaceSignature null → content-match skipped entirely.
				mockReaddirSync.mockImplementation(() => {
					throw new Error('ENOENT: no such file or directory');
				});
				mockQdrant.getCollections.mockResolvedValue({
					collections: [{ name: 'ws-someone' }]
				});
				mockQdrant.getCollection.mockImplementation(async (name: string) => {
					if (name === 'ws-someone') return { points_count: 500, status: 'green' };
					throw new Error('not found');
				});
				mockQdrant.scroll.mockResolvedValue({
					points: [{ payload: { pathSegments: { '0': 'mcps', '1': 'internal' } } }]
				});

				const result = await handleCodebaseSearch({ query: 'x', workspace: '/unmounted-ws' });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('collection_not_found');
				// The legacy shape stays empty when the workspace dirs were unreadable…
				expect(parsed.collection_signatures).toEqual({});
				// …but every diagnostic entry carries its indexed top-level dirs, so the
				// caller can match them against directories they can list themselves.
				expect(parsed.existing_collections).toHaveLength(1);
				expect(parsed.existing_collections[0].collection).toBe('ws-someone');
				expect(parsed.existing_collections[0].top_dirs).toEqual(['mcps']);
				expect(mockQdrant.scroll).toHaveBeenCalledWith('ws-someone', expect.objectContaining({
					with_payload: { include: ['pathSegments'] }
				}));
			});

			// The diagnostic used to state ONLY the Jaccard arm ("Jaccard >= 0.6 with a
			// discriminant dir required") while the code accepts a SECOND path since
			// #2554/#2766: overlap >= 0.6 with >=2 shared discriminant dirs. A caller whose
			// workspace has exactly 1 discriminant dir and high overlap was told a rule its
			// input satisfied — so the tool read as lying, and the real requirement (a
			// SECOND discriminant dir) was undiscoverable from the failure itself.
			test('the failure diagnostic states the acceptance rule the code actually applies', async () => {
				mockReaddirSync.mockReturnValue([
					{ name: 'src', isDirectory: () => true },
					{ name: 'docs', isDirectory: () => true },
					{ name: 'tests', isDirectory: () => true }
				]);
				mockQdrant.getCollections.mockResolvedValue({ collections: [{ name: 'ws-someone' }] });
				mockQdrant.getCollection.mockImplementation(async (name: string) => {
					if (name === 'ws-someone') return { points_count: 500, status: 'green' };
					throw new Error('not found');
				});
				mockQdrant.scroll.mockResolvedValue({
					points: [{ payload: { pathSegments: { '0': 'src' } } }]
				});

				const result = await handleCodebaseSearch({ query: 'x', workspace: '/generic-ws' });
				const parsed = JSON.parse(result.content[0].text);

				// Both arms must be named, or the caller cannot diagnose the overlap path.
				expect(parsed.message).toMatch(/Jaccard/);
				expect(parsed.message).toMatch(/overlap/i);
				// The overlap arm needs TWO discriminant dirs — the single most misleading
				// omission of the old wording, which said "a discriminant dir required".
				expect(parsed.message).toMatch(/2 shared discriminant dirs/);
				// Thresholds are exposed per arm, not as one anonymous number.
				expect(parsed.content_match_jaccard_threshold).toBe(0.6);
				expect(parsed.content_match_overlap_threshold).toBe(0.6);
				expect(parsed.content_match_discriminant_dirs_required)
					.toEqual({ jaccard_path: 1, overlap_path: 2 });
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
				// #3174 (defect 4) updated this contract: the signature scrolls now run
				// unconditionally to populate top_dirs on every existing_collections entry —
				// content-matching stays skipped (null signature), but the diagnostic still
				// lets an unmounted-worktree caller self-identify. Payload-only calls.
				expect(mockQdrant.scroll).toHaveBeenCalledWith('ws-anything', expect.objectContaining({
					with_payload: { include: ['pathSegments'] }
				}));
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

			test('hash miss + accepting candidate ranked beyond the old cap (rank 12) → still found and served', async () => {
				// CoursIA-2 fleet finding (2026-09-20, po-203 cross-workspace [TASK]): the only
				// accepting collections sat at ranks 12-13 of 62 by points_count — under
				// CONTENT_MATCH_MAX_CANDIDATES=10 the fallback never probed them and the tool
				// reported collection_not_found for a workspace whose content IS indexed (under
				// sibling-clone hashes). The cap must cover the whole realistic candidate set.
				mockReaddirSync.mockReturnValue([
					{ name: 'roo-code', isDirectory: () => true },
					{ name: 'mcps', isDirectory: () => true },
					{ name: 'docs', isDirectory: () => true }
				]);
				// 12 collections with strictly descending points_count: the ONLY accepting one
				// is the smallest = probed LAST (rank 12).
				const names = Array.from({ length: 12 }, (_, i) => `ws-c${String(i + 1).padStart(2, '0')}`);
				mockQdrant.getCollections.mockResolvedValue({ collections: names.map(name => ({ name })) });
				mockQdrant.getCollection.mockImplementation(async (name: string) => {
					const idx = names.indexOf(name);
					if (idx === -1) throw new Error('not found'); // hash variants miss
					return { points_count: (12 - idx) * 1000, status: 'green' };
				});
				mockQdrant.scroll.mockImplementation(async (name: string) => {
					if (name === 'ws-c12') {
						return { points: [
							{ payload: { pathSegments: { '0': 'roo-code' } } },
							{ payload: { pathSegments: { '0': 'mcps' } } },
							{ payload: { pathSegments: { '0': 'docs' } } }
						] };
					}
					return { points: [{ payload: { pathSegments: { '0': 'elsewhere' } } }] };
				});
				mockQdrant.query.mockResolvedValue({
					points: [{ score: 0.8, payload: { filePath: 'roo-code/z.ts', codeChunk: 'z', startLine: 1, endLine: 1 } }]
				});

				const result = await handleCodebaseSearch({ query: 'z', workspace: '/fleet-ws' });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('success');
				expect(parsed.collection).toBe('ws-c12');
				expect(parsed.collection_resolved_by).toBe('content-match');
				// All 12 candidates were actually probed — the rank-12 one included.
				// (#2609 V2(c): the success path may add ONE more scroll after resolution
				// — the coverage count, identified by its `filePath` payload projection —
				// which is not a fallback signature probe.)
				const signatureProbes = mockQdrant.scroll.mock.calls.filter(
					(args: any[]) => args[1]?.with_payload?.include?.[0] === 'pathSegments'
				);
				expect(signatureProbes).toHaveLength(12);
			});

			test('no match + candidates exceed the cap → diagnostic discloses scanned of total, not just total', async () => {
				// The old message said "content-based fallback over N ws-* collections" where N
				// was the TOTAL count while only min(N, cap) were probed — the cap was invisible
				// as a failure mode. The message and payload must state the real probe count.
				mockReaddirSync.mockReturnValue([
					{ name: 'roo-code', isDirectory: () => true },
					{ name: 'mcps', isDirectory: () => true },
					{ name: 'docs', isDirectory: () => true }
				]);
				const names = Array.from({ length: 65 }, (_, i) => `ws-x${String(i).padStart(3, '0')}`);
				mockQdrant.getCollections.mockResolvedValue({ collections: names.map(name => ({ name })) });
				mockQdrant.getCollection.mockImplementation(async (name: string) => {
					if (!names.includes(name)) throw new Error('not found');
					return { points_count: 1000 - names.indexOf(name), status: 'green' };
				});
				mockQdrant.scroll.mockResolvedValue({ points: [{ payload: { pathSegments: { '0': 'elsewhere' } } }] });

				const result = await handleCodebaseSearch({ query: 'q', workspace: '/capped-ws' });
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.status).toBe('collection_not_found');
				expect(parsed.content_match_candidates_total).toBe(65);
				expect(parsed.content_match_candidates_scanned).toBe(64);
				expect(parsed.message).toMatch(/over 64 of 65 ws-\* collections/);
				// The disclosed number is the real probe frontier: the first 64 ranked
				// candidates were each probed, the 65th never. (The diagnostic also draws
				// 5 extra signature-sample scrolls after the failed match — count via the
				// set of probed names, not a raw call count.)
				const probedNames = new Set(mockQdrant.scroll.mock.calls.map((c: any[]) => c[0]));
				for (let i = 0; i < 64; i++) expect(probedNames.has(names[i])).toBe(true);
				expect(probedNames.has(names[64])).toBe(false);
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
			// #2609 follow-up: the accepting path must be observable, not re-derived.
			// This fixture is THE overlap-acceptance case — jaccard 0.226 < 0.6.
			expect(match!.sharedDiscriminants).toBeGreaterThanOrEqual(2);
		});
	});

	// ============================================================
	// ============================================================
	// #2609 V2 follow-up (ai-01, 2026-09-30) — overlapping-window merge at ranking
	// Measured live, golden q3 re-run: build-out/compare-config.js rendered windows
	// 183-213 and 184-214 took ranks 2-3 BOTH — two stored ADJACENT single lines (198,
	// 199) that each expanded to an overlapping block. Same passage twice, two of the
	// five top slots, while the defining source sat outside the top-5.
	// ============================================================

	describe('dropOverlappingWindows (#2609 V2 follow-up) — pure merge', () => {
		const key = (fp: string) => fp;
		const hit = (fp: string, s: number, e: number, score: number) => ({
			point: { payload: { filePath: fp, startLine: s, endLine: e } },
			score,
			range: { s, e } as { s: number; e: number } | null,
		});

		test('merges same-file windows that strictly intersect, keeping the higher score', () => {
			const { kept, merged } = dropOverlappingWindows([
				hit('a.ts', 183, 213, 0.9),
				hit('a.ts', 184, 214, 0.85),
			], key);
			expect(kept).toHaveLength(1);
			expect(kept[0].score).toBe(0.9);
			expect(merged).toBe(1);
		});

		test('adjacent-but-disjoint windows are BOTH kept — adjacency is not overlap', () => {
			// The stored chunks of the measured defect were ADJACENT lines; the merge
			// catches them via their EXPANDED ranges (e2e below), never by treating
			// adjacency alone as duplication. Consecutive single-line chunks (the
			// diversification fixture uses lines 1,2,3) must survive.
			const { kept, merged } = dropOverlappingWindows([
				hit('a.ts', 10, 20, 0.9),
				hit('a.ts', 21, 30, 0.85),
			], key);
			expect(kept).toHaveLength(2);
			expect(merged).toBe(0);
		});

		test('distant chunks of the same file are kept (the per-file cap still governs them)', () => {
			const { kept, merged } = dropOverlappingWindows([
				hit('a.ts', 922, 925, 0.9),
				hit('a.ts', 1162, 1177, 0.85),
			], key);
			expect(kept).toHaveLength(2);
			expect(merged).toBe(0);
		});

		test('compiled vintages of the same logical file share the merge key', () => {
			// capKeyOf strips build-<hash>/ and build-out/ — the same passage in two
			// vintages is one echo, exactly like the same passage twice in one file.
			const stripVintage = (fp: string) => fp.replace(/build(-[a-f0-9]{8,}|-out)\//g, '');
			const { kept, merged } = dropOverlappingWindows([
				hit('build-aaa11111/foo.ts', 5, 9, 0.9),
				hit('build-out/foo.ts', 5, 9, 0.85),
			], stripVintage);
			expect(kept).toHaveLength(1);
			expect(merged).toBe(1);
		});

		test('hits without a usable range are kept as-is', () => {
			const noRange = { point: { payload: { filePath: 'a.json' } }, score: 0.9, range: null };
			const { kept, merged } = dropOverlappingWindows([noRange], key);
			expect(kept).toHaveLength(1);
			expect(merged).toBe(0);
		});

		test('the kept window shields EVERY later intersecting echo (transitive containment)', () => {
			const { kept, merged } = dropOverlappingWindows([
				hit('a.ts', 100, 200, 0.95),
				hit('a.ts', 150, 160, 0.9),
				hit('a.ts', 190, 210, 0.85),
			], key);
			expect(kept).toHaveLength(1);
			expect(merged).toBe(2);
		});
	});

	describe('overlapping-window merge — end to end (#2609 V2 follow-up)', () => {
		// Same synthetic file as the block-expansion suite: searchSemantic spans
		// lines 5-9; body lines 6 and 7 are ADJACENT stored chunks that both expand
		// to the SAME block — the exact shape measured on golden q3.
		const TS_CONTENT = [
			"import { join } from 'path';",
			'',
			'const VALUE = 42;',
			'',
			'export async function searchSemantic(query: string): Promise<Result> {',
			'\tconst filter = buildFilter(query);',
			'\tconst rows = await joinWithPostgres(filter);',
			'\treturn { rows, filter };',
			'}',
			'',
			'export function other() {',
			'\treturn 1;',
			'}'
		].join('\n');
		const LINE_6 = '\tconst filter = buildFilter(query);';
		const LINE_7 = '\tconst rows = await joinWithPostgres(filter);';

		beforeEach(() => {
			vi.clearAllMocks();
			mockGetQdrantClient.mockReturnValue(mockQdrant);
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([]);
			mockStatSync.mockReturnValue({ size: 1000 });
			mockReadFileSync.mockReturnValue(TS_CONTENT);
			process.env.EMBEDDING_API_KEY = 'test-key';
			mockQdrant.getCollection.mockResolvedValue({ status: 'green' });
			mockEmbeddingCreate.mockResolvedValue({ data: [{ embedding: new Array(8).fill(0.1) }] });
		});

		afterEach(() => {
			delete process.env.EMBEDDING_API_KEY;
		});

		test('adjacent stored lines expanding to the same block yield ONE slot; the freed slot backfills with a distinct file', async () => {
			mockQdrant.query.mockResolvedValue({
				points: [
					{ score: 0.9, payload: { filePath: 'src/search-semantic.tool.ts', codeChunk: LINE_7, startLine: 7, endLine: 7 } },
					{ score: 0.85, payload: { filePath: 'src/search-semantic.tool.ts', codeChunk: LINE_6, startLine: 6, endLine: 6 } },
					{ score: 0.7, payload: { filePath: 'src/bar.ts', codeChunk: 'GONE FROM DISK — anchors nowhere', startLine: 1, endLine: 1 } }
				]
			});

			const result = await handleCodebaseSearch({ query: 'postgres join', workspace: '/ws', limit: 2 });
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('success');
			expect(parsed.overlapping_chunks_merged).toBe(1);
			expect(parsed.results_count).toBe(2);
			// The surviving hit is the higher-scored window, rendered as its block.
			expect(parsed.results[0].file_path).toBe('src/search-semantic.tool.ts');
			expect(parsed.results[0].start_line).toBe(5);
			expect(parsed.results[0].end_line).toBe(9);
			// Without the merge the echo (same file, cap 2 allows it) took the slot;
			// with it, the slot backfills with a DISTINCT file.
			expect(parsed.results[1].file_path).toBe('src/bar.ts');
			expect(parsed.results.filter((r: any) => r.file_path === 'src/search-semantic.tool.ts')).toHaveLength(1);
		});
	});

	// handleCodebaseSearch - outer catch block (embedding errors)
	// ============================================================

	describe('handleCodebaseSearch - embedding error handling', () => {
		beforeEach(() => {
			process.env.EMBEDDING_API_KEY = 'test-key';
			// Collection found successfully
			mockQdrant.getCollection.mockResolvedValue({ status: 'green' });
			// #3279: Reset breaker state between tests to prevent pollution
			resetCodebaseEmbeddingBreaker();
			resetCodebaseEmbeddingClient();
		});

		afterEach(() => {
			delete process.env.EMBEDDING_API_KEY;
			resetCodebaseEmbeddingBreaker();
		});

		test('falls back to text on fetch failed and opens breaker (#3279)', async () => {
			// #3279: fetch failures now trigger text fallback (instead of returning an opaque error).
			// The breaker also opens for CODEBASE_EMBEDDING_CB_TTL_MS so subsequent calls fast-fail.
			mockEmbeddingCreate.mockRejectedValue(new Error('fetch failed: connection refused'));
			mockQdrant.scroll.mockResolvedValue({ points: [] });

			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect((result as any).isError).toBe(false);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.fallback_used).toBe(true);
			expect(parsed.fallback_reason).toBe('embedding_unreachable');

			// Subsequent call should fast-fail via breaker (not 30s wait)
			mockEmbeddingCreate.mockClear();
			const start = Date.now();
			const second = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			const elapsed = Date.now() - start;
			expect(elapsed).toBeLessThan(500);
			expect(mockEmbeddingCreate).not.toHaveBeenCalled();
			const secondParsed = JSON.parse(second.content[0].text);
			expect(secondParsed.status).toBe('embedding_unreachable');
			expect(secondParsed.circuit_breaker.open).toBe(true);
		});

		test('falls back to text on ECONNREFUSED and opens breaker (#3279)', async () => {
			// #3279: Same fallback+breaker behavior for ECONNREFUSED.
			mockEmbeddingCreate.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6333'));
			mockQdrant.scroll.mockResolvedValue({ points: [] });

			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect((result as any).isError).toBe(false);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.fallback_used).toBe(true);

			// Subsequent call: breaker open → fast-fail
			mockEmbeddingCreate.mockClear();
			const second = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect(mockEmbeddingCreate).not.toHaveBeenCalled();
			expect(JSON.parse(second.content[0].text).circuit_breaker.open).toBe(true);
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

		test('returns text-fallback on unexpected exception (#3279)', async () => {
			// #3279: Unexpected errors now go through the text fallback path. With empty mock
			// scroll, the fallback returns success with 0 results — informative, not an opaque error.
			mockEmbeddingCreate.mockRejectedValue(new Error('Unexpected internal error'));
			mockQdrant.scroll.mockResolvedValue({ points: [] });

			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect((result as any).isError).toBe(false);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.fallback_used).toBe(true);
			expect(parsed.fallback_reason).toBe('embedding_unreachable');
			expect(parsed.results_count).toBe(0);
		});

		test('handles non-Error thrown values via text fallback (#3279)', async () => {
			// #3279: Same fallback path for non-Error rejections.
			mockEmbeddingCreate.mockRejectedValue('string error');
			mockQdrant.scroll.mockResolvedValue({ points: [] });

			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect((result as any).isError).toBe(false);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.fallback_used).toBe(true);
		});
	});

	// ============================================================
	// #3279 Circuit-breaker + text fallback
	// ============================================================

	describe('handleCodebaseSearch - circuit-breaker (#3279)', () => {
		beforeEach(() => {
			process.env.EMBEDDING_API_KEY = 'test-key';
			resetCodebaseEmbeddingBreaker();
			resetCodebaseEmbeddingClient();
			mockQdrant.getCollection.mockResolvedValue({ status: 'green' });
		});

		afterEach(() => {
			delete process.env.EMBEDDING_API_KEY;
			resetCodebaseEmbeddingBreaker();
		});

		test('opens breaker after embedding failure', async () => {
			mockEmbeddingCreate.mockRejectedValue(new Error('fetch failed: connection refused'));
			mockQdrant.scroll.mockResolvedValue({ points: [] });

			await handleCodebaseSearch({ query: 'test', workspace: '/ws' });

			// Second call should fast-fail via breaker, NOT hit the embedding API
			mockEmbeddingCreate.mockClear();
			const start = Date.now();
			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			const elapsed = Date.now() - start;

			expect(elapsed).toBeLessThan(500); // Fast-fail, not 30s
			expect(mockEmbeddingCreate).not.toHaveBeenCalled();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('embedding_unreachable');
			expect(parsed.circuit_breaker.open).toBe(true);
		});

		test('fast-fail response includes TTL and alternative path hint', async () => {
			mockEmbeddingCreate.mockRejectedValue(new Error('ECONNREFUSED'));
			mockQdrant.scroll.mockResolvedValue({ points: [] });

			await handleCodebaseSearch({ query: 'test', workspace: '/ws' });

			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.hint).toContain('roosync_search');
			expect(parsed.circuit_breaker.ttl_total_seconds).toBeGreaterThan(0);
		});

		test('closes breaker on embedding success', async () => {
			// First call: embedding fails → breaker opens, fallback tried (empty)
			mockEmbeddingCreate.mockRejectedValueOnce(new Error('ECONNREFUSED'));
			mockQdrant.scroll.mockResolvedValueOnce({ points: [] });
			await handleCodebaseSearch({ query: 'test', workspace: '/ws' });

			// Manually close the breaker (simulating TTL expiry) so the next call actually hits embedding
			resetCodebaseEmbeddingBreaker();

			// Now succeed — should NOT open the breaker
			mockEmbeddingCreate.mockResolvedValue({
				data: [{ embedding: new Array(2560).fill(0.1) }]
			});
			mockQdrant.query.mockResolvedValue({ points: [] });

			await handleCodebaseSearch({ query: 'test', workspace: '/ws' });

			// Breaker should still be closed — embedding was called and succeeded
			mockEmbeddingCreate.mockClear();
			mockQdrant.query.mockResolvedValue({ points: [] });
			await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect(mockEmbeddingCreate).toHaveBeenCalled();
		});
	});

	describe('handleCodebaseSearch - text fallback (#3279)', () => {
		beforeEach(() => {
			process.env.EMBEDDING_API_KEY = 'test-key';
			resetCodebaseEmbeddingBreaker();
			resetCodebaseEmbeddingClient();
			mockQdrant.getCollection.mockResolvedValue({ status: 'green' });
		});

		afterEach(() => {
			delete process.env.EMBEDDING_API_KEY;
			resetCodebaseEmbeddingBreaker();
		});

		test('text fallback returns token-matched results when embedding fails', async () => {
			mockEmbeddingCreate.mockRejectedValue(new Error('fetch failed'));
			mockQdrant.scroll.mockResolvedValue({
				points: [
					{
						payload: {
							filePath: 'src/services/auth.ts',
							codeChunk: 'function authenticate(user, token) { return verifyToken(token); }',
							startLine: 1,
							endLine: 5,
							pathSegments: { '0': 'src', '1': 'services' }
						}
					},
					{
						payload: {
							filePath: 'src/utils/helpers.ts',
							codeChunk: '// unrelated content here',
							startLine: 1,
							endLine: 3,
							pathSegments: { '0': 'src', '1': 'utils' }
						}
					}
				]
			});

			const result = await handleCodebaseSearch({ query: 'authenticate user token', workspace: '/ws' });
			expect((result as any).isError).toBe(false);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.fallback_used).toBe(true);
			expect(parsed.fallback_reason).toBe('embedding_unreachable');
			expect(parsed.results_count).toBeGreaterThan(0);
			expect(parsed.results[0].file_path).toBe('src/services/auth.ts');
			expect(parsed.results[0].matched_tokens).toEqual(expect.arrayContaining(['authenticate', 'user', 'token']));
		});

		test('text fallback returns empty results when no token matches', async () => {
			mockEmbeddingCreate.mockRejectedValue(new Error('ECONNREFUSED'));
			mockQdrant.scroll.mockResolvedValue({
				points: [
					{ payload: { filePath: 'a.ts', codeChunk: 'completely unrelated code' } }
				]
			});

			const result = await handleCodebaseSearch({ query: 'xyzzy plover', workspace: '/ws' });
			expect((result as any).isError).toBe(false);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.fallback_used).toBe(true);
			expect(parsed.results_count).toBe(0);
		});

		test('text fallback returns error when fallback scroll also fails', async () => {
			mockEmbeddingCreate.mockRejectedValue(new Error('fetch failed'));
			mockQdrant.scroll.mockRejectedValue(new Error('Qdrant also down'));

			const result = await handleCodebaseSearch({ query: 'test', workspace: '/ws' });
			expect((result as any).isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('embedding_unreachable');
		});
	});
});

// ============================================================
// #3344 — transport resilience, hash convergence, filtered search
// ============================================================

describe('#3344 transport resilience + hash convergence', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetQdrantClient.mockReturnValue(mockQdrant);
		mockExistsSync.mockReturnValue(true);
		mockReaddirSync.mockReturnValue([]);
	});

	test('transient fetch failed on getCollection is retried once, search succeeds', async () => {
		process.env.EMBEDDING_API_KEY = 'test-key';
		try {
			let calls = 0;
			mockQdrant.getCollection.mockImplementation(async () => {
				calls++;
				if (calls === 1) {
					const inner: any = new Error('read ECONNRESET'); inner.code = 'ECONNRESET';
					const outer: any = new TypeError('fetch failed'); outer.cause = inner;
					throw outer;
				}
				return { status: 'green', points_count: 10 };
			});
			mockEmbeddingCreate.mockResolvedValue({ data: [{ embedding: new Array(8).fill(0.1) }] });
			mockQdrant.query.mockResolvedValue({ points: [] });

			const result = await handleCodebaseSearch({ query: 'foo', workspace: '/ws' });
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('success');
			expect(calls).toBe(2); // exactly one retry, then success
		} finally {
			delete process.env.EMBEDDING_API_KEY;
		}
	});

	test('persistent transport failure surfaces classified error with real errno', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error('probe refused'));
		vi.stubGlobal('fetch', fetchMock);
		try {
			const inner: any = new Error('connect ETIMEDOUT 1.2.3.4:443'); inner.code = 'ETIMEDOUT';
			const outer: any = new TypeError('fetch failed'); outer.cause = inner;
			mockQdrant.getCollection.mockRejectedValue(outer);

			const result = await handleCodebaseSearch({ query: 'foo', workspace: '/ws' });
			const parsed = JSON.parse(result.content[0].text);
			expect(result.isError).toBe(true);
			expect(parsed.status).toBe('qdrant_unreachable');
			expect(parsed.message).toContain('ETIMEDOUT');
		} finally {
			vi.unstubAllGlobals();
		}
	});

	test('hash convergence: lowercase-backslash, forward-slash and canonical Windows fsPath forms converge', () => {
		// Criterion added in #3344 (comment 15:11Z): the hash produced for the
		// lowercase-backslash, forward-slash and canonical Windows fsPath forms must
		// converge — every form's variant set contains the canonical fsPath hash, so
		// whatever form the caller passes, the real indexed collection is reachable.
		const fsPathCanonical = 'D:\\dev\\CoursIA-2';
		const fwdSlash = 'D:/dev/CoursIA-2';
		const lowerBackslash = 'd:\\dev\\CoursIA-2';
		const lowerFwd = 'd:/dev/CoursIA-2';

		const canonicalHash = getWorkspaceCollectionName(fsPathCanonical);
		const fwdHash = getWorkspaceCollectionName(fwdSlash);

		const vCanonical = getWorkspaceCollectionVariants(fsPathCanonical);
		const vFwd = getWorkspaceCollectionVariants(fwdSlash);
		const vLowerBack = getWorkspaceCollectionVariants(lowerBackslash);
		const vLowerFwd = getWorkspaceCollectionVariants(lowerFwd);

		// Canonical fsPath hash reachable from every input form
		expect(vCanonical).toContain(canonicalHash);
		expect(vFwd).toContain(canonicalHash);
		expect(vLowerBack).toContain(canonicalHash);
		expect(vLowerFwd).toContain(canonicalHash);
		// Forward-slash canonical hash reachable too
		expect(vCanonical).toContain(fwdHash);
		expect(vLowerBack).toContain(fwdHash);
		// Double-escaped input (JSON/MCP passing) also converges
		const doubleEscaped = getWorkspaceCollectionVariants('d:\\\\dev\\\\CoursIA-2');
		expect(doubleEscaped).toContain(canonicalHash);
	});

	test('filtered search on a CoursIA-2 workspace applies pathSegments filter and returns results', async () => {
		process.env.EMBEDDING_API_KEY = 'test-key';
		try {
			mockQdrant.getCollection.mockResolvedValue({ status: 'green', points_count: 42 });
			mockEmbeddingCreate.mockResolvedValue({ data: [{ embedding: new Array(8).fill(0.1) }] });
			mockQdrant.query.mockResolvedValue({
				points: [{
					score: 0.75,
					payload: { filePath: 'scripts/deploy.ps1', codeChunk: 'param($Workspace)', startLine: 1, endLine: 3 }
				}]
			});

			const result = await handleCodebaseSearch({
				query: 'coordination adjoint dispatch workflow',
				workspace: 'D:\\dev\\CoursIA-2',
				directory_prefix: 'scripts'
			});
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('success');
			expect(parsed.results_count).toBe(1);
			// The directory filter must be translated into indexed pathSegments keys
			expect(mockQdrant.query).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					filter: expect.objectContaining({
						must: [{ key: 'pathSegments.0', match: { value: 'scripts' } }]
					})
				})
			);
		} finally {
			delete process.env.EMBEDDING_API_KEY;
		}
	});

	// ============================================================
	// #2609 V2(a) — query-time block expansion
	// ============================================================
	describe('block expansion (#2609 V2(a))', () => {
		// Synthetic TS file: the anchor line lives INSIDE searchSemantic (line 7, 1-based).
		// The nearest declaration above is the export function on line 5; braces close on line 9.
		const TS_CONTENT = [
			"import { join } from 'path';",
			'',
			'const VALUE = 42;',
			'',
			'export async function searchSemantic(query: string): Promise<Result> {',
			'\tconst filter = buildFilter(query);',
			'\tconst rows = await joinWithPostgres(filter);',
			'\treturn { rows, filter };',
			'}',
			'',
			'export function other() {',
			'\treturn 1;',
			'}'
		].join('\n');
		const ANCHOR_1BASED = 7; // '\tconst rows = await joinWithPostgres(filter);'
		const ANCHOR_LINE = '\tconst rows = await joinWithPostgres(filter);';

		beforeEach(() => {
			vi.clearAllMocks();
			mockGetQdrantClient.mockReturnValue(mockQdrant);
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([]);
			mockStatSync.mockReturnValue({ size: 1000 });
			mockReadFileSync.mockReturnValue(TS_CONTENT);
			process.env.EMBEDDING_API_KEY = 'test-key';
			mockQdrant.getCollection.mockResolvedValue({ status: 'green' });
			mockEmbeddingCreate.mockResolvedValue({ data: [{ embedding: new Array(8).fill(0.1) }] });
		});

		afterEach(() => {
			delete process.env.CODEBASE_BLOCK_EXPANSION;
			delete process.env.EMBEDDING_API_KEY;
		});

		test('handler renders the enclosing declaration block, not the matched line', async () => {
			mockQdrant.query.mockResolvedValue({
				points: [{
					score: 0.8,
					payload: { filePath: 'src/search-semantic.tool.ts', codeChunk: ANCHOR_LINE, startLine: ANCHOR_1BASED, endLine: ANCHOR_1BASED }
				}]
			});

			const result = await handleCodebaseSearch({ query: 'postgres join', workspace: '/ws' });
			const parsed = JSON.parse(result.content[0].text);

			expect(parsed.status).toBe('success');
			expect(parsed.block_expansion_applied).toBe(1);
			const hit = parsed.results[0];
			// Handle upgraded to the BLOCK range (the whole function), not the single-line chunk
			expect(hit.start_line).toBe(5);
			expect(hit.end_line).toBe(9);
			expect(hit.lines).toBe('5-9');
			// The line(s) the vector matched stay visible
			expect(hit.match_lines).toBe('7-7');
			// The snippet is the block passage: declaration + body + closing brace
			expect(hit.snippet).toContain('export async function searchSemantic');
			expect(hit.snippet).toContain('joinWithPostgres');
			expect(hit.snippet).toContain('}');
			expect(hit.snippet.length).toBeGreaterThan(150);
		});

		test('stale index (anchor not locatable) degrades to the raw chunk snippet', async () => {
			// Chunk text that exists NOWHERE in the current file → verification must fail
			mockQdrant.query.mockResolvedValue({
				points: [{
					score: 0.8,
					payload: { filePath: 'src/search-semantic.tool.ts', codeChunk: 'GONE FROM DISK ages ago', startLine: ANCHOR_1BASED, endLine: ANCHOR_1BASED }
				}]
			});

			const result = await handleCodebaseSearch({ query: 'postgres join', workspace: '/ws' });
			const parsed = JSON.parse(result.content[0].text);

			expect(parsed.block_expansion_applied).toBeUndefined();
			const hit = parsed.results[0];
			// Raw shape preserved: stored (single-line) chunk lines, no match_lines
			expect(hit.start_line).toBe(ANCHOR_1BASED);
			expect(hit.end_line).toBe(ANCHOR_1BASED);
			expect(hit.match_lines).toBeUndefined();
			expect(hit.snippet).toContain('GONE FROM DISK');
		});

		test('data/config files keep the raw shape (no block structure, no expansion)', async () => {
			mockQdrant.query.mockResolvedValue({
				points: [{
					score: 0.8,
					payload: { filePath: 'roo-config/baselines/idx.json', codeChunk: '"codebaseIndexQdrantUrl": "http://localhost:6333"', startLine: 3, endLine: 3 }
				}]
			});

			const result = await handleCodebaseSearch({ query: 'qdrant url', workspace: '/ws', min_score: 0.2 });
			const parsed = JSON.parse(result.content[0].text);

			expect(parsed.block_expansion_applied).toBeUndefined();
			// readFileSync must never be called for a data file
			expect(mockReadFileSync).not.toHaveBeenCalled();
		});

		test('CODEBASE_BLOCK_EXPANSION=0 disables expansion (rollback env)', async () => {
			process.env.CODEBASE_BLOCK_EXPANSION = '0';
			mockQdrant.query.mockResolvedValue({
				points: [{
					score: 0.8,
					payload: { filePath: 'src/search-semantic.tool.ts', codeChunk: ANCHOR_LINE, startLine: ANCHOR_1BASED, endLine: ANCHOR_1BASED }
				}]
			});

			const result = await handleCodebaseSearch({ query: 'postgres join', workspace: '/ws' });
			const parsed = JSON.parse(result.content[0].text);

			expect(parsed.block_expansion_applied).toBeUndefined();
			expect(parsed.results[0].match_lines).toBeUndefined();
			expect(parsed.results[0].start_line).toBe(ANCHOR_1BASED);
		});

		test('oversized file (statSync > 2MB) skips expansion', () => {
			mockStatSync.mockReturnValue({ size: 3 * 1024 * 1024 });
			const cache = new Map<string, string[] | null>();
			const out = expandHitBlock('src/foo.ts', ANCHOR_1BASED, ANCHOR_LINE, '/ws', cache);
			expect(out).toBeNull();
			expect(mockReadFileSync).not.toHaveBeenCalled();
		});

		test('computeBlockRange: braceless language (python def) closes on dedent', () => {
			const py = [
				'import os',
				'',
				'def run():',
				'    a = 1',
				'    b = 2',
				'',
				'x = 3'
			];
			// anchor on 'b = 2' (idx 4) → block = def run() .. idx 4 (blank line at 5 stops it)
			const range = computeBlockRange(py, 4);
			expect(range).toEqual({ startIdx: 2, endIdx: 4 });
		});

		test('computeBlockRange: blank-line fallback when no declaration above', () => {
			const lines = ['let a = 1;', 'let b = 2;', 'let c = 3;', '', 'let d = 4;'];
			const range = computeBlockRange(lines, 1);
			expect(range).toEqual({ startIdx: 0, endIdx: 2 });
		});

		test('computeBlockRange: declaration that CLOSES BEFORE the anchor falls back (compiled-JS live case)', () => {
			// Live eval finding (2026-09-27, golden scenario 3): on compiled build-* JS the
			// decl regex latched onto a function above whose braces close before the anchor
			// line — the anchor lives in the NEXT (anonymous, var-assigned) function.
			// The guard must reject that block and serve the anchor-containing window.
			const compiled = [
				'function firstBlock(diffs) {', // idx 0 — matches DECL
				'  const a = 1;',
				'  return a;',
				'}',                            // idx 3 — firstBlock closes here
				'',
				'var handler = function() {',   // idx 5 — NOT matched by the decl regexes (var-assigned)
				'  doWork(target);',            // idx 6 — ANCHOR
				'  return true;',
				'};'
			];
			const range = computeBlockRange(compiled, 6);
			// The naive decl walk would return {0,3} — a block NOT containing the anchor.
			expect(range).toEqual({ startIdx: 5, endIdx: 8 });
		});

		test('verifyAnchor: segment chunk (substring of a long line) verifies via containment', () => {
			const lines = ['const config = {"qdrant": "localhost:6333", "pg": "postgres://user:pass@host/db", "retries": 3};'];
			// A segment chunk of that line — not equal to the whole line, but contained in it
			const segmentChunk = '"pg": "postgres://user:pass@host/db", "retries": 3};';
			expect(verifyAnchor(lines, 0, segmentChunk)).toBe(true);
			expect(verifyAnchor(lines, 0, 'TOTALLY ABSENT TEXT')).toBe(false);
		});

		test('renderBlock: oversized block windows around the anchor with omission markers', () => {
			const lines: string[] = ['export function huge() {'];
			for (let i = 0; i < 118; i++) lines.push(`\tline${i}();`);
			lines.push('}');
			const range = computeBlockRange(lines, 60);
			expect(range).toEqual({ startIdx: 0, endIdx: 119 });
			const rendered = renderBlock(lines, range!, 60)!;
			expect(rendered).not.toBeNull();
			// Bounded render: ≤ 80 lines + 2 marker lines
			const renderedLineCount = rendered.text.split('\n').length;
			expect(renderedLineCount).toBeLessThanOrEqual(80 + 2);
			// Markers present and honest
			expect(rendered.text).toMatch(/\[\.\.\. \d+ lines above/);
			expect(rendered.text).toMatch(/\[\.\.\. \d+ lines below/);
			// The anchor stays inside the rendered window
			expect(rendered.text).toContain('line59();');
			// 1-based handle covers the rendered window only
			expect(rendered.endLine - rendered.startLine + 1).toBeLessThanOrEqual(80);
		});

		test('renderBlock: char budget shrinks a long-line block around the anchor (positive control)', () => {
			// 60 lines x ~100 chars = ~6 000 chars: over the 3 000-char budget, but each line is short
			// enough that a line-bounded window fits — the loop must shrink it, not give up.
			const lines: string[] = ['export function wide() {'];
			for (let i = 0; i < 60; i++) lines.push(`\tconst v${i} = '${'y'.repeat(80)}';`);
			lines.push('}');
			const range = computeBlockRange(lines, 30);
			const rendered = renderBlock(lines, range!, 30);
			expect(rendered).not.toBeNull();
			const body = rendered!.text.split('\n').filter(l => !l.startsWith('[... ')).join('\n');
			expect(body.length).toBeLessThanOrEqual(3000);
			expect(rendered!.text).toContain('const v29 =');
		});

		test('renderBlock: a single 500 KB line (minified bundle) → null, never an unbounded render', () => {
			const lines = ['var a=' + 'x'.repeat(500_000) + ';'];
			const range = computeBlockRange(lines, 0);
			expect(range).toEqual({ startIdx: 0, endIdx: 0 });
			expect(renderBlock(lines, range!, 0)).toBeNull();
		});

		test('renderBlock: 5 lines of 1 KB each (below the 5-line floor, over budget) → null', () => {
			const lines = Array.from({ length: 5 }, (_, i) => `const k${i} = '${'z'.repeat(1024)}';`);
			const range = { startIdx: 0, endIdx: 4 };
			expect(renderBlock(lines, range, 2)).toBeNull();
		});

		test('handler: a hit on a minified one-liner keeps the bounded raw snippet (no 500 KB result)', async () => {
			const minified = 'var a=' + 'x'.repeat(500_000) + ';';
			mockReadFileSync.mockReturnValue(minified);
			mockQdrant.query.mockResolvedValue({
				points: [{
					score: 0.8,
					payload: { filePath: 'dist/bundle.min.js', codeChunk: 'x'.repeat(1000), startLine: 1, endLine: 1 }
				}]
			});

			const result = await handleCodebaseSearch({ query: 'bundle', workspace: '/ws' });
			const parsed = JSON.parse(result.content[0].text);

			expect(parsed.status).toBe('success');
			expect(parsed.block_expansion_applied).toBeUndefined();
			const hit = parsed.results[0];
			expect(hit.match_lines).toBeUndefined();
			expect(hit.snippet.length).toBeLessThanOrEqual(600);
			expect(result.content[0].text.length).toBeLessThan(10_000);
		});

		test('anchor beyond EOF (file shrank since indexing) → null', () => {
			const cache = new Map<string, string[] | null>();
			const out = expandHitBlock('src/foo.ts', 9999, ANCHOR_LINE, '/ws', cache);
			expect(out).toBeNull();
		});

		test('unreadable file → null, and the miss is cached (one stat attempt per file)', () => {
			mockStatSync.mockImplementation(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
			const cache = new Map<string, string[] | null>();
			expect(expandHitBlock('src/foo.ts', 1, 'whatever', '/ws', cache)).toBeNull();
			expect(expandHitBlock('src/foo.ts', 1, 'whatever', '/ws', cache)).toBeNull();
			expect(mockStatSync).toHaveBeenCalledTimes(1);
		});
	});
});
