/**
 * UnifiedStoreReader — Phase A smoke tests.
 *
 * Validates that the scaffold compiles, the null object is a true no-op,
 * and the skeleton class throws to flag accidental wiring before Phase C.
 *
 * No live Postgres required.
 *
 * @issue #2426 (Epic #2191)
 */

import { describe, it, expect } from 'vitest';
import {
  UnifiedStoreReader,
  NullUnifiedStoreReader,
} from '../../../../src/services/unified-store/index.js';

describe('NullUnifiedStoreReader', () => {
  it('init/close are no-op', async () => {
    const r = new NullUnifiedStoreReader();
    await expect(r.init()).resolves.toBeUndefined();
    await expect(r.close()).resolves.toBeUndefined();
  });

  it('getConversation returns null', async () => {
    const r = new NullUnifiedStoreReader();
    await expect(r.getConversation('t-1')).resolves.toBeNull();
  });

  it('getMessages returns []', async () => {
    const r = new NullUnifiedStoreReader();
    await expect(r.getMessages('t-1')).resolves.toEqual([]);
  });

  it('joinFromQdrant returns []', async () => {
    const r = new NullUnifiedStoreReader();
    await expect(
      r.joinFromQdrant([{ task_id: 't-1', score: 0.9 }]),
    ).resolves.toEqual([]);
  });

  it('ping returns false', async () => {
    const r = new NullUnifiedStoreReader();
    await expect(r.ping()).resolves.toBe(false);
  });
});

describe('UnifiedStoreReader (Phase A skeleton)', () => {
  it('throws not implemented on init', async () => {
    const r = new UnifiedStoreReader({ connectionString: 'postgres://x' });
    await expect(r.init()).rejects.toThrow(/Phase A scaffold/);
  });

  it('throws not implemented on joinFromQdrant', async () => {
    const r = new UnifiedStoreReader({ connectionString: 'postgres://x' });
    await expect(
      r.joinFromQdrant([{ task_id: 't-1', score: 0.9 }]),
    ).rejects.toThrow(/Phase A scaffold/);
  });
});
