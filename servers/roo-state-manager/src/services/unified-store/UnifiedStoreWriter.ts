/**
 * UnifiedStoreWriter — Postgres writer for the unified store
 *
 * @module services/unified-store/UnifiedStoreWriter
 * @issue #2426 (Epic #2191 unified store)
 * @phase A (scaffold — interface + no-op stubs; Phase B implements upsert)
 *
 * Contract for Phase B/C:
 *   - upsertConversation: idempotent, ON CONFLICT DO UPDATE on (task_id)
 *   - upsertMessages: batched, ON CONFLICT DO NOTHING on (task_id, seq)
 *   - Called from SkeletonCacheService.addOrUpdate() in best-effort try/catch
 *     (Phase B activates the hook behind env var UNIFIED_STORE_DUAL_WRITE)
 *   - Failure NEVER blocks skeleton cache — writer must absorb its own errors
 *     and log + emit metric
 *
 * Phase A: interface is sealed, implementation throws to make accidental wiring
 * fail loudly. Phase B replaces the body with a real pg.Pool + parameterized
 * queries + retry + circuit-breaker.
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
 * Phase A skeleton. Methods throw "not implemented" so any accidental hook
 * lights up immediately rather than silently no-op.
 *
 * Phase B will:
 *   - import { Pool } from 'pg'
 *   - parameterize INSERT ... ON CONFLICT
 *   - wrap each call in a small retry (3x exponential) + circuit-breaker
 *   - emit metric unified_store.write.{ok,fail,latency}
 */
export class UnifiedStoreWriter implements IUnifiedStoreWriter {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _config: UnifiedStoreWriterConfig) {}

  async init(): Promise<void> {
    throw new Error('UnifiedStoreWriter.init: not implemented (Phase A scaffold, #2426)');
  }

  async close(): Promise<void> {
    throw new Error('UnifiedStoreWriter.close: not implemented (Phase A scaffold, #2426)');
  }

  async upsertConversation(_bundle: ConversationBundle): Promise<void> {
    throw new Error('UnifiedStoreWriter.upsertConversation: not implemented (Phase A scaffold, #2426)');
  }

  async upsertConversationOnly(_row: ConversationRow): Promise<void> {
    throw new Error('UnifiedStoreWriter.upsertConversationOnly: not implemented (Phase A scaffold, #2426)');
  }

  async upsertMessages(_rows: MessageRow[]): Promise<void> {
    throw new Error('UnifiedStoreWriter.upsertMessages: not implemented (Phase A scaffold, #2426)');
  }

  async ping(): Promise<boolean> {
    throw new Error('UnifiedStoreWriter.ping: not implemented (Phase A scaffold, #2426)');
  }
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
