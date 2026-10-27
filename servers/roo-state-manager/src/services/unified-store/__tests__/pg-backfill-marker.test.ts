/**
 * Backfill completeness markers (#4131, review ms#1540 BLOCKER).
 *
 * What this suite pins:
 *   1. the marker is read from `roosync_store_meta` in ONE query, on a
 *      short-lived client that is always closed;
 *   2. a marker present ⇒ 'complete', absent ⇒ 'absent';
 *   3. every failure (table missing, PG unreachable) ⇒ 'absent' — the
 *      fail-safe direction (GDrive keeps serving);
 *   4. the lookup is BOUNDED: one query per TTL, never one per call;
 *   5. no PG URL on the host ⇒ 'absent', no query at all.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue({ rows: [] }),
  end: vi.fn().mockResolvedValue(undefined),
  configs: [] as unknown[],
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

  test('the forced state (test seam) is returned as-is', () => {
    setBackfillMarkerState('channel', 'complete');
    expect(getBackfillMarkerState('channel')).toBe('complete');
    setBackfillMarkerState('channel', 'absent');
    expect(getBackfillMarkerState('channel')).toBe('absent');
  });
});
