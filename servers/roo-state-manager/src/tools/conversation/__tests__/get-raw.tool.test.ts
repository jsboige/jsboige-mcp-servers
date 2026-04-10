/**
 * Tests for get-raw.tool.ts
 * Issue #492 - Coverage for get raw conversation tool
 * Issue #1123 - Security: path traversal prevention, taskId validation
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

// Valid UUID for tests
const VALID_UUID = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
const VALID_CLAUDE_SESSION = 'claude-session-abc123--xyz789';

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

	// --- Security tests (Issue #1123) ---

	test('rejects taskId with path traversal (..)', async () => {
		await expect(getRawConversationTool.handler({ taskId: '../../etc/passwd' }))
			.rejects.toThrow('path separators');
	});

	test('rejects taskId with forward slash', async () => {
		await expect(getRawConversationTool.handler({ taskId: 'foo/bar' }))
			.rejects.toThrow('path separators');
	});

	test('rejects taskId with backslash', async () => {
		await expect(getRawConversationTool.handler({ taskId: 'foo\\bar' }))
			.rejects.toThrow('path separators');
	});

	test('rejects taskId with invalid format', async () => {
		await expect(getRawConversationTool.handler({ taskId: 'not-a-uuid' }))
			.rejects.toThrow('Invalid taskId format');
	});

	test('rejects taskId with mixed traversal and invalid format', async () => {
		await expect(getRawConversationTool.handler({ taskId: '../a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' }))
			.rejects.toThrow('path separators');
	});

	test('accepts valid UUID taskId', async () => {
		mockDetectStorageLocations.mockResolvedValue(['/storage']);
		mockAccess.mockResolvedValue(undefined);
		mockReadFile.mockResolvedValue('{"messages": []}');
		mockStat.mockResolvedValue({
			birthtime: new Date('2026-01-01'),
			mtime: new Date('2026-01-02'),
			size: 1024
		});

		const result = await getRawConversationTool.handler({ taskId: VALID_UUID });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.taskId).toBe(VALID_UUID);
	});

	test('accepts valid claude- session ID', async () => {
		mockDetectStorageLocations.mockResolvedValue(['/storage']);
		mockAccess.mockResolvedValue(undefined);
		mockReadFile.mockResolvedValue('{"messages": []}');
		mockStat.mockResolvedValue({
			birthtime: new Date('2026-01-01'),
			mtime: new Date('2026-01-02'),
			size: 512
		});

		const result = await getRawConversationTool.handler({ taskId: VALID_CLAUDE_SESSION });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.taskId).toBe(VALID_CLAUDE_SESSION);
	});

	// --- Functional tests ---

	test('returns raw conversation data when found', async () => {
		mockDetectStorageLocations.mockResolvedValue(['/storage']);
		mockAccess.mockResolvedValue(undefined);
		mockReadFile.mockResolvedValue('{"messages": []}');
		mockStat.mockResolvedValue({
			birthtime: new Date('2026-01-01'),
			mtime: new Date('2026-01-02'),
			size: 1024
		});

		const result = await getRawConversationTool.handler({ taskId: VALID_UUID });

		expect(result.content[0].type).toBe('text');
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.taskId).toBe(VALID_UUID);
		expect(parsed.api_conversation_history).toEqual({ messages: [] });
		expect(parsed.taskStats.size).toBe(1024);
	});

	test('handles BOM in JSON files', async () => {
		mockDetectStorageLocations.mockResolvedValue(['/storage']);
		mockAccess.mockResolvedValue(undefined);
		// BOM character \uFEFF at the start
		mockReadFile.mockResolvedValue('\uFEFF{"key": "value"}');
		mockStat.mockResolvedValue({ birthtime: new Date(), mtime: new Date(), size: 100 });

		const result = await getRawConversationTool.handler({ taskId: VALID_UUID });

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.api_conversation_history).toEqual({ key: 'value' });
	});

	test('returns null for unreadable JSON files with parse errors', async () => {
		mockDetectStorageLocations.mockResolvedValue(['/storage']);
		mockAccess.mockResolvedValue(undefined);
		mockReadFile.mockRejectedValue(new Error('ENOENT'));
		mockStat.mockResolvedValue({ birthtime: new Date(), mtime: new Date(), size: 0 });

		const result = await getRawConversationTool.handler({ taskId: VALID_UUID });

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.api_conversation_history).toBeNull();
		expect(parsed.ui_messages).toBeNull();
		expect(parsed._parseErrors).toBeDefined();
		expect(parsed._parseErrors.length).toBeGreaterThan(0);
	});

	test('throws when task not found in any location', async () => {
		mockDetectStorageLocations.mockResolvedValue(['/storage1', '/storage2']);
		mockAccess.mockRejectedValue(new Error('ENOENT'));

		await expect(getRawConversationTool.handler({ taskId: VALID_UUID }))
			.rejects.toThrow('not found');
	});

	test('tries multiple storage locations', async () => {
		mockDetectStorageLocations.mockResolvedValue(['/loc1', '/loc2']);
		let callCount = 0;
		mockAccess.mockImplementation(async () => {
			callCount++;
			if (callCount === 1) throw new Error('ENOENT');
			return undefined;
		});
		mockReadFile.mockResolvedValue('{}');
		mockStat.mockResolvedValue({ birthtime: new Date(), mtime: new Date(), size: 50 });

		const result = await getRawConversationTool.handler({ taskId: VALID_UUID });

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.taskId).toBe(VALID_UUID);
	});
});
