/**
 * Writer factory — instantiates the correct UnifiedStoreWriter based on env config
 *
 * @module services/unified-store/writer-factory
 * @issue #2426 Phase B (Epic #2191 unified store)
 *
 * Env-gate logic:
 *   - a PG URL is set → PgUnifiedStoreWriter (the PG cutover is the DEFAULT
 *     path, #4131 — UNIFIED_STORE_DUAL_WRITE only remains as a kill-switch:
 *     '0'/'false' restores the Null writer)
 *   - Otherwise → NullUnifiedStoreWriter (no-op, zero overhead)
 *
 * The factory is idempotent: repeated calls return the same instance
 * (singleton pattern matching SkeletonCacheService's approach).
 */

import type { IUnifiedStoreWriter } from './UnifiedStoreWriter.js';
import { NullUnifiedStoreWriter } from './UnifiedStoreWriter.js';
import { PgUnifiedStoreWriter } from './PgUnifiedStoreWriter.js';
import { isPgFlagOn } from './pg-flags.js';

let instance: IUnifiedStoreWriter | null = null;

/**
 * Create or return the singleton writer instance.
 *
 * Called from SkeletonCacheService (or startup) when the dual-write
 * env-gate needs to be evaluated. Once created, the instance is reused
 * for the lifetime of the MCP process.
 */
export function getUnifiedStoreWriter(): IUnifiedStoreWriter {
  if (instance) return instance;

  const pgUrl = process.env.UNIFIED_STORE_PG_URL;

  if (pgUrl && isPgFlagOn('UNIFIED_STORE_DUAL_WRITE')) {
    console.error(
      `[UnifiedStore] Dual-write ENABLED — connecting to ${maskConnectionString(pgUrl)}`
    );
    instance = new PgUnifiedStoreWriter({
      connectionString: pgUrl,
      poolMax: parseInt(process.env.UNIFIED_STORE_POOL_MAX ?? '5', 10),
      // #4131 B15 — default 15 s (was 5 s: statement timeouts fired under
      // mailbox load); env overrides still win.
      statementTimeoutMs: parseInt(process.env.UNIFIED_STORE_TIMEOUT_MS ?? '15000', 10),
      connectionTimeoutMillis: parseInt(process.env.UNIFIED_STORE_CONNECT_TIMEOUT_MS ?? '15000', 10),
    });
  } else {
    console.error('[UnifiedStore] Dual-write DISABLED — using NullUnifiedStoreWriter');
    instance = new NullUnifiedStoreWriter();
  }

  return instance;
}

/**
 * Reset the singleton (for testing or config hot-reload).
 * Does NOT close the previous instance — caller must handle lifecycle.
 */
export function resetWriterInstance(): void {
  instance = null;
}

/**
 * Mask credentials in connection string for logging.
 * postgres://user:secret@host/db → postgres://user:***@host/db
 */
function maskConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return '<invalid-url>';
  }
}
