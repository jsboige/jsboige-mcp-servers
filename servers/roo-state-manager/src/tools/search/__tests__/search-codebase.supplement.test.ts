/**
 * #4352 (a3): the supplement corpus inside `codebase_search`.
 *
 * What is pinned here:
 *  - the supplement is queried with the SAME query vector, the SAME limit and the
 *    SAME score threshold as the main collection (a second vector or a laxer
 *    threshold would make the two corpora incomparable);
 *  - its hits are MERGED into the one ranked pool and labelled `index: 'supplement'`
 *    (labelled by origin, never privileged: they pass the same maluses and cap);
 *  - the response carries `supplement: {collection, points, hits}` whenever a
 *    supplement collection exists;
 *  - the whole thing is FAIL-OPEN: an unreachable supplement, or a workspace with
 *    no remote, leaves the search's own answer intact.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockQdrant, mockEmbeddingCreate, mockExecFile, state } = vi.hoisted(() => {
	const state = {
		originUrl: 'https://github.com/jsboige/roo-extensions.git' as string | null,
		// NUL-separated `git ls-files` output; null = not a git workspace (coverage walk off)
		gitFiles: null as string | null,
	};
	const mockExecFile = vi.fn((_cmd: string, args: string[], _opts: unknown, cb: (err: any, stdout?: string) => void) => {
		if (args.includes('config') && state.originUrl !== null) {
			cb(null, `${state.originUrl}\n`);
			return;
		}
		if (args.includes('ls-files')) {
			// the coverage walk lists tracked files then untracked ones; untracked stays empty
			cb(null, args.includes('--others') ? '' : (state.gitFiles ?? ''));
			return;
		}
		cb(Object.assign(new Error('not a git repository'), { code: 128 }));
	});
	const mockQdrant = {
		getCollection: vi.fn(),
		getCollections: vi.fn(),
		query: vi.fn(),
		scroll: vi.fn(),
	};
	const mockEmbeddingCreate = vi.fn();
	return { mockQdrant, mockEmbeddingCreate, mockExecFile, state };
});

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return { ...actual, execFile: mockExecFile };
});

vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		existsSync: vi.fn(() => true),
		readdirSync: vi.fn(() => []),
		readFileSync: vi.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
		statSync: vi.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
	};
});

vi.mock('../../../services/qdrant.js', () => ({
	getQdrantClient: () => mockQdrant,
}));

vi.mock('../../../services/code-index/embedding-client.js', () => ({
	getCodebaseEmbeddingClient: () => ({ embeddings: { create: mockEmbeddingCreate } }),
	// #4352 (a5): the search path reads through the interactive (query) client;
	// the writer keeps the index client. Same fake create() for both.
	getCodebaseEmbeddingQueryClient: () => ({ embeddings: { create: mockEmbeddingCreate } }),
	getCodebaseEmbeddingModel: () => 'text-embedding-3-small',
	resetCodebaseEmbeddingClient: vi.fn(),
}));

import { handleCodebaseSearch, getWorkspaceCollectionName } from '../search-codebase.tool.js';
import {
	supplementCollectionName,
	clearSupplementCollectionCache,
} from '../../../services/code-index/supplement-index.js';

const WORKSPACE = '/test/ws';
const SUPPLEMENT = supplementCollectionName('https://github.com/jsboige/roo-extensions.git')!;
const MAIN = getWorkspaceCollectionName(WORKSPACE);

function point(filePath: string, score: number, codeChunk = 'some code here for the query', startLine = 1) {
	return { id: `${filePath}-${score}`, score, payload: { filePath, codeChunk, startLine, endLine: startLine + 2, pathSegments: { '0': filePath.split('/')[0] } } };
}

function parse(result: any) {
	return JSON.parse(result.content[0].text);
}

describe('codebase_search merges the supplement corpus (#4352 a3)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearSupplementCollectionCache();
		state.originUrl = 'https://github.com/jsboige/roo-extensions.git';
		state.gitFiles = null;
		mockEmbeddingCreate.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
		mockQdrant.getCollection.mockImplementation(async (name: string) => {
			if (name === MAIN) return { status: 'green', points_count: 500 };
			if (name === SUPPLEMENT) return { status: 'green', points_count: 40 };
			throw Object.assign(new Error('Not found'), { status: 404 });
		});
		mockQdrant.getCollections.mockResolvedValue({ collections: [] });
		mockQdrant.scroll.mockResolvedValue({ points: [], next_page_offset: null });
	});

	test('a supplement hit is merged, labelled, and the response reports both corpora', async () => {
		mockQdrant.query.mockImplementation(async (collection: string) => {
			if (collection === MAIN) return { points: [point('src/a.ts', 0.9)] };
			if (collection === SUPPLEMENT) return { points: [point('.claude/rules/claim.md', 0.95)] };
			throw new Error(`unexpected collection ${collection}`);
		});

		const body = parse(await handleCodebaseSearch({ query: 'claim discipline', workspace: WORKSPACE } as any, [] as any, undefined));

		expect(body.status).toBe('success');
		expect(body.results_count).toBe(2);
		const supplementHit = body.results.find((r: any) => r.index === 'supplement');
		expect(supplementHit.file_path).toBe('.claude/rules/claim.md');
		// highest score wins the rank, and the label never changes the ranking
		expect(body.results[0].index).toBe('supplement');
		expect(body.results.find((r: any) => r.file_path === 'src/a.ts').index).toBeUndefined();
		expect(body.supplement).toMatchObject({ collection: SUPPLEMENT, points: 1, hits: 1 });
	});

	test('both collections get the SAME vector, limit and threshold', async () => {
		mockQdrant.query.mockImplementation(async (collection: string) => ({
			points: collection === MAIN ? [point('src/a.ts', 0.9)] : [],
		}));
		await handleCodebaseSearch({ query: 'x', workspace: WORKSPACE, limit: 4, min_score: 0.7 } as any, [] as any, undefined);

		expect(mockQdrant.query).toHaveBeenCalledTimes(2);
		const [mainCall, supplementCall] = mockQdrant.query.mock.calls;
		expect(mainCall[0]).toBe(MAIN);
		expect(supplementCall[0]).toBe(SUPPLEMENT);
		expect(supplementCall[1].query).toEqual(mainCall[1].query);
		expect(supplementCall[1].score_threshold).toBe(mainCall[1].score_threshold);
		expect(supplementCall[1].limit).toBe(mainCall[1].limit);
		// same exclusions as the main search
		const keys = supplementCall[1].filter.must_not.map((m: any) => m.key);
		expect(keys).toContain('type');
	});

	test('an unreachable supplement leaves the search intact and says why (fail-open)', async () => {
		mockQdrant.query.mockImplementation(async (collection: string) => {
			if (collection === MAIN) return { points: [point('src/a.ts', 0.9)] };
			throw new Error('connection reset by peer');
		});
		const body = parse(await handleCodebaseSearch({ query: 'x', workspace: WORKSPACE } as any, [] as any, undefined));
		expect(body.status).toBe('success');
		expect(body.results).toHaveLength(1);
		expect(body.results[0].index).toBeUndefined();
		expect(body.supplement.collection).toBe(SUPPLEMENT);
		expect(body.supplement.points).toBe(0);
		expect(body.supplement.error).toMatch(/connection reset/);
	});

	test('a workspace with no origin remote reports no supplement at all', async () => {
		state.originUrl = null;
		mockQdrant.query.mockResolvedValue({ points: [point('src/a.ts', 0.9)] });
		const body = parse(await handleCodebaseSearch({ query: 'x', workspace: WORKSPACE } as any, [] as any, undefined));
		expect(body.status).toBe('success');
		expect(body.supplement).toBeUndefined();
		expect(mockQdrant.query).toHaveBeenCalledTimes(1);
	});

	test('a supplement hit obeys the same per-file cap and the same data-file malus', async () => {
		// three chunks of the same .yml file, plus a plain source hit
		mockQdrant.query.mockImplementation(async (collection: string) => {
			if (collection === MAIN) return { points: [point('src/a.ts', 0.70)] };
			return {
				points: [
					point('.github/workflows/ci.yml', 0.95, 'chunk one', 1),
					point('.github/workflows/ci.yml', 0.94, 'chunk two', 20),
					point('.github/workflows/ci.yml', 0.93, 'chunk three', 40),
				],
			};
		});
		// limit 3 with 4 candidates: the cap must bite (the leftovers backfill exists for
		// the opposite case — a pool smaller than the limit — and would hide it at limit 5)
		const body = parse(await handleCodebaseSearch({ query: 'x', workspace: WORKSPACE, limit: 3 } as any, [] as any, undefined));
		const supplementHits = body.results.filter((r: any) => r.index === 'supplement');
		// MAX_CHUNKS_PER_FILE = 2 — the cap applies to supplement hits exactly as to Zoo ones
		expect(supplementHits.length).toBe(2);
		// and the .yml data-file malus (×0.75) is visible in the exposed score
		expect(body.data_file_malus_applied).toBe(2);
		expect(supplementHits[0].score).toBeCloseTo(0.95 * 0.75, 5);
	});

	// ── review ms#1514, fix 1: an absent collection stays silent ───────────────

	test('an ABSENT supplement collection: no supplement block, hint stays on Grep, one query — the 404 probe is paid once then cached', async () => {
		// a blind spot on disk so the response carries not_indexed_by_design at all
		state.gitFiles = 'src/a.ts\0scripts/deploy.ps1\0';
		mockQdrant.getCollection.mockImplementation(async (name: string) => {
			if (name === MAIN) return { status: 'green', points_count: 500 };
			// the SUPPLEMENT collection does not exist: a derived name is not an existence proof
			throw Object.assign(new Error('Not found'), { status: 404 });
		});
		mockQdrant.query.mockImplementation(async (collection: string) => {
			if (collection === MAIN) return { points: [point('src/a.ts', 0.9)] };
			throw new Error(`unexpected supplement query for ${collection}`);
		});

		const first = parse(await handleCodebaseSearch({ query: 'x', workspace: WORKSPACE } as any, [] as any, undefined));
		// silent: no supplement block announcing points: 0 / error for a corpus that does not exist
		expect(first.supplement).toBeUndefined();
		// the hint keeps sending the agent to Grep — claiming "searched separately" would be a lie
		expect(first.not_indexed_by_design.hint).toMatch(/use Grep for them/);
		expect(first.not_indexed_by_design.hint).not.toMatch(/searched separately/);
		// mutation check: only the main collection was queried — no 404 round trip
		expect(mockQdrant.query).toHaveBeenCalledTimes(1);
		expect(mockQdrant.query.mock.calls[0][0]).toBe(MAIN);
		// the existence probe was paid exactly once for this workspace
		expect(mockQdrant.getCollection.mock.calls.filter((c: any[]) => c[0] === SUPPLEMENT)).toHaveLength(1);

		const second = parse(await handleCodebaseSearch({ query: 'y', workspace: WORKSPACE } as any, [] as any, undefined));
		expect(second.supplement).toBeUndefined();
		expect(second.not_indexed_by_design.hint).toMatch(/use Grep for them/);
		// …and not twice: absence is cached 5 minutes, like the remote probe
		expect(mockQdrant.getCollection.mock.calls.filter((c: any[]) => c[0] === SUPPLEMENT)).toHaveLength(1);
		expect(mockQdrant.query).toHaveBeenCalledTimes(2); // the second main query only
	});

	test('a TRANSIENT probe failure never suppresses the corpus nor caches it — the query goes out and carries its error (Hermes pt 1)', async () => {
		mockQdrant.getCollection.mockImplementation(async (name: string) => {
			if (name === MAIN) return { status: 'green', points_count: 500 };
			// the SUPPLEMENT probe dies on transport — an ECONNREFUSED is not a 404, not an absence
			throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:6333'), { code: 'ECONNREFUSED' });
		});
		mockQdrant.query.mockImplementation(async (collection: string) => {
			if (collection === MAIN) return { points: [point('src/a.ts', 0.9)] };
			throw new Error('connection reset by peer');
		});

		const first = parse(await handleCodebaseSearch({ query: 'x', workspace: WORKSPACE } as any, [] as any, undefined));
		// the corpus was NOT suppressed: the block exists and the error says why (fail-open with a reason)
		expect(first.supplement).toMatchObject({ collection: SUPPLEMENT, points: 0 });
		expect(first.supplement.error).toMatch(/connection reset/);
		// mutation check: the supplement query WENT OUT — the probe failure is not a gate
		expect(mockQdrant.query).toHaveBeenCalledTimes(2);

		const second = parse(await handleCodebaseSearch({ query: 'y', workspace: WORKSPACE } as any, [] as any, undefined));
		expect(second.supplement.error).toMatch(/connection reset/);
		// the transport failure was NOT cached: each search probed again (2 probes, not 1)
		expect(mockQdrant.getCollection.mock.calls.filter((c: any[]) => c[0] === SUPPLEMENT)).toHaveLength(2);
	});

	test('a PRESENT supplement collection flips the same hint to "searched separately" (control for fix 1)', async () => {
		state.gitFiles = 'src/a.ts\0scripts/deploy.ps1\0';
		mockQdrant.query.mockImplementation(async (collection: string) => ({
			points: collection === MAIN ? [point('src/a.ts', 0.9)] : [],
		}));
		const body = parse(await handleCodebaseSearch({ query: 'x', workspace: WORKSPACE } as any, [] as any, undefined));
		expect(body.supplement).toMatchObject({ collection: SUPPLEMENT, points: 0, hits: 0 });
		expect(body.not_indexed_by_design.hint).toMatch(new RegExp(`searched separately in ${SUPPLEMENT}`));
	});
});
