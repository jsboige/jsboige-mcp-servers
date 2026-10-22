/**
 * B13 (#4131) — a DUAL_WRITE seat without PG_PRIMARY (a READ_PG host) must
 * still mutate PG-only rows.
 *
 * Measured on ai-01 (22/10 ~23:05Z): a DM written under PG-primary has no
 * GDrive file. On a host that reads PG but does not hold the PG-primary
 * write gate, markAsRead/archiveMessage/destroyMessage skipped their PG
 * branch entirely (gated on isChannelPgPrimary() alone), fell through to the
 * file path and answered "not found" — 2/2 mark_read failures, and the same
 * shape re-failed on every sweep retry.
 *
 * The contract this suite pins:
 *   1. READ_PG + DUAL_WRITE, no PG_PRIMARY, row present in PG, file absent →
 *      markAsRead, archiveMessage and destroyMessage commit the row mutation;
 *   2. the file path stays authoritative when the file exists (same env).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const MACHINE = 'myia-po-2024';
const WORKSPACE = 'roo-extensions';

const mocks = vi.hoisted(() => ({
  /** Whether the PG channel reader exists (the READ_PG gate). */
  pgActive: true,
  /** Rows the doubled PG read surface returns. */
  rows: [] as Array<Record<string, unknown>>,
  /** PG row updates requested by the mutations. */
  updates: [] as Array<{ id: string; fields: Record<string, unknown> }>,
  /** PG row destroys requested by the mutations. */
  destroys: [] as Array<{ id: string; reason: string }>,
  sharedPath: '',
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// PG channel read surface. `mapRowToMessage` stays real; only the reader gate
// and the transport are doubled.
vi.mock('../unified-store/roosync-channel-read.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getChannelPgReader: () => (mocks.pgActive ? { stub: true } : null),
    getChannelMessageFromPg: async (_reader: unknown, id: string) => {
      const row = mocks.rows.find((r) => r.id === id);
      return row ? (actual.mapRowToMessage as (r: Record<string, unknown>) => unknown)(row) : null;
    },
  };
});

// Record the row mutations instead of opening a PG connection.
vi.mock('../unified-store/roosync-channel-write.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    updateRooSyncMessagePrimary: async (id: string, fields: Record<string, unknown>) => {
      mocks.updates.push({ id, fields });
      return true;
    },
    destroyRooSyncMessageInStore: async (id: string, reason: string) => {
      mocks.destroys.push({ id, reason });
      return true;
    },
  };
});

// Keep the file-path test off the real PG transport.
vi.mock('../unified-store/roosync-channel-dual-write.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dualWriteRooSyncMessageRead: async () => true,
  };
});

import { MessageManager } from '../MessageManager.js';

/** One PG row with the columns `mapRowToMessage` reads. */
function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'msg-b13-row',
    from_machine: 'myia-ai-01',
    from_workspace: null,
    to_machine: MACHINE,
    to_workspace: WORKSPACE,
    subject: 'PG-only DM',
    body: 'body',
    priority: 'MEDIUM',
    status: 'unread',
    created_at: new Date().toISOString(),
    thread_id: null,
    reply_to: null,
    read_by: [],
    read_by_workspace: [],
    tags: [],
    attachment_refs: [],
    options: {},
    reminder_sent_at: null,
    destroyed_at: null,
    destroyed_reason: null,
    ...overrides,
  };
}

let previousEnv: Record<string, string | undefined>;
let manager: MessageManager;

describe('B13 — PG-only row mutations on a READ_PG + DUAL_WRITE host', () => {
  beforeEach(() => {
    mocks.pgActive = true;
    mocks.rows = [row({})];
    mocks.updates = [];
    mocks.destroys = [];
    mocks.sharedPath = mkdtempSync(join(tmpdir(), 'rsm-b13-'));
    for (const dir of ['inbox', 'sent', 'archive']) {
      mkdirSync(join(mocks.sharedPath, 'messages', dir), { recursive: true });
    }

    previousEnv = {
      ROOSYNC_MACHINE_ID: process.env.ROOSYNC_MACHINE_ID,
      ROOSYNC_WORKSPACE_ID: process.env.ROOSYNC_WORKSPACE_ID,
      UNIFIED_STORE_CHANNEL_READ_PG: process.env.UNIFIED_STORE_CHANNEL_READ_PG,
      UNIFIED_STORE_CHANNEL_PG_PRIMARY: process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY,
      UNIFIED_STORE_DUAL_WRITE: process.env.UNIFIED_STORE_DUAL_WRITE,
      UNIFIED_STORE_PG_URL: process.env.UNIFIED_STORE_PG_URL,
    };
    process.env.ROOSYNC_MACHINE_ID = MACHINE;
    process.env.ROOSYNC_WORKSPACE_ID = WORKSPACE;
    process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
    delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://unit-test.invalid:5432/rsm';

    manager = new MessageManager(mocks.sharedPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(mocks.sharedPath, { recursive: true, force: true });
  });

  test('markAsRead commits the row update (no GDrive file exists)', async () => {
    expect(process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY).toBeUndefined();

    const ok = await manager.markAsRead('msg-b13-row');

    expect(ok).toBe(true);
    expect(mocks.updates).toHaveLength(1);
    expect(mocks.updates[0].id).toBe('msg-b13-row');
    expect(mocks.updates[0].fields.status).toBe('read');
  });

  test('archiveMessage commits the row update (no GDrive file exists)', async () => {
    const ok = await manager.archiveMessage('msg-b13-row');

    expect(ok).toBe(true);
    expect(mocks.updates).toHaveLength(1);
    expect(mocks.updates[0].id).toBe('msg-b13-row');
    expect(mocks.updates[0].fields.status).toBe('archived');
  });

  test('destroyMessage commits the row destroy (no GDrive file exists)', async () => {
    const ok = await manager.destroyMessage('msg-b13-row', 'ttl_expired');

    expect(ok).toBe(true);
    expect(mocks.destroys).toEqual([{ id: 'msg-b13-row', reason: 'ttl_expired' }]);
  });

  test('the file path stays authoritative when the file exists', async () => {
    writeFileSync(
      join(mocks.sharedPath, 'messages', 'inbox', 'msg-b13-row.json'),
      JSON.stringify({
        id: 'msg-b13-row',
        from: 'myia-ai-01',
        to: MACHINE,
        subject: 'file-backed message',
        body: 'body',
        priority: 'MEDIUM',
        status: 'unread',
        created_at: new Date().toISOString(),
        read_by: [],
        read_by_workspace: [],
        tags: [],
        attachment_refs: [],
        options: {},
      }),
      'utf-8'
    );

    const ok = await manager.markAsRead('msg-b13-row');

    expect(ok).toBe(true);
    // Writable is true, yet the existing file keeps the file path in charge.
    expect(mocks.updates).toEqual([]);
  });
});