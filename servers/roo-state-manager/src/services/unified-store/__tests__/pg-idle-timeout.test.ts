/**
 * idleTimeoutMillis plumbing — reader & writer pools must recycle idle
 * clients (#4731 nocturnal pg-unavailable waves, 2026-11-17)
 *
 * pg's default idleTimeoutMillis is 0 (never close an idle client). Seats
 * idle for hours overnight; whatever sits between them and PG (NAT, proxy,
 * server-side idle kill) then silently drops the pooled sockets. The pool
 * keeps handing out dead clients — the first query on them stalls until the
 * TCP retransmit timeout, and ×10 hosts firing their cron simultaneously
 * produced the observed >15 s pg-unavailable waves (dashboard-pg answered in
 * 13-106 ms on the same seconds: only the channel-pg pool was stranded).
 *
 * A finite idleTimeoutMillis closes idle clients PROACTIVELY; the next use
 * opens a fresh connection — a controlled ~100-300 ms reconnect bounded by
 * the existing 15 s connectionTimeoutMillis (#2191), instead of a dead
 * socket surfaced as a stall.
 *
 * These tests pin the plumbing: default 30000ms, config override, env
 * override in both factories — same shape as pg-connection-timeout.test.ts.
 *
 * @module services/unified-store/__tests__/pg-idle-timeout.test
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const mockPool = {
  on: vi.fn(),
  connect: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() })),
  query: vi.fn(),
  end: vi.fn(async () => undefined),
};

vi.mock('pg', () => ({
  default: { Pool: vi.fn(() => mockPool) },
}));

import pg from 'pg';
import { PgUnifiedStoreReader } from '../PgUnifiedStoreReader.js';
import { PgUnifiedStoreWriter } from '../PgUnifiedStoreWriter.js';
import { getUnifiedStoreReader, resetReaderInstance } from '../reader-factory.js';
import { getUnifiedStoreWriter, resetWriterInstance } from '../writer-factory.js';

const PoolMock = vi.mocked(pg.Pool);

const PG_URL = 'postgres://test:test@localhost:5432/unified_store';

async function initReader(config?: { idleTimeoutMillis?: number }) {
  const reader = new PgUnifiedStoreReader({ connectionString: PG_URL, ...config });
  await reader.init();
  return reader;
}

async function initWriter(config?: { idleTimeoutMillis?: number }) {
  const writer = new PgUnifiedStoreWriter({ connectionString: PG_URL, ...config });
  await writer.init();
  return writer;
}

describe('idleTimeoutMillis plumbing (#4731 nocturnal waves)', () => {
  beforeEach(() => {
    PoolMock.mockClear();
    resetReaderInstance();
    resetWriterInstance();
  });

  afterEach(() => {
    delete process.env.UNIFIED_STORE_DUAL_WRITE;
    delete process.env.UNIFIED_STORE_PG_URL;
    delete process.env.UNIFIED_STORE_POOL_MAX;
    delete process.env.UNIFIED_STORE_TIMEOUT_MS;
    delete process.env.UNIFIED_STORE_CONNECT_TIMEOUT_MS;
    delete process.env.UNIFIED_STORE_IDLE_TIMEOUT_MS;
  });

  test('reader pool defaults to 30000ms idleTimeoutMillis (not pg default 0)', async () => {
    await initReader();
    expect(PoolMock).toHaveBeenCalledTimes(1);
    expect(PoolMock.mock.calls[0][0]).toMatchObject({ idleTimeoutMillis: 30000 });
  });

  test('writer pool defaults to 30000ms idleTimeoutMillis (not pg default 0)', async () => {
    await initWriter();
    expect(PoolMock).toHaveBeenCalledTimes(1);
    expect(PoolMock.mock.calls[0][0]).toMatchObject({ idleTimeoutMillis: 30000 });
  });

  test('reader honors explicit idleTimeoutMillis config', async () => {
    await initReader({ idleTimeoutMillis: 250 });
    expect(PoolMock.mock.calls[0][0]).toMatchObject({ idleTimeoutMillis: 250 });
  });

  test('writer honors explicit idleTimeoutMillis config', async () => {
    await initWriter({ idleTimeoutMillis: 250 });
    expect(PoolMock.mock.calls[0][0]).toMatchObject({ idleTimeoutMillis: 250 });
  });

  test('reader-factory plumbs UNIFIED_STORE_IDLE_TIMEOUT_MS', async () => {
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    process.env.UNIFIED_STORE_IDLE_TIMEOUT_MS = '1234';
    const reader = getUnifiedStoreReader();
    await reader.init();
    expect(PoolMock.mock.calls[0][0]).toMatchObject({ idleTimeoutMillis: 1234 });
  });

  test('writer-factory plumbs UNIFIED_STORE_IDLE_TIMEOUT_MS', async () => {
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    process.env.UNIFIED_STORE_IDLE_TIMEOUT_MS = '2345';
    const writer = getUnifiedStoreWriter();
    await writer.init();
    expect(PoolMock.mock.calls[0][0]).toMatchObject({ idleTimeoutMillis: 2345 });
  });
});
