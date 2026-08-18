/**
 * PgUnifiedStoreWriter — Concrete Postgres writer for the unified store
 *
 * @module services/unified-store/PgUnifiedStoreWriter
 * @issue #2426 Phase B (Epic #2191 unified store)
 *
 * Features:
 *   - pg.Pool connection management (connect once, reuse across calls)
 *   - Parameterized queries (SQL injection safe)
 *   - Retry with exponential backoff (transient network/GDrive-lag errors)
 *   - Circuit breaker (3 consecutive failures → OPEN for 60s, half-open probe)
 *   - Metrics emitted via log lines (prom-compatible pattern)
 *
 * Env-gate: UNIFIED_STORE_DUAL_WRITE=1 activates this writer via the
 * SkeletonCacheService hook. When unset/false, NullUnifiedStoreWriter is used.
 *
 * Connection string: UNIFIED_STORE_PG_URL (required when dual-write is ON)
 *   e.g. postgres://user:pass@pg.myia.io:5432/unified_store?sslmode=require
 */

import pg from 'pg';
import type {
  ConversationBundle,
  ConversationRow,
  MessageRow,
  RooSyncAttachmentRow,
  RooSyncMessageRow,
  RooSyncMessageUpdate,
} from './types.js';
import type { IUnifiedStoreWriter, UnifiedStoreWriterConfig } from './UnifiedStoreWriter.js';

// ─── Circuit Breaker ───────────────────────────────────────────────

type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

class CircuitBreaker {
  private state: BreakerState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly threshold: number;
  private readonly resetMs: number;

  constructor(threshold = 3, resetMs = 60_000) {
    this.threshold = threshold;
    this.resetMs = resetMs;
  }

  /** Returns true if the call should be allowed through. */
  allow(): boolean {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime >= this.resetMs) {
        this.state = 'HALF_OPEN';
        return true; // probe
      }
      return false; // still open
    }
    // HALF_OPEN — allow one probe
    return true;
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.threshold) {
      this.state = 'OPEN';
    }
  }

  getState(): BreakerState { return this.state; }
  getFailureCount(): number { return this.failureCount; }
}

// ─── Metrics ───────────────────────────────────────────────────────

interface WriterMetrics {
  upsertsTotal: number;
  upsertsSuccess: number;
  upsertsFailed: number;
  upsertsRetried: number;
  breakerOpens: number;
  lastError?: string;
  lastErrorTs?: string;
}

// ─── PgUnifiedStoreWriter ──────────────────────────────────────────

export class PgUnifiedStoreWriter implements IUnifiedStoreWriter {
  private pool: pg.Pool | null = null;
  private readonly config: UnifiedStoreWriterConfig;
  private breaker: CircuitBreaker;
  private metrics: WriterMetrics;
  private initialized = false;

  // Retry config
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;

  constructor(config: UnifiedStoreWriterConfig) {
    this.config = config;
    this.breaker = new CircuitBreaker(3, 60_000);
    this.metrics = {
      upsertsTotal: 0,
      upsertsSuccess: 0,
      upsertsFailed: 0,
      upsertsRetried: 0,
      breakerOpens: 0,
    };
    this.maxRetries = config.maxRetries ?? 2;
    this.baseDelayMs = config.baseDelayMs ?? 500;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.initialized && this.pool) return;

    this.pool = new pg.Pool({
      connectionString: this.config.connectionString,
      max: this.config.poolMax ?? 5,
      statement_timeout: this.config.statementTimeoutMs ?? 5000,
      // SSL is configured via the connection string (sslmode=require)
    });

