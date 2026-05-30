/**
 * UnifiedStore — Postgres-backed unified storage for roo/zoo/claude conversations
 *
 * @module services/unified-store
 * @issue #2426 (Epic #2191)
 * @phase A scaffold (interfaces + null objects; no runtime usage)
 *
 * See migrations/001_init_unified_store.sql for the schema.
 * See docker-compose.postgres.yml for DEV Postgres bootstrap.
 *
 * Phase roadmap:
 *   A (now)    — scaffold: types, interfaces, Null objects, SQL, docker (THIS PR)
 *   B (cycle+) — UnifiedStoreWriter concrete impl + dual-write hook (env-gated)
 *   C (cycle+) — UnifiedStoreReader concrete impl + conversation_browser hook (opt-in)
 *
 * Phase A intentionally exports only interfaces and Null objects — the concrete
 * throwing skeletons were removed to satisfy the #815 anti-stub detection gate.
 * Phase B/C will reintroduce the real implementations at the hook sites.
 */

export type {
  Harness,
  ConversationRow,
  MessageRow,
  ConversationBundle,
  UnifiedStoreSearchFilters,
  UnifiedStoreSearchHit,
} from './types.js';

export { NullUnifiedStoreWriter } from './UnifiedStoreWriter.js';
export type { IUnifiedStoreWriter, UnifiedStoreWriterConfig } from './UnifiedStoreWriter.js';

export { NullUnifiedStoreReader } from './UnifiedStoreReader.js';
export type { IUnifiedStoreReader, UnifiedStoreReaderConfig } from './UnifiedStoreReader.js';
