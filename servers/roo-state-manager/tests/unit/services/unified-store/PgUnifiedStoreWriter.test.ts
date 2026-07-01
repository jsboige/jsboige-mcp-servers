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

// ─── Additional coverage: genuine untested branches (#815 Cluster B, po-2024) ───
// Anchored on source contract PgUnifiedStoreWriter.ts L29-354. Tests-only, 0 source runtime.
// Sibling describe (own writer instances) to avoid coupling with the shared-writer beforeEach above.

describe('PgUnifiedStoreWriter — additional coverage (#815 Cluster B)', () => {

  describe('lifecycle edge cases', () => {
    it('init() rejects when pool.connect() throws during the connectivity check', async () => {
      vi.clearAllMocks();
      mockConnect.mockRejectedValue(new Error('ECONNREFUSED'));
      const writer = new PgUnifiedStoreWriter({ connectionString: 'pg://x' });

      await expect(writer.init()).rejects.toThrow('ECONNREFUSED');

      // initialized stayed false → pool is null → ping returns false (pool-null guard, source L149)
      expect(await writer.ping()).toBe(false);
    });

    it('ping() returns false when the writer was never initialized (pool null guard)', async () => {
      vi.clearAllMocks();
      const writer = new PgUnifiedStoreWriter({ connectionString: 'pg://x' });

      const result = await writer.ping();

      expect(result).toBe(false);
      // No connect attempt issued against a null pool (source L149 early-return)
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('close() is a no-op when the writer was never initialized (pool null guard, source L140)', async () => {
      vi.clearAllMocks();
      mockEnd.mockResolvedValue(undefined);
      const writer = new PgUnifiedStoreWriter({ connectionString: 'pg://x' });

      await writer.close(); // must not throw

      expect(mockEnd).not.toHaveBeenCalled();
    });
  });

  describe('withRetry exhaustive-failure metrics', () => {
    it('records lastError + lastErrorTs and counts the failure after all retries are exhausted', async () => {
      vi.clearAllMocks();
      const client = mockClient();
      mockConnect.mockResolvedValue(client);
      mockEnd.mockResolvedValue(undefined);
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO conversations')) {
          throw new Error('persistent PK violation');
        }
        return Promise.resolve({ rowCount: 1 });
      });
      const writer = new PgUnifiedStoreWriter({ connectionString: 'pg://x' });
      await writer.init();

      // Best-effort writer: never throws (source L339-343), all retries fail → metrics captured
      await writer.upsertConversationOnly(dummyConv);

      const metrics = writer.getMetrics();
      expect(metrics.upsertsTotal).toBe(1);
      expect(metrics.upsertsSuccess).toBe(0);
      expect(metrics.upsertsFailed).toBe(1);
      expect(metrics.lastError).toBe('persistent PK violation');
      expect(metrics.lastErrorTs).toBeTruthy(); // ISO timestamp set at source L333
      await writer.close();
    });
  });

  describe('getMetrics defensive copy', () => {
    it('mutating the returned metrics object does not affect internal state (source L348 spread)', async () => {
      vi.clearAllMocks();
      const client = mockClient();
      mockConnect.mockResolvedValue(client);
      mockEnd.mockResolvedValue(undefined);
      mockQuery.mockResolvedValue({ rowCount: 1 });
      const writer = new PgUnifiedStoreWriter({ connectionString: 'pg://x' });
      await writer.init();
      await writer.upsertConversationOnly(dummyConv);

      const snapshot = writer.getMetrics();
      const successBefore = snapshot.upsertsSuccess;
      (snapshot as { upsertsSuccess: number }).upsertsSuccess = 99999; // mutate the copy

      expect(writer.getMetrics().upsertsSuccess).toBe(successBefore);
      await writer.close();
    });
  });

  describe('upsertConversationRow null-coalescing (source L228-239)', () => {
    it('coerces undefined optional fields and falsy metadata to NULL params', async () => {
      vi.clearAllMocks();
      const client = mockClient();
      mockConnect.mockResolvedValue(client);
      mockEnd.mockResolvedValue(undefined);
      mockQuery.mockResolvedValue({ rowCount: 1 });
      const writer = new PgUnifiedStoreWriter({ connectionString: 'pg://x' });
      await writer.init();

      // Sparse row: optional fields undefined, metadata null (falsy) → every `?? null` branch
      const sparse = {
        task_id: 't-sparse',
        machine_id: 'm',
        harness: 'roo',
        workspace: undefined,
        parent_task_id: undefined,
        title: undefined,
        first_ts: undefined,
        last_ts: undefined,
        msg_count: 0,
        metadata: null,
      } as unknown as ConversationRow;

      await writer.upsertConversationOnly(sparse);

      const convQuery = mockQuery.mock.calls.find(
        c => typeof c[0] === 'string' && c[0].includes('INSERT INTO conversations'),
      );
      expect(convQuery).toBeDefined();
      // params layout (source L228-239):
      //   [task_id, machine_id, harness, workspace, parent_task_id, title, first_ts, last_ts, msg_count, metadata]
      const params = convQuery![1] as unknown[];
      expect(params[3]).toBeNull(); // workspace ?? null
      expect(params[4]).toBeNull(); // parent_task_id ?? null
      expect(params[5]).toBeNull(); // title ?? null
      expect(params[6]).toBeNull(); // first_ts ?? null
      expect(params[7]).toBeNull(); // last_ts ?? null
      expect(params[8]).toBe(0);    // msg_count passed through
      expect(params[9]).toBeNull(); // metadata falsy → JSON.stringify branch skipped (source L238)
      await writer.close();
    });

    it('JSON-stringifies metadata when present (source L238 ternary truthy branch)', async () => {
      vi.clearAllMocks();
      const client = mockClient();
      mockConnect.mockResolvedValue(client);
      mockEnd.mockResolvedValue(undefined);
      mockQuery.mockResolvedValue({ rowCount: 1 });
      const writer = new PgUnifiedStoreWriter({ connectionString: 'pg://x' });
      await writer.init();

      await writer.upsertConversationOnly(dummyConv); // dummyConv.metadata = { mode: 'code-simple' }

      const convQuery = mockQuery.mock.calls.find(
        c => typeof c[0] === 'string' && c[0].includes('INSERT INTO conversations'),
      );
      const params = convQuery![1] as unknown[];
      expect(params[9]).toBe(JSON.stringify({ mode: 'code-simple' }));
      await writer.close();
    });
  });

  describe('circuit breaker recovery (HALF_OPEN probe, source L46-70)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // CircuitBreaker is constructed internally with resetMs=60_000 (source L103) and not injectable,
    // so the OPEN→HALF_OPEN→CLOSED recovery (documented in the source header) can only be exercised
    // by advancing the clock. Fake timers are scoped to these tests only.
    it('recovers OPEN → HALF_OPEN → CLOSED after reset timeout when the probe succeeds', async () => {
      vi.clearAllMocks();
      vi.useFakeTimers({ now: 1_700_000_000_000 });
      const client = mockClient();
      mockConnect.mockResolvedValue(client);
      mockEnd.mockResolvedValue(undefined);
      mockQuery.mockResolvedValue({ rowCount: 1 });
      const writer = new PgUnifiedStoreWriter({ connectionString: 'pg://x' });
      await writer.init();
      expect(writer.getBreakerState()).toBe('CLOSED');

      // Force the breaker OPEN: 3 fully-failed upserts (threshold = 3, source L40/L67/L103)
      mockQuery.mockImplementation(() => {
        throw new Error('db down');
      });
      for (let i = 0; i < 3; i++) {
        const p = writer.upsertConversationOnly({ ...dummyConv, task_id: `fail-${i}` });
        // Flush the retry backoff sleeps (500ms + 1000ms, source L320-324) queued under fake timers
        await vi.advanceTimersByTimeAsync(5_000);
        await p;
      }
      expect(writer.getBreakerState()).toBe('OPEN');
      expect(writer.getMetrics().breakerOpens).toBeGreaterThanOrEqual(1);

      // Advance past resetMs (60s) → next allow() flips OPEN → HALF_OPEN and admits one probe
      vi.advanceTimersByTime(61_000);

      // Probe succeeds on first attempt → recordSuccess → CLOSED (source L59-62)
      mockQuery.mockResolvedValue({ rowCount: 1 });
      await writer.upsertConversationOnly({ ...dummyConv, task_id: 'probe' });

      expect(writer.getBreakerState()).toBe('CLOSED');
      await writer.close();
    });

    it('a failed HALF_OPEN probe keeps the breaker OPEN (no premature recovery)', async () => {
      vi.clearAllMocks();
      vi.useFakeTimers({ now: 1_700_000_000_000 });
      const client = mockClient();
      mockConnect.mockResolvedValue(client);
      mockEnd.mockResolvedValue(undefined);
      mockQuery.mockResolvedValue({ rowCount: 1 });
      const writer = new PgUnifiedStoreWriter({ connectionString: 'pg://x' });
      await writer.init();

      // OPEN the breaker
      mockQuery.mockImplementation(() => {
        throw new Error('db down');
      });
      for (let i = 0; i < 3; i++) {
        const p = writer.upsertConversationOnly({ ...dummyConv, task_id: `fail-${i}` });
        await vi.advanceTimersByTimeAsync(5_000);
        await p;
      }
      expect(writer.getBreakerState()).toBe('OPEN');

      // Past resetMs → HALF_OPEN probe admitted; probe FAILS again → recordFailure → stays OPEN
      vi.advanceTimersByTime(61_000);
      const probe = writer.upsertConversationOnly({ ...dummyConv, task_id: 'probe-fail' });
      await vi.advanceTimersByTimeAsync(5_000); // flush probe retries
      await probe;

      expect(writer.getBreakerState()).toBe('OPEN');
      await writer.close();
    });
  });
});
