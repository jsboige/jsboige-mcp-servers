/**
 * #4301 — on a CHANNEL_READ_PG host, the pre-listing sweeps select their
 * candidates from PG rows instead of rebuilding the GDrive inbox cache.
 *
 * Measured on ai-01 (20/10, build `ca2da038`): the channel was served by PG
 * (799 inbox reads) while `roosync_read` still called `autoArchiveOld(7, true)`
 * before every listing → `ensureInboxCache` → GDrive only. Over 11 h 45 that
 * was 39 passes, 38 cache rebuilds (~4 400 files each) and 511 read errors.
 *
 * The contract this suite pins:
 *   1. `roosync_read mode=inbox` on a READ_PG host never touches
 *      `ensureInboxCache` / `rebuildInboxCache`, and archives messages older
 *      than the 7-day horizon as PG row updates (`status` + `archived_at`);
 *   2. the 30-day sweep (the auto-archive daemon's call) does the same, with
 *      the unread horizon still spared;
 *   3. a host without the PG channel reader keeps the historical GDrive-cache
 *      sweep unchanged (non-regression).
 *
 * On `main` this suite is red: the sweep goes straight to `ensureInboxCache`
 * and no PG row is ever archived.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const DAY_MS = 24 * 60 * 60 * 1000;
const MACHINE = 'myia-po-2024';
const WORKSPACE = 'roo-extensions';

const mocks = vi.hoisted(() => ({
  /** Whether the PG channel reader exists (the READ_PG gate). */
  pgActive: true,
  /** Rows the doubled PG mailbox returns. */
  rows: [] as Array<Record<string, unknown>>,
  /** G: cache instrumentation — the two calls the fix must remove. */
  ensureCalls: 0,
  rebuildCalls: 0,
  /** PG row updates requested by the sweeps. */
  updates: [] as Array<{ id: string; fields: Record<string, unknown> }>,
  /** Holder bound to the real MessageManager instance (tool path mock). */
  keeper: { manager: null as unknown, sharedPath: '' },
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// PG channel read surface. `mapRowToMessage`/`filterMailboxRows` stay real;
// only the reader gate and the transport are doubled.
vi.mock('../unified-store/roosync-channel-read.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getChannelPgReader: () => (mocks.pgActive ? { stub: true } : null),
    readChannelSweepRowsFromPg: async () => mocks.rows,
    // #1474 pool read (reconciled cleanup/reminders on a writable PG host):
    // without it the mock module lets the REAL reader run and the test would
    // measure a network failure instead of the pre-listing design.
    readWholeChannelFromPg: async () =>
      mocks.rows.map((r) => (actual.mapRowToMessage as (row: Record<string, unknown>) => unknown)(r)),
    readChannelInboxFromPg: async () => [],
    countChannelInboxFromPg: async () => ({ total: 0, unread: 0, read: 0 }),
    getChannelMessageFromPg: async () => null,
  };
});

// Record the archive transition instead of opening a PG connection.
vi.mock('../unified-store/roosync-channel-write.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    updateRooSyncMessagePrimary: async (id: string, fields: Record<string, unknown>) => {
      mocks.updates.push({ id, fields });
      return true;
    },
  };
});

// The tool resolves the manager through the module singleton — hand it the
// real instance the test created (the class itself stays the real one).
vi.mock('../MessageManager.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getMessageManager: () => mocks.keeper.manager,
  };
});

vi.mock('../../utils/shared-state-path.js', () => ({
  getSharedStatePath: () => mocks.keeper.sharedPath,
  assertSharedStoreAccessible: () => undefined,
}));

vi.mock('../../services/lazy-roosync.js', () => ({
  getRooSyncService: async () => ({
    getHeartbeatService: () => ({ registerHeartbeat: async () => undefined }),
  }),
}));

vi.mock('../../tools/roosync/heartbeat-activity.js', () => ({
  recordRooSyncActivityAsync: () => undefined,
}));

import { MessageManager } from '../MessageManager.js';
import { roosyncRead } from '../../tools/roosync/read.js';

/** One PG row with the columns `mapRowToMessage` reads. */
function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `msg-test-${Math.random().toString(16).slice(2, 10)}`,
    from_machine: 'myia-ai-01',
    from_workspace: null,
    to_machine: MACHINE,
    to_workspace: WORKSPACE,
    subject: 'test',
    body: 'body',
    priority: 'MEDIUM',
    status: 'read',
    created_at: new Date(Date.now() - 8 * DAY_MS).toISOString(),
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

