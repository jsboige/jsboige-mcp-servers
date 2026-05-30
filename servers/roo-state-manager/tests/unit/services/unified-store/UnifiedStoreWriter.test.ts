/**
 * UnifiedStoreWriter — Phase A smoke tests.
 *
 * Validates that the scaffold compiles, the null object is a true no-op,
 * and the skeleton class throws to flag accidental wiring before Phase B.
 *
 * No live Postgres required.
 *
 * @issue #2426 (Epic #2191)
 */

import { describe, it, expect } from 'vitest';
import {
  UnifiedStoreWriter,
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

describe('UnifiedStoreWriter (Phase A skeleton)', () => {
  it('throws not implemented on init', async () => {
    const w = new UnifiedStoreWriter({ connectionString: 'postgres://x' });
    await expect(w.init()).rejects.toThrow(/Phase A scaffold/);
  });

  it('throws not implemented on upsertConversation', async () => {
    const w = new UnifiedStoreWriter({ connectionString: 'postgres://x' });
    await expect(w.upsertConversation(dummyBundle)).rejects.toThrow(/Phase A scaffold/);
  });
});
