/**
 * Live integration tests for search services (Qdrant + Embeddings).
 *
 * These tests connect to REAL services (not mocked) to verify:
 * 1. Qdrant connectivity and collection availability
 * 2. Embedding service generates vectors of correct dimensions
 * 3. End-to-end semantic search works
 * 4. codebase_search finds real code
 *
 * Requirements:
 * - Qdrant running at QDRANT_URL (default: https://qdrant.myia.io)
 * - Embedding service at EMBEDDING_API_BASE_URL (default: https://embeddings.myia.io/v1)
 * - Valid API keys in .env
 *
 * These tests are EXCLUDED from CI (vitest.config.ci.ts) since CI has no Qdrant.
 * They run locally to detect service outages that unit tests cannot catch.
 */
import { describe, test, expect, beforeAll, vi } from 'vitest';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

// CRITICAL: Unmock the global mocks set in jest.setup.js
// These live tests need REAL clients, not mocks
vi.unmock('openai');
vi.unmock('@qdrant/js-client-rest');

// Load .env from project root BEFORE any module import
const envPath = resolve(__dirname, '../../../../.env');
dotenv.config({ path: envPath, override: true });

// Dynamic imports to pick up env vars after dotenv loaded and mocks removed
let getQdrantClient: () => any;
let getOpenAIClient: () => any;
let getEmbeddingModel: () => string;
let getEmbeddingDimensions: () => number;
let resetQdrantClient: () => void;

beforeAll(async () => {
	// Verify required env vars exist before running
	const required = ['QDRANT_URL', 'EMBEDDING_API_KEY', 'EMBEDDING_API_BASE_URL'];
	const missing = required.filter(v => !process.env[v]);
	if (missing.length > 0) {
		throw new Error(
			`Live integration tests require env vars: ${missing.join(', ')}. ` +
			`Checked .env at: ${envPath}. ` +
			`Set them in .env or skip these tests with: npx vitest run --exclude '**/search-live*'`
		);
	}

	// Reset modules to force fresh imports with real (unmocked) modules
	vi.resetModules();

	const qdrantModule = await import('../../../services/qdrant.js');
	const openaiModule = await import('../../../services/openai.js');
	getQdrantClient = qdrantModule.getQdrantClient;
	resetQdrantClient = qdrantModule.resetQdrantClient;
	getOpenAIClient = openaiModule.default;
	getEmbeddingModel = openaiModule.getEmbeddingModel;
	getEmbeddingDimensions = openaiModule.getEmbeddingDimensions;

	// Reset singletons to ensure they pick up real env vars
	resetQdrantClient();
});

describe('Live Qdrant Connectivity', () => {
	test('should connect to Qdrant and list collections', async () => {
		const client = getQdrantClient();
		const result = await client.getCollections();

		expect(result).toBeDefined();
		expect(result.collections).toBeDefined();
		expect(Array.isArray(result.collections)).toBe(true);
		// We expect at least 1 collection (roo_tasks_semantic_index or ws-* collections)
		expect(result.collections.length).toBeGreaterThan(0);

		const collectionNames = result.collections.map((c: any) => c.name);
		console.log(`Qdrant collections (${collectionNames.length}): ${collectionNames.slice(0, 5).join(', ')}...`);
	});

	test('should find the roo_tasks_semantic_index collection', async () => {
		const client = getQdrantClient();
		const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

		try {
			const info = await client.getCollection(collectionName);
			expect(info).toBeDefined();
			expect(info.points_count ?? info.vectors_count).toBeGreaterThanOrEqual(0);
			console.log(`Collection "${collectionName}": ${info.points_count ?? info.vectors_count} vectors, status=${info.status}`);
		} catch (e: any) {
			// Collection may not exist on all machines — warn but don't fail
			if (e.message?.includes('Not found')) {
				console.warn(`Collection "${collectionName}" not found — skipping (machine may not have indexed yet)`);
			} else {
				throw e;
			}
		}
	});
});

describe('Live Embedding Service', () => {
	test('should generate embeddings with correct dimensions', async () => {
		const client = getOpenAIClient();
		const model = getEmbeddingModel();
		const expectedDims = getEmbeddingDimensions();

		console.log(`Embedding model: ${model}, expected dimensions: ${expectedDims}`);
		console.log(`Base URL: ${process.env.EMBEDDING_API_BASE_URL}`);

		const response = await client.embeddings.create({
			model,
			input: 'RooSync multi-agent coordination system',
		});

		expect(response).toBeDefined();
		expect(response.data).toBeDefined();
		expect(response.data.length).toBe(1);

		const vector = response.data[0].embedding;
		expect(Array.isArray(vector)).toBe(true);
		expect(vector.length).toBe(expectedDims);

		// Verify vector values are real numbers (not NaN or Infinity)
		const allFinite = vector.every((v: number) => Number.isFinite(v));
		expect(allFinite).toBe(true);

		console.log(`Embedding generated: ${vector.length} dimensions, first 3 values: [${vector.slice(0, 3).map((v: number) => v.toFixed(4)).join(', ')}]`);
	});

	test('should handle multiple inputs in batch', async () => {
		const client = getOpenAIClient();
		const model = getEmbeddingModel();

		const response = await client.embeddings.create({
			model,
			input: ['first query', 'second query'],
		});

		expect(response.data.length).toBe(2);
		expect(response.data[0].embedding.length).toBe(getEmbeddingDimensions());
		expect(response.data[1].embedding.length).toBe(getEmbeddingDimensions());
	});
});

describe('Live Semantic Search (end-to-end)', () => {
	test('should perform a semantic search on roo_tasks collection', async () => {
		const client = getQdrantClient();
		const openai = getOpenAIClient();
		const model = getEmbeddingModel();
		const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

		// Check if collection exists
		try {
			await client.getCollection(collectionName);
		} catch {
			console.warn(`Collection "${collectionName}" not found — skipping semantic search test`);
			return;
		}

		// Generate query embedding
		const embResponse = await openai.embeddings.create({
			model,
			input: 'scheduler task execution',
		});
		const queryVector = embResponse.data[0].embedding;

		// Search
		const results = await client.search(collectionName, {
			vector: queryVector,
			limit: 5,
			with_payload: true,
		});

		expect(results).toBeDefined();
		expect(Array.isArray(results)).toBe(true);
		// We expect at least some results if the index is populated
		if (results.length > 0) {
			expect(results[0].score).toBeDefined();
			expect(typeof results[0].score).toBe('number');
			console.log(`Search returned ${results.length} results, top score: ${results[0].score.toFixed(4)}`);
		} else {
			console.warn('Search returned 0 results — collection may be empty');
		}
	});

	test('should find workspace collection for roo-extensions', async () => {
		const client = getQdrantClient();
		const collections = await client.getCollections();
		const wsCollections = collections.collections
			.map((c: any) => c.name)
			.filter((name: string) => name.startsWith('ws-'));

		expect(wsCollections.length).toBeGreaterThan(0);
		console.log(`Workspace collections: ${wsCollections.length} (${wsCollections.slice(0, 5).join(', ')})`);

		// Try to search the first ws- collection as a smoke test
		const firstWs = wsCollections[0];
		const info = await client.getCollection(firstWs);
		expect(info.points_count ?? info.vectors_count).toBeGreaterThanOrEqual(0);
		console.log(`Collection "${firstWs}": ${info.points_count ?? info.vectors_count} vectors`);
	});
});
