/**
 * Tests for the RooSync channel dual-write (#3151 Phase A).
 *
 * Covers the spec acceptance points:
 *   - mapping parity GDrive Message ↔ PG row (same fields)
 *   - idempotence: INSERT ... ON CONFLICT (id) DO NOTHING at the SQL level
 *   - sendMessage dual-writes; PG failure never blocks the GDrive path
 *   - send with attachment: payload bytea + attachment_refs refresh
 *   - amend propagates the new body under the same id
 *   - env-gate off → Null writer (zero PG calls)
 *
 * The writer factory is mocked so no Postgres is needed; SQL shape is asserted
 * against the captured query text.
 *
 * @module services/unified-store/__tests__/roosync-channel-dual-write
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Message } from '../../MessageManager.js';
import { mapMessageToRow } from '../roosync-channel-dual-write.js';

// ─── Mock pg at file level (vi.mock is hoisted — describe-scoped vars are TDZ) ──

const mockQuery = vi.fn();
const mockConnect = vi.fn();
const mockClient = { query: mockQuery, release: vi.fn() };
const mockPool = { connect: mockConnect, query: vi.fn(), end: vi.fn() };

vi.mock('pg', () => ({ default: { Pool: vi.fn(() => mockPool) } }));

// ─── Mock the writer factory (controls every PG interaction) ──────────

const insertRooSyncMessage = vi.fn().mockResolvedValue(undefined);
const updateRooSyncMessage = vi.fn().mockResolvedValue(undefined);
const insertRooSyncAttachment = vi.fn().mockResolvedValue(undefined);

vi.mock('../writer-factory.js', () => ({
  getUnifiedStoreWriter: () => ({
    insertRooSyncMessage,
    updateRooSyncMessage,
    insertRooSyncAttachment,
  }),
  resetWriterInstance: vi.fn(),
}));

// Import MessageManager AFTER the factory mock is registered.
import { MessageManager } from '../../MessageManager.js';
import { AttachmentManager } from '../../roosync/AttachmentManager.js';
import { PgUnifiedStoreWriter } from '../PgUnifiedStoreWriter.js';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.unmock('fs');
vi.unmock('fs/promises');

// ─── Helpers ─────────────────────────────────────────────────────────

function sampleMessage(overrides?: Partial<Message>): Message {
  return {
    id: 'msg-20260817T120000-abcdef',
    from: 'myia-po-2023:roo-extensions',
    to: 'myia-ai-01:roo-extensions',
    subject: '[TASK] test',
    body: 'Contenu de test',
    priority: 'HIGH',
    timestamp: '2026-08-17T12:00:00.000Z',
    status: 'unread',
    tags: ['TASK', 'claude-interactive'],
    thread_id: 'thread-1',
    reply_to: 'msg-20260816T000000-aaaaaa',
    ...overrides,
  };
}

describe('roosync-channel-dual-write (mapping parity)', () => {
  test('maps every Message field to the PG row (from/to split machine:workspace)', () => {
    const row = mapMessageToRow(sampleMessage());
    expect(row).toEqual({
      id: 'msg-20260817T120000-abcdef',
      thread_id: 'thread-1',
      from_machine: 'myia-po-2023',
      from_workspace: 'roo-extensions',
      to_machine: 'myia-ai-01',
      to_workspace: 'roo-extensions',
      subject: '[TASK] test',
      body: 'Contenu de test',
      priority: 'HIGH',
      status: 'unread',
      tags: ['TASK', 'claude-interactive'],
      attachment_refs: [],
      created_at: '2026-08-17T12:00:00.000Z',
    });
  });

  test('bare machine id (no workspace) maps to empty workspace, not undefined', () => {
    const row = mapMessageToRow(sampleMessage({ from: 'myia-po-2023', to: 'myia-ai-01' }));
    expect(row.from_workspace).toBe('');
    expect(row.to_workspace).toBe('');
  });

  test('attachments map to attachment_refs; undefined tags map to []', () => {
    const msg = sampleMessage({
      attachments: [{ uuid: 'u1', filename: 'a.txt', sizeBytes: 3 }],
    });
    delete (msg as Partial<Message>).tags;
    const row = mapMessageToRow(msg);
    expect(row.attachment_refs).toEqual([{ uuid: 'u1', filename: 'a.txt', sizeBytes: 3 }]);
    expect(row.tags).toEqual([]);
  });
});

describe('PgUnifiedStoreWriter SQL shape (idempotence)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(mockClient);
    mockQuery.mockResolvedValue({ rowCount: 1 });
  });

  // init() self-connects with a 'SELECT 1' probe — find OUR call, not the probe.
  function targetCall(fragment: string): [string, unknown[]] {
    const call = mockQuery.mock.calls.find((c) => String(c[0]).includes(fragment));
    if (!call) throw new Error(`no query containing "${fragment}"`);
    return call as [string, unknown[]];
  }

  test('insertRooSyncMessage emits ON CONFLICT (id) DO NOTHING — idempotent', async () => {
    const writer = new PgUnifiedStoreWriter({
      connectionString: 'postgres://t:t@localhost:5432/x',
    });
    await writer.insertRooSyncMessage(mapMessageToRow(sampleMessage()));

    const [sql, params] = targetCall('INSERT INTO roosync_messages');
    expect(sql).toContain('ON CONFLICT (id) DO NOTHING');
    // jsonb params must be pre-stringified
    expect((params as unknown[])[10]).toBe('["TASK","claude-interactive"]');
    expect((params as unknown[])[11]).toBe('[]');
  });

  test('insertRooSyncAttachment emits bytea payload with ON CONFLICT DO NOTHING', async () => {
    const writer = new PgUnifiedStoreWriter({
      connectionString: 'postgres://t:t@localhost:5432/x',
    });
    await writer.insertRooSyncAttachment({
      id: 'u1',
      filename: 'a.txt',
      mime: 'text/plain',
      size: 4,
      sha256: 'deadbeef',
      payload: Buffer.from('test'),
    });

    const [sql, params] = targetCall('INSERT INTO roosync_attachments');
    expect(sql).toContain('ON CONFLICT (id) DO NOTHING');
    expect(Buffer.isBuffer((params as unknown[])[5])).toBe(true);
  });

  test('updateRooSyncMessage builds a dynamic SET from provided fields only', async () => {
    const writer = new PgUnifiedStoreWriter({
      connectionString: 'postgres://t:t@localhost:5432/x',
    });
    await writer.updateRooSyncMessage('msg-1', { body: 'new' });

    const [sql, params] = targetCall('UPDATE roosync_messages');
    expect(sql).toContain('body = $1');
    expect(sql).toContain("WHERE id = $2");
    expect(params).toEqual(['new', 'msg-1']);
  });

  test('updateRooSyncMessage with no fields issues no query', async () => {
    const writer = new PgUnifiedStoreWriter({
      connectionString: 'postgres://t:t@localhost:5432/x',
    });
    await writer.updateRooSyncMessage('msg-1', {});
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('MessageManager hooks (GDrive never blocked by PG)', () => {
  let messageManager: MessageManager;
  let testPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    testPath = join(tmpdir(), `rsm-dw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    for (const d of ['messages/inbox', 'messages/sent', 'messages/archive']) {
      mkdirSync(join(testPath, d), { recursive: true });
    }
    messageManager = new MessageManager(testPath);
  });

  afterEach(() => {
    if (existsSync(testPath)) rmSync(testPath, { recursive: true, force: true });
  });

  test('sendMessage dual-writes the mapped row to PG', async () => {
    const msg = await messageManager.sendMessage(
      'myia-po-2023:roo-extensions',
      'myia-ai-01:roo-extensions',
      'Sujet',
      'Corps',
      'HIGH'
    );

    // GDrive path completed (files written)
    expect(existsSync(join(testPath, 'messages/inbox', `${msg.id}.json`))).toBe(true);
    expect(existsSync(join(testPath, 'messages/sent', `${msg.id}.json`))).toBe(true);

    // PG dual-write fired with the same content
    await vi.waitFor(() => expect(insertRooSyncMessage).toHaveBeenCalledTimes(1));
    const row = insertRooSyncMessage.mock.calls[0][0];
    expect(row.id).toBe(msg.id);
    expect(row.subject).toBe('Sujet');
    expect(row.body).toBe('Corps');
    expect(row.from_machine).toBe('myia-po-2023');
    expect(row.to_machine).toBe('myia-ai-01');
  });

  test('PG failure never blocks sendMessage — GDrive files still written', async () => {
    insertRooSyncMessage.mockRejectedValueOnce(new Error('PG down'));

    const msg = await messageManager.sendMessage(
      'myia-po-2023:roo-extensions',
      'myia-ai-01:roo-extensions',
      'Sujet',
      'Corps'
    );

    expect(existsSync(join(testPath, 'messages/inbox', `${msg.id}.json`))).toBe(true);
    expect(existsSync(join(testPath, 'messages/sent', `${msg.id}.json`))).toBe(true);
  });

  test('amendMessage propagates the new body to PG under the same id', async () => {
    const msg = await messageManager.sendMessage(
      'myia-po-2023:roo-extensions',
      'myia-ai-01:roo-extensions',
      'Sujet',
      'Ancien corps'
    );

    await messageManager.amendMessage(msg.id, 'myia-po-2023:roo-extensions', 'Nouveau corps', 'typo');

    await vi.waitFor(() =>
      expect(updateRooSyncMessage).toHaveBeenCalledWith(msg.id, { body: 'Nouveau corps' })
    );
  });

  test('updateMessageAttachments refreshes attachment_refs on PG', async () => {
    const msg = await messageManager.sendMessage(
      'myia-po-2023:roo-extensions',
      'myia-ai-01:roo-extensions',
      'Sujet',
      'Corps'
    );

    await messageManager.updateMessageAttachments(msg.id, [
      { uuid: 'u1', filename: 'a.txt', sizeBytes: 3 },
    ]);

    await vi.waitFor(() =>
      expect(updateRooSyncMessage).toHaveBeenCalledWith(msg.id, {
        attachment_refs: [{ uuid: 'u1', filename: 'a.txt', sizeBytes: 3 }],
      })
    );
  });

  test('AttachmentManager.uploadAttachment ships the payload bytea to PG', async () => {
    const am = new AttachmentManager(testPath);
    const src = join(testPath, 'source.txt');
    writeFileSync(src, 'hello');

    const ref = await am.uploadAttachment(src, 'myia-po-2023', 'source.txt', 'msg-1');

    expect(ref.uuid).toBeDefined();
    await vi.waitFor(() => expect(insertRooSyncAttachment).toHaveBeenCalledTimes(1));
    const row = insertRooSyncAttachment.mock.calls[0][0];
    expect(row.filename).toBe('source.txt');
    expect(row.payload.toString()).toBe('hello');
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.size).toBe(5);
  });
});

describe('env-gate (flag off → Null writer)', () => {
  test('NullUnifiedStoreWriter RooSync methods are no-ops', async () => {
    // Direct instantiation keeps the test independent of process.env at import time.
    const { NullUnifiedStoreWriter } = await import('../UnifiedStoreWriter.js');
    const nullWriter = new NullUnifiedStoreWriter();
    await expect(
      nullWriter.insertRooSyncMessage(mapMessageToRow(sampleMessage()))
    ).resolves.toBeUndefined();
    await expect(
      nullWriter.updateRooSyncMessage('id', { body: 'x' })
    ).resolves.toBeUndefined();
    await expect(
      nullWriter.insertRooSyncAttachment({
        id: 'u',
        filename: 'f',
        mime: null,
        size: 0,
        sha256: null,
        payload: Buffer.alloc(0),
      })
    ).resolves.toBeUndefined();
  });
});
