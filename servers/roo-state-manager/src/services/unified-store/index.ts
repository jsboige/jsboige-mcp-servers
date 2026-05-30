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
 *   A (now)    — scaffold: types, interfaces, null objects, SQL, docker (THIS PR)
 *   B (cycle+) — UnifiedStoreWriter impl + dual-write hook (env-gated)
 *   C (cycle+) — UnifiedStoreReader impl + conversation_browser hook (opt-in)
 */

export type {
  Harness,
  ConversationRow,
  MessageRow,
  ConversationBundle,
  UnifiedStoreSearchFilters,
  UnifiedStoreSearchHit,
} from './types.js';

export {
  UnifiedStoreWriter,
  NullUnifiedStoreWriter,
} from './UnifiedStoreWriter.js';
export type { IUnifiedStoreWriter, UnifiedStoreWriterConfig } from './UnifiedStoreWriter.js';

export {
  UnifiedStoreReader,
  NullUnifiedStoreReader,
} from './UnifiedStoreReader.js';
export type { IUnifiedStoreReader, UnifiedStoreReaderConfig } from './UnifiedStoreReader.js';
