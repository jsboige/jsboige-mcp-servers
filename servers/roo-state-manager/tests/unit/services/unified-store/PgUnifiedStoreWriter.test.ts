/**
 * PgUnifiedStoreWriter — Phase B unit tests.
 *
 * Tests the concrete Postgres writer with mocked pg.Pool.
 * No live Postgres required.
 *
 * @issue #2426 Phase B (Epic #2191)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgUnifiedStoreWriter } from '../../../../src/services/unified-store/PgUnifiedStoreWriter.js';
import type {
  ConversationBundle,
  ConversationRow,
  MessageRow,
} from '../../../../src/services/unified-store/types.js';

// ─── Mock pg module ────────────────────────────────────────────────

const mockQuery = vi.fn();
const mockConnect = vi.fn();
const mockEnd = vi.fn();

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(() => ({
      connect: mockConnect,
      end: mockEnd,
    })),
  },
}));

// Helper to create a mock client with BEGIN/COMMIT/ROLLBACK support
function mockClient() {
  return {
    query: mockQuery,
    release: vi.fn(),
  };
}

// ─── Fixtures ──────────────────────────────────────────────────────

const dummyConv: ConversationRow = {
  task_id: 't-phase-b',
  machine_id: 'myia-po-2025',
  harness: 'roo',
  workspace: 'roo-extensions',
  parent_task_id: null,
  title: 'Phase B test',
  first_ts: '2026-05-30T10:00:00Z',
  last_ts: '2026-05-30T10:05:00Z',
  msg_count: 3,
  metadata: { mode: 'code-simple' },
};

const dummyMessages: MessageRow[] = [
  {
    task_id: 't-phase-b',
    message_id: null,
    seq: 0,
    role: 'user',
    content: 'Hello',
    tool_calls: null,
    ts: '2026-05-30T10:00:00Z',
  },
  {
    task_id: 't-phase-b',
    message_id: null,
    seq: 1,
    role: 'assistant',
    content: 'Response',
    tool_calls: [{ name: 'read_file', args: { path: '/foo.ts' } }],
    ts: '2026-05-30T10:02:00Z',
  },
];

const dummyBundle: ConversationBundle = {
  conversation: dummyConv,
  messages: dummyMessages,
};

// ─── Tests ─────────────────────────────────────────────────────────

describe('PgUnifiedStoreWriter', () => {
  let writer: PgUnifiedStoreWriter;

  beforeEach(() => {
    vi.clearAllMocks();
    writer = new PgUnifiedStoreWriter({
      connectionString: 'postgres://test:test@localhost:5433/unified_store',
      poolMax: 2,
      statementTimeoutMs: 3000,
    });
    // Default: connect succeeds, query succeeds
    const client = mockClient();
    mockConnect.mockResolvedValue(client);
    mockQuery.mockResolvedValue({ rowCount: 1 });
    mockEnd.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await writer.close();
  });

  describe('lifecycle', () => {
    it('initializes pool and verifies connectivity', async () => {
      await writer.init();
      // Pool constructor called + connect for SELECT 1 + release
      expect(mockConnect).toHaveBeenCalled();
    });

    it('close drains the pool', async () => {
      await writer.init();
      await writer.close();
      expect(mockEnd).toHaveBeenCalled();
    });

    it('init is idempotent', async () => {
      await writer.init();
      await writer.init();
      // Pool constructor called once (via vi.fn)
      await writer.close();
    });
  });

  describe('ping', () => {
    it('returns true when DB is reachable', async () => {
      await writer.init();
      const result = await writer.ping();
      expect(result).toBe(true);
    });

    it('returns false when DB is unreachable', async () => {
      // Override mock to reject connections (simulates DB down)
      mockConnect.mockRejectedValue(new Error('Connection refused'));
      // ping uses withRetry which catches the error and returns false
      const result = await writer.ping();
      expect(result).toBe(false);
    });
  });

  describe('upsertConversation (atomic)', () => {
    it('upserts conversation + messages in a transaction', async () => {
      await writer.init();
      await writer.upsertConversation(dummyBundle);

      // BEGIN, upsert conv, upsert msgs, COMMIT
      expect(mockQuery).toHaveBeenCalledWith('BEGIN');
      expect(mockQuery).toHaveBeenCalledWith('COMMIT');
      // Conversation upsert query
      const convQuery = mockQuery.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('INSERT INTO conversations'));
      expect(convQuery).toBeDefined();
      // Messages upsert query
      const msgQuery = mockQuery.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('INSERT INTO messages'));
      expect(msgQuery).toBeDefined();
    });

    it('rolls back on error', async () => {
      await writer.init();
      // Make the conversation INSERT fail
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO conversations')) {
          throw new Error('PK violation');
        }
        return Promise.resolve({ rowCount: 1 });
      });

      // Should NOT throw (best-effort, circuit breaker absorbs)
      await writer.upsertConversation(dummyBundle);

      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    });

    it('handles empty messages array', async () => {
      await writer.init();
      const bundleNoMsgs: ConversationBundle = {
        conversation: dummyConv,
        messages: [],
      };
      await writer.upsertConversation(bundleNoMsgs);

      // Should still BEGIN/COMMIT but NOT call message insert
      const msgQuery = mockQuery.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('INSERT INTO messages'));
      expect(msgQuery).toBeUndefined();
    });
  });

  describe('upsertConversationOnly', () => {
    it('upserts a single conversation row', async () => {
      await writer.init();
      await writer.upsertConversationOnly(dummyConv);

      const convQuery = mockQuery.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('INSERT INTO conversations'));
      expect(convQuery).toBeDefined();
      // Params should match the conversation row
      expect(convQuery![1][0]).toBe('t-phase-b');
      expect(convQuery![1][1]).toBe('myia-po-2025');
    });
  });

  describe('upsertMessages', () => {
    it('uses UNNEST for batch insert', async () => {
      await writer.init();
      await writer.upsertMessages(dummyMessages);

      const msgQuery = mockQuery.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('UNNEST'));
      expect(msgQuery).toBeDefined();
      // Second param is the array of task_ids
      expect(msgQuery![1][0]).toEqual(['t-phase-b', 't-phase-b']);
    });

    it('skips empty array', async () => {
      await writer.init();
      await writer.upsertMessages([]);
      // No query should be issued
      const msgQuery = mockQuery.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('INSERT INTO messages'));
      expect(msgQuery).toBeUndefined();
    });
  });

  describe('retry + circuit breaker', () => {
    it('retries on transient failure', async () => {
      await writer.init();
      let callCount = 0;
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO conversations')) {
          callCount++;
          if (callCount === 1) throw new Error('Transient');
          return Promise.resolve({ rowCount: 1 });
        }
        return Promise.resolve({ rowCount: 1 });
      });

      await writer.upsertConversationOnly(dummyConv);

      // Should have retried
      const metrics = writer.getMetrics();
      expect(metrics.upsertsRetried).toBeGreaterThan(0);
      expect(metrics.upsertsSuccess).toBe(1);
    });

    it('opens circuit breaker after threshold failures', async () => {
      await writer.init();
      mockQuery.mockImplementation(() => {
        throw new Error('Persistent failure');
      });

      // Trigger 3 failures to open the breaker
      await writer.upsertConversationOnly(dummyConv);
      await writer.upsertConversationOnly(dummyConv);
      await writer.upsertConversationOnly(dummyConv);

      expect(writer.getBreakerState()).toBe('OPEN');
      expect(writer.getMetrics().breakerOpens).toBeGreaterThan(0);
    });

    it('metrics track totals correctly', async () => {
      await writer.init();
      await writer.upsertConversationOnly(dummyConv);

      const metrics = writer.getMetrics();
      expect(metrics.upsertsTotal).toBe(1);
      expect(metrics.upsertsSuccess).toBe(1);
      expect(metrics.upsertsFailed).toBe(0);
    });
  });

  describe('parameterized queries (SQL injection safety)', () => {
    it('uses $N placeholders, not string interpolation', async () => {
      await writer.init();
      const maliciousConv: ConversationRow = {
        ...dummyConv,
        task_id: "'; DROP TABLE conversations; --",
      };
      await writer.upsertConversationOnly(maliciousConv);

      const convQuery = mockQuery.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('INSERT INTO conversations'));
      expect(convQuery).toBeDefined();
      // Must use $1, not string interpolation
      expect(convQuery![0]).toContain('$1');
      expect(convQuery![0]).not.toContain('DROP TABLE');
      // The malicious string should be a parameter, not in the query
      expect(convQuery![1][0]).toBe("'; DROP TABLE conversations; --");
    });
  });
});
