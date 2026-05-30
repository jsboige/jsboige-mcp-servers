/**
 * UnifiedStore — Postgres-backed unified storage for roo/zoo/claude conversations
 *
 * @module services/unified-store
 * @issue #2426 (Epic #2191)
 *
 * See migrations/001_init_unified_store.sql for the schema.
 * See docker-compose.postgres.yml for DEV Postgres bootstrap.
 *
 * Phase roadmap:
 *   A (done) — scaffold: types, interfaces, Null objects, SQL, docker
 *   B (done) — UnifiedStoreWriter concrete impl + dual-write hook (env-gated)
 *   C (now)  — UnifiedStoreReader concrete impl + 2-step search (Qdrant ANN → Postgres JOIN)
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

export { PgUnifiedStoreWriter } from './PgUnifiedStoreWriter.js';

export { getUnifiedStoreWriter, resetWriterInstance } from './writer-factory.js';

export { NullUnifiedStoreReader } from './UnifiedStoreReader.js';
export type { IUnifiedStoreReader, UnifiedStoreReaderConfig } from './UnifiedStoreReader.js';

export { PgUnifiedStoreReader } from './PgUnifiedStoreReader.js';

export { getUnifiedStoreReader, resetReaderInstance } from './reader-factory.js';
