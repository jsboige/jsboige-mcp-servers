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
  RooSyncAttachmentMetadataRow,
  RooSyncMessageRow,
  RooSyncDashboardRow,
  RooSyncDashboardMessageRow,
  DashboardRetirementMark,
} from './types.js';
import type {
  IUnifiedStoreReader,
  UnifiedStoreReaderConfig,
  RooSyncMailboxReadOptions,
  ConversationListFilters,
  ConversationListRow,
} from './UnifiedStoreReader.js';

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
      // #4131 B15: 5 s statement timeout fired 189× on 22/10 under mailbox
      // load — default headroom 15 s (same as ai-01's stopgap); still bounded.
      statement_timeout: this.config.statementTimeoutMs ?? 15000,
      // #2191 deep-queue: without this, a dropped-SYN host hangs pool.connect()
      // until the OS TCP timeout — the GDrive fallback catch never fires.
      connectionTimeoutMillis: this.config.connectionTimeoutMillis ?? 15000,
    });

    // Idle-client errors are emitted on the POOL with no awaited query to
    // reject — unhandled, they crash the process (see the writer's identical
    // handler for the #3292 incident note). In-flight reads reject normally.
    this.pool.on('error', err => {
      console.warn('[PgUnifiedStoreReader] Idle pool client error — pool stays usable', err?.message ?? err);
    });

    // Verify connectivity
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }

    this.initialized = true;
    console.error('[PgUnifiedStoreReader] Pool initialized and connected');
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.initialized = false;
      console.error('[PgUnifiedStoreReader] Pool drained');
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

  /**
   * #4131 (migrations/012) — read one key of `roosync_store_meta`.
   *
   * Carries the backfill completeness markers. Throws when the table does
   * not exist yet (the migration was never applied on this store) or the
   * store is unreachable — the caller treats both as "no proof of
   * completeness" and keeps the GDrive path.
   */
  async getStoreMeta(key: string): Promise<string | null> {
    if (!this.pool) await this.init();
    if (!this.pool) throw new Error('Pool not initialized');
    const result = await this.pool.query(
      'SELECT value FROM roosync_store_meta WHERE key = $1',
      [key]
    );
    if (result.rows.length === 0) return null;
    const value = result.rows[0].value;
    return typeof value === 'string' ? value : String(value ?? '');
  }

  isNull(): boolean { return false; }

  // ─── RooSync channel reads (#3151 Phase B) ─────────────────────

  async getRooSyncMailbox(machineId: string, opts?: RooSyncMailboxReadOptions): Promise<RooSyncMessageRow[]> {
    if (!this.pool) await this.init();
    if (!this.pool) throw new Error('Pool not initialized');

    // #4131 B15 — array-shaped recipient clause + explicit columns so the
    // partial index idx_roosync_messages_mailbox_live (to_machine,
    // created_at DESC, WHERE the live-set predicate, migrations/011) serves
    // the read. The OR form fetched the machine's full history including
    // archived/destroyed rows: 5 139 dead rows per read for 486 live ones,
    // 4 212 vs 575 shared buffers (EXPLAIN ANALYZE, 23/10). `body` is the
    // one unbounded column — `bodyChars` bounds it (RooSyncMailboxReadOptions).
    const bodyChars = opts?.bodyChars;
    const bodyExpr = bodyChars === undefined
      ? 'body'
      : bodyChars > 0 ? 'LEFT(body, $2) AS body' : "'' AS body";
    const params: Array<string | number | string[]> = [[machineId, 'all', 'All']];
    if (bodyChars !== undefined && bodyChars > 0) params.push(bodyChars);

    const result = await this.pool.query(
      `SELECT id, thread_id, from_machine, from_workspace, to_machine, to_workspace,
              subject, ${bodyExpr}, priority, status, tags, attachment_refs, created_at,
              reply_to, read_by, read_by_workspace, options, destroyed_at, destroyed_reason,
              reminder_sent_at
       FROM roosync_messages
       WHERE status <> 'archived'
         AND destroyed_at IS NULL
         AND to_machine = ANY($1::text[])
       ORDER BY created_at DESC`,
      params,
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

  async getRooSyncChannelMessages(): Promise<RooSyncMessageRow[]> {
    if (!this.pool) await this.init();
    if (!this.pool) throw new Error('Pool not initialized');

    // Same live set as getRooSyncMailbox minus the recipient clause — the
    // global scans (#4302) are recipient-blind by design. Explicit columns
    // (#4131 B15); the partial index idx_roosync_messages_channel_live
    // (created_at DESC, migrations/011) serves the ordered scan. Full body:
    // both consumers (cleanupExpiredMessages, sendExpiryReminders) map rows
    // to full Messages.
    const result = await this.pool.query(
      `SELECT id, thread_id, from_machine, from_workspace, to_machine, to_workspace,
              subject, body, priority, status, tags, attachment_refs, created_at,
              reply_to, read_by, read_by_workspace, options, destroyed_at, destroyed_reason,
              reminder_sent_at
       FROM roosync_messages
       WHERE status <> 'archived'
         AND destroyed_at IS NULL
       ORDER BY created_at DESC`
    );

    return result.rows.map(row => this.mapRooSyncMessageRow(row));
  }

  // ─── RooSync attachment reads (#3151 §7.5.2) ─────────────────────

  async getRooSyncAttachmentById(id: string): Promise<(RooSyncAttachmentMetadataRow & { payload: Buffer }) | null> {
    if (!this.pool) await this.init();
    if (!this.pool) throw new Error('Pool not initialized');

    const result = await this.pool.query(
      'SELECT * FROM roosync_attachments WHERE id = $1',
      [id],
    );

    if (result.rows.length === 0) return null;
    return this.mapRooSyncAttachmentRow(result.rows[0], true) as RooSyncAttachmentMetadataRow & { payload: Buffer };
  }

  async listRooSyncAttachmentMetadata(uuids: string[]): Promise<RooSyncAttachmentMetadataRow[]> {
    if (uuids.length === 0) return [];
    if (!this.pool) await this.init();
    if (!this.pool) throw new Error('Pool not initialized');

    const result = await this.pool.query(
      'SELECT * FROM roosync_attachments WHERE id = ANY($1::text[])',
      [uuids],
    );

    return result.rows.map((row: pg.QueryResult['rows'][0]) =>
      this.mapRooSyncAttachmentRow(row, false));
  }

  async scanRooSyncAttachments(messageId?: string): Promise<RooSyncAttachmentMetadataRow[]> {
    if (!this.pool) await this.init();
    if (!this.pool) throw new Error('Pool not initialized');

    const result = messageId
      ? await this.pool.query(
        'SELECT * FROM roosync_attachments WHERE message_id = $1 ORDER BY uploaded_at DESC',
        [messageId],
      )
      : await this.pool.query('SELECT * FROM roosync_attachments ORDER BY uploaded_at DESC');

    return result.rows.map((row: pg.QueryResult['rows'][0]) =>
      this.mapRooSyncAttachmentRow(row, false));
  }

  private mapRooSyncAttachmentRow(
    row: pg.QueryResult['rows'][0],
    withPayload: boolean,
  ): RooSyncAttachmentMetadataRow | (RooSyncAttachmentMetadataRow & { payload: Buffer }) {
    const mapped: RooSyncAttachmentMetadataRow = {
      id: row.id,
      filename: row.filename,
      mime: row.mime,
      size: Number(row.size),
      sha256: row.sha256,
      uploaderMachine: row.uploader_machine,
      uploaderWorkspace: row.uploader_workspace,
      messageId: row.message_id,
      uploadedAt: new Date(row.uploaded_at).toISOString(),
    };
    if (withPayload) return { ...mapped, payload: Buffer.from(row.payload) };
    return mapped;
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

  // ─── RooSync dashboard retirements (#3782) ───────────────────────

  async getArchivedRooSyncDashboardMessageIds(key: string): Promise<string[] | null> {
    if (!this.pool) await this.init();
    if (!this.pool) throw new Error('Pool not initialized');

    const result = await this.pool.query(
      `SELECT message_id FROM roosync_dashboard_messages
       WHERE dashboard_key = $1 AND archived_at IS NOT NULL AND message_id IS NOT NULL`,
      [key],
    );
    return result.rows.map(r => r.message_id as string);
  }

  async getRooSyncDashboardRetirement(key: string): Promise<DashboardRetirementMark | null> {
    if (!this.pool) await this.init();
    if (!this.pool) throw new Error('Pool not initialized');

    const result = await this.pool.query(
      `SELECT source_key, target_key, retired_by, retired_at
       FROM roosync_dashboard_retirements
       WHERE source_key = $1 AND lifted_at IS NULL`,
      [key],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      sourceKey: row.source_key,
      targetKey: row.target_key,
      retiredBy: row.retired_by,
      retiredAt: row.retired_at instanceof Date
        ? row.retired_at.toISOString()
        : String(row.retired_at),
    };
  }

  async listRetiredRooSyncDashboardKeys(): Promise<string[]> {
    if (!this.pool) await this.init();
    if (!this.pool) throw new Error('Pool not initialized');

    const result = await this.pool.query(
      'SELECT source_key FROM roosync_dashboard_retirements WHERE lifted_at IS NULL',
    );
    return result.rows.map(r => String(r.source_key));
  }

  async listRooSyncDashboardKeys(): Promise<string[]> {
    if (!this.pool) await this.init();
    if (!this.pool) throw new Error('Pool not initialized');

    const result = await this.pool.query('SELECT key FROM roosync_dashboards');
    return result.rows.map(r => String(r.key));
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
      read_by_workspace: row.read_by_workspace ?? [],
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

  /**
   * List conversations for the list_conversations PG tier.
   *
   * The LEFT JOIN LATERAL rides `messages_task_seq_unique (task_id, seq)` —
   * the UNIQUE constraint declared in migrations/001, so no index is added
   * here. Measured on the live store 2026-09-07 (12,887 conversations /
   * 2,773,371 messages): machine-filtered, 1,114 rows returned, all buffers
   * cached, `Execution Time: 14.0 ms` (the LATERAL itself: 1,114 index
   * searches, 0.006 ms each). The `conversations` scan is sequential and stays
   * so deliberately — at this row count an index would be speculative code.
   */
  async listConversations(filters?: ConversationListFilters): Promise<ConversationListRow[]> {
    // Self-init + THROW, like the RooSync reads above — not the `return []` of
    // getConversation/getMessages. No path calls init() explicitly (#2816), so
    // `return []` on a null pool would render a silently EMPTY tier that is
    // indistinguishable from "PG holds nothing for this filter". A throw is
    // caught by the caller and surfaced as pg_tier.status=failed with the error.
    if (!this.pool) await this.init();
    if (!this.pool) throw new Error('Pool not initialized');

    const machineId = filters?.machineId?.trim() || null;
    const limit = filters?.limit ?? 5000;
    // #2428 levier (a) — window bounds ride the WHERE, parameterized. Applied
    // before the LIMIT on purpose: with the dates only filtered in JS
    // (unified-header-pipeline.ts), the cap was spent on the newest 5 000 rows
    // overall and any older window rendered 0 (11 081 of 16 081 unreachable,
    // measured 23/10). The bounds filter on COALESCE(last_ts, first_ts,
    // ingested_at) — the same chain `mapRowToSkeleton` dates a row with
    // (`conversation-list-store.ts`, `last_ts ?? meta.lastActivity ?? first_ts
    // ?? ingested_at`), minus `meta.lastActivity`, which 0 of the 84 NULL-
    // `last_ts` rows carry (measured 24/10). A NULL-`last_ts` row is therefore
    // judged on the date the list displays it with, not dropped from every
    // window.
    const startDate = filters?.startDate ?? null;
    const endDate = filters?.endDate ?? null;

    const result = await this.pool.query(
      `WITH c AS (
         SELECT * FROM conversations
         WHERE ($1::text IS NULL OR LOWER(machine_id) = LOWER($1))
           AND ($3::timestamptz IS NULL OR COALESCE(last_ts, first_ts, ingested_at) >= $3::timestamptz)
           AND ($4::timestamptz IS NULL OR COALESCE(last_ts, first_ts, ingested_at) <= $4::timestamptz)
         ORDER BY last_ts DESC NULLS LAST
         LIMIT $2
       )
       SELECT c.*, m.content AS first_user_message
       FROM c
       LEFT JOIN LATERAL (
         SELECT content FROM messages
         WHERE messages.task_id = c.task_id
           AND messages.role = 'user'
           AND messages.content IS NOT NULL
         ORDER BY messages.seq ASC
         LIMIT 1
       ) m ON TRUE`,
      [machineId, limit, startDate, endDate],
    );

    return result.rows.map(row => ({
      ...this.mapConversationRow(row),
      first_user_message: row.first_user_message ?? null,
    }));
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
