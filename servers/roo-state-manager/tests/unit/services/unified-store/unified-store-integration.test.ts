/**
 * Unified Store — Integration tests for env-gate ON path.
 *
 * Tests the full wiring chain with mocked pg but real factory/hook logic:
 *   1. Writer factory → PgUnifiedStoreWriter when env-gate ON
 *   2. Reader factory → PgUnifiedStoreReader when env-gate ON
 *   3. isNull() returns correct values per impl (reader only)
 *   4. Writer → reader round-trip (upsert → query with same mock data)
 *   5. joinFromQdrant preserves ANN ranking (score DESC, not last_ts)
 *   6. jsonb[] guard: non-serializable tool_calls stored as null
 *   7. Null object safety (writer + reader no-op when env-gate OFF)
 *
 * @issue #2426 Phase C+ (Epic #2191)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getUnifiedStoreWriter,
  resetWriterInstance,
} from '../../../../src/services/unified-store/writer-factory.js';
import {
  getUnifiedStoreReader,
  resetReaderInstance,
} from '../../../../src/services/unified-store/reader-factory.js';
import { NullUnifiedStoreWriter } from '../../../../src/services/unified-store/UnifiedStoreWriter.js';
import { NullUnifiedStoreReader } from '../../../../src/services/unified-store/UnifiedStoreReader.js';
import { PgUnifiedStoreWriter } from '../../../../src/services/unified-store/PgUnifiedStoreWriter.js';
import { PgUnifiedStoreReader } from '../../../../src/services/unified-store/PgUnifiedStoreReader.js';
import type { ConversationBundle, MessageRow, UnifiedStoreSearchFilters } from '../../../../src/services/unified-store/types.js';

// ─── Mock pg module ────────────────────────────────────────────────

const mockPoolQuery = vi.fn();
const mockPoolConnect = vi.fn();
const mockPoolEnd = vi.fn();

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(() => ({
      connect: mockPoolConnect,
      end: mockPoolEnd,
      query: mockPoolQuery,
    })),
  },
}));

/** Create a mock pg client with pre-programmed responses. */
function mockClient(responses: Array<{ rowCount: number; rows?: any[] }> = []) {
  const query = vi.fn();
  for (const resp of responses) {
    query.mockResolvedValueOnce(resp);
  }
  // Default: BEGIN/COMMIT/ROLLBACK and other queries
  query.mockResolvedValue({ rowCount: 1, rows: [] });
  return { query, release: vi.fn() };
}

/** Helper to set env-gate ON for both reader and writer. */
function enableEnvGate(): void {
  process.env.UNIFIED_STORE_DUAL_WRITE = '1';
  process.env.UNIFIED_STORE_PG_URL = 'postgres://test:test@localhost:5433/unified_store';
}

// ─── Fixtures ──────────────────────────────────────────────────────

const testConv: ConversationBundle = {
  conversation: {
    task_id: 't-integ-test',
    machine_id: 'myia-po-2025',
    harness: 'claude',
    workspace: 'roo-extensions',
    parent_task_id: null,
    title: 'Integration test',
    first_ts: '2026-05-31T08:00:00Z',
    last_ts: '2026-05-31T08:10:00Z',
    msg_count: 2,
    metadata: { mode: 'code-simple' },
  },
  messages: [
    {
      task_id: 't-integ-test',
      message_id: null,
      seq: 0,
      role: 'user',
      content: 'Search for patterns',
      tool_calls: null,
      ts: '2026-05-31T08:00:00Z',
    },
    {
      task_id: 't-integ-test',
      message_id: null,
      seq: 1,
      role: 'assistant',
      content: 'Found 3 results',
      tool_calls: [{ name: 'roosync_search', arguments: { action: 'semantic' } }],
      ts: '2026-05-31T08:01:00Z',
    },
  ],
};

// ─── Tests ─────────────────────────────────────────────────────────

