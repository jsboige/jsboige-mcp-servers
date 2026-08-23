/**
 * Tests for the RooSync channel PG-primary WRITE path (#3151 Phase D).
 *
 * Covers the Phase D-1 contract:
 *   - gate: UNIFIED_STORE_CHANNEL_PG_PRIMARY implies the read gate
 *     (a machine that stops writing GDrive must not keep reading it primary)
 *   - sendMessage: PG insert success → NO GDrive files; PG failure →
 *     GDrive fallback (the send is never lost)
 *   - markAsRead / archiveMessage / amendMessage / destroyMessage: mutation
 *     against a PG-loaded row, same guards as the file path; PG miss →
 *     legacy file path; PG failure → file path
 *   - retention purge: opt-in window, transactional writer SQL shape
 *
 * Factories are mocked so no Postgres is needed; the concrete writer's SQL
 * is asserted against captured query text (same pattern as
 * unified-store-writer.test.ts).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Message } from '../../MessageManager.js';
import type { RooSyncMessageRow } from '../types.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';

// ─── Writer factory mock (module scope: vi.mock factories are hoisted) ──

const mockInsertRooSyncMessage = vi.fn().mockResolvedValue(undefined);
const mockUpdateRooSyncMessage = vi.fn().mockResolvedValue(undefined);
const mockDeleteRooSyncAttachment = vi.fn().mockResolvedValue(undefined);
const mockPurgeArchivedRooSyncMessages = vi.fn().mockResolvedValue(0);

vi.mock('../writer-factory.js', () => ({
  getUnifiedStoreWriter: () => ({
    insertRooSyncMessage: mockInsertRooSyncMessage,
    updateRooSyncMessage: mockUpdateRooSyncMessage,
    deleteRooSyncAttachment: mockDeleteRooSyncAttachment,
    purgeArchivedRooSyncMessages: mockPurgeArchivedRooSyncMessages,
  }),
  resetWriterInstance: vi.fn(),
}));

// ─── Reader factory mock ────────────────────────────────────────────

const mockGetRooSyncMessageById = vi.fn().mockResolvedValue(null);

vi.mock('../reader-factory.js', () => ({
  getUnifiedStoreReader: () => ({
    isNull: () => false,
    getRooSyncMessageById: mockGetRooSyncMessageById,
    getRooSyncMailbox: vi.fn().mockResolvedValue([]),
  }),
  resetReaderInstance: vi.fn(),
}));

// ─── pg mock (SQL shape assertions on the concrete writer) ──────────

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: vi.fn() });
const mockPool = { connect: mockConnect, query: mockQuery, end: vi.fn() };

vi.mock('pg', () => ({ default: { Pool: vi.fn(() => mockPool) } }));

// Import AFTER the factory mocks are registered.
import {
  isChannelPgPrimary,
  insertRooSyncMessagePrimary,
  updateRooSyncMessagePrimary,
  purgeArchivedChannelMessages,
} from '../roosync-channel-write.js';
import { getChannelPgReader } from '../roosync-channel-read.js';
import { PgUnifiedStoreWriter } from '../PgUnifiedStoreWriter.js';
import { MessageManager } from '../../MessageManager.js';

vi.unmock('fs');
vi.unmock('fs/promises');

// ─── Helpers ─────────────────────────────────────────────────────────

function sampleRow(overrides?: Partial<RooSyncMessageRow>): RooSyncMessageRow {
  return {
    id: 'msg-20260823T100000-aaaaaa',
    thread_id: null,
    from_machine: 'myia-po-2023',
    from_workspace: 'roo-extensions',
    to_machine: 'myia-ai-01',
    to_workspace: '',
    subject: '[TASK] test',
    body: 'Contenu de test',
    priority: 'HIGH',
    status: 'unread',
    tags: [],
    attachment_refs: [],
    created_at: '2026-08-23T10:00:00.000Z',
    reply_to: null,
    read_by: [],
    options: {},
    ...overrides,
  };
}

function withPrimaryGate(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://t:t@localhost:5432/x';
    try {
      await fn();
    } finally {
      delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
      delete process.env.UNIFIED_STORE_PG_URL;
      delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
    }
  };
}

// ─── Gate ────────────────────────────────────────────────────────────

describe('isChannelPgPrimary (env gate)', () => {
  afterEach(() => {
    delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
    delete process.env.UNIFIED_STORE_PG_URL;
  });

  test('flag off → false', () => {
    delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
    expect(isChannelPgPrimary()).toBe(false);
  });

  test('flag on without PG URL → false', () => {
    process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY = '1';
    delete process.env.UNIFIED_STORE_PG_URL;
    expect(isChannelPgPrimary()).toBe(false);
  });

  test('flag on + URL → true', () => {
    process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://t:t@localhost:5432/x';
    expect(isChannelPgPrimary()).toBe(true);
  });

  test(
    'write-primary gate implies the READ gate (getChannelPgReader non-null)',
    withPrimaryGate(() => {
      // UNIFIED_STORE_CHANNEL_READ_PG deliberately NOT set
      delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
      expect(getChannelPgReader()).not.toBeNull();
    })
  );
});

// ─── MessageManager PG-primary behaviors ─────────────────────────────

describe('MessageManager PG-primary write path', () => {
  let testPath: string;
  let messageManager: MessageManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertRooSyncMessage.mockResolvedValue(undefined);
    mockUpdateRooSyncMessage.mockResolvedValue(undefined);
    mockGetRooSyncMessageById.mockResolvedValue(null);
    testPath = join(tmpdir(), `rsm-pg-primary-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    messageManager = new MessageManager(testPath);
  });

  afterEach(() => {
    if (existsSync(testPath)) rmSync(testPath, { recursive: true, force: true });
  });

  function writeInboxFile(message: Message): void {
    mkdirSync(join(testPath, 'messages/inbox'), { recursive: true });
    writeFileSync(join(testPath, 'messages/inbox', `${message.id}.json`), JSON.stringify(message, null, 2));
  }

  // ── sendMessage ──

  test(
    'send: PG insert success → no GDrive files, message returned',
    withPrimaryGate(async () => {
      const sent = await messageManager.sendMessage(
        'myia-po-2023:roo-extensions', 'myia-ai-01', '[TASK]', 'body'
      );
      expect(sent.id).toMatch(/^msg-/);
      expect(mockInsertRooSyncMessage).toHaveBeenCalledTimes(1);
      expect(existsSync(join(testPath, 'messages/inbox', `${sent.id}.json`))).toBe(false);
      expect(existsSync(join(testPath, 'messages/sent', `${sent.id}.json`))).toBe(false);
    })
  );

  test(
    'send: PG insert failure → GDrive fallback, files written',
    withPrimaryGate(async () => {
      mockInsertRooSyncMessage.mockRejectedValue(new Error('PG down'));
      const sent = await messageManager.sendMessage(
        'myia-po-2023:roo-extensions', 'myia-ai-01', '[TASK]', 'body'
      );
      expect(existsSync(join(testPath, 'messages/inbox', `${sent.id}.json`))).toBe(true);
      expect(existsSync(join(testPath, 'messages/sent', `${sent.id}.json`))).toBe(true);
    })
  );

  test('send: gate off → GDrive files written (Phase A behavior)', async () => {
    const sent = await messageManager.sendMessage(
      'myia-po-2023:roo-extensions', 'myia-ai-01', '[TASK]', 'body'
    );
    expect(existsSync(join(testPath, 'messages/inbox', `${sent.id}.json`))).toBe(true);
  });

  // ── markAsRead ──

  test(
    'markAsRead: PG row → targeted status flip + options persisted, no file',
    withPrimaryGate(async () => {
      mockGetRooSyncMessageById.mockResolvedValue(sampleRow());
      const ok = await messageManager.markAsRead('msg-20260823T100000-aaaaaa', 'myia-ai-01');
      expect(ok).toBe(true);
      expect(mockUpdateRooSyncMessage).toHaveBeenCalledWith(
        'msg-20260823T100000-aaaaaa',
        expect.objectContaining({ status: 'read' })
      );
      const fields = mockUpdateRooSyncMessage.mock.calls[0][1];
      expect(fields.read_at).toBeDefined();
      expect(fields.options).toBeDefined();
      expect(fields.options.acknowledged_at).toHaveProperty('myia-ai-01');
      expect(existsSync(join(testPath, 'messages/inbox', 'msg-20260823T100000-aaaaaa.json'))).toBe(false);
    })
  );

  test(
    'markAsRead: broadcast → read_by mirrored, global status untouched',
    withPrimaryGate(async () => {
      mockGetRooSyncMessageById.mockResolvedValue(
        sampleRow({ to_machine: 'all', to_workspace: '' })
      );
      const ok = await messageManager.markAsRead('msg-20260823T100000-aaaaaa', 'myia-ai-01');
      expect(ok).toBe(true);
      const fields = mockUpdateRooSyncMessage.mock.calls[0][1];
      expect(fields.read_by).toEqual(['myia-ai-01']);
      expect(fields.status).toBeUndefined();
    })
  );

  test(
    'markAsRead: denied (reader not recipient) → false, no update',
    withPrimaryGate(async () => {
      mockGetRooSyncMessageById.mockResolvedValue(sampleRow());
      const ok = await messageManager.markAsRead('msg-20260823T100000-aaaaaa', 'myia-web1');
      expect(ok).toBe(false);
      expect(mockUpdateRooSyncMessage).not.toHaveBeenCalled();
    })
  );

  test(
    'markAsRead: PG update failure → GDrive file fallback',
    withPrimaryGate(async () => {
      mockGetRooSyncMessageById.mockResolvedValue(sampleRow());
      mockUpdateRooSyncMessage.mockRejectedValue(new Error('PG down'));
      writeInboxFile({
        id: 'msg-20260823T100000-aaaaaa',
        from: 'myia-po-2023:roo-extensions',
        to: 'myia-ai-01',
        subject: 's', body: 'b', priority: 'MEDIUM',
        timestamp: '2026-08-23T10:00:00.000Z', status: 'unread',
      });
      const ok = await messageManager.markAsRead('msg-20260823T100000-aaaaaa', 'myia-ai-01');
      expect(ok).toBe(true);
      const onDisk = JSON.parse(
        readFileSync(join(testPath, 'messages/inbox', 'msg-20260823T100000-aaaaaa.json'), 'utf-8')
      );
      expect(onDisk.status).toBe('read');
    })
  );

  // ── archiveMessage ──

  test(
    'archive: PG row → status+archived_at update, idempotent on archived row',
    withPrimaryGate(async () => {
      mockGetRooSyncMessageById.mockResolvedValue(sampleRow());
      const ok = await messageManager.archiveMessage('msg-20260823T100000-aaaaaa');
      expect(ok).toBe(true);
      expect(mockUpdateRooSyncMessage).toHaveBeenCalledWith(
        'msg-20260823T100000-aaaaaa',
        expect.objectContaining({ status: 'archived' })
      );

      mockUpdateRooSyncMessage.mockClear();
      mockGetRooSyncMessageById.mockResolvedValue(sampleRow({ status: 'archived' }));
      const again = await messageManager.archiveMessage('msg-20260823T100000-aaaaaa');
      expect(again).toBe(true);
      expect(mockUpdateRooSyncMessage).not.toHaveBeenCalled();
    })
  );

  test(
    'archive: PG row unknown → legacy file path',
    withPrimaryGate(async () => {
      mockGetRooSyncMessageById.mockResolvedValue(null);
      writeInboxFile({
        id: 'msg-legacy',
        from: 'myia-po-2023:roo-extensions',
        to: 'myia-ai-01',
        subject: 's', body: 'b', priority: 'MEDIUM',
        timestamp: '2026-08-23T10:00:00.000Z', status: 'read',
      });
      const ok = await messageManager.archiveMessage('msg-legacy');
      expect(ok).toBe(true);
      expect(existsSync(join(testPath, 'messages/archive', 'msg-legacy.json'))).toBe(true);
      expect(existsSync(join(testPath, 'messages/inbox', 'msg-legacy.json'))).toBe(false);
    })
  );

  // ── amendMessage ──

  test(
    'amend: PG row → body + options persisted',
    withPrimaryGate(async () => {
      mockGetRooSyncMessageById.mockResolvedValue(sampleRow());
      const result = await messageManager.amendMessage(
        'msg-20260823T100000-aaaaaa',
        'myia-po-2023:roo-extensions',
        'nouveau corps',
        'typo'
      );
      expect(result.success).toBe(true);
      expect(mockUpdateRooSyncMessage).toHaveBeenCalledWith(
        'msg-20260823T100000-aaaaaa',
        expect.objectContaining({ body: 'nouveau corps' })
      );
      const fields = mockUpdateRooSyncMessage.mock.calls[0][1];
      expect(fields.options.metadata).toMatchObject({
        amended: true,
        amendment_reason: 'typo',
        original_content: 'Contenu de test',
      });
    })
  );

  test(
    'amend: PG row already read → same error as the file path',
    withPrimaryGate(async () => {
      mockGetRooSyncMessageById.mockResolvedValue(sampleRow({ status: 'read' }));
      await expect(
        messageManager.amendMessage('msg-20260823T100000-aaaaaa', 'myia-po-2023:roo-extensions', 'x')
      ).rejects.toThrow(/déjà lu ou archivé/);
      expect(mockUpdateRooSyncMessage).not.toHaveBeenCalled();
    })
  );

  test(
    'amend: PG row, sender mismatch → permission error',
    withPrimaryGate(async () => {
      mockGetRooSyncMessageById.mockResolvedValue(sampleRow());
      await expect(
        messageManager.amendMessage('msg-20260823T100000-aaaaaa', 'myia-web1', 'x')
      ).rejects.toThrow(/Permission refusée/);
      expect(mockUpdateRooSyncMessage).not.toHaveBeenCalled();
    })
  );

  // ── destroyMessage ──

  test(
    'destroy: PG row with attachments → payloads purged then destroyed stamp',
    withPrimaryGate(async () => {
      mockGetRooSyncMessageById.mockResolvedValue(
        sampleRow({
          attachment_refs: [
            { uuid: 'u1', filename: 'a.txt', sizeBytes: 3 },
            { uuid: 'u2', filename: 'b.txt', sizeBytes: 4 },
          ],
        })
      );
      const ok = await messageManager.destroyMessage('msg-20260823T100000-aaaaaa', 'ttl_expired');
      expect(ok).toBe(true);
      expect(mockDeleteRooSyncAttachment).toHaveBeenCalledTimes(2);
      const updateCall = mockUpdateRooSyncMessage.mock.calls.find(
        (c) => c[1].destroyed_at !== undefined
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1].body).toBe('[DESTROYED]');
      expect(updateCall![1].destroyed_reason).toBe('ttl_expired');
    })
  );

  test(
    'destroy: already destroyed PG row → idempotent true, no writes',
    withPrimaryGate(async () => {
      mockGetRooSyncMessageById.mockResolvedValue(
        sampleRow({ destroyed_at: '2026-08-23T11:00:00.000Z' })
      );
      const ok = await messageManager.destroyMessage('msg-20260823T100000-aaaaaa', 'ttl_expired');
      expect(ok).toBe(true);
      expect(mockUpdateRooSyncMessage).not.toHaveBeenCalled();
      expect(mockDeleteRooSyncAttachment).not.toHaveBeenCalled();
    })
  );

  // ── retention ──

  test(
    'purgeArchivedFromStore: delegates the retention window to the writer',
    withPrimaryGate(async () => {
      mockPurgeArchivedRooSyncMessages.mockResolvedValue(7);
      const purged = await messageManager.purgeArchivedFromStore(90);
      expect(purged).toBe(7);
      expect(mockPurgeArchivedRooSyncMessages).toHaveBeenCalledWith(90);
    })
  );
});

// ─── Module-level helpers ────────────────────────────────────────────

describe('roosync-channel-write helpers (failure contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://t:t@localhost:5432/x';
  });
  afterEach(() => {
    delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
    delete process.env.UNIFIED_STORE_PG_URL;
  });

  test('insertRooSyncMessagePrimary resolves true on success', async () => {
    mockInsertRooSyncMessage.mockResolvedValue(undefined);
    const message: Message = {
      id: 'msg-1', from: 'myia-po-2023', to: 'myia-ai-01',
      subject: 's', body: 'b', priority: 'MEDIUM',
      timestamp: '2026-08-23T10:00:00.000Z', status: 'unread',
    };
    await expect(insertRooSyncMessagePrimary(message)).resolves.toBe(true);
  });

  test('insertRooSyncMessagePrimary resolves false (never throws) on PG failure', async () => {
    mockInsertRooSyncMessage.mockRejectedValue(new Error('PG down'));
    await expect(insertRooSyncMessagePrimary({} as Message)).resolves.toBe(false);
  });

  test('updateRooSyncMessagePrimary resolves false on PG failure', async () => {
    mockUpdateRooSyncMessage.mockRejectedValue(new Error('PG down'));
    await expect(updateRooSyncMessagePrimary('id', { body: 'x' })).resolves.toBe(false);
  });

  test('purgeArchivedChannelMessages: non-positive window → no writer call', async () => {
    await purgeArchivedChannelMessages(0);
    expect(mockPurgeArchivedRooSyncMessages).not.toHaveBeenCalled();
  });

  test('purgeArchivedChannelMessages: writer failure → 0, never throws', async () => {
    mockPurgeArchivedRooSyncMessages.mockRejectedValue(new Error('PG down'));
    await expect(purgeArchivedChannelMessages(30)).resolves.toBe(0);
  });
});

// ─── Concrete writer SQL shape ───────────────────────────────────────

describe('PgUnifiedStoreWriter — Phase D additions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks drops the module-scope implementations — re-establish
    // them (same pattern as unified-store-writer.test.ts)
    mockConnect.mockResolvedValue({ query: mockQuery, release: vi.fn() });
    mockQuery.mockResolvedValue({ rows: [] });
  });

  function createWriter(): PgUnifiedStoreWriter {
    return new PgUnifiedStoreWriter({
      connectionString: 'postgres://test:test@localhost:5432/unified_store',
      maxRetries: 0,
    });
  }

  test('updateRooSyncMessage serializes options as jsonb', async () => {
    const writer = createWriter();
    await writer.updateRooSyncMessage('msg-1', {
      status: 'read',
      options: { acknowledged_at: { 'myia-ai-01': '2026-08-23T10:05:00.000Z' } },
    });
    const call = mockQuery.mock.calls.find((c) => String(c[0]).includes('UPDATE roosync_messages'));
    expect(call).toBeDefined();
    const sql = String(call![0]);
    expect(sql).toContain('options = $');
    const params = call![1] as unknown[];
    const optionsParam = params.find(
      (p) => typeof p === 'string' && p.includes('acknowledged_at')
    );
    expect(optionsParam).toBeDefined();
    expect(JSON.parse(optionsParam as string)).toEqual({
      acknowledged_at: { 'myia-ai-01': '2026-08-23T10:05:00.000Z' },
    });
  });

  test('purgeArchivedRooSyncMessages: attachment deletes + row deletes in one transaction', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (String(sql).includes('SELECT id, attachment_refs')) {
        return Promise.resolve({
          rows: [
            { id: 'msg-a', attachment_refs: [{ uuid: 'u1' }, { uuid: 'u2' }] },
            { id: 'msg-b', attachment_refs: [] },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const writer = createWriter();
    const purged = await writer.purgeArchivedRooSyncMessages(90);
    expect(purged).toBe(2);
    expect(mockQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    const attDeletes = mockQuery.mock.calls.filter(
      (c) => String(c[0]) === 'DELETE FROM roosync_attachments WHERE id = $1'
    );
    expect(attDeletes).toHaveLength(2);
    const rowDelete = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes('DELETE FROM roosync_messages WHERE id = ANY')
    );
    expect(rowDelete).toBeDefined();
    expect(rowDelete![1]).toEqual([['msg-a', 'msg-b']]);
  });

  test('purgeArchivedRooSyncMessages: mid-transaction failure → ROLLBACK, count 0, never throws', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (String(sql).includes('DELETE FROM roosync_messages WHERE id = ANY')) {
        return Promise.reject(new Error('mid-transaction failure'));
      }
      if (String(sql).includes('SELECT id, attachment_refs')) {
        return Promise.resolve({ rows: [{ id: 'msg-a', attachment_refs: [] }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const writer = createWriter();
    // withRetry never throws (best-effort contract) — a rolled-back purge
    // must surface as 0, never as the candidate row count
    await expect(writer.purgeArchivedRooSyncMessages(90)).resolves.toBe(0);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  test('purgeArchivedRooSyncMessages: non-positive window → 0, no query', async () => {
    const writer = createWriter();
    await expect(writer.purgeArchivedRooSyncMessages(0)).resolves.toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
