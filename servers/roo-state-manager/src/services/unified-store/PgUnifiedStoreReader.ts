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
  RooSyncMessageRow,
  RooSyncDashboardRow,
  RooSyncDashboardMessageRow,
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

  isNull(): boolean { return false; }

  // ─── RooSync channel reads (#3151 Phase B) ─────────────────────

  async getRooSyncMailbox(machineId: string): Promise<RooSyncMessageRow[]> {
    if (!this.pool) await this.init();
    if (!this.pool) throw new Error('Pool not initialized');

    const result = await this.pool.query(
      `SELECT * FROM roosync_messages
       WHERE status <> 'archived'
         AND (to_machine = $1 OR to_machine IN ('all', 'All'))
       ORDER BY created_at DESC`,
      [machineId],
    );

    return result.rows.map(row => this.mapRooSyncMessageRow(row));
  }

  async getRooSyncMessageById(id: string): Promise<RooSyncMessageRow | null> {
    if (!this.pool) await this.init();
    if (!this.pool) throw new Error('Pool not initialized');

    const result = await this.pool.query(
      'SELECT * FROM roosync_messages WHERE id = $1',
      [id],
    );

    if (result.rows.length === 0) return null;
    return this.mapRooSyncMessageRow(result.rows[0]);
  }

  // ─── RooSync dashboard reads (#3151 Phase C) ─────────────────────

  async getRooSyncDashboard(key: string): Promise<{
    dashboard: RooSyncDashboardRow;
    messages: RooSyncDashboardMessageRow[];
  } | null> {
    if (!this.pool) await this.init();
    if (!this.pool) throw new Error('Pool not initialized');

    const dashResult = await this.pool.query(
      'SELECT * FROM roosync_dashboards WHERE key = $1',
      [key],
    );
    if (dashResult.rows.length === 0) return null;

    const msgResult = await this.pool.query(
      `SELECT * FROM roosync_dashboard_messages
       WHERE dashboard_key = $1 AND archived_at IS NULL
       ORDER BY created_at ASC, id ASC`,
      [key],
    );

    return {
      dashboard: this.mapRooSyncDashboardRow(dashResult.rows[0]),
      messages: msgResult.rows.map(r => this.mapRooSyncDashboardMessageRow(r)),
    };
  }

  private mapRooSyncDashboardRow(row: pg.QueryResult['rows'][0]): RooSyncDashboardRow {
    return {
      key: row.key,
      type: row.type,
      machine_id: row.machine_id ?? null,
      workspace: row.workspace ?? null,
      content: row.content ?? '',
      status_json: row.status_json ?? { lastModified: '', lastModifiedBy: { machineId: '', workspace: '' } },
      updated_at: row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : (row.updated_at ? String(row.updated_at) : undefined),
      version: row.version,
    };
  }

  private mapRooSyncDashboardMessageRow(row: pg.QueryResult['rows'][0]): RooSyncDashboardMessageRow {
    return {
      id: row.id,
      dashboard_key: row.dashboard_key,
      message_id: row.message_id ?? null,
      author_machine: row.author_machine,
      author_workspace: row.author_workspace,
      content: row.content ?? '',
      tags: row.tags ?? [],
      team_stage: row.team_stage ?? null,
      reply_to: row.reply_to ?? null,
      acknowledged_at: row.acknowledged_at ?? null,
      archived_at: row.archived_at instanceof Date
        ? row.archived_at.toISOString()
        : (row.archived_at ? String(row.archived_at) : null),
      created_at: row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    };
  }

  private mapRooSyncMessageRow(row: pg.QueryResult['rows'][0]): RooSyncMessageRow {
    return {
      id: row.id,
      thread_id: row.thread_id ?? null,
      from_machine: row.from_machine,
      from_workspace: row.from_workspace ?? '',
      to_machine: row.to_machine,
      to_workspace: row.to_workspace ?? '',
      subject: row.subject ?? '',
      body: row.body ?? '',
      priority: row.priority ?? 'MEDIUM',
      status: row.status ?? 'unread',
      tags: row.tags ?? [],
      attachment_refs: row.attachment_refs ?? [],
      created_at: row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
      reply_to: row.reply_to ?? null,
      read_by: row.read_by ?? [],
      options: row.options ?? {},
      destroyed_at: row.destroyed_at ?? null,
      destroyed_reason: row.destroyed_reason ?? null,
      reminder_sent_at: row.reminder_sent_at ?? null,
    };
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
    // #2426 Phase C+: No ORDER BY — preserve Qdrant ANN relevance ranking
    // (re-sorted by score after constructing hits)
    const sql = `
      SELECT DISTINCT c.*
      FROM conversations c${joinClause}
      WHERE ${whereClause}
    `;

    const result = await this.pool.query(sql, params);

    // Construct hits with Qdrant scores, then sort by score DESC to preserve ANN ranking
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

    // Sort by Qdrant ANN score descending (highest relevance first)
    hits.sort((a, b) => b.score - a.score);
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
