/**
 * Tests for index-task.tool.ts
 * Issue #492 - Coverage for semantic indexing tool
 * Issue #833 Sprint C3 - Claude Code source routing branch coverage (web1 lane `src/tools/indexing/`)
 *
 * @module tools/indexing/__tests__/index-task.tool
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockDetectRooStorage, mockFindConversationById, mockClaudeFindConversationById } = vi.hoisted(() => ({
	mockDetectRooStorage: vi.fn(),
	mockFindConversationById: vi.fn(),
	mockClaudeFindConversationById: vi.fn()
}));

vi.mock('../../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		detectRooStorage: mockDetectRooStorage,
		findConversationById: mockFindConversationById
	}
}));

vi.mock('../../../utils/claude-storage-detector.js', () => ({
	ClaudeStorageDetector: {
		findConversationById: mockClaudeFindConversationById
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

	// ============================================================
	// Handler - source='claude-code' branch (src L64-74)
	// #833 Sprint C3: routing Claude Code session through ClaudeStorageDetector
	// rather than the Roo cache + RooStorageDetector path.
	// ============================================================

	test('claude-code source: ClaudeStorageDetector.findConversationById is called (not Roo cache)', async () => {
		// Source: L64-67 — when source='claude-code', tool delegates to ClaudeStorageDetector
		// and reads taskPath from claudeConversation?.metadata?.dataSource.
		mockClaudeFindConversationById.mockResolvedValue({
			metadata: { dataSource: '/tmp/claude-projects/session-xyz.jsonl' }
		});

		const cache = new Map();
		// Even though we seed the cache, claude-code source must NOT use it.
		cache.set('claude-session', { metadata: {} });
		const ensureFresh = vi.fn().mockResolvedValue(true);

		await indexTaskSemanticTool.handler(
			{ task_id: 'claude-session', source: 'claude-code' },
			cache,
			ensureFresh
		);

		expect(mockClaudeFindConversationById).toHaveBeenCalledWith('claude-session');
		// Roo path MUST NOT be invoked for claude-code source.
		expect(mockFindConversationById).not.toHaveBeenCalled();
	});

	test('claude-code source: returns "not found" error when ClaudeStorageDetector yields no session', async () => {
		// Source: L69-74 — claudeConversation?.metadata?.dataSource undefined → GenericError
		mockClaudeFindConversationById.mockResolvedValue(null);

		const cache = new Map();
		const ensureFresh = vi.fn().mockResolvedValue(true);

		const result = await indexTaskSemanticTool.handler(
			{ task_id: 'missing-claude-session', source: 'claude-code' },
			cache,
			ensureFresh
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Claude Code session 'missing-claude-session' not found");
	});

	test('claude-code source: returns "not found" error when metadata.dataSource is missing', async () => {
		// Source: L67 — taskPath = claudeConversation?.metadata?.dataSource
		// When metadata or dataSource is undefined → falls into the L69-74 error.
		mockClaudeFindConversationById.mockResolvedValue({ metadata: {} });

		const cache = new Map();
		const ensureFresh = vi.fn().mockResolvedValue(true);

		const result = await indexTaskSemanticTool.handler(
			{ task_id: 'claude-no-path', source: 'claude-code' },
			cache,
			ensureFresh
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('claude-no-path');
		expect(result.content[0].text).toContain('not found');
	});

	test('default source: RooStorageDetector is consulted, not ClaudeStorageDetector', async () => {
		// Source: L47 (default 'roo') + L75-84 — only RooStorageDetector should fire when
		// source is omitted. This is the existing-roo branch, asserted explicitly to lock the
		// dispatcher routing.
		mockFindConversationById.mockResolvedValue({ path: '/tmp/roo/task-1' });

		const cache = new Map();
		cache.set('test-1', { metadata: {} });
		const ensureFresh = vi.fn().mockResolvedValue(true);

		await indexTaskSemanticTool.handler(
			{ task_id: 'test-1' },
			cache,
			ensureFresh
		);

		expect(mockFindConversationById).toHaveBeenCalledWith('test-1');
		expect(mockClaudeFindConversationById).not.toHaveBeenCalled();
	});
});
