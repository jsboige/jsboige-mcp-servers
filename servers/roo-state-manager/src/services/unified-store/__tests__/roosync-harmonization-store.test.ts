/**
 * #3544 — harmonic campaign store: PG authority + gate behaviour.
 *
 * What this pins down (ai-01's decision, issue comment 6710974383: PG is the
 * AUTHORITY, G: the fallback mirror):
 *   - the READ gate is on only when an explicit flag says so or the backfill
 *     marker proves the store complete — and it closes with the seat-wide
 *     kill-switch;
 *   - a PG miss returns `null` (caller falls back to the FILE), never an empty
 *     campaign — the under-show this whole issue exists to prevent;
 *   - a PG failure is logged and answered with `null`, never thrown;
 *   - the record round-trips through `payload` bit for bit, and the typed
 *     columns are the fallback when a row has no payload;
 *   - writes are `disabled` without the primary gate, and the backfill helpers
 *     bypass the gate with INSERT-only semantics;
 *   - the concrete writer's SQL is INSERT ... DO NOTHING on backfill and
 *     ON CONFLICT DO UPDATE otherwise, with confirmations idempotent on
 *     (campaign_id, event_id).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Reader factory mock ────────────────────────────────────────────

const mockGetHarmonizationCampaign = vi.fn();
const mockListHarmonizationCampaigns = vi.fn();
let readerIsNull = false;

vi.mock('../reader-factory.js', () => ({
  getUnifiedStoreReader: () => ({
    isNull: () => readerIsNull,
    getHarmonizationCampaign: mockGetHarmonizationCampaign,
    listHarmonizationCampaigns: mockListHarmonizationCampaigns,
  }),
  resetReaderInstance: vi.fn(),
}));

// ─── Writer factory mock ────────────────────────────────────────────

const mockSyncHarmonizationCampaign = vi.fn().mockResolvedValue({ ok: true, reason: 'written' });
const mockAppendHarmonizationConfirmation = vi.fn().mockResolvedValue({ ok: true, reason: 'written' });

vi.mock('../writer-factory.js', () => ({
  getUnifiedStoreWriter: () => ({
    syncHarmonizationCampaign: mockSyncHarmonizationCampaign,
    appendHarmonizationConfirmation: mockAppendHarmonizationConfirmation,
  }),
  resetWriterInstance: vi.fn(),
}));

// ─── pg mock (SQL shape assertions on the concrete writer) ──────────

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: vi.fn() });
const mockPool = { on: vi.fn(), connect: mockConnect, query: mockQuery, end: vi.fn() };

vi.mock('pg', () => ({ default: { Pool: vi.fn(() => mockPool) } }));

const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }));

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockLoggerWarn, error: vi.fn() }),
}));

import {
  getHarmonizationPgReader,
  isHarmonizationPgPrimary,
  mapCampaignToRow,
  mapRowToCampaign,
  mapConfirmationToRow,
  readCampaignFromPg,
  listCampaignsFromPg,
  readConfirmationsFromPg,
  writeCampaignToPg,
  writeConfirmationToPg,
  backfillCampaignToStore,
  backfillConfirmationToStore,
} from '../roosync-harmonization-store.js';
import type { HarmonizationCampaignRow, HarmonizationConfirmationRow } from '../types.js';
import type {
  CampaignConfirmedObservation,
  HarmonizationCampaignRecord,
} from '../../HarmonizationCampaignService.js';
import { PgUnifiedStoreWriter } from '../PgUnifiedStoreWriter.js';

const CAMPAIGN_ID = 'hc-claude-settings-2026.10.25-1';

function sampleRecord(over: Partial<HarmonizationCampaignRecord> = {}): HarmonizationCampaignRecord {
  return {
    id: CAMPAIGN_ID,
    targetFile: 'claude-settings',
    createdAt: '2026-10-24T22:58:39.163Z',
    createdBy: 'myia-ai-01',
    canon: {
      version: '2026.10.25-1',
      mode: 'enforce-value',
      keys: { model: 'claude-sonnet-5-5', 'env.CLAUDE_CODE_MAX_CONTEXT_TOKENS': '230000' },
      hash: 'sha256:deadbeef',
    },
    fleet: ['myia-web2:roo-extensions', 'myia-ai-01:CoursIA'],
    exceptions: { 'myia-po-2027': ['model'] },
    dispatches: { 'myia-web2:roo-extensions': { at: '2026-10-25T00:10:00.000Z', messageId: 'msg-7' } },
    reminders: { 'myia-po-2027': [{ at: '2026-10-25T06:00:00.000Z', messageId: 'msg-9' }] },
    status: 'closed',
    closedAt: '2026-10-26T08:00:00.000Z',
    closeReason: '8/8 confirmed',
    rev: 3,
    ...over,
  };
}

function rowFor(record: HarmonizationCampaignRecord): HarmonizationCampaignRow {
  return mapCampaignToRow(record);
}

const sampleConfirmation: CampaignConfirmedObservation = {
  kind: 'confirm',
  machine: 'myia-po-2023',
  at: '2026-10-25T04:51:35.610Z',
  canonHash: 'sha256:deadbeef',
  observedHash: 'sha256:deadbeef',
  source: 'live-read',
  eventId: 'evt-0001',
};

const ENV_KEYS = [
  'UNIFIED_STORE_PG_URL',
  'UNIFIED_STORE_DUAL_WRITE',
  'UNIFIED_STORE_HARMONIZATION_READ_PG',
  'UNIFIED_STORE_HARMONIZATION_PG_PRIMARY',
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  vi.clearAllMocks();
  readerIsNull = false;
  mockGetHarmonizationCampaign.mockReset().mockResolvedValue(null);
  mockListHarmonizationCampaigns.mockReset().mockResolvedValue([]);
  mockSyncHarmonizationCampaign.mockReset().mockResolvedValue({ ok: true, reason: 'written' });
  mockAppendHarmonizationConfirmation.mockReset().mockResolvedValue({ ok: true, reason: 'written' });
  mockQuery.mockReset().mockResolvedValue({ rows: [] });
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ─── gates ──────────────────────────────────────────────────────────

describe('gates', () => {
  test('without a PG URL the reader is null and writes are disabled', () => {
    expect(getHarmonizationPgReader()).toBeNull();
    expect(isHarmonizationPgPrimary()).toBe(false);
  });

  test('an explicit read flag opens the reader', () => {
    process.env.UNIFIED_STORE_PG_URL = 'postgres://test';
    process.env.UNIFIED_STORE_HARMONIZATION_READ_PG = '1';
    expect(getHarmonizationPgReader()).not.toBeNull();
  });

  test('a Null reader behind the flag is still no reader', () => {
    process.env.UNIFIED_STORE_PG_URL = 'postgres://test';
    process.env.UNIFIED_STORE_HARMONIZATION_READ_PG = '1';
    readerIsNull = true;
    expect(getHarmonizationPgReader()).toBeNull();
  });

  test('the seat-wide kill-switch closes reads and writes (documented meaning)', () => {
    process.env.UNIFIED_STORE_PG_URL = 'postgres://test';
    process.env.UNIFIED_STORE_HARMONIZATION_READ_PG = '1';
    process.env.UNIFIED_STORE_HARMONIZATION_PG_PRIMARY = '1';
    process.env.UNIFIED_STORE_DUAL_WRITE = '0';
    expect(getHarmonizationPgReader()).toBeNull();
    expect(isHarmonizationPgPrimary()).toBe(false);
  });

  test('primary follows the writer factory: a URL alone is enough, the kill-switch is what closes it', () => {
    // The factory builds the Pg writer whenever a URL is present and the
    // seat-wide kill-switch is not set (#4131 — the cutover is the default).
    // A primary over a Null writer would report success while nothing landed,
    // so the gate carries the SAME condition as the factory: URL present and
    // dual-write not explicitly off.
    process.env.UNIFIED_STORE_PG_URL = 'postgres://test';
    process.env.UNIFIED_STORE_HARMONIZATION_PG_PRIMARY = '1';
    expect(isHarmonizationPgPrimary()).toBe(true);
    process.env.UNIFIED_STORE_DUAL_WRITE = '0';
    expect(isHarmonizationPgPrimary()).toBe(false);
    process.env.UNIFIED_STORE_DUAL_WRITE = 'off';
    expect(isHarmonizationPgPrimary()).toBe(false);
  });

  test('primary never resolves without a PG URL, whatever the flags say', () => {
    process.env.UNIFIED_STORE_HARMONIZATION_PG_PRIMARY = '1';
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    expect(isHarmonizationPgPrimary()).toBe(false);
  });
});

// ─── mapping ────────────────────────────────────────────────────────

describe('mapping', () => {
  test('the record round-trips through payload without losing a field', () => {
    const record = sampleRecord();
    // Real JSONB round trip: mapping the row we just built in memory would
    // compare an object to itself and prove nothing.
    const row = JSON.parse(JSON.stringify(rowFor(record))) as HarmonizationCampaignRow;
    expect(mapRowToCampaign(row)).toEqual(record);
  });

  test('typed columns are the fallback when the row has no payload', () => {
    const record = sampleRecord();
    const { payload: _payload, ...bare } = rowFor(record);
    const rebuilt = mapRowToCampaign(bare as HarmonizationCampaignRow);
    expect(rebuilt.id).toBe(record.id);
    expect(rebuilt.targetFile).toBe(record.targetFile);
    expect(rebuilt.canon.hash).toBe(record.canon.hash);
    expect(rebuilt.canon.version).toBe(record.canon.version);
    expect(rebuilt.canon.mode).toBe(record.canon.mode);
    expect(rebuilt.status).toBe(record.status);
    expect(rebuilt.rev).toBe(record.rev);
    expect(rebuilt.fleet).toEqual(record.fleet);
    expect(rebuilt.exceptions).toEqual(record.exceptions);
    expect(rebuilt.closedAt).toBe(record.closedAt);
    expect(rebuilt.closeReason).toBe(record.closeReason);
  });

  test('an open campaign carries no closedAt / closeReason at all', () => {
    const open = sampleRecord({ status: 'active' });
    delete (open as { closedAt?: string }).closedAt;
    delete (open as { closeReason?: string }).closeReason;
    const row = rowFor(open);
    expect(row.closed_at).toBeNull();
    expect(row.close_reason).toBeNull();
    const rebuilt = mapRowToCampaign({ ...row, payload: {} } as HarmonizationCampaignRow);
    expect(rebuilt.closedAt).toBeUndefined();
    expect(rebuilt.closeReason).toBeUndefined();
  });

  test('a confirmation event becomes a live-read row keyed by its eventId', () => {
    expect(mapConfirmationToRow(CAMPAIGN_ID, sampleConfirmation)).toEqual({
      campaign_id: CAMPAIGN_ID,
      machine_id: 'myia-po-2023',
      workspace: null,
      confirmed_at: '2026-10-25T04:51:35.610Z',
      canon_hash: 'sha256:deadbeef',
      observed_hash: 'sha256:deadbeef',
      source: 'live-read',
      event_id: 'evt-0001',
    } satisfies HarmonizationConfirmationRow);
  });
});

// ─── reads ──────────────────────────────────────────────────────────

describe('reads', () => {
  beforeEach(() => {
    process.env.UNIFIED_STORE_PG_URL = 'postgres://test';
    process.env.UNIFIED_STORE_HARMONIZATION_READ_PG = '1';
  });

  test('a known campaign comes back as the record the file would have held', async () => {
    const record = sampleRecord();
    mockGetHarmonizationCampaign.mockResolvedValue({ campaign: rowFor(record), confirmations: [] });
    await expect(readCampaignFromPg(CAMPAIGN_ID)).resolves.toEqual(record);
    expect(mockGetHarmonizationCampaign).toHaveBeenCalledWith(CAMPAIGN_ID);
  });

  test('an unknown campaign is null — the caller falls back to the file', async () => {
    mockGetHarmonizationCampaign.mockResolvedValue(null);
    await expect(readCampaignFromPg(CAMPAIGN_ID)).resolves.toBeNull();
  });

  test('a PG failure is answered with null and logged, never thrown', async () => {
    mockGetHarmonizationCampaign.mockRejectedValue(new Error('pool timeout'));
    await expect(readCampaignFromPg(CAMPAIGN_ID)).resolves.toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  test('the campaign list is null (not []) when PG fails', async () => {
    mockListHarmonizationCampaigns.mockRejectedValue(new Error('boom'));
    await expect(listCampaignsFromPg(false)).resolves.toBeNull();
  });

  test('the campaign list maps every row', async () => {
    const a = sampleRecord();
    const b = sampleRecord({ id: 'hc-claude-settings-2026.10.24-2', rev: 2 });
    mockListHarmonizationCampaigns.mockResolvedValue([rowFor(a), { ...rowFor(b) }]);
    const listed = await listCampaignsFromPg(true);
    expect(listed?.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(mockListHarmonizationCampaigns).toHaveBeenCalledWith(true);
  });

  test('confirmations come back as organ events, filtered by machine on request', async () => {
    const other: HarmonizationConfirmationRow = {
      ...mapConfirmationToRow(CAMPAIGN_ID, { ...sampleConfirmation, machine: 'myia-web2', eventId: 'evt-0002' }),
    };
    mockGetHarmonizationCampaign.mockResolvedValue({
      campaign: rowFor(sampleRecord()),
      confirmations: [mapConfirmationToRow(CAMPAIGN_ID, sampleConfirmation), other],
    });

    const all = await readConfirmationsFromPg(CAMPAIGN_ID);
    expect(all).toEqual([sampleConfirmation, { ...sampleConfirmation, machine: 'myia-web2', eventId: 'evt-0002' }]);

    const one = await readConfirmationsFromPg(CAMPAIGN_ID, 'myia-po-2023');
    expect(one).toEqual([sampleConfirmation]);
  });

  test('confirmations of an unknown campaign are null — not an empty journal', async () => {
    mockGetHarmonizationCampaign.mockResolvedValue(null);
    await expect(readConfirmationsFromPg(CAMPAIGN_ID)).resolves.toBeNull();
  });
});

// ─── writes ─────────────────────────────────────────────────────────

describe('writes', () => {
  test('without the primary gate a write reports disabled and touches nothing', async () => {
    process.env.UNIFIED_STORE_PG_URL = 'postgres://test';
    await expect(writeCampaignToPg(sampleRecord())).resolves.toEqual({
      ok: false,
      reason: 'disabled',
    });
    await expect(writeConfirmationToPg(CAMPAIGN_ID, sampleConfirmation)).resolves.toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(mockSyncHarmonizationCampaign).not.toHaveBeenCalled();
    expect(mockAppendHarmonizationConfirmation).not.toHaveBeenCalled();
  });

  test('with the primary gate the campaign row is forwarded unchanged', async () => {
    process.env.UNIFIED_STORE_PG_URL = 'postgres://test';
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_HARMONIZATION_PG_PRIMARY = '1';
    const record = sampleRecord();
    await expect(writeCampaignToPg(record)).resolves.toEqual({ ok: true, reason: 'written' });
    expect(mockSyncHarmonizationCampaign).toHaveBeenCalledWith(rowFor(record), undefined);
  });

  test('a confirmation write carries the live-read row and the eventId', async () => {
    process.env.UNIFIED_STORE_PG_URL = 'postgres://test';
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_HARMONIZATION_PG_PRIMARY = '1';
    await writeConfirmationToPg(CAMPAIGN_ID, sampleConfirmation, { workspace: 'roo-extensions' });
    expect(mockAppendHarmonizationConfirmation).toHaveBeenCalledWith({
      ...mapConfirmationToRow(CAMPAIGN_ID, sampleConfirmation),
      workspace: 'roo-extensions',
    });
  });

  test('a throwing writer becomes an exhausted outcome, never an exception', async () => {
    process.env.UNIFIED_STORE_PG_URL = 'postgres://test';
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_HARMONIZATION_PG_PRIMARY = '1';
    mockSyncHarmonizationCampaign.mockRejectedValue(new Error('breaker open'));
    const outcome = await writeCampaignToPg(sampleRecord());
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ reason: 'exhausted' });
  });

  test('the backfill helpers bypass the gate and are INSERT-only', async () => {
    // No flags at all — the backfill runs BEFORE the read gate opens.
    const record = sampleRecord();
    await backfillCampaignToStore(record);
    expect(mockSyncHarmonizationCampaign).toHaveBeenCalledWith(rowFor(record), { backfill: true });

    await backfillConfirmationToStore(CAMPAIGN_ID, sampleConfirmation);
    expect(mockAppendHarmonizationConfirmation).toHaveBeenCalledWith(
      mapConfirmationToRow(CAMPAIGN_ID, sampleConfirmation)
    );
  });
});

// ─── concrete SQL shape ─────────────────────────────────────────────

describe('PgUnifiedStoreWriter — harmonization SQL', () => {
  function writer(): PgUnifiedStoreWriter {
    return new PgUnifiedStoreWriter({ connectionString: 'postgres://test' });
  }

  test('a live sync upserts the campaign (DO UPDATE, never a rollback on replay)', async () => {
    const outcome = await writer().syncHarmonizationCampaign(rowFor(sampleRecord()));
    expect(outcome).toEqual({ ok: true, reason: 'written' });
    const sql = String(mockQuery.mock.calls.at(-1)?.[0] ?? '');
    expect(sql).toContain('INSERT INTO harmonization_campaigns');
    expect(sql).toContain('ON CONFLICT (campaign_id) DO UPDATE SET');
    expect(sql).not.toContain('DO NOTHING');
    // JSONB columns are serialised, never passed as objects (pg would guess).
    const params = mockQuery.mock.calls.at(-1)?.[1] as unknown[];
    expect(params[11]).toBe(JSON.stringify(sampleRecord().fleet));
    expect(params[12]).toBe(JSON.stringify(sampleRecord().exceptions));
  });

  test('a backfill sync is INSERT ... DO NOTHING', async () => {
    await writer().syncHarmonizationCampaign(rowFor(sampleRecord()), { backfill: true });
    const sql = String(mockQuery.mock.calls.at(-1)?.[0] ?? '');
    expect(sql).toContain('ON CONFLICT (campaign_id) DO NOTHING');
    expect(sql).not.toContain('DO UPDATE');
  });

  test('confirmations are idempotent on (campaign_id, event_id)', async () => {
    await writer().appendHarmonizationConfirmation(mapConfirmationToRow(CAMPAIGN_ID, sampleConfirmation));
    const sql = String(mockQuery.mock.calls.at(-1)?.[0] ?? '');
    expect(sql).toContain('INSERT INTO harmonization_confirmations');
    expect(sql).toContain('ON CONFLICT (campaign_id, event_id) DO NOTHING');
    expect(mockQuery.mock.calls.at(-1)?.[1]).toEqual([
      CAMPAIGN_ID,
      'myia-po-2023',
      null,
      '2026-10-25T04:51:35.610Z',
      'sha256:deadbeef',
      'sha256:deadbeef',
      'live-read',
      'evt-0001',
    ]);
  });
});
