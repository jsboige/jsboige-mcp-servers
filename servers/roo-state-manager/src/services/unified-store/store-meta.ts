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

/** The store URL, or null when this host has no PG store configured. */
export function storeMetaUrl(): string | null {
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
    throw new Error('store-meta: UNIFIED_STORE_PG_URL absent — no PG store to write to');
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
