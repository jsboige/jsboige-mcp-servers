/**
 * Tests for the RooSync dashboard PG store (#3151 Phase C).
 *
 * Covers the Phase C acceptance points:
 *   - Dashboard ↔ rows mapping is full-fidelity (round-trip parity with the
 *     GDrive markdown semantics: frontmatter → status_json, intercom section
 *     → journal rows)
 *   - readDashboardFromPg: gate off → null; PG failure → null (caller falls
 *     back to the GDrive file — dégradation gracieuse); key miss → null
 *     (under-show protection, same contract as the Phase B message channel)
 *   - dualWriteDashboardSync / dualWriteDashboardDelete / backfill: never
 *     throw, correct writer calls, backfill mode flag, condensed mode flag
 *     (archived_at stamps ONLY on condensation — CRITICAL 1) and failure
 *     warns (divergence observable — CRITICAL 2)
 *   - SQL shape of the concrete PgUnifiedStoreWriter.syncRooSyncDashboard
 *     (sync vs backfill modes) and PgUnifiedStoreReader.getRooSyncDashboard
 *     (active-set filter, ordering) — asserted against captured query text
 *
 * Reader/writer factories are mocked so no Postgres is needed.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Dashboard } from '../../../tools/roosync/dashboard-schemas.js';
import type {
  RooSyncDashboardRow,
  RooSyncDashboardMessageRow,
} from '../types.js';

// ─── Reader factory mock (controllable double) ──────────────────────

const mockGetRooSyncDashboard = vi.fn().mockResolvedValue(null);

vi.mock('../reader-factory.js', () => ({
  getUnifiedStoreReader: () => ({
    isNull: () => false,
    getRooSyncDashboard: mockGetRooSyncDashboard,
  }),
  resetReaderInstance: vi.fn(),
}));

// ─── Writer factory mock (dual-write assertions) ────────────────────
// Module scope: vi.mock factories are hoisted, so referenced consts must
// live here (same pattern as roosync-channel-dual-write.test.ts).

const mockSyncRooSyncDashboard = vi.fn().mockResolvedValue(undefined);
const mockDeleteRooSyncDashboard = vi.fn().mockResolvedValue(undefined);

vi.mock('../writer-factory.js', () => ({
  getUnifiedStoreWriter: () => ({
    syncRooSyncDashboard: mockSyncRooSyncDashboard,
    deleteRooSyncDashboard: mockDeleteRooSyncDashboard,
  }),
  resetWriterInstance: vi.fn(),
}));

// ─── pg mock (SQL shape assertions on the concrete classes) ─────────

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: vi.fn() });
const mockPool = { connect: mockConnect, query: mockQuery, end: vi.fn() };

vi.mock('pg', () => ({ default: { Pool: vi.fn(() => mockPool) } }));

// ─── Logger mock (dual-write failure warns must be observable) ──────
// vi.hoisted: the store calls createLogger at module scope, so the factory
// runs at import time — before const declarations. Same lazy-call reason
// the reader/writer factories below survive hoisting without it.

const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }));

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockLoggerWarn, error: vi.fn() }),
}));

// Import AFTER the factory mocks are registered.
import {
  getDashboardPgReader,
  mapDashboardToRows,
  mapRowsToDashboard,
  readDashboardFromPg,
  dualWriteDashboardSync,
  dualWriteDashboardDelete,
  backfillDashboardToStore,
} from '../roosync-dashboard-store.js';
import { PgUnifiedStoreWriter } from '../PgUnifiedStoreWriter.js';
import { PgUnifiedStoreReader } from '../PgUnifiedStoreReader.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function sampleDashboard(overrides?: Partial<Dashboard>): Dashboard {
  return {
    type: 'workspace',
    key: 'workspace-roo-extensions',
    lastModified: '2026-08-21T10:00:00.000Z',
    lastModifiedBy: { machineId: 'myia-po-2025', workspace: 'roo-extensions' },
    status: { markdown: '# Status\n\nEverything nominal.', lastDiffCommit: 'abc123' },
    intercom: {
      messages: [
        {
          id: 'myia-po-2025:roo-extensions:ic-20260821T0900-a1b2',
          timestamp: '2026-08-21T09:00:00.000Z',
          author: { machineId: 'myia-po-2025', workspace: 'roo-extensions' },
          content: '[CLAIMED] starting work',
          teamStage: 'team-exec',
          reply_to: 'myia-ai-01:roo-extensions:ic-20260820T0800-c3d4',
          acknowledged_at: { 'myia-ai-01': '2026-08-21T09:30:00.000Z' },
        },
        {
          id: 'myia-po-2026:roo-extensions:ic-20260821T0930-e5f6',
          timestamp: '2026-08-21T09:30:00.000Z',
          author: { machineId: 'myia-po-2026', workspace: 'roo-extensions' },
          content: '[REPLY] ack',
        },
      ],
      totalMessages: 47,
      lastCondensedAt: '2026-08-20T00:00:00.000Z',
    },
    ...overrides,
  };
}

function sampleDashboardRow(): RooSyncDashboardRow {
  const { row } = mapDashboardToRows(sampleDashboard());
  return row;
}

function sampleMessageRow(overrides?: Partial<RooSyncDashboardMessageRow>): RooSyncDashboardMessageRow {
  return {
    id: 12,
    dashboard_key: 'workspace-roo-extensions',
    message_id: 'myia-po-2025:roo-extensions:ic-20260821T0900-a1b2',
    author_machine: 'myia-po-2025',
    author_workspace: 'roo-extensions',
    content: '[CLAIMED] starting work',
    tags: [],
    team_stage: 'team-exec',
    reply_to: 'myia-ai-01:roo-extensions:ic-20260820T0800-c3d4',
    acknowledged_at: { 'myia-ai-01': '2026-08-21T09:30:00.000Z' },
    archived_at: null,
    created_at: '2026-08-21T09:00:00.000Z',
    ...overrides,
  };
}

function withReadGate(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://t:t@localhost:5432/x';
    try {
      await fn();
    } finally {
      delete process.env.UNIFIED_STORE_DASHBOARD_READ_PG;
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRooSyncDashboard.mockReset().mockResolvedValue(null);
  mockSyncRooSyncDashboard.mockReset().mockResolvedValue(undefined);
  mockDeleteRooSyncDashboard.mockReset().mockResolvedValue(undefined);
  mockQuery.mockReset().mockResolvedValue({ rows: [] });
  // mockConnect closes over mockQuery — re-establish after the resets so the
  // concrete writer/reader self-init (pool.connect → SELECT 1) succeeds.
  mockConnect.mockReset().mockResolvedValue({ query: mockQuery, release: vi.fn() });
});

afterEach(() => {
  delete process.env.UNIFIED_STORE_DASHBOARD_READ_PG;
  delete process.env.UNIFIED_STORE_PG_URL;
});

// ─── Mapping parity ─────────────────────────────────────────────────

describe('Dashboard ↔ rows mapping (full-fidelity round-trip)', () => {
  test('every Dashboard field survives mapDashboardToRows → mapRowsToDashboard', () => {
    const original = sampleDashboard();
    const { row, messages } = mapDashboardToRows(original);
    const reconstructed = mapRowsToDashboard(row, messages);

    expect(reconstructed.type).toBe(original.type);
    expect(reconstructed.key).toBe(original.key);
    expect(reconstructed.lastModified).toBe(original.lastModified);
    expect(reconstructed.lastModifiedBy).toEqual(original.lastModifiedBy);
    expect(reconstructed.status.markdown).toBe(original.status.markdown);
    expect(reconstructed.status.lastDiffCommit).toBe(original.status.lastDiffCommit);
    expect(reconstructed.intercom.lastCondensedAt).toBe(original.intercom.lastCondensedAt);
    expect(reconstructed.intercom.totalMessages).toBe(original.intercom.totalMessages);
    expect(reconstructed.intercom.messages).toEqual(original.intercom.messages);
  });

  test('key split: machine / workspace / global', () => {
    const machine = mapDashboardToRows(sampleDashboard({
      type: 'machine', key: 'machine-myia-ai-01', lastModifiedBy: { machineId: 'x', workspace: 'y' },
    }));
    expect(machine.row.machine_id).toBe('myia-ai-01');
    expect(machine.row.workspace).toBeNull();

    const workspace = mapDashboardToRows(sampleDashboard());
    expect(workspace.row.workspace).toBe('roo-extensions');
    expect(workspace.row.machine_id).toBeNull();

    const global = mapDashboardToRows(sampleDashboard({
      type: 'global', key: 'global', lastModifiedBy: { machineId: 'x', workspace: 'y' },
    }));
    expect(global.row.machine_id).toBeNull();
    expect(global.row.workspace).toBeNull();
  });

  test('journal rows carry the dashboard key and message metadata', () => {
    const { row, messages } = mapDashboardToRows(sampleDashboard());
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      expect(m.dashboard_key).toBe(row.key);
      expect(m.message_id).toMatch(/^myia-po-\d+:roo-extensions:ic-/);
      expect(m.archived_at).toBeNull();
      expect(m.tags).toEqual([]);
    }
    expect(messages[0].team_stage).toBe('team-exec');
    expect(messages[0].reply_to).toBe('myia-ai-01:roo-extensions:ic-20260820T0800-c3d4');
    expect(messages[0].acknowledged_at).toEqual({ 'myia-ai-01': '2026-08-21T09:30:00.000Z' });
    expect(messages[1].team_stage).toBeNull();
    expect(messages[1].reply_to).toBeNull();
  });

  test('optional fields are omitted, not undefined-polluted (jsonb round-trip)', () => {
    const { row, messages } = mapDashboardToRows({
      type: 'global',
      key: 'global',
      lastModified: '2026-08-21T10:00:00.000Z',
      lastModifiedBy: { machineId: 'm', workspace: 'w' },
      status: { markdown: '' },
      intercom: { messages: [], totalMessages: 0 },
    });
    // JSON.stringify of status_json must not carry undefined-valued keys
    const json = JSON.parse(JSON.stringify(row.status_json));
    expect(json.lastCondensedAt).toBeUndefined();
    expect(json.totalMessages).toBe(0);
    expect(messages).toEqual([]);
  });
});

// ─── Read path ──────────────────────────────────────────────────────

describe('readDashboardFromPg', () => {
  test('gate off → null, reader untouched', async () => {
    const result = await readDashboardFromPg('workspace-roo-extensions');
    expect(result).toBeNull();
    expect(mockGetRooSyncDashboard).not.toHaveBeenCalled();
  });

  test('gate on, key miss → null (fallback to GDrive)', withReadGate(async () => {
    mockGetRooSyncDashboard.mockResolvedValueOnce(null);
    const result = await readDashboardFromPg('workspace-unknown');
    expect(result).toBeNull();
    expect(mockGetRooSyncDashboard).toHaveBeenCalledWith('workspace-unknown');
  }));

  test('gate on, PG failure → null (dégradation gracieuse)', withReadGate(async () => {
    mockGetRooSyncDashboard.mockRejectedValueOnce(new Error('connection refused'));
    const result = await readDashboardFromPg('workspace-roo-extensions');
    expect(result).toBeNull();
  }));

  test('gate on, hit → Dashboard reconstructed from active journal rows', withReadGate(async () => {
    mockGetRooSyncDashboard.mockResolvedValueOnce({
      dashboard: sampleDashboardRow(),
      messages: [sampleMessageRow()],
    });
    const result = await readDashboardFromPg('workspace-roo-extensions');
    expect(result).not.toBeNull();
    expect(result!.status.markdown).toBe('# Status\n\nEverything nominal.');
    expect(result!.intercom.messages).toHaveLength(1);
    expect(result!.intercom.messages[0].id).toBe('myia-po-2025:roo-extensions:ic-20260821T0900-a1b2');
    expect(result!.intercom.messages[0].reply_to).toBeDefined();
    expect(result!.intercom.totalMessages).toBe(47);
  }));

  test('null message_id row → deterministic id stable across two reads', withReadGate(async () => {
    const row = sampleMessageRow({ id: 91, message_id: null });
    mockGetRooSyncDashboard.mockResolvedValue({ dashboard: sampleDashboardRow(), messages: [row] });
    const first = await readDashboardFromPg('workspace-roo-extensions');
    const second = await readDashboardFromPg('workspace-roo-extensions');
    expect(first!.intercom.messages[0].id).toBe('myia-po-2025:roo-extensions:pg-91');
    expect(first!.intercom.messages[0].id).toBe(second!.intercom.messages[0].id);
  }));

  test('getDashboardPgReader is null when the reader factory yields Null', async () => {
    // reader-factory is module-mocked non-Null; simulate the Null case via the
    // gate logic contract instead — same assertion as the channel reader tests.
    delete process.env.UNIFIED_STORE_PG_URL;
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
    expect(getDashboardPgReader()).toBeNull();
    delete process.env.UNIFIED_STORE_DASHBOARD_READ_PG;
  });
});

// ─── Write path ─────────────────────────────────────────────────────

describe('dualWriteDashboardSync / Delete / Backfill', () => {
  test('sync maps and forwards to the writer', async () => {
    await dualWriteDashboardSync(sampleDashboard());
    expect(mockSyncRooSyncDashboard).toHaveBeenCalledTimes(1);
    const [row, messages] = mockSyncRooSyncDashboard.mock.calls[0];
    expect(row.key).toBe('workspace-roo-extensions');
    expect(messages).toHaveLength(2);
    // no flags on the plain live path — no stamping (CRITICAL 1)
    expect(mockSyncRooSyncDashboard.mock.calls[0][2]).toBeUndefined();
  });

  test('condensed sync forwards the condensed flag (the only stamping mode)', async () => {
    await dualWriteDashboardSync(sampleDashboard(), { condensed: true });
    expect(mockSyncRooSyncDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'workspace-roo-extensions' }),
      expect.any(Array),
      { condensed: true }
    );
  });

  test('sync never throws on writer failure and warns (CRITICAL 2 — divergence must be observable)', async () => {
    mockSyncRooSyncDashboard.mockRejectedValueOnce(new Error('PG down'));
    await expect(dualWriteDashboardSync(sampleDashboard())).resolves.toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('dual-write sync failed'),
      expect.objectContaining({ key: 'workspace-roo-extensions', condensed: false })
    );
  });

  test('delete forwards the key and never throws', async () => {
    await dualWriteDashboardDelete('workspace-roo-extensions');
    expect(mockDeleteRooSyncDashboard).toHaveBeenCalledWith('workspace-roo-extensions');
    mockDeleteRooSyncDashboard.mockRejectedValueOnce(new Error('PG down'));
    await expect(dualWriteDashboardDelete('workspace-roo-extensions')).resolves.toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('dual-write delete failed'),
      expect.objectContaining({ key: 'workspace-roo-extensions' })
    );
  });

  test('backfill passes the backfill mode flag', async () => {
    await backfillDashboardToStore(sampleDashboard());
    expect(mockSyncRooSyncDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'workspace-roo-extensions' }),
      expect.any(Array),
      { backfill: true }
    );
  });
});

// ─── SQL shape — concrete writer (#3151 Phase C) ────────────────────

describe('PgUnifiedStoreWriter.syncRooSyncDashboard SQL shape', () => {
  const writer = new PgUnifiedStoreWriter({ connectionString: 'postgres://t:t@localhost:5432/x' });

  function queries(): string[] {
    return mockQuery.mock.calls.map(c => String(c[0]));
  }

  test('plain sync: transactional upserts, NO archive stamp (CRITICAL 1)', async () => {
    await writer.syncRooSyncDashboard(sampleDashboardRow(), [sampleMessageRow()]);
    const sql = queries().join('\n---\n');
    expect(sql).toContain('BEGIN');
    expect(sql).toContain('INSERT INTO roosync_dashboards');
    expect(sql).toContain('ON CONFLICT (key) DO UPDATE SET');
    expect(sql).toContain('version = roosync_dashboards.version + 1');
    expect(sql).toContain('INSERT INTO roosync_dashboard_messages');
    expect(sql).toContain('ON CONFLICT (dashboard_key, message_id) DO UPDATE SET');
    expect(sql).toContain('COMMIT');
    // A plain write's snapshot can lag concurrent appends from the other
    // machines — stamping here would archive messages still live on GDrive.
    expect(sql).not.toContain('SET archived_at');
  });

  test('plain sync with an EMPTY message list: NO stamp (stale-empty snapshot must not archive everything)', async () => {
    await writer.syncRooSyncDashboard(sampleDashboardRow(), []);
    const stampCall = mockQuery.mock.calls.find(c =>
      String(c[0]).includes('SET archived_at')
    );
    expect(stampCall).toBeUndefined();
  });

  test('condensed sync: transactional upserts + archive stamp', async () => {
    await writer.syncRooSyncDashboard(sampleDashboardRow(), [sampleMessageRow()], { condensed: true });
    const sql = queries().join('\n---\n');
    expect(sql).toContain('BEGIN');
    expect(sql).toContain('ON CONFLICT (key) DO UPDATE SET');
    expect(sql).toContain('ON CONFLICT (dashboard_key, message_id) DO UPDATE SET');
    expect(sql).toContain('SET archived_at = COALESCE(archived_at, NOW())');
    expect(sql).toContain('AND NOT (message_id = ANY($2))');
    expect(sql).toContain('COMMIT');
  });

  test('sync mode: NULL message_id rows are excluded from the journal batch', async () => {
    await writer.syncRooSyncDashboard(sampleDashboardRow(), [
      sampleMessageRow(),
      sampleMessageRow({ id: 2, message_id: null }),
    ]);
    const journalCall = mockQuery.mock.calls.find(c =>
      String(c[0]).includes('INSERT INTO roosync_dashboard_messages')
    );
    expect(journalCall).toBeDefined();
    const idsParam = journalCall![1][1] as string[];
    expect(idsParam).toHaveLength(1);
    expect(idsParam[0]).toBe('myia-po-2025:roo-extensions:ic-20260821T0900-a1b2');
  });

  test('backfill mode: DO NOTHING everywhere, NO archive stamp', async () => {
    await writer.syncRooSyncDashboard(sampleDashboardRow(), [sampleMessageRow()], { backfill: true });
    const sql = queries().join('\n---\n');
    expect(sql).toContain('ON CONFLICT (key) DO NOTHING');
    expect(sql).toContain('ON CONFLICT (dashboard_key, message_id) DO NOTHING');
    expect(sql).not.toContain('DO UPDATE SET');
    expect(sql).not.toContain('SET archived_at');
  });

  test('condensed sync with an empty message list: stamp uses the sentinel (condensation archived everything)', async () => {
    await writer.syncRooSyncDashboard(sampleDashboardRow(), [], { condensed: true });
    const journalCall = mockQuery.mock.calls.find(c =>
      String(c[0]).includes('INSERT INTO roosync_dashboard_messages')
    );
    expect(journalCall).toBeUndefined();
    const stampCall = mockQuery.mock.calls.find(c =>
      String(c[0]).includes('SET archived_at')
    );
    expect(stampCall![1][1]).toEqual(['__none__']);
  });

  test('deleteRooSyncDashboard deletes by key (journal cascades via FK)', async () => {
    await writer.deleteRooSyncDashboard('workspace-roo-extensions');
    expect(mockQuery).toHaveBeenCalledWith(
      'DELETE FROM roosync_dashboards WHERE key = $1',
      ['workspace-roo-extensions']
    );
  });
});

// ─── SQL shape — concrete reader (#3151 Phase C) ────────────────────

describe('PgUnifiedStoreReader.getRooSyncDashboard SQL shape', () => {
  const reader = new PgUnifiedStoreReader({ connectionString: 'postgres://t:t@localhost:5432/x' });

  test('miss → null without a journal query', async () => {
    // First call = self-init SELECT 1, second = the key lookup.
    mockQuery.mockResolvedValueOnce({ rows: [{ '1': 1 }] }).mockResolvedValueOnce({ rows: [] });
    const result = await reader.getRooSyncDashboard('global');
    expect(result).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(2);
    // The journal query must not have run on a dashboard-row miss
    for (const call of mockQuery.mock.calls) {
      expect(String(call[0])).not.toContain('roosync_dashboard_messages');
    }
  });

  test('hit → dashboard + active messages, ordered oldest-first', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        key: 'global',
        type: 'global',
        machine_id: null,
        workspace: null,
        content: '# Status',
        status_json: { lastModified: '2026-08-21T10:00:00.000Z', lastModifiedBy: { machineId: 'm', workspace: 'w' } },
        updated_at: new Date('2026-08-21T10:00:00.000Z'),
        version: 3,
      }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [
      { id: 2, dashboard_key: 'global', message_id: 'b', author_machine: 'm2', author_workspace: 'w', content: 'second', tags: [], team_stage: null, reply_to: null, acknowledged_at: null, archived_at: null, created_at: new Date('2026-08-21T09:30:00.000Z') },
      { id: 1, dashboard_key: 'global', message_id: 'a', author_machine: 'm1', author_workspace: 'w', content: 'first', tags: [], team_stage: null, reply_to: null, acknowledged_at: null, archived_at: null, created_at: new Date('2026-08-21T09:00:00.000Z') },
    ]});

    const result = await reader.getRooSyncDashboard('global');
    expect(result).not.toBeNull();
    expect(result!.dashboard.version).toBe(3);
    expect(result!.messages.map(m => m.message_id)).toEqual(['b', 'a']); // server-side ordering preserved

    const journalSql = String(mockQuery.mock.calls[1][0]);
    expect(journalSql).toContain('archived_at IS NULL');
    expect(journalSql).toContain('ORDER BY created_at ASC, id ASC');
  });
});
