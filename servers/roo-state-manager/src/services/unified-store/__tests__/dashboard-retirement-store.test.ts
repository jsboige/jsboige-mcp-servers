/**
 * #3782 — journal-level key retirement: store functions + concrete SQL shapes.
 *
 * The mark lives in `roosync_dashboard_retirements` (migrations/008):
 *   - `retireDashboardKeyChecked` forwards to the writer (never throws, checked
 *     outcome — the merge gates its source disposition on it);
 *   - `getDashboardRetirement` / `listRetiredDashboardKeys` read through the
 *     reader factory (NOT the DASHBOARD_READ_PG gate — decision inputs), and
 *     fail OPEN: reader null, error or timeout = key treated as not retired;
 *   - the concrete writer INSERTs the mark with ON CONFLICT DO UPDATE (a
 *     re-mark refreshes and clears any previous lift) — never a DELETE;
 *   - the concrete reader filters `lifted_at IS NULL` everywhere.
 */
import { describe, test, expect, beforeEach, beforeAll, vi } from 'vitest';

let readerIsNull = false;

const mockGetRooSyncDashboardRetirement = vi.fn().mockResolvedValue(null);
const mockListRetiredRooSyncDashboardKeys = vi.fn().mockResolvedValue([]);

vi.mock('../reader-factory.js', () => ({
  getUnifiedStoreReader: () => ({
    isNull: () => readerIsNull,
    getRooSyncDashboardRetirement: mockGetRooSyncDashboardRetirement,
    listRetiredRooSyncDashboardKeys: mockListRetiredRooSyncDashboardKeys,
  }),
  resetReaderInstance: vi.fn(),
}));

const mockRetireRooSyncDashboardKey = vi.fn().mockResolvedValue({ ok: true, reason: 'written' });
const mockUnretireRooSyncDashboardKey = vi.fn().mockResolvedValue({ ok: true, reason: 'written' });

vi.mock('../writer-factory.js', () => ({
  getUnifiedStoreWriter: () => ({
    retireRooSyncDashboardKeyChecked: mockRetireRooSyncDashboardKey,
    unretireRooSyncDashboardKeyChecked: mockUnretireRooSyncDashboardKey,
  }),
  resetWriterInstance: vi.fn(),
}));

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: vi.fn() });
const mockPool = { on: vi.fn(), connect: mockConnect, query: mockQuery, end: vi.fn() };

vi.mock('pg', () => ({ default: { Pool: vi.fn(() => mockPool) } }));

const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }));

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockLoggerWarn, error: vi.fn() }),
}));

import {
  getDashboardRetirement,
  listRetiredDashboardKeys,
  retireDashboardKeyChecked,
  unretireDashboardKeyChecked,
} from '../roosync-dashboard-store.js';
import { PgUnifiedStoreWriter } from '../PgUnifiedStoreWriter.js';
import { PgUnifiedStoreReader } from '../PgUnifiedStoreReader.js';

beforeEach(() => {
  vi.clearAllMocks();
  readerIsNull = false;
  mockGetRooSyncDashboardRetirement.mockReset().mockResolvedValue(null);
  mockListRetiredRooSyncDashboardKeys.mockReset().mockResolvedValue([]);
  mockRetireRooSyncDashboardKey.mockReset().mockResolvedValue({ ok: true, reason: 'written' });
  mockUnretireRooSyncDashboardKey.mockReset().mockResolvedValue({ ok: true, reason: 'written' });
  mockQuery.mockReset().mockResolvedValue({ rows: [] });
  // mockConnect closes over mockQuery — re-establish after the resets (same
  // pattern as roosync-dashboard-store.test.ts).
  mockConnect.mockReset().mockResolvedValue({ query: mockQuery, release: vi.fn() });
});

// ─── Store functions — forwarding + fail-open contracts ────────────────────

describe('retireDashboardKeyChecked / unretireDashboardKeyChecked (forwarding)', () => {
  test('retire forwards source, target and author; outcome returned', async () => {
    const outcome = await retireDashboardKeyChecked('machine-x (1)', 'machine-x', 'myia-ai-01:roo-extensions');
    expect(mockRetireRooSyncDashboardKey).toHaveBeenCalledWith('machine-x (1)', 'machine-x', 'myia-ai-01:roo-extensions');
    expect(outcome).toEqual({ ok: true, reason: 'written' });
  });

  test('retire never throws on writer failure — exhausted outcome + warn (the merge defers, honest report)', async () => {
    mockRetireRooSyncDashboardKey.mockRejectedValueOnce(new Error('PG down'));
    const outcome = await retireDashboardKeyChecked('k (1)', 'k', 'by');
    expect(outcome).toEqual({ ok: false, reason: 'exhausted', detail: 'Error: PG down' });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('mark write failed'),
      expect.objectContaining({ sourceKey: 'k (1)', targetKey: 'k' })
    );
  });

  test('unretire forwards the key; failure degrades to exhausted', async () => {
    await unretireDashboardKeyChecked('k (1)');
    expect(mockUnretireRooSyncDashboardKey).toHaveBeenCalledWith('k (1)');
    mockUnretireRooSyncDashboardKey.mockRejectedValueOnce(new Error('PG down'));
    await expect(unretireDashboardKeyChecked('k (1)')).resolves.toEqual(
      expect.objectContaining({ ok: false, reason: 'exhausted' })
    );
  });
});

