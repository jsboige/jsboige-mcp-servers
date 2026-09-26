/**
 * #3782 locks-off-Drive — consultative lock: store wrapper + concrete SQL shapes.
 *
 * The lock row lives in `roosync_dashboard_locks` (migrations/009):
 *   - `acquireDashboardSharedLock` forwards to the writer through the factory,
 *     races a 3s timeout and degrades EVERY failure mode (Null writer, error,
 *     hang) to 'unavailable' so the caller falls back to its machine-local lock;
 *   - `releaseDashboardSharedLock` is best-effort (TTL steal recovers);
 *   - the concrete writer: atomic INSERT wins, conflict + age >= TTL steals on
 *     the single PG clock, fresh conflict = 'held'; release is
 *     ownership-checked (holder equality) — never DELETE WHERE lock_key only.
 */
import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';

const mockTryAcquire = vi.fn().mockResolvedValue('unavailable');
const mockRelease = vi.fn().mockResolvedValue(undefined);

vi.mock('../writer-factory.js', () => ({
  getUnifiedStoreWriter: () => ({
    tryAcquireRooSyncDashboardLock: mockTryAcquire,
    releaseRooSyncDashboardLock: mockRelease,
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
  acquireDashboardSharedLock,
  releaseDashboardSharedLock,
} from '../roosync-dashboard-store.js';
import { PgUnifiedStoreWriter } from '../PgUnifiedStoreWriter.js';
import { NullUnifiedStoreWriter } from '../UnifiedStoreWriter.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockTryAcquire.mockReset().mockResolvedValue('unavailable');
  mockRelease.mockReset().mockResolvedValue(undefined);
  mockQuery.mockReset().mockResolvedValue({ rows: [] });
  mockConnect.mockReset().mockResolvedValue({ query: mockQuery, release: vi.fn() });
});

// ─── Store wrapper — degradation contract ──────────────────────────────────

describe('acquireDashboardSharedLock (wrapper, fail-open to machine-local layer)', () => {
  const HOLDER = JSON.stringify({ machineId: 'm', pid: 1, acquiredAt: '2026-09-26T09:00:00.000Z' });

  test('forwards lockKey, holderJson and ttl verbatim; passes the status through', async () => {
    mockTryAcquire.mockResolvedValueOnce('acquired');
    await expect(acquireDashboardSharedLock('condense:k', HOLDER, 900000)).resolves.toBe('acquired');
    expect(mockTryAcquire).toHaveBeenCalledWith('condense:k', HOLDER, 900000);

    mockTryAcquire.mockResolvedValueOnce('held');
    await expect(acquireDashboardSharedLock('append:k', HOLDER, 30000)).resolves.toBe('held');
    expect(mockTryAcquire).toHaveBeenLastCalledWith('append:k', HOLDER, 30000);
  });

  test('writer throws → unavailable + warn (TypeError on a lock-less writer mock heals the same way)', async () => {
    mockTryAcquire.mockRejectedValueOnce(new Error('pool hung'));
    await expect(acquireDashboardSharedLock('condense:k', HOLDER, 1000)).resolves.toBe('unavailable');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('machine-local layer takes over'),
      expect.objectContaining({ lockKey: 'condense:k' })
    );
  });

  test('writer hang → unavailable after the 3s op timeout (the race, not just rejections)', async () => {
    vi.useFakeTimers();
    try {
      mockTryAcquire.mockImplementation(() => new Promise(() => {}));
      const pending = acquireDashboardSharedLock('condense:k', HOLDER, 1000);
      await vi.advanceTimersByTimeAsync(3100);
      await expect(pending).resolves.toBe('unavailable');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('releaseDashboardSharedLock (best-effort)', () => {
  test('forwards lockKey and holderJson; a rejection is swallowed', async () => {
    const HOLDER = JSON.stringify({ machineId: 'm', pid: 1, acquiredAt: 't' });
    await releaseDashboardSharedLock('condense:k', HOLDER);
    expect(mockRelease).toHaveBeenCalledWith('condense:k', HOLDER);

    mockRelease.mockRejectedValueOnce(new Error('PG down'));
    await expect(releaseDashboardSharedLock('condense:k', HOLDER)).resolves.toBeUndefined();
  });

  test('writer hang → resolves after the 3s op timeout', async () => {
    vi.useFakeTimers();
    try {
      mockRelease.mockImplementation(() => new Promise(() => {}));
      const pending = releaseDashboardSharedLock('append:k', '{}');
      await vi.advanceTimersByTimeAsync(3100);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Concrete writer — SQL shapes (atomic INSERT, TTL steal, ownership release)

describe('PgUnifiedStoreWriter lock SQL shape', () => {
  const writer = new PgUnifiedStoreWriter({ connectionString: 'postgres://t:t@localhost:5432/x' });
  const HOLDER = JSON.stringify({ machineId: 'myia-web1', pid: 42, acquiredAt: '2026-09-26T09:00:00.000Z' });

  // Warm the pool once — init() pings via client.query('SELECT 1'), which must
  // not consume a test's mockResolvedValueOnce (same pattern as the retirement
  // suite).
  beforeAll(async () => {
    await writer.init();
  });

  test('free row → INSERT ON CONFLICT DO NOTHING wins → acquired', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await expect(writer.tryAcquireRooSyncDashboardLock('condense:k', HOLDER, 900000)).resolves.toBe('acquired');
    expect(mockQuery).toHaveBeenCalledTimes(1); // le steal ne court JAMAIS quand l'INSERT gagne
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('INSERT INTO roosync_dashboard_locks');
    expect(String(sql)).toContain('ON CONFLICT (lock_key) DO NOTHING');
    expect(params).toEqual(['condense:k', HOLDER]);
  });

  test('conflict + row older than TTL → the UPDATE steal wins → acquired (single PG clock)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });  // INSERT conflict
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });  // steal UPDATE matched
    await expect(writer.tryAcquireRooSyncDashboardLock('append:k', HOLDER, 30000)).resolves.toBe('acquired');
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [sql, params] = mockQuery.mock.calls[1];
    expect(String(sql)).toContain('UPDATE roosync_dashboard_locks');
    expect(String(sql)).toContain('acquired_at < NOW() - ($3::double precision * interval \'1 millisecond\')');
    expect(params).toEqual(['append:k', HOLDER, 30000]);
  });

  test('conflict + FRESH holder (steal matches nothing) → held', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    await expect(writer.tryAcquireRooSyncDashboardLock('condense:k', HOLDER, 900000)).resolves.toBe('held');
  });

  test('PG error PROPAGATES — the wrapper owns the degradation, not the writer', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));
    await expect(writer.tryAcquireRooSyncDashboardLock('condense:k', HOLDER, 1000)).rejects.toThrow('connection refused');
  });

  test('release: ownership-checked DELETE (holder equality, jamais key seule)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await writer.releaseRooSyncDashboardLock('condense:k', HOLDER);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('DELETE FROM roosync_dashboard_locks');
    expect(String(sql)).toContain('WHERE lock_key = $1 AND holder = $2::jsonb');
    expect(params).toEqual(['condense:k', HOLDER]);
  });
});

// ─── Null writer — no PG half configured ────────────────────────────────────

describe('NullUnifiedStoreWriter — hôte sans PG', () => {
  const nullWriter = new NullUnifiedStoreWriter();

  test('acquire → unavailable (machine-local layer takes over)', async () => {
    await expect(nullWriter.tryAcquireRooSyncDashboardLock('condense:k', '{}', 1000)).resolves.toBe('unavailable');
  });

  test('release → no-op, ne jette jamais', async () => {
    await expect(nullWriter.releaseRooSyncDashboardLock('condense:k', '{}')).resolves.toBeUndefined();
  });
});
