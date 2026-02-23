/**
 * Tests for get-stats.tool.ts
 * Issue #492 - Coverage for storage stats tool
 *
 * @module tools/storage/__tests__/get-stats.tool
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockGetStorageStats, mockGetWorkspaceBreakdown } = vi.hoisted(() => ({
	mockGetStorageStats: vi.fn(),
	mockGetWorkspaceBreakdown: vi.fn()
}));

vi.mock('../../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		getStorageStats: mockGetStorageStats,
		getWorkspaceBreakdown: mockGetWorkspaceBreakdown
	}
}));

import { getStorageStatsTool } from '../get-stats.tool.js';

describe('getStorageStatsTool', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('has correct tool definition', () => {
		expect(getStorageStatsTool.definition.name).toBe('get_storage_stats');
		expect(getStorageStatsTool.definition.inputSchema.type).toBe('object');
		expect(getStorageStatsTool.definition.inputSchema.required).toEqual([]);
	});

	test('handler returns enhanced stats with workspace breakdown', async () => {
		mockGetStorageStats.mockResolvedValue({
			totalConversations: 100,
			totalSize: 50000000
		});
		mockGetWorkspaceBreakdown.mockResolvedValue({
			'/workspace/a': { conversations: 60, size: 30000000 },
			'/workspace/b': { conversations: 40, size: 20000000 }
		});

		const result = await getStorageStatsTool.handler({});

		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe('text');
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.totalConversations).toBe(100);
		expect(parsed.totalSize).toBe(50000000);
		expect(parsed.totalWorkspaces).toBe(2);
		expect(parsed.workspaceBreakdown).toBeDefined();
		expect(parsed.workspaceBreakdown['/workspace/a'].conversations).toBe(60);
	});

	test('handler includes totalWorkspaces count', async () => {
		mockGetStorageStats.mockResolvedValue({ totalConversations: 0 });
		mockGetWorkspaceBreakdown.mockResolvedValue({
			'/ws1': {}, '/ws2': {}, '/ws3': {}
		});

		const result = await getStorageStatsTool.handler({});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.totalWorkspaces).toBe(3);
	});

	test('handler handles empty workspace breakdown', async () => {
		mockGetStorageStats.mockResolvedValue({ totalConversations: 0 });
		mockGetWorkspaceBreakdown.mockResolvedValue({});

		const result = await getStorageStatsTool.handler({});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.totalWorkspaces).toBe(0);
		expect(parsed.workspaceBreakdown).toEqual({});
	});

	test('handler propagates errors from getStorageStats', async () => {
		mockGetStorageStats.mockRejectedValue(new Error('Stats unavailable'));

		await expect(getStorageStatsTool.handler({})).rejects.toThrow('Stats unavailable');
	});

	test('handler propagates errors from getWorkspaceBreakdown', async () => {
		mockGetStorageStats.mockResolvedValue({ totalConversations: 10 });
		mockGetWorkspaceBreakdown.mockRejectedValue(new Error('Breakdown failed'));

		await expect(getStorageStatsTool.handler({})).rejects.toThrow('Breakdown failed');
	});

	test('handler calls both detector methods', async () => {
		mockGetStorageStats.mockResolvedValue({});
		mockGetWorkspaceBreakdown.mockResolvedValue({});

		await getStorageStatsTool.handler({});

		expect(mockGetStorageStats).toHaveBeenCalledTimes(1);
		expect(mockGetWorkspaceBreakdown).toHaveBeenCalledTimes(1);
	});
});
