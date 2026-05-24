/**
 * Tests for messages.ts — consolidated roosync_messages router
 * Covers the switch dispatch to roosyncSend, roosyncRead, roosyncManage, roosyncAttachments
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock the 4 sub-tools
const { mockSend, mockRead, mockManage, mockAttachments } = vi.hoisted(() => ({
	mockSend: vi.fn(),
	mockRead: vi.fn(),
	mockManage: vi.fn(),
	mockAttachments: vi.fn(),
}));

vi.mock('../send.js', () => ({
	roosyncSend: (...args: any[]) => mockSend(...args),
}));

vi.mock('../read.js', () => ({
	roosyncRead: (...args: any[]) => mockRead(...args),
}));

vi.mock('../manage.js', () => ({
	roosyncManage: (...args: any[]) => mockManage(...args),
}));

vi.mock('../roosync-attachments.tool.js', () => ({
	roosyncAttachments: (...args: any[]) => mockAttachments(...args),
}));

import { roosyncMessages } from '../messages.js';

describe('roosyncMessages — consolidated router', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSend.mockResolvedValue('send-ok');
		mockRead.mockResolvedValue('read-ok');
		mockManage.mockResolvedValue('manage-ok');
		mockAttachments.mockResolvedValue('attachments-ok');
	});

	// --- Send family ---

	test('action=send delegates to roosyncSend with all params', async () => {
		const result = await roosyncMessages({
			action: 'send',
			to: 'myia-ai-01',
			subject: 'Test subject',
			body: 'Hello',
			priority: 'HIGH',
			tags: ['urgent'],
			thread_id: 'thread-1',
			reply_to: 'msg-123',
			auto_destruct: true,
			destruct_after_read_by: ['myia-po-2023'],
			destruct_after: '2h',
			attachments: [{ path: '/tmp/file.txt', filename: 'file.txt' }],
		});

		expect(result).toBe('send-ok');
		expect(mockSend).toHaveBeenCalledWith({
			action: 'send',
			to: 'myia-ai-01',
			subject: 'Test subject',
			body: 'Hello',
			priority: 'HIGH',
			tags: ['urgent'],
			thread_id: 'thread-1',
			reply_to: 'msg-123',
			auto_destruct: true,
			destruct_after_read_by: ['myia-po-2023'],
			destruct_after: '2h',
			attachments: [{ path: '/tmp/file.txt', filename: 'file.txt' }],
		});
	});

	test('action=reply delegates to roosyncSend with reply params', async () => {
		const result = await roosyncMessages({
			action: 'reply',
			message_id: 'msg-456',
			body: 'Reply body',
			priority: 'LOW',
			tags: ['info'],
		});

		expect(result).toBe('send-ok');
		expect(mockSend).toHaveBeenCalledWith({
			action: 'reply',
			message_id: 'msg-456',
			body: 'Reply body',
			priority: 'LOW',
			tags: ['info'],
		});
	});

	test('action=amend delegates to roosyncSend with amend params', async () => {
		const result = await roosyncMessages({
			action: 'amend',
			message_id: 'msg-789',
			new_content: 'Updated content',
			reason: 'Typo fix',
		});

		expect(result).toBe('send-ok');
		expect(mockSend).toHaveBeenCalledWith({
			action: 'amend',
			message_id: 'msg-789',
			new_content: 'Updated content',
			reason: 'Typo fix',
		});
	});

	// --- Read family ---

	test('action=inbox delegates to roosyncRead with inbox params', async () => {
		const result = await roosyncMessages({
			action: 'inbox',
			status: 'unread',
			limit: 10,
			page: 2,
			per_page: 5,
			workspace: 'roo-extensions',
			to_machine: 'myia-po-2023',
			format: 'json',
		});

		expect(result).toBe('read-ok');
		expect(mockRead).toHaveBeenCalledWith({
			mode: 'inbox',
			status: 'unread',
			limit: 10,
			page: 2,
			per_page: 5,
			workspace: 'roo-extensions',
			to_machine: 'myia-po-2023',
			format: 'json',
		});
	});

	test('action=message delegates to roosyncRead with message params', async () => {
		const result = await roosyncMessages({
			action: 'message',
			message_id: 'msg-001',
			mark_as_read: true,
		});

		expect(result).toBe('read-ok');
		expect(mockRead).toHaveBeenCalledWith({
			mode: 'message',
			message_id: 'msg-001',
			mark_as_read: true,
		});
	});

	// --- Manage family ---

	test('action=mark_read delegates to roosyncManage', async () => {
		const result = await roosyncMessages({
			action: 'mark_read',
			message_id: 'msg-002',
		});

		expect(result).toBe('manage-ok');
		expect(mockManage).toHaveBeenCalledWith({
			action: 'mark_read',
			message_id: 'msg-002',
		});
	});

	test('action=archive delegates to roosyncManage', async () => {
		const result = await roosyncMessages({
			action: 'archive',
			message_id: 'msg-003',
		});

		expect(result).toBe('manage-ok');
		expect(mockManage).toHaveBeenCalledWith({
			action: 'archive',
			message_id: 'msg-003',
		});
	});

	test('action=bulk_mark_read delegates to roosyncManage with filters', async () => {
		const result = await roosyncMessages({
			action: 'bulk_mark_read',
			from: 'myia-ai-01',
			priority: 'HIGH',
			before_date: '2026-01-01',
			subject_contains: 'deploy',
			tag: 'alert',
		});

		expect(result).toBe('manage-ok');
		expect(mockManage).toHaveBeenCalledWith({
			action: 'bulk_mark_read',
			from: 'myia-ai-01',
			priority: 'HIGH',
			before_date: '2026-01-01',
			subject_contains: 'deploy',
			tag: 'alert',
		});
	});

	test('action=bulk_archive delegates to roosyncManage with filters', async () => {
		const result = await roosyncMessages({
			action: 'bulk_archive',
			from: 'myia-po-2024',
			tag: 'old',
		});

		expect(result).toBe('manage-ok');
		expect(mockManage).toHaveBeenCalledWith({
			action: 'bulk_archive',
			from: 'myia-po-2024',
			priority: undefined,
			before_date: undefined,
			subject_contains: undefined,
			tag: 'old',
		});
	});

	test('action=cleanup delegates to roosyncManage', async () => {
		const result = await roosyncMessages({ action: 'cleanup' });

		expect(result).toBe('manage-ok');
		expect(mockManage).toHaveBeenCalledWith({ action: 'cleanup' });
	});

	test('action=stats delegates to roosyncManage with format', async () => {
		const result = await roosyncMessages({
			action: 'stats',
			format: 'json',
		});

		expect(result).toBe('manage-ok');
		expect(mockManage).toHaveBeenCalledWith({
			action: 'stats',
			format: 'json',
		});
	});

	// --- Attachments family ---

	test('action=attachments_list delegates to roosyncAttachments', async () => {
		const result = await roosyncMessages({
			action: 'attachments_list',
			message_id: 'msg-att',
		});

		expect(result).toBe('attachments-ok');
		expect(mockAttachments).toHaveBeenCalledWith({
			action: 'list',
			message_id: 'msg-att',
		});
	});

	test('action=attachments_get delegates to roosyncAttachments', async () => {
		const result = await roosyncMessages({
			action: 'attachments_get',
			uuid: 'uuid-abc-123',
			targetPath: '/tmp/download',
		});

		expect(result).toBe('attachments-ok');
		expect(mockAttachments).toHaveBeenCalledWith({
			action: 'get',
			uuid: 'uuid-abc-123',
			targetPath: '/tmp/download',
		});
	});

	test('action=attachments_delete delegates to roosyncAttachments', async () => {
		const result = await roosyncMessages({
			action: 'attachments_delete',
			uuid: 'uuid-del-456',
		});

		expect(result).toBe('attachments-ok');
		expect(mockAttachments).toHaveBeenCalledWith({
			action: 'delete',
			uuid: 'uuid-del-456',
		});
	});
});
