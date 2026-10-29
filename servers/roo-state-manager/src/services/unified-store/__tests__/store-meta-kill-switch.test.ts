/**
 * store-meta honours the PG emergency kill-switch (#4131, review ms#1563).
 *
 * Every other PG surface gates on `isPgFlagOn('UNIFIED_STORE_DUAL_WRITE')`;
 * store-meta gated on the URL alone, so a seat flipped back to GDrive-only
 * with `UNIFIED_STORE_DUAL_WRITE=0` still read and wrote its machine registry
 * and inventory rows in PG.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const pgClientCtor = vi.fn();
vi.mock('pg', () => ({
  default: {
    Client: vi.fn().mockImplementation((...args: unknown[]) => {
      pgClientCtor(...args);
      throw new Error('pg must not be reached when the kill-switch is set');
    }),
  },
}));

import {
  storeMetaUrl,
  readStoreMetaValue,
  upsertStoreMetaValue,
} from '../store-meta.js';

const URL = 'postgres://user@pg.invalid:5432/roosync';

describe('store-meta — kill-switch UNIFIED_STORE_DUAL_WRITE', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      UNIFIED_STORE_PG_URL: process.env.UNIFIED_STORE_PG_URL,
      UNIFIED_STORE_DUAL_WRITE: process.env.UNIFIED_STORE_DUAL_WRITE,
    };
    process.env.UNIFIED_STORE_PG_URL = URL;
    pgClientCtor.mockClear();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('serves the URL by default when the flag is unset', () => {
    delete process.env.UNIFIED_STORE_DUAL_WRITE;
    expect(storeMetaUrl()).toBe(URL);
  });

  it.each(['0', 'false', 'off', 'disabled'])('returns null when the flag is %s', (off) => {
    process.env.UNIFIED_STORE_DUAL_WRITE = off;
    expect(storeMetaUrl()).toBeNull();
  });

  it('read and upsert never reach PG under the kill-switch', async () => {
    process.env.UNIFIED_STORE_DUAL_WRITE = '0';
    await expect(readStoreMetaValue('machine_registry')).resolves.toBeNull();
    // Callers gate on storeMetaUrl() first; a direct upsert fails loudly, never reaching pg.
    await expect(upsertStoreMetaValue('machine_registry', '{"machines":{}}')).rejects.toThrow(/kill-switch/);
    expect(pgClientCtor).not.toHaveBeenCalled();
  });
});