describe('unified-store integration — env-gate ON', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetWriterInstance();
    resetReaderInstance();
    vi.clearAllMocks();
    delete process.env.UNIFIED_STORE_DUAL_WRITE;
    delete process.env.UNIFIED_STORE_PG_URL;
  });

  afterEach(() => {
    resetWriterInstance();
    resetReaderInstance();
    process.env = { ...originalEnv };
  });

  // ── Factory wiring ─────────────────────────────────────────────

  describe('factory wiring', () => {
    it('writer factory returns NullUnifiedStoreWriter when env-gate OFF', () => {
      const writer = getUnifiedStoreWriter();
      expect(writer).toBeInstanceOf(NullUnifiedStoreWriter);
    });

    it('reader factory returns NullUnifiedStoreReader when env-gate OFF', () => {
      const reader = getUnifiedStoreReader();
      expect(reader).toBeInstanceOf(NullUnifiedStoreReader);
      expect(reader.isNull()).toBe(true);
    });

    it('writer factory returns PgUnifiedStoreWriter when env-gate ON', () => {
      enableEnvGate();
      const writer = getUnifiedStoreWriter();
      expect(writer).toBeInstanceOf(PgUnifiedStoreWriter);
    });

    it('reader factory returns PgUnifiedStoreReader when env-gate ON', () => {
      enableEnvGate();
      const reader = getUnifiedStoreReader();
      expect(reader).toBeInstanceOf(PgUnifiedStoreReader);
      expect(reader.isNull()).toBe(false);
    });

    it('both factories use the same env-gate vars (symmetric activation)', () => {
      // OFF
      let writer = getUnifiedStoreWriter();
      let reader = getUnifiedStoreReader();
      expect(writer).toBeInstanceOf(NullUnifiedStoreWriter);
      expect(reader.isNull()).toBe(true);

      // Reset + ON
      resetWriterInstance();
      resetReaderInstance();
      enableEnvGate();

      writer = getUnifiedStoreWriter();
      reader = getUnifiedStoreReader();
      expect(writer).toBeInstanceOf(PgUnifiedStoreWriter);
      expect(reader.isNull()).toBe(false);
    });
  });

  // ── Writer → Reader round-trip (mocked pg) ────────────────────

  describe('write → read round-trip', () => {
    it('writer calls upsertConversation with correct SQL when env-gate ON', async () => {
      enableEnvGate();

      // Mock pool.connect() for init() — returns a client for the SELECT 1 health check
      const initClient = mockClient([{ rowCount: 1, rows: [{ '?column?': 1 }] }]);
      // Mock pool.connect() for upsertConversation() — transaction client
      const txnClient = mockClient([
        { rowCount: 0, rows: [] }, // BEGIN
        { rowCount: 1, rows: [] }, // upsertConversationRow
        { rowCount: 2, rows: [] }, // upsertMessagesRows
        { rowCount: 0, rows: [] }, // COMMIT
      ]);
      mockPoolConnect
        .mockResolvedValueOnce(initClient)   // init() health check
        .mockResolvedValueOnce(txnClient);    // upsertConversation() transaction

      const writer = getUnifiedStoreWriter() as PgUnifiedStoreWriter;
      await writer.init();
      await writer.upsertConversation(testConv);

      // Verify the writer called connect (transaction pattern)
      expect(mockPoolConnect).toHaveBeenCalledTimes(2);

      // Verify SQL contains parameterized query (not string interpolation)
      const sqlCalls = txnClient.query.mock.calls.map((c: any[]) => c[0]);
      const hasParametrizedInsert = sqlCalls.some(
        (sql: string) => typeof sql === 'string' && sql.includes('$1') && sql.includes('INSERT'),
      );
      expect(hasParametrizedInsert).toBe(true);

      await writer.close();
    });

    it('reader returns conversation when found via getConversation', async () => {
      enableEnvGate();

      const convRow = {
        task_id: 't-integ-test',
        machine_id: 'myia-po-2025',
        harness: 'claude',
        workspace: 'roo-extensions',
        parent_task_id: null,
        title: 'Integration test',
        first_ts: '2026-05-31T08:00:00Z',
        last_ts: '2026-05-31T08:10:00Z',
        msg_count: 2,
        metadata: null,
        ingested_at: '2026-05-31T08:11:00Z',
      };

      // init() health check client
      const initClient = mockClient([{ rowCount: 1, rows: [{ '?column?': 1 }] }]);
      mockPoolConnect.mockResolvedValueOnce(initClient);

      // getConversation query
      mockPoolQuery.mockResolvedValueOnce({ rows: [convRow], rowCount: 1 });

      const reader = getUnifiedStoreReader() as PgUnifiedStoreReader;
      await reader.init();
      const result = await reader.getConversation('t-integ-test');

      expect(result).not.toBeNull();
      expect(result!.task_id).toBe('t-integ-test');
      expect(result!.harness).toBe('claude');

      // Verify parameterized query (SQL injection safety)
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining('$1'),
        ['t-integ-test'],
      );

      await reader.close();
    });

    it('reader returns empty for non-existent conversation', async () => {
      enableEnvGate();

      // init() health check client
      const initClient = mockClient([{ rowCount: 1, rows: [{ '?column?': 1 }] }]);
      mockPoolConnect.mockResolvedValueOnce(initClient);

      // getConversation query — not found
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const reader = getUnifiedStoreReader() as PgUnifiedStoreReader;
      await reader.init();
      const result = await reader.getConversation('nonexistent');
      expect(result).toBeNull();

      await reader.close();
    });
  });

  // ── joinFromQdrant — ANN ranking preservation ─────────────────

  describe('joinFromQdrant — ANN ranking', () => {
    /** Helper to set up reader with init() already done. */
    async function initReader(): Promise<PgUnifiedStoreReader> {
      const initClient = mockClient([{ rowCount: 1, rows: [{ '?column?': 1 }] }]);
      mockPoolConnect.mockResolvedValueOnce(initClient);
      const reader = getUnifiedStoreReader() as PgUnifiedStoreReader;
      await reader.init();
      return reader;
    }

    it('preserves Qdrant score ordering (not last_ts)', async () => {
      enableEnvGate();

      // Qdrant returns: t-low (score 0.9), t-high (score 0.3), t-mid (score 0.6)
      const qdrantHits = [
        { task_id: 't-low', score: 0.9 },
        { task_id: 't-high', score: 0.3 },
        { task_id: 't-mid', score: 0.6 },
      ];

      // Postgres returns all 3 conversations (unsorted from DB)
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          { task_id: 't-high', machine_id: 'm1', harness: 'roo', workspace: 'w', parent_task_id: null, title: 'High', first_ts: '2026-05-31T10:00:00Z', last_ts: '2026-05-31T10:10:00Z', msg_count: 1, metadata: null, ingested_at: '2026-05-31T10:11:00Z' },
          { task_id: 't-low', machine_id: 'm1', harness: 'roo', workspace: 'w', parent_task_id: null, title: 'Low', first_ts: '2026-05-31T08:00:00Z', last_ts: '2026-05-31T08:10:00Z', msg_count: 1, metadata: null, ingested_at: '2026-05-31T08:11:00Z' },
          { task_id: 't-mid', machine_id: 'm1', harness: 'roo', workspace: 'w', parent_task_id: null, title: 'Mid', first_ts: '2026-05-31T09:00:00Z', last_ts: '2026-05-31T09:10:00Z', msg_count: 1, metadata: null, ingested_at: '2026-05-31T09:11:00Z' },
        ],
        rowCount: 3,
      });

      const reader = await initReader();
      const hits = await reader.joinFromQdrant(qdrantHits);

      // Must be sorted by score DESC (Qdrant ANN ranking), NOT by last_ts
      expect(hits).toHaveLength(3);
      expect(hits[0].task_id).toBe('t-low');   // score 0.9
      expect(hits[1].task_id).toBe('t-mid');   // score 0.6
      expect(hits[2].task_id).toBe('t-high');  // score 0.3

      // Verify scores match Qdrant
      expect(hits[0].score).toBe(0.9);
      expect(hits[1].score).toBe(0.6);
      expect(hits[2].score).toBe(0.3);

      await reader.close();
    });

    it('applies workspace filter via SQL WHERE', async () => {
      enableEnvGate();

      mockPoolQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      const reader = await initReader();

      const filters: UnifiedStoreSearchFilters = { workspace: 'roo-extensions' };
      await reader.joinFromQdrant([{ task_id: 't1', score: 0.5 }], filters);

      // Verify SQL contains workspace filter
      const sqlCall = mockPoolQuery.mock.calls[0];
      expect(sqlCall[0]).toContain('c.workspace');

      await reader.close();
    });

    it('applies tool_name filter via GIN JOIN', async () => {
      enableEnvGate();

      const convRow = {
        task_id: 't-tool', machine_id: 'm1', harness: 'roo', workspace: 'w',
        parent_task_id: null, title: 'Tool test', first_ts: '2026-05-31T08:00:00Z',
        last_ts: '2026-05-31T08:10:00Z', msg_count: 1, metadata: null, ingested_at: '2026-05-31T08:11:00Z',
      };

      // First query: joinFromQdrant conversation lookup
      mockPoolQuery.mockResolvedValueOnce({ rows: [convRow], rowCount: 1 });
      // Second query: getMessagesByToolCall
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 1, task_id: 't-tool', message_id: null, seq: 1, role: 'assistant',
          content: 'result', tool_calls: [{ name: 'roosync_search' }], ts: '2026-05-31T08:01:00Z',
        }],
        rowCount: 1,
      });

      const reader = await initReader();

      const filters: UnifiedStoreSearchFilters = { tool_name: 'roosync_search' };
      const hits = await reader.joinFromQdrant([{ task_id: 't-tool', score: 0.8 }], filters);

      expect(hits).toHaveLength(1);
      expect(hits[0].matched_messages).toBeDefined();
      expect(hits[0].matched_messages!.length).toBe(1);

      // Verify SQL contains GIN containment operator
      const sqlCall = mockPoolQuery.mock.calls[0];
      expect(sqlCall[0]).toContain('JOIN messages');
      expect(sqlCall[0]).toContain('@>');

      await reader.close();
    });

    it('returns empty array for empty qdrantHits', async () => {
      enableEnvGate();

      const reader = await initReader();
      const hits = await reader.joinFromQdrant([]);
      expect(hits).toEqual([]);

      await reader.close();
    });
  });

  // ── jsonb[] guard ─────────────────────────────────────────────

  describe('jsonb[] guard — non-serializable tool_calls', () => {
    /** Helper to set up writer with init() already done. */
    async function initWriter(): Promise<PgUnifiedStoreWriter> {
      const initClient = mockClient([{ rowCount: 1, rows: [{ '?column?': 1 }] }]);
      mockPoolConnect.mockResolvedValueOnce(initClient);
      const writer = getUnifiedStoreWriter() as PgUnifiedStoreWriter;
      await writer.init();
      return writer;
    }

    it('stores null for tool_calls with circular reference (graceful degradation)', async () => {
      enableEnvGate();

      // Transaction client for upsertConversation
      const txnClient = mockClient([
        { rowCount: 0, rows: [] }, // BEGIN
        { rowCount: 1, rows: [] }, // upsertConversationRow
        { rowCount: 1, rows: [] }, // upsertMessagesRows
        { rowCount: 0, rows: [] }, // COMMIT
      ]);
      mockPoolConnect
        .mockResolvedValueOnce(mockClient([{ rowCount: 1, rows: [{ '?column?': 1 }] }])) // init
        .mockResolvedValueOnce(txnClient); // upsert transaction

      const writer = await initWriter();

      // Create a message with non-standard tool_calls (circular ref will fail JSON.stringify)
      const circularObj: any = { name: 'test' };
      circularObj.self = circularObj; // Circular reference

      const bundle: ConversationBundle = {
        conversation: testConv.conversation,
        messages: [
          {
            task_id: 't-integ-test',
            message_id: null,
            seq: 0,
            role: 'assistant',
            content: 'test',
            tool_calls: circularObj, // This will fail JSON.stringify
            ts: '2026-05-31T08:00:00Z',
          },
        ],
      };

      // Should NOT throw — the guard catches the error and stores null
      await writer.upsertConversation(bundle);

      // Verify the UNNEST query was called (meaning the message was inserted)
      const unnestCall = txnClient.query.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('UNNEST'),
      );
      expect(unnestCall).toBeDefined();

      // The 6th parameter ($6::jsonb[]) should have null for the circular tool_calls
      const toolCallsParam = unnestCall![1][5]; // $6::jsonb[] is index 5 in the params array
      expect(toolCallsParam[0]).toBeNull(); // Circular ref → null guard

      await writer.close();
    });

    it('stores valid JSON for well-formed tool_calls', async () => {
      enableEnvGate();

      // Transaction client for upsertConversation
      const txnClient = mockClient([
        { rowCount: 0, rows: [] },
        { rowCount: 1, rows: [] },
        { rowCount: 1, rows: [] },
        { rowCount: 0, rows: [] },
      ]);
      mockPoolConnect
        .mockResolvedValueOnce(mockClient([{ rowCount: 1, rows: [{ '?column?': 1 }] }])) // init
        .mockResolvedValueOnce(txnClient); // upsert transaction

      const writer = await initWriter();
      await writer.upsertConversation(testConv);

      const unnestCall = txnClient.query.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('UNNEST'),
      );
      expect(unnestCall).toBeDefined();

      // Message seq=1 has tool_calls = [{ name: 'roosync_search', ... }]
      const toolCallsParam = unnestCall![1][5];
      // seq=0 has null tool_calls, seq=1 has valid JSON
      expect(toolCallsParam[0]).toBeNull(); // seq=0
      expect(toolCallsParam[1]).toBe('[{"name":"roosync_search","arguments":{"action":"semantic"}}]'); // seq=1

      await writer.close();
    });
  });

  // ── Null object safety ────────────────────────────────────────

  describe('null object safety', () => {
    it('NullWriter.upsertConversation never throws', async () => {
      const writer = getUnifiedStoreWriter(); // env-gate OFF
      expect(writer).toBeInstanceOf(NullUnifiedStoreWriter);
      // Should silently succeed
      await expect(writer.upsertConversation(testConv)).resolves.toBeUndefined();
    });

    it('NullReader.joinFromQdrant returns empty array', async () => {
      const reader = getUnifiedStoreReader(); // env-gate OFF
      expect(reader.isNull()).toBe(true);
      const hits = await reader.joinFromQdrant([{ task_id: 't1', score: 0.9 }]);
      expect(hits).toEqual([]);
    });

    it('NullReader.getConversation returns null', async () => {
      const reader = getUnifiedStoreReader();
      const result = await reader.getConversation('any');
      expect(result).toBeNull();
    });

    it('NullReader.getMessages returns empty array', async () => {
      const reader = getUnifiedStoreReader();
      const result = await reader.getMessages('any');
      expect(result).toEqual([]);
    });
  });
});
