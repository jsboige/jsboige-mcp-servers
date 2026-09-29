/**
 * connectionTimeoutMillis plumbing — reader & writer pools must bound
 * connection establishment (#2191 deep-queue, 2026-09-29)
 *
 * Without connectionTimeoutMillis, a dropped-SYN PG host hangs pool.connect()
 * until the OS TCP timeout (~20-120s+) — the GDrive/file fallback catch never
 * fires because the promise never rejects. These tests pin the plumbing:
 * default 5000ms, config override, and env override in both factories.
 *
 * The behavioral test (real network, unreachable host, fast reject → null
 * fallback) lives in pg-connection-timeout.e2e.test.ts.
 *
 * @module services/unified-store/__tests__/pg-connection-timeout.test
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

async function initReader(config?: { connectionTimeoutMillis?: number }) {
  const reader = new PgUnifiedStoreReader({ connectionString: PG_URL, ...config });
  await reader.init();
  return reader;
}

async function initWriter(config?: { connectionTimeoutMillis?: number }) {
  const writer = new PgUnifiedStoreWriter({ connectionString: PG_URL, ...config });
  await writer.init();
  return writer;
}

describe('connectionTimeoutMillis plumbing (#2191 deep-queue)', () => {
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
  });

  test('reader pool defaults to 5000ms connectionTimeoutMillis', async () => {
    await initReader();
    expect(PoolMock).toHaveBeenCalledTimes(1);
    expect(PoolMock.mock.calls[0][0]).toMatchObject({ connectionTimeoutMillis: 5000 });
  });

  test('writer pool defaults to 5000ms connectionTimeoutMillis', async () => {
    await initWriter();
    expect(PoolMock).toHaveBeenCalledTimes(1);
    expect(PoolMock.mock.calls[0][0]).toMatchObject({ connectionTimeoutMillis: 5000 });
  });

  test('reader honors explicit connectionTimeoutMillis config', async () => {
    await initReader({ connectionTimeoutMillis: 250 });
    expect(PoolMock.mock.calls[0][0]).toMatchObject({ connectionTimeoutMillis: 250 });
  });

  test('writer honors explicit connectionTimeoutMillis config', async () => {
    await initWriter({ connectionTimeoutMillis: 250 });
    expect(PoolMock.mock.calls[0][0]).toMatchObject({ connectionTimeoutMillis: 250 });
  });

  test('reader-factory plumbs UNIFIED_STORE_CONNECT_TIMEOUT_MS', async () => {
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    process.env.UNIFIED_STORE_CONNECT_TIMEOUT_MS = '1234';
    const reader = getUnifiedStoreReader();
    await reader.init();
    expect(PoolMock.mock.calls[0][0]).toMatchObject({ connectionTimeoutMillis: 1234 });
  });

  test('writer-factory plumbs UNIFIED_STORE_CONNECT_TIMEOUT_MS', async () => {
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    process.env.UNIFIED_STORE_CONNECT_TIMEOUT_MS = '2345';
    const writer = getUnifiedStoreWriter();
    await writer.init();
    expect(PoolMock.mock.calls[0][0]).toMatchObject({ connectionTimeoutMillis: 2345 });
  });
});
