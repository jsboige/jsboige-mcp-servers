/**
 * Tests pour cleanup.ts
 * Issue #613 ISS-1 - RooSync message cleanup
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockBulkOperation } = vi.hoisted(() => ({
	mockBulkOperation: vi.fn()
}));

const { mockGetSharedStatePath } = vi.hoisted(() => ({
	mockGetSharedStatePath: vi.fn()
}));

const { mockGetLocalMachineId } = vi.hoisted(() => ({
	mockGetLocalMachineId: vi.fn()
}));

vi.mock('../../../services/MessageManager.js', () => ({
	MessageManager: class {
		constructor() {}
		bulkOperation(...args: any[]) { return mockBulkOperation(...args); }
	}
}));

vi.mock('../../../utils/server-helpers.js', () => ({
	getSharedStatePath: mockGetSharedStatePath
}));

vi.mock('../../../utils/message-helpers.js', () => ({
	getLocalMachineId: mockGetLocalMachineId
}));

vi.mock('../../../utils/logger.js', () => ({
	createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
	Logger: class {}
}));

describe('cleanup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetSharedStatePath.mockReturnValue('/shared/state');
		mockGetLocalMachineId.mockReturnValue('test-machine');
	});

	test('exports cleanupToolMetadata', async () => {
		const module = await import('../cleanup.js');
		expect(module.cleanupToolMetadata).toBeDefined();
		expect(module.cleanupToolMetadata.name).toBe('roosync_cleanup_messages');
		expect(module.cleanupToolMetadata.inputSchema.properties.operation).toBeDefined();
	});

	test('exports CleanupMessagesArgs type', async () => {
		const module = await import('../cleanup.js');
		// Type is exported but not a runtime value, so we can't test it directly
		// The compilation would fail if the type wasn't exported
		// We can at least verify the module loaded successfully
		expect(module.cleanupMessages).toBeDefined();
	});

	test('requires operation parameter', async () => {
		const { cleanupMessages } = await import('../cleanup.js');
		// @ts-expect-error - testing missing required parameter
		const result = await cleanupMessages({});
		expect(result.content[0].text).toContain('Erreur');
	});

	test('calls bulkOperation with mark_read operation', async () => {
		mockBulkOperation.mockResolvedValue({
			operation: 'mark_read',
			matched: 5,
			processed: 5,
			errors: 0,
			message_ids: ['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5']
		});

		const { cleanupMessages } = await import('../cleanup.js');
		const result = await cleanupMessages({
			operation: 'mark_read',
			priority: 'LOW'
		});

		expect(mockBulkOperation).toHaveBeenCalledWith(
			'test-machine',
			'mark_read',
			{ priority: 'LOW' }
		);
		expect(result.content[0].text).toContain('Cleanup RooSync - mark_read');
		expect(result.content[0].text).toContain('**Messages correspondants :** 5');
		expect(result.content[0].text).toContain('**Messages traités :** 5');
	});

	test('calls bulkOperation with archive operation', async () => {
		mockBulkOperation.mockResolvedValue({
			operation: 'archive',
			matched: 3,
			processed: 3,
			errors: 0,
			message_ids: ['msg-1', 'msg-2', 'msg-3']
		});

		const { cleanupMessages } = await import('../cleanup.js');
		const result = await cleanupMessages({
			operation: 'archive',
			from: 'test-machine'
		});

		expect(mockBulkOperation).toHaveBeenCalledWith(
			'test-machine',
			'archive',
			{ from: 'test-machine' }
		);
		expect(result.content[0].text).toContain('Cleanup RooSync - archive');
	});

	test('applies multiple filters correctly', async () => {
		mockBulkOperation.mockResolvedValue({
			operation: 'mark_read',
			matched: 1,
			processed: 1,
			errors: 0,
			message_ids: ['msg-1']
		});

		const { cleanupMessages } = await import('../cleanup.js');
		await cleanupMessages({
			operation: 'mark_read',
			from: 'sender',
			priority: 'LOW',
			status: 'unread',
			subject_contains: 'test',
			tag: 'test-tag'
		});

		expect(mockBulkOperation).toHaveBeenCalledWith(
			'test-machine',
			'mark_read',
			{
				from: 'sender',
				priority: 'LOW',
				status: 'unread',
				subject_contains: 'test',
				tag: 'test-tag'
			}
		);
	});

	test('formats result with verbose=true shows message IDs', async () => {
		mockBulkOperation.mockResolvedValue({
			operation: 'mark_read',
			matched: 25,
			processed: 25,
			errors: 0,
			message_ids: Array.from({ length: 25 }, (_, i) => `msg-${i + 1}`)
		});

		const { cleanupMessages } = await import('../cleanup.js');
		const result = await cleanupMessages({
			operation: 'mark_read',
			verbose: true
		});

		const text = result.content[0].text;
		expect(text).toContain('**IDs traités** (20/25 affichés)');
		expect(text).toContain('- msg-1');
		expect(text).toContain('- msg-20');
		expect(text).toContain('... et 5 autres');
	});

	test('formats result with verbose=false hides message IDs', async () => {
		mockBulkOperation.mockResolvedValue({
			operation: 'mark_read',
			matched: 5,
			processed: 5,
			errors: 0,
			message_ids: ['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5']
		});

		const { cleanupMessages } = await import('../cleanup.js');
		const result = await cleanupMessages({
			operation: 'mark_read',
			verbose: false
		});

		const text = result.content[0].text;
		expect(text).toContain('Cleanup RooSync - mark_read');
		expect(text).toContain('**Messages correspondants :** 5');
		expect(text).toContain('**Messages traités :** 5');
		expect(text).not.toContain('IDs traités');
	});

	test('handles errors gracefully', async () => {
		mockBulkOperation.mockRejectedValue(new Error('Storage inaccessible'));

		const { cleanupMessages } = await import('../cleanup.js');
		const result = await cleanupMessages({
			operation: 'mark_read'
		});

		expect(result.content[0].text).toContain('Erreur lors du cleanup');
		expect(result.content[0].text).toContain('Storage inaccessible');
	});

	test('reports errors in bulk operation result', async () => {
		mockBulkOperation.mockResolvedValue({
			operation: 'mark_read',
			matched: 10,
			processed: 8,
			errors: 2,
			message_ids: ['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5', 'msg-6', 'msg-7', 'msg-8']
		});

		const { cleanupMessages } = await import('../cleanup.js');
		const result = await cleanupMessages({
			operation: 'mark_read'
		});

		const text = result.content[0].text;
		expect(text).toContain('**Messages correspondants :** 10');
		expect(text).toContain('**Messages traités :** 8');
		expect(text).toContain('**Erreurs :** 2');
	});

	test('inputSchema metadata is valid', async () => {
		const { cleanupToolMetadata } = await import('../cleanup.js');

		expect(cleanupToolMetadata.name).toBe('roosync_cleanup_messages');
		expect(cleanupToolMetadata.inputSchema.type).toBe('object');
		expect(cleanupToolMetadata.inputSchema.required).toContain('operation');

		const operationProp = cleanupToolMetadata.inputSchema.properties.operation;
		expect(operationProp.type).toBe('string');
		expect(operationProp.enum).toEqual(['mark_read', 'archive']);

		// Optional filter properties
		expect(cleanupToolMetadata.inputSchema.properties.from).toBeDefined();
		expect(cleanupToolMetadata.inputSchema.properties.priority).toBeDefined();
		expect(cleanupToolMetadata.inputSchema.properties.before_date).toBeDefined();
		expect(cleanupToolMetadata.inputSchema.properties.subject_contains).toBeDefined();
		expect(cleanupToolMetadata.inputSchema.properties.tag).toBeDefined();
		expect(cleanupToolMetadata.inputSchema.properties.status).toBeDefined();
		expect(cleanupToolMetadata.inputSchema.properties.verbose).toBeDefined();
	});
});
