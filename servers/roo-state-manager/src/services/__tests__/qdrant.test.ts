/**
 * Tests for qdrant.ts
 * Issue #492 - Coverage for singleton QdrantClient factory
 *
 * @module services/__tests__/qdrant
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock QdrantClient
const mockQdrantClient = { getCollections: vi.fn() };

vi.mock('@qdrant/js-client-rest', () => ({
	QdrantClient: vi.fn().mockImplementation(() => mockQdrantClient)
}));

describe('qdrant', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
		// Clean env vars
		delete process.env.QDRANT_URL;
		delete process.env.QDRANT_API_KEY;
	});

	test('getQdrantClient returns a client instance', async () => {
		process.env.QDRANT_URL = 'https://qdrant.example.com';
		process.env.QDRANT_API_KEY = 'test-key';

		const { getQdrantClient } = await import('../qdrant.js');
		const client = getQdrantClient();
		expect(client).toBeDefined();
		expect(client).toBe(mockQdrantClient);
	});

	test('getQdrantClient returns singleton on repeated calls', async () => {
		process.env.QDRANT_URL = 'https://qdrant.example.com';
		process.env.QDRANT_API_KEY = 'test-key';

		const { getQdrantClient } = await import('../qdrant.js');
		const client1 = getQdrantClient();
		const client2 = getQdrantClient();
		expect(client1).toBe(client2);
	});

	test('getQdrantClient uses QDRANT_URL from env', async () => {
		process.env.QDRANT_URL = 'https://custom-qdrant.example.com';
		process.env.QDRANT_API_KEY = 'api-key-123';

		const { QdrantClient } = await import('@qdrant/js-client-rest');
		const { getQdrantClient } = await import('../qdrant.js');
		getQdrantClient();

		expect(QdrantClient).toHaveBeenCalledWith(expect.objectContaining({
			url: 'https://custom-qdrant.example.com',
			apiKey: 'api-key-123',
			port: 443,
			checkCompatibility: false
		}));
	});

	test('getQdrantClient handles undefined env vars', async () => {
		// No env vars set
		const { getQdrantClient } = await import('../qdrant.js');
		const client = getQdrantClient();
		expect(client).toBeDefined();
	});

	test('resetQdrantClient clears the singleton', async () => {
		process.env.QDRANT_URL = 'https://qdrant.example.com';
		process.env.QDRANT_API_KEY = 'test-key';

		const { QdrantClient } = await import('@qdrant/js-client-rest');
		const { getQdrantClient, resetQdrantClient } = await import('../qdrant.js');

		getQdrantClient();
		expect(QdrantClient).toHaveBeenCalledTimes(1);

		resetQdrantClient();

		getQdrantClient();
		expect(QdrantClient).toHaveBeenCalledTimes(2);
	});

	test('resetQdrantClient is safe to call without prior init', async () => {
		const { resetQdrantClient } = await import('../qdrant.js');
		expect(() => resetQdrantClient()).not.toThrow();
	});
});
