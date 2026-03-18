/**
 * Tests pour les outils MCP de pièces jointes RooSync (#674)
 * - roosync_list_attachments
 * - roosync_get_attachment
 * - roosync_delete_attachment
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockListAttachments, mockGetAttachment, mockGetAttachmentMetadata, mockDeleteAttachment } = vi.hoisted(() => ({
  mockListAttachments: vi.fn(),
  mockGetAttachment: vi.fn(),
  mockGetAttachmentMetadata: vi.fn(),
  mockDeleteAttachment: vi.fn(),
}));

vi.mock('../../../services/roosync/AttachmentManager.js', () => ({
  AttachmentManager: class {
    constructor() {}
    listAttachments(...args: any[]) { return mockListAttachments(...args); }
    getAttachment(...args: any[]) { return mockGetAttachment(...args); }
    getAttachmentMetadata(...args: any[]) { return mockGetAttachmentMetadata(...args); }
    deleteAttachment(...args: any[]) { return mockDeleteAttachment(...args); }
  }
}));

vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: vi.fn().mockReturnValue('/mock/shared')
}));

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  Logger: class {}
}));

import {
  roosyncListAttachments,
  listAttachmentsToolMetadata,
  roosyncGetAttachment,
  getAttachmentToolMetadata,
  roosyncDeleteAttachment,
  deleteAttachmentToolMetadata,
  roosyncAttachments,
  attachmentsToolMetadata
} from '../roosync-attachments.tool.js';

// ============================================================
describe('roosync_list_attachments', () => {
  beforeEach(() => vi.clearAllMocks());

  test('exports listAttachmentsToolMetadata with correct name', () => {
    expect(listAttachmentsToolMetadata.name).toBe('roosync_list_attachments');
  });

  test('returns empty message when no attachments', async () => {
    mockListAttachments.mockResolvedValue([]);
    const result = await roosyncListAttachments({});
    expect(result.content[0].text).toContain('Aucune pièce jointe');
  });

  test('lists attachments in table format', async () => {
    mockListAttachments.mockResolvedValue([
      {
        uuid: 'uuid-001',
        originalName: 'report.txt',
        sizeBytes: 1024,
        mimeType: 'text/plain',
        uploadedAt: '2026-03-13T10:00:00Z',
        uploaderMachineId: 'myia-po-2025',
        messageId: 'msg-001'
      }
    ]);
    const result = await roosyncListAttachments({ message_id: 'msg-001' });
    const text = result.content[0].text;
    expect(text).toContain('uuid-001');
    expect(text).toContain('report.txt');
    expect(text).toContain('Total');
    expect(text).toContain('1');
  });

  test('filters by messageId when provided', async () => {
    mockListAttachments.mockResolvedValue([]);
    await roosyncListAttachments({ message_id: 'msg-xyz' });
    expect(mockListAttachments).toHaveBeenCalledWith('msg-xyz');
  });

  test('lists all attachments when no messageId provided', async () => {
    mockListAttachments.mockResolvedValue([]);
    await roosyncListAttachments({});
    expect(mockListAttachments).toHaveBeenCalledWith(undefined);
  });

  test('handles errors gracefully', async () => {
    mockListAttachments.mockRejectedValue(new Error('storage error'));
    const result = await roosyncListAttachments({});
    expect(result.content[0].text).toContain('Erreur');
    expect(result.content[0].text).toContain('storage error');
  });
});

// ============================================================
describe('roosync_get_attachment', () => {
  beforeEach(() => vi.clearAllMocks());

  test('exports getAttachmentToolMetadata with required params', () => {
    expect(getAttachmentToolMetadata.name).toBe('roosync_get_attachment');
    expect(getAttachmentToolMetadata.inputSchema.required).toContain('uuid');
    expect(getAttachmentToolMetadata.inputSchema.required).toContain('targetPath');
  });

  test('returns error when uuid is missing', async () => {
    const result = await roosyncGetAttachment({ uuid: '', targetPath: '/tmp/out.txt' });
    expect(result.content[0].text).toContain('uuid');
  });

  test('returns error when targetPath is missing', async () => {
    const result = await roosyncGetAttachment({ uuid: 'some-uuid', targetPath: '' });
    expect(result.content[0].text).toContain('targetPath');
  });

  test('returns success with metadata on valid download', async () => {
    const mockMeta = {
      uuid: 'uuid-abc',
      originalName: 'data.json',
      sizeBytes: 512,
      mimeType: 'application/json',
      uploadedAt: '2026-03-13T09:00:00Z',
      uploaderMachineId: 'myia-po-2025',
      messageId: 'msg-xyz'
    };
    mockGetAttachment.mockResolvedValue(mockMeta);

    const result = await roosyncGetAttachment({ uuid: 'uuid-abc', targetPath: '/tmp/data.json' });
    const text = result.content[0].text;
    expect(text).toContain('✅');
    expect(text).toContain('uuid-abc');
    expect(text).toContain('/tmp/data.json');
  });

  test('handles download error gracefully', async () => {
    mockGetAttachment.mockRejectedValue(new Error('disk full'));
    const result = await roosyncGetAttachment({ uuid: 'uuid-abc', targetPath: '/tmp/out.txt' });
    expect(result.content[0].text).toContain('Erreur');
    expect(result.content[0].text).toContain('disk full');
  });
});

// ============================================================
describe('roosync_delete_attachment', () => {
  beforeEach(() => vi.clearAllMocks());

  test('exports deleteAttachmentToolMetadata with required params', () => {
    expect(deleteAttachmentToolMetadata.name).toBe('roosync_delete_attachment');
    expect(deleteAttachmentToolMetadata.inputSchema.required).toContain('uuid');
  });

  test('returns error when uuid is missing', async () => {
    const result = await roosyncDeleteAttachment({ uuid: '' });
    expect(result.content[0].text).toContain('uuid');
  });

  test('returns not found when attachment does not exist', async () => {
    mockGetAttachmentMetadata.mockResolvedValue(null);
    const result = await roosyncDeleteAttachment({ uuid: 'ghost-uuid' });
    expect(result.content[0].text).toContain('introuvable');
  });

  test('returns success after deletion', async () => {
    const mockMeta = {
      uuid: 'uuid-del',
      originalName: 'bye.txt',
      sizeBytes: 256,
      mimeType: 'text/plain',
      uploadedAt: '2026-03-13T08:00:00Z',
      uploaderMachineId: 'myia-po-2025',
      messageId: 'msg-del'
    };
    mockGetAttachmentMetadata.mockResolvedValue(mockMeta);
    mockDeleteAttachment.mockResolvedValue(undefined);

    const result = await roosyncDeleteAttachment({ uuid: 'uuid-del' });
    const text = result.content[0].text;
    expect(text).toContain('✅');
    expect(text).toContain('uuid-del');
    expect(text).toContain('bye.txt');
  });

  test('handles deletion error gracefully', async () => {
    mockGetAttachmentMetadata.mockResolvedValue({
      uuid: 'x', originalName: 'f.txt', sizeBytes: 1,
      mimeType: 'text/plain', uploadedAt: '2026-01-01T00:00:00Z', uploaderMachineId: 'm'
    });
    mockDeleteAttachment.mockRejectedValue(new Error('permission denied'));
    const result = await roosyncDeleteAttachment({ uuid: 'x' });
    expect(result.content[0].text).toContain('Erreur');
  });
});

// ============================================================
// CONS-7: roosync_attachments (outil consolidé)
// ============================================================

describe('roosync_attachments (CONS-7)', () => {
  beforeEach(() => vi.clearAllMocks());

  test('exports attachmentsToolMetadata with name roosync_attachments', () => {
    expect(attachmentsToolMetadata.name).toBe('roosync_attachments');
  });

  test('requires action field', () => {
    expect(attachmentsToolMetadata.inputSchema.required).toContain('action');
  });

  test('action=list delegates to roosyncListAttachments', async () => {
    mockListAttachments.mockResolvedValue([]);
    const result = await roosyncAttachments({ action: 'list' });
    expect(result.content[0].text).toContain('Aucune pièce jointe');
    expect(mockListAttachments).toHaveBeenCalledWith(undefined);
  });

  test('action=list with message_id filters correctly', async () => {
    mockListAttachments.mockResolvedValue([]);
    await roosyncAttachments({ action: 'list', message_id: 'msg-123' });
    expect(mockListAttachments).toHaveBeenCalledWith('msg-123');
  });

  test('action=get requires uuid', async () => {
    const result = await roosyncAttachments({ action: 'get', targetPath: '/tmp/out' });
    expect(result.content[0].text).toContain('uuid');
  });

  test('action=get requires targetPath', async () => {
    const result = await roosyncAttachments({ action: 'get', uuid: 'some-uuid' });
    expect(result.content[0].text).toContain('targetPath');
  });

  test('action=get delegates to roosyncGetAttachment', async () => {
    const mockMeta = {
      uuid: 'uuid-cons7', originalName: 'file.txt', sizeBytes: 100,
      mimeType: 'text/plain', uploadedAt: '2026-03-18T00:00:00Z', uploaderMachineId: 'po-2025'
    };
    mockGetAttachment.mockResolvedValue(mockMeta);
    const result = await roosyncAttachments({ action: 'get', uuid: 'uuid-cons7', targetPath: '/tmp/file.txt' });
    expect(result.content[0].text).toContain('✅');
    expect(result.content[0].text).toContain('uuid-cons7');
  });

  test('action=delete requires uuid', async () => {
    const result = await roosyncAttachments({ action: 'delete' });
    expect(result.content[0].text).toContain('uuid');
  });

  test('action=delete delegates to roosyncDeleteAttachment', async () => {
    const mockMeta = {
      uuid: 'uuid-del2', originalName: 'bye.txt', sizeBytes: 50,
      mimeType: 'text/plain', uploadedAt: '2026-03-18T00:00:00Z', uploaderMachineId: 'po-2025'
    };
    mockGetAttachmentMetadata.mockResolvedValue(mockMeta);
    mockDeleteAttachment.mockResolvedValue(undefined);
    const result = await roosyncAttachments({ action: 'delete', uuid: 'uuid-del2' });
    expect(result.content[0].text).toContain('✅');
    expect(result.content[0].text).toContain('uuid-del2');
  });

  test('unknown action returns error', async () => {
    const result = await roosyncAttachments({ action: 'unknown' as any });
    expect(result.content[0].text).toContain('Action inconnue');
  });
});
