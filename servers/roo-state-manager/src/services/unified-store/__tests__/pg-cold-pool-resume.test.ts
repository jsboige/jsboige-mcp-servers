/**
 * Bounded resume for cold PG pools (#4303, #4291 lever 3).
 *
 * Measured on ai-01 (proxy.log, 20/10): every PG failure in the wake of the
 * 11:13Z restart — 2 inbox replis + 3 dashboard replis between 11:15:22Z and
 * 11:16:36Z, 82 dashboard + 8 channel over the full log — was a single
 * `Connection terminated due to connection timeout`: the read hit the pool
 * before its first connection completed, the helper returned null, and the
 * caller reopened GDrive at the exact moment DriveFS was coldest.
 *
 * Spec (#4303): a read that fails ONCE on a connection timeout takes one
 * bounded, logged retry before falling back. Durable failure keeps today's
 * contract unchanged: null + the existing fallback warn.
 *
 * These tests are RED on main — the helpers fall back on the FIRST
 * connection timeout today.
 *
 * @module services/unified-store/__tests__/pg-cold-pool-resume.test
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  RooSyncDashboardMessageRow,
  RooSyncDashboardRow,
  RooSyncMessageRow,
} from '../types.js';

// ─── Reader factory + logger mocks (same shapes as the sibling suites) ──

const mockGetRooSyncDashboard = vi.fn().mockResolvedValue(null);

vi.mock('../reader-factory.js', () => ({
  getUnifiedStoreReader: () => ({
    isNull: () => false,
    getRooSyncDashboard: mockGetRooSyncDashboard,
  }),
  resetReaderInstance: vi.fn(),
}));

const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }));

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockLoggerWarn, error: vi.fn() }),
}));

import {
  readChannelInboxFromPg,
  countChannelInboxFromPg,
  getChannelMessageFromPg,
} from '../roosync-channel-read.js';
import { readDashboardFromPg } from '../roosync-dashboard-store.js';

// ─── Fixtures ─────────────────────────────────────────────────────────

/** The exact signature node-postgres raises when connectionTimeoutMillis fires. */
const CONNECTION_TIMEOUT = new Error('Connection terminated due to connection timeout');

function sampleMessageRow(overrides?: Partial<RooSyncMessageRow>): RooSyncMessageRow {
  return {
    id: 'msg-20260818T100000-aaaaaa',
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
    reply_to: null,
    read_by: [],
    read_by_workspace: [],
    options: {},
    ...overrides,
  };
}

function sampleDashboardRow(): RooSyncDashboardRow {
  return {
    key: 'workspace-roo-extensions',
    type: 'workspace',
    machine_id: null,
    workspace: 'roo-extensions',
    content: '# Status',
    status_json: {
      lastModified: '2026-10-20T11:00:00.000Z',
      lastModifiedBy: { machineId: 'myia-po-2025', workspace: 'roo-extensions' },
      totalMessages: 1,
    },
  };
}

function sampleJournalRow(): RooSyncDashboardMessageRow {
  return {
    id: 12,
    dashboard_key: 'workspace-roo-extensions',
    message_id: 'myia-po-2025:roo-extensions:ic-20260821T0900-a1b2',
    author_machine: 'myia-po-2025',
    author_workspace: 'roo-extensions',
    content: '[DONE] shipped',
    tags: [],
    team_stage: null,
    reply_to: null,
    acknowledged_at: null,
    archived_at: null,
    created_at: '2026-08-21T09:00:00.000Z',
  };
}

function readerDouble(overrides: Record<string, ReturnType<typeof vi.fn>>) {
  return {
    isNull: () => false,
    getRooSyncMailbox: vi.fn(),
    getRooSyncMessageById: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRooSyncDashboard.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  delete process.env.UNIFIED_STORE_DASHBOARD_READ_PG;
  delete process.env.UNIFIED_STORE_PG_URL;
});

// ─── One connection timeout heals: PG serves, no GDrive fallback ─────

