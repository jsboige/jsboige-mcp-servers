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
   * RooSync channel reconcile (#3292) — ids present in the store at or after
   * `sinceId` (lexicographic; ids embed their UTC timestamp, so the caller's
   * date cutoff can be compared as a string). Indexed range scan on the PK.
   *
   * Unlike the insert methods this is a READ with reader semantics: it throws
   * on failure — the reconcile must distinguish "PG says 0" from "PG
   * unreachable", and treating the latter as the former would re-import the
   * whole lookback window blind.
   */
  listRooSyncMessageIds(sinceId: string): Promise<string[]>;
  /**
   * RooSync channel — partial update: amend, attachment-ref refresh, and the
   * read / archived / destroyed state transitions (Phase A.2).
   */
  updateRooSyncMessage(id: string, fields: RooSyncMessageUpdate): Promise<void>;
  /**
   * RooSync channel — attachment payload as bytea (+ metadata, migration 007),
   * ON CONFLICT (id) DO NOTHING. Metadata fields are optional: legacy
   * dual-write callers still ship payload-only rows.
   */
  insertRooSyncAttachment(row: RooSyncAttachmentRow): Promise<void>;
  /**
   * RooSync channel — purge an attachment payload when the message is destroyed
   * or the attachment is deleted. Returns the number of rows deleted (0 when
   * the row was already absent) — the delete path distinguishes "purged" from
   * "nothing existed anywhere" (#3151 §7.5.2).
   */
  deleteRooSyncAttachment(uuid: string): Promise<number>;
  /**
   * RooSync channel retention (#3151 Phase D) — delete archived rows older
   * than `retentionDays` together with their attachment payloads, in one
   * transaction. Returns the number of rows purged. 0 or negative → no-op.
   */
  purgeArchivedRooSyncMessages(retentionDays: number): Promise<number>;
  /**
   * RooSync dashboards (#3151 Phase C) — transactional sync of one dashboard
   * row + its active journal rows: upsert the row, upsert the message rows
   * (idempotent on (dashboard_key, message_id)).
   *
   * `archived_at` is stamped ONLY when `opts.condensed` is set: on GDrive,
   * condensation is the only operation that removes intercom messages, so a
   * plain sync or append (whose snapshot may lag concurrent appends from the
   * other machines) must never archive rows it simply hasn't seen.
   *
   * `opts.backfill` switches to the one-time-import semantics of
   * backfill-roosync-dashboards.mjs: INSERT-only everywhere (DO NOTHING),
   * no archive stamping — a file read at T0 racing a live sync at T1 must
   * never overwrite the fresher PG state or archive its messages.
   */
  syncRooSyncDashboard(
    row: RooSyncDashboardRow,
    messages: RooSyncDashboardMessageRow[],
    opts?: { backfill?: boolean; condensed?: boolean }
  ): Promise<void>;
  /**
   * RooSync dashboards — same transaction as syncRooSyncDashboard, but the
   * outcome is RETURNED instead of swallowed (rework #1134, review ask 2).
   *
   * The legacy void methods route through withRetry, which absorbs every
   * failure mode silently (breaker skip, deterministic #3342 fail-fast,
   * retry exhaustion) — correct for fire-and-forget dual-writes, but a caller
   * that is about to make an IRREVERSIBLE decision on the assumption "PG now
   * holds this" (e.g. removing the source key of a merge) must be able to
   * distinguish "written" from "silently skipped".
   */
  syncRooSyncDashboardChecked(
    row: RooSyncDashboardRow,
    messages: RooSyncDashboardMessageRow[],
    opts?: { backfill?: boolean; condensed?: boolean }
  ): Promise<UnifiedStoreWriteOutcome>;
  /**
   * RooSync dashboards — targeted archival of explicit journal rows
   * (#3151-D gate, reconcile archival pass). Unlike the condensed stamp
   * (which archives everything absent from ONE snapshot), this archives
   * exactly the ids the caller derived under per-key freshness guards.
   * Idempotent: rows already archived keep their first stamp (COALESCE)
   * and do not count. Returns the number of rows newly archived.
   */
  archiveRooSyncDashboardMessages(key: string, messageIds: string[]): Promise<number>;
  /** RooSync dashboards — drop dashboard + journal (cascade) when the GDrive file is deleted. */
  deleteRooSyncDashboard(key: string): Promise<void>;
  /** RooSync dashboards — same delete, outcome returned instead of swallowed (rework #1134). */
  deleteRooSyncDashboardChecked(key: string): Promise<UnifiedStoreWriteOutcome>;
  /**
   * #3782 — retire a source key at the journal level after a merge: a MARK in
   * `roosync_dashboard_retirements`, never a DELETE (the dashboard/journal rows
   * stay — gel des purges). Re-marking a lifted key refreshes it and lifts the
   * lift. Outcome returned (the merge gates its source disposition on it).
   */
  retireRooSyncDashboardKeyChecked(
    sourceKey: string,
    targetKey: string,
    retiredBy: string
  ): Promise<UnifiedStoreWriteOutcome>;
  /** #3782 — lift an active mark: the key becomes readable again with its original content. */
  unretireRooSyncDashboardKeyChecked(key: string): Promise<UnifiedStoreWriteOutcome>;
  /**
   * #3782 locks-off-Drive — atomically acquire the consultative lock row for
   * `lockKey`: INSERT wins, conflict + age >= ttlMs steals (single PG clock),
   * fresh conflict = 'held'. 'unavailable' = no PG half (Null) so the caller
   * falls back to its machine-local lock.
   */
  tryAcquireRooSyncDashboardLock(
    lockKey: string,
    holderJson: string,
    ttlMs: number
  ): Promise<RooSyncLockAcquireStatus>;
  /** #3782 — release the lock row, only if still owned by this exact holder. */
  releaseRooSyncDashboardLock(lockKey: string, holderJson: string): Promise<void>;
  /** Health probe (SELECT 1). */
  ping(): Promise<boolean>;
}

