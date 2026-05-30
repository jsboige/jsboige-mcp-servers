/**
 * writer-factory — Phase B unit tests.
 *
 * Tests the factory that creates the correct writer based on env vars.
 * No live Postgres required.
 *
 * @issue #2426 Phase B (Epic #2191)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getUnifiedStoreWriter,
  resetWriterInstance,
} from '../../../../src/services/unified-store/writer-factory.js';
import { NullUnifiedStoreWriter } from '../../../../src/services/unified-store/UnifiedStoreWriter.js';
import { PgUnifiedStoreWriter } from '../../../../src/services/unified-store/PgUnifiedStoreWriter.js';

describe('writer-factory', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetWriterInstance();
    // Clear env vars
    delete process.env.UNIFIED_STORE_DUAL_WRITE;
    delete process.env.UNIFIED_STORE_PG_URL;
  });

  afterEach(() => {
    resetWriterInstance();
    // Restore env
    process.env = { ...originalEnv };
  });

  it('returns NullUnifiedStoreWriter when UNIFIED_STORE_DUAL_WRITE is unset', () => {
    const writer = getUnifiedStoreWriter();
    expect(writer).toBeInstanceOf(NullUnifiedStoreWriter);
  });

  it('returns NullUnifiedStoreWriter when UNIFIED_STORE_DUAL_WRITE is "0"', () => {
    process.env.UNIFIED_STORE_DUAL_WRITE = '0';
    const writer = getUnifiedStoreWriter();
    expect(writer).toBeInstanceOf(NullUnifiedStoreWriter);
  });

  it('returns NullUnifiedStoreWriter when UNIFIED_STORE_DUAL_WRITE is "1" but no PG URL', () => {
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    // No UNIFIED_STORE_PG_URL set
    const writer = getUnifiedStoreWriter();
    expect(writer).toBeInstanceOf(NullUnifiedStoreWriter);
  });

  it('returns PgUnifiedStoreWriter when both env vars are set', () => {
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://user:pass@localhost:5433/unified_store';
    const writer = getUnifiedStoreWriter();
    expect(writer).toBeInstanceOf(PgUnifiedStoreWriter);
  });

  it('returns the same instance on repeated calls (singleton)', () => {
    const w1 = getUnifiedStoreWriter();
    const w2 = getUnifiedStoreWriter();
    expect(w1).toBe(w2);
  });

  it('resetWriterInstance allows creating a new instance', () => {
    const w1 = getUnifiedStoreWriter();
    resetWriterInstance();
    const w2 = getUnifiedStoreWriter();
    expect(w1).not.toBe(w2);
  });
});
