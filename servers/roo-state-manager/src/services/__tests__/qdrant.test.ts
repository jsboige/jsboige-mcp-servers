/**
 * Tests for qdrant.ts
 * Issue #492 - Coverage for singleton QdrantClient factory
 * Extended: getCollectionSize, isLargeCollection, timeout config
 *
 * @module services/__tests__/qdrant
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock QdrantClient — use vi.fn(impl) not vi.fn().mockImplementation(impl)
// vitest auto-clears mockImplementation between tests (even without clearAllMocks)
// but vi.fn(impl) captures the implementation in the constructor, surviving auto-clear.
const mockQdrantClient = { getCollection: vi.fn() };

vi.mock('@qdrant/js-client-rest', () => ({
	QdrantClient: vi.fn(() => mockQdrantClient)
}));

describe('qdrant', () => {
	let getQdrantClient: () => any;
	let resetQdrantClient: () => void;
	let getCollectionSize: () => Promise<number>;
	let isLargeCollection: () => Promise<boolean>;
	let MockedQdrantClient: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		// Clear only the spies we control (not the constructor mock)
		mockQdrantClient.getCollection.mockReset();

		// Reset env vars to safe defaults
		process.env.QDRANT_URL = 'https://qdrant.example.com';
		process.env.QDRANT_API_KEY = 'test-key';
		delete process.env.QDRANT_TIMEOUT_MS;
		delete process.env.QDRANT_COLLECTION_NAME;

		// Import all once
		const qdrantModule = await import('../qdrant.js');
		const qdrantClientModule = await import('@qdrant/js-client-rest');
		getQdrantClient = qdrantModule.getQdrantClient;
		resetQdrantClient = qdrantModule.resetQdrantClient;
		getCollectionSize = qdrantModule.getCollectionSize;
		isLargeCollection = qdrantModule.isLargeCollection;
		MockedQdrantClient = qdrantClientModule.QdrantClient;

		// Reset singleton + clear constructor call tracking
		resetQdrantClient();
		(MockedQdrantClient as ReturnType<typeof vi.fn>).mockClear();
	});

	// ---- getQdrantClient / resetQdrantClient ----

	test('getQdrantClient returns a client instance', () => {
		const client = getQdrantClient();
		expect(client).toBeDefined();
		expect(client).toBe(mockQdrantClient);
	});

	test('getQdrantClient returns singleton on repeated calls', () => {
		const client1 = getQdrantClient();
		const client2 = getQdrantClient();
		expect(client1).toBe(client2);
	});

	test('getQdrantClient uses QDRANT_URL from env', () => {
		process.env.QDRANT_URL = 'https://custom-qdrant.example.com';
		process.env.QDRANT_API_KEY = 'api-key-123';
		resetQdrantClient();

		getQdrantClient();

		expect(MockedQdrantClient).toHaveBeenCalledWith(expect.objectContaining({
			url: 'https://custom-qdrant.example.com',
			apiKey: 'api-key-123',
			port: 443,
			checkCompatibility: false
		}));
	});

	test('getQdrantClient handles undefined env vars', () => {
		delete process.env.QDRANT_URL;
		delete process.env.QDRANT_API_KEY;
		resetQdrantClient();

		const client = getQdrantClient();
		expect(client).toBeDefined();
	});

	test('resetQdrantClient clears the singleton', () => {
		getQdrantClient();
		expect(MockedQdrantClient).toHaveBeenCalledTimes(1);

		resetQdrantClient();
		getQdrantClient();
		expect(MockedQdrantClient).toHaveBeenCalledTimes(2);
	});

	test('resetQdrantClient is safe to call without prior init', () => {
		expect(() => resetQdrantClient()).not.toThrow();
	});

	test('getQdrantClient uses QDRANT_TIMEOUT_MS from env', () => {
		process.env.QDRANT_TIMEOUT_MS = '30000';
		resetQdrantClient();
		getQdrantClient();

		expect(MockedQdrantClient).toHaveBeenCalledWith(expect.objectContaining({
			timeout: 30000
		}));
	});

	test('getQdrantClient defaults timeout to 15000ms', () => {
		resetQdrantClient();
		getQdrantClient();

		expect(MockedQdrantClient).toHaveBeenCalledWith(expect.objectContaining({
			timeout: 15000
		}));
	});

	// ---- getCollectionSize ----

	test('getCollectionSize returns points_count from collection', async () => {
		mockQdrantClient.getCollection.mockResolvedValue({
			points_count: 12345
		});

		const size = await getCollectionSize();
		expect(size).toBe(12345);
	});

	test('getCollectionSize returns 0 when points_count is undefined', async () => {
		mockQdrantClient.getCollection.mockResolvedValue({});

		const size = await getCollectionSize();
		expect(size).toBe(0);
	});

	test('getCollectionSize returns 1 on error (graceful degradation)', async () => {
		mockQdrantClient.getCollection.mockRejectedValue(new Error('connection refused'));

		const size = await getCollectionSize();
		expect(size).toBe(1);
	});

	test('getCollectionSize uses default collection name when env not set', async () => {
		mockQdrantClient.getCollection.mockResolvedValue({ points_count: 50 });

		await getCollectionSize();

		expect(mockQdrantClient.getCollection).toHaveBeenCalledWith('roo_tasks_semantic_index');
	});

	test('getCollectionSize uses QDRANT_COLLECTION_NAME from env when set', async () => {
		process.env.QDRANT_COLLECTION_NAME = 'custom_collection';
		mockQdrantClient.getCollection.mockResolvedValue({ points_count: 42 });

		const size = await getCollectionSize();

		expect(mockQdrantClient.getCollection).toHaveBeenCalledWith('custom_collection');
		expect(size).toBe(42);
	});

	// ---- isLargeCollection ----

	test('isLargeCollection returns true for collections > 5M vectors', async () => {
		mockQdrantClient.getCollection.mockResolvedValue({
			points_count: 6_000_000
		});

		const result = await isLargeCollection();
		expect(result).toBe(true);
	});

	test('isLargeCollection returns false for collections <= 5M vectors', async () => {
		mockQdrantClient.getCollection.mockResolvedValue({
			points_count: 4_999_999
		});

		const result = await isLargeCollection();
		expect(result).toBe(false);
	});

	test('isLargeCollection returns false for exactly 5M vectors', async () => {
		mockQdrantClient.getCollection.mockResolvedValue({
			points_count: 5_000_000
		});

		const result = await isLargeCollection();
		expect(result).toBe(false);
	});
});