/**
 * Discriminated outcome of a checked write (rework #1134, review ask 2).
 *
 * - `written` — the transaction committed.
 * - `disabled` — no PG half configured on this host (Null writer): nothing was
 *   expected, nothing was lost. Callers gate destructive follow-ups on
 *   `ok || reason === 'disabled'`.
 * - `breaker-skip` — circuit breaker OPEN, the write was never attempted.
 * - `deterministic` — SQLSTATE class 22 (#3342): same payload fails forever.
 * - `exhausted` — retries spent, last error in `detail`.
 */
export type UnifiedStoreWriteOutcome =
  | { ok: true; reason: 'written' }
  | { ok: false; reason: 'disabled' }
  | { ok: false; reason: 'breaker-skip'; detail: string }
  | { ok: false; reason: 'deterministic'; detail: string }
  | { ok: false; reason: 'exhausted'; detail: string };

/**
 * #3782 locks-off-Drive — outcome of a consultative lock acquisition.
 *
 * - `acquired` — we hold the row (fresh INSERT or TTL steal).
 * - `held` — a fresh holder owns it; caller must skip/wait.
 * - `unavailable` — no PG half on this host, or the table/store is not
 *   reachable: the caller falls back to its machine-local lock layer.
 */
export type RooSyncLockAcquireStatus = 'acquired' | 'held' | 'unavailable';

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
  async listRooSyncMessageIds(_sinceId: string): Promise<string[]> { return []; }
  async updateRooSyncMessage(_id: string, _fields: RooSyncMessageUpdate): Promise<void> {}
  async insertRooSyncAttachment(_row: RooSyncAttachmentRow): Promise<void> {}
  async deleteRooSyncAttachment(_uuid: string): Promise<number> { return 0; }
  async purgeArchivedRooSyncMessages(_retentionDays: number): Promise<number> { return 0; }
  async syncRooSyncDashboard(
    _row: RooSyncDashboardRow,
    _messages: RooSyncDashboardMessageRow[],
    _opts?: { backfill?: boolean; condensed?: boolean }
  ): Promise<void> {}
  async syncRooSyncDashboardChecked(
    _row: RooSyncDashboardRow,
    _messages: RooSyncDashboardMessageRow[],
    _opts?: { backfill?: boolean; condensed?: boolean }
  ): Promise<UnifiedStoreWriteOutcome> {
    return { ok: false, reason: 'disabled' };
  }
  async archiveRooSyncDashboardMessages(_key: string, _messageIds: string[]): Promise<number> { return 0; }
  async deleteRooSyncDashboard(_key: string): Promise<void> {}
  async deleteRooSyncDashboardChecked(_key: string): Promise<UnifiedStoreWriteOutcome> {
    return { ok: false, reason: 'disabled' };
  }
  async retireRooSyncDashboardKeyChecked(
    _sourceKey: string,
    _targetKey: string,
    _retiredBy: string
  ): Promise<UnifiedStoreWriteOutcome> {
    return { ok: false, reason: 'disabled' };
  }
  async unretireRooSyncDashboardKeyChecked(_key: string): Promise<UnifiedStoreWriteOutcome> {
    return { ok: false, reason: 'disabled' };
  }

  async tryAcquireRooSyncDashboardLock(
    _lockKey: string,
    _holderJson: string,
    _ttlMs: number
  ): Promise<RooSyncLockAcquireStatus> {
    return 'unavailable';
  }

  async releaseRooSyncDashboardLock(_lockKey: string, _holderJson: string): Promise<void> {}
  async ping(): Promise<boolean> { return false; }
}
