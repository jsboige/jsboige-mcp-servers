/**
 * Tests for openai.ts
 * Issue #492 - Coverage for embedding helper functions
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { MockOpenAI } = vi.hoisted(() => ({
	MockOpenAI: vi.fn()
}));

vi.mock('openai', () => ({
	default: MockOpenAI
}));

describe('openai', () => {
	const origEnv = { ...process.env };

	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		// Reset env vars
		delete process.env.EMBEDDING_MODEL;
		delete process.env.EMBEDDING_DIMENSIONS;
		delete process.env.EMBEDDING_API_KEY;
		delete process.env.OPENAI_API_KEY;
		delete process.env.EMBEDDING_API_BASE_URL;
	});

	afterEach(() => {
		process.env = { ...origEnv };
	});

	// ============================================================
	// getEmbeddingModel
	// ============================================================

	describe('getEmbeddingModel', () => {
		test('returns default model when env not set', async () => {
			const { getEmbeddingModel } = await import('../openai.js');
			expect(getEmbeddingModel()).toBe('text-embedding-3-small');
		});

		test('returns custom model from env', async () => {
			process.env.EMBEDDING_MODEL = 'qwen3-4b-awq';
			const { getEmbeddingModel } = await import('../openai.js');
			expect(getEmbeddingModel()).toBe('qwen3-4b-awq');
		});

		test('returns empty string if env is empty', async () => {
			process.env.EMBEDDING_MODEL = '';
			const { getEmbeddingModel } = await import('../openai.js');
			// Empty string is falsy, so falls back to default
			expect(getEmbeddingModel()).toBe('text-embedding-3-small');
		});
	});

	// ============================================================
	// getEmbeddingDimensions
	// ============================================================

	describe('getEmbeddingDimensions', () => {
		test('returns default 1536 when env not set', async () => {
			const { getEmbeddingDimensions } = await import('../openai.js');
			expect(getEmbeddingDimensions()).toBe(1536);
		});

		test('returns custom dimensions from env', async () => {
			process.env.EMBEDDING_DIMENSIONS = '2560';
			const { getEmbeddingDimensions } = await import('../openai.js');
			expect(getEmbeddingDimensions()).toBe(2560);
		});

		test('returns 1536 for non-numeric env value', async () => {
			process.env.EMBEDDING_DIMENSIONS = 'not-a-number';
			const { getEmbeddingDimensions } = await import('../openai.js');
			expect(getEmbeddingDimensions()).toBe(1536);
		});

		test('returns 1536 for zero', async () => {
			process.env.EMBEDDING_DIMENSIONS = '0';
			const { getEmbeddingDimensions } = await import('../openai.js');
			expect(getEmbeddingDimensions()).toBe(1536);
		});

		test('returns 1536 for negative number', async () => {
			process.env.EMBEDDING_DIMENSIONS = '-100';
			const { getEmbeddingDimensions } = await import('../openai.js');
			expect(getEmbeddingDimensions()).toBe(1536);
		});

		test('parses valid integer string', async () => {
			process.env.EMBEDDING_DIMENSIONS = '768';
			const { getEmbeddingDimensions } = await import('../openai.js');
			expect(getEmbeddingDimensions()).toBe(768);
		});
	});

	// ============================================================
	// getOpenAIClient (default export)
	// ============================================================

	describe('getOpenAIClient', () => {
		test('throws when no API key configured', async () => {
			const mod = await import('../openai.js');
			expect(() => mod.default()).toThrow('No embedding API key configured');
		});

		test('creates client with EMBEDDING_API_KEY', async () => {
			process.env.EMBEDDING_API_KEY = 'test-embedding-key';
			MockOpenAI.mockImplementation(() => ({ mock: true }));

			const mod = await import('../openai.js');
			const client = mod.default();

			expect(client).toBeDefined();
			expect(MockOpenAI).toHaveBeenCalledWith({
				apiKey: 'test-embedding-key',
				baseURL: undefined
			});
		});

		test('falls back to OPENAI_API_KEY', async () => {
			process.env.OPENAI_API_KEY = 'test-openai-key';
			MockOpenAI.mockImplementation(() => ({ mock: true }));

			const mod = await import('../openai.js');
			const client = mod.default();

			expect(client).toBeDefined();
			expect(MockOpenAI).toHaveBeenCalledWith({
				apiKey: 'test-openai-key',
				baseURL: undefined
			});
		});

		test('prefers EMBEDDING_API_KEY over OPENAI_API_KEY', async () => {
			process.env.EMBEDDING_API_KEY = 'embed-key';
			process.env.OPENAI_API_KEY = 'openai-key';
			MockOpenAI.mockImplementation(() => ({ mock: true }));

			const mod = await import('../openai.js');
			mod.default();

			expect(MockOpenAI).toHaveBeenCalledWith({
				apiKey: 'embed-key',
				baseURL: undefined
			});
		});

		test('uses EMBEDDING_API_BASE_URL when set', async () => {
			process.env.EMBEDDING_API_KEY = 'key';
			process.env.EMBEDDING_API_BASE_URL = 'https://custom.api.com/v1';
			MockOpenAI.mockImplementation(() => ({ mock: true }));

			const mod = await import('../openai.js');
			mod.default();

			expect(MockOpenAI).toHaveBeenCalledWith({
				apiKey: 'key',
				baseURL: 'https://custom.api.com/v1'
			});
		});

		test('returns singleton on subsequent calls', async () => {
			process.env.EMBEDDING_API_KEY = 'key';
			const instance = { singleton: true };
			MockOpenAI.mockImplementation(() => instance);

			const mod = await import('../openai.js');
			const first = mod.default();
			const second = mod.default();

			expect(first).toBe(second);
			expect(MockOpenAI).toHaveBeenCalledTimes(1);
		});
	});
});
