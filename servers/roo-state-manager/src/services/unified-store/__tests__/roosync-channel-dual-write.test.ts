/**
 * Tests for the RooSync channel dual-write (#3151 Phase A and A.2).
 *
 * Covers the spec acceptance points:
 *   - mapping parity GDrive Message ↔ PG row (same fields)
 *   - idempotence: INSERT ... ON CONFLICT (id) DO NOTHING at the SQL level
 *   - sendMessage dual-writes; PG failure never blocks the GDrive path
 *   - send with attachment: payload bytea + attachment_refs refresh
 *   - amend propagates the new body under the same id
 *   - env-gate off → Null writer (zero PG calls)
 *   - Phase A.2: read / archived transitions mirrored, broadcast deliberately
 *     excluded, destruction purges bytea payloads before stamping the body
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
const mockPool = { on: vi.fn(), connect: mockConnect, query: vi.fn(), end: vi.fn() };

vi.mock('pg', () => ({ default: { Pool: vi.fn(() => mockPool) } }));

// ─── Mock the writer factory (controls every PG interaction) ──────────

const insertRooSyncMessage = vi.fn().mockResolvedValue(undefined);
const updateRooSyncMessage = vi.fn().mockResolvedValue(undefined);
const insertRooSyncAttachment = vi.fn().mockResolvedValue(undefined);
const deleteRooSyncAttachment = vi.fn().mockResolvedValue(undefined);

vi.mock('../writer-factory.js', () => ({
  getUnifiedStoreWriter: () => ({
    insertRooSyncMessage,
    updateRooSyncMessage,
    insertRooSyncAttachment,
    deleteRooSyncAttachment,
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
      // #3151 Phase B — full-fidelity columns (migrations/005).
      reply_to: 'msg-20260816T000000-aaaaaa',
      read_by: [],
      options: {},
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

  // #3151 Phase A.2 — regression guard. The early-return used to be hard-coded to
  // `body`/`attachment_refs`, so a state-only update looked like a no-op and was
  // silently dropped before ever reaching SQL. Revert the guard to that shape and
  // THIS test fails while every other one still passes.
  test.each([
    ['status only', { status: 'read' as const }, 'status = $1'],
    ['archived_at only', { archived_at: '2026-08-18T00:00:00.000Z' }, 'archived_at = $1'],
    ['destroyed_reason only', { destroyed_reason: 'ttl_expired' }, 'destroyed_reason = $1'],
    ['reminder_sent_at only', { reminder_sent_at: '2026-08-18T00:00:00.000Z' }, 'reminder_sent_at = $1'],
  ])('updateRooSyncMessage writes a %s update (not swallowed by the no-op guard)',
    async (_label, fields, expectedSet) => {
      const writer = new PgUnifiedStoreWriter({
        connectionString: 'postgres://t:t@localhost:5432/x',
      });
      await writer.updateRooSyncMessage('msg-1', fields);

      const [sql] = targetCall('UPDATE roosync_messages');
      expect(sql).toContain(expectedSet);
      expect(sql).toContain('WHERE id = $2');
    });

  test('updateRooSyncMessage combines several state fields in one SET', async () => {
    const writer = new PgUnifiedStoreWriter({
      connectionString: 'postgres://t:t@localhost:5432/x',
    });
    await writer.updateRooSyncMessage('msg-1', {
      body: '[DESTROYED]',
      destroyed_at: '2026-08-18T00:00:00.000Z',
      destroyed_reason: 'ttl_expired',
    });

    const [sql, params] = targetCall('UPDATE roosync_messages');
    expect(sql).toContain('body = $1');
    expect(sql).toContain('destroyed_at = $2');
    expect(sql).toContain('destroyed_reason = $3');
    expect(params).toEqual([
      '[DESTROYED]',
      '2026-08-18T00:00:00.000Z',
      'ttl_expired',
      'msg-1',
    ]);
  });

  test('deleteRooSyncAttachment removes the bytea payload by id', async () => {
    const writer = new PgUnifiedStoreWriter({
      connectionString: 'postgres://t:t@localhost:5432/x',
    });
    await writer.deleteRooSyncAttachment('u1');

    const [sql, params] = targetCall('DELETE FROM roosync_attachments');
    expect(sql).toContain('WHERE id = $1');
    expect(params).toEqual(['u1']);
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

describe('state transitions and destruction (#3151 Phase A.2)', () => {
  let messageManager: MessageManager;
  let testPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    testPath = join(tmpdir(), `rsm-a2-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    for (const d of ['messages/inbox', 'messages/sent', 'messages/archive']) {
      mkdirSync(join(testPath, d), { recursive: true });
    }
    messageManager = new MessageManager(testPath);
  });

  afterEach(() => {
    if (existsSync(testPath)) rmSync(testPath, { recursive: true, force: true });
  });

  async function send(to = 'myia-ai-01:roo-extensions'): Promise<Message> {
    return messageManager.sendMessage(
      'myia-po-2023:roo-extensions',
      to,
      'Sujet',
      'Corps'
    );
  }

  test('markAsRead mirrors status=read with a read_at stamp', async () => {
    const msg = await send();
    await messageManager.markAsRead(msg.id, 'myia-ai-01:roo-extensions');

    await vi.waitFor(() => {
      const call = updateRooSyncMessage.mock.calls.find((c) => c[1]?.status === 'read');
      expect(call).toBeDefined();
      expect(call![0]).toBe(msg.id);
      expect(call![1].read_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  // The exclusion is deliberate, so it is asserted rather than left to reading the
  // code: a broadcast marked globally `read` in PG would vanish from the mailbox of
  // the five machines that have not read it.
  test('markAsRead on a broadcast does NOT mirror a global read status', async () => {
    const msg = await send('all');
    await messageManager.markAsRead(msg.id, 'myia-ai-01:roo-extensions');

    // Give any floating dual-write a chance to land before asserting absence.
    await new Promise((r) => setTimeout(r, 50));
    const statusCalls = updateRooSyncMessage.mock.calls.filter((c) => c[1]?.status !== undefined);
    expect(statusCalls).toEqual([]);
  });

  test('archiveMessage mirrors status=archived — the PG equivalent of leaving inbox/', async () => {
    const msg = await send();
    await messageManager.archiveMessage(msg.id);

    expect(existsSync(join(testPath, 'messages/inbox', `${msg.id}.json`))).toBe(false);
    await vi.waitFor(() => {
      const call = updateRooSyncMessage.mock.calls.find((c) => c[1]?.status === 'archived');
      expect(call).toBeDefined();
      expect(call![0]).toBe(msg.id);
      expect(call![1].archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  test('destroyMessage purges the PG attachment payloads and wipes the body', async () => {
    const msg = await send();
    await messageManager.updateMessageAttachments(msg.id, [
      { uuid: 'u1', filename: 'secret.env', sizeBytes: 12 },
      { uuid: 'u2', filename: 'key.txt', sizeBytes: 8 },
    ]);
    updateRooSyncMessage.mockClear();

    const ok = await messageManager.destroyMessage(msg.id, 'ttl_expired');
    expect(ok).toBe(true);

    await vi.waitFor(() => {
      expect(deleteRooSyncAttachment).toHaveBeenCalledWith('u1');
      expect(deleteRooSyncAttachment).toHaveBeenCalledWith('u2');
      const call = updateRooSyncMessage.mock.calls.find((c) => c[1]?.destroyed_at !== undefined);
      expect(call).toBeDefined();
      expect(call![0]).toBe(msg.id);
      expect(call![1].body).toBe('[DESTROYED]');
      expect(call![1].destroyed_reason).toBe('ttl_expired');
    });
  });

  test('payloads are purged BEFORE the body is stamped destroyed', async () => {
    const order: string[] = [];
    deleteRooSyncAttachment.mockImplementation(async () => { order.push('delete'); });
    updateRooSyncMessage.mockImplementation(async (_id: string, f: Record<string, unknown>) => {
      if (f.destroyed_at !== undefined) order.push('stamp');
    });

    const msg = await send();
    await messageManager.updateMessageAttachments(msg.id, [
      { uuid: 'u1', filename: 'secret.env', sizeBytes: 12 },
    ]);
    await messageManager.destroyMessage(msg.id, 'read_by_recipient');

    await vi.waitFor(() => expect(order).toEqual(['delete', 'stamp']));
  });

  // Third and last mutation path on a message. `cleanupExpiredMessages` needs no
  // hook of its own: it destroys through `destroyMessage`, which is covered above.
  test('sendExpiryReminders mirrors the reminder flag so a PG sweep cannot remind twice', async () => {
    const msg = await messageManager.sendMessage(
      'myia-po-2023:roo-extensions',
      'myia-ai-01:roo-extensions',
      'Secret',
      'Corps',
      'HIGH',
      undefined,
      undefined,
      undefined,
      { auto_destruct: true, destruct_after: '5m' }
    );
    updateRooSyncMessage.mockClear();

    await expect(messageManager.sendExpiryReminders()).resolves.toBe(1);

    await vi.waitFor(() => {
      const call = updateRooSyncMessage.mock.calls.find(
        (c) => c[1]?.reminder_sent_at !== undefined
      );
      expect(call).toBeDefined();
      expect(call![0]).toBe(msg.id);
      expect(call![1].reminder_sent_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  test('PG failure never blocks archive or destroy on GDrive', async () => {
    updateRooSyncMessage.mockRejectedValue(new Error('PG down'));
    deleteRooSyncAttachment.mockRejectedValue(new Error('PG down'));

    const archived = await send();
    await expect(messageManager.archiveMessage(archived.id)).resolves.toBe(true);
    expect(existsSync(join(testPath, 'messages/archive', `${archived.id}.json`))).toBe(true);

    const destroyed = await send();
    await expect(messageManager.destroyMessage(destroyed.id, 'ttl_expired')).resolves.toBe(true);
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
    await expect(nullWriter.deleteRooSyncAttachment('u')).resolves.toBeUndefined();
  });
});
