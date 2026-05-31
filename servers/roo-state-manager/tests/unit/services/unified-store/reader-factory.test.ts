/**
 * reader-factory — Phase C unit tests.
 *
 * Tests the factory that creates the correct reader based on env vars.
 *
 * @issue #2426 Phase C (Epic #2191)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getUnifiedStoreReader,
  resetReaderInstance,
} from '../../../../src/services/unified-store/reader-factory.js';
import { NullUnifiedStoreReader } from '../../../../src/services/unified-store/UnifiedStoreReader.js';
import { PgUnifiedStoreReader } from '../../../../src/services/unified-store/PgUnifiedStoreReader.js';

describe('reader-factory', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetReaderInstance();
    delete process.env.UNIFIED_STORE_DUAL_WRITE;
    delete process.env.UNIFIED_STORE_PG_URL;
  });

  afterEach(() => {
    resetReaderInstance();
    process.env = { ...originalEnv };
  });

  it('returns NullUnifiedStoreReader when UNIFIED_STORE_DUAL_WRITE is unset', () => {
    const reader = getUnifiedStoreReader();
    expect(reader).toBeInstanceOf(NullUnifiedStoreReader);
  });

  it('returns NullUnifiedStoreReader when UNIFIED_STORE_DUAL_WRITE is "0"', () => {
    process.env.UNIFIED_STORE_DUAL_WRITE = '0';
    const reader = getUnifiedStoreReader();
    expect(reader).toBeInstanceOf(NullUnifiedStoreReader);
  });

  it('returns NullUnifiedStoreReader when DUAL_WRITE=1 but no PG URL', () => {
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    const reader = getUnifiedStoreReader();
    expect(reader).toBeInstanceOf(NullUnifiedStoreReader);
  });

  it('returns PgUnifiedStoreReader when both env vars are set', () => {
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://user:pass@localhost:5433/unified_store';
    const reader = getUnifiedStoreReader();
    expect(reader).toBeInstanceOf(PgUnifiedStoreReader);
  });

  it('returns the same instance on repeated calls (singleton)', () => {
    const r1 = getUnifiedStoreReader();
    const r2 = getUnifiedStoreReader();
    expect(r1).toBe(r2);
  });

  it('resetReaderInstance allows creating a new instance', () => {
    const r1 = getUnifiedStoreReader();
    resetReaderInstance();
    const r2 = getUnifiedStoreReader();
    expect(r1).not.toBe(r2);
  });
});
