/**
 * writer-signal.test.ts — #4863: the RSM ws-writer sentinel as the reader's
 * freshness signal.
 *
 * The measured divergence (po-2024, 22/11): a reader seat whose checkout path
 * differs from the writer's hash-resolves a writer-less legacy twin whose files
 * still exist (liveness 0.900 > the 0.5 warn threshold) — so neither the liveness
 * preference nor the stale-twin warning ever fires, and the response carries no
 * signal that the served corpus is frozen. The ws-writer sentinel (claimed by
 * the refresh loop INSIDE the collection on every non-dry pass) is the only
 * cross-seat signal that travels with the corpus. These tests pin:
 *
 *   1. the fail-open probe's three verdicts — claimed / writer-less / undecidable;
 *   2. the selection wiring at the probe level (a divergent path serves the
 *      writer-bearing variant and names its writer);
 *   3. the handler's response contract — collection_writer on every probed
 *      search, writer_warning exactly when the served corpus is writer-less;
 *   4. the WRITER_SIGNAL=0 rollback: the pre-#4863 behaviour, field-free.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { v5 as uuidv5 } from 'uuid';
import { readdirSync } from 'fs';
import { ZOO_CODE_BLOCK_NAMESPACE } from '../../../services/code-index/zoo-parity.js';

const { mockGetQdrantClient, mockQdrant, mockEmbeddingCreate } = vi.hoisted(() => ({
	mockGetQdrantClient: vi.fn(),
	mockQdrant: {
		getCollection: vi.fn(),
		getCollections: vi.fn(),
		query: vi.fn(),
		scroll: vi.fn(),
		retrieve: vi.fn(),
	},
	mockEmbeddingCreate: vi.fn(),
}));

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

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		execFile: vi.fn((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, s?: string) => void) =>
			cb(Object.assign(new Error('not a git repository'), { code: 128 }))),
	};
});

vi.mock('../../../services/qdrant.js', () => ({ getQdrantClient: mockGetQdrantClient }));
vi.mock('openai', () => ({ default: vi.fn(() => ({ embeddings: { create: mockEmbeddingCreate } })) }));

import {
	WS_WRITER_SENTINEL_ID,
	probeWsWriterSentinel,
	resolveWriterProbeTimeout,
	probeWorkspaceCollections,
} from '../../../services/code-index/collection-naming.js';
import {
	handleCodebaseSearch,
	getWorkspaceCollectionVariants,
	getWorkspaceCollectionName,
} from '../search-codebase.tool.js';

const CANONICAL = 'ws-d2ffdbaa832aed16';
const LEGACY = 'ws-59e7574de63c6e62';
const WEB1 = { writer: 'myia-web1:roo-extensions', since: '2026-11-21T00:00:00.000Z' };

beforeEach(() => {
	vi.clearAllMocks();
	mockGetQdrantClient.mockReturnValue(mockQdrant);
	process.env.EMBEDDING_API_KEY = 'test-key';
	delete process.env.WRITER_SIGNAL;
});

afterEach(() => {
	delete process.env.EMBEDDING_API_KEY;
	delete process.env.WRITER_SIGNAL;
	vi.useRealTimers();
});

describe('WS_WRITER_SENTINEL_ID — one definition, re-exported on the writer path', () => {
	it('is the uuidv5 of __rsm_ws_writer__ under Zoo\'s code-block namespace', () => {
		expect(WS_WRITER_SENTINEL_ID).toBe(uuidv5('__rsm_ws_writer__', ZOO_CODE_BLOCK_NAMESPACE));
	});

	it('the writer module re-exports the SAME id (identity, not a copy)', async () => {
		const writer = await import('../../../services/code-index/ws-index-writer.js');
		expect(writer.WS_WRITER_SENTINEL_ID).toBe(WS_WRITER_SENTINEL_ID);
	});
});

describe('probeWsWriterSentinel — three verdicts, fail-open', () => {
	it('claimed: a sentinel payload names its writer and since', async () => {
		const client = {
			retrieve: vi.fn(async () => [{ id: WS_WRITER_SENTINEL_ID, payload: { writer: WEB1.writer, since: WEB1.since } }]),
		};
		await expect(probeWsWriterSentinel(client, CANONICAL)).resolves.toEqual(WEB1);
		expect(client.retrieve).toHaveBeenCalledWith(CANONICAL, expect.objectContaining({ ids: [WS_WRITER_SENTINEL_ID] }));
	});

	it('writer-less: the collection was READ and holds no sentinel → null', async () => {
		const client = { retrieve: vi.fn(async () => []) };
		await expect(probeWsWriterSentinel(client, LEGACY)).resolves.toBeNull();
	});

	it('undecidable: a transport error reads as undefined, never as writer-less', async () => {
		const client = { retrieve: vi.fn(async () => { throw new Error('fetch failed'); }) };
		await expect(probeWsWriterSentinel(client, CANONICAL)).resolves.toBeUndefined();
	});

	it('undecidable: a timed-out read is undefined, and its late rejection stays handled', async () => {
		const client = {
			retrieve: vi.fn(() => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 50))),
		};
		await expect(probeWsWriterSentinel(client, CANONICAL, { timeoutMs: 5 })).resolves.toBeUndefined();
		// Let the late rejection land — an unhandled rejection here fails the run.
		await new Promise(r => setTimeout(r, 80));
	});

	it('falls back to a has_id scroll when the client has no retrieve', async () => {
		const client = {
			scroll: vi.fn(async () => ({ points: [{ payload: { writer: WEB1.writer, since: WEB1.since } }] })),
		};
		await expect(probeWsWriterSentinel(client, CANONICAL)).resolves.toEqual(WEB1);
		expect(client.scroll).toHaveBeenCalledWith(CANONICAL, expect.objectContaining({
			filter: { must: [{ has_id: [WS_WRITER_SENTINEL_ID] }] },
		}));
	});

	it('accepts the raw-HTTP retrieve envelope ({result: [...]}) beside the SDK-unwrapped array', async () => {
		const client = {
			retrieve: vi.fn(async () => ({ result: [{ payload: { writer: WEB1.writer, since: WEB1.since } }] })),
		};
		await expect(probeWsWriterSentinel(client, CANONICAL)).resolves.toEqual(WEB1);
	});

	it('a client with neither retrieve nor scroll is undecidable, not writer-less', async () => {
		await expect(probeWsWriterSentinel({}, CANONICAL)).resolves.toBeUndefined();
	});
});

describe('resolveWriterProbeTimeout — an env typo never silently disarms the feature', () => {
	it('defaults to 1500 ms', () => {
		expect(resolveWriterProbeTimeout(undefined)).toBe(1500);
	});

	it('NaN / zero / negative fall back to the default', () => {
		expect(resolveWriterProbeTimeout('abc')).toBe(1500);
		expect(resolveWriterProbeTimeout('0')).toBe(1500);
		expect(resolveWriterProbeTimeout('-1')).toBe(1500);
	});

	it('accepts a positive finite override', () => {
		expect(resolveWriterProbeTimeout('250')).toBe(250);
	});
});

describe('probeWorkspaceCollections — #4863 resolution wiring', () => {
	it('a divergent-path reader serves the writer-bearing variant and exposes its writer', async () => {
		// po-2024's exact checkout spelling: both the legacy twin (larger) and the
		// canonical collection exist among its hash variants; liveness ties.
		const workspace = 'D:\\Dev\\roo-extensions';
		const variants = getWorkspaceCollectionVariants(workspace);
		expect(variants).toEqual(expect.arrayContaining([CANONICAL, LEGACY]));
		const client = {
			getCollection: vi.fn(async (name: string) => {
				if (name === CANONICAL) return { points_count: 338386 };
				if (name === LEGACY) return { points_count: 571554 };
				throw new Error('not found');
			}),
			retrieve: vi.fn(async (name: string) =>
				name === CANONICAL ? [{ payload: WEB1 }] : []),
			scroll: vi.fn(async () => ({ points: [] })),
		};
		const probe = await probeWorkspaceCollections(client, workspace);
		expect(probe.resolved).toBe(CANONICAL);
		expect(probe.resolved_by).toBe('hash');
		expect(probe.hash_resolution.basis).toBe('writer');
		expect(probe.resolved_writer).toEqual(WEB1);
		expect(probe.writer_signals?.[LEGACY]).toBeNull();
		expect(probe.writer_signals?.[CANONICAL]).toEqual(WEB1);
	});

	it('the resolved collection is writer-less → resolved_writer is null (the response flags it)', async () => {
		const workspace = 'D:\\Dev\\roo-extensions';
		const client = {
			getCollection: vi.fn(async (name: string) => {
				if (name === LEGACY) return { points_count: 571554 };
				throw new Error('not found');
			}),
			retrieve: vi.fn(async () => []),
			scroll: vi.fn(async () => ({ points: [] })),
		};
		const probe = await probeWorkspaceCollections(client, workspace);
		expect(probe.resolved).toBe(LEGACY);
		expect(probe.resolved_writer).toBeNull();
	});

	it('WRITER_SIGNAL=0: the legacy ranking stands and no writer fields are emitted', async () => {
		process.env.WRITER_SIGNAL = '0';
		const workspace = 'D:\\Dev\\roo-extensions';
		const client = {
			getCollection: vi.fn(async (name: string) => {
				if (name === CANONICAL) return { points_count: 338386 };
				if (name === LEGACY) return { points_count: 571554 };
				throw new Error('not found');
			}),
			retrieve: vi.fn(async (name: string) => (name === CANONICAL ? [{ payload: WEB1 }] : [])),
			scroll: vi.fn(async () => ({ points: [] })),
		};
		const probe = await probeWorkspaceCollections(client, workspace);
		// Equal liveness (both scrolls empty → undecidable) → points ranking → the twin.
		expect(probe.resolved).toBe(LEGACY);
		expect(probe.writer_signals).toBeUndefined();
		expect(probe.resolved_writer).toBeUndefined();
		expect(client.retrieve).not.toHaveBeenCalled();
	});
});

describe('handleCodebaseSearch — #4863 response contract', () => {
	function setupTwoVariantSearch() {
		const workspace = 'D:/Dev/roo-ext';
		const canonical = getWorkspaceCollectionName('d:/dev/roo-ext');
		const legacy = getWorkspaceCollectionName('d:\\Dev\\roo-ext');
		mockQdrant.getCollection.mockImplementation(async (name: string) => {
			if (name === canonical) return { status: 'green', points_count: 338386 };
			if (name === legacy) return { status: 'green', points_count: 571554 };
			throw new Error('not found');
		});
		mockQdrant.retrieve.mockImplementation(async (name: string) =>
			name === canonical ? [{ payload: WEB1 }] : []);
		mockQdrant.scroll.mockResolvedValue({ points: [] });
		mockQdrant.query.mockImplementation(async (name: string) => ({
			points: [{
				score: 0.7,
				payload: {
					filePath: name === canonical ? 'src/canonical.ts' : 'src/legacy.ts',
					codeChunk: 'export function foo() {}',
					startLine: 1,
					endLine: 5,
				},
			}],
		}));
		mockEmbeddingCreate.mockResolvedValue({ data: [{ embedding: new Array(8).fill(0.1) }] });
		return { workspace, canonical, legacy };
	}

	it('serves the writer-bearing variant on a liveness tie and reports collection_writer.claimed', async () => {
		const { workspace, canonical } = setupTwoVariantSearch();
		const result = await handleCodebaseSearch({ query: 'foo function', workspace });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.status, `PAYLOAD=${JSON.stringify(parsed).slice(0, 800)} TEXT=${String(result.content?.[0]?.text).slice(0, 400)}`).toBe('success');
		expect(parsed.collection).toBe(canonical);
		expect(parsed.collection_resolved_by).toBe('hash');
		expect(parsed.variant_selection?.basis).toBe('writer');
		expect(parsed.collection_writer).toEqual({ status: 'claimed', writer: WEB1.writer, since: WEB1.since });
		expect(parsed.results[0].file_path).toBe('src/canonical.ts');
		expect(parsed.writer_warning).toBeUndefined();
	});

	it('a served writer-less collection is flagged: collection_writer.writer-less + writer_warning', async () => {
		const workspace = 'D:/Dev/roo-ext';
		const legacy = getWorkspaceCollectionName('D:/Dev/roo-ext');
		mockQdrant.getCollection.mockImplementation(async (name: string) => {
			if (name === legacy) return { status: 'green', points_count: 571554 };
			throw new Error('not found');
		});
		mockQdrant.retrieve.mockResolvedValue([]);
		mockQdrant.query.mockResolvedValue({
			points: [{ score: 0.7, payload: { filePath: 'src/foo.ts', codeChunk: 'export function foo() {}', startLine: 1, endLine: 5 } }],
		});
		mockEmbeddingCreate.mockResolvedValue({ data: [{ embedding: new Array(8).fill(0.1) }] });

		const result = await handleCodebaseSearch({ query: 'foo function', workspace });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.status).toBe('success');
		expect(parsed.collection).toBe(legacy);
		expect(parsed.collection_writer).toEqual({ status: 'writer-less' });
		expect(parsed.writer_warning).toContain('WRITER-LESS');
		expect(parsed.writer_warning).toContain('liveness is NOT freshness');
	});

	it('an undecidable sentinel read with >1 variants reports undecidable — not writer-less, but freshness-NOT-verified warning', async () => {
		const { workspace, canonical } = setupTwoVariantSearch();
		mockQdrant.retrieve.mockRejectedValue(new Error('fetch failed'));
		const result = await handleCodebaseSearch({ query: 'foo function', workspace });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.status).toBe('success');
		// Every probe failed → no preference → the larger legacy twin wins on points.
		expect(parsed.collection_writer).toEqual({ status: 'undecidable' });
		// #4863 closure criterion: undecidable + several variants must flag freshness as
		// NOT verified — worded as unverified, NEVER writer-less (the writer may exist).
		expect(parsed.writer_warning).toBeDefined();
		expect(parsed.writer_warning).toContain('could not be read');
		expect(parsed.writer_warning).toContain('freshness NOT verified');
		expect(parsed.writer_warning).not.toContain('WRITER-LESS');
		expect(parsed.collection).not.toBe(canonical);
	});

	it('content-match reports the writer on the fallback path', async () => {
		vi.mocked(readdirSync).mockReturnValue([
			{ name: 'roo-code', isDirectory: () => true },
		] as any);
		mockQdrant.getCollection.mockImplementation(async (name: string) => {
			if (name === 'ws-contentmatched') return { status: 'green', points_count: 100 };
			throw new Error('not found');
		});
		mockQdrant.getCollections.mockResolvedValue({ collections: [{ name: 'ws-contentmatched' }] });
		mockQdrant.retrieve.mockResolvedValue([{ payload: WEB1 }]);
		mockQdrant.scroll.mockResolvedValue({
			points: [{ payload: { filePath: 'src/foo.ts', pathSegments: { '0': 'roo-code' } } }],
		});
		mockQdrant.query.mockResolvedValue({
			points: [{ score: 0.7, payload: { filePath: 'src/foo.ts', codeChunk: 'export function foo() {}', startLine: 1, endLine: 5 } }],
		});
		mockEmbeddingCreate.mockResolvedValue({ data: [{ embedding: new Array(8).fill(0.1) }] });
		const result = await handleCodebaseSearch({ query: 'foo', workspace: 'D:/Dev/roo-ext' });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.status).toBe('success');
		expect(parsed.collection_resolved_by).toBe('content-match');
		expect(parsed.collection_writer).toEqual({ status: 'claimed', ...WEB1 });
		expect(parsed.writer_warning).toBeUndefined();
	});

	it('content-match preserves a writer-less verdict and warns', async () => {
		vi.mocked(readdirSync).mockReturnValue([
			{ name: 'roo-code', isDirectory: () => true },
		] as any);
		mockQdrant.getCollection.mockImplementation(async (name: string) => {
			if (name === 'ws-contentmatched') return { status: 'green', points_count: 100 };
			throw new Error('not found');
		});
		mockQdrant.getCollections.mockResolvedValue({ collections: [{ name: 'ws-contentmatched' }] });
		mockQdrant.retrieve.mockResolvedValue([]);
		mockQdrant.scroll.mockResolvedValue({
			points: [{ payload: { filePath: 'src/foo.ts', pathSegments: { '0': 'roo-code' } } }],
		});
		mockQdrant.query.mockResolvedValue({
			points: [{ score: 0.7, payload: { filePath: 'src/foo.ts', codeChunk: 'export function foo() {}', startLine: 1, endLine: 5 } }],
		});
		mockEmbeddingCreate.mockResolvedValue({ data: [{ embedding: new Array(8).fill(0.1) }] });
		const result = await handleCodebaseSearch({ query: 'foo', workspace: 'D:/Dev/roo-ext' });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.status).toBe('success');
		expect(parsed.collection_resolved_by).toBe('content-match');
		expect(parsed.collection_writer).toEqual({ status: 'writer-less' });
		expect(parsed.writer_warning).toContain('WRITER-LESS');
	});

	it('WRITER_SIGNAL=0 restores the pre-#4863 response: no collection_writer, no preference', async () => {
		process.env.WRITER_SIGNAL = '0';
		const { workspace, canonical, legacy } = setupTwoVariantSearch();
		const result = await handleCodebaseSearch({ query: 'foo function', workspace });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.status).toBe('success');
		expect(parsed.collection).toBe(legacy);
		expect(parsed.collection).not.toBe(canonical);
		expect(parsed.collection_writer).toBeUndefined();
		expect(parsed.writer_warning).toBeUndefined();
		expect(mockQdrant.retrieve).not.toHaveBeenCalled();
	});
});
