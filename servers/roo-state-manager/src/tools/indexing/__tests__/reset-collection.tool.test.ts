/**
 * Tests for reset-collection.tool.ts
 * Issue #492 - Coverage for indexing tools
 * Issue #1274 - Confirm parameter enforcement
 *
 * @module tools/indexing/__tests__/reset-collection.tool
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockResetCollection } = vi.hoisted(() => ({
	mockResetCollection: vi.fn()
}));

vi.mock('../../../services/task-indexer.js', () => ({
	TaskIndexer: class {
		resetCollection = mockResetCollection;
	}
}));

import { resetQdrantCollectionTool } from '../reset-collection.tool.js';

describe('resetQdrantCollectionTool', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('has correct tool definition', () => {
		expect(resetQdrantCollectionTool.definition.name).toBe('reset_qdrant_collection');
		expect(resetQdrantCollectionTool.definition.inputSchema.type).toBe('object');
		expect(resetQdrantCollectionTool.definition.inputSchema.required).toEqual([]);
	});

	test('definition includes confirm property', () => {
		const props = resetQdrantCollectionTool.definition.inputSchema.properties;
		expect(props).toBeDefined();
		expect((props as any).confirm.type).toBe('boolean');
	});

	test('handler resets collection and clears skeleton timestamps', async () => {
		mockResetCollection.mockResolvedValue(undefined);

		const cache = new Map<string, any>();
		cache.set('task-1', { metadata: { qdrantIndexedAt: '2026-01-01' } });
		cache.set('task-2', { metadata: { qdrantIndexedAt: '2026-01-02' } });
		cache.set('task-3', { metadata: {} }); // no qdrantIndexedAt

		const saveCallback = vi.fn().mockResolvedValue(undefined);
		const indexQueue = new Set<string>();
		const setIndexingEnabled = vi.fn();

		const result = await resetQdrantCollectionTool.handler(
			{ confirm: true },
			cache,
			saveCallback,
			indexQueue,
			setIndexingEnabled
		);

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.skeletonsReset).toBe(2); // only 2 had qdrantIndexedAt
		expect(parsed.queuedForReindexing).toBe(3); // all 3 added to queue
	});

	test('handler calls resetCollection on TaskIndexer', async () => {
		mockResetCollection.mockResolvedValue(undefined);

		const result = await resetQdrantCollectionTool.handler(
			{ confirm: true },
			new Map(),
			vi.fn().mockResolvedValue(undefined),
			new Set(),
			vi.fn()
		);

		expect(mockResetCollection).toHaveBeenCalledTimes(1);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
	});

	test('handler saves skeleton after clearing qdrantIndexedAt', async () => {
		mockResetCollection.mockResolvedValue(undefined);

		const skeleton = { metadata: { qdrantIndexedAt: '2026-01-01', other: 'data' } };
		const cache = new Map<string, any>();
		cache.set('task-x', skeleton);

		const saveCallback = vi.fn().mockResolvedValue(undefined);

		await resetQdrantCollectionTool.handler(
			{ confirm: true },
			cache,
			saveCallback,
			new Set(),
			vi.fn()
		);

		expect(saveCallback).toHaveBeenCalledWith(skeleton);
		expect(skeleton.metadata.qdrantIndexedAt).toBeUndefined();
		expect(skeleton.metadata.other).toBe('data'); // other metadata preserved
	});

	test('handler adds all tasks to index queue', async () => {
		mockResetCollection.mockResolvedValue(undefined);

		const cache = new Map<string, any>();
		cache.set('a', { metadata: {} });
		cache.set('b', { metadata: {} });
		const indexQueue = new Set<string>();

		await resetQdrantCollectionTool.handler(
			{ confirm: true },
			cache,
			vi.fn().mockResolvedValue(undefined),
			indexQueue,
			vi.fn()
		);

		expect(indexQueue.has('a')).toBe(true);
		expect(indexQueue.has('b')).toBe(true);
		expect(indexQueue.size).toBe(2);
	});

	test('handler re-enables indexing', async () => {
		mockResetCollection.mockResolvedValue(undefined);

		const setEnabled = vi.fn();

		await resetQdrantCollectionTool.handler(
			{ confirm: true },
			new Map(),
			vi.fn().mockResolvedValue(undefined),
			new Set(),
			setEnabled
		);

		expect(setEnabled).toHaveBeenCalledWith(true);
	});

	test('handler returns error result on resetCollection failure', async () => {
		mockResetCollection.mockRejectedValue(new Error('Qdrant down'));

		const result = await resetQdrantCollectionTool.handler(
			{ confirm: true },
			new Map(),
			vi.fn().mockResolvedValue(undefined),
			new Set(),
			vi.fn()
		);

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.message).toContain('Qdrant down');
	});

	test('handler handles empty cache', async () => {
		mockResetCollection.mockResolvedValue(undefined);

		const result = await resetQdrantCollectionTool.handler(
			{ confirm: true },
			new Map(),
			vi.fn().mockResolvedValue(undefined),
			new Set(),
			vi.fn()
		);

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.skeletonsReset).toBe(0);
		expect(parsed.queuedForReindexing).toBe(0);
	});

	test('handler rejects without confirm', async () => {
		const result = await resetQdrantCollectionTool.handler(
			{},
			new Map(),
			vi.fn().mockResolvedValue(undefined),
			new Set(),
			vi.fn()
		);

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.message).toContain('Confirmation requise');
		expect(mockResetCollection).not.toHaveBeenCalled();
	});

	test('handler rejects with confirm: false', async () => {
		const result = await resetQdrantCollectionTool.handler(
			{ confirm: false },
			new Map(),
			vi.fn().mockResolvedValue(undefined),
			new Set(),
			vi.fn()
		);

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.message).toContain('Confirmation requise');
		expect(mockResetCollection).not.toHaveBeenCalled();
	});
});
