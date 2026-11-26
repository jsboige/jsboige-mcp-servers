/**
 * #4880 — the content-match sweep is paid on EVERY search, and nothing cached it.
 *
 * Measured ai-01, 23/11 13:20Z (read-only): for the workspace `d:/roo-extensions` NO
 * `ws-*` collection matches any of the 4 hash spellings (each answers 404 in <30 ms),
 * so EVERY `codebase_search` runs the content-match fallback. The fallback probes up
 * to 64 candidates SERIALLY, one 200-point payload-only scroll each. On a cold Qdrant
 * the 3 largest collections each burned the 15 000 ms client timeout (15 014 / 15 006 /
 * 15 002 ms) while every other candidate answered in ~10 ms — ~47 s in total, so the
 * call hit its 50 s deadline (`qdrant_backend_slow`, phase `content_match_fallback`).
 * A warm pass took 6.3 s and resolved by `content-match` — but the resolution was
 * never cached, so every call re-paid the whole sweep.
 *
 * Two fixes are pinned here:
 *  (1) a PER-CANDIDATE bound on the signature scroll — a cold candidate is skipped
 *      (never allowed to eat the whole call) and COUNTED (`unprobed_candidates`), so a
 *      miss caused by cold candidates is visible instead of silent;
 *  (2) an in-process TTL cache of a SUCCESSFUL content-match resolution — the second
 *      search for the same workspace re-runs no sweep probe at all.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetQdrantClient, mockQdrant, mockEmbeddingCreate, mockExistsSync, mockReaddirSync, mockReadFileSync, mockStatSync } = vi.hoisted(() => ({
	mockGetQdrantClient: vi.fn(),
	mockQdrant: { getCollection: vi.fn(), query: vi.fn(), getCollections: vi.fn(), scroll: vi.fn() },
	mockEmbeddingCreate: vi.fn(),
	// Default: every file reachable (keeps the liveness probe out of the way).
	mockExistsSync: vi.fn(() => true),
	// Default: no workspace dirs → the content-match signature is empty. Each test sets its own.
	mockReaddirSync: vi.fn(() => []),
	mockReadFileSync: vi.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
	mockStatSync: vi.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); })
}));

const { mockExecFile, gitFails } = vi.hoisted(() => {
	const gitFails = (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string) => void) =>
		cb(Object.assign(new Error('not a git repository'), { code: 128 }));
	return { mockExecFile: vi.fn(gitFails), gitFails };
});

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return { ...actual, execFile: mockExecFile };
});

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
	handleCodebaseSearch,
	findCollectionByContent,
	_resetContentMatchCacheForTests,
} from '../search-codebase.tool.js';

/**
 * A SIGNATURE scroll asks for `pathSegments` (+`filePath`). The coverage count asks
 * for `filePath` only, and the ws-writer sentinel asks for the whole payload — so
 * naming the subject by what it ASKS for counts the sweep and nothing else.
 */
const isSignatureScroll = (opts: any): boolean => {
	const include = opts?.with_payload?.include;
	return Array.isArray(include) && include.includes('pathSegments');
};

const countSignatureScrolls = (): number =>
	mockQdrant.scroll.mock.calls.filter(c => isSignatureScroll(c[1])).length;

