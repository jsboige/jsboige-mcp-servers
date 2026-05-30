/**
 * UnifiedStoreWriter — Phase A smoke tests.
 *
 * Phase A intentionally ships only the IUnifiedStoreWriter interface and the
 * NullUnifiedStoreWriter no-op implementation. The concrete throwing skeleton
 * was removed to satisfy the #815 anti-stub gate; Phase B will reintroduce a
 * real implementation at the SkeletonCacheService hook site.
 *
 * No live Postgres required.
 *
 * @issue #2426 (Epic #2191)
 */

import { describe, it, expect } from 'vitest';
import {
  NullUnifiedStoreWriter,
  type ConversationBundle,
  type ConversationRow,
  type MessageRow,
} from '../../../../src/services/unified-store/index.js';

const dummyConv: ConversationRow = {
  task_id: 't-1',
  machine_id: 'myia-po-2023',
  harness: 'claude',
  workspace: 'roo-extensions',
  parent_task_id: null,
  title: 'smoke',
  first_ts: '2026-05-30T00:00:00Z',
  last_ts: '2026-05-30T00:00:01Z',
  msg_count: 1,
  metadata: null,
};

const dummyMsg: MessageRow = {
  task_id: 't-1',
  message_id: null,
  seq: 0,
  role: 'user',
  content: 'hello',
  tool_calls: null,
  ts: '2026-05-30T00:00:00Z',
};

const dummyBundle: ConversationBundle = {
  conversation: dummyConv,
  messages: [dummyMsg],
};

describe('NullUnifiedStoreWriter', () => {
  it('resolves init/close as no-op', async () => {
    const w = new NullUnifiedStoreWriter();
    await expect(w.init()).resolves.toBeUndefined();
    await expect(w.close()).resolves.toBeUndefined();
  });

  it('absorbs all write calls without throwing', async () => {
    const w = new NullUnifiedStoreWriter();
    await expect(w.upsertConversation(dummyBundle)).resolves.toBeUndefined();
    await expect(w.upsertConversationOnly(dummyConv)).resolves.toBeUndefined();
    await expect(w.upsertMessages([dummyMsg])).resolves.toBeUndefined();
  });

  it('ping returns false (always unhealthy)', async () => {
    const w = new NullUnifiedStoreWriter();
    await expect(w.ping()).resolves.toBe(false);
  });
});