    // Verify connectivity
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }

    this.initialized = true;
    console.info('[PgUnifiedStoreWriter] Pool initialized and connected');
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.initialized = false;
      console.info('[PgUnifiedStoreWriter] Pool drained');
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

  // ─── Upsert Operations ────────────────────────────────────────

  async upsertConversation(bundle: ConversationBundle): Promise<void> {
    await this.withRetry('upsertConversation', async () => {
      if (!this.pool) await this.init(); // #2816: no path calls init() explicitly — self-init on first use
      if (!this.pool) throw new Error('Pool not initialized');
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await this.upsertConversationRow(client, bundle.conversation);
        if (bundle.messages.length > 0) {
          await this.upsertMessagesRows(client, bundle.messages);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {}); // swallow rollback error
        throw err;
      } finally {
        client.release();
      }
    });
  }

  async upsertConversationOnly(row: ConversationRow): Promise<void> {
    await this.withRetry('upsertConversationOnly', async () => {
      if (!this.pool) await this.init(); // #2816: no path calls init() explicitly — self-init on first use
      if (!this.pool) throw new Error('Pool not initialized');
      const client = await this.pool.connect();
      try {
        await this.upsertConversationRow(client, row);
      } finally {
        client.release();
      }
    });
  }

  async upsertMessages(rows: MessageRow[]): Promise<void> {
    if (rows.length === 0) return;

    await this.withRetry('upsertMessages', async () => {
      if (!this.pool) await this.init(); // #2816: no path calls init() explicitly — self-init on first use
      if (!this.pool) throw new Error('Pool not initialized');
      const client = await this.pool.connect();
      try {
        await this.upsertMessagesRows(client, rows);
      } finally {
        client.release();
      }
    });
  }

  // ─── RooSync Channel Operations (#3151 Phase A) ────────────────

  async insertRooSyncMessage(row: RooSyncMessageRow): Promise<void> {
    await this.withRetry('insertRooSyncMessage', async () => {
      if (!this.pool) await this.init();
      if (!this.pool) throw new Error('Pool not initialized');
      const client = await this.pool.connect();
      try {
        const sql = `
          INSERT INTO roosync_messages
            (id, thread_id, from_machine, from_workspace, to_machine, to_workspace,
             subject, body, priority, status, tags, attachment_refs, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (id) DO NOTHING
        `;
        const params = [
          row.id,
          row.thread_id ?? null,
          row.from_machine,
          row.from_workspace,
          row.to_machine,
          row.to_workspace,
          row.subject,
          row.body,
          row.priority,
          row.status,
          // jsonb params must be stringified (pg does not auto-cast objects)
          JSON.stringify(row.tags ?? []),
          JSON.stringify(row.attachment_refs ?? []),
          row.created_at,
        ];
        await client.query(sql, params);
      } finally {
        client.release();
      }
    });
  }

  /**
   * Column mapping for {@link RooSyncMessageUpdate}. Driving the SET clause from
   * this table rather than from a chain of `if` blocks is deliberate: the previous
   * shape hard-coded `body` and `attachment_refs` in BOTH the early-return guard and
   * the builder, so adding a field meant editing two places and silently writing
   * nothing if you forgot one. Adding a column here is now the whole change.
   *
   * `jsonb` values are stringified before binding (node-postgres would otherwise
   * send a JS array as a Postgres array literal).
   */
  private static readonly ROOSYNC_MESSAGE_UPDATE_COLUMNS: ReadonlyArray<
    readonly [keyof RooSyncMessageUpdate, string, boolean]
  > = [
    ['body', 'body', false],
    ['attachment_refs', 'attachment_refs', true],
    ['status', 'status', false],
    ['read_at', 'read_at', false],
    ['archived_at', 'archived_at', false],
    ['destroyed_at', 'destroyed_at', false],
    ['destroyed_reason', 'destroyed_reason', false],
    ['reminder_sent_at', 'reminder_sent_at', false],
  ];

  async updateRooSyncMessage(
    id: string,
    fields: RooSyncMessageUpdate
  ): Promise<void> {
    const updates = PgUnifiedStoreWriter.ROOSYNC_MESSAGE_UPDATE_COLUMNS.filter(
      ([key]) => fields[key] !== undefined
    );
    // Nothing to update — skip before self-init (a no-op must not open a connection)
    if (updates.length === 0) return;
    await this.withRetry('updateRooSyncMessage', async () => {
      if (!this.pool) await this.init();
      if (!this.pool) throw new Error('Pool not initialized');
      const client = await this.pool.connect();
      try {
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const [key, column, isJson] of updates) {
          const value = fields[key];
          params.push(isJson ? JSON.stringify(value) : value);
          sets.push(`${column} = $${params.length}`);
        }
        params.push(id);
        await client.query(
          `UPDATE roosync_messages SET ${sets.join(', ')} WHERE id = $${params.length}`,
          params as never[]
        );
      } finally {
        client.release();
      }
    });
  }

  /**
   * Delete an attachment payload (#3151 Phase A.2).
   *
   * The counterpart of `insertRooSyncAttachment`, called when `destroyMessage`
   * purges the blob on GDrive. Without it the bytea copy — which is the whole
   * point of D2 — would survive its own destruction, and `destroy_after` would
   * bound nothing again, one storage layer lower.
   */
  async deleteRooSyncAttachment(uuid: string): Promise<void> {
    await this.withRetry('deleteRooSyncAttachment', async () => {
      if (!this.pool) await this.init();
      if (!this.pool) throw new Error('Pool not initialized');
      const client = await this.pool.connect();
      try {
        await client.query('DELETE FROM roosync_attachments WHERE id = $1', [uuid]);
      } finally {
        client.release();
      }
    });
  }

  async insertRooSyncAttachment(row: RooSyncAttachmentRow): Promise<void> {
    await this.withRetry('insertRooSyncAttachment', async () => {
      if (!this.pool) await this.init();
      if (!this.pool) throw new Error('Pool not initialized');
      const client = await this.pool.connect();
      try {
        const sql = `
          INSERT INTO roosync_attachments (id, filename, mime, size, sha256, payload)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (id) DO NOTHING
        `;
        await client.query(sql, [
          row.id,
          row.filename,
          row.mime,
          row.size,
          row.sha256,
          row.payload, // pg serializes Buffer to bytea
        ]);
      } finally {
        client.release();
      }
    });
  }

  // ─── Query Helpers ────────────────────────────────────────────

  private async upsertConversationRow(client: pg.PoolClient, row: ConversationRow): Promise<void> {
    const sql = `
      INSERT INTO conversations (task_id, machine_id, harness, workspace, parent_task_id, title, first_ts, last_ts, msg_count, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (task_id) DO UPDATE SET
        machine_id = EXCLUDED.machine_id,
        harness = EXCLUDED.harness,
        workspace = EXCLUDED.workspace,
        parent_task_id = EXCLUDED.parent_task_id,
        title = EXCLUDED.title,
        first_ts = COALESCE(EXCLUDED.first_ts, conversations.first_ts),
        last_ts = EXCLUDED.last_ts,
        msg_count = EXCLUDED.msg_count,
        metadata = COALESCE(EXCLUDED.metadata, conversations.metadata)
    `;
    const params = [
      row.task_id,
      row.machine_id,
      row.harness,
      row.workspace ?? null,
      row.parent_task_id ?? null,
      row.title ?? null,
      row.first_ts ?? null,
      row.last_ts ?? null,
      row.msg_count,
      row.metadata ? JSON.stringify(row.metadata) : null,
    ];
    await client.query(sql, params);
  }

  private async upsertMessagesRows(client: pg.PoolClient, rows: MessageRow[]): Promise<void> {
    // Batch insert using UNNEST for efficiency (up to 100x faster than individual INSERTs)
    const taskIds: string[] = [];
    const messageIds: (string | null)[] = [];
    const seqs: number[] = [];
    const roles: string[] = [];
    const contents: (string | null)[] = [];
    const toolCalls: (string | null)[] = [];
    const timestamps: string[] = [];

    for (const row of rows) {
      taskIds.push(row.task_id);
      messageIds.push(row.message_id ?? null);
      seqs.push(row.seq);
      roles.push(row.role);
      contents.push(row.content ?? null);
      // #2426 Phase C+: Guard jsonb[] cast — validate JSON before pushing to pg array
      // pg transforms JS string[] into Postgres array literal {val1,val2,...}
      // which breaks if strings contain commas, braces, quotes. Validate + stringify safely.
      if (row.tool_calls) {
        try {
          const json = JSON.stringify(row.tool_calls);
          // Verify round-trip to catch non-serializable values
          JSON.parse(json);
          toolCalls.push(json);
        } catch {
          // Non-serializable tool_calls — store null rather than break the entire batch
          toolCalls.push(null);
        }
      } else {
        toolCalls.push(null);
      }
      timestamps.push(row.ts);
    }

    const sql = `
      INSERT INTO messages (task_id, message_id, seq, role, content, tool_calls, ts)
      SELECT * FROM UNNEST(
        $1::text[], $2::text[], $3::integer[], $4::text[], $5::text[], $6::jsonb[], $7::timestamptz[]
      )
      ON CONFLICT (task_id, seq) DO NOTHING
    `;
    await client.query(sql, [
      taskIds,
      messageIds,
      seqs,
      roles,
      contents,
      toolCalls,
      timestamps,
    ]);
  }

  // ─── Retry + Circuit Breaker ──────────────────────────────────

  private async withRetry(label: string, fn: () => Promise<void>): Promise<void> {
    this.metrics.upsertsTotal++;

    if (!this.breaker.allow()) {
      this.metrics.upsertsFailed++;
      const state = this.breaker.getState();
      console.warn(`[PgUnifiedStoreWriter] Circuit breaker ${state}, skipping ${label}`);
      return; // best-effort: skip silently (writer failure never blocks caller)
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await fn();
        this.breaker.recordSuccess();
        this.metrics.upsertsSuccess++;
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < this.maxRetries) {
          this.metrics.upsertsRetried++;
          const delay = this.baseDelayMs * Math.pow(2, attempt);
          console.warn(
            `[PgUnifiedStoreWriter] ${label} attempt ${attempt + 1}/${this.maxRetries + 1} failed: ${lastError.message}. Retrying in ${delay}ms...`
          );
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    // All retries exhausted
    this.breaker.recordFailure();
    this.metrics.upsertsFailed++;
    this.metrics.lastError = lastError?.message;
    this.metrics.lastErrorTs = new Date().toISOString();

    if (this.breaker.getState() === 'OPEN') {
      this.metrics.breakerOpens++;
    }

    // Best-effort: log error but do NOT throw (writer failure never blocks caller)
    console.error(
      `[PgUnifiedStoreWriter] ${label} failed after ${this.maxRetries + 1} attempts: ${lastError?.message}. Circuit breaker: ${this.breaker.getState()}`
    );
  }

  // ─── Observability ────────────────────────────────────────────

  getMetrics(): Readonly<WriterMetrics> {
    return { ...this.metrics };
  }

  getBreakerState(): BreakerState {
    return this.breaker.getState();
  }
}
