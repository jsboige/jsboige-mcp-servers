import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  roosyncListAttachments,
  roosyncGetAttachment,
  roosyncDeleteAttachment,
  roosyncAttachments,
} from '../../../../src/tools/roosync/roosync-attachments.tool.js';
import { AttachmentManager } from '../../../../src/services/roosync/AttachmentManager.js';
import type { AttachmentMetadata } from '../../../../src/services/roosync/AttachmentManager.js';

vi.mock('../../../../src/services/roosync/AttachmentManager.js');
vi.mock('../../../../src/utils/shared-state-path.js', () => ({
  getSharedStatePath: () => '/mock/shared-state',
}));

const mockListAttachments = vi.fn();
const mockGetAttachment = vi.fn();
const mockGetAttachmentMetadata = vi.fn();
const mockDeleteAttachment = vi.fn();

const mockAttachment: AttachmentMetadata = {
  uuid: 'att-001',
  originalName: 'report.md',
  mimeType: 'text/markdown',
  sizeBytes: 2048,
  uploadedAt: '2026-04-22T10:00:00.000Z',
  uploaderMachineId: 'myia-po-2023',
  messageId: 'msg-001',
};

const mockAttachment2: AttachmentMetadata = {
  uuid: 'att-002',
  originalName: 'data.json',
  mimeType: 'application/json',
  sizeBytes: 512,
  uploadedAt: '2026-04-21T08:00:00.000Z',
  uploaderMachineId: 'myia-ai-01',
};

