/**
 * #4596 (ii) — retired-skip: the dashboard sync transaction consults the
 * ACTIVE retirement mark (#3782, `lifted_at IS NULL`) inside the transaction
 * and turns into a NAMED no-op when one is found — for EVERY write mode
 * (reconcile backfill / plain sync / condensation).
 *
 * Matrix: mark state (ACTIVE / none / lifted via unretire) × write mode
 * (backfill / plain / condensed), plus the retire → skip → unretire →
 * written cycle, and the transaction shape (BEGIN → lookup → empty COMMIT,
 * zero write statements).
 */
import { describe, test, expect, beforeEach, beforeAll, vi } from 'vitest';

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: vi.fn() });
const mockPool = { on: vi.fn(), connect: mockConnect, query: mockQuery, end: vi.fn() };

vi.mock('pg', () => ({ default: { Pool: vi.fn(() => mockPool) } }));

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { PgUnifiedStoreWriter } from '../PgUnifiedStoreWriter.js';
import type {
  RooSyncDashboardRow,
  RooSyncDashboardMessageRow,
} from '../types.js';

const writer = new PgUnifiedStoreWriter({ connectionString: 'postgres://t:t@localhost:5432/x' });

function sampleRow(key = 'workspace-foo (1)'): RooSyncDashboardRow {
  return {
    key,
    type: 'workspace',
    machine_id: null,
    workspace: 'foo',
    content: '# status\n',
    status_json: {},
  };
}

function sampleMessage(key = 'workspace-foo (1)'): RooSyncDashboardMessageRow {
  return {
    dashboard_key: key,
    message_id: 'myia-po-2024:foo:ic-20261112T2100-a1b2',
    author_machine: 'myia-po-2024',
    author_workspace: 'foo',
    content: '[INFO] starting work',
    tags: [],
    team_stage: null,
    reply_to: null,
    acknowledged_at: null,
    created_at: '2026-11-12T21:00:00.000Z',
  };
}

function sqls(): string[] {
  return mockQuery.mock.calls.map(c => String(c[0]));
}

// Warm the pool once — init() pings via client.query('SELECT 1'), which must
// not consume a test's mockResolvedValueOnce (same pattern as the retirement
// store suite).
beforeAll(async () => {
  await writer.init();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockReset().mockResolvedValue({ rows: [] });
  // mockConnect closes over mockQuery — re-establish after the resets.
  mockConnect.mockReset().mockResolvedValue({ query: mockQuery, release: vi.fn() });
});

// ─── ACTIVE mark → retired-skip for EVERY write mode ───────────────────────

describe('#4596 (ii) retired-skip — ACTIVE mark', () => {
  for (const mode of [
    { name: 'backfill (reconcile insert pass)', opts: { backfill: true } },
    { name: 'plain sync (live dual-write)', opts: {} },
    { name: 'condensed (condensation stamp path)', opts: { condensed: true } },
  ] as const) {
    test(`ACTIVE mark → retired-skip, zero write statements — ${mode.name}`, async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })                      // BEGIN
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })     // retirement lookup — ACTIVE
        .mockResolvedValueOnce({ rows: [] });                     // COMMIT (empty)
      const outcome = await writer.syncRooSyncDashboardChecked(
        sampleRow(), [sampleMessage()], { ...mode.opts }
      );
      expect(outcome).toEqual({ ok: true, reason: 'retired-skip' });
      const calls = sqls();
      // Empty transaction, still committed properly: BEGIN → lookup → COMMIT.
      expect(calls[0]).toBe('BEGIN');
      expect(calls[1]).toContain('roosync_dashboard_retirements');
      expect(calls[1]).toContain('lifted_at IS NULL');
      expect(calls[2]).toBe('COMMIT');
      expect(calls).toHaveLength(3);
      // NO write of any kind reached the store — not the dashboard row,
      // not the journal, not the condensation stamp.
      expect(calls.some(s => s.includes('INSERT INTO roosync_dashboards'))).toBe(false);
      expect(calls.some(s => s.includes('INSERT INTO roosync_dashboard_messages'))).toBe(false);
      expect(calls.some(s => s.includes('SET archived_at'))).toBe(false);
    });
  }

  test('void variant (the reconcile path) is also a silent no-op — no throw, no write', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      writer.syncRooSyncDashboard(sampleRow(), [sampleMessage()], { backfill: true })
    ).resolves.toBeUndefined();
    expect(sqls().some(s => s.includes('INSERT INTO roosync_dashboards'))).toBe(false);
  });
});

// ─── NO mark (or lifted) → unchanged nominal path ──────────────────────────

describe('#4596 (ii) retired-skip — no active mark', () => {
  for (const mode of [
    { name: 'backfill', opts: { backfill: true } },
    { name: 'plain', opts: {} },
    { name: 'condensed', opts: { condensed: true } },
  ] as const) {
    test(`no mark → written, nominal transaction intact — ${mode.name}`, async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })   // BEGIN
        .mockResolvedValueOnce({ rows: [] });  // retirement lookup — empty
      const outcome = await writer.syncRooSyncDashboardChecked(
        sampleRow(), [sampleMessage()], { ...mode.opts }
      );
      expect(outcome).toEqual({ ok: true, reason: 'written' });
      const calls = sqls();
      expect(calls[1]).toContain('roosync_dashboard_retirements');
      expect(calls.some(s => s.includes('INSERT INTO roosync_dashboards'))).toBe(true);
      expect(calls.some(s => s.includes('INSERT INTO roosync_dashboard_messages'))).toBe(true);
      if (mode.opts.condensed) {
        expect(calls.some(s => s.includes('SET archived_at'))).toBe(true);
      }
    });
  }
});

// ─── retire → skip → unretire → written again (the mark lifecycle) ─────────

describe('#4596 (ii) retired-skip — lifecycle', () => {
  test('retire → sync skips; unretire lifts the mark → sync writes again', async () => {
    // 1. Retire the key (mark INSERT — pool.query, default mock).
    const retireOutcome = await writer.retireRooSyncDashboardKeyChecked(
      'workspace-foo (1)', 'workspace-foo', 'myia-po-2024:roo-extensions'
    );
    expect(retireOutcome).toEqual({ ok: true, reason: 'written' });

    // 2. Sync under the retired key → named no-op.
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      writer.syncRooSyncDashboardChecked(sampleRow(), [sampleMessage()])
    ).resolves.toEqual({ ok: true, reason: 'retired-skip' });

    // 3. Unretire (lifted_at set — pool.query UPDATE, default mock).
    const unretireOutcome = await writer.unretireRooSyncDashboardKeyChecked('workspace-foo (1)');
    expect(unretireOutcome).toEqual({ ok: true, reason: 'written' });

    // 4. Sync again → lookup now sees no ACTIVE mark (lifted_at IS NULL
    //    filters it) → nominal write.
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      writer.syncRooSyncDashboardChecked(sampleRow(), [sampleMessage()])
    ).resolves.toEqual({ ok: true, reason: 'written' });
  });
});
