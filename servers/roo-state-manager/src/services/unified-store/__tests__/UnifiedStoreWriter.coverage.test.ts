/**
 * Coverage tests for UnifiedStoreWriter.ts (Issue #2426, Phase A interface + Null).
 *
 * Targets the Null object — its base interface implementation:
 *   - init/close are no-ops
 *   - upsertConversation resolves without throwing
 *   - upsertConversationOnly resolves without throwing
 *   - upsertMessages resolves without throwing
 *   - ping returns false
 *
 * Pure test, no pg, no env vars.
 */

import { describe, test, expect } from 'vitest';
import { NullUnifiedStoreWriter } from '../UnifiedStoreWriter.js';
import type { ConversationBundle, ConversationRow, MessageRow } from '../types.js';

function makeConversationRow(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    task_id: 'task-1',
    machine_id: 'machine-1',
    harness: 'roo',
    workspace: null,
    parent_task_id: null,
    title: 'Sample',
    first_ts: '2026-01-01T00:00:00Z',
    last_ts: '2026-01-02T00:00:00Z',
    msg_count: 0,
    metadata: null,
    ...overrides,
  };
}

function makeMessageRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    task_id: 'task-1',
    message_id: null,
    seq: 0,
    role: 'user',
    content: 'hi',
    tool_calls: null,
    ts: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeBundle(): ConversationBundle {
  return {
    conversation: makeConversationRow(),
    messages: [makeMessageRow({ seq: 0 }), makeMessageRow({ seq: 1, role: 'assistant' })],
  };
}

describe('NullUnifiedStoreWriter — silent no-op contract', () => {
  test('init() resolves without throwing', async () => {
    const w = new NullUnifiedStoreWriter();
    await expect(w.init()).resolves.toBeUndefined();
  });

  test('close() resolves without throwing', async () => {
    const w = new NullUnifiedStoreWriter();
    await expect(w.close()).resolves.toBeUndefined();
  });

  test('init() then close() are idempotent (multiple cycles)', async () => {
    const w = new NullUnifiedStoreWriter();
    for (let i = 0; i < 3; i++) {
      await w.init();
      await w.close();
    }
    // No throw — verified by reaching here.
  });

  test('upsertConversation(bundle) resolves without throwing', async () => {
    const w = new NullUnifiedStoreWriter();
    await expect(w.upsertConversation(makeBundle())).resolves.toBeUndefined();
  });

  test('upsertConversation(empty bundle) resolves without throwing', async () => {
    const w = new NullUnifiedStoreWriter();
    await expect(
      w.upsertConversation({ conversation: makeConversationRow(), messages: [] })
    ).resolves.toBeUndefined();
  });

  test('upsertConversationOnly(row) resolves without throwing', async () => {
    const w = new NullUnifiedStoreWriter();
    await expect(w.upsertConversationOnly(makeConversationRow())).resolves.toBeUndefined();
  });

  test('upsertConversationOnly(row with all null fields) resolves without throwing', async () => {
    const w = new NullUnifiedStoreWriter();
    await expect(
      w.upsertConversationOnly(
        makeConversationRow({
          workspace: null,
          parent_task_id: null,
          title: null,
          first_ts: null,
          last_ts: null,
          metadata: null,
        })
      )
    ).resolves.toBeUndefined();
  });

  test('upsertMessages([]) resolves without throwing', async () => {
    const w = new NullUnifiedStoreWriter();
    await expect(w.upsertMessages([])).resolves.toBeUndefined();
  });

  test('upsertMessages(non-empty array) resolves without throwing', async () => {
    const w = new NullUnifiedStoreWriter();
    const messages: MessageRow[] = [
      makeMessageRow({ seq: 0 }),
      makeMessageRow({ seq: 1, role: 'assistant' }),
      makeMessageRow({ seq: 2, role: 'system' }),
      makeMessageRow({ seq: 3, role: 'tool' }),
    ];
    await expect(w.upsertMessages(messages)).resolves.toBeUndefined();
  });

  test('ping() returns false', async () => {
    const w = new NullUnifiedStoreWriter();
    expect(await w.ping()).toBe(false);
  });

  test('multiple Null instances are independent', async () => {
    const a = new NullUnifiedStoreWriter();
    const b = new NullUnifiedStoreWriter();
    expect(a).not.toBe(b);
    await expect(a.upsertConversation(makeBundle())).resolves.toBeUndefined();
    await expect(b.upsertConversationOnly(makeConversationRow())).resolves.toBeUndefined();
  });

  test('all methods callable in any order without error', async () => {
    const w = new NullUnifiedStoreWriter();
    await w.close(); // close before init
    await w.init();
    await w.upsertConversation(makeBundle());
    await w.upsertConversationOnly(makeConversationRow());
    await w.upsertMessages([]);
    expect(await w.ping()).toBe(false);
    await w.close();
  });
});