describe('#4301 — pre-listing sweeps on a CHANNEL_READ_PG host', () => {
  beforeEach(() => {
    mocks.pgActive = true;
    mocks.rows = [];
    mocks.ensureCalls = 0;
    mocks.rebuildCalls = 0;
    mocks.updates = [];
    mocks.keeper.sharedPath = mkdtempSync(join(tmpdir(), 'rsm-4301-'));

    previousEnv = {
      ROOSYNC_MACHINE_ID: process.env.ROOSYNC_MACHINE_ID,
      ROOSYNC_WORKSPACE_ID: process.env.ROOSYNC_WORKSPACE_ID,
      UNIFIED_STORE_CHANNEL_READ_PG: process.env.UNIFIED_STORE_CHANNEL_READ_PG,
      UNIFIED_STORE_DUAL_WRITE: process.env.UNIFIED_STORE_DUAL_WRITE,
      UNIFIED_STORE_PG_URL: process.env.UNIFIED_STORE_PG_URL,
    };
    process.env.ROOSYNC_MACHINE_ID = MACHINE;
    process.env.ROOSYNC_WORKSPACE_ID = WORKSPACE;
    process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://unit-test.invalid:5432/rsm';

    mocks.keeper.manager = new MessageManager(mocks.keeper.sharedPath as string);

    // The two G: cache entry points the fix must keep off the READ_PG path.
    vi.spyOn(MessageManager.prototype as any, 'ensureInboxCache').mockImplementation(async () => {
      mocks.ensureCalls++;
      return { items: [], full: new Map() };
    });
    vi.spyOn(MessageManager.prototype as any, 'rebuildInboxCache').mockImplementation(async () => {
      mocks.rebuildCalls++;
      return { items: [], full: new Map() };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(mocks.keeper.sharedPath as string, { recursive: true, force: true });
  });

  test('roosync_read mode=inbox: no G: cache, 7-day rows archived as PG updates', async () => {
    const oldRead = row({ status: 'read', created_at: new Date(Date.now() - 8 * DAY_MS).toISOString() });
    const recent = row({ status: 'read', created_at: new Date(Date.now() - 2 * DAY_MS).toISOString() });
    const oldUnread = row({ status: 'unread', created_at: new Date(Date.now() - 8 * DAY_MS).toISOString() });
    mocks.rows = [oldRead, recent, oldUnread];

    await roosyncRead({ mode: 'inbox' });

    expect(mocks.ensureCalls).toBe(0);
    expect(mocks.rebuildCalls).toBe(0);

    const archivedIds = mocks.updates
      .filter((u) => u.fields.status === 'archived')
      .map((u) => u.id);
    // Read beyond 7 days → archived. Recent, and unread within its own horizon,
    // stay put.
    expect(archivedIds).toEqual([oldRead.id]);
    expect(mocks.updates[0].fields.archived_at).toEqual(expect.any(String));
  });

  test('30-day daemon sweep: PG rows, unread horizon still spared', async () => {
    const oldRead = row({ status: 'read', created_at: new Date(Date.now() - 31 * DAY_MS).toISOString() });
    const recent = row({ status: 'read', created_at: new Date(Date.now() - 10 * DAY_MS).toISOString() });
    const abandonedUnread = row({ status: 'unread', created_at: new Date(Date.now() - 95 * DAY_MS).toISOString() });
    const pendingUnread = row({ status: 'unread', created_at: new Date(Date.now() - 50 * DAY_MS).toISOString() });
    mocks.rows = [oldRead, recent, abandonedUnread, pendingUnread];

    // The daemon (index.ts) calls exactly this signature.
    const archived = await (mocks.keeper.manager as MessageManager).autoArchiveOld(30);

    expect(archived).toBe(2);
    expect(mocks.ensureCalls).toBe(0);
    expect(mocks.rebuildCalls).toBe(0);
    expect(mocks.updates.filter((u) => u.fields.status === 'archived').map((u) => u.id).sort())
      .toEqual([oldRead.id, abandonedUnread.id].sort());
  });

  test('host without the PG reader keeps the GDrive-cache sweep (non-regression)', async () => {
    mocks.pgActive = false;
    mocks.rows = [row({ status: 'read', created_at: new Date(Date.now() - 31 * DAY_MS).toISOString() })];

    const archived = await (mocks.keeper.manager as MessageManager).autoArchiveOld(7);

    expect(archived).toBe(0); // empty doubled cache — nothing to archive
    expect(mocks.ensureCalls).toBeGreaterThan(0);
    expect(mocks.updates).toEqual([]);
  });
});
