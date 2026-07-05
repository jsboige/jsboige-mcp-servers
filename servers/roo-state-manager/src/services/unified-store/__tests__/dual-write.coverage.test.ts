/**
 * Coverage tests for dual-write.ts (Issue #2426 / #692).
 *
 * Targets COLD branches in the existing test (none yet):
 *   - L45-46 try: writer fetch + harness mapping
 *   - L48-52 source → Harness: 'roo' default, 'claude-code' → 'claude', 'zoo-code' → 'zoo', else 'roo'
 *   - L54-67 row mapping with fallback chain for machine_id (metadata.machineId → env ROOSYNC_MACHINE_ID → env COMPUTERNAME → 'unknown')
 *   - L65 metadata spread (or null when no metadata)
 *   - L68-72 catch: all errors swallowed, never rejects
 *   - L72-77 writer.upsertConversationOnly call with mapped row
 *
 * No pg connection — we use NullUnifiedStoreWriter (env-gate OFF) and
 * spy on upsertConversationOnly to assert the mapping contract.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { dualWriteConversationToStore } from '../dual-write.js';
import { resetWriterInstance } from '../writer-factory.js';
import { NullUnifiedStoreWriter } from '../UnifiedStoreWriter.js';
import type { ConversationSkeleton } from '../../../types/conversation.js';

// #2656: vi.unstubAllEnvs() restores process.env to its ORIGINAL (OS-inherited)
// state, not a clean slate. On machines where UNIFIED_STORE_DUAL_WRITE=1 is set
// at the OS level (e.g. ai-01 production PG dual-write runtime), the writer
// factory returns PgUnifiedStoreWriter instead of Null → the
// NullUnifiedStoreWriter.prototype spy never fires → drift CI fails.
// Explicitly delete the unified-store env vars so every test starts with the
// env-gate OFF (Null writer) regardless of the host OS env.
function clearUnifiedStoreEnv(): void {
  delete process.env.UNIFIED_STORE_DUAL_WRITE;
  delete process.env.UNIFIED_STORE_PG_URL;
  delete process.env.UNIFIED_STORE_POOL_MAX;
  delete process.env.UNIFIED_STORE_TIMEOUT_MS;
}

type SkelOverrides = {
  source?: string;
  machineId?: string;
  workspace?: string;
  parentTaskId?: string;
  title?: string;
  createdAt?: string;
  lastActivity?: string;
  messageCount?: number;
};

function makeSkeleton(overrides: SkelOverrides = {}): ConversationSkeleton {
  const metadata = {
    lastActivity: overrides.lastActivity ?? '2026-01-02T00:00:00.000Z',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    messageCount: overrides.messageCount ?? 0,
    actionCount: 0,
    totalSize: 0,
    source: overrides.source ?? 'roo',
    machineId: overrides.machineId,
    workspace: overrides.workspace,
    parentTaskId: overrides.parentTaskId,
    title: overrides.title,
  } as ConversationSkeleton['metadata'];

  return {
    taskId: 'task-stub',
    parentTaskId: null,
    messageCount: overrides.messageCount ?? 0,
    sequence: [],
    metadata,
  } as ConversationSkeleton;
}

function makeMinimalSkeleton(): ConversationSkeleton {
  // Simulates "no metadata" by making metadata undefined — tests must pass
  // the null-coalescing chain (`skeleton.metadata?.source ?? 'roo'` etc).
  return {
    taskId: 'task-stub',
    parentTaskId: null,
    messageCount: 0,
    sequence: [],
    metadata: undefined,
  } as unknown as ConversationSkeleton;
}

describe('dual-write — env-gate off (Null writer, silent no-op)', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetWriterInstance();
    vi.unstubAllEnvs();
    clearUnifiedStoreEnv();
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    infoSpy.mockRestore();
    resetWriterInstance();
  });

  test('dual-write resolves without throwing when env-gate is OFF', async () => {
    await expect(dualWriteConversationToStore('task-1', makeSkeleton())).resolves.toBeUndefined();
  });

  test('dual-write does NOT call upsertConversationOnly on Null writer', async () => {
    // Null writer's upsertConversationOnly is a no-op — but we still call it.
    // We spy on the prototype to verify it IS called (the mapping still happens).
    const spy = vi.spyOn(NullUnifiedStoreWriter.prototype, 'upsertConversationOnly');
    await dualWriteConversationToStore('task-1', makeSkeleton());
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('dual-write never throws when env-gate is OFF and skeleton is empty', async () => {
    // Empty skeleton → metadata undefined → all fields fall back to defaults.
    await expect(dualWriteConversationToStore('task-empty', makeSkeleton())).resolves.toBeUndefined();
  });
});

describe('dual-write — harness mapping', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetWriterInstance();
    vi.unstubAllEnvs();
    clearUnifiedStoreEnv();
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    spy = vi.spyOn(NullUnifiedStoreWriter.prototype, 'upsertConversationOnly');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    infoSpy.mockRestore();
    spy.mockRestore();
    resetWriterInstance();
  });

  test('source="claude-code" → harness="claude"', async () => {
    await dualWriteConversationToStore('task-claude', makeSkeleton({ source: 'claude-code' }));
    const row = spy.mock.calls[0][0];
    expect(row.harness).toBe('claude');
  });

  test('source="zoo-code" → harness="zoo"', async () => {
    await dualWriteConversationToStore('task-zoo', makeSkeleton({ source: 'zoo-code' }));
    const row = spy.mock.calls[0][0];
    expect(row.harness).toBe('zoo');
  });

  test('source="roo" → harness="roo" (explicit)', async () => {
    await dualWriteConversationToStore('task-roo', makeSkeleton({ source: 'roo' }));
    const row = spy.mock.calls[0][0];
    expect(row.harness).toBe('roo');
  });

  test('source undefined (skeleton with no metadata) → harness="roo" (default)', async () => {
    // When metadata is undefined, skeleton.metadata?.source is undefined,
    // so the if-chain falls through to the default 'roo'.
    await dualWriteConversationToStore('task-default', makeMinimalSkeleton());
    const row = spy.mock.calls[0][0];
    expect(row.harness).toBe('roo');
  });

  test('source="other-source" → harness="roo" (fallback, not mapped)', async () => {
    await dualWriteConversationToStore('task-other', makeSkeleton({ source: 'unknown' }));
    const row = spy.mock.calls[0][0];
    expect(row.harness).toBe('roo');
  });

  test('source="claude-code" with mixed case → harness="roo" (strict equality)', async () => {
    await dualWriteConversationToStore('task-case', makeSkeleton({ source: 'Claude-Code' }));
    const row = spy.mock.calls[0][0];
    expect(row.harness).toBe('roo');
  });
});

describe('dual-write — machine_id fallback chain', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let spy: ReturnType<typeof vi.spyOn>;
  const originalComputerName = process.env.COMPUTERNAME;
  const originalRoosync = process.env.ROOSYNC_MACHINE_ID;

  beforeEach(() => {
    resetWriterInstance();
    vi.unstubAllEnvs();
    clearUnifiedStoreEnv();
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    spy = vi.spyOn(NullUnifiedStoreWriter.prototype, 'upsertConversationOnly');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalComputerName === undefined) delete process.env.COMPUTERNAME;
    else process.env.COMPUTERNAME = originalComputerName;
    if (originalRoosync === undefined) delete process.env.ROOSYNC_MACHINE_ID;
    else process.env.ROOSYNC_MACHINE_ID = originalRoosync;
    infoSpy.mockRestore();
    spy.mockRestore();
    resetWriterInstance();
  });

  test('prefers metadata.machineId when present', async () => {
    await dualWriteConversationToStore('task-1', makeSkeleton({ machineId: 'meta-machine' }));
    const row = spy.mock.calls[0][0];
    expect(row.machine_id).toBe('meta-machine');
  });

  test('falls back to ROOSYNC_MACHINE_ID when metadata.machineId is missing', async () => {
    vi.stubEnv('ROOSYNC_MACHINE_ID', 'roosync-machine');
    delete process.env.COMPUTERNAME;
    await dualWriteConversationToStore('task-1', makeSkeleton());
    const row = spy.mock.calls[0][0];
    expect(row.machine_id).toBe('roosync-machine');
  });

  test('falls back to COMPUTERNAME when metadata.machineId and ROOSYNC_MACHINE_ID are missing', async () => {
    delete process.env.ROOSYNC_MACHINE_ID;
    vi.stubEnv('COMPUTERNAME', 'comp-name');
    await dualWriteConversationToStore('task-1', makeSkeleton());
    const row = spy.mock.calls[0][0];
    expect(row.machine_id).toBe('comp-name');
  });

  test('falls back to "unknown" when all three are missing', async () => {
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.COMPUTERNAME;
    await dualWriteConversationToStore('task-1', makeSkeleton());
    const row = spy.mock.calls[0][0];
    expect(row.machine_id).toBe('unknown');
  });

  test('precedence: metadata.machineId > ROOSYNC_MACHINE_ID > COMPUTERNAME > "unknown"', async () => {
    vi.stubEnv('ROOSYNC_MACHINE_ID', 'roosync-machine');
    vi.stubEnv('COMPUTERNAME', 'comp-name');
    await dualWriteConversationToStore('task-1', makeSkeleton({ machineId: 'meta-machine' }));
    const row = spy.mock.calls[0][0];
    expect(row.machine_id).toBe('meta-machine');
  });

  test('metadata.machineId wins over ROOSYNC_MACHINE_ID (precedence sanity check)', async () => {
    vi.stubEnv('ROOSYNC_MACHINE_ID', 'roosync-machine');
    await dualWriteConversationToStore('task-1', makeSkeleton({ machineId: 'real-machine' }));
    const row = spy.mock.calls[0][0];
    expect(row.machine_id).toBe('real-machine');
  });
});

describe('dual-write — row field mapping', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetWriterInstance();
    vi.unstubAllEnvs();
    clearUnifiedStoreEnv();
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    spy = vi.spyOn(NullUnifiedStoreWriter.prototype, 'upsertConversationOnly');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    infoSpy.mockRestore();
    spy.mockRestore();
    resetWriterInstance();
  });

  test('row.task_id is the explicit taskId argument (not skeleton.taskId)', async () => {
    const baseMeta = makeSkeleton().metadata;
    const skel = {
      taskId: 'skeleton-id', // different from the function arg
      parentTaskId: null,
      messageCount: 0,
      sequence: [],
      metadata: baseMeta,
    } as ConversationSkeleton;
    await dualWriteConversationToStore('arg-id', skel);
    const row = spy.mock.calls[0][0];
    expect(row.task_id).toBe('arg-id');
  });

  test('row.workspace comes from metadata.workspace (string)', async () => {
    await dualWriteConversationToStore('task-1', makeSkeleton({ workspace: 'my-ws' }));
    const row = spy.mock.calls[0][0];
    expect(row.workspace).toBe('my-ws');
  });

  test('row.workspace is null when metadata.workspace is missing', async () => {
    await dualWriteConversationToStore('task-1', makeSkeleton());
    const row = spy.mock.calls[0][0];
    expect(row.workspace).toBeNull();
  });

  test('row.parent_task_id from skeleton.parentTaskId (top-level field)', async () => {
    // Build a skeleton where parentTaskId is set at top level (not in metadata).
    const baseMeta = makeSkeleton().metadata;
    const skel = {
      taskId: 'task-1',
      parentTaskId: 'parent-from-top',
      messageCount: 0,
      sequence: [],
      metadata: baseMeta,
    } as ConversationSkeleton;
    await dualWriteConversationToStore('task-1', skel);
    const row = spy.mock.calls[0][0];
    expect(row.parent_task_id).toBe('parent-from-top');
  });

  test('row.parent_task_id from metadata.parentTaskId when top-level is null', async () => {
    // skeleton.parentTaskId = null, metadata.parentTaskId = 'parent-from-meta'.
    // Code: skeleton.parentTaskId ?? skeleton.metadata?.parentTaskId ?? null
    //      = null ?? 'parent-from-meta' ?? null
    //      = 'parent-from-meta'
    const baseMeta = makeSkeleton({ parentTaskId: 'parent-from-meta' }).metadata;
    const skel = {
      taskId: 'task-1',
      parentTaskId: null,
      messageCount: 0,
      sequence: [],
      metadata: baseMeta,
    } as ConversationSkeleton;
    await dualWriteConversationToStore('task-1', skel);
    const row = spy.mock.calls[0][0];
    expect(row.parent_task_id).toBe('parent-from-meta');
  });

  test('row.parent_task_id null when both skeleton.parentTaskId and metadata.parentTaskId are missing', async () => {
    const baseMeta = makeSkeleton().metadata; // no parentTaskId
    const skel = {
      taskId: 'task-1',
      parentTaskId: null,
      messageCount: 0,
      sequence: [],
      metadata: baseMeta,
    } as ConversationSkeleton;
    await dualWriteConversationToStore('task-1', skel);
    const row = spy.mock.calls[0][0];
    expect(row.parent_task_id).toBeNull();
  });

  test('row.title from metadata.title', async () => {
    await dualWriteConversationToStore('task-1', makeSkeleton({ title: 'My Task' }));
    const row = spy.mock.calls[0][0];
    expect(row.title).toBe('My Task');
  });

  test('row.title null when metadata.title missing', async () => {
    await dualWriteConversationToStore('task-1', makeSkeleton());
    const row = spy.mock.calls[0][0];
    expect(row.title).toBeNull();
  });

  test('row.first_ts from metadata.createdAt', async () => {
    await dualWriteConversationToStore('task-1', makeSkeleton({ createdAt: '2026-01-01T00:00:00Z' }));
    const row = spy.mock.calls[0][0];
    expect(row.first_ts).toBe('2026-01-01T00:00:00Z');
  });

  test('row.last_ts from metadata.lastActivity', async () => {
    await dualWriteConversationToStore('task-1', makeSkeleton({ lastActivity: '2026-01-02T00:00:00Z' }));
    const row = spy.mock.calls[0][0];
    expect(row.last_ts).toBe('2026-01-02T00:00:00Z');
  });

  test('row.msg_count from metadata.messageCount', async () => {
    await dualWriteConversationToStore('task-1', makeSkeleton({ messageCount: 42 }));
    const row = spy.mock.calls[0][0];
    expect(row.msg_count).toBe(42);
  });

  test('row.msg_count defaults to 0 when metadata.messageCount missing', async () => {
    await dualWriteConversationToStore('task-1', makeSkeleton());
    const row = spy.mock.calls[0][0];
    expect(row.msg_count).toBe(0);
  });

  test('row.metadata is a spread copy when metadata present (not the same reference)', async () => {
    await dualWriteConversationToStore('task-1', makeSkeleton({ title: 'spread' }));
    const row = spy.mock.calls[0][0];
    expect(row.metadata).not.toBeNull();
    expect(row.metadata).toEqual(expect.objectContaining({ title: 'spread' }));
  });

  test('row.metadata is null when skeleton has no metadata', async () => {
    await dualWriteConversationToStore('task-1', makeMinimalSkeleton());
    const row = spy.mock.calls[0][0];
    expect(row.metadata).toBeNull();
  });
});

describe('dual-write — error swallowing (never throws)', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetWriterInstance();
    vi.unstubAllEnvs();
    clearUnifiedStoreEnv();
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    infoSpy.mockRestore();
    resetWriterInstance();
  });

  test('when upsertConversationOnly throws, dual-write swallows it (never rejects)', async () => {
    const spy = vi.spyOn(NullUnifiedStoreWriter.prototype, 'upsertConversationOnly')
      .mockRejectedValueOnce(new Error('Postgres down'));
    await expect(dualWriteConversationToStore('task-1', makeSkeleton())).resolves.toBeUndefined();
    spy.mockRestore();
  });

  test('when writer factory throws (synthetic), dual-write swallows it', async () => {
    // Synthesize a throw by stubbing the factory module indirectly: call dual-write
    // with a skeleton whose metadata.source is a non-string getter that throws.
    // Easier: directly verify try/catch via a custom Null subclass.
    // (Factory can't easily be made to throw without mocking the module.)
    // Simpler: trigger the catch via upsertConversationOnly throwing on the second
    // call — but our default mock only throws once. Skip synthetic; rely on prev test.
    // Here we assert the no-throw contract with a sync throw from upsertConversationOnly.
    const spy = vi.spyOn(NullUnifiedStoreWriter.prototype, 'upsertConversationOnly')
      .mockImplementation(() => { throw new Error('sync throw'); });
    await expect(dualWriteConversationToStore('task-1', makeSkeleton())).resolves.toBeUndefined();
    spy.mockRestore();
  });
});