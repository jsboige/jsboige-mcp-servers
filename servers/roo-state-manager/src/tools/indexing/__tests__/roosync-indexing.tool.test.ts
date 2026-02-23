/**
 * Tests for roosync-indexing.tool.ts
 * Issue #492 - Coverage for unified indexing dispatcher
 *
 * @module tools/indexing/__tests__/roosync-indexing.tool
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockIndexHandler, mockResetHandler, mockDiagnoseHandler, mockRebuildHandler } = vi.hoisted(() => ({
	mockIndexHandler: vi.fn(),
	mockResetHandler: vi.fn(),
	mockDiagnoseHandler: vi.fn(),
	mockRebuildHandler: vi.fn()
}));

vi.mock('../index-task.tool.js', () => ({
	indexTaskSemanticTool: {
		handler: mockIndexHandler
	}
}));

vi.mock('../reset-collection.tool.js', () => ({
	resetQdrantCollectionTool: {
		handler: mockResetHandler
	}
}));

vi.mock('../diagnose-index.tool.js', () => ({
	handleDiagnoseSemanticIndex: mockDiagnoseHandler
}));

import { roosyncIndexingTool, handleRooSyncIndexing } from '../roosync-indexing.tool.js';

describe('roosyncIndexingTool', () => {
	const cache = new Map();
	const ensureFresh = vi.fn().mockResolvedValue(true);
	const saveSkeleton = vi.fn().mockResolvedValue(undefined);
	const indexQueue = new Set<string>();
	const setEnabled = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ============================================================
	// Tool definition
	// ============================================================

	test('has correct tool name', () => {
		expect(roosyncIndexingTool.name).toBe('roosync_indexing');
	});

	test('has required action field', () => {
		expect(roosyncIndexingTool.inputSchema.required).toEqual(['action']);
	});

	test('has action enum with 5 values', () => {
		const actionProp = (roosyncIndexingTool.inputSchema.properties as any).action;
		expect(actionProp.enum).toEqual(['index', 'reset', 'rebuild', 'diagnose', 'archive']);
	});

	// ============================================================
	// Action validation
	// ============================================================

	test('returns error when action is missing', async () => {
		const result = await handleRooSyncIndexing(
			{} as any,
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);
		expect((result as any).isError).toBe(true);
		expect(result.content[0].text).toContain('action');
	});

	test('returns error for invalid action', async () => {
		const result = await handleRooSyncIndexing(
			{ action: 'invalid' as any },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);
		expect((result as any).isError).toBe(true);
		expect(result.content[0].text).toContain('invalid');
	});

	// ============================================================
	// Index action
	// ============================================================

	test('index action requires task_id', async () => {
		const result = await handleRooSyncIndexing(
			{ action: 'index' },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);
		expect((result as any).isError).toBe(true);
		expect(result.content[0].text).toContain('task_id');
	});

	test('index action delegates to indexTaskSemanticTool', async () => {
		const expected = { content: [{ type: 'text', text: 'indexed' }] };
		mockIndexHandler.mockResolvedValue(expected);

		const result = await handleRooSyncIndexing(
			{ action: 'index', task_id: 'abc-123' },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);

		expect(mockIndexHandler).toHaveBeenCalledWith(
			{ task_id: 'abc-123' },
			cache,
			ensureFresh
		);
		expect(result).toBe(expected);
	});

	// ============================================================
	// Reset action
	// ============================================================

	test('reset action delegates to resetQdrantCollectionTool', async () => {
		const expected = { content: [{ type: 'text', text: 'reset' }] };
		mockResetHandler.mockResolvedValue(expected);

		const result = await handleRooSyncIndexing(
			{ action: 'reset', confirm: true },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);

		expect(mockResetHandler).toHaveBeenCalledWith(
			{ confirm: true },
			cache,
			saveSkeleton,
			indexQueue,
			setEnabled
		);
		expect(result).toBe(expected);
	});

	// ============================================================
	// Rebuild action
	// ============================================================

	test('rebuild action delegates to rebuildHandler', async () => {
		const expected = { content: [{ type: 'text', text: 'rebuilt' }] };
		mockRebuildHandler.mockResolvedValue(expected);

		const result = await handleRooSyncIndexing(
			{ action: 'rebuild', workspace_filter: '/ws', max_tasks: 10, dry_run: true },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);

		expect(mockRebuildHandler).toHaveBeenCalledWith({
			workspace_filter: '/ws',
			max_tasks: 10,
			dry_run: true
		});
		expect(result).toBe(expected);
	});

	// ============================================================
	// Diagnose action
	// ============================================================

	test('diagnose action delegates to handleDiagnoseSemanticIndex', async () => {
		const expected = { content: [{ type: 'text', text: 'diagnosed' }] };
		mockDiagnoseHandler.mockResolvedValue(expected);

		const result = await handleRooSyncIndexing(
			{ action: 'diagnose' },
			cache, ensureFresh, saveSkeleton, indexQueue, setEnabled, mockRebuildHandler
		);

		expect(mockDiagnoseHandler).toHaveBeenCalledWith(cache);
		expect(result).toBe(expected);
	});
});