describe('#4303 cold-pool resume — one connection timeout, then served by PG', () => {
  test('readChannelInboxFromPg: mailbox rejects once, then rows — non-null (PG-served), 2 attempts, resume logged', async () => {
    const mailbox = vi.fn()
      .mockRejectedValueOnce(CONNECTION_TIMEOUT)
      .mockResolvedValueOnce([sampleMessageRow()]);
    const reader = readerDouble({ getRooSyncMailbox: mailbox });

    const items = await readChannelInboxFromPg(reader as never, 'myia-ai-01');

    expect(items).not.toBeNull(); // null IS the GDrive fallback contract
    expect(items).toHaveLength(1);
    expect(mailbox).toHaveBeenCalledTimes(2);
    expect(
      mockLoggerWarn.mock.calls.some((c) => /bounded|resume|retry/i.test(String(c[0])))
    ).toBe(true);
  });

  test('countChannelInboxFromPg: rejects once, then rows — non-null counts, 2 attempts', async () => {
    const mailbox = vi.fn()
      .mockRejectedValueOnce(CONNECTION_TIMEOUT)
      .mockResolvedValueOnce([sampleMessageRow()]);
    const reader = readerDouble({ getRooSyncMailbox: mailbox });

    const counts = await countChannelInboxFromPg(reader as never, 'myia-ai-01');

    expect(counts).not.toBeNull();
    expect(counts).toEqual({ total: 1, unread: 1, read: 0 });
    expect(mailbox).toHaveBeenCalledTimes(2);
  });

  test('getChannelMessageFromPg: rejects once, then row — non-null message, 2 attempts', async () => {
    const byId = vi.fn()
      .mockRejectedValueOnce(CONNECTION_TIMEOUT)
      .mockResolvedValueOnce(sampleMessageRow());
    const reader = readerDouble({ getRooSyncMessageById: byId });

    const message = await getChannelMessageFromPg(reader as never, 'msg-20260818T100000-aaaaaa');

    expect(message).not.toBeNull();
    expect(message?.id).toBe('msg-20260818T100000-aaaaaa');
    expect(byId).toHaveBeenCalledTimes(2);
  });

  test('readDashboardFromPg: read rejects once, then row — non-null dashboard (no GDrive fallback)', async () => {
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://t:t@localhost:5432/x';
    mockGetRooSyncDashboard
      .mockRejectedValueOnce(CONNECTION_TIMEOUT)
      .mockResolvedValueOnce({ dashboard: sampleDashboardRow(), messages: [sampleJournalRow()] });

    const dashboard = await readDashboardFromPg('workspace-roo-extensions');

    expect(dashboard).not.toBeNull();
    expect(dashboard?.key).toBe('workspace-roo-extensions');
    expect(mockGetRooSyncDashboard).toHaveBeenCalledTimes(2);
    expect(
      mockLoggerWarn.mock.calls.some((c) => /bounded|resume|retry/i.test(String(c[0])))
    ).toBe(true);
  });
});

// ─── Durable failure: fallback contract unchanged, with its log ──────

describe('#4303 durable PG failure — GDrive fallback unchanged', () => {
  test('readChannelInboxFromPg: always connection timeout — null after exactly one bounded retry, fallback logged', async () => {
    const mailbox = vi.fn().mockRejectedValue(CONNECTION_TIMEOUT);
    const reader = readerDouble({ getRooSyncMailbox: mailbox });

    const items = await readChannelInboxFromPg(reader as never, 'myia-ai-01');

    expect(items).toBeNull(); // the documented fallback contract
    expect(mailbox).toHaveBeenCalledTimes(2); // initial + ONE bounded retry, no storm
    expect(
      mockLoggerWarn.mock.calls.some((c) => /fall back to GDrive/i.test(String(c[0])))
    ).toBe(true);
  });

  test('readDashboardFromPg: always connection timeout — null, fallback logged', async () => {
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://t:t@localhost:5432/x';
    mockGetRooSyncDashboard.mockRejectedValue(CONNECTION_TIMEOUT);

    const dashboard = await readDashboardFromPg('workspace-roo-extensions');

    expect(dashboard).toBeNull();
    expect(mockGetRooSyncDashboard).toHaveBeenCalledTimes(2);
    expect(
      mockLoggerWarn.mock.calls.some((c) => /fall back to GDrive/i.test(String(c[0])))
    ).toBe(true);
  });
});

// ─── Scope guard: non-timeout errors do NOT get a retry ──────────────

describe('#4303 resume scope — only connection timeouts retry', () => {
  test('other errors fall back immediately, single attempt', async () => {
    const mailbox = vi.fn().mockRejectedValueOnce(new Error('relation "roosync_messages" does not exist'));
    const reader = readerDouble({ getRooSyncMailbox: mailbox });

    const items = await readChannelInboxFromPg(reader as never, 'myia-ai-01');

    expect(items).toBeNull();
    expect(mailbox).toHaveBeenCalledTimes(1); // no retry on non-timeout errors
  });
});
