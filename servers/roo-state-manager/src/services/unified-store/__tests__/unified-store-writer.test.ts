/**
 * Tests for PgUnifiedStoreWriter — Postgres-backed unified store writer
 *
 * #2426 Phase 2: Tests for the dual-write writer with circuit-breaker + retry.
 * Uses mocked pg.Pool to avoid real DB dependency.
 *
 * @module services/unified-store/__tests__/unified-store-writer.test
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgUnifiedStoreWriter } from '../PgUnifiedStoreWriter.js';
import type { ConversationBundle, ConversationRow, MessageRow } from '../types.js';

// ─── Mock pg module ──────────────────────────────────────────────────

const mockQuery = vi.fn();
const mockConnect = vi.fn();
const mockEnd = vi.fn();

const mockClient = {
  query: mockQuery,
  release: vi.fn(),
};

const mockPoolQuery = vi.fn();

const mockPool = {
  connect: mockConnect,
  query: mockPoolQuery,
  end: mockEnd,
};

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(() => mockPool),
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────

function createWriter(overrides?: {
  maxRetries?: number;
  baseDelayMs?: number;
}): PgUnifiedStoreWriter {
  return new PgUnifiedStoreWriter({
    connectionString: 'postgres://test:test@localhost:5432/unified_store',
    poolMax: 2,
    statementTimeoutMs: 3000,
    maxRetries: overrides?.maxRetries,
    baseDelayMs: overrides?.baseDelayMs,
  });
}

function createConversationRow(overrides?: Partial<ConversationRow>): ConversationRow {
  return {
    task_id: 'task-123',
    machine_id: 'myia-po-2023',
    harness: 'claude',
    workspace: '/test/workspace',
    parent_task_id: null,
    title: 'Test Task',
    first_ts: '2026-06-01T10:00:00Z',
    last_ts: '2026-06-01T11:00:00Z',
    msg_count: 10,
    metadata: null,
    ...overrides,
  };
}

function createMessageRow(overrides?: Partial<MessageRow>): MessageRow {
  return {
    id: 1,
    task_id: 'task-123',
    message_id: null,
    seq: 0,
    role: 'user',
    content: 'Hello world',
    tool_calls: null,
    ts: '2026-06-01T10:00:00Z',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('PgUnifiedStoreWriter', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(mockClient);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockEnd.mockResolvedValue(undefined);
    mockClient.release.mockReset();
  });

  // ─── Lifecycle ──────────────────────────────────────────────────

  describe('lifecycle', () => {
    test('init connects to pool and verifies connectivity', async () => {
      const writer = createWriter();
      await writer.init();

      expect(mockConnect).toHaveBeenCalledTimes(1); // connect for SELECT 1 verification
      expect(mockQuery).toHaveBeenCalledWith('SELECT 1');
    });

    test('init is idempotent', async () => {
      const writer = createWriter();
      await writer.init();
      await writer.init();

      // SELECT 1 called only once (second init early-returns)
      const select1Calls = mockQuery.mock.calls.filter(c => c[0] === 'SELECT 1');
      expect(select1Calls.length).toBe(1);
    });

    test('close drains the pool', async () => {
      const writer = createWriter();
      await writer.init();
      await writer.close();

      expect(mockEnd).toHaveBeenCalledTimes(1);
    });

    test('ping returns true when pool is healthy', async () => {
      const writer = createWriter();
      await writer.init();
      const result = await writer.ping();

      expect(result).toBe(true);
    });

    test('ping returns false when pool throws', async () => {
      mockConnect.mockRejectedValue(new Error('Connection refused'));
      // Need to bypass init's connect
      const writer = createWriter();
      await writer.init().catch(() => {});
      mockConnect.mockResolvedValue(mockClient);
      mockQuery.mockRejectedValue(new Error('DB down'));

      const result = await writer.ping();
      expect(result).toBe(false);
    });
  });

  // ─── Upsert Conversation ────────────────────────────────────────

  describe('upsertConversation', () => {
    test('inserts conversation + messages in a transaction', async () => {
      const writer = createWriter();
      await writer.init();

      const bundle: ConversationBundle = {
        conversation: createConversationRow(),
        messages: [
          createMessageRow({ seq: 0, role: 'user' }),
          createMessageRow({ seq: 1, role: 'assistant' }),
        ],
      };

      await writer.upsertConversation(bundle);

      // BEGIN, upsert conversation, upsert messages (UNNEST), COMMIT
      expect(mockQuery).toHaveBeenCalledWith('BEGIN');
      expect(mockQuery).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    test('rolls back on error', async () => {
      const writer = createWriter();
      await writer.init();

      // Make the conversation INSERT fail
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO conversations')) {
          throw new Error('Unique violation');
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const bundle: ConversationBundle = {
        conversation: createConversationRow(),
        messages: [],
      };

      // Should not throw (best-effort with retry)
      await writer.upsertConversation(bundle);

      // ROLLBACK should be called
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    });

    test('skips messages when bundle has no messages', async () => {
      const writer = createWriter();
      await writer.init();

      const bundle: ConversationBundle = {
        conversation: createConversationRow(),
        messages: [],
      };

      await writer.upsertConversation(bundle);

      // Only BEGIN, INSERT conversation, COMMIT — no UNNEST
      const unnestCalls = mockQuery.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('UNNEST')
      );
      expect(unnestCalls.length).toBe(0);
    });
  });

  // ─── Upsert Conversation Only ───────────────────────────────────

  describe('upsertConversationOnly', () => {
    test('inserts conversation without transaction', async () => {
      const writer = createWriter();
      await writer.init();

      await writer.upsertConversationOnly(createConversationRow());

      // Should NOT call BEGIN/COMMIT (single statement)
      const beginCalls = mockQuery.mock.calls.filter(c => c[0] === 'BEGIN');
      expect(beginCalls.length).toBe(0);

      // Should call INSERT INTO conversations
      const insertCalls = mockQuery.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('INSERT INTO conversations')
      );
      expect(insertCalls.length).toBe(1);
    });
  });

  // ─── Upsert Messages ────────────────────────────────────────────

  describe('upsertMessages', () => {
    test('uses UNNEST for batch insert', async () => {
      const writer = createWriter();
      await writer.init();

      const messages = [
        createMessageRow({ seq: 0 }),
        createMessageRow({ seq: 1 }),
        createMessageRow({ seq: 2 }),
      ];

      await writer.upsertMessages(messages);

      const unnestCalls = mockQuery.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('UNNEST')
      );
      expect(unnestCalls.length).toBe(1);
    });

    test('is no-op when rows is empty', async () => {
      const writer = createWriter();
      await writer.init();

      const queryCountBefore = mockQuery.mock.calls.length;

      await writer.upsertMessages([]);

      // No additional queries should be made (early return)
      expect(mockQuery.mock.calls.length).toBe(queryCountBefore);
    });

    test('handles tool_calls JSON serialization safely', async () => {
      const writer = createWriter();
      await writer.init();

      const messages = [
        createMessageRow({
          seq: 0,
          tool_calls: [{ name: 'read_file', arguments: { path: '/test.ts' } }],
        }),
      ];

      await writer.upsertMessages(messages);

      // The UNNEST query should have been called with JSON-stringified tool_calls
      const unnestCall = mockQuery.mock.calls.find(
        c => typeof c[0] === 'string' && c[0].includes('UNNEST')
      );
      expect(unnestCall).toBeDefined();
      // tool_calls array should be ['{"name":"read_file",...}']
      const toolCallsParam = unnestCall![1][5]; // $6::jsonb[]
      expect(toolCallsParam[0]).toContain('read_file');
    });

    test('handles non-serializable tool_calls gracefully (stores null)', async () => {
      const writer = createWriter();
      await writer.init();

      const circular: any = { name: 'test' };
      circular.self = circular; // circular reference

      const messages = [
        createMessageRow({ seq: 0, tool_calls: circular }),
      ];

      // Should not throw
      await writer.upsertMessages(messages);

      const unnestCall = mockQuery.mock.calls.find(
        c => typeof c[0] === 'string' && c[0].includes('UNNEST')
      );
      expect(unnestCall).toBeDefined();
      // tool_calls should be [null] because JSON.stringify fails on circular
      const toolCallsParam = unnestCall![1][5];
      expect(toolCallsParam[0]).toBeNull();
    });
  });

  // ─── Retry + Circuit Breaker ────────────────────────────────────

  describe('circuit breaker', () => {
    test('retries on transient failure', async () => {
      const writer = createWriter();
      await writer.init();

      let callCount = 0;
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO conversations')) {
          callCount++;
          if (callCount <= 1) throw new Error('Transient error');
          return { rows: [], rowCount: 0 };
        }
        if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      });

      await writer.upsertConversationOnly(createConversationRow());

      // First attempt failed, retry succeeded
      expect(callCount).toBe(2); // failed once, succeeded on retry
      const metrics = writer.getMetrics();
      expect(metrics.upsertsRetried).toBeGreaterThan(0);
      expect(metrics.upsertsSuccess).toBe(1);
    });

    test('opens circuit breaker after consecutive failures', async () => {
      // baseDelayMs: 0 — eliminates real setTimeout backoff so the test is
      // deterministic under --coverage instrumentation (cf. flaky 301s hang).
      const writer = createWriter({ baseDelayMs: 0 });
      await writer.init();

      // Make all conversation inserts fail
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO conversations')) {
          throw new Error('Connection refused');
        }
        return { rows: [], rowCount: 0 };
      });

      // Trigger 3+ failures to open breaker
      for (let i = 0; i < 4; i++) {
        await writer.upsertConversationOnly(createConversationRow({ task_id: `task-${i}` }));
      }

      const state = writer.getBreakerState();
      expect(state).toBe('OPEN');
    });

    test('circuit breaker skips calls when OPEN', async () => {
      // baseDelayMs: 0 — eliminates real setTimeout backoff so the test is
      // deterministic under --coverage instrumentation (cf. flaky 301s hang).
      const writer = createWriter({ baseDelayMs: 0 });
      await writer.init();

      // Force breaker OPEN by failing repeatedly
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO conversations')) {
          throw new Error('Connection refused');
        }
        return { rows: [], rowCount: 0 };
      });

      for (let i = 0; i < 5; i++) {
        await writer.upsertConversationOnly(createConversationRow({ task_id: `task-${i}` }));
      }

      expect(writer.getBreakerState()).toBe('OPEN');

      const metricsBefore = writer.getMetrics();
      // Another call should be skipped by breaker
      await writer.upsertConversationOnly(createConversationRow({ task_id: 'task-skipped' }));

      const metricsAfter = writer.getMetrics();
      // Failed count should increase (breaker blocks the call = counted as failed)
      expect(metricsAfter.upsertsFailed).toBeGreaterThan(metricsBefore.upsertsFailed);
    });

    test('metrics are accurate', async () => {
      const writer = createWriter();
      await writer.init();

      await writer.upsertConversationOnly(createConversationRow());

      const metrics = writer.getMetrics();
      expect(metrics.upsertsTotal).toBe(1);
      expect(metrics.upsertsSuccess).toBe(1);
      expect(metrics.upsertsFailed).toBe(0);
      expect(metrics.upsertsRetried).toBe(0);
    });
  });
});
