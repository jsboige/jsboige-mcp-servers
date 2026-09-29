/**
 * Behavioral fallback test — unreachable PG must REJECT fast, not hang (#2191
 * deep-queue, 2026-09-29)
 *
 * Real network, no pg mock (separate file so vi.mock hoisting can't leak here):
 * 10.255.255.1 is an unallocated RFC1918 address — dropped SYN on every sane
 * network. With connectionTimeoutMillis the connect must reject within the
 * bound; without it the promise hangs until the OS TCP timeout and the file
 * fallback never triggers.
 *
 * The 3s race bound doubles as a regression sentinel: if someone drops
 * connectionTimeoutMillis, this test fails on the race instead of hanging CI.
 *
 * @module services/unified-store/__tests__/pg-connection-timeout.e2e.test
 */

import { describe, test, expect } from 'vitest';
import { PgUnifiedStoreReader } from '../PgUnifiedStoreReader.js';
import { readChannelInboxFromPg } from '../roosync-channel-read.js';

// Unallocated RFC1918 — no route, dropped SYN (fast EHOSTUNREACH on some
// networks is equally fine: the assertion is "rejects within the bound", not
// "waits the full timeout").
const UNREACHABLE_URL = 'postgres://test:test@10.255.255.1:5432/unified_store';
const CONNECT_TIMEOUT_MS = 300;
const RACE_BOUND_MS = 3000;

describe('PG unreachable → fast reject, file fallback (#2191 deep-queue)', () => {
  test('init() rejects within the bound instead of hanging', async () => {
    const reader = new PgUnifiedStoreReader({
      connectionString: UNREACHABLE_URL,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });

    const startedAt = Date.now();
    const raced = await Promise.race([
      reader.init().then(
        () => 'resolved',
        () => 'rejected'
      ),
      new Promise<'still-hanging'>(resolve =>
        setTimeout(() => resolve('still-hanging'), RACE_BOUND_MS)
      ),
    ]);

    try {
      expect(raced).toBe('rejected');
      expect(Date.now() - startedAt).toBeLessThan(RACE_BOUND_MS);
    } finally {
      await reader.close();
    }
  });

  test('readChannelInboxFromPg returns null (GDrive fallback) — bounded, not hanging', async () => {
    const reader = new PgUnifiedStoreReader({
      connectionString: UNREACHABLE_URL,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });

    const startedAt = Date.now();
    const raced = await Promise.race([
      readChannelInboxFromPg(reader, 'myia-po-2024').then(
        items => (items === null ? 'null-fallback' : `unexpected-items:${items.length}`),
        () => 'rejected'
      ),
      new Promise<'still-hanging'>(resolve =>
        setTimeout(() => resolve('still-hanging'), RACE_BOUND_MS)
      ),
    ]);

    try {
      // null = the documented contract: caller falls back to the GDrive path.
      expect(raced).toBe('null-fallback');
      expect(Date.now() - startedAt).toBeLessThan(RACE_BOUND_MS);
    } finally {
      await reader.close();
    }
  });
});
