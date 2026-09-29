/**
 * Tests for the PG conversation-list read path (list_conversations PG tier).
 *
 * Covers:
 *   - the env gate: OFF by default, OFF without a PG URL, OFF on a Null reader,
 *     and read at CALL time (togglable without a process restart)
 *   - resolveLabel: the coalesce that keeps this tier from REGRESSING labels.
 *     `title` is NULL on 79.8% of live rows, so a title-only mapping would ship
 *     unlabelled conversations — that case is asserted explicitly.
 *   - mapRowToSkeleton: marker dataSource, harness -> source, empty sequence,
 *     and NO fabricated per-role counts
 *   - loadPgConversationTier: dedup against the tiers already loaded, the
 *     `truncated` flag when the cap is reached, and graceful degradation
 *     (a throwing reader yields status 'failed', never an exception)
 *   - loadPgConversationSkeleton (#2191, the `view` body load): same gate, the
 *     cold-pool init, paging, user/assistant mapping, and null on every
 *     degraded path so `view` keeps its historical answer
 *   - the SQL SHAPE of PgUnifiedStoreReader.listConversations, asserted against
 *     captured query text. This is a shape assertion, NOT acceptance: what the
 *     query actually returns was measured against the live store separately.
 *
 * The reader factory is mocked, so no Postgres is needed.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConversationListRow } from '../UnifiedStoreReader.js';
import type { ConversationRow, MessageRow } from '../types.js';

// ─── Reader factory mock (controllable double) ──────────────────────

const mockListConversations = vi.fn().mockResolvedValue([]);
const mockIsNull = vi.fn().mockReturnValue(false);
const mockInit = vi.fn().mockResolvedValue(undefined);
const mockGetConversation = vi.fn().mockResolvedValue(null);
const mockGetMessages = vi.fn().mockResolvedValue([]);

vi.mock('../reader-factory.js', () => ({
  getUnifiedStoreReader: () => ({
    isNull: () => mockIsNull(),
    listConversations: mockListConversations,
    init: mockInit,
    getConversation: mockGetConversation,
    getMessages: mockGetMessages,
  }),
  resetReaderInstance: vi.fn(),
}));

// ─── pg mock (SQL shape assertions on the concrete reader) ──────────

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: vi.fn() });
const mockPool = { on: vi.fn(), connect: mockConnect, query: mockQuery, end: vi.fn() };

vi.mock('pg', () => ({ default: { Pool: vi.fn(() => mockPool) } }));

// ─── Logger mock (the degradation warn must be observable) ──────────

const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }));

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    warn: mockLoggerWarn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { PgUnifiedStoreReader } from '../PgUnifiedStoreReader.js';
import {
  getConversationListPgReader,
  resolveLabel,
  mapRowToSkeleton,
  loadPgConversationTier,
  loadPgConversationSkeleton,
  PG_DATA_SOURCE,
  DEFAULT_PG_LIST_LIMIT,
  PG_VIEW_PAGE_SIZE,
} from '../conversation-list-store.js';

// ─── Fixtures ───────────────────────────────────────────────────────

function row(overrides: Partial<ConversationListRow> = {}): ConversationListRow {
  return {
    task_id: 'task-1',
    machine_id: 'myia-po-2025',
    harness: 'roo',
    workspace: 'd:/dev/CoursIA',
    parent_task_id: null,
    title: 'A stored title',
    first_ts: '2026-09-05T12:14:55.368Z',
    last_ts: '2026-09-06T03:37:15.817Z',
    msg_count: 1320,
    metadata: null,
    first_user_message: null,
    ...overrides,
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  mockIsNull.mockReturnValue(false);
  mockListConversations.mockResolvedValue([]);
  mockInit.mockResolvedValue(undefined);
  mockGetConversation.mockResolvedValue(null);
  mockGetMessages.mockResolvedValue([]);
  // clearAllMocks wipes implementations too — re-arm the pg double so the
  // SQL-shape block below gets a usable pool on every test.
  mockQuery.mockResolvedValue({ rows: [] });
  mockConnect.mockResolvedValue({ query: mockQuery, release: vi.fn() });
  process.env.UNIFIED_STORE_CONVERSATION_READ_PG = '1';
  process.env.UNIFIED_STORE_PG_URL = 'postgres://user@host:5432/db';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ─── Gate ───────────────────────────────────────────────────────────

describe('getConversationListPgReader — the gate', () => {
  test('returns null when the flag is unset (default: this tier is OFF)', () => {
    delete process.env.UNIFIED_STORE_CONVERSATION_READ_PG;
    expect(getConversationListPgReader()).toBeNull();
  });

  test('returns null when the flag is any value other than "1"', () => {
    process.env.UNIFIED_STORE_CONVERSATION_READ_PG = 'true';
    expect(getConversationListPgReader()).toBeNull();
  });

  test('returns null when no PG URL is configured', () => {
    delete process.env.UNIFIED_STORE_PG_URL;
    expect(getConversationListPgReader()).toBeNull();
  });

  test('returns null when the factory handed back a Null reader', () => {
    mockIsNull.mockReturnValue(true);
    expect(getConversationListPgReader()).toBeNull();
  });

  test('returns the reader when flag + URL + non-Null reader all hold', () => {
    expect(getConversationListPgReader()).not.toBeNull();
  });

  test('is read at CALL time, not import time (togglable without a restart)', () => {
    expect(getConversationListPgReader()).not.toBeNull();
    delete process.env.UNIFIED_STORE_CONVERSATION_READ_PG;
    expect(getConversationListPgReader()).toBeNull();
    process.env.UNIFIED_STORE_CONVERSATION_READ_PG = '1';
    expect(getConversationListPgReader()).not.toBeNull();
  });
});

// ─── Label resolution ───────────────────────────────────────────────

describe('resolveLabel — the coalesce that prevents a label regression', () => {
  test('prefers the title column when present', () => {
    expect(resolveLabel(row({ title: 'A stored title' }))).toBe('A stored title');
  });

  test('falls back to metadata.title when the column is NULL', () => {
    expect(resolveLabel(row({ title: null, metadata: { title: 'From metadata' } })))
      .toBe('From metadata');
  });

  test('falls back to the first user message — the 79.8%-NULL-title case', () => {
    // This is the regression the module exists to prevent: on the live store
    // title is NULL on 79.8% of rows, and 8,289 of those 10,278 rows do carry a
    // first user message. Mapping title straight through would have shipped
    // those conversations unlabelled.
    const r = row({ title: null, metadata: null, first_user_message: 'Fix the failing build' });
    expect(resolveLabel(r)).toBe('Fix the failing build');
  });

  test('treats a whitespace-only title as absent', () => {
    expect(resolveLabel(row({ title: '   ', first_user_message: 'real content' })))
      .toBe('real content');
  });

  test('returns undefined when no source has content (no invented label)', () => {
    expect(resolveLabel(row({ title: null, metadata: null, first_user_message: null })))
      .toBeUndefined();
  });

  test('flattens newlines and caps the length', () => {
    const label = resolveLabel(row({ title: null, first_user_message: 'a\n\nb   c' }));
    expect(label).toBe('a b c');

    const long = resolveLabel(row({ title: null, first_user_message: 'x'.repeat(500) }))!;
    expect(long.length).toBeLessThanOrEqual(203);
    expect(long.endsWith('...')).toBe(true);
  });
});

// ─── Row -> skeleton mapping ────────────────────────────────────────

describe('mapRowToSkeleton', () => {
  test('marks its provenance so PG rows are distinguishable in the output', () => {
    expect(mapRowToSkeleton(row()).metadata.dataSource).toBe(PG_DATA_SOURCE);
  });

  test('carries taskId, machineId, workspace and message count through', () => {
    const s = mapRowToSkeleton(row());
    expect(s.taskId).toBe('task-1');
    expect(s.metadata.machineId).toBe('myia-po-2025');
    expect(s.metadata.workspace).toBe('d:/dev/CoursIA');
    expect(s.metadata.messageCount).toBe(1320);
  });

  test('maps last_ts to lastActivity and first_ts to createdAt', () => {
    const s = mapRowToSkeleton(row());
    expect(s.metadata.lastActivity).toBe('2026-09-06T03:37:15.817Z');
    expect(s.metadata.createdAt).toBe('2026-09-05T12:14:55.368Z');
  });

  test('falls back for lastActivity when last_ts is NULL (84 such rows live)', () => {
    const s = mapRowToSkeleton(row({ last_ts: null, metadata: { lastActivity: '2026-01-01T00:00:00Z' } }));
    expect(s.metadata.lastActivity).toBe('2026-01-01T00:00:00Z');
  });

  test.each([
    ['roo', 'roo'],
    ['zoo', 'zoo-code'],
    ['claude', 'claude-code'],
  ] as const)('maps harness %s to source %s', (harness, source) => {
    expect(mapRowToSkeleton(row({ harness })).metadata.source).toBe(source);
  });

  test('leaves the sequence empty — this tier lists, it does not load messages', () => {
    expect(mapRowToSkeleton(row()).sequence).toEqual([]);
  });

  test('sets truncatedInstruction so the contentPattern fast path can match', () => {
    expect(mapRowToSkeleton(row({ title: 'searchable label' })).truncatedInstruction)
      .toBe('searchable label');
  });

  test('propagates parent_task_id (4,943 rows live have one)', () => {
    const s = mapRowToSkeleton(row({ parent_task_id: 'parent-9' }));
    expect(s.parentTaskId).toBe('parent-9');
    expect(s.metadata.parentTaskId).toBe('parent-9');
  });

  test('omits workspace rather than inventing one when the column is NULL', () => {
    expect(mapRowToSkeleton(row({ workspace: null })).metadata.workspace).toBeUndefined();
  });

  test('does not fabricate size/action counts absent from the stored metadata', () => {
    const s = mapRowToSkeleton(row({ metadata: null }));
    expect(s.metadata.totalSize).toBe(0);
    expect(s.metadata.actionCount).toBe(0);
  });
});

// ─── Tier read ──────────────────────────────────────────────────────

describe('loadPgConversationTier', () => {
  test('passes the machine filter and the default cap to the reader', async () => {
    await loadPgConversationTier({ machineId: 'myia-po-2025' }, new Set());
    expect(mockListConversations).toHaveBeenCalledWith({
      machineId: 'myia-po-2025',
      limit: DEFAULT_PG_LIST_LIMIT,
    });
  });

  test('drops rows an earlier tier already produced (local skeleton wins)', async () => {
    mockListConversations.mockResolvedValue([
      row({ task_id: 'already-local' }),
      row({ task_id: 'pg-only' }),
    ]);
    const result = await loadPgConversationTier({}, new Set(['already-local']));
    expect(result.rows_read).toBe(2);
    expect(result.skeletons.map(s => s.taskId)).toEqual(['pg-only']);
  });

  test('reports truncated when the cap was reached — never silently', async () => {
    mockListConversations.mockResolvedValue([row({ task_id: 'a' }), row({ task_id: 'b' })]);
    const result = await loadPgConversationTier({ limit: 2 }, new Set());
    expect(result.truncated).toBe(true);
  });

  test('does not report truncated below the cap', async () => {
    mockListConversations.mockResolvedValue([row({ task_id: 'a' })]);
    const result = await loadPgConversationTier({ limit: 2 }, new Set());
    expect(result.truncated).toBe(false);
  });

  test('degrades gracefully on a PG failure: status failed, no throw, warn emitted', async () => {
    mockListConversations.mockRejectedValue(new Error('connection refused'));
    const result = await loadPgConversationTier({}, new Set());
    expect(result.status).toBe('failed');
    expect(result.error).toContain('connection refused');
    expect(result.skeletons).toEqual([]);
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  test('returns an empty ready result when the gate is off', async () => {
    delete process.env.UNIFIED_STORE_CONVERSATION_READ_PG;
    const result = await loadPgConversationTier({}, new Set());
    expect(result).toEqual({ status: 'ready', rows_read: 0, truncated: false, skeletons: [] });
    expect(mockListConversations).not.toHaveBeenCalled();
  });
});

// ─── loadPgConversationSkeleton (#2191 view body load) ──────────────

function convRow(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    task_id: 'claude-d--dev-CoursIA--0f1e2d3c',
    machine_id: 'myia-po-2025',
    harness: 'claude',
    workspace: 'd:/dev/CoursIA',
    parent_task_id: null,
    title: null,
    first_ts: '2026-09-05T12:14:55.368Z',
    last_ts: '2026-09-06T03:37:15.817Z',
    msg_count: 3,
    metadata: null,
    ...overrides,
  };
}

function msg(seq: number, overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    task_id: 'claude-d--dev-CoursIA--0f1e2d3c',
    message_id: null,
    seq,
    role: seq % 2 === 0 ? 'user' : 'assistant',
    content: `message ${seq}`,
    tool_calls: null,
    ts: '2026-09-05T12:14:55.368Z',
    ...overrides,
  };
}

describe('loadPgConversationSkeleton', () => {
  test('returns null without touching the reader when the gate is off', async () => {
    delete process.env.UNIFIED_STORE_CONVERSATION_READ_PG;
    expect(await loadPgConversationSkeleton('any')).toBeNull();
    expect(mockInit).not.toHaveBeenCalled();
    expect(mockGetConversation).not.toHaveBeenCalled();
  });

  test('initialises the pool before reading (#2816: no self-init on a cold pool)', async () => {
    await loadPgConversationSkeleton('any');
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetConversation.mock.invocationCallOrder[0],
    );
  });

  test('returns null when the store has no row for the task', async () => {
    expect(await loadPgConversationSkeleton('absent')).toBeNull();
    expect(mockGetMessages).not.toHaveBeenCalled();
  });

  test('maps user/assistant rows into the sequence, in order, with PG provenance', async () => {
    mockGetConversation.mockResolvedValue(convRow());
    mockGetMessages.mockResolvedValue([
      msg(0, { content: 'first question' }),
      msg(1, { content: null, ts: new Date('2026-09-05T12:15:00.000Z') as unknown as string }),
      msg(2, { role: 'tool', content: 'tool output' }),
      msg(3, { role: 'user', content: 'second question' }),
    ]);

    const skeleton = await loadPgConversationSkeleton('claude-d--dev-CoursIA--0f1e2d3c');

    expect(skeleton).not.toBeNull();
    expect(skeleton!.taskId).toBe('claude-d--dev-CoursIA--0f1e2d3c');
    expect(skeleton!.metadata.dataSource).toBe(PG_DATA_SOURCE);
    expect(skeleton!.metadata.machineId).toBe('myia-po-2025');
    expect(skeleton!.sequence).toEqual([
      { role: 'user', content: 'first question', timestamp: '2026-09-05T12:14:55.368Z', isTruncated: false },
      { role: 'assistant', content: '', timestamp: '2026-09-05T12:15:00.000Z', isTruncated: false },
      { role: 'user', content: 'second question', timestamp: '2026-09-05T12:14:55.368Z', isTruncated: false },
    ]);
    // Title is NULL on the row: the label falls back to the first user message.
    expect(skeleton!.metadata.title).toBe('first question');
  });

  test('converts Date timestamps on the conversation row (node-pg TIMESTAMPTZ)', async () => {
    mockGetConversation.mockResolvedValue(
      convRow({
        first_ts: new Date('2026-09-05T12:14:55.368Z') as unknown as string,
        last_ts: new Date('2026-09-06T03:37:15.817Z') as unknown as string,
      }),
    );
    mockGetMessages.mockResolvedValue([msg(0)]);

    const skeleton = await loadPgConversationSkeleton('t');

    expect(skeleton!.metadata.createdAt).toBe('2026-09-05T12:14:55.368Z');
    expect(skeleton!.metadata.lastActivity).toBe('2026-09-06T03:37:15.817Z');
  });

  test('pages through the messages until a short page', async () => {
    mockGetConversation.mockResolvedValue(convRow());
    const full = Array.from({ length: PG_VIEW_PAGE_SIZE }, (_, i) => msg(i));
    mockGetMessages.mockResolvedValueOnce(full).mockResolvedValueOnce([msg(PG_VIEW_PAGE_SIZE)]);

    const skeleton = await loadPgConversationSkeleton('t');

    expect(mockGetMessages).toHaveBeenNthCalledWith(1, 't', { limit: PG_VIEW_PAGE_SIZE, offset: 0 });
    expect(mockGetMessages).toHaveBeenNthCalledWith(2, 't', {
      limit: PG_VIEW_PAGE_SIZE,
      offset: PG_VIEW_PAGE_SIZE,
    });
    expect(mockGetMessages).toHaveBeenCalledTimes(2);
    expect(skeleton!.sequence).toHaveLength(PG_VIEW_PAGE_SIZE + 1);
  });

  test('returns null for a header-only row (no message rows: nothing to show)', async () => {
    mockGetConversation.mockResolvedValue(convRow({ msg_count: 42 }));
    expect(await loadPgConversationSkeleton('orphan')).toBeNull();
  });

  test('degrades to null with a warn when the store throws — never an exception', async () => {
    mockGetConversation.mockResolvedValue(convRow());
    mockGetMessages.mockRejectedValue(new Error('connection refused'));
    expect(await loadPgConversationSkeleton('t')).toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalled();
  });
});

// ─── SQL shape (mock-backed: shape, NOT acceptance) ─────────────────

describe('PgUnifiedStoreReader.listConversations — SQL shape', () => {
  // These assert the query TEXT the reader emits. They cannot prove what the
  // query returns; that was measured against the live store (12,887
  // conversations / 2,773,371 messages, 2026-09-07): 1,114 rows for
  // machine_id=myia-po-2025, `Execution Time: 14.0 ms`, all buffers cached.

  function makeReader() {
    return new PgUnifiedStoreReader({ connectionString: 'postgres://user@host:5432/db' });
  }

  test('joins the first user message via LATERAL, ordered by seq, LIMIT 1', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await makeReader().listConversations({ machineId: 'myia-po-2025' });

    const sql = mockQuery.mock.calls.map(c => String(c[0])).find(t => t.includes('LEFT JOIN LATERAL'))!;
    expect(sql).toBeDefined();
    expect(sql).toMatch(/role\s*=\s*'user'/);
    expect(sql).toMatch(/ORDER BY messages\.seq ASC/);
    expect(sql).toMatch(/LIMIT 1/);
    // Rides messages_task_seq_unique (task_id, seq) from migrations/001 — the
    // correlation must be on task_id or the index does not apply.
    expect(sql).toMatch(/messages\.task_id = c\.task_id/);
  });

  test('orders by last_ts DESC NULLS LAST so the cap drops the OLDEST rows', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await makeReader().listConversations({});

    const sql = mockQuery.mock.calls.map(c => String(c[0])).find(t => t.includes('FROM conversations'))!;
    expect(sql).toMatch(/ORDER BY last_ts DESC NULLS LAST/);
  });

  test('matches machine_id case-insensitively, and passes null to mean "all machines"', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const reader = makeReader();

    await reader.listConversations({ machineId: 'MYIA-PO-2025' });
    let call = mockQuery.mock.calls.find(c => String(c[0]).includes('FROM conversations'))!;
    expect(String(call[0])).toMatch(/LOWER\(machine_id\) = LOWER\(\$1\)/);
    expect((call[1] as unknown[])[0]).toBe('MYIA-PO-2025');

    mockQuery.mockClear();
    await reader.listConversations({});
    call = mockQuery.mock.calls.find(c => String(c[0]).includes('FROM conversations'))!;
    expect((call[1] as unknown[])[0]).toBeNull();
  });

  test('a null pool THROWS rather than rendering a silently empty tier', async () => {
    // getConversation/getMessages `return []` on a null pool, and no path calls
    // init() explicitly (#2816) — that shape would make an unreachable store
    // indistinguishable from "PG holds nothing". Positive control: if the guard
    // were reverted to `return []`, this expectation goes red.
    const reader = makeReader();
    mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(reader.listConversations({})).rejects.toThrow();
  });
});