describe('getDashboardRetirement (fail-open lookups)', () => {
  test('forwards the key and returns the active mark', async () => {
    const mark = { sourceKey: 'k (1)', targetKey: 'k', retiredBy: 'by', retiredAt: '2026-09-26T09:00:00.000Z' };
    mockGetRooSyncDashboardRetirement.mockResolvedValueOnce(mark);
    await expect(getDashboardRetirement('k (1)')).resolves.toEqual(mark);
    expect(mockGetRooSyncDashboardRetirement).toHaveBeenCalledWith('k (1)');
  });

  test('Null reader (no PG half) → null — the key is treated as not retired', async () => {
    readerIsNull = true;
    await expect(getDashboardRetirement('k (1)')).resolves.toBeNull();
  });

  test('reader failure → null + warn (fail-open: worst case is pre-#3782 behaviour)', async () => {
    mockGetRooSyncDashboardRetirement.mockRejectedValueOnce(new Error('pool hung'));
    await expect(getDashboardRetirement('k (1)')).resolves.toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('fail-open'),
      expect.objectContaining({ key: 'k (1)' })
    );
  });
});

describe('listRetiredDashboardKeys (fail-open listing)', () => {
  test('returns the active keys as a Set', async () => {
    mockListRetiredRooSyncDashboardKeys.mockResolvedValueOnce(['machine-x (1)', 'workspace-Foo (2)']);
    const retired = await listRetiredDashboardKeys();
    expect(retired).toBeInstanceOf(Set);
    expect([...retired]).toEqual(['machine-x (1)', 'workspace-Foo (2)']);
  });

  test('Null reader / failure → empty Set', async () => {
    await expect(listRetiredDashboardKeys()).resolves.toEqual(new Set());
    readerIsNull = true;
    await expect(listRetiredDashboardKeys()).resolves.toEqual(new Set());
    readerIsNull = false;
    mockListRetiredRooSyncDashboardKeys.mockRejectedValueOnce(new Error('PG down'));
    await expect(listRetiredDashboardKeys()).resolves.toEqual(new Set());
  });
});

// ─── Concrete writer — SQL shapes (mark, never DELETE) ─────────────────────

describe('PgUnifiedStoreWriter retirement SQL shape', () => {
  const writer = new PgUnifiedStoreWriter({ connectionString: 'postgres://t:t@localhost:5432/x' });

  test('retire: INSERT ON CONFLICT (source_key) DO UPDATE, clears any previous lift', async () => {
    const outcome = await writer.retireRooSyncDashboardKeyChecked('k (1)', 'k', 'myia-ai-01:roo-extensions');
    expect(outcome).toEqual({ ok: true, reason: 'written' });
    const call = mockQuery.mock.calls.find(c => String(c[0]).includes('roosync_dashboard_retirements'));
    expect(call).toBeDefined();
    const sql = String(call![0]);
    expect(sql).toContain('INSERT INTO roosync_dashboard_retirements');
    expect(sql).toContain('ON CONFLICT (source_key) DO UPDATE SET');
    expect(sql).toContain('lifted_at = NULL');
    expect(sql).not.toContain('DELETE FROM roosync_dashboards');
    expect(call![1]).toEqual(['k (1)', 'k', 'myia-ai-01:roo-extensions']);
  });

  test('unretire: UPDATE lifted_at = COALESCE(lifted_at, NOW()) on the ACTIVE mark only', async () => {
    const outcome = await writer.unretireRooSyncDashboardKeyChecked('k (1)');
    expect(outcome).toEqual({ ok: true, reason: 'written' });
    const call = mockQuery.mock.calls.find(c => String(c[0]).includes('roosync_dashboard_retirements'));
    expect(call).toBeDefined();
    const sql = String(call![0]);
    expect(sql).toContain('UPDATE roosync_dashboard_retirements');
    expect(sql).toContain('SET lifted_at = COALESCE(lifted_at, NOW())');
    expect(sql).toContain('WHERE source_key = $1 AND lifted_at IS NULL');
    expect(call![1]).toEqual(['k (1)']);
  });
});

// ─── Concrete reader — SQL shapes + lifted filtering ───────────────────────

describe('PgUnifiedStoreReader retirement SQL shape', () => {
  const reader = new PgUnifiedStoreReader({ connectionString: 'postgres://t:t@localhost:5432/x' });

  // Warm the pool once — init() pings via client.query('SELECT 1'), which
  // must not consume a test's mockResolvedValueOnce.
  beforeAll(async () => {
    await reader.init();
  });

  test('getRooSyncDashboardRetirement: active marks only, Date → ISO mapping', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        source_key: 'machine-x (1)',
        target_key: 'machine-x',
        retired_by: 'myia-ai-01:roo-extensions',
        retired_at: new Date('2026-09-26T09:00:00.000Z'),
      }],
    });
    const mark = await reader.getRooSyncDashboardRetirement('machine-x (1)');
    expect(mark).toEqual({
      sourceKey: 'machine-x (1)',
      targetKey: 'machine-x',
      retiredBy: 'myia-ai-01:roo-extensions',
      retiredAt: '2026-09-26T09:00:00.000Z',
    });
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain('FROM roosync_dashboard_retirements');
    expect(sql).toContain('lifted_at IS NULL');
    expect(mockQuery.mock.calls[0][1]).toEqual(['machine-x (1)']);
  });

  test('getRooSyncDashboardRetirement: no active mark → null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(reader.getRooSyncDashboardRetirement('k (1)')).resolves.toBeNull();
  });

  test('listRetiredRooSyncDashboardKeys: active keys only', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ source_key: 'a (1)' }, { source_key: 'b (2)' }] });
    await expect(reader.listRetiredRooSyncDashboardKeys()).resolves.toEqual(['a (1)', 'b (2)']);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain('SELECT source_key FROM roosync_dashboard_retirements');
    expect(sql).toContain('lifted_at IS NULL');
  });
});
