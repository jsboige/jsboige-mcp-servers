/**
 * #4879 — codebase_search global deadline.
 *
 * Measured 23/11 (ai-01): with the Qdrant data plane stalled, codebase_search
 * stacked its stages past the 180 s tool timeout and returned nothing at all.
 * The deadline returns a classified error naming the stalled phase instead.
 *
 * Pinned here:
 *   1. `CODEBASE_SEARCH_DEADLINE_MS` parsing (default 50 s, kill-switch values),
 *   2. a stalled Qdrant collection probe → `qdrant_backend_slow`, phase `collection_resolution`,
 *   3. a stalled embedding call → `embedding_timeout`, phase `embedding`,
 *   4. a stalled Qdrant query → `qdrant_backend_slow`, phase `qdrant_query`,
 *   5. kill-switch `0` → no deadline (the call stays pending, pre-#4879 behaviour),
 *   6. a search that answers in time returns its own result, not the deadline's.
 *
 * @module tools/search/__tests__/search-codebase.deadline
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetQdrantClient, mockQdrant, mockEmbeddingCreate } = vi.hoisted(() => ({
	mockGetQdrantClient: vi.fn(),
	mockQdrant: { getCollection: vi.fn(), query: vi.fn(), getCollections: vi.fn(), scroll: vi.fn() },
	mockEmbeddingCreate: vi.fn(),
}));

vi.mock('../../../services/qdrant.js', () => ({
	getQdrantClient: mockGetQdrantClient,
}));

vi.mock('openai', () => ({
	default: vi.fn(() => ({
		embeddings: { create: mockEmbeddingCreate },
	})),
}));

import {
	handleCodebaseSearch,
	codebaseSearchDeadlineMs,
	resetCodebaseEmbeddingBreaker,
	resetCodebaseEmbeddingClient,
	clearCoverageCache,
} from '../search-codebase.tool.js';

/** A promise that never settles — the shape of a stalled data plane. */
const never = () => new Promise<never>(() => {});

function parse(result: any): any {
	return JSON.parse(result.content[0].text);
}

const SHORT_DEADLINE_MS = 80;

describe('#4879 — codebaseSearchDeadlineMs', () => {
	afterEach(() => {
		delete process.env.CODEBASE_SEARCH_DEADLINE_MS;
	});

	test('1. default 50 s; 0 / negative / garbage = kill-switch; a valid value is used', () => {
		delete process.env.CODEBASE_SEARCH_DEADLINE_MS;
		expect(codebaseSearchDeadlineMs()).toBe(50_000);
		for (const v of ['0', '-1', 'soon']) {
			process.env.CODEBASE_SEARCH_DEADLINE_MS = v;
			expect(codebaseSearchDeadlineMs()).toBe(0);
		}
		process.env.CODEBASE_SEARCH_DEADLINE_MS = '1234';
		expect(codebaseSearchDeadlineMs()).toBe(1234);
	});
});

describe('#4879 — handleCodebaseSearch under a stalled backend', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetQdrantClient.mockReturnValue(mockQdrant);
		resetCodebaseEmbeddingBreaker();
		resetCodebaseEmbeddingClient();
		clearCoverageCache();
		process.env.EMBEDDING_API_KEY = 'test-key';
		process.env.CODEBASE_SEARCH_DEADLINE_MS = String(SHORT_DEADLINE_MS);
		// Defaults: a healthy, populated collection; scroll answers empty (coverage, sentinel).
		mockQdrant.getCollection.mockResolvedValue({ status: 'green', points_count: 10 });
		mockQdrant.getCollections.mockResolvedValue({ collections: [] });
		mockQdrant.scroll.mockResolvedValue({ points: [], next_page_offset: null });
		mockEmbeddingCreate.mockResolvedValue({ data: [{ embedding: new Array(8).fill(0.1) }] });
		mockQdrant.query.mockResolvedValue({ points: [] });
	});

	afterEach(() => {
		delete process.env.EMBEDDING_API_KEY;
		delete process.env.CODEBASE_SEARCH_DEADLINE_MS;
	});

	test('2. stalled collection probe → qdrant_backend_slow in phase collection_resolution, within the deadline', async () => {
		mockQdrant.getCollection.mockImplementation(never);
		const started = Date.now();
		const result = await handleCodebaseSearch({ query: 'breaker', workspace: '/ws' });
		const elapsed = Date.now() - started;

		expect(result.isError).toBe(true);
		const body = parse(result);
		expect(body.status).toBe('qdrant_backend_slow');
		expect(body.phase).toBe('collection_resolution');
		expect(body.deadline_ms).toBe(SHORT_DEADLINE_MS);
		expect(elapsed).toBeLessThan(SHORT_DEADLINE_MS + 2_000);
	});

	test('3. stalled embedding call → embedding_timeout in phase embedding', async () => {
		mockEmbeddingCreate.mockImplementation(never);
		const body = parse(await handleCodebaseSearch({ query: 'breaker', workspace: '/ws' }));
		expect(body.status).toBe('embedding_timeout');
		expect(body.phase).toBe('embedding');
	});

	test('4. stalled Qdrant query → qdrant_backend_slow in phase qdrant_query', async () => {
		mockQdrant.query.mockImplementation(never);
		const body = parse(await handleCodebaseSearch({ query: 'breaker', workspace: '/ws' }));
		expect(body.status).toBe('qdrant_backend_slow');
		expect(body.phase).toBe('qdrant_query');
	});

	test('5. kill-switch 0 → no deadline: the stalled call stays pending', async () => {
		process.env.CODEBASE_SEARCH_DEADLINE_MS = '0';
		mockQdrant.getCollection.mockImplementation(never);
		const sentinel = new Promise(resolve => setTimeout(() => resolve('still-pending'), 300));
		const winner = await Promise.race([handleCodebaseSearch({ query: 'breaker', workspace: '/ws' }), sentinel]);
		expect(winner).toBe('still-pending');
	});

	test('6. a search that answers in time returns its own result, not the deadline response', async () => {
		process.env.CODEBASE_SEARCH_DEADLINE_MS = '5000';
		const result = await handleCodebaseSearch({ query: 'breaker', workspace: '/ws' });
		const body = parse(result);
		expect(body.phase).toBeUndefined();
		expect(body.status).not.toBe('qdrant_backend_slow');
	});
});
