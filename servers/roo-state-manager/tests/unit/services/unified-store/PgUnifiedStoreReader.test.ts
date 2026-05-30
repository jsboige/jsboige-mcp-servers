/**
 * PgUnifiedStoreReader — Phase C unit tests.
 *
 * Tests the concrete Postgres reader with mocked pg.Pool.
 * No live Postgres required.
 *
 * @issue #2426 Phase C (Epic #2191)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgUnifiedStoreReader } from '../../../../src/services/unified-store/PgUnifiedStoreReader.js';
import type { ConversationRow, MessageRow } from '../../../../src/services/unified-store/types.js';

// ─── Mock pg module ────────────────────────────────────────────────

const mockQuery = vi.fn();
const mockConnect = vi.fn();
const mockEnd = vi.fn();

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(() => ({
      connect: mockConnect,
      end: mockEnd,
      query: mockQuery,
    })),
  },
}));

function mockClient() {
  return {
    query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    release: vi.fn(),
  };
}

// ─── Fixtures ──────────────────────────────────────────────────────

const mockConvRow = {
  task_id: 't-reader-test',
  machine_id: 'myia-po-2025',
  harness: 'roo',
  workspace: 'roo-extensions',
  parent_task_id: null,
  title: 'Reader test',
  first_ts: '2026-05-30T10:00:00Z',
  last_ts: '2026-05-30T10:05:00Z',
  msg_count: 3,
  metadata: null,
  ingested_at: '2026-05-30T10:06:00Z',
};

const mockMsgRows = [
  {
    id: 1,
    task_id: 't-reader-test',
    message_id: null,
    seq: 0,
    role: 'user',
    content: 'Hello',
    tool_calls: null,
    ts: '2026-05-30T10:00:00Z',
  },
  {
    id: 2,
    task_id: 't-reader-test',
    message_id: null,
    seq: 1,
    role: 'assistant',
    content: 'Response',
    tool_calls: [{ name: 'read_file', args: { path: '/foo.ts' } }],
    ts: '2026-05-30T10:02:00Z',
  },
];

// ─── Tests ─────────────────────────────────────────────────────────

describe('PgUnifiedStoreReader', () => {
  let reader: PgUnifiedStoreReader;

  beforeEach(() => {
    vi.clearAllMocks();
    reader = new PgUnifiedStoreReader({
      connectionString: 'postgres://test:test@localhost:5433/unified_store',
      poolMax: 2,
      statementTimeoutMs: 3000,
    });
    const client = mockClient();
    mockConnect.mockResolvedValue(client);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockEnd.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await reader.close();
  });

  describe('lifecycle', () => {
    it('initializes pool and verifies connectivity', async () => {
      await reader.init();
      expect(mockConnect).toHaveBeenCalled();
    });

    it('close drains the pool', async () => {
      await reader.init();
      await reader.close();
      expect(mockEnd).toHaveBeenCalled();
    });

    it('init is idempotent', async () => {
      await reader.init();
      await reader.init();
      await reader.close();
    });
  });

  describe('ping', () => {
    it('returns true when DB is reachable', async () => {
      await reader.init();
      const result = await reader.ping();
      expect(result).toBe(true);
    });

    it('returns false when pool is not initialized', async () => {
      const result = await reader.ping();
      expect(result).toBe(false);
    });
  });

  describe('getConversation', () => {
    it('returns null when not initialized', async () => {
      const result = await reader.getConversation('t-1');
      expect(result).toBeNull();
    });

    it('returns conversation when found', async () => {
      await reader.init();
      mockQuery.mockResolvedValue({ rows: [mockConvRow], rowCount: 1 });

      const result = await reader.getConversation('t-reader-test');

      expect(result).not.toBeNull();
      expect(result!.task_id).toBe('t-reader-test');
      expect(result!.machine_id).toBe('myia-po-2025');
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM conversations WHERE task_id = $1',
        ['t-reader-test'],
      );
    });

    it('returns null when not found', async () => {
      await reader.init();
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await reader.getConversation('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getMessages', () => {
    it('returns empty array when not initialized', async () => {
      const result = await reader.getMessages('t-1');
      expect(result).toEqual([]);
    });

    it('returns messages ordered by seq', async () => {
      await reader.init();
      mockQuery.mockResolvedValue({ rows: mockMsgRows, rowCount: 2 });

      const result = await reader.getMessages('t-reader-test');

      expect(result).toHaveLength(2);
      expect(result[0].seq).toBe(0);
      expect(result[1].seq).toBe(1);
      expect(result[1].tool_calls).toEqual([{ name: 'read_file', args: { path: '/foo.ts' } }]);
    });

    it('passes limit and offset to query', async () => {
      await reader.init();
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await reader.getMessages('t-1', { limit: 10, offset: 5 });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT $2 OFFSET $3'),
        ['t-1', 10, 5],
      );
    });

    it('uses default limit 1000', async () => {
      await reader.init();
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await reader.getMessages('t-1');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['t-1', 1000, 0],
      );
    });
  });

  describe('joinFromQdrant', () => {
    it('returns empty when not initialized', async () => {
      const result = await reader.joinFromQdrant([
        { task_id: 't-1', score: 0.9 },
      ]);
      expect(result).toEqual([]);
    });

    it('returns empty when no Qdrant hits', async () => {
      await reader.init();
      const result = await reader.joinFromQdrant([]);
      expect(result).toEqual([]);
    });

    it('joins conversations from Qdrant task_ids', async () => {
      await reader.init();
      mockQuery.mockResolvedValue({ rows: [mockConvRow], rowCount: 1 });

      const result = await reader.joinFromQdrant([
        { task_id: 't-reader-test', score: 0.95 },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].task_id).toBe('t-reader-test');
      expect(result[0].score).toBe(0.95);
      expect(result[0].conversation.machine_id).toBe('myia-po-2025');
    });

    it('applies machine_id filter', async () => {
      await reader.init();
      mockQuery.mockResolvedValue({ rows: [mockConvRow], rowCount: 1 });

      await reader.joinFromQdrant(
        [{ task_id: 't-reader-test', score: 0.9 }],
        { machine_id: 'myia-po-2025' },
      );

      const call = mockQuery.mock.calls[0];
      expect(call[0]).toContain('c.machine_id = $2');
      expect(call[1]).toContain('myia-po-2025');
    });

    it('applies workspace filter', async () => {
      await reader.init();
      mockQuery.mockResolvedValue({ rows: [mockConvRow], rowCount: 1 });

      await reader.joinFromQdrant(
        [{ task_id: 't-reader-test', score: 0.9 }],
        { workspace: 'roo-extensions' },
      );

      const call = mockQuery.mock.calls[0];
      expect(call[0]).toContain('c.workspace = $2');
    });

    it('applies date range filters', async () => {
      await reader.init();
      mockQuery.mockResolvedValue({ rows: [mockConvRow], rowCount: 1 });

      await reader.joinFromQdrant(
        [{ task_id: 't-reader-test', score: 0.9 }],
        { since: '2026-05-01', until: '2026-05-31' },
      );

      const call = mockQuery.mock.calls[0];
      expect(call[0]).toContain('c.last_ts >= $2');
      expect(call[0]).toContain('c.last_ts <= $3');
    });

    it('joins messages when tool_name filter is specified', async () => {
      await reader.init();
      // First call: conversation query with JOIN
      mockQuery
        .mockResolvedValueOnce({ rows: [mockConvRow], rowCount: 1 })
        // Second call: matched messages query
        .mockResolvedValueOnce({ rows: [mockMsgRows[1]], rowCount: 1 });

      const result = await reader.joinFromQdrant(
        [{ task_id: 't-reader-test', score: 0.9 }],
        { tool_name: 'read_file' },
      );

      expect(result).toHaveLength(1);
      expect(result[0].matched_messages).toBeDefined();
      expect(result[0].matched_messages).toHaveLength(1);

      // First query should have JOIN messages
      const joinCall = mockQuery.mock.calls[0];
      expect(joinCall[0]).toContain('JOIN messages m');
      expect(joinCall[0]).toContain('m.tool_calls @>');
    });

    it('uses DISTINCT to deduplicate when joining messages', async () => {
      await reader.init();
      mockQuery.mockResolvedValue({ rows: [mockConvRow], rowCount: 1 });

      await reader.joinFromQdrant(
        [{ task_id: 't-reader-test', score: 0.9 }],
        { tool_name: 'read_file' },
      );

      const call = mockQuery.mock.calls[0];
      expect(call[0]).toContain('SELECT DISTINCT c.*');
    });
  });

  describe('parameterized queries (SQL injection safety)', () => {
    it('getConversation uses $1 placeholder', async () => {
      await reader.init();
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await reader.getConversation("'; DROP TABLE conversations; --");

      const call = mockQuery.mock.calls[0];
      expect(call[0]).toContain('$1');
      expect(call[0]).not.toContain('DROP TABLE');
      expect(call[1][0]).toBe("'; DROP TABLE conversations; --");
    });
  });
});
