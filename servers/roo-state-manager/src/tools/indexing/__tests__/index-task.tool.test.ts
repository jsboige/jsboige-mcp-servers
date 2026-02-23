/**
 * Tests for index-task.tool.ts
 * Issue #492 - Coverage for semantic indexing tool
 *
 * @module tools/indexing/__tests__/index-task.tool
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockDetectRooStorage, mockFindConversationById } = vi.hoisted(() => ({
	mockDetectRooStorage: vi.fn(),
	mockFindConversationById: vi.fn()
}));

vi.mock('../../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		detectRooStorage: mockDetectRooStorage,
		findConversationById: mockFindConversationById
	}
}));

import { indexTaskSemanticTool } from '../index-task.tool.js';

describe('indexTaskSemanticTool', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		vi.clearAllMocks();
		process.env = { ...originalEnv };
		process.env.EMBEDDING_API_KEY = 'test-key';
		process.env.QDRANT_URL = 'http://localhost:6333';
		process.env.QDRANT_COLLECTION_NAME = 'test_collection';
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	// ============================================================
	// Tool definition
	// ============================================================

	test('has correct tool definition', () => {
		expect(indexTaskSemanticTool.definition.name).toBe('index_task_semantic');
		expect(indexTaskSemanticTool.definition.inputSchema.type).toBe('object');
		expect(indexTaskSemanticTool.definition.inputSchema.required).toEqual(['task_id']);
	});

	test('definition has task_id property', () => {
		const props = indexTaskSemanticTool.definition.inputSchema.properties;
		expect((props as any).task_id.type).toBe('string');
	});

	// ============================================================
	// Handler - env validation
	// ============================================================

	test('handler throws when no API key configured', async () => {
		delete process.env.EMBEDDING_API_KEY;
		delete process.env.OPENAI_API_KEY;

		const cache = new Map();
		const ensureFresh = vi.fn().mockResolvedValue(true);

		const result = await indexTaskSemanticTool.handler(
			{ task_id: 'test-1' },
			cache,
			ensureFresh
		);

		// Error is caught internally and returned as error text
		expect(result.content[0].text).toContain('Erreur');
	});

	test('handler accepts OPENAI_API_KEY as fallback', async () => {
		delete process.env.EMBEDDING_API_KEY;
		process.env.OPENAI_API_KEY = 'openai-key';

		const cache = new Map();
		cache.set('test-1', { metadata: {} });
		const ensureFresh = vi.fn().mockResolvedValue(true);
		mockFindConversationById.mockResolvedValue(null);

		const result = await indexTaskSemanticTool.handler(
			{ task_id: 'test-1' },
			cache,
			ensureFresh
		);

		// Task path not found but API key was accepted
		expect(result.content[0].text).toContain('Erreur');
		expect(result.content[0].text).toContain('not found');
	});

	// ============================================================
	// Handler - cache check
	// ============================================================

	test('handler calls ensureCacheFreshCallback', async () => {
		const cache = new Map();
		const ensureFresh = vi.fn().mockResolvedValue(true);

		await indexTaskSemanticTool.handler(
			{ task_id: 'missing-task' },
			cache,
			ensureFresh
		);

		expect(ensureFresh).toHaveBeenCalledTimes(1);
	});

	test('handler returns error when task not in cache', async () => {
		const cache = new Map();
		const ensureFresh = vi.fn().mockResolvedValue(true);

		const result = await indexTaskSemanticTool.handler(
			{ task_id: 'nonexistent' },
			cache,
			ensureFresh
		);

		expect(result.content[0].text).toContain('nonexistent');
		expect(result.content[0].text).toContain('not found');
	});

	test('handler returns error when task path not found', async () => {
		const cache = new Map();
		cache.set('test-1', { metadata: {} });
		const ensureFresh = vi.fn().mockResolvedValue(true);
		mockFindConversationById.mockResolvedValue(null);

		const result = await indexTaskSemanticTool.handler(
			{ task_id: 'test-1' },
			cache,
			ensureFresh
		);

		expect(result.content[0].text).toContain('not found');
	});

	test('handler returns error when conversation has no path', async () => {
		const cache = new Map();
		cache.set('test-1', { metadata: {} });
		const ensureFresh = vi.fn().mockResolvedValue(true);
		mockFindConversationById.mockResolvedValue({ path: null });

		const result = await indexTaskSemanticTool.handler(
			{ task_id: 'test-1' },
			cache,
			ensureFresh
		);

		expect(result.content[0].text).toContain('not found');
	});
});
