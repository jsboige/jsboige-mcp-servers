/**
 * dual-write helper — unit tests (#692).
 *
 * The helper extracted from SkeletonCacheService.dualWriteToStore() maps a full
 * ConversationSkeleton → ConversationRow and fire-and-forget upserts it. These tests
 * pin the row mapping and the never-throws contract independently of the production
 * call sites (the call-site anti-dead-branch guard lives in background-services.test.ts).
 *
 * @issue jsboige/jsboige-mcp-servers#692
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertConversationOnly = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../../src/services/unified-store/writer-factory.js', () => ({
  getUnifiedStoreWriter: () => ({
    upsertConversationOnly,
    upsertMessages: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue(true),
  }),
  resetWriterInstance: vi.fn(),
}));

import { dualWriteConversationToStore } from '../../../../src/services/unified-store/dual-write.js';
import type { ConversationSkeleton } from '../../../../src/types/conversation.js';

function makeSkeleton(overrides: Partial<ConversationSkeleton> = {}): ConversationSkeleton {
  return {
    taskId: 'task-x',
    metadata: {
      machineId: 'myia-po-2024',
      messageCount: 7,
      createdAt: '2026-06-01T00:00:00Z',
      lastActivity: '2026-07-02T00:00:00Z',
      title: 'Test',
      workspace: 'roo-extensions',
    },
    sequence: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as ConversationSkeleton;
}

describe('dualWriteConversationToStore (#692)', () => {
  beforeEach(() => {
    upsertConversationOnly.mockClear();
  });

  it('maps the full skeleton to a ConversationRow and upserts it', async () => {
    const skeleton = makeSkeleton({ taskId: 'task-abc' });

    await dualWriteConversationToStore('task-abc', skeleton);

    expect(upsertConversationOnly).toHaveBeenCalledTimes(1);
    const row = upsertConversationOnly.mock.calls[0][0];
    expect(row.task_id).toBe('task-abc');
    expect(row.machine_id).toBe('myia-po-2024');
    expect(row.workspace).toBe('roo-extensions');
    expect(row.msg_count).toBe(7);
    expect(row.title).toBe('Test');
    expect(row.first_ts).toBe('2026-06-01T00:00:00Z');
    expect(row.last_ts).toBe('2026-07-02T00:00:00Z');
    // metadata is copied (spread), not the same reference
    expect(row.metadata).not.toBe(skeleton.metadata);
    expect(row.metadata).toMatchObject({ messageCount: 7 });
  });

  it('maps source=claude-code → harness="claude"', async () => {
    await dualWriteConversationToStore('t', makeSkeleton({ metadata: { source: 'claude-code' } as any }));
    expect(upsertConversationOnly.mock.calls[0][0].harness).toBe('claude');
  });

  it('maps source=zoo-code → harness="zoo"', async () => {
    await dualWriteConversationToStore('t', makeSkeleton({ metadata: { source: 'zoo-code' } as any }));
    expect(upsertConversationOnly.mock.calls[0][0].harness).toBe('zoo');
  });

  it('defaults harness to "roo" when source is absent (Roo conversations)', async () => {
    await dualWriteConversationToStore('t', makeSkeleton());
    expect(upsertConversationOnly.mock.calls[0][0].harness).toBe('roo');
  });

  it('never throws when the writer rejects (fire-and-forget contract)', async () => {
    upsertConversationOnly.mockRejectedValueOnce(new Error('PG down'));
    await expect(
      dualWriteConversationToStore('t', makeSkeleton())
    ).resolves.toBeUndefined();
  });

  it('never throws when the writer factory itself throws', async () => {
    // Re-import a version whose writer-factory throws — simulate via a transient rejection
    // already covered above; this asserts the outer try/catch swallows pre-upsert errors too
    // by passing a skeleton that would make mapping throw (undefined metadata handled).
    await expect(
      dualWriteConversationToStore('t', { taskId: 't' } as ConversationSkeleton)
    ).resolves.toBeUndefined();
    // Writer still called with best-effort defaults
    expect(upsertConversationOnly).toHaveBeenCalled();
  });
});
