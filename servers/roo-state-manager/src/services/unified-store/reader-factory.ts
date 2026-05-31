/**
 * Reader factory — instantiates the correct UnifiedStoreReader based on env config
 *
 * @module services/unified-store/reader-factory
 * @issue #2426 Phase C (Epic #2191 unified store)
 *
 * Env-gate logic:
 *   - UNIFIED_STORE_DUAL_WRITE=1 + UNIFIED_STORE_PG_URL set → PgUnifiedStoreReader
 *   - Otherwise → NullUnifiedStoreReader (no-op, zero overhead)
 *
 * Reuses the same env vars as the writer (UNIFIED_STORE_DUAL_WRITE + UNIFIED_STORE_PG_URL).
 * The reader is only needed when the unified store is active.
 */

import type { IUnifiedStoreReader } from './UnifiedStoreReader.js';
import { NullUnifiedStoreReader } from './UnifiedStoreReader.js';
import { PgUnifiedStoreReader } from './PgUnifiedStoreReader.js';

let instance: IUnifiedStoreReader | null = null;

/**
 * Create or return the singleton reader instance.
 */
export function getUnifiedStoreReader(): IUnifiedStoreReader {
  if (instance) return instance;

  const dualWrite = process.env.UNIFIED_STORE_DUAL_WRITE;
  const pgUrl = process.env.UNIFIED_STORE_PG_URL;

  if (dualWrite === '1' && pgUrl) {
    console.info('[UnifiedStore] Reader ENABLED — connecting to Postgres');
    instance = new PgUnifiedStoreReader({
      connectionString: pgUrl,
      poolMax: parseInt(process.env.UNIFIED_STORE_POOL_MAX ?? '5', 10),
      statementTimeoutMs: parseInt(process.env.UNIFIED_STORE_TIMEOUT_MS ?? '5000', 10),
    });
  } else {
    instance = new NullUnifiedStoreReader();
  }

  return instance;
}

/**
 * Reset the singleton (for testing or config hot-reload).
 */
export function resetReaderInstance(): void {
  instance = null;
}
