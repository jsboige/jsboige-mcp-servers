/**
 * Reader factory — instantiates the correct UnifiedStoreReader based on env config
 *
 * @module services/unified-store/reader-factory
 * @issue #2426 Phase C (Epic #2191 unified store)
 *
 * Env-gate logic:
 *   - a PG URL is set → PgUnifiedStoreReader (the PG cutover is the DEFAULT
 *     path, #4131 — UNIFIED_STORE_DUAL_WRITE only remains as a kill-switch:
 *     '0'/'false' restores the Null reader)
 *   - Otherwise → NullUnifiedStoreReader (no-op, zero overhead)
 *
 * Reuses the same env vars as the writer (UNIFIED_STORE_DUAL_WRITE + UNIFIED_STORE_PG_URL).
 * The reader is only needed when the unified store is active.
 */

import type { IUnifiedStoreReader } from './UnifiedStoreReader.js';
import { NullUnifiedStoreReader } from './UnifiedStoreReader.js';
import { PgUnifiedStoreReader } from './PgUnifiedStoreReader.js';
import { isPgFlagOn } from './pg-flags.js';

let instance: IUnifiedStoreReader | null = null;

/**
 * Create or return the singleton reader instance.
 */
export function getUnifiedStoreReader(): IUnifiedStoreReader {
  if (instance) return instance;

  const pgUrl = process.env.UNIFIED_STORE_PG_URL;

  if (pgUrl && isPgFlagOn('UNIFIED_STORE_DUAL_WRITE')) {
    console.error('[UnifiedStore] Reader ENABLED — connecting to Postgres');
    instance = new PgUnifiedStoreReader({
      connectionString: pgUrl,
      poolMax: parseInt(process.env.UNIFIED_STORE_POOL_MAX ?? '5', 10),
      // #4131 B15 — default 15 s (was 5 s: statement timeouts fired under
      // mailbox load); env overrides still win.
      statementTimeoutMs: parseInt(process.env.UNIFIED_STORE_TIMEOUT_MS ?? '15000', 10),
      connectionTimeoutMillis: parseInt(process.env.UNIFIED_STORE_CONNECT_TIMEOUT_MS ?? '15000', 10),
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
