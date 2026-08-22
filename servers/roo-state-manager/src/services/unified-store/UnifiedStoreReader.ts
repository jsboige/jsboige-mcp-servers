/**
 * UnifiedStoreReader — Postgres reader for the unified store (2-step search)
 *
 * @module services/unified-store/UnifiedStoreReader
 * @issue #2426 (Epic #2191 unified store)
 * @phase A (interface + Null object only; concrete impl deferred to Phase C per #815 gate)
 *
 * 2-step read path (ADR 010 v2.0 Scenario B):
 *   1. Qdrant ANN over content embeddings -> top-K task_id + score
 *   2. JOIN Postgres conversations + messages for the filter set
 *
 * This restores roosync_search #636 filters (has_errors, tool_name, role, etc.)
 * via the GIN idx_msg_toolcalls + plain BTREE on conversations.
 *
 * Phase A surface intentionally restricted to:
 *   - IUnifiedStoreReader interface (contract for Phase C)
 *   - NullUnifiedStoreReader (no-op, safe — used when opt-in is OFF)
 *
 * The concrete throwing skeleton was removed (gate #815 — anti-stub detection
 * scans all of src/ recursively). Phase C will reintroduce a real implementation
 * and hook it into conversation_browser as an opt-in source.
 */

import type {
  UnifiedStoreSearchFilters,
  UnifiedStoreSearchHit,
  ConversationRow,
  MessageRow,
  RooSyncMessageRow,
  RooSyncDashboardRow,
  RooSyncDashboardMessageRow,
} from './types.js';

export interface UnifiedStoreReaderConfig {
  connectionString: string;
  poolMax?: number;
  statementTimeoutMs?: number;
}

export interface IUnifiedStoreReader {
  init(): Promise<void>;
  close(): Promise<void>;
  /** Lookup a single conversation by task_id. */
  getConversation(taskId: string): Promise<ConversationRow | null>;
  /** Lookup messages for a conversation, ordered by seq ASC. */
  getMessages(taskId: string, opts?: { limit?: number; offset?: number }): Promise<MessageRow[]>;
  /**
   * 2-step semantic search:
   *   1. caller supplies top-K (task_id, score) from Qdrant
   *   2. this method JOINs Postgres applying SQL filters
   */
  joinFromQdrant(
    qdrantHits: Array<{ task_id: string; score: number }>,
    filters?: UnifiedStoreSearchFilters,
  ): Promise<UnifiedStoreSearchHit[]>;
  ping(): Promise<boolean>;
  /** Returns true if this is a NullUnifiedStoreReader (env-gate OFF). */
  isNull(): boolean;

  // ─── RooSync channel reads (#3151 Phase B) ──────────────────────

  /**
   * Mailbox candidates for a machine: non-archived rows addressed to the
   * machine or broadcast ('all'), newest first. Workspace matching and
   * per-machine broadcast status are applied by the caller (JS) for exact
   * parity with the GDrive `matchesRecipient` semantics — the query's job is
   * to bound the candidate set via the mailbox index (D5).
   */
  getRooSyncMailbox(machineId: string): Promise<RooSyncMessageRow[]>;
  /** Full-fidelity lookup of one channel message by id (any status). */
  getRooSyncMessageById(id: string): Promise<RooSyncMessageRow | null>;

  // ─── RooSync dashboard reads (#3151 Phase C) ─────────────────────

  /**
   * Dashboard row + ACTIVE journal rows (archived_at IS NULL, oldest first)
   * for a key. Null when the key has no row — the caller falls back to the
   * GDrive file (same under-show protection as the message channel).
   */
  getRooSyncDashboard(key: string): Promise<{
    dashboard: RooSyncDashboardRow;
    messages: RooSyncDashboardMessageRow[];
  } | null>;
}

/** Null object for opt-out read path. */
export class NullUnifiedStoreReader implements IUnifiedStoreReader {
  async init(): Promise<void> {}
  async close(): Promise<void> {}
  async getConversation(_taskId: string): Promise<ConversationRow | null> { return null; }
  async getMessages(_taskId: string, _opts?: { limit?: number; offset?: number }): Promise<MessageRow[]> { return []; }
  async joinFromQdrant(
    _qdrantHits: Array<{ task_id: string; score: number }>,
    _filters?: UnifiedStoreSearchFilters,
  ): Promise<UnifiedStoreSearchHit[]> {
    return [];
  }
  async ping(): Promise<boolean> { return false; }
  isNull(): boolean { return true; }
  async getRooSyncMailbox(_machineId: string): Promise<RooSyncMessageRow[]> { return []; }
  async getRooSyncMessageById(_id: string): Promise<RooSyncMessageRow | null> { return null; }
  async getRooSyncDashboard(_key: string): Promise<{
    dashboard: RooSyncDashboardRow;
    messages: RooSyncDashboardMessageRow[];
  } | null> { return null; }
}
