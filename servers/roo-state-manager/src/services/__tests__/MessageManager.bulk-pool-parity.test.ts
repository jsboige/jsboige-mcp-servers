/**
 * #4285 — inbox and bulk_* must resolve the SAME message pool.
 *
 * Measured on ai-01 (20/10): `inbox` listed 15 unread ghosts (URGENT from
 * February…) that `bulk_mark_read(before_date: 2026-10-03)` matched **0** of.
 * Root cause: on CHANNEL_READ_PG seats the inbox serves PG
 * (`readInbox`/`getFilteredCount` are PG-primary), where the whole history
 * lives — while `bulkOperation` enumerated only the GDrive cache, whose pool
 * (`messages/inbox/`) no longer holds those rows (rotated out, or PG-primary
 * sends that never filed). Two enumerations, two different sets: an unread
 * the badge counts forever and no bulk can ever clear.
 *
 * These tests pin the contract the issue states: same source (PG when the
 * reader is up, GDrive when it is not), same recipient filter
 * (machine:workspace), and the bulk predicates running over whichever pool
 * was enumerated.
 *
 * The in-memory reader stub mirrors PgUnifiedStoreReader.getRooSyncMailbox
 * semantics (rows for this machine + 'all' broadcasts, archived/destroyed
 * excluded). The update stub applies RooSyncMessageUpdate to the row so a
 * subsequent read sees the transition — modelling the real SQL update.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Shared mutable PG state (hoisted: vi.mock factories run before imports) ──
const pg = vi.hoisted(() => {
  const state = {
    /** 'up' = reader serves rows · 'throw' = reader up but mailbox read fails · 'off' = no reader */
    mode: 'up' as 'up' | 'throw' | 'off',
    /** isChannelPgPrimary() — gates the PG-primary mutation paths */
    pgPrimary: true,
    rows: [] as Array<Record<string, unknown>>,
    updateCalls: [] as Array<{ id: string; fields: Record<string, unknown> }>,
  };
  const reader = {
    isNull: () => false,
    // Parity with PgUnifiedStoreReader.getRooSyncMailbox: this machine's rows
    // plus broadcasts, archived/destroyed excluded by construction of seeds.
    getRooSyncMailbox: async (machineId: string) => {
      if (state.mode === 'throw') throw new Error('pg mailbox read failed (test)');
      return state.rows.filter(
        (r) => r.to_machine === machineId || r.to_machine === 'all' || r.to_machine === 'All'
      );
    },
    getRooSyncMessageById: async (id: string) =>
      state.rows.find((r) => r.id === id) ?? null,
  };
  return { state, reader };
});

vi.mock('../unified-store/roosync-channel-read.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getChannelPgReader: () => (pg.state.mode === 'off' ? null : pg.reader),
  };
});

vi.mock('../unified-store/roosync-channel-write.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isChannelPgPrimary: () => pg.state.pgPrimary,
    // Apply the update to the in-memory row (the real one UPDATEs the table),
    // so a subsequent PG read sees the transition.
    updateRooSyncMessagePrimary: async (id: string, fields: Record<string, unknown>) => {
      pg.state.updateCalls.push({ id, fields });
      const row = pg.state.rows.find((r) => r.id === id);
      if (!row) return false;
      for (const key of ['status', 'read_by', 'read_by_workspace', 'options', 'archived_at', 'read_at']) {
        if (key in fields) (row as Record<string, unknown>)[key] = (fields as Record<string, unknown>)[key];
      }
      return true;
    },
  };
});

// Import after mocks
import { MessageManager } from '../MessageManager.js';
import type { RooSyncMessageRow } from '../unified-store/types.js';

const MACHINE = 'myia-ai-01';
const WS = 'roo-extensions';

function makeTempSharedState(): string {
  const dir = join(tmpdir(), `mm-bulk-parity-${randomUUID()}`);
  for (const sub of ['messages', 'messages/inbox', 'messages/sent', 'messages/archive']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return dir;
}

function row(overrides: Partial<RooSyncMessageRow> & { id: string }): RooSyncMessageRow {
  return {
    thread_id: null,
    from_machine: 'myia-po-2023',
    from_workspace: 'CoursIA-2',
    to_machine: MACHINE,
    to_workspace: WS,
    subject: `subject-${overrides.id}`,
    body: `body-${overrides.id}`,
    priority: 'MEDIUM',
    status: 'unread',
    tags: [],
    attachment_refs: [],
    created_at: '2026-02-06T09:00:00.000Z',
    reply_to: null,
    read_by: [],
    read_by_workspace: [],
    options: {},
    ...overrides,
  } as RooSyncMessageRow;
}

function seedFile(sharedState: string, msg: Record<string, unknown>): void {
  writeFileSync(
    join(sharedState, 'messages', 'inbox', `${msg.id}.json`),
    JSON.stringify(msg),
    'utf-8'
  );
}

function onDisk(sharedState: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(sharedState, 'messages', 'inbox', `${id}.json`), 'utf-8'));
}

