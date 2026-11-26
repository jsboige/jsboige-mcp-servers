/**
 * #4880 — the vector query's client abort must sit ABOVE the server-side
 * search budget, and a timed-out attempt must not be retried.
 *
 * Measured on ai-01 (23/11): the shared client aborted at QDRANT_TIMEOUT_MS
 * (15 s) while the query handed Qdrant `timeout: 30` — the server budget never
 * applied — and each cut attempt was retried twice: 3 x 15 s + 2 s + 4 s of
 * backoff = the 52-57 s observed before the text fallback, on a server that
 * answered the same query shape in 8-14.5 s once warm.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockQdrantClient, mockGetQdrantClient, mockOpenAIClient, mockFetch } = vi.hoisted(() => {
	// Backoff read at module load: keep the legacy-path test fast.
	process.env.SEMANTIC_RETRY_BACKOFF_MS = '1';
	const client = {
		query: vi.fn(),
		getCollection: vi.fn(),
		scroll: vi.fn(),
		retrieve: vi.fn(),
	};
	return {
		mockQdrantClient: client,
		mockGetQdrantClient: vi.fn((_opts?: { timeoutMs?: number }) => client),
		mockOpenAIClient: { embeddings: { create: vi.fn() } },
		mockFetch: vi.fn(),
	};
});

vi.mock('../../../services/qdrant.js', () => ({
	getQdrantClient: mockGetQdrantClient,
	resetQdrantClient: vi.fn(),
	isLargeCollection: vi.fn(async () => false),
	getCollectionSize: vi.fn(async () => 1000),
}));

vi.mock('../../../services/openai.js', () => ({
	default: () => mockOpenAIClient,
	getEmbeddingQueryClient: () => mockOpenAIClient,
	getEmbeddingModel: () => 'test-model',
}));

vi.mock('../../../services/task-indexer.js', () => ({
	TaskIndexer: class {},
	getHostIdentifier: () => 'test-host-01',
}));

vi.mock('../../../services/task-indexer/ChunkExtractor.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../services/task-indexer/ChunkExtractor.js')>()),
	getHostIdentifier: () => 'test-host-01',
}));

vi.mock('../../../services/unified-store/reader-factory.js', () => ({
	getUnifiedStoreReader: () => ({ isNull: () => true, joinFromQdrant: async () => [] }),
}));

import {
	searchTasksByContentTool,
	_resetEmbeddingCircuitBreaker,
} from '../search-semantic.tool.js';
import { resolveSearchClientTimeoutMs } from '../search-client-timeout.js';

const fallback = vi.fn(async () => ({
	content: [{ type: 'text' as const, text: JSON.stringify({ mode: 'fallback_text_search', results: [] }) }],
	isError: false,
}));

const run = (query: string) => searchTasksByContentTool.handler(
	{ search_query: query, workspace: 'roo-extensions' },
	new Map(),
	vi.fn(async () => true),
	fallback,
);

const aborted = () => new Error('This operation was aborted');

describe('#4880 resolveSearchClientTimeoutMs', () => {
	test('default: the 30 s server budget plus a 5 s margin', () => {
		expect(resolveSearchClientTimeoutMs({})).toBe(35000);
	});

	test('follows QDRANT_SEARCH_TIMEOUT_MS, rounded up to the second the server receives', () => {
		expect(resolveSearchClientTimeoutMs({ QDRANT_SEARCH_TIMEOUT_MS: '45000' })).toBe(50000);
		expect(resolveSearchClientTimeoutMs({ QDRANT_SEARCH_TIMEOUT_MS: '45500' })).toBe(51000);
	});

	test('an unparsable or non-positive budget falls back to the default', () => {
		expect(resolveSearchClientTimeoutMs({ QDRANT_SEARCH_TIMEOUT_MS: 'abc' })).toBe(35000);
		expect(resolveSearchClientTimeoutMs({ QDRANT_SEARCH_TIMEOUT_MS: '0' })).toBe(35000);
	});

	test('kill switch QDRANT_SEARCH_TIMEOUT_ALIGN=0 → null (shared client)', () => {
		expect(resolveSearchClientTimeoutMs({ QDRANT_SEARCH_TIMEOUT_ALIGN: '0' })).toBeNull();
		expect(resolveSearchClientTimeoutMs({ QDRANT_SEARCH_TIMEOUT_ALIGN: '1' })).toBe(35000);
	});
});

describe('#4880 semantic search: aligned client, no retry on a timed-out attempt', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_resetEmbeddingCircuitBreaker();
		vi.stubGlobal('fetch', mockFetch);
		// Classifier probes (healthz / listing / light scroll) all answer.
		mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ result: { collections: [{ name: 'c' }] } }) });
		mockOpenAIClient.embeddings.create.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
		mockQdrantClient.retrieve.mockResolvedValue([]);
		mockQdrantClient.scroll.mockResolvedValue({ points: [] });
		delete process.env.QDRANT_SEARCH_TIMEOUT_ALIGN;
		delete process.env.QDRANT_SEARCH_TIMEOUT_MS;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.QDRANT_SEARCH_TIMEOUT_ALIGN;
	});

	test('the vector query runs on a client whose abort sits above the server budget', async () => {
		mockQdrantClient.query.mockResolvedValue({ points: [] });
		await run('aligned client');
		expect(mockGetQdrantClient).toHaveBeenCalledWith({ timeoutMs: 35000 });
		const sent = mockQdrantClient.query.mock.calls[0][1];
		// The server budget the client now waits for (seconds).
		expect(sent.timeout).toBe(30);
	});

	test('a timed-out attempt is NOT retried: one query, then the fallback', async () => {
		mockQdrantClient.query.mockRejectedValue(aborted());
		const result = await run('timed out once');
		expect(mockQdrantClient.query).toHaveBeenCalledTimes(1);
		expect(fallback).toHaveBeenCalledTimes(1);
		expect(result.isError).toBe(false);
	});

	test('a transient 503 is still retried (only timeouts stop retrying)', async () => {
		mockQdrantClient.query
			.mockRejectedValueOnce(new Error('Service Unavailable'))
			.mockResolvedValue({ points: [] });
		await run('transient 503');
		expect(mockQdrantClient.query).toHaveBeenCalledTimes(2);
		expect(fallback).not.toHaveBeenCalled();
	});

	test('a CONNECT-phase timeout spent no search budget: still retried', async () => {
		const connectTimeout = Object.assign(new TypeError('fetch failed'), {
			cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
		});
		mockQdrantClient.query
			.mockRejectedValueOnce(connectTimeout)
			.mockResolvedValue({ points: [] });
		await run('connect timeout');
		expect(mockQdrantClient.query).toHaveBeenCalledTimes(2);
		expect(fallback).not.toHaveBeenCalled();
	});

	test('kill switch =0 restores the legacy path: shared client, timeouts retried twice', async () => {
		process.env.QDRANT_SEARCH_TIMEOUT_ALIGN = '0';
		mockQdrantClient.query.mockRejectedValue(aborted());
		await run('legacy path');
		expect(mockQdrantClient.query).toHaveBeenCalledTimes(3);
		expect(mockGetQdrantClient).not.toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: expect.any(Number) }));
	});
});
