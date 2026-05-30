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
} from './types.js';

export interface UnifiedStoreWriterConfig {
  /** PG connection string, e.g. postgres://user:pass@host:5433/db?sslmode=require */
  connectionString: string;
  /** Pool max connections. Default 5. */
  poolMax?: number;
  /** Per-query timeout in ms. Default 5000. */
  statementTimeoutMs?: number;
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
  async ping(): Promise<boolean> { return false; }
}
