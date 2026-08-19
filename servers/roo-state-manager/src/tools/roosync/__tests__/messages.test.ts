/**
 * Tests for roosync_messages dispatcher (#2307 Phase 5).
 *
 * Covers:
 * - Schema validation (14 actions, all params)
 * - Shorthand resolution (hermes, nanoclaw)
 * - Routing: action → correct sub-tool call
 * - Exhaustive switch (never guard)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { MessagesArgsSchema, roosyncMessages } from '../messages.js';

// Mock sub-tools to verify routing without side effects
vi.mock('../send.js', () => ({
  roosyncSend: vi.fn().mockResolvedValue('SEND_RESULT'),
}));
vi.mock('../read.js', () => ({
  roosyncRead: vi.fn().mockResolvedValue('READ_RESULT'),
}));
vi.mock('../manage.js', () => ({
  roosyncManage: vi.fn().mockResolvedValue('MANAGE_RESULT'),
}));
vi.mock('../roosync-attachments.tool.js', () => ({
  roosyncAttachments: vi.fn().mockResolvedValue('ATTACHMENTS_RESULT'),
}));

import { roosyncSend } from '../send.js';
import { roosyncRead } from '../read.js';
import { roosyncManage } from '../manage.js';
import { roosyncAttachments } from '../roosync-attachments.tool.js';

const mockSend = vi.mocked(roosyncSend);
const mockRead = vi.mocked(roosyncRead);
const mockManage = vi.mocked(roosyncManage);
const mockAttachments = vi.mocked(roosyncAttachments);

describe('roosync_messages dispatcher', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================
  // Schema validation
  // ============================================================

  describe('MessagesArgsSchema', () => {
    test('should accept all 14 actions', () => {
      const actions = [
        'send', 'reply', 'amend',
        'inbox', 'message',
        'mark_read', 'archive', 'bulk_mark_read', 'bulk_archive', 'cleanup', 'stats',
        'attachments_list', 'attachments_get', 'attachments_delete'
      ];
      for (const action of actions) {
        const result = MessagesArgsSchema.safeParse({ action });
        expect(result.success, `action "${action}" should be valid`).toBe(true);
      }
    });

    test('should reject unknown action', () => {
      const result = MessagesArgsSchema.safeParse({ action: 'unknown_action' });
      expect(result.success).toBe(false);
    });

    test('should require action field', () => {
      const result = MessagesArgsSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    test('should validate send params', () => {
      const result = MessagesArgsSchema.safeParse({
        action: 'send',
        to: 'myia-po-2023',
        subject: 'Test',
        body: 'Hello',
        priority: 'HIGH',
        tags: ['test'],
        auto_destruct: true,
        destruct_after: '2h'
      });
      expect(result.success).toBe(true);
    });

    test('should validate inbox params', () => {
      const result = MessagesArgsSchema.safeParse({
        action: 'inbox',
        status: 'unread',
        limit: 10,
        page: 1,
        per_page: 5,
        format: 'json'
      });
      expect(result.success).toBe(true);
    });

    test('should validate bulk params', () => {
      const result = MessagesArgsSchema.safeParse({
        action: 'bulk_mark_read',
        from: 'myia-ai-01',
        tag: 'INFO'
      });
      expect(result.success).toBe(true);
    });

    test('should strip unknown params', () => {
      const result = MessagesArgsSchema.safeParse({
        action: 'inbox',
        unknownParam: 'value'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toHaveProperty('unknownParam');
      }
    });

    test('#3029 AC-4: handler consumes MessagesArgsSchema at runtime (validation layer)', async () => {
      // The handler now parses args via MessagesArgsSchema at runtime, making the schema
      // an active validation layer — not just a z.infer type source. Invalid input is
      // rejected by the handler itself before routing. (Valid input passing through is
      // already covered by the 30+ routing tests below.)
      await expect(roosyncMessages({ action: 'invalid_action' } as any)).rejects.toThrow();
    });
  });

  // ============================================================
  // Routing: action → correct sub-tool
  // ============================================================

  describe('routing', () => {
    test('send routes to roosyncSend', async () => {
      await roosyncMessages({ action: 'send', to: 'm1', subject: 'S', body: 'B' });
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'send', to: 'm1', subject: 'S', body: 'B' })
      );
    });

    test('reply routes to roosyncSend with action=reply', async () => {
      await roosyncMessages({ action: 'reply', message_id: 'msg-1', body: 'Reply body' });
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'reply', message_id: 'msg-1', body: 'Reply body' })
      );
    });

    test('amend routes to roosyncSend with action=amend', async () => {
      await roosyncMessages({ action: 'amend', message_id: 'msg-1', new_content: 'Updated' });
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'amend', message_id: 'msg-1', new_content: 'Updated' })
      );
    });

    // #3029: Alias retro-compat reply_to → message_id pour reply/amend.
    // Sans ce fix, l'agent qui passait reply_to pour action="reply" recevait
    // "Paramètre message_id requis" et devait retenter. L'alias évite ce coût.
    test('#3029 reply accepts reply_to as alias for message_id', async () => {
      await roosyncMessages({ action: 'reply', reply_to: 'msg-42', body: 'OK' });
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'reply', message_id: 'msg-42', body: 'OK' })
      );
    });

    test('#3029 amend accepts reply_to as alias for message_id', async () => {
      await roosyncMessages({ action: 'amend', reply_to: 'msg-42', new_content: 'Updated' });
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'amend', message_id: 'msg-42', new_content: 'Updated' })
      );
    });

    test('#3029 message_id wins when both message_id and reply_to provided', async () => {
      await roosyncMessages({ action: 'reply', message_id: 'msg-EXPLICIT', reply_to: 'msg-ALIAS', body: 'OK' });
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'reply', message_id: 'msg-EXPLICIT', body: 'OK' })
      );
      // reply_to ne doit PAS fuiter vers send (qui l'attend pour action='send')
      const callArg = mockSend.mock.calls[0][0];
      expect(callArg).not.toHaveProperty('reply_to');
    });

    test('inbox routes to roosyncRead with mode=inbox', async () => {
      await roosyncMessages({ action: 'inbox' });
      expect(mockRead).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'inbox' })
      );
    });

    test('inbox passes pagination params', async () => {
      await roosyncMessages({ action: 'inbox', page: 2, per_page: 10 });
      expect(mockRead).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'inbox', page: 2, per_page: 10 })
      );
    });

    test('message routes to roosyncRead with mode=message', async () => {
      await roosyncMessages({ action: 'message', message_id: 'msg-1' });
      expect(mockRead).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'message', message_id: 'msg-1' })
      );
    });

    test('mark_read routes to roosyncManage', async () => {
      await roosyncMessages({ action: 'mark_read', message_id: 'msg-1' });
      expect(mockManage).toHaveBeenCalledWith({ action: 'mark_read', message_id: 'msg-1' });
    });

    test('archive routes to roosyncManage', async () => {
      await roosyncMessages({ action: 'archive', message_id: 'msg-1' });
      expect(mockManage).toHaveBeenCalledWith({ action: 'archive', message_id: 'msg-1' });
    });

    test('bulk_mark_read routes to roosyncManage with filters', async () => {
      await roosyncMessages({ action: 'bulk_mark_read', from: 'ai-01', tag: 'URGENT' });
      expect(mockManage).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'bulk_mark_read', from: 'ai-01', tag: 'URGENT' })
      );
    });

    test('bulk_archive routes to roosyncManage', async () => {
      await roosyncMessages({ action: 'bulk_archive', before_date: '2026-01-01' });
      expect(mockManage).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'bulk_archive', before_date: '2026-01-01' })
      );
    });

    test('cleanup routes to roosyncManage', async () => {
      await roosyncMessages({ action: 'cleanup' });
      expect(mockManage).toHaveBeenCalledWith({ action: 'cleanup' });
    });

    test('stats routes to roosyncManage', async () => {
      await roosyncMessages({ action: 'stats', format: 'json' });
      expect(mockManage).toHaveBeenCalledWith({ action: 'stats', format: 'json' });
    });

    test('attachments_list routes to roosyncAttachments', async () => {
      await roosyncMessages({ action: 'attachments_list', message_id: 'msg-1' });
      expect(mockAttachments).toHaveBeenCalledWith({ action: 'list', message_id: 'msg-1' });
    });

    test('attachments_get routes to roosyncAttachments', async () => {
      await roosyncMessages({ action: 'attachments_get', uuid: 'abc-123', targetPath: '/tmp/f' });
      expect(mockAttachments).toHaveBeenCalledWith({ action: 'get', uuid: 'abc-123', targetPath: '/tmp/f' });
    });

    test('attachments_delete routes to roosyncAttachments', async () => {
      await roosyncMessages({ action: 'attachments_delete', uuid: 'abc-123' });
      expect(mockAttachments).toHaveBeenCalledWith({ action: 'delete', uuid: 'abc-123' });
    });
  });

  // ============================================================
  // Shorthand resolution (#2241)
  // ============================================================

  describe('shorthand resolution', () => {
    test('"hermes" resolves to myia-po-2026:hermes-agent', async () => {
      await roosyncMessages({ action: 'send', to: 'hermes', subject: 'S', body: 'B' });
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'myia-po-2026:hermes-agent' })
      );
    });

    test('"HERMES" (uppercase) resolves correctly', async () => {
      await roosyncMessages({ action: 'send', to: 'HERMES', subject: 'S', body: 'B' });
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'myia-po-2026:hermes-agent' })
      );
    });

    test('"nanoclaw" resolves to myia-ai-01:nanoclaw', async () => {
      await roosyncMessages({ action: 'send', to: 'nanoclaw', subject: 'S', body: 'B' });
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'myia-ai-01:nanoclaw' })
      );
    });

    test('full machine ID passes through unchanged', async () => {
      await roosyncMessages({ action: 'send', to: 'myia-po-2025', subject: 'S', body: 'B' });
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'myia-po-2025' })
      );
    });

    test('machine:workspace passes through unchanged', async () => {
      await roosyncMessages({ action: 'send', to: 'myia-po-2025:Embeddings', subject: 'S', body: 'B' });
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'myia-po-2025:Embeddings' })
      );
    });
  });

  // ============================================================
  // Return value forwarding
  // ============================================================

  describe('return values', () => {
    test('forwards sub-tool return value unchanged', async () => {
      mockSend.mockResolvedValueOnce('CUSTOM_SEND_RESULT');
      const result = await roosyncMessages({ action: 'send', to: 'm1', subject: 'S', body: 'B' });
      expect(result).toBe('CUSTOM_SEND_RESULT');
    });

    test('forwards read result unchanged', async () => {
      mockRead.mockResolvedValueOnce('CUSTOM_READ_RESULT');
      const result = await roosyncMessages({ action: 'inbox' });
      expect(result).toBe('CUSTOM_READ_RESULT');
    });

    test('forwards manage result unchanged', async () => {
      mockManage.mockResolvedValueOnce('CUSTOM_MANAGE_RESULT');
      const result = await roosyncMessages({ action: 'mark_read', message_id: 'msg-1' });
      expect(result).toBe('CUSTOM_MANAGE_RESULT');
    });
  });

  // ============================================================
  // #3177 — unknown params must fail loudly, not resolve to server identity
  // ============================================================
  describe('unknown param guard (#3177)', () => {
    test('inbox with machineId throws naming the real param to_machine', async () => {
      await expect(
        roosyncMessages({ action: 'inbox', machineId: 'myia-po-2026' } as any)
      ).rejects.toThrow(/machineId.*to_machine/);
      expect(mockRead).not.toHaveBeenCalled();
    });

    test('inbox with machine_id (snake) also throws with to_machine hint', async () => {
      await expect(
        roosyncMessages({ action: 'inbox', machine_id: 'myia-po-2026' } as any)
      ).rejects.toThrow(/to_machine/);
    });

    test('any other unknown param throws ZodError (strict schema)', async () => {
      await expect(
        roosyncMessages({ action: 'inbox', machineFilter: 'x' } as any)
      ).rejects.toThrow();
      expect(mockRead).not.toHaveBeenCalled();
    });

    test('valid inbox call still routes (no false positive)', async () => {
      await roosyncMessages({ action: 'inbox', to_machine: 'myia-po-2023', workspace: 'roo-extensions' });
      expect(mockRead).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'inbox', to_machine: 'myia-po-2023', workspace: 'roo-extensions'
      }));
    });
  });
});
