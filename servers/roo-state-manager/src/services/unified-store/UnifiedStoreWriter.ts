/**
 * UnifiedStoreWriter — Postgres writer for the unified store
 *
 * @module services/unified-store/UnifiedStoreWriter
 * @issue #2426 (Epic #2191 unified store)
 * @phase A (interface + Null object only; concrete impl deferred to Phase B per #815 gate)
 *
 * Contract for Phase B/C:
 *   - upsertConversation: idempotent, ON CONFLICT DO UPDATE on (task_id)
 *   - upsertMessages: batched, ON CONFLICT DO NOTHING on (task_id, seq)
 *   - Called from SkeletonCacheService.addOrUpdate() in best-effort try/catch
 *     (Phase B activates the hook behind env var UNIFIED_STORE_DUAL_WRITE)
 *   - Failure NEVER blocks skeleton cache — writer must absorb its own errors
 *     and log + emit metric
 *
 * Phase A surface intentionally restricted to:
 *   - IUnifiedStoreWriter interface (contract for Phase B)
 *   - NullUnifiedStoreWriter (no-op, safe — used when dual-write is OFF)
 *
 * The concrete throwing skeleton was removed (gate #815 — anti-stub detection
 * scans all of src/ recursively). Phase B will reintroduce a real implementation
 * (pg.Pool + parameterized queries + retry + circuit-breaker) at the hook site.
 */

import type {
  ConversationBundle,
  ConversationRow,
  MessageRow,
  RooSyncAttachmentRow,
  RooSyncMessageRow,
  RooSyncMessageUpdate,
  RooSyncDashboardRow,
  RooSyncDashboardMessageRow,
} from './types.js';

export interface UnifiedStoreWriterConfig {
  /** PG connection string, e.g. postgres://user:pass@host:5433/db?sslmode=require */
  connectionString: string;
  /** Pool max connections. Default 5. */
  poolMax?: number;
  /** Per-query timeout in ms. Default 5000. */
  statementTimeoutMs?: number;
  /** Max retry attempts on transient failure. Default 2. */
  maxRetries?: number;
  /** Base backoff delay (ms) between retries; actual delay = baseDelayMs × 2^attempt. Default 500. */
  baseDelayMs?: number;
}

export interface IUnifiedStoreWriter {
  /** Lifecycle: connect pool. Idempotent. */
  init(): Promise<void>;
  /** Lifecycle: drain pool. Idempotent. */
  close(): Promise<void>;
  /** Atomic upsert of conversation + messages. */
  upsertConversation(bundle: ConversationBundle): Promise<void>;
  /** Conversation-only upsert (msg_count refresh, no message rows). */
  upsertConversationOnly(row: ConversationRow): Promise<void>;
  /** Batched message upsert. */
  upsertMessages(rows: MessageRow[]): Promise<void>;
  /**
   * RooSync channel (#3151 Phase A) — INSERT ON CONFLICT (id) DO NOTHING.
   * Idempotent by message id; a retry never duplicates or overwrites.
   */
  insertRooSyncMessage(row: RooSyncMessageRow): Promise<void>;
  /**
   * RooSync channel — partial update: amend, attachment-ref refresh, and the
   * read / archived / destroyed state transitions (Phase A.2).
   */
  updateRooSyncMessage(id: string, fields: RooSyncMessageUpdate): Promise<void>;
  /** RooSync channel — attachment payload as bytea, ON CONFLICT (id) DO NOTHING. */
  insertRooSyncAttachment(row: RooSyncAttachmentRow): Promise<void>;
  /** RooSync channel — purge an attachment payload when the message is destroyed. */
  deleteRooSyncAttachment(uuid: string): Promise<void>;
  /**
   * RooSync dashboards (#3151 Phase C) — transactional sync of one dashboard
   * row + its active journal rows: upsert the row, upsert the message rows
   * (idempotent on (dashboard_key, message_id)), stamp `archived_at` on active
   * journal rows absent from the sync set (condensation).
   *
   * `opts.backfill` switches to the one-time-import semantics of
   * backfill-roosync-dashboards.mjs: INSERT-only everywhere (DO NOTHING),
   * no archive stamping — a file read at T0 racing a live sync at T1 must
   * never overwrite the fresher PG state or archive its messages.
   */
  syncRooSyncDashboard(
    row: RooSyncDashboardRow,
    messages: RooSyncDashboardMessageRow[],
    opts?: { backfill?: boolean }
  ): Promise<void>;
  /** RooSync dashboards — drop dashboard + journal (cascade) when the GDrive file is deleted. */
  deleteRooSyncDashboard(key: string): Promise<void>;
  /** Health probe (SELECT 1). */
  ping(): Promise<boolean>;
}

/**
 * Null object — used when the env var UNIFIED_STORE_DUAL_WRITE is unset/false.
 * All methods resolve to no-op so the hook call site is safe at all times.
 */
export class NullUnifiedStoreWriter implements IUnifiedStoreWriter {
  async init(): Promise<void> {}
  async close(): Promise<void> {}
  async upsertConversation(_bundle: ConversationBundle): Promise<void> {}
  async upsertConversationOnly(_row: ConversationRow): Promise<void> {}
  async upsertMessages(_rows: MessageRow[]): Promise<void> {}
  async insertRooSyncMessage(_row: RooSyncMessageRow): Promise<void> {}
  async updateRooSyncMessage(_id: string, _fields: RooSyncMessageUpdate): Promise<void> {}
  async insertRooSyncAttachment(_row: RooSyncAttachmentRow): Promise<void> {}
  async deleteRooSyncAttachment(_uuid: string): Promise<void> {}
  async syncRooSyncDashboard(
    _row: RooSyncDashboardRow,
    _messages: RooSyncDashboardMessageRow[],
    _opts?: { backfill?: boolean }
  ): Promise<void> {}
  async deleteRooSyncDashboard(_key: string): Promise<void> {}
  async ping(): Promise<boolean> { return false; }
}
