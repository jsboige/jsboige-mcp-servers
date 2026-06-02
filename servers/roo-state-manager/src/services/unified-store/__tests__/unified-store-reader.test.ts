/**
 * Tests for PgUnifiedStoreReader — Postgres-backed unified store reader (2-step search)
 *
 * #2426 Phase 2: Tests for the 2-step read path (Qdrant ANN → Postgres JOIN).
 * Uses mocked pg.Pool to avoid real DB dependency.
 *
 * @module services/unified-store/__tests__/unified-store-reader.test
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { PgUnifiedStoreReader } from '../PgUnifiedStoreReader.js';
import type { UnifiedStoreSearchFilters } from '../types.js';

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

function createReader(): PgUnifiedStoreReader {
  return new PgUnifiedStoreReader({
    connectionString: 'postgres://test:test@localhost:5432/unified_store',
    poolMax: 2,
    statementTimeoutMs: 3000,
  });
}

function makeConversationRow(overrides: Record<string, unknown> = {}) {
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
    ingested_at: '2026-06-01T10:00:00Z',
    ...overrides,
  };
}

function makeMessageRow(overrides: Record<string, unknown> = {}) {
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

describe('PgUnifiedStoreReader', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(mockClient);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockEnd.mockResolvedValue(undefined);
    mockClient.release.mockReset();
  });

  // ─── Lifecycle ──────────────────────────────────────────────────

  describe('lifecycle', () => {
    test('init connects and verifies', async () => {
      const reader = createReader();
      await reader.init();

      expect(mockQuery).toHaveBeenCalledWith('SELECT 1');
    });

    test('close drains the pool', async () => {
      const reader = createReader();
      await reader.init();
      await reader.close();

      expect(mockEnd).toHaveBeenCalled();
    });

    test('ping returns true when pool is healthy', async () => {
      const reader = createReader();
      await reader.init();
      expect(await reader.ping()).toBe(true);
    });

    test('ping returns false when pool throws', async () => {
      mockConnect.mockRejectedValue(new Error('Connection refused'));
      const reader = createReader();
      await reader.init().catch(() => {});
      mockConnect.mockResolvedValue(mockClient);
      mockQuery.mockRejectedValue(new Error('DB down'));

      expect(await reader.ping()).toBe(false);
    });

    test('isNull returns false', async () => {
      const reader = createReader();
      expect(reader.isNull()).toBe(false);
    });
  });

  // ─── getConversation ────────────────────────────────────────────

  describe('getConversation', () => {
    test('returns conversation when found', async () => {
      const row = makeConversationRow();
      mockPoolQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const reader = createReader();
      await reader.init();
      const result = await reader.getConversation('task-123');

      expect(result).not.toBeNull();
      expect(result!.task_id).toBe('task-123');
      expect(result!.machine_id).toBe('myia-po-2023');
      expect(result!.harness).toBe('claude');
    });

    test('returns null when not found', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const reader = createReader();
      await reader.init();
      const result = await reader.getConversation('nonexistent');

      expect(result).toBeNull();
    });
  });

  // ─── getMessages ────────────────────────────────────────────────

  describe('getMessages', () => {
    test('returns messages ordered by seq', async () => {
      const rows = [
        makeMessageRow({ seq: 0, role: 'user' }),
        makeMessageRow({ seq: 1, role: 'assistant' }),
      ];
      mockPoolQuery.mockResolvedValue({ rows, rowCount: 2 });

      const reader = createReader();
      await reader.init();
      const result = await reader.getMessages('task-123');

      expect(result.length).toBe(2);
      expect(result[0].seq).toBe(0);
      expect(result[1].seq).toBe(1);

      // Verify ORDER BY seq ASC
      const queryCall = mockPoolQuery.mock.calls.find(
        c => typeof c[0] === 'string' && c[0].includes('ORDER BY seq')
      );
      expect(queryCall).toBeDefined();
    });

    test('respects limit and offset', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const reader = createReader();
      await reader.init();
      await reader.getMessages('task-123', { limit: 50, offset: 10 });

      const queryCall = mockPoolQuery.mock.calls.find(
        c => c[0].includes('LIMIT') && c[0].includes('OFFSET')
      );
      expect(queryCall).toBeDefined();
      expect(queryCall![1]).toEqual(['task-123', 50, 10]);
    });

    test('uses default limit=1000 when not specified', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const reader = createReader();
      await reader.init();
      await reader.getMessages('task-123');

      const queryCall = mockPoolQuery.mock.calls.find(
        c => Array.isArray(c[1]) && c[1][1] === 1000
      );
      expect(queryCall).toBeDefined();
    });
  });

  // ─── joinFromQdrant (2-step search) ─────────────────────────────

  describe('joinFromQdrant', () => {
    test('returns empty array when no hits', async () => {
      const reader = createReader();
      await reader.init();
      const result = await reader.joinFromQdrant([]);

      expect(result).toEqual([]);
    });

    test('maps Qdrant hits to search results with scores', async () => {
      const convRow = makeConversationRow({ task_id: 'task-1' });
      const convRow2 = makeConversationRow({ task_id: 'task-2' });

      // Mock the JOIN query at pool level
      mockPoolQuery.mockImplementation((sql: string) => {
        if (sql.includes('FROM conversations')) {
          return Promise.resolve({ rows: [convRow, convRow2], rowCount: 2 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const reader = createReader();
      await reader.init();

      const qdrantHits = [
        { task_id: 'task-1', score: 0.95 },
        { task_id: 'task-2', score: 0.80 },
      ];

      const result = await reader.joinFromQdrant(qdrantHits);

      expect(result.length).toBe(2);
      // Sorted by score DESC
      expect(result[0].score).toBe(0.95);
      expect(result[1].score).toBe(0.80);
      expect(result[0].task_id).toBe('task-1');
      expect(result[1].task_id).toBe('task-2');
    });

    test('applies machine_id filter', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const reader = createReader();
      await reader.init();

      const filters: UnifiedStoreSearchFilters = { machine_id: 'myia-po-2023' };
      await reader.joinFromQdrant(
        [{ task_id: 'task-1', score: 0.9 }],
        filters,
      );

      const queryCall = mockPoolQuery.mock.calls.find(
        c => typeof c[0] === 'string' && c[0].includes('machine_id')
      );
      expect(queryCall).toBeDefined();
    });

    test('applies workspace filter', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const reader = createReader();
      await reader.init();

      const filters: UnifiedStoreSearchFilters = { workspace: '/test/workspace' };
      await reader.joinFromQdrant(
        [{ task_id: 'task-1', score: 0.9 }],
        filters,
      );

      const queryCall = mockPoolQuery.mock.calls.find(
        c => typeof c[0] === 'string' && c[0].includes('workspace')
      );
      expect(queryCall).toBeDefined();
    });

    test('applies date range filters', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const reader = createReader();
      await reader.init();

      const filters: UnifiedStoreSearchFilters = {
        since: '2026-05-01T00:00:00Z',
        until: '2026-06-01T00:00:00Z',
      };
      await reader.joinFromQdrant(
        [{ task_id: 'task-1', score: 0.9 }],
        filters,
      );

      const queryCall = mockPoolQuery.mock.calls.find(
        c => typeof c[0] === 'string' && c[0].includes('last_ts')
      );
      expect(queryCall).toBeDefined();
    });

    test('joins messages when tool_name filter is specified', async () => {
      const convRow = makeConversationRow({ task_id: 'task-1' });
      const msgRow = makeMessageRow({
        task_id: 'task-1',
        tool_calls: [{ name: 'read_file', arguments: { path: '/test.ts' } }],
      });

      mockPoolQuery.mockImplementation((sql: string) => {
        if (sql.includes('JOIN messages')) {
          return Promise.resolve({ rows: [convRow], rowCount: 1 });
        }
        if (sql.includes('tool_calls @>')) {
          return Promise.resolve({ rows: [msgRow], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const reader = createReader();
      await reader.init();

      const filters: UnifiedStoreSearchFilters = { tool_name: 'read_file' };
      const result = await reader.joinFromQdrant(
        [{ task_id: 'task-1', score: 0.9 }],
        filters,
      );

      expect(result.length).toBe(1);
      // Should have matched messages because tool_name filter was applied
      expect(result[0].matched_messages).toBeDefined();
    });

    test('uses GIN @> operator for tool_calls JSONB filter', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const reader = createReader();
      await reader.init();

      const filters: UnifiedStoreSearchFilters = { tool_name: 'write_to_file' };
      await reader.joinFromQdrant(
        [{ task_id: 'task-1', score: 0.9 }],
        filters,
      );

      // Find the query that uses GIN @> containment
      const queryCall = mockPoolQuery.mock.calls.find(
        c => typeof c[0] === 'string' && c[0].includes('@>')
      );
      expect(queryCall).toBeDefined();
    });

    test('preserves Qdrant ANN ranking (sort by score DESC)', async () => {
      const convA = makeConversationRow({ task_id: 'task-a' });
      const convB = makeConversationRow({ task_id: 'task-b' });
      const convC = makeConversationRow({ task_id: 'task-c' });

      // Return in DB order (arbitrary), not score order
      mockPoolQuery.mockResolvedValue({ rows: [convB, convA, convC], rowCount: 3 });

      const reader = createReader();
      await reader.init();

      const result = await reader.joinFromQdrant([
        { task_id: 'task-c', score: 0.99 },
        { task_id: 'task-a', score: 0.85 },
        { task_id: 'task-b', score: 0.70 },
      ]);

      // Should be sorted by Qdrant score DESC
      expect(result[0].task_id).toBe('task-c');
      expect(result[0].score).toBe(0.99);
      expect(result[1].task_id).toBe('task-a');
      expect(result[1].score).toBe(0.85);
      expect(result[2].task_id).toBe('task-b');
      expect(result[2].score).toBe(0.70);
    });
  });
});