describe('roosync-attachments.tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(AttachmentManager).mockImplementation(() => ({
      listAttachments: mockListAttachments,
      getAttachment: mockGetAttachment,
      getAttachmentMetadata: mockGetAttachmentMetadata,
      deleteAttachment: mockDeleteAttachment,
    } as any));
  });

  // ── formatSize (via output assertions) ──────────────────────

  describe('formatSize (via output)', () => {
    it('formats bytes correctly', async () => {
      mockListAttachments.mockResolvedValue([{ ...mockAttachment, sizeBytes: 500 }]);
      const result = await roosyncListAttachments({});
      expect(result.content[0].text).toContain('500 B');
    });

    it('formats kilobytes correctly', async () => {
      mockListAttachments.mockResolvedValue([{ ...mockAttachment, sizeBytes: 2048 }]);
      const result = await roosyncListAttachments({});
      expect(result.content[0].text).toContain('2.0 KB');
    });

    it('formats megabytes correctly', async () => {
      mockListAttachments.mockResolvedValue([{ ...mockAttachment, sizeBytes: 5 * 1024 * 1024 }]);
      const result = await roosyncListAttachments({});
      expect(result.content[0].text).toContain('5.0 MB');
    });
  });

  // ── roosyncListAttachments ──────────────────────────────────

  describe('roosyncListAttachments', () => {
    it('returns empty message when no attachments', async () => {
      mockListAttachments.mockResolvedValue([]);
      const result = await roosyncListAttachments({});
      expect(result.content[0].text).toContain('Aucune pièce jointe');
      expect(result.content[0].text).toContain('stockage partagé');
    });

    it('scopes empty message to specific message_id', async () => {
      mockListAttachments.mockResolvedValue([]);
      const result = await roosyncListAttachments({ message_id: 'msg-001' });
      expect(result.content[0].text).toContain('msg-001');
    });

    it('lists attachments in table format', async () => {
      mockListAttachments.mockResolvedValue([mockAttachment, mockAttachment2]);
      const result = await roosyncListAttachments({});
      const text = result.content[0].text;
      expect(text).toContain('att-001');
      expect(text).toContain('report.md');
      expect(text).toContain('att-002');
      expect(text).toContain('data.json');
      expect(text).toContain('Total :** 2');
    });

    it('shows message_id when scoped', async () => {
      mockListAttachments.mockResolvedValue([mockAttachment]);
      const result = await roosyncListAttachments({ message_id: 'msg-001' });
      expect(result.content[0].text).toContain('Message `msg-001`');
    });

    it('handles AttachmentManager error gracefully', async () => {
      mockListAttachments.mockRejectedValue(new Error('disk error'));
      const result = await roosyncListAttachments({});
      expect(result.content[0].text).toContain('Erreur');
      expect(result.content[0].text).toContain('disk error');
    });
  });

  // ── roosyncGetAttachment ────────────────────────────────────

  describe('roosyncGetAttachment', () => {
    it('requires uuid parameter', async () => {
      const result = await roosyncGetAttachment({ uuid: '', targetPath: '/tmp/out.md' });
      expect(result.content[0].text).toContain('uuid` requis');
    });

    it('requires targetPath parameter', async () => {
      const result = await roosyncGetAttachment({ uuid: 'att-001', targetPath: '' });
      expect(result.content[0].text).toContain('targetPath` requis');
    });

    it('returns metadata on successful get', async () => {
      mockGetAttachment.mockResolvedValue(mockAttachment);
      const result = await roosyncGetAttachment({ uuid: 'att-001', targetPath: '/tmp/out.md' });
      const text = result.content[0].text;
      expect(text).toContain('Pièce jointe récupérée');
      expect(text).toContain('att-001');
      expect(text).toContain('report.md');
      expect(text).toContain('/tmp/out.md');
    });

    it('handles error with helpful suggestions', async () => {
      mockGetAttachment.mockRejectedValue(new Error('not found'));
      const result = await roosyncGetAttachment({ uuid: 'att-999', targetPath: '/tmp/out.md' });
      expect(result.content[0].text).toContain('Erreur');
      expect(result.content[0].text).toContain('att-999');
    });
  });

  // ── roosyncDeleteAttachment ─────────────────────────────────

  describe('roosyncDeleteAttachment', () => {
    it('requires uuid parameter', async () => {
      const result = await roosyncDeleteAttachment({ uuid: '' });
      expect(result.content[0].text).toContain('uuid` requis');
    });

    it('returns not found when metadata is null', async () => {
      mockGetAttachmentMetadata.mockResolvedValue(null);
      const result = await roosyncDeleteAttachment({ uuid: 'att-999' });
      expect(result.content[0].text).toContain('introuvable');
    });

    it('deletes and returns confirmation', async () => {
      mockGetAttachmentMetadata.mockResolvedValue(mockAttachment);
      mockDeleteAttachment.mockResolvedValue(undefined);
      const result = await roosyncDeleteAttachment({ uuid: 'att-001' });
      const text = result.content[0].text;
      expect(text).toContain('supprimée');
      expect(text).toContain('report.md');
      expect(text).toContain('irréversible');
    });

    it('handles delete error', async () => {
      mockGetAttachmentMetadata.mockRejectedValue(new Error('permission denied'));
      const result = await roosyncDeleteAttachment({ uuid: 'att-001' });
      expect(result.content[0].text).toContain('Erreur');
    });
  });

  // ── roosyncAttachments (consolidated) ───────────────────────

  describe('roosyncAttachments (consolidated)', () => {
    it('delegates to list action', async () => {
      mockListAttachments.mockResolvedValue([mockAttachment]);
      const result = await roosyncAttachments({ action: 'list' });
      expect(result.content[0].text).toContain('att-001');
    });

    it('delegates to get action with validation', async () => {
      const result = await roosyncAttachments({ action: 'get' });
      expect(result.content[0].text).toContain('uuid` requis');
    });

    it('get action requires targetPath', async () => {
      const result = await roosyncAttachments({ action: 'get', uuid: 'att-001' });
      expect(result.content[0].text).toContain('targetPath` requis');
    });

    it('delegates to delete action with validation', async () => {
      const result = await roosyncAttachments({ action: 'delete' });
      expect(result.content[0].text).toContain('uuid` requis');
    });

    it('returns error for unknown action', async () => {
      const result = await roosyncAttachments({ action: 'rename' } as any);
      expect(result.content[0].text).toContain('Action inconnue');
      expect(result.content[0].text).toContain('rename');
    });
  });
});
