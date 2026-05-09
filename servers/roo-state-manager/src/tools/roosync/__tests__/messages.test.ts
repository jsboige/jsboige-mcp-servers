/**
 * Tests for messages.ts — consolidated messaging router
 * Covers: action routing to correct sub-tool (send, read, manage, attachments)
 * Issue: coverage improvement — messages.ts at 6.66% branch coverage
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// --- Mock all 4 sub-tools ---

const { mockRoosyncSend } = vi.hoisted(() => ({
  mockRoosyncSend: vi.fn().mockResolvedValue({ success: true, action: 'send' })
}));

const { mockRoosyncRead } = vi.hoisted(() => ({
  mockRoosyncRead: vi.fn().mockResolvedValue({ success: true, action: 'read' })
}));

const { mockRoosyncManage } = vi.hoisted(() => ({
  mockRoosyncManage: vi.fn().mockResolvedValue({ success: true, action: 'manage' })
}));

const { mockRoosyncAttachments } = vi.hoisted(() => ({
  mockRoosyncAttachments: vi.fn().mockResolvedValue({ success: true, action: 'attachments' })
}));

vi.mock('../send.js', () => ({
  roosyncSend: mockRoosyncSend
}));

vi.mock('../read.js', () => ({
  roosyncRead: mockRoosyncRead
}));

vi.mock('../manage.js', () => ({
  roosyncManage: mockRoosyncManage
}));

vi.mock('../roosync-attachments.tool.js', () => ({
  roosyncAttachments: mockRoosyncAttachments
}));

import { roosyncMessages } from '../messages.js';

describe('roosyncMessages — consolidated router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRoosyncSend.mockResolvedValue({ success: true, action: 'send' });
    mockRoosyncRead.mockResolvedValue({ success: true, action: 'read' });
    mockRoosyncManage.mockResolvedValue({ success: true, action: 'manage' });
    mockRoosyncAttachments.mockResolvedValue({ success: true, action: 'attachments' });
  });

  // --- Send family ---
  describe('send family', () => {
    test('action=send routes to roosyncSend with correct args', async () => {
      const result = await roosyncMessages({
        action: 'send',
        to: 'myia-po-2023',
        subject: 'Test',
        body: 'Hello',
        priority: 'HIGH',
        tags: ['urgent'],
        thread_id: 'thread-1',
        reply_to: 'msg-123',
        auto_destruct: true,
        destruct_after_read_by: ['myia-po-2023'],
        destruct_after: '30m',
        attachments: [{ path: '/tmp/file.txt', filename: 'file.txt' }]
      });

      expect(mockRoosyncSend).toHaveBeenCalledWith({
        action: 'send',
        to: 'myia-po-2023',
        subject: 'Test',
        body: 'Hello',
        priority: 'HIGH',
        tags: ['urgent'],
        thread_id: 'thread-1',
        reply_to: 'msg-123',
        auto_destruct: true,
        destruct_after_read_by: ['myia-po-2023'],
        destruct_after: '30m',
        attachments: [{ path: '/tmp/file.txt', filename: 'file.txt' }]
      });
      expect(result.success).toBe(true);
    });

    test('action=reply routes to roosyncSend with reply action', async () => {
      await roosyncMessages({
        action: 'reply',
        message_id: 'msg-456',
        body: 'Reply body',
        priority: 'MEDIUM',
        tags: ['discussion']
      });

      expect(mockRoosyncSend).toHaveBeenCalledWith({
        action: 'reply',
        message_id: 'msg-456',
        body: 'Reply body',
        priority: 'MEDIUM',
        tags: ['discussion']
      });
    });

    test('action=amend routes to roosyncSend with amend action', async () => {
      await roosyncMessages({
        action: 'amend',
        message_id: 'msg-789',
        new_content: 'Updated content',
        reason: 'typo fix'
      });

      expect(mockRoosyncSend).toHaveBeenCalledWith({
        action: 'amend',
        message_id: 'msg-789',
        new_content: 'Updated content',
        reason: 'typo fix'
      });
    });
  });

  // --- Read family ---
  describe('read family', () => {
    test('action=inbox routes to roosyncRead with inbox mode', async () => {
      await roosyncMessages({
        action: 'inbox',
        status: 'unread',
        limit: 10,
        page: 2,
        per_page: 5,
        workspace: 'roo-extensions',
        to_machine: 'myia-ai-01',
        format: 'json'
      });

      expect(mockRoosyncRead).toHaveBeenCalledWith({
        mode: 'inbox',
        status: 'unread',
        limit: 10,
        page: 2,
        per_page: 5,
        workspace: 'roo-extensions',
        to_machine: 'myia-ai-01',
        format: 'json'
      });
    });

    test('action=message routes to roosyncRead with message mode', async () => {
      await roosyncMessages({
        action: 'message',
        message_id: 'msg-999',
        mark_as_read: true
      });

      expect(mockRoosyncRead).toHaveBeenCalledWith({
        mode: 'message',
        message_id: 'msg-999',
        mark_as_read: true
      });
    });
  });

  // --- Manage family ---
  describe('manage family', () => {
    test('action=mark_read routes to roosyncManage', async () => {
      await roosyncMessages({
        action: 'mark_read',
        message_id: 'msg-100'
      });

      expect(mockRoosyncManage).toHaveBeenCalledWith({
        action: 'mark_read',
        message_id: 'msg-100'
      });
    });

    test('action=archive routes to roosyncManage', async () => {
      await roosyncMessages({
        action: 'archive',
        message_id: 'msg-200'
      });

      expect(mockRoosyncManage).toHaveBeenCalledWith({
        action: 'archive',
        message_id: 'msg-200'
      });
    });

    test('action=bulk_mark_read routes with all filters', async () => {
      await roosyncMessages({
        action: 'bulk_mark_read',
        from: 'myia-ai-01',
        priority: 'HIGH',
        before_date: '2026-01-01',
        subject_contains: 'urgent',
        tag: 'alert'
      });

      expect(mockRoosyncManage).toHaveBeenCalledWith({
        action: 'bulk_mark_read',
        from: 'myia-ai-01',
        priority: 'HIGH',
        before_date: '2026-01-01',
        subject_contains: 'urgent',
        tag: 'alert'
      });
    });

    test('action=bulk_archive routes to roosyncManage', async () => {
      await roosyncMessages({
        action: 'bulk_archive',
        from: 'myia-po-2024',
        tag: 'old'
      });

      expect(mockRoosyncManage).toHaveBeenCalledWith({
        action: 'bulk_archive',
        from: 'myia-po-2024',
        priority: undefined,
        before_date: undefined,
        subject_contains: undefined,
        tag: 'old'
      });
    });

    test('action=cleanup routes to roosyncManage', async () => {
      await roosyncMessages({ action: 'cleanup' });

      expect(mockRoosyncManage).toHaveBeenCalledWith({ action: 'cleanup' });
    });

    test('action=stats routes to roosyncManage with format', async () => {
      await roosyncMessages({ action: 'stats', format: 'markdown' });

      expect(mockRoosyncManage).toHaveBeenCalledWith({
        action: 'stats',
        format: 'markdown'
      });
    });
  });

  // --- Attachments family ---
  describe('attachments family', () => {
    test('action=attachments_list routes to roosyncAttachments', async () => {
      await roosyncMessages({
        action: 'attachments_list',
        message_id: 'msg-300'
      });

      expect(mockRoosyncAttachments).toHaveBeenCalledWith({
        action: 'list',
        message_id: 'msg-300'
      });
    });

    test('action=attachments_get routes with uuid and targetPath', async () => {
      await roosyncMessages({
        action: 'attachments_get',
        uuid: 'att-uuid-123',
        targetPath: '/tmp/download'
      });

      expect(mockRoosyncAttachments).toHaveBeenCalledWith({
        action: 'get',
        uuid: 'att-uuid-123',
        targetPath: '/tmp/download'
      });
    });

    test('action=attachments_delete routes with uuid', async () => {
      await roosyncMessages({
        action: 'attachments_delete',
        uuid: 'att-uuid-456'
      });

      expect(mockRoosyncAttachments).toHaveBeenCalledWith({
        action: 'delete',
        uuid: 'att-uuid-456'
      });
    });
  });

  // --- Minimal args ---
  describe('edge cases', () => {
    test('action=send with minimal args passes undefined optionals', async () => {
      await roosyncMessages({
        action: 'send',
        to: 'myia-ai-01'
      });

      expect(mockRoosyncSend).toHaveBeenCalledWith({
        action: 'send',
        to: 'myia-ai-01',
        subject: undefined,
        body: undefined,
        priority: undefined,
        tags: undefined,
        thread_id: undefined,
        reply_to: undefined,
        auto_destruct: undefined,
        destruct_after_read_by: undefined,
        destruct_after: undefined,
        attachments: undefined
      });
    });

    test('action=inbox with no optionals uses defaults', async () => {
      await roosyncMessages({ action: 'inbox' });

      expect(mockRoosyncRead).toHaveBeenCalledWith({
        mode: 'inbox',
        status: undefined,
        limit: undefined,
        page: undefined,
        per_page: undefined,
        workspace: undefined,
        to_machine: undefined,
        format: undefined
      });
    });
  });
});
