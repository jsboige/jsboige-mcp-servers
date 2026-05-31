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
}
