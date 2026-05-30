/**
 * UnifiedStoreReader — Postgres reader for the unified store (2-step search)
 *
 * @module services/unified-store/UnifiedStoreReader
 * @issue #2426 (Epic #2191 unified store)
 * @phase A (scaffold — interface + no-op stubs; Phase C implements)
 *
 * 2-step read path (ADR 010 v2.0 Scenario B):
 *   1. Qdrant ANN over content embeddings -> top-K task_id + score
 *   2. JOIN Postgres conversations + messages for the filter set
 *
 * This restores roosync_search #636 filters (has_errors, tool_name, role, etc.)
 * via the GIN idx_msg_toolcalls + plain BTREE on conversations.
 *
 * Phase A: interface sealed, throws to flag accidental wiring.
 * Phase C will hook into conversation_browser as an opt-in source.
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
}

export class UnifiedStoreReader implements IUnifiedStoreReader {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _config: UnifiedStoreReaderConfig) {}

  async init(): Promise<void> {
    throw new Error('UnifiedStoreReader.init: not implemented (Phase A scaffold, #2426)');
  }

  async close(): Promise<void> {
    throw new Error('UnifiedStoreReader.close: not implemented (Phase A scaffold, #2426)');
  }

  async getConversation(_taskId: string): Promise<ConversationRow | null> {
    throw new Error('UnifiedStoreReader.getConversation: not implemented (Phase A scaffold, #2426)');
  }

  async getMessages(_taskId: string, _opts?: { limit?: number; offset?: number }): Promise<MessageRow[]> {
    throw new Error('UnifiedStoreReader.getMessages: not implemented (Phase A scaffold, #2426)');
  }

  async joinFromQdrant(
    _qdrantHits: Array<{ task_id: string; score: number }>,
    _filters?: UnifiedStoreSearchFilters,
  ): Promise<UnifiedStoreSearchHit[]> {
    throw new Error('UnifiedStoreReader.joinFromQdrant: not implemented (Phase A scaffold, #2426)');
  }

  async ping(): Promise<boolean> {
    throw new Error('UnifiedStoreReader.ping: not implemented (Phase A scaffold, #2426)');
  }
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
}
