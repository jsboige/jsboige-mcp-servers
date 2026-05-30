/**
 * UnifiedStore — Postgres row types matching migrations/001_init_unified_store.sql
 *
 * @module services/unified-store/types
 * @issue #2426 (Epic #2191 unified store)
 * @phase A (scaffold — no runtime usage yet)
 *
 * These types model the SQL rows verbatim. They are intentionally separate from
 * UnifiedTask (#1391 in src/types/unified-task.ts) which is an in-memory view
 * with derived fields (status/outcome/storageTier). The writer maps in-memory
 * -> rows; the reader maps rows -> in-memory.
 */

/** Origin harness for a conversation. */
export type Harness = 'roo' | 'zoo' | 'claude';

/** A row of the `conversations` table. */
export interface ConversationRow {
  task_id: string;
  machine_id: string;
  harness: Harness;
  workspace: string | null;
  parent_task_id: string | null;
  title: string | null;
  /** ISO 8601 from internal payload (NOT mtime). */
  first_ts: string | null;
  /** ISO 8601 from internal payload (NOT mtime). */
  last_ts: string | null;
  msg_count: number;
  metadata: Record<string, unknown> | null;
  /** Set by Postgres DEFAULT NOW() on insert. */
  ingested_at?: string;
}

/** A row of the `messages` table. */
export interface MessageRow {
  /** BIGSERIAL — set by Postgres on insert, present on read. */
  id?: number;
  task_id: string;
  /** Nullable per Q5 (progressive adoption). */
  message_id: string | null;
  seq: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** Q6 duplicated Postgres + Qdrant. */
  content: string | null;
  tool_calls: unknown[] | null;
  /** ISO 8601 from internal payload (NOT mtime). */
  ts: string;
}

/** Bundle for atomic upsert of one conversation + its messages. */
export interface ConversationBundle {
  conversation: ConversationRow;
  messages: MessageRow[];
}

/** Search filters for the reader (Phase C). */
export interface UnifiedStoreSearchFilters {
  workspace?: string;
  machine_id?: string;
  harness?: Harness;
  /** ISO 8601 lower bound on last_ts. */
  since?: string;
  /** ISO 8601 upper bound on last_ts. */
  until?: string;
  /** Match on tool_calls JSONB (uses idx_msg_toolcalls GIN). */
  tool_name?: string;
}

/** Result row from a 2-step search (Qdrant ANN -> Postgres JOIN). */
export interface UnifiedStoreSearchHit {
  task_id: string;
  /** From Qdrant ANN, lower = closer. */
  score: number;
  conversation: ConversationRow;
  /** Optional: matched messages if the filter targets messages. */
  matched_messages?: MessageRow[];
}
