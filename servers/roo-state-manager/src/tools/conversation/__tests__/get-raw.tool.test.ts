/**
 * Tests for get-raw.tool.ts
 * Issue #492 - Coverage for get raw conversation tool
 *
 * @module tools/conversation/__tests__/get-raw.tool
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockDetectStorageLocations, mockAccess, mockReadFile, mockStat } = vi.hoisted(() => ({
	mockDetectStorageLocations: vi.fn(),
	mockAccess: vi.fn(),
	mockReadFile: vi.fn(),
	mockStat: vi.fn()
}));

vi.mock('../../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		detectStorageLocations: mockDetectStorageLocations
	}
}));

vi.mock('fs', () => ({
	promises: {
		access: mockAccess,
		readFile: mockReadFile,
		stat: mockStat
	}
}));

import { getRawConversationTool } from '../get-raw.tool.js';

describe('getRawConversationTool', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('has correct tool definition', () => {
		expect(getRawConversationTool.definition.name).toBe('get_raw_conversation');
		expect(getRawConversationTool.definition.inputSchema.required).toEqual(['taskId']);
	});

	test('throws when taskId is empty', async () => {
		await expect(getRawConversationTool.handler({ taskId: '' }))
			.rejects.toThrow('taskId is required');
	});

	test('returns raw conversation data when found', async () => {
		mockDetectStorageLocations.mockResolvedValue(['/storage']);
		mockAccess.mockResolvedValue(undefined);
		mockReadFile.mockResolvedValue('{"messages": []}');
		mockStat.mockResolvedValue({
			birthtime: new Date('2026-01-01'),
			mtime: new Date('2026-01-02'),
			size: 1024
		});

		const result = await getRawConversationTool.handler({ taskId: 'task-123' });

		expect(result.content[0].type).toBe('text');
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.taskId).toBe('task-123');
		expect(parsed.api_conversation_history).toEqual({ messages: [] });
		expect(parsed.taskStats.size).toBe(1024);
	});

	test('handles BOM in JSON files', async () => {
		mockDetectStorageLocations.mockResolvedValue(['/storage']);
		mockAccess.mockResolvedValue(undefined);
		// BOM character \uFEFF at the start
		mockReadFile.mockResolvedValue('\uFEFF{"key": "value"}');
		mockStat.mockResolvedValue({ birthtime: new Date(), mtime: new Date(), size: 100 });

		const result = await getRawConversationTool.handler({ taskId: 'bom-task' });

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.api_conversation_history).toEqual({ key: 'value' });
	});

	test('returns null for unreadable JSON files', async () => {
		mockDetectStorageLocations.mockResolvedValue(['/storage']);
		mockAccess.mockResolvedValue(undefined);
		mockReadFile.mockRejectedValue(new Error('ENOENT'));
		mockStat.mockResolvedValue({ birthtime: new Date(), mtime: new Date(), size: 0 });

		const result = await getRawConversationTool.handler({ taskId: 'broken-task' });

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.api_conversation_history).toBeNull();
		expect(parsed.ui_messages).toBeNull();
	});

	test('throws when task not found in any location', async () => {
		mockDetectStorageLocations.mockResolvedValue(['/storage1', '/storage2']);
		mockAccess.mockRejectedValue(new Error('ENOENT'));

		await expect(getRawConversationTool.handler({ taskId: 'missing' }))
			.rejects.toThrow('not found');
	});

	test('tries multiple storage locations', async () => {
		mockDetectStorageLocations.mockResolvedValue(['/loc1', '/loc2']);
		// First location fails, second succeeds
		let callCount = 0;
		mockAccess.mockImplementation(async () => {
			callCount++;
			if (callCount === 1) throw new Error('ENOENT');
			return undefined;
		});
		mockReadFile.mockResolvedValue('{}');
		mockStat.mockResolvedValue({ birthtime: new Date(), mtime: new Date(), size: 50 });

		const result = await getRawConversationTool.handler({ taskId: 'task-in-loc2' });

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.taskId).toBe('task-in-loc2');
	});
});
