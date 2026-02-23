/**
 * Tests for detect-storage.tool.ts
 * Issue #492 - Coverage for storage detection tool
 *
 * @module tools/storage/__tests__/detect-storage.tool
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockDetectRooStorage } = vi.hoisted(() => ({
	mockDetectRooStorage: vi.fn()
}));

vi.mock('../../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		detectRooStorage: mockDetectRooStorage
	}
}));

import { detectStorageTool } from '../detect-storage.tool.js';

describe('detectStorageTool', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('has correct tool definition', () => {
		expect(detectStorageTool.definition.name).toBe('detect_roo_storage');
		expect(detectStorageTool.definition.inputSchema.type).toBe('object');
		expect(detectStorageTool.definition.inputSchema.required).toEqual([]);
	});

	test('handler returns storage detection result', async () => {
		const mockResult = {
			storageLocations: ['/path/to/roo/storage'],
			totalConversations: 42
		};
		mockDetectRooStorage.mockResolvedValue(mockResult);

		const result = await detectStorageTool.handler({});

		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe('text');
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.storageLocations).toEqual(['/path/to/roo/storage']);
		expect(parsed.totalConversations).toBe(42);
	});

	test('handler returns JSON-formatted text', async () => {
		mockDetectRooStorage.mockResolvedValue({ found: true });

		const result = await detectStorageTool.handler({});
		const text = result.content[0].text;

		// Should be pretty-printed JSON (indented)
		expect(text).toContain('\n');
		expect(JSON.parse(text)).toEqual({ found: true });
	});

	test('handler propagates errors from detector', async () => {
		mockDetectRooStorage.mockRejectedValue(new Error('Storage not accessible'));

		await expect(detectStorageTool.handler({})).rejects.toThrow('Storage not accessible');
	});

	test('handler returns empty result when no storage found', async () => {
		mockDetectRooStorage.mockResolvedValue({ storageLocations: [], totalConversations: 0 });

		const result = await detectStorageTool.handler({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.storageLocations).toEqual([]);
		expect(parsed.totalConversations).toBe(0);
	});
});
