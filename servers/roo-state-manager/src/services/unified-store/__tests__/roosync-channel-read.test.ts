/**
 * Tests for the RooSync channel PG-primary read path (#3151 Phase B).
 *
 * Covers the spec acceptance points:
 *   - row → Message mapping restores full fidelity (round-trip with
 *     mapMessageToRow: same fields on the way back)
 *   - readChannelInboxFromPg applies the GDrive inbox semantics
 *     (recipient matching, status filter, per-machine broadcast state
 *     from read_by)
 *   - PG failure → null → MessageManager falls back to GDrive files
 *     (dégradation gracieuse)
 *   - flag off → GDrive path only, zero reader calls
 *   - MessageManager readInbox / getFilteredCount / getMessage are
 *     PG-first when the gate is on
 *   - markAsRead on a broadcast mirrors read_by (not global status)
 *
 * The reader factory is mocked so no Postgres is needed; SQL shape of the
 * concrete PgUnifiedStoreReader is asserted against the captured query text.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Message, MessageListItem } from '../../MessageManager.js';
import type { RooSyncMessageRow } from '../types.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';

// ─── Reader factory mock (controllable double) ──────────────────────

const mockGetRooSyncMailbox = vi.fn().mockResolvedValue([]);
const mockGetRooSyncMessageById = vi.fn().mockResolvedValue(null);

vi.mock('../reader-factory.js', () => ({
  getUnifiedStoreReader: () => ({
    isNull: () => false,
    getRooSyncMailbox: mockGetRooSyncMailbox,
    getRooSyncMessageById: mockGetRooSyncMessageById,
  }),
  resetReaderInstance: vi.fn(),
}));

// ─── Writer factory mock (dual-write assertions) ────────────────────
// Module scope: vi.mock factories are hoisted, so referenced consts must
// live here (same pattern as roosync-channel-dual-write.test.ts).

const mockUpdateRooSyncMessage = vi.fn().mockResolvedValue(undefined);

vi.mock('../writer-factory.js', () => ({
  getUnifiedStoreWriter: () => ({
    insertRooSyncMessage: vi.fn().mockResolvedValue(undefined),
    updateRooSyncMessage: mockUpdateRooSyncMessage,
    insertRooSyncAttachment: vi.fn().mockResolvedValue(undefined),
    deleteRooSyncAttachment: vi.fn().mockResolvedValue(undefined),
  }),
  resetWriterInstance: vi.fn(),
}));

// ─── pg mock (SQL shape assertions on the concrete reader) ──────────

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: vi.fn() });
const mockPool = { connect: mockConnect, query: mockQuery, end: vi.fn() };

vi.mock('pg', () => ({ default: { Pool: vi.fn(() => mockPool) } }));

// Import AFTER the factory mock is registered.
import {
  getChannelPgReader,
  mapRowToMessage,
  mapRowToListItem,
  readChannelInboxFromPg,
  countChannelInboxFromPg,
  getChannelMessageFromPg,
} from '../roosync-channel-read.js';
import { mapMessageToRow } from '../roosync-channel-dual-write.js';
import { MessageManager } from '../../MessageManager.js';

vi.unmock('fs');
vi.unmock('fs/promises');

// ─── Helpers ─────────────────────────────────────────────────────────

function sampleRow(overrides?: Partial<RooSyncMessageRow>): RooSyncMessageRow {
  return {
    id: 'msg-20260818T100000-aaaaaa',
    thread_id: 'thread-1',
    from_machine: 'myia-po-2023',
    from_workspace: 'roo-extensions',
    to_machine: 'myia-ai-01',
    to_workspace: '',
    subject: '[TASK] test',
    body: 'Contenu de test',
    priority: 'HIGH',
    status: 'unread',
    tags: ['TASK'],
    attachment_refs: [],
    created_at: '2026-08-18T10:00:00.000Z',
    reply_to: 'msg-20260817T000000-bbbbbb',
    read_by: [],
    options: {},
    ...overrides,
  };
}

function withReadGate(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://t:t@localhost:5432/x';
    try {
      await fn();
    } finally {
      delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
    }
  };
}

// ─── Mapping parity ─────────────────────────────────────────────────

describe('row → Message mapping (full-fidelity round-trip)', () => {
  test('every Message field survives mapMessageToRow → mapRowToMessage', () => {
    const message: Message = {
      id: 'msg-20260818T100000-aaaaaa',
      from: 'myia-po-2023:roo-extensions',
      to: 'myia-ai-01:roo-extensions',
      subject: '[TASK] test',
      body: 'Contenu de test',
      priority: 'HIGH',
      timestamp: '2026-08-18T10:00:00.000Z',
      status: 'unread',
      tags: ['TASK'],
      thread_id: 'thread-1',
      reply_to: 'msg-20260817T000000-bbbbbb',
      read_by: ['myia-po-2025'],
      auto_destruct: true,
      destruct_after: '30m',
      destruct_after_read_by: ['myia-ai-01'],
      expires_at: '2026-08-18T10:30:00.000Z',
      acknowledged_at: { 'myia-po-2025': '2026-08-18T10:05:00.000Z' },
      attachments: [{ uuid: 'u1', filename: 'a.txt', sizeBytes: 3 }],
    };
    const restored = mapRowToMessage(mapMessageToRow(message));

    expect(restored).toEqual(message);
  });

  test('bare machine ids round-trip without a workspace suffix', () => {
    const restored = mapRowToMessage(sampleRow({ to_workspace: '' }));
    expect(restored.to).toBe('myia-ai-01');
  });

  test('destroyed / reminder stamps are restored from the update-path columns', () => {
    const restored = mapRowToMessage(
      sampleRow({
        destroyed_at: '2026-08-18T11:00:00.000Z',
        destroyed_reason: 'ttl_expired',
        reminder_sent_at: '2026-08-18T10:45:00.000Z',
      })
    );
    expect(restored.destroyed_at).toBe('2026-08-18T11:00:00.000Z');
    expect(restored.destroyed_reason).toBe('ttl_expired');
    expect(restored.reminder_sent).toBe(true);
  });

  test('list item preview truncates at 100 chars like the GDrive cache build', () => {
    const item = mapRowToListItem(sampleRow({ body: 'x'.repeat(150) }));
    expect(item.preview.length).toBe(103); // 100 + '...'
    expect(item.preview.endsWith('...')).toBe(true);
  });
});

// ─── Env gate ───────────────────────────────────────────────────────

describe('getChannelPgReader (env gate)', () => {
  afterEach(() => {
    delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
    delete process.env.UNIFIED_STORE_PG_URL;
  });

  test('flag off → null (GDrive path, zero PG calls)', () => {
    delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
    expect(getChannelPgReader()).toBeNull();
  });

  test('flag on without PG URL → null', () => {
    process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
    delete process.env.UNIFIED_STORE_PG_URL;
    expect(getChannelPgReader()).toBeNull();
  });

  test('flag on + URL + non-null reader → reader', () => {
    process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://t:t@localhost:5432/x';
    expect(getChannelPgReader()).not.toBeNull();
  });
});

// ─── Inbox semantics on PG rows ─────────────────────────────────────

describe('readChannelInboxFromPg (GDrive inbox semantics)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('filters by recipient (workspace-aware) and orders newest first', async () => {
    mockGetRooSyncMailbox.mockResolvedValue([
      sampleRow({ id: 'newer', created_at: '2026-08-18T12:00:00.000Z' }),
      sampleRow({ id: 'other-machine', to_machine: 'myia-web1' }),
      sampleRow({ id: 'other-workspace', to_workspace: 'CoursIA' }),
      sampleRow({ id: 'older', created_at: '2026-08-18T11:00:00.000Z' }),
      sampleRow({ id: 'ws-targeted', to_workspace: 'roo-extensions', created_at: '2026-08-18T10:30:00.000Z' }),
    ]);

    const items = await readChannelInboxFromPg(
      getReaderDouble(), 'myia-ai-01', undefined, 'roo-extensions'
    );

    expect(items).not.toBeNull();
    expect(items!.map((i) => i.id)).toEqual(['newer', 'older', 'ws-targeted']);
  });

  test('broadcast status is per-machine from read_by (#629, #2307 p4)', async () => {
    mockGetRooSyncMailbox.mockResolvedValue([
      sampleRow({ id: 'bc-read', to_machine: 'all', to_workspace: '', read_by: ['myia-ai-01'] }),
      sampleRow({ id: 'bc-unread', to_machine: 'all', to_workspace: '', read_by: ['myia-po-2025'] }),
    ]);

    const all = await readChannelInboxFromPg(getReaderDouble(), 'myia-ai-01');
    expect(all!.find((i) => i.id === 'bc-read')!.status).toBe('read');
    expect(all!.find((i) => i.id === 'bc-unread')!.status).toBe('unread');

    const unreadOnly = await readChannelInboxFromPg(getReaderDouble(), 'myia-ai-01', 'unread');
    expect(unreadOnly!.map((i) => i.id)).toEqual(['bc-unread']);

    const readOnly = await readChannelInboxFromPg(getReaderDouble(), 'myia-ai-01', 'read');
    expect(readOnly!.map((i) => i.id)).toEqual(['bc-read']);
  });

  test('targeted status filter matches the global row status', async () => {
    mockGetRooSyncMailbox.mockResolvedValue([
      sampleRow({ id: 'u', status: 'unread' }),
      sampleRow({ id: 'r', status: 'read' }),
    ]);
    const unread = await readChannelInboxFromPg(getReaderDouble(), 'myia-ai-01', 'unread');
    expect(unread!.map((i) => i.id)).toEqual(['u']);
  });

  test('archived rows never reach the mailbox (reader contract)', async () => {
    // The SQL filters status <> 'archived'; the double simulates that contract.
    mockGetRooSyncMailbox.mockResolvedValue([sampleRow({ id: 'inbox' })]);
    const items = await readChannelInboxFromPg(getReaderDouble(), 'myia-ai-01');
    expect(items!.map((i) => i.id)).toEqual(['inbox']);
  });

  test('PG failure → null (caller falls back to GDrive)', async () => {
    mockGetRooSyncMailbox.mockRejectedValue(new Error('PG down'));
    const items = await readChannelInboxFromPg(getReaderDouble(), 'myia-ai-01');
    expect(items).toBeNull();
  });

  test('countChannelInboxFromPg counts per-machine broadcast state', async () => {
    mockGetRooSyncMailbox.mockResolvedValue([
      sampleRow({ id: 'u', status: 'unread' }),
      sampleRow({ id: 'r', status: 'read' }),
      sampleRow({ id: 'bc', to_machine: 'all', to_workspace: '', read_by: ['myia-ai-01'] }),
    ]);
    const counts = await countChannelInboxFromPg(getReaderDouble(), 'myia-ai-01');
    expect(counts).toEqual({ total: 3, unread: 1, read: 2 });
  });

  test('countChannelInboxFromPg → null on PG failure', async () => {
    mockGetRooSyncMailbox.mockRejectedValue(new Error('PG down'));
    expect(await countChannelInboxFromPg(getReaderDouble(), 'myia-ai-01')).toBeNull();
  });

  test('getChannelMessageFromPg returns the full message or null', async () => {
    mockGetRooSyncMessageById.mockResolvedValue(sampleRow({ body: 'hello' }));
    const hit = await getChannelMessageFromPg(getReaderDouble(), 'msg-x');
    expect(hit?.body).toBe('hello');

    mockGetRooSyncMessageById.mockResolvedValue(null);
    expect(await getChannelMessageFromPg(getReaderDouble(), 'msg-unknown')).toBeNull();

    mockGetRooSyncMessageById.mockRejectedValue(new Error('PG down'));
    expect(await getChannelMessageFromPg(getReaderDouble(), 'msg-x')).toBeNull();
  });
});

/** The same double shape the factory mock returns. */
function getReaderDouble() {
  return {
    isNull: () => false,
    getRooSyncMailbox: mockGetRooSyncMailbox,
    getRooSyncMessageById: mockGetRooSyncMessageById,
  } as unknown as Parameters<typeof readChannelInboxFromPg>[0];
}