describe('#4880 — content-match: bounded candidate probe + resolution cache', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetQdrantClient.mockReturnValue(mockQdrant);
		mockExistsSync.mockReturnValue(true);
		// The writer-sentinel probe is a separate feature; disabling it keeps this
		// file's scroll accounting to the sweep alone.
		process.env.WRITER_SIGNAL = '0';
		process.env.EMBEDDING_API_KEY = 'test-key';
		mockEmbeddingCreate.mockResolvedValue({ data: [{ embedding: new Array(8).fill(0.1) }] });
		// The module-level cache is process state — reset it between cases.
		_resetContentMatchCacheForTests?.();
	});

	afterEach(() => {
		delete process.env.WRITER_SIGNAL;
		delete process.env.EMBEDDING_API_KEY;
		delete process.env.CONTENT_MATCH_SIGNATURE_TIMEOUT_MS;
		delete process.env.CONTENT_MATCH_RESOLUTION_CACHE_TTL_MS;
	});

	// ============================================================
	// (1) The per-candidate bound — findCollectionByContent
	// ============================================================

	describe('findCollectionByContent — a cold candidate is skipped, not awaited', () => {
		test('a candidate whose scroll never resolves is skipped after the bound, and a later candidate still matches', async () => {
			process.env.CONTENT_MATCH_SIGNATURE_TIMEOUT_MS = '30';
			// A scroll that NEVER settles — the cold-cache shape (the client timeout
			// was 15 000 ms, far past the search deadline).
			const neverResolves = new Promise(() => {});
			mockQdrant.scroll.mockImplementation(async (name: string) => {
				if (name === 'ws-cold') return neverResolves;
				return { points: [
					{ payload: { pathSegments: { '0': 'mcps' } } },
					{ payload: { pathSegments: { '0': 'roo-code' } } },
					{ payload: { pathSegments: { '0': 'docs' } } },
				] };
			});

			const workspaceSignature = new Set(['mcps', 'roo-code', 'docs', 'scripts']);
			const match = await findCollectionByContent(
				mockQdrant,
				['ws-cold', 'ws-warm'],
				workspaceSignature
			);

			// The cold candidate did not eat the call — the warm one still matched.
			expect(match).not.toBeNull();
			expect(match!.name).toBe('ws-warm');
			// The skipped candidate is COUNTED: a miss caused by cold candidates must be visible.
			expect(match!.unprobed_candidates).toBe(1);
		});

		test('the count is reported even when the sweep finds no match at all', async () => {
			process.env.CONTENT_MATCH_SIGNATURE_TIMEOUT_MS = '30';
			const neverResolves = new Promise(() => {});
			mockQdrant.scroll.mockImplementation(async (name: string) => {
				if (name === 'ws-cold') return neverResolves;
				// A collection whose dirs never intersect the workspace's.
				return { points: [{ payload: { pathSegments: { '0': 'unrelated' } } }] };
			});

			const workspaceSignature = new Set(['mcps', 'roo-code']);
			const stats = { unprobed_candidates: 0 };
			const match = await findCollectionByContent(
				mockQdrant,
				['ws-cold', 'ws-unrelated'],
				workspaceSignature,
				undefined,
				stats
			);

			expect(match).toBeNull();
			// A MISS caused by cold candidates must be visible — the count is the
			// only difference between "no collection matches" and "the candidates
			// were cold".
			expect(stats.unprobed_candidates).toBe(1);
		});
	});

	// ============================================================
	// (2) The resolution cache — codebase_search
	// ============================================================

	describe('handleCodebaseSearch — the resolution is cached per workspace', () => {
		/** A hash miss on every spelling + one collection whose dirs match the workspace. */
		const primeContentMatch = () => {
			mockReaddirSync.mockReturnValue([
				{ name: 'roo-code', isDirectory: () => true },
				{ name: 'mcps', isDirectory: () => true },
				{ name: 'roo-config', isDirectory: () => true },
				{ name: 'docs', isDirectory: () => true },
			]);
			mockQdrant.getCollections.mockResolvedValue({
				collections: [{ name: 'ws-contentmatched' }, { name: 'ws-unrelated' }]
			});
			mockQdrant.getCollection.mockImplementation(async (name: string) => {
				if (name === 'ws-contentmatched') return { points_count: 9000, status: 'green' };
				if (name === 'ws-unrelated') return { points_count: 100, status: 'green' };
				throw Object.assign(new Error(`Collection ${name} not found`), { status: 404 });
			});
			mockQdrant.scroll.mockImplementation(async (name: string) => {
				if (name === 'ws-contentmatched') {
					return { points: [
						{ payload: { pathSegments: { '0': 'mcps' } } },
						{ payload: { pathSegments: { '0': 'roo-code' } } },
						{ payload: { pathSegments: { '0': 'roo-config' } } },
						{ payload: { pathSegments: { '0': 'docs' } } },
					] };
				}
				return { points: [{ payload: { pathSegments: { '0': 'src' } } }] };
			});
			mockQdrant.query.mockResolvedValue({
				points: [{
					score: 0.82,
					payload: { filePath: 'mcps/internal/foo.ts', codeChunk: 'export const foo = 1', startLine: 1, endLine: 2 }
				}]
			});
		};

		test('a second search for the same workspace within the TTL re-runs no sweep probe and reports cached: true', async () => {
			process.env.CONTENT_MATCH_RESOLUTION_CACHE_TTL_MS = '60000';
			primeContentMatch();

			const first = JSON.parse((await handleCodebaseSearch({ query: 'foo', workspace: '/ws/cm-cache-hit' })).content[0].text);
			expect(first.status).toBe('success');
			expect(first.collection_resolved_by).toBe('content-match');
			// The first resolution was FRESH — nothing was cached yet.
			expect(first.content_match.cached).toBeUndefined();

			const scrollsAfterFirst = countSignatureScrolls();
			const listingsAfterFirst = mockQdrant.getCollections.mock.calls.length;
			expect(scrollsAfterFirst).toBeGreaterThan(0);

			const second = JSON.parse((await handleCodebaseSearch({ query: 'bar', workspace: '/ws/cm-cache-hit' })).content[0].text);
			expect(second.status).toBe('success');
			expect(second.collection_resolved_by).toBe('content-match');
			expect(second.collection).toBe(first.collection);
			// The whole sweep is skipped — no signature scroll, no collection listing.
			expect(second.content_match.cached).toBe(true);
			expect(countSignatureScrolls()).toBe(scrollsAfterFirst);
			expect(mockQdrant.getCollections.mock.calls.length).toBe(listingsAfterFirst);
		});

		test('CONTENT_MATCH_RESOLUTION_CACHE_TTL_MS=0 disables the cache (kill-switch)', async () => {
			primeContentMatch();

			// With a TTL, the second search is served from the cache — this proves the
			// mechanism is there before the kill-switch is exercised on the SAME
			// workspace.
			process.env.CONTENT_MATCH_RESOLUTION_CACHE_TTL_MS = '60000';
			const first = JSON.parse((await handleCodebaseSearch({ query: 'foo', workspace: '/ws/cm-cache-disabled' })).content[0].text);
			expect(first.collection_resolved_by).toBe('content-match');
			expect(first.content_match.cached).toBeUndefined();
			const cached = JSON.parse((await handleCodebaseSearch({ query: 'bar', workspace: '/ws/cm-cache-disabled' })).content[0].text);
			expect(cached.content_match.cached).toBe(true);
			const scrollsWhileCached = countSignatureScrolls();

			// Kill-switch: the cache is off — the same workspace is swept again.
			process.env.CONTENT_MATCH_RESOLUTION_CACHE_TTL_MS = '0';
			const uncached = JSON.parse((await handleCodebaseSearch({ query: 'baz', workspace: '/ws/cm-cache-disabled' })).content[0].text);
			expect(uncached.collection_resolved_by).toBe('content-match');
			expect(uncached.content_match.cached).toBeUndefined();
			// The sweep ran again — the cache is off.
			expect(countSignatureScrolls()).toBeGreaterThan(scrollsWhileCached);
			expect(mockQdrant.getCollections.mock.calls.length).toBe(2);
		});

		test('a match found by a PARTIAL sweep (a cold candidate skipped) is not cached', async () => {
			process.env.CONTENT_MATCH_RESOLUTION_CACHE_TTL_MS = '60000';
			process.env.CONTENT_MATCH_SIGNATURE_TIMEOUT_MS = '30';
			primeContentMatch();
			// A larger cold candidate, probed first (points desc): it might be the live
			// collection, so a match chosen without it must not be pinned for the TTL.
			const neverResolves = new Promise(() => {});
			mockQdrant.getCollections.mockResolvedValue({
				collections: [{ name: 'ws-cold-big' }, { name: 'ws-contentmatched' }, { name: 'ws-unrelated' }]
			});
			const baseGetCollection = mockQdrant.getCollection.getMockImplementation()!;
			mockQdrant.getCollection.mockImplementation(async (name: string) =>
				name === 'ws-cold-big' ? { points_count: 50000, status: 'green' } : baseGetCollection(name));
			const baseScroll = mockQdrant.scroll.getMockImplementation()!;
			mockQdrant.scroll.mockImplementation(async (name: string, opts: any) =>
				name === 'ws-cold-big' ? neverResolves : baseScroll(name, opts));

			const first = JSON.parse((await handleCodebaseSearch({ query: 'foo', workspace: '/ws/cm-cache-partial' })).content[0].text);
			expect(first.collection_resolved_by).toBe('content-match');
			expect(first.collection).toBe('ws-contentmatched');
			expect(first.content_match.unprobed_candidates).toBe(1);

			const second = JSON.parse((await handleCodebaseSearch({ query: 'bar', workspace: '/ws/cm-cache-partial' })).content[0].text);
			// Not served from the cache — the sweep ran again.
			expect(second.content_match.cached).toBeUndefined();
			expect(mockQdrant.getCollections.mock.calls.length).toBe(2);
		});

		test('a miss is never cached — the next search re-runs the sweep', async () => {
			process.env.CONTENT_MATCH_RESOLUTION_CACHE_TTL_MS = '60000';
			process.env.CONTENT_MATCH_SIGNATURE_TIMEOUT_MS = '30';
			// Every workspace dir is GENERIC → no discriminant dir → the strict gate
			// can never accept → an honest miss. The only candidate is COLD (its
			// scroll never settles) — the shape measured on ai-01.
			const neverResolves = new Promise(() => {});
			mockReaddirSync.mockReturnValue([
				{ name: 'src', isDirectory: () => true },
				{ name: 'docs', isDirectory: () => true },
				{ name: 'tests', isDirectory: () => true },
			]);
			mockQdrant.getCollections.mockResolvedValue({ collections: [{ name: 'ws-someone' }] });
			mockQdrant.getCollection.mockImplementation(async (name: string) => {
				if (name === 'ws-someone') return { points_count: 500, status: 'green' };
				throw Object.assign(new Error(`Collection ${name} not found`), { status: 404 });
			});
			mockQdrant.scroll.mockImplementation(async () => neverResolves);

			const first = JSON.parse((await handleCodebaseSearch({ query: 'x', workspace: '/ws/cm-cache-miss' })).content[0].text);
			expect(first.status).toBe('collection_not_found');
			expect(first.content_match).toBeUndefined();
			// The miss says WHY it missed: the only candidate was cold.
			expect(first.content_match_unprobed_candidates).toBe(1);

			const second = JSON.parse((await handleCodebaseSearch({ query: 'x', workspace: '/ws/cm-cache-miss' })).content[0].text);
			expect(second.status).toBe('collection_not_found');
			// The miss was not cached — the sweep ran again.
			expect(mockQdrant.getCollections.mock.calls.length).toBe(2);
		});
	});
});
