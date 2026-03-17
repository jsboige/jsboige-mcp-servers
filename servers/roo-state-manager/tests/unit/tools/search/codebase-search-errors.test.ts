/**
 * Tests de couverture des chemins d'erreur pour search-codebase.tool.ts
 * Issue #733 — Couverture module search > 70%
 *
 * Couvre le catch block (lignes 333-377) :
 * - fetch failed / ECONNREFUSED → qdrant_connection_error
 * - API key / Unauthorized → auth_error
 * - Erreur générique → error
 *
 * @module search/codebase-search-errors.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mocks hoistés pour éviter les problèmes ESM
const { mockQuery, mockGetCollection, mockEmbeddingsCreate } = vi.hoisted(() => ({
	mockQuery: vi.fn(),
	mockGetCollection: vi.fn(),
	mockEmbeddingsCreate: vi.fn()
}));

vi.mock('../../../../src/services/qdrant.js', () => ({
	getQdrantClient: () => ({
		query: mockQuery,
		getCollection: mockGetCollection
	})
}));

vi.mock('openai', () => ({
	default: vi.fn().mockImplementation(() => ({
		embeddings: {
			create: mockEmbeddingsCreate
		}
	}))
}));

/**
 * Re-registers mocks with vi.doMock() then dynamically imports a fresh module.
 * Needed because the module caches the OpenAI client as a singleton.
 */
async function getFreshHandler() {
	vi.resetModules();
	vi.doMock('../../../../src/services/qdrant.js', () => ({
		getQdrantClient: () => ({
			query: mockQuery,
			getCollection: mockGetCollection
		})
	}));
	vi.doMock('openai', () => ({
		default: vi.fn().mockImplementation(() => ({
			embeddings: { create: mockEmbeddingsCreate }
		}))
	}));
	const mod = await import('../../../../src/tools/search/search-codebase.tool.js');
	return mod.handleCodebaseSearch;
}

const originalEnv = process.env;

describe('codebase_search - handleCodebaseSearch - Error paths', () => {
	let hcs: Awaited<ReturnType<typeof getFreshHandler>>;

	beforeEach(async () => {
		vi.clearAllMocks();
		process.env = { ...originalEnv };
		process.env.EMBEDDING_API_KEY = 'test-key';

		// Default: collection found
		mockGetCollection.mockResolvedValue({ status: 'green' });

		// Default: embedding succeeds
		mockEmbeddingsCreate.mockResolvedValue({
			data: [{ embedding: new Array(128).fill(0.1) }]
		});

		hcs = await getFreshHandler();
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it('retourne qdrant_connection_error quand fetch failed', async () => {
		mockQuery.mockRejectedValue(new Error('fetch failed ECONNREFUSED 127.0.0.1:6333'));

		const result = await hcs({ query: 'test connection error' });

		expect(result.isError).toBe(true);
		const response = JSON.parse(result.content[0].text);
		expect(response.status).toBe('qdrant_connection_error');
		expect(response.message).toContain('Qdrant');
		expect(response.hint).toBeDefined();
		expect(response.error).toContain('fetch failed');
	});

	it('retourne qdrant_connection_error quand ECONNREFUSED', async () => {
		mockQuery.mockRejectedValue(new Error('connect ECONNREFUSED ::1:6333'));

		const result = await hcs({ query: 'test econnrefused' });

		expect(result.isError).toBe(true);
		const response = JSON.parse(result.content[0].text);
		expect(response.status).toBe('qdrant_connection_error');
	});

	it('retourne auth_error quand API key invalide', async () => {
		mockEmbeddingsCreate.mockRejectedValue(new Error('Invalid API key provided'));

		const result = await hcs({ query: 'test auth error' });

		expect(result.isError).toBe(true);
		const response = JSON.parse(result.content[0].text);
		expect(response.status).toBe('auth_error');
		expect(response.message).toContain('authentification');
		expect(response.hint).toBeDefined();
	});

	it('retourne auth_error quand Unauthorized', async () => {
		mockEmbeddingsCreate.mockRejectedValue(new Error('Unauthorized: token expired'));

		const result = await hcs({ query: 'test unauthorized' });

		expect(result.isError).toBe(true);
		const response = JSON.parse(result.content[0].text);
		expect(response.status).toBe('auth_error');
	});

	it('retourne error générique pour toute autre erreur', async () => {
		mockQuery.mockRejectedValue(new Error('Unexpected server error: timeout'));

		const result = await hcs({ query: 'test generic error' });

		expect(result.isError).toBe(true);
		const response = JSON.parse(result.content[0].text);
		expect(response.status).toBe('error');
		expect(response.message).toContain('recherche');
		expect(response.error).toContain('Unexpected server error');
	});
});
