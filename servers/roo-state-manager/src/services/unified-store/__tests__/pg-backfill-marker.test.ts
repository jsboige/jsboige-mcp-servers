/**
 * Backfill completeness markers (#4131, review ms#1540 BLOCKER).
 *
 * What this suite pins:
 *   1. the marker is read from `roosync_store_meta` in ONE query, on a
 *      short-lived client that is always closed;
 *   2. a marker present ⇒ 'complete', absent ⇒ 'absent';
 *   3. every failure (table missing, PG unreachable) ⇒ 'absent' — the
 *      fail-safe direction (GDrive keeps serving) — UNLESS the scope was
 *      already proven complete: a failed refresh keeps 'complete', only a
 *      successful lookup without the marker closes it;
 *   4. the lookup is BOUNDED: one query per TTL, never one per call;
 *   5. no PG URL on the host ⇒ 'absent', no query at all.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue({ rows: [] }),
  end: vi.fn().mockResolvedValue(undefined),
  configs: [] as unknown[],
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mocks.info, warn: mocks.warn, error: vi.fn() }),
}));

vi.mock('pg', () => ({
  default: {
    Client: class {
      constructor(config: unknown) {
        mocks.configs.push(config);
      }
      connect = mocks.connect;
      query = mocks.query;
      end = mocks.end;
    },
  },
}));

import {
  CHANNEL_BACKFILL_META_KEY,
  DASHBOARD_BACKFILL_META_KEY,
  backfillMarkerTtlMs,
  getBackfillMarkerState,
  refreshBackfillMarkers,
  resetBackfillMarkerCache,
  setBackfillMarkerState,
} from '../pg-backfill-marker.js';

const PG_URL = 'postgres://t:t@localhost:5432/x';

describe('backfill completeness marker (#4131)', () => {
  beforeEach(() => {
    mocks.connect.mockReset().mockResolvedValue(undefined);
    mocks.query.mockReset().mockResolvedValue({ rows: [] });
    mocks.end.mockReset().mockResolvedValue(undefined);
    mocks.configs.length = 0;
    mocks.info.mockReset();
    mocks.warn.mockReset();
    delete process.env.UNIFIED_STORE_PG_URL;
    delete process.env.UNIFIED_STORE_BACKFILL_MARKER_TTL_MS;
    resetBackfillMarkerCache();
  });

  afterEach(() => {
    delete process.env.UNIFIED_STORE_PG_URL;
    delete process.env.UNIFIED_STORE_BACKFILL_MARKER_TTL_MS;
    resetBackfillMarkerCache();
  });

  test('no PG URL on the host ⇒ absent, and NO query is issued', async () => {
    await refreshBackfillMarkers(true);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(getBackfillMarkerState('channel')).toBe('absent');
    expect(getBackfillMarkerState('dashboard')).toBe('absent');
  });

  test('a marker row ⇒ complete', async () => {
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    mocks.query.mockResolvedValue({
      rows: [{ key: CHANNEL_BACKFILL_META_KEY, value: '2026-10-27T18:00:00.000Z' }],
    });
    await refreshBackfillMarkers(true);
    expect(getBackfillMarkerState('channel')).toBe('complete');
    // The other scope keeps its own answer.
    expect(getBackfillMarkerState('dashboard')).toBe('absent');
  });

  test('both markers present ⇒ both scopes complete (ONE query)', async () => {
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    mocks.query.mockResolvedValue({
      rows: [
        { key: CHANNEL_BACKFILL_META_KEY, value: '2026-10-27T18:00:00.000Z' },
        { key: DASHBOARD_BACKFILL_META_KEY, value: '2026-10-27T18:05:00.000Z' },
      ],
    });
    await refreshBackfillMarkers(true);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(getBackfillMarkerState('channel')).toBe('complete');
    expect(getBackfillMarkerState('dashboard')).toBe('complete');
  });

  test('an empty marker value does NOT count as complete', async () => {
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    mocks.query.mockResolvedValue({
      rows: [{ key: CHANNEL_BACKFILL_META_KEY, value: '   ' }],
    });
    await refreshBackfillMarkers(true);
    expect(getBackfillMarkerState('channel')).toBe('absent');
  });

  test('a failing lookup ⇒ absent (the fail-safe direction), and the client is closed', async () => {
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    mocks.query.mockRejectedValue(new Error('relation "roosync_store_meta" does not exist'));
    await refreshBackfillMarkers(true);
    expect(getBackfillMarkerState('channel')).toBe('absent');
    expect(getBackfillMarkerState('dashboard')).toBe('absent');
    expect(mocks.end).toHaveBeenCalled();
  });

  test('a failing CONNECT ⇒ absent, and the client is closed anyway', async () => {
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    mocks.connect.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await refreshBackfillMarkers(true);
    expect(getBackfillMarkerState('channel')).toBe('absent');
    expect(mocks.end).toHaveBeenCalled();
  });

  test('the lookup is bounded: a fresh cache issues NO query on the next read', async () => {
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    await refreshBackfillMarkers(true);
    const callsAfterRefresh = mocks.query.mock.calls.length;
    // Ten gate consultations, same TTL window: no extra query.
    for (let i = 0; i < 10; i++) getBackfillMarkerState('channel');
    expect(mocks.query.mock.calls.length).toBe(callsAfterRefresh);
  });

  test('a stale cache triggers exactly ONE new lookup', async () => {
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    process.env.UNIFIED_STORE_BACKFILL_MARKER_TTL_MS = '1';
    await refreshBackfillMarkers(true);
    const before = mocks.query.mock.calls.length;
    // Let the 1 ms TTL expire — deterministic, not a race with the clock.
    await new Promise((resolve) => setTimeout(resolve, 10));
    getBackfillMarkerState('channel');
    getBackfillMarkerState('channel');
    getBackfillMarkerState('dashboard');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // One refresh for the three consultations (the in-flight guard suppresses
    // the other two).
    expect(mocks.query.mock.calls.length).toBe(before + 1);
  });

  test('the TTL is configurable and defaults to 5 minutes', () => {
    expect(backfillMarkerTtlMs()).toBe(300_000);
    process.env.UNIFIED_STORE_BACKFILL_MARKER_TTL_MS = '1000';
    expect(backfillMarkerTtlMs()).toBe(1000);
    process.env.UNIFIED_STORE_BACKFILL_MARKER_TTL_MS = 'not-a-number';
    expect(backfillMarkerTtlMs()).toBe(300_000);
  });

  describe('a failed refresh never downgrades a proven complete (#4131, ai-01 01/11 16:43-16:57Z)', () => {
    async function proveBothComplete(): Promise<void> {
      process.env.UNIFIED_STORE_PG_URL = PG_URL;
      mocks.query.mockResolvedValue({
        rows: [
          { key: CHANNEL_BACKFILL_META_KEY, value: '2026-10-27T18:00:00.000Z' },
          { key: DASHBOARD_BACKFILL_META_KEY, value: '2026-10-27T18:05:00.000Z' },
        ],
      });
      await refreshBackfillMarkers(true);
      expect(getBackfillMarkerState('channel')).toBe('complete');
      expect(getBackfillMarkerState('dashboard')).toBe('complete');
    }

    test('a failing query after a proof keeps both scopes complete', async () => {
      await proveBothComplete();
      mocks.query.mockReset().mockRejectedValue(new Error('Connection terminated unexpectedly'));
      await refreshBackfillMarkers(true);
      expect(getBackfillMarkerState('channel')).toBe('complete');
      expect(getBackfillMarkerState('dashboard')).toBe('complete');
      expect(mocks.end).toHaveBeenCalled();
    });

    test('a failing CONNECT after a proof keeps the scope complete', async () => {
      await proveBothComplete();
      mocks.connect.mockReset().mockRejectedValue(new Error('connect ETIMEDOUT'));
      await refreshBackfillMarkers(true);
      expect(getBackfillMarkerState('channel')).toBe('complete');
    });

    test('only the proven scope is kept — an absent one stays absent', async () => {
      process.env.UNIFIED_STORE_PG_URL = PG_URL;
      mocks.query.mockResolvedValue({
        rows: [{ key: CHANNEL_BACKFILL_META_KEY, value: '2026-10-27T18:00:00.000Z' }],
      });
      await refreshBackfillMarkers(true);
      mocks.query.mockReset().mockRejectedValue(new Error('Connection terminated unexpectedly'));
      await refreshBackfillMarkers(true);
      expect(getBackfillMarkerState('channel')).toBe('complete');
      expect(getBackfillMarkerState('dashboard')).toBe('absent');
    });

    test('a SUCCESSFUL lookup that no longer finds the marker still closes the scope', async () => {
      await proveBothComplete();
      mocks.query.mockReset().mockRejectedValue(new Error('Connection terminated unexpectedly'));
      await refreshBackfillMarkers(true);
      mocks.query.mockReset().mockResolvedValue({ rows: [] });
      await refreshBackfillMarkers(true);
      expect(getBackfillMarkerState('channel')).toBe('absent');
      expect(getBackfillMarkerState('dashboard')).toBe('absent');
    });

    test('the kept state stays bounded: a failed refresh restarts the TTL, no query storm while PG is down', async () => {
      // Only Date is faked: the clock cannot cross the TTL behind the test's
      // back on a loaded runner, while promises and setTimeout stay real.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-11-01T16:43:00.000Z'));
        process.env.UNIFIED_STORE_BACKFILL_MARKER_TTL_MS = '200';
        await proveBothComplete();
        // Let the proof go stale, so only the failed refresh can make it fresh.
        vi.setSystemTime(Date.now() + 250);
        mocks.query.mockReset().mockRejectedValue(new Error('Connection terminated unexpectedly'));
        await refreshBackfillMarkers(true);
        const afterFailure = mocks.query.mock.calls.length;
        for (let i = 0; i < 10; i++) getBackfillMarkerState('channel');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(mocks.query.mock.calls.length).toBe(afterFailure);
        expect(getBackfillMarkerState('channel')).toBe('complete');
      } finally {
        vi.useRealTimers();
      }
    });

    test('a failed lookup logs the failure, never "marker absent" — only a successful lookup does', async () => {
      const markerAbsentLines = () =>
        mocks.info.mock.calls.filter(([line]) => String(line).includes("marker in PG")).length;
      process.env.UNIFIED_STORE_PG_URL = PG_URL;
      mocks.query.mockRejectedValue(new Error('connect ECONNREFUSED'));
      await refreshBackfillMarkers(true);
      expect(getBackfillMarkerState('channel')).toBe('absent');
      expect(mocks.warn).toHaveBeenCalledTimes(1);
      expect(markerAbsentLines()).toBe(0);
      // Control: the same scope after a SUCCESSFUL empty lookup does say it.
      resetBackfillMarkerCache();
      mocks.query.mockReset().mockResolvedValue({ rows: [] });
      await refreshBackfillMarkers(true);
      expect(markerAbsentLines()).toBe(2);
    });

    test('the channel PG-primary gate stays ON through a failed refresh', async () => {
      const { isChannelPgPrimaryEnabled, isDashboardPgPrimaryEnabled } = await import('../pg-read-gates.js');
      delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
      delete process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY;
      delete process.env.UNIFIED_STORE_DUAL_WRITE;
      await proveBothComplete();
      expect(isChannelPgPrimaryEnabled()).toBe(true);
      mocks.query.mockReset().mockRejectedValue(new Error('Connection terminated unexpectedly'));
      await refreshBackfillMarkers(true);
      expect(isChannelPgPrimaryEnabled()).toBe(true);
      expect(isDashboardPgPrimaryEnabled()).toBe(true);
    });
  });

  test('the forced state (test seam) is returned as-is', () => {
    setBackfillMarkerState('channel', 'complete');
    expect(getBackfillMarkerState('channel')).toBe('complete');
    setBackfillMarkerState('channel', 'absent');
    expect(getBackfillMarkerState('channel')).toBe('absent');
  });
});
