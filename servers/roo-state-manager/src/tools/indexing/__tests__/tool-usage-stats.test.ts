/**
 * Tests for tool_usage_stats action in roosync-indexing.tool.ts
 * Issue #2336 D2 - Parse tool calls from JSONL files instead of Qdrant
 *
 * @module tools/indexing/__tests__/tool-usage-stats
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockDetectStorageLocations } = vi.hoisted(() => ({
	mockDetectStorageLocations: vi.fn(),
}));

vi.mock('../../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		findConversationById: vi.fn(),
		detectStorageLocations: mockDetectStorageLocations
	}
}));

vi.mock('../index-task.tool.js', () => ({
	indexTaskSemanticTool: { handler: vi.fn() }
}));

vi.mock('../reset-collection.tool.js', () => ({
	resetQdrantCollectionTool: { handler: vi.fn() }
}));

vi.mock('../diagnose-index.tool.js', () => ({
	handleDiagnoseSemanticIndex: vi.fn()
}));

import { handleRooSyncIndexing } from '../roosync-indexing.tool.js';

describe('tool_usage_stats action (#2336 D2)', () => {
	const cache = new Map();
	const ensureFresh = vi.fn().mockResolvedValue(true);
	const saveSkeleton = vi.fn();
	const setEnabled = vi.fn();
	const rebuildHandler = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		mockDetectStorageLocations.mockResolvedValue([]);
	});

	test('returns jsonl_scan method and empty stats when no storage locations', async () => {
		const result = await handleRooSyncIndexing(
			{ action: 'tool_usage_stats' },
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler
		);

		expect(result.isError).toBe(false);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.method).toBe('jsonl_scan');
		expect(parsed.total_tool_calls).toBe(0);
		expect(parsed.unique_tools).toBe(0);
		expect(parsed.tools).toEqual([]);
	});

	test('returns error for invalid date format', async () => {
		const result = await handleRooSyncIndexing(
			{ action: 'tool_usage_stats', start_date: 'not-a-date', end_date: 'also-invalid' },
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Invalid');
	});

	test('has correct response structure', async () => {
		const result = await handleRooSyncIndexing(
			{ action: 'tool_usage_stats' },
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler
		);

		expect(result.isError).toBe(false);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.action).toBe('tool_usage_stats');
		expect(parsed.method).toBe('jsonl_scan');
		expect(parsed).toHaveProperty('files_scanned');
		expect(parsed).toHaveProperty('total_tool_calls');
		expect(parsed).toHaveProperty('unique_tools');
		expect(parsed).toHaveProperty('tools');
		expect(parsed).toHaveProperty('weekly_trend');
		expect(parsed).toHaveProperty('date_range');
		expect(parsed).toHaveProperty('source_distribution');
	});

	test('date range defaults to 28 days (4 weeks)', async () => {
		const result = await handleRooSyncIndexing(
			{ action: 'tool_usage_stats' },
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler
		);

		const parsed = JSON.parse(result.content[0].text);
		const { start, end } = parsed.date_range;
		const diffDays = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000);
		expect(diffDays).toBe(28);
	});

	test('respects custom date range', async () => {
		const result = await handleRooSyncIndexing(
			{ action: 'tool_usage_stats', start_date: '2026-05-01', end_date: '2026-05-14' },
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler
		);

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.date_range.start).toBe('2026-05-01');
		expect(parsed.date_range.end).toBe('2026-05-14');
	});
});