// ─── MessageManager integration (PG-first, GDrive fallback) ─────────

describe('MessageManager PG-first reads (#3151 Phase B)', () => {
  let messageManager: MessageManager;
  let testPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testPath = join(tmpdir(), `rsm-b-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    for (const d of ['messages/inbox', 'messages/sent', 'messages/archive']) {
      mkdirSync(join(testPath, d), { recursive: true });
    }
    messageManager = new MessageManager(testPath);
  });

  afterEach(() => {
    if (existsSync(testPath)) rmSync(testPath, { recursive: true, force: true });
  });

  function writeInboxFile(message: Message): void {
    writeFileSync(join(testPath, 'messages/inbox', `${message.id}.json`), JSON.stringify(message, null, 2));
  }

  test(
    'readInbox serves from PG without touching the GDrive inbox',
    withReadGate(async () => {
      mockGetRooSyncMailbox.mockResolvedValue([
        sampleRow({ id: 'pg-1', subject: 'from PG' }),
      ]);
      // No GDrive file written — a GDrive read would return [].

      const items = await messageManager.readInbox('myia-ai-01', 'all', undefined, 'roo-extensions');
      expect(items.map((i) => i.id)).toEqual(['pg-1']);
      expect(items[0].subject).toBe('from PG');
      expect(mockGetRooSyncMailbox).toHaveBeenCalledWith('myia-ai-01');
    })
  );

  test(
    'readInbox PG failure falls back to GDrive files',
    withReadGate(async () => {
      mockGetRooSyncMailbox.mockRejectedValue(new Error('PG down'));
      writeInboxFile({
        id: 'g-1',
        from: 'myia-po-2023:roo-extensions',
        to: 'myia-ai-01:roo-extensions',
        subject: 'from GDrive',
        body: 'b',
        priority: 'MEDIUM',
        timestamp: '2026-08-18T09:00:00.000Z',
        status: 'unread',
      });

      const items = await messageManager.readInbox('myia-ai-01', 'all', undefined, 'roo-extensions');
      expect(items.map((i) => i.id)).toEqual(['g-1']);
    })
  );

  test(
    'readInbox paginates PG results with the #638 semantics',
    withReadGate(async () => {
      mockGetRooSyncMailbox.mockResolvedValue([
        sampleRow({ id: 'a' }),
        sampleRow({ id: 'b' }),
        sampleRow({ id: 'c' }),
      ]);

      const page2 = await messageManager.readInbox('myia-ai-01', 'all', undefined, undefined, 2, 2);
      expect(page2.map((i) => i.id)).toEqual(['c']);
    })
  );

  test(
    'getFilteredCount counts from PG',
    withReadGate(async () => {
      mockGetRooSyncMailbox.mockResolvedValue([
        sampleRow({ id: 'u', status: 'unread' }),
        sampleRow({ id: 'r', status: 'read' }),
      ]);
      const counts = await messageManager.getFilteredCount('myia-ai-01');
      expect(counts).toEqual({ total: 2, unread: 1, read: 1 });
    })
  );

  test(
    'getMessage serves from PG and enforces the #2287 access check',
    withReadGate(async () => {
      mockGetRooSyncMessageById.mockResolvedValue(sampleRow({ body: 'secret' }));

      const asRecipient = await messageManager.getMessage('msg-20260818T100000-aaaaaa', 'myia-ai-01:roo-extensions');
      expect(asRecipient?.body).toBe('secret');

      const asOutsider = await messageManager.getMessage('msg-20260818T100000-aaaaaa', 'myia-web1:roo-extensions');
      expect(asOutsider).toBeNull();
    })
  );

  test(
    'getMessage PG miss falls back to the GDrive paths',
    withReadGate(async () => {
      mockGetRooSyncMessageById.mockResolvedValue(null);
      writeInboxFile({
        id: 'g-2',
        from: 'myia-po-2023:roo-extensions',
        to: 'myia-ai-01:roo-extensions',
        subject: 's',
        body: 'gd',
        priority: 'MEDIUM',
        timestamp: '2026-08-18T08:00:00.000Z',
        status: 'unread',
      });

      const msg = await messageManager.getMessage('g-2', 'myia-ai-01:roo-extensions');
      expect(msg?.body).toBe('gd');
    })
  );

  test('flag off → GDrive path only, zero reader calls', async () => {
    delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
    writeInboxFile({
      id: 'g-3',
      from: 'myia-po-2023:roo-extensions',
      to: 'myia-ai-01:roo-extensions',
      subject: 's',
      body: 'gd',
      priority: 'MEDIUM',
      timestamp: '2026-08-18T07:00:00.000Z',
      status: 'unread',
    });

    const items = await messageManager.readInbox('myia-ai-01', 'all', undefined, 'roo-extensions');
    expect(items.map((i) => i.id)).toEqual(['g-3']);
    expect(mockGetRooSyncMailbox).not.toHaveBeenCalled();
    expect(mockGetRooSyncMessageById).not.toHaveBeenCalled();
  });
});

// ─── Broadcast read mirror (markAsRead) ─────────────────────────────

describe('markAsRead broadcast mirror (#3151 Phase B)', () => {
  let messageManager: MessageManager;
  let testPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testPath = join(tmpdir(), `rsm-b2-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    for (const d of ['messages/inbox', 'messages/sent', 'messages/archive']) {
      mkdirSync(join(testPath, d), { recursive: true });
    }
    messageManager = new MessageManager(testPath);
  });

  afterEach(() => {
    if (existsSync(testPath)) rmSync(testPath, { recursive: true, force: true });
  });

  test(
    'broadcast read mirrors read_by, NOT a global status flip',
    withReadGate(async () => {
      writeBroadcast(testPath, 'bc-1', ['myia-po-2025']);
      const ok = await messageManager.markAsRead('bc-1', 'myia-ai-01:roo-extensions');
      expect(ok).toBe(true);

      await vi.waitFor(() => {
        const readByCall = mockUpdateRooSyncMessage.mock.calls.find(
          (c) => (c[1] as Record<string, unknown>).read_by !== undefined
        );
        expect(readByCall).toBeDefined();
        expect(readByCall![0]).toBe('bc-1');
        expect((readByCall![1] as { read_by: string[] }).read_by).toEqual(
          expect.arrayContaining(['myia-po-2025', 'myia-ai-01'])
        );
      });

      // No global status flip for broadcasts — the A.2 invariant holds.
      const statusCall = mockUpdateRooSyncMessage.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>).status === 'read'
      );
      expect(statusCall).toBeUndefined();
    })
  );

  function writeBroadcast(basePath: string, id: string, readBy: string[]): void {
    writeFileSync(join(basePath, 'messages/inbox', `${id}.json`), JSON.stringify({
      id,
      from: 'myia-po-2023:roo-extensions',
      to: 'all',
      subject: 'broadcast',
      body: 'b',
      priority: 'MEDIUM',
      timestamp: '2026-08-18T06:00:00.000Z',
      status: 'unread',
      read_by: readBy,
    }, null, 2));
  }
});

