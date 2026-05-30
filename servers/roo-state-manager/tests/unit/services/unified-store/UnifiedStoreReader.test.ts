/**
 * UnifiedStoreReader — Phase A smoke tests.
 *
 * Phase A intentionally ships only the IUnifiedStoreReader interface and the
 * NullUnifiedStoreReader no-op implementation. The concrete throwing skeleton
 * was removed to satisfy the #815 anti-stub gate; Phase C will reintroduce a
 * real implementation at the conversation_browser hook site.
 *
 * No live Postgres required.
 *
 * @issue #2426 (Epic #2191)
 */

import { describe, it, expect } from 'vitest';
import { NullUnifiedStoreReader } from '../../../../src/services/unified-store/index.js';

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