describe('MessageManager.bulkOperation — pool parity with the inbox (#4285)', () => {
  let shared: string;

  beforeEach(() => {
    shared = makeTempSharedState();
    pg.state.mode = 'up';
    pg.state.pgPrimary = true;
    pg.state.rows = [];
    pg.state.updateCalls = [];
  });

  afterEach(() => {
    rmSync(shared, { recursive: true, force: true });
  });

  test('inbox lists the PG ghost (the message bulk must be able to reach)', async () => {
    pg.state.rows = [row({ id: 'msg-20260206T090000-ghost1', priority: 'URGENT' })];

    const mm = new MessageManager(shared, 5000);
    const unread = await mm.readInbox(MACHINE, 'unread', undefined, WS);
    expect(unread.map((m) => m.id)).toContain('msg-20260206T090000-ghost1');
  });

  test('bulk_mark_read finds and clears the PG ghost the inbox listed (the ai-01 measurement)', async () => {
    // The ghost: February URGENT, PG-only — messages/inbox/ is empty, exactly
    // the state measured on ai-01 where the badge showed 15 unreads and
    // bulk_mark_read(before_date) matched 0.
    pg.state.rows = [row({ id: 'msg-20260206T090000-ghost1', priority: 'URGENT' })];

    const mm = new MessageManager(shared, 5000);
    const result = await mm.bulkOperation(
      MACHINE, 'mark_read',
      { before_date: '2026-10-03T00:00:00Z', status: 'unread' },
      WS
    );

    expect(result.matched).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);

    // The write landed in the store the enumeration served: the badge clears.
    expect(await mm.getFilteredCount(MACHINE, 'all', WS)).toEqual({ total: 1, unread: 0, read: 1 });
  });

  test('bulk predicates run over the PG pool (AND logic, recipient, tag)', async () => {
    pg.state.rows = [
      row({ id: 'a-old-urgent-tagged', priority: 'URGENT', tags: ['ops'] }),
      row({ id: 'b-old-medium', priority: 'MEDIUM' }),
      row({ id: 'c-old-urgent-other-machine', priority: 'URGENT', to_machine: 'myia-po-2025', to_workspace: WS }),
      row({ id: 'd-recent-urgent-tagged', priority: 'URGENT', tags: ['ops'], created_at: '2026-10-18T09:00:00.000Z' }),
    ];

    const mm = new MessageManager(shared, 5000);
    const result = await mm.bulkOperation(
      MACHINE, 'mark_read',
      { priority: 'URGENT', before_date: '2026-10-01T00:00:00Z', tag: 'ops', status: 'unread' },
      WS
    );

    expect(result.matched).toBe(1);
    expect(result.message_ids).toEqual(['a-old-urgent-tagged']);
  });

  test('bulk_archive reaches the PG pool and archives the row', async () => {
    pg.state.rows = [row({ id: 'msg-20260312T101500-arch1' })];

    const mm = new MessageManager(shared, 5000);
    const result = await mm.bulkOperation(
      MACHINE, 'archive',
      { before_date: '2026-10-03T00:00:00Z' },
      WS
    );

    expect(result.matched).toBe(1);
    expect(result.processed).toBe(1);
    const updated = pg.state.rows.find((r) => r.id === 'msg-20260312T101500-arch1');
    expect(updated?.status).toBe('archived');
    const call = pg.state.updateCalls.find((c) => c.id === 'msg-20260312T101500-arch1');
    expect(call?.fields).toMatchObject({ status: 'archived' });
    expect(call?.fields).toHaveProperty('archived_at');
  });

  test('PG off → GDrive fallback unchanged (file-pool messages still bulk-mark)', async () => {
    pg.state.mode = 'off';
    seedFile(shared, {
      id: 'file-1', from: 'myia-po-2023:roo-extensions', to: `${MACHINE}:${WS}`,
      subject: 'file message', body: 'b', priority: 'MEDIUM',
      timestamp: '2026-01-05T08:00:00.000Z', status: 'unread',
    });

    const mm = new MessageManager(shared, 5000);
    const result = await mm.bulkOperation(
      MACHINE, 'mark_read',
      { before_date: '2026-10-03T00:00:00Z', status: 'unread' },
      WS
    );

    expect(result.matched).toBe(1);
    expect(result.processed).toBe(1);
    expect(onDisk(shared, 'file-1').status).toBe('read');
  });

  test('PG enumeration failure → graceful GDrive fallback (same degradation as readInbox)', async () => {
    pg.state.mode = 'throw';
    seedFile(shared, {
      id: 'file-2', from: 'myia-po-2023:roo-extensions', to: `${MACHINE}:${WS}`,
      subject: 'file message 2', body: 'b', priority: 'MEDIUM',
      timestamp: '2026-01-05T08:00:00.000Z', status: 'unread',
    });

    const mm = new MessageManager(shared, 5000);
    const result = await mm.bulkOperation(
      MACHINE, 'mark_read',
      { before_date: '2026-10-03T00:00:00Z', status: 'unread' },
      WS
    );

    expect(result.matched).toBe(1);
    expect(result.processed).toBe(1);
  });
});