// ─── PgUnifiedStoreReader SQL shape ─────────────────────────────────

describe('PgUnifiedStoreReader channel SQL shape', () => {
  beforeEach(() => {
    // Re-arm implementations: earlier describes call vi.clearAllMocks(), and
    // the global setup may restore mocks between tests (same defensive
    // pattern as roosync-channel-dual-write.test.ts).
    mockConnect.mockResolvedValue({ query: mockQuery, release: vi.fn() });
    mockQuery.mockResolvedValue({ rows: [] });
  });

  test('mailbox query bounds candidates via to_machine + non-archived, newest first', async () => {
    const { PgUnifiedStoreReader } = await import('../PgUnifiedStoreReader.js');
    const reader = new PgUnifiedStoreReader({
      connectionString: 'postgres://t:t@localhost:5432/x',
    });
    await reader.getRooSyncMailbox('myia-ai-01');

    const call = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes('FROM roosync_messages')
    )!;
    expect(String(call[0])).toContain("status <> 'archived'");
    expect(String(call[0])).toContain("to_machine = $1");
    expect(String(call[0])).toContain("to_machine IN ('all', 'All')");
    expect(String(call[0])).toContain('ORDER BY created_at DESC');
    expect(call[1]).toEqual(['myia-ai-01']);
  });

  test('by-id lookup is a primary-key select', async () => {
    const { PgUnifiedStoreReader } = await import('../PgUnifiedStoreReader.js');
    const reader = new PgUnifiedStoreReader({
      connectionString: 'postgres://t:t@localhost:5432/x',
    });
    await reader.getRooSyncMessageById('msg-1');

    const call = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes('WHERE id = $1')
    )!;
    expect(String(call[0])).toContain('SELECT * FROM roosync_messages');
    expect(call[1]).toEqual(['msg-1']);
  });

  test('rows are mapped with the full-fidelity columns', async () => {
    // First Once = init()'s SELECT 1 probe (same mockQuery via the client).
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'm1',
        thread_id: null,
        from_machine: 'a',
        from_workspace: '',
        to_machine: 'all',
        to_workspace: '',
        subject: 's',
        body: 'b',
        priority: 'LOW',
        status: 'unread',
        tags: [],
        attachment_refs: [],
        created_at: new Date('2026-08-18T10:00:00Z'),
        reply_to: null,
        read_by: ['x'],
        options: { auto_destruct: true },
        destroyed_at: null,
        destroyed_reason: null,
        reminder_sent_at: null,
      }],
    });
    const { PgUnifiedStoreReader } = await import('../PgUnifiedStoreReader.js');
    const reader = new PgUnifiedStoreReader({
      connectionString: 'postgres://t:t@localhost:5432/x',
    });
    const row = await reader.getRooSyncMessageById('m1');
    expect(row).toMatchObject({
      id: 'm1',
      created_at: '2026-08-18T10:00:00.000Z',
      read_by: ['x'],
      options: { auto_destruct: true },
    });
  });
});
