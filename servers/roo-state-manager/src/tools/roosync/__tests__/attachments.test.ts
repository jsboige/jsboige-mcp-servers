/**
 * Tests pour les outils MCP de pièces jointes RooSync (#674)
 * - roosync_list_attachments
 * - roosync_get_attachment
 * - roosync_delete_attachment
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockListAttachments, mockGetAttachment, mockGetAttachmentMetadata, mockDeleteAttachment, mockGetMessage, mockListByRefs } = vi.hoisted(() => ({
  mockListAttachments: vi.fn(),
  mockGetAttachment: vi.fn(),
  mockGetAttachmentMetadata: vi.fn(),
  mockDeleteAttachment: vi.fn(),
  mockGetMessage: vi.fn(),
  mockListByRefs: vi.fn(),
}));

vi.mock('../../../services/roosync/AttachmentManager.js', () => ({
  AttachmentManager: class {
    constructor() {}
    listAttachments(...args: any[]) { return mockListAttachments(...args); }
    // #3256 targeted path — mocked at class level like its scan sibling
    listAttachmentsByRefs(...args: any[]) { return mockListByRefs(...args); }
    getAttachment(...args: any[]) { return mockGetAttachment(...args); }
    getAttachmentMetadata(...args: any[]) { return mockGetAttachmentMetadata(...args); }
    deleteAttachment(...args: any[]) { return mockDeleteAttachment(...args); }
  }
}));

// #3256 — the targeted path resolves refs through the MessageManager
// singleton; mock it (undefined getMessage → null → fallback scan, which is
// exactly the pre-#3256 behavior the existing tests below pin).
vi.mock('../../../services/MessageManager.js', () => ({
  getMessageManager: () => ({ getMessage: mockGetMessage }),
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
  roosyncGetAttachment,
  roosyncDeleteAttachment,
  roosyncAttachments,
} from '../roosync-attachments.tool.js';

// ============================================================
describe('roosync_list_attachments', () => {
  beforeEach(() => vi.clearAllMocks());

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
    // Second arg is the stats accumulator (#3013) — shape is covered by the
    // manager tests; here we only care that the message_id propagated.
    expect(mockListAttachments).toHaveBeenCalledWith('msg-xyz', expect.anything());
  });

  test('lists all attachments when no messageId provided', async () => {
    mockListAttachments.mockResolvedValue([]);
    await roosyncListAttachments({});
    expect(mockListAttachments).toHaveBeenCalledWith(undefined, expect.anything());
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

  test('action=list delegates to roosyncListAttachments', async () => {
    mockListAttachments.mockResolvedValue([]);
    const result = await roosyncAttachments({ action: 'list' });
    expect(result.content[0].text).toContain('Aucune pièce jointe');
    // Stats accumulator is passed as second arg (#3013) — covered by manager tests.
    expect(mockListAttachments).toHaveBeenCalledWith(undefined, expect.anything());
  });

  test('action=list with message_id filters correctly', async () => {
    mockListAttachments.mockResolvedValue([]);
    await roosyncAttachments({ action: 'list', message_id: 'msg-123' });
    expect(mockListAttachments).toHaveBeenCalledWith('msg-123', expect.anything());
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

// ============================================================
// #3256 — targeted lookup: message refs replace the store scan
// ============================================================
describe('#3256 targeted attachment lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks drops implementations (vitest v3); re-establish the default
    // delegation so a miss resolves to [] and an unknown message to the fallback.
    mockListByRefs.mockResolvedValue([]);
    mockGetMessage.mockResolvedValue(null);
  });

  test('message with attachments[] resolves via listAttachmentsByRefs — scan never called', async () => {
    mockGetMessage.mockResolvedValue({
      id: 'msg-hit', from: 'a', to: 'b', subject: 's', body: 'x',
      priority: 'LOW', timestamp: '2026-08-24T00:00:00Z', status: 'unread',
      attachments: [
        { uuid: 'uuid-1', filename: 'one.txt', sizeBytes: 10 },
        { uuid: 'uuid-2', filename: 'two.txt', sizeBytes: 20 },
      ],
    });
    mockListByRefs.mockResolvedValue([
      { uuid: 'uuid-1', originalName: 'one.txt', sizeBytes: 10, mimeType: 'text/plain', uploadedAt: '2026-08-24T00:00:00Z', uploaderMachineId: 'm', messageId: 'msg-hit' },
      { uuid: 'uuid-2', originalName: 'two.txt', sizeBytes: 20, mimeType: 'text/plain', uploadedAt: '2026-08-24T00:00:00Z', uploaderMachineId: 'm', messageId: 'msg-hit' },
    ]);

    const result = await roosyncListAttachments({ message_id: 'msg-hit' });

    expect(mockListByRefs).toHaveBeenCalledWith(['uuid-1', 'uuid-2'], expect.anything());
    expect(mockListAttachments).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('uuid-1');
    expect(result.content[0].text).toContain('**Total :** 2');
  });

  test('message WITHOUT attachments answers immediately — the scan is never touched', async () => {
    mockGetMessage.mockResolvedValue({
      id: 'msg-miss', from: 'a', to: 'b', subject: 's', body: 'x',
      priority: 'LOW', timestamp: '2026-08-24T00:00:00Z', status: 'unread',
    });

    const result = await roosyncListAttachments({ message_id: 'msg-miss' });

    expect(result.content[0].text).toContain('Aucune pièce jointe');
    expect(result.content[0].text).toContain('msg-miss');
    // The store scan (O(N_flotte), the 17.9s miss) must never run; byRefs([])
    // itself issues zero IO — proven at service level by the readFile counter.
    expect(mockListAttachments).not.toHaveBeenCalled();
    expect(mockListByRefs).toHaveBeenCalledWith([], expect.anything());
  });

  test('message with explicit empty attachments[] is a definitive miss too', async () => {
    mockGetMessage.mockResolvedValue({
      id: 'msg-empty', from: 'a', to: 'b', subject: 's', body: 'x',
      priority: 'LOW', timestamp: '2026-08-24T00:00:00Z', status: 'unread',
      attachments: [],
    });

    await roosyncListAttachments({ message_id: 'msg-empty' });
    expect(mockListAttachments).not.toHaveBeenCalled();
    expect(mockListByRefs).toHaveBeenCalledWith([], expect.anything());
  });

  test('UNKNOWN message falls back to the historical scan path', async () => {
    mockGetMessage.mockResolvedValue(null);
    mockListAttachments.mockResolvedValue([]);

    await roosyncListAttachments({ message_id: 'msg-ghost' });

    expect(mockListAttachments).toHaveBeenCalledWith('msg-ghost', expect.anything());
    expect(mockListByRefs).not.toHaveBeenCalled();
  });

  test('attachments_get resolves uuid from (message_id, filename) without any listing', async () => {
    mockGetMessage.mockResolvedValue({
      id: 'msg-get', from: 'a', to: 'b', subject: 's', body: 'x',
      priority: 'LOW', timestamp: '2026-08-24T00:00:00Z', status: 'unread',
      attachments: [
        { uuid: 'uuid-aaa', filename: 'secret.key', sizeBytes: 5 },
        { uuid: 'uuid-bbb', filename: 'other.txt', sizeBytes: 7 },
      ],
    });
    mockGetAttachment.mockResolvedValue({
      uuid: 'uuid-aaa', originalName: 'secret.key', sizeBytes: 5,
      mimeType: 'application/octet-stream', uploadedAt: '2026-08-24T00:00:00Z',
      uploaderMachineId: 'm', messageId: 'msg-get',
    });

    const result = await roosyncGetAttachment({ message_id: 'msg-get', filename: 'secret.key', targetPath: '/tmp/secret.key' });

    expect(mockGetAttachment).toHaveBeenCalledWith('uuid-aaa', '/tmp/secret.key');
    expect(result.content[0].text).toContain('✅');
    expect(result.content[0].text).toContain('uuid-aaa');
  });

  test('attachments_get with an absent filename lists what IS available', async () => {
    mockGetMessage.mockResolvedValue({
      id: 'msg-nope', from: 'a', to: 'b', subject: 's', body: 'x',
      priority: 'LOW', timestamp: '2026-08-24T00:00:00Z', status: 'unread',
      attachments: [{ uuid: 'uuid-aaa', filename: 'real.txt', sizeBytes: 5 }],
    });

    const result = await roosyncGetAttachment({ message_id: 'msg-nope', filename: 'ghost.txt', targetPath: '/tmp/x' });

    expect(mockGetAttachment).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('real.txt');
  });

  test('attachments_get without uuid and without (message_id, filename) says what is required', async () => {
    const result = await roosyncGetAttachment({ targetPath: '/tmp/x' });
    expect(result.content[0].text).toContain('uuid');
    expect(result.content[0].text).toContain('message_id');
  });
});
