/**
 * PgUnifiedStoreReader — Concrete Postgres reader for the unified store (2-step search)
 *
 * @module services/unified-store/PgUnifiedStoreReader
 * @issue #2426 Phase C (Epic #2191 unified store)
 *
 * 2-step read path (ADR 010 v2.0 Scenario B):
 *   1. Qdrant ANN over content embeddings -> top-K task_id + score
 *   2. JOIN Postgres conversations + messages for the filter set
 *
 * This restores roosync_search #636 filters (has_errors, tool_name, role, etc.)
 * via the GIN idx_msg_toolcalls + plain BTREE on conversations.
 *
 * Connection string: UNIFIED_STORE_PG_URL (same as writer)
 */

import pg from 'pg';
import type {
  UnifiedStoreSearchFilters,
  UnifiedStoreSearchHit,
  ConversationRow,
  MessageRow,
} from './types.js';
import type { IUnifiedStoreReader, UnifiedStoreReaderConfig } from './UnifiedStoreReader.js';

export class PgUnifiedStoreReader implements IUnifiedStoreReader {
  private pool: pg.Pool | null = null;
  private readonly config: UnifiedStoreReaderConfig;
  private initialized = false;

  constructor(config: UnifiedStoreReaderConfig) {
    this.config = config;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.initialized && this.pool) return;

    this.pool = new pg.Pool({
      connectionString: this.config.connectionString,
      max: this.config.poolMax ?? 5,
      statement_timeout: this.config.statementTimeoutMs ?? 5000,
    });

    // Verify connectivity
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }

    this.initialized = true;
    console.info('[PgUnifiedStoreReader] Pool initialized and connected');
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.initialized = false;
      console.info('[PgUnifiedStoreReader] Pool drained');
    }
  }

  async ping(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      const client = await this.pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
      return true;
    } catch {
      return false;
    }
  }

  // ─── Single lookups ────────────────────────────────────────────

  async getConversation(taskId: string): Promise<ConversationRow | null> {
    if (!this.pool) return null;

    const result = await this.pool.query(
      'SELECT * FROM conversations WHERE task_id = $1',
      [taskId],
    );

    if (result.rows.length === 0) return null;
    return this.mapConversationRow(result.rows[0]);
  }

  async getMessages(
    taskId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<MessageRow[]> {
    if (!this.pool) return [];

    const limit = opts?.limit ?? 1000;
    const offset = opts?.offset ?? 0;

    const result = await this.pool.query(
      'SELECT * FROM messages WHERE task_id = $1 ORDER BY seq ASC LIMIT $2 OFFSET $3',
      [taskId, limit, offset],
    );

    return result.rows.map(row => this.mapMessageRow(row));
  }

  // ─── 2-step search: Qdrant ANN → Postgres JOIN ────────────────

  async joinFromQdrant(
    qdrantHits: Array<{ task_id: string; score: number }>,
    filters?: UnifiedStoreSearchFilters,
  ): Promise<UnifiedStoreSearchHit[]> {
    if (!this.pool || qdrantHits.length === 0) return [];

    const taskIds = qdrantHits.map(h => h.task_id);
    const scoreMap = new Map(qdrantHits.map(h => [h.task_id, h.score]));

    // Build WHERE clause from filters
    const conditions: string[] = ['c.task_id = ANY($1)'];
    const params: unknown[] = [taskIds];
    let paramIdx = 2;

    if (filters?.machine_id) {
      conditions.push(`c.machine_id = $${paramIdx++}`);
      params.push(filters.machine_id);
    }
    if (filters?.workspace) {
      conditions.push(`c.workspace = $${paramIdx++}`);
      params.push(filters.workspace);
    }
    if (filters?.harness) {
      conditions.push(`c.harness = $${paramIdx++}`);
      params.push(filters.harness);
    }
    if (filters?.since) {
      conditions.push(`c.last_ts >= $${paramIdx++}`);
      params.push(filters.since);
    }
    if (filters?.until) {
      conditions.push(`c.last_ts <= $${paramIdx++}`);
      params.push(filters.until);
    }

    // Join messages if tool_name filter is specified
    let joinClause = '';
    if (filters?.tool_name) {
      joinClause = ` JOIN messages m ON m.task_id = c.task_id`;
      // GIN index on tool_calls JSONB — use @> containment operator
      conditions.push(`m.tool_calls @> $${paramIdx++}`);
      params.push(JSON.stringify([{ name: filters.tool_name }]));
    }

    const whereClause = conditions.join(' AND ');
    const sql = `
      SELECT DISTINCT c.*
      FROM conversations c${joinClause}
      WHERE ${whereClause}
      ORDER BY c.last_ts DESC
    `;

    const result = await this.pool.query(sql, params);

    // If tool_name filter, also fetch matching messages for each hit
    const hits: UnifiedStoreSearchHit[] = [];
    for (const row of result.rows) {
      const conv = this.mapConversationRow(row);
      const hit: UnifiedStoreSearchHit = {
        task_id: conv.task_id,
        score: scoreMap.get(conv.task_id) ?? 0,
        conversation: conv,
      };

      // Fetch matched messages if tool_name filter was applied
      if (filters?.tool_name) {
        hit.matched_messages = await this.getMessagesByToolCall(conv.task_id, filters.tool_name);
      }

      hits.push(hit);
    }

    return hits;
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private async getMessagesByToolCall(taskId: string, toolName: string): Promise<MessageRow[]> {
    if (!this.pool) return [];

    const result = await this.pool.query(
      `SELECT * FROM messages
       WHERE task_id = $1 AND tool_calls @> $2
       ORDER BY seq ASC`,
      [taskId, JSON.stringify([{ name: toolName }])],
    );

    return result.rows.map(row => this.mapMessageRow(row));
  }

  private mapConversationRow(row: pg.QueryResult['rows'][0]): ConversationRow {
    return {
      task_id: row.task_id,
      machine_id: row.machine_id,
      harness: row.harness,
      workspace: row.workspace ?? null,
      parent_task_id: row.parent_task_id ?? null,
      title: row.title ?? null,
      first_ts: row.first_ts ?? null,
      last_ts: row.last_ts ?? null,
      msg_count: row.msg_count ?? 0,
      metadata: row.metadata ?? null,
      ingested_at: row.ingested_at,
    };
  }

  private mapMessageRow(row: pg.QueryResult['rows'][0]): MessageRow {
    return {
      id: row.id,
      task_id: row.task_id,
      message_id: row.message_id ?? null,
      seq: row.seq,
      role: row.role,
      content: row.content ?? null,
      tool_calls: row.tool_calls ?? null,
      ts: row.ts,
    };
  }
}
