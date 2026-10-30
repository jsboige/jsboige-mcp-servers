/**
 * Generic key/value access to `roosync_store_meta` (migrations/012).
 *
 * @module services/unified-store/store-meta
 * @issue #4131 (PostgreSQL cutover) — Phase D blocker
 *
 * WHY — the machine registry (`.machine-registry.json`) and the per-machine
 * inventories (`inventories/{machineId}.json`) are the last objects on GDrive
 * that carry truth data: with the mount absent, `loadRooSyncConfig` threw and
 * the registry silently degraded to an empty Map (measured 28/10, #4131
 * Phase D table row 10 — 87/87 startups read the G: file). Moving them into
 * the existing generic KV side table needs NO new migration and follows the
 * migration-012 contract: the presence of the ROW is the data gate, not a
 * human flag — absent row → the GDrive file stays in charge, exactly like
 * the backfill markers.
 *
 * CONNECTION — same discipline as pg-backfill-marker.ts: a short-lived client
 * (3 s connect and statement timeouts), never the shared reader pool. These
 * calls run at service startup and per inventory publish; they must not
 * instantiate — nor hold open — the seat's PG pool, and must not be able to
 * keep the process alive. SSL comes from the connection string, like every
 * other PG consumer here.
 *
 * MEASURABILITY — the registry/inventory callers log their source ('loaded
 * from PG' / 'seeded PG from the GDrive file' / 'EMPTY — no source') through
 * the RSM logger, so the #4131 Phase D journal counts can tell the surfaces
 * apart by grepping one line each.
 */

import { createLogger } from '../../utils/logger.js';
import { isPgFlagOn } from './pg-flags.js';

/**
 * Lazy logger — same reason as conversation-list-store.ts: this module is
 * imported transitively by unit tests that mock `fs` with a partial double,
 * and `createLogger` touches the filesystem in its constructor.
 */
let cachedLogger: ReturnType<typeof createLogger> | null = null;
function getLogger(): ReturnType<typeof createLogger> {
  if (!cachedLogger) cachedLogger = createLogger('store-meta');
  return cachedLogger;
}

/** Meta key holding the machine registry (seeded from `.machine-registry.json`). */
export const MACHINE_REGISTRY_META_KEY = 'machine_registry';

/** Meta key holding one machine's published inventory. */
export function inventoryMetaKey(machineId: string): string {
  return `inventory:${machineId.toLowerCase()}`;
}

/** Connect / statement timeout of the meta access, in ms (mirrors the marker). */
const META_TIMEOUT_MS = 3_000;

/**
 * The store URL, or null when this host has no usable PG store — no URL, a
 * placeholder URL, or the emergency kill-switch `UNIFIED_STORE_DUAL_WRITE=0`.
 * Same gate as every other PG surface: with the URL as the only test, a seat
 * flipped back to GDrive-only still read and wrote its registry/inventory rows
 * in PG (review ms#1563).
 */
export function storeMetaUrl(): string | null {
  if (!isPgFlagOn('UNIFIED_STORE_DUAL_WRITE')) return null;
  const url = process.env.UNIFIED_STORE_PG_URL;
  return url && url.trim().length > 0 ? url : null;
}

/**
 * Read one meta value. Resolves null when the row is absent — absence is a
 * legitimate state ("the GDrive file stays in charge"), not an error.
 * Rejects on connection/statement failure (caller decides the fallback).
 */
export async function readStoreMetaValue(key: string): Promise<string | null> {
  const url = storeMetaUrl();
  if (!url) return null;
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: META_TIMEOUT_MS,
    statement_timeout: META_TIMEOUT_MS,
  });
  try {
    await client.connect();
    const result = await client.query(
      'SELECT value FROM roosync_store_meta WHERE key = $1',
      [key]
    );
    const value = result.rows[0]?.value;
    return value === null || value === undefined ? null : String(value);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Upsert one meta value (idempotent, same style as the backfill markers).
 * Rejects on connection/statement failure — the caller owns the fallback.
 */
export async function upsertStoreMetaValue(key: string, value: string): Promise<void> {
  const url = storeMetaUrl();
  if (!url) {
    throw new Error('store-meta: no PG store to write to (UNIFIED_STORE_PG_URL absent, or kill-switch UNIFIED_STORE_DUAL_WRITE off)');
  }
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: META_TIMEOUT_MS,
    statement_timeout: META_TIMEOUT_MS,
  });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO roosync_store_meta (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value]
    );
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Atomically union ONE map field of a JSON document with `patch`, server-side.
 *
 * Review ms#1576 (ai-01, blocking #2, then its own correction c.6495611063):
 * the plain upsert replaces the whole `value`, so two seats booting together
 * both read the pre-state, both write, and the first one's entry is gone —
 * its own verification can have already returned `true`. A read-merge-write
 * can never close that window, and ai-01 explicitly withdrew the "random
 * delay + superset check" remedy as unproven. The union therefore happens
 * inside the statement: `INSERT … ON CONFLICT DO UPDATE` takes a row lock,
 * and on READ COMMITTED the DO UPDATE branch re-reads the version the
 * concurrent writer just committed, so the merge applies ON TOP of it
 * instead of over it.
 *
 *   R = jsonb_set(E || I, ARRAY[field], (E#>ARRAY[field]) || (I#>ARRAY[field]))
 *
 * `E` = existing value, `I` = incoming document (EXCLUDED). Scalar top-level
 * keys take the incoming value (`E || I`), exactly like the plain upsert; only
 * the map field is unioned, incoming winning on a key it carries (a seat
 * refreshes its OWN entry and cannot touch anyone else's).
 *
 * @returns the post-state document, as the caller's proof of what landed.
 *          A row that is not valid JSON makes the cast throw — the caller
 *          then treats the write as failed rather than overwrite blind
 *          (same family as the `refused-blind` guard).
 */
export async function mergeStoreMetaJsonMap(
  key: string,
  field: string,
  incomingDocument: string
): Promise<string> {
  const url = storeMetaUrl();
  if (!url) {
    throw new Error('store-meta: no PG store to merge into (UNIFIED_STORE_PG_URL absent, or kill-switch UNIFIED_STORE_DUAL_WRITE off)');
  }
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: META_TIMEOUT_MS,
    statement_timeout: META_TIMEOUT_MS,
  });
  try {
    await client.connect();
    const result = await client.query(
      `INSERT INTO roosync_store_meta (key, value, updated_at)
       VALUES ($1, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = jsonb_set(
         roosync_store_meta.value::jsonb || EXCLUDED.value::jsonb,
         ARRAY[$2::text],
         COALESCE(roosync_store_meta.value::jsonb #> ARRAY[$2::text], '{}'::jsonb)
           || COALESCE(EXCLUDED.value::jsonb #> ARRAY[$2::text], '{}'::jsonb),
         true
       )::text,
       updated_at = now()
       RETURNING value`,
      [key, field, incomingDocument]
    );
    return String(result.rows[0].value);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Delete one meta value. Test/probe hygiene only — production writers never
 * delete (the registry and inventories are upserted). Resolves false when the
 * row was already absent.
 */
export async function deleteStoreMetaValue(key: string): Promise<boolean> {
  const url = storeMetaUrl();
  if (!url) return false;
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: META_TIMEOUT_MS,
    statement_timeout: META_TIMEOUT_MS,
  });
  try {
    await client.connect();
    const result = await client.query(
      'DELETE FROM roosync_store_meta WHERE key = $1',
      [key]
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    await client.end().catch(() => {
      getLogger().warn('[store-meta] client.end() failed during delete (ignored)');
    });
  }
}
