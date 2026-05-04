/**
 * Tests unitaires pour roosync-attachments.tool.ts
 * Coverage: list, get, delete, consolidated tool, error handling, formatSize
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted() so mock functions are available in vi.mock() factories
const {
  mockListAttachments,
  mockGetAttachment,
  mockGetAttachmentMetadata,
  mockDeleteAttachment,
} = vi.hoisted(() => ({
  mockListAttachments: vi.fn(),
  mockGetAttachment: vi.fn(),
  mockGetAttachmentMetadata: vi.fn(),
  mockDeleteAttachment: vi.fn(),
}));

// Mock shared-state-path
vi.mock('../../utils/shared-state-path.js', () => ({
  getSharedStatePath: () => '/fake/shared-state',
}));

// Mock AttachmentManager — constructor returns object with mock methods
vi.mock('../../services/roosync/AttachmentManager.js', () => ({
  AttachmentManager: vi.fn(() => ({
    listAttachments: mockListAttachments,
    getAttachment: mockGetAttachment,
    getAttachmentMetadata: mockGetAttachmentMetadata,
    deleteAttachment: mockDeleteAttachment,
  })),
}));

import {
  roosyncListAttachments,
  roosyncGetAttachment,
  roosyncDeleteAttachment,
  roosyncAttachments,
} from '../roosync/roosync-attachments.tool.js';

const SAMPLE_META = {
  uuid: 'abc-123',
  originalName: 'report.txt',
  sizeBytes: 2048,
  mimeType: 'text/plain',
  uploadedAt: '2026-05-04T10:00:00Z',
  uploaderMachineId: 'myia-po-2023',
  messageId: 'msg-001',
};

beforeEach(() => {
  mockListAttachments.mockClear();
  mockGetAttachment.mockClear();
  mockGetAttachmentMetadata.mockClear();
  mockDeleteAttachment.mockClear();
});

describe('roosyncListAttachments', () => {
  it('returns empty message when no attachments', async () => {
    mockListAttachments.mockResolvedValue([]);
    const result = await roosyncListAttachments({});
    expect(result.content[0].text).toContain('Aucune');
  });

  it('returns empty message scoped to message_id', async () => {
    mockListAttachments.mockResolvedValue([]);
    const result = await roosyncListAttachments({ message_id: 'msg-x' });
    expect(result.content[0].text).toContain('msg-x');
  });

  it('returns table with attachments', async () => {
    mockListAttachments.mockResolvedValue([SAMPLE_META]);
    const result = await roosyncListAttachments({});
    expect(result.content[0].text).toContain('abc-123');
    expect(result.content[0].text).toContain('report.txt');
    expect(result.content[0].text).toContain('2.0 KB');
    expect(result.content[0].text).toContain('Total');
  });

  it('handles error gracefully', async () => {
    mockListAttachments.mockRejectedValue(new Error('disk full'));
    const result = await roosyncListAttachments({});
    expect(result.content[0].text).toContain('Erreur');
    expect(result.content[0].text).toContain('disk full');
  });
});

describe('roosyncGetAttachment', () => {
  it('returns error if uuid missing', async () => {
    const result = await roosyncGetAttachment({ uuid: '', targetPath: '/tmp/out' });
    expect(result.content[0].text).toContain('uuid');
  });

  it('returns error if targetPath missing', async () => {
    const result = await roosyncGetAttachment({ uuid: 'abc', targetPath: '' });
    expect(result.content[0].text).toContain('targetPath');
  });

  it('returns success with metadata', async () => {
    mockGetAttachment.mockResolvedValue(SAMPLE_META);
    const result = await roosyncGetAttachment({ uuid: 'abc-123', targetPath: '/tmp/out.txt' });
    expect(result.content[0].text).toContain('récupérée');
    expect(result.content[0].text).toContain('abc-123');
    expect(result.content[0].text).toContain('/tmp/out.txt');
  });

  it('handles error with helpful message', async () => {
    mockGetAttachment.mockRejectedValue(new Error('not found'));
    const result = await roosyncGetAttachment({ uuid: 'bad', targetPath: '/tmp/out' });
    expect(result.content[0].text).toContain('Erreur');
    expect(result.content[0].text).toContain('bad');
  });
});

describe('roosyncDeleteAttachment', () => {
  it('returns error if uuid missing', async () => {
    const result = await roosyncDeleteAttachment({ uuid: '' });
    expect(result.content[0].text).toContain('uuid');
  });

  it('returns not found if metadata is null', async () => {
    mockGetAttachmentMetadata.mockResolvedValue(null);
    const result = await roosyncDeleteAttachment({ uuid: 'ghost' });
    expect(result.content[0].text).toContain('introuvable');
  });

  it('deletes and returns confirmation', async () => {
    mockGetAttachmentMetadata.mockResolvedValue(SAMPLE_META);
    mockDeleteAttachment.mockResolvedValue(undefined);
    const result = await roosyncDeleteAttachment({ uuid: 'abc-123' });
    expect(result.content[0].text).toContain('supprimée');
    expect(result.content[0].text).toContain('report.txt');
    expect(mockDeleteAttachment).toHaveBeenCalledWith('abc-123');
  });

  it('handles delete error', async () => {
    mockGetAttachmentMetadata.mockResolvedValue(SAMPLE_META);
    mockDeleteAttachment.mockRejectedValue(new Error('permission denied'));
    const result = await roosyncDeleteAttachment({ uuid: 'abc-123' });
    expect(result.content[0].text).toContain('Erreur');
  });
});

describe('roosyncAttachments (consolidated)', () => {
  it('delegates to list', async () => {
    mockListAttachments.mockResolvedValue([SAMPLE_META]);
    const result = await roosyncAttachments({ action: 'list' });
    expect(result.content[0].text).toContain('abc-123');
  });

  it('delegates to get with validation', async () => {
    const result = await roosyncAttachments({ action: 'get', uuid: '', targetPath: '/tmp' });
    expect(result.content[0].text).toContain('uuid');
  });

  it('delegates to get requiring targetPath', async () => {
    const result = await roosyncAttachments({ action: 'get', uuid: 'abc', targetPath: '' });
    expect(result.content[0].text).toContain('targetPath');
  });

  it('delegates to delete with validation', async () => {
    const result = await roosyncAttachments({ action: 'delete', uuid: '' });
    expect(result.content[0].text).toContain('uuid');
  });

  it('returns error for unknown action', async () => {
    const result = await roosyncAttachments({ action: 'foobar' } as any);
    expect(result.content[0].text).toContain('Action inconnue');
  });
});

describe('formatSize (indirect)', () => {
  it('formats bytes', async () => {
    mockListAttachments.mockResolvedValue([{ ...SAMPLE_META, sizeBytes: 512 }]);
    const result = await roosyncListAttachments({});
    expect(result.content[0].text).toContain('512 B');
  });

  it('formats KB', async () => {
    mockListAttachments.mockResolvedValue([SAMPLE_META]);
    const result = await roosyncListAttachments({});
    expect(result.content[0].text).toContain('2.0 KB');
  });

  it('formats MB', async () => {
    mockListAttachments.mockResolvedValue([{ ...SAMPLE_META, sizeBytes: 5 * 1024 * 1024 }]);
    const result = await roosyncListAttachments({});
    expect(result.content[0].text).toContain('5.0 MB');
  });
});
