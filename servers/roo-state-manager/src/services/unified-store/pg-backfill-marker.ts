/**
 * Backfill completeness markers (#4131 — review ms#1540 BLOCKER).
 *
 * @module services/unified-store/pg-backfill-marker
 * @issue #4131 (PostgreSQL cutover)
 *
 * WHY — the cutover gates used to be opt-in env flags (`=== '1'`), so a seat
 * with a PG URL got nothing until someone edited its gitignored `.env` by
 * hand. The fix was made the default path; the review (ms#1540) then blocked
 * it on a real hole: the DEFAULT read was gated on a HUMAN flag, while the
 * precondition of a PG read is DATA — the channel history must have been
 * imported. A seat that reads an empty PG store sees an EMPTY mailbox:
 * no error, no breaker trip, no GDrive fallback (under-show — the one
 * failure this channel cannot tolerate; the backfill script says so in its
 * own header, scripts/backfill-roosync-channel.mjs:9-10).
 *
 * THE CONTRACT — the default read resolves ON only when the backfill wrote
 * its completeness marker in PG (`roosync_store_meta`, migrations/012):
 *
 *   - marker present → the store is complete → PG is the default surface;
 *   - marker absent  → GDrive stays the surface, one log line says why;
 *   - explicit `'1'` → the operator forces PG on (backward compat: a seat
 *     that was already PG-primary keeps working without the marker);
 *   - explicit `'0'` → the emergency kill-switch, honoured at call time.
 *
 * BOUNDS — the marker is looked up at most once per TTL (default 5 min,
 * `UNIFIED_STORE_BACKFILL_MARKER_TTL_MS`), never once per call: the lookup
 * is a single indexed row read, but a per-call read on the inbox hot path
 * would be a per-call query. A refresh in flight suppresses the others
 * (one observer per condition), and a stale value is served until the
 * refresh lands — bounded staleness, never a per-call query.
 *
 * FAIL-SAFE — every failure (PG unreachable, table missing because
 * migrations/012 was never applied, marker absent) resolves to `'absent'`,
 * i.e. the GDrive path. The marker can only ever OPEN the PG surface, never
 * close it by accident.
 *
 * SCOPE — the GDrive tree is SHARED (`.shared-state/messages`; `inbox/` has
 * no recipient index, which is why the historical sweep was fleet-wide), so
 * one backfill of that tree covers the fleet: the marker is fleet-wide.
 *
 * CONNECTION — the lookup uses its OWN short-lived client (3 s connect and
 * statement timeouts), not the shared reader pool: a marker lookup must not
 * instantiate — nor hold open — the seat's PG pool, and it must not be
 * able to keep the process alive. SSL comes from the connection string
 * (`sslmode=require`), exactly like the reader and the writer.
 */

import { createLogger } from '../../utils/logger.js';

const logger = createLogger('pg-backfill-marker');

/** Which store the marker describes. */
export type BackfillScope = 'channel' | 'dashboard';

/**
 * State of the completeness marker for one scope.
 *
 * - `'unknown'` — never looked up (or the lookup is in flight): the default
 *   read stays on GDrive.
 * - `'complete'`— the marker is in PG: the store is complete.
 * - `'absent'`  — no marker (or the lookup failed): GDrive stays.
 */
export type BackfillMarkerState = 'unknown' | 'complete' | 'absent';

/** Meta key written by `scripts/backfill-roosync-channel.mjs`. */
export const CHANNEL_BACKFILL_META_KEY = 'channel_backfill_complete_at';

/** Meta key written by `scripts/backfill-roosync-dashboards.mjs`. */
export const DASHBOARD_BACKFILL_META_KEY = 'dashboard_backfill_complete_at';

/** Default TTL of the marker lookup, in ms. */
const DEFAULT_TTL_MS = 300_000;

/** Connect / statement timeout of the marker lookup, in ms. */
const LOOKUP_TIMEOUT_MS = 3_000;

const META_KEYS: Record<BackfillScope, string> = {
  channel: CHANNEL_BACKFILL_META_KEY,
  dashboard: DASHBOARD_BACKFILL_META_KEY,
};

interface CacheEntry {
  state: BackfillMarkerState;
  checkedAt: number;
}

const cache: Record<BackfillScope, CacheEntry> = {
  channel: { state: 'unknown', checkedAt: 0 },
  dashboard: { state: 'unknown', checkedAt: 0 },
};

/** In-flight refresh — one observer per condition, never a stampede. */
let inFlight: Promise<void> | null = null;

/** TTL of the marker lookup, in ms. */
export function backfillMarkerTtlMs(): number {
  const raw = Number(process.env.UNIFIED_STORE_BACKFILL_MARKER_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

/**
 * Current marker state for a scope.
 *
 * Synchronous by design — the gates that consult it are synchronous. The
 * lookup itself is asynchronous and bounded by the TTL: when the cached
 * value is stale (or absent) a refresh is started in the background and the
 * CACHED value is returned. `'unknown'` therefore means "not known yet" and
 * is treated as `'absent'` by the gates — the GDrive path.
 */
export function getBackfillMarkerState(scope: BackfillScope): BackfillMarkerState {
  const entry = cache[scope];
  if (entry.state === 'unknown') {
    void refreshBackfillMarkers();
    return 'unknown';
  }
  if (Date.now() - entry.checkedAt > backfillMarkerTtlMs()) {
    void refreshBackfillMarkers();
  }
  return entry.state;
}

/**
 * Refresh both marker states from PG.
 *
 * @param force - re-read even if a refresh is already in flight (used by the
 *   backfill scripts' own verification path and by tests).
 */
export async function refreshBackfillMarkers(force = false): Promise<void> {
  if (inFlight && !force) return inFlight;
  const run = doRefresh().finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

async function doRefresh(): Promise<void> {
  const url = process.env.UNIFIED_STORE_PG_URL;
  if (!url) {
    // No store on this host: nothing to mark, the GDrive path is the only one.
    setState('channel', 'absent');
    setState('dashboard', 'absent');
    return;
  }

  let values: Map<string, string>;
  try {
    values = await readMetaValues(url, Object.values(META_KEYS));
  } catch (error) {
    // Two causes, one safe answer: migrations/012 not applied on this store,
    // or PG unreachable. Both mean "no proof of completeness" → the GDrive
    // path. The message names the likely cause without printing anything
    // from the connection string.
    logger.warn(
      '[backfill-marker] marker lookup failed — PG reads stay on GDrive ' +
      '(migrations/012 not applied on this store, or PG unreachable)',
      { error: String(error) }
    );
    setState('channel', 'absent');
    setState('dashboard', 'absent');
    return;
  }

  for (const scope of ['channel', 'dashboard'] as BackfillScope[]) {
    const value = values.get(META_KEYS[scope]);
    setState(scope, value && value.trim().length > 0 ? 'complete' : 'absent');
  }
}

/**
 * Read the meta rows of the given keys in ONE query, on a short-lived client.
 *
 * @returns the values found (a key with no row is simply absent from the map).
 */
async function readMetaValues(url: string, keys: string[]): Promise<Map<string, string>> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: LOOKUP_TIMEOUT_MS,
    statement_timeout: LOOKUP_TIMEOUT_MS,
  });
  const values = new Map<string, string>();
  try {
    await client.connect();
    const result = await client.query(
      'SELECT key, value FROM roosync_store_meta WHERE key = ANY($1)',
      [keys]
    );
    for (const row of result.rows) {
      const value = row?.value;
      if (typeof row?.key === 'string' && value !== null && value !== undefined) {
        values.set(row.key, String(value));
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
  return values;
}

function setState(scope: BackfillScope, state: BackfillMarkerState): void {
  const previous = cache[scope].state;
  cache[scope] = { state, checkedAt: Date.now() };
  if (state === 'absent' && previous !== 'absent') {
    logger.info(
      `[backfill-marker] no '${META_KEYS[scope]}' marker in PG — the default PG read stays OFF ` +
      'and GDrive keeps serving this surface (run the backfill script to import the history)'
    );
  }
}

/**
 * Make sure the marker states are resolved (and fresh) before a caller that
 * CAN await decides.
 *
 * The synchronous gates serve the cached value; a caller that can await (the
 * MCP startup, the CLI helpers) uses this to close the 'unknown' window — an
 * unresolved marker reads as "no proof of completeness", which on a
 * PG-primary seat would be one empty inbox.
 */
export async function ensureBackfillMarkersFresh(): Promise<void> {
  const now = Date.now();
  const scopes: BackfillScope[] = ['channel', 'dashboard'];
  const fresh = scopes.every(
    (scope) =>
      cache[scope].state !== 'unknown' &&
      now - cache[scope].checkedAt <= backfillMarkerTtlMs()
  );
  if (fresh) return;
  await refreshBackfillMarkers();
}

/**
 * Force a marker state (hot-reload / test seam).
 *
 * @param scope - which marker.
 * @param state - the state to force.
 */
export function setBackfillMarkerState(scope: BackfillScope, state: BackfillMarkerState): void {
  cache[scope] = { state, checkedAt: Date.now() };
}

/** Drop the cached states (test seam / config hot-reload). */
export function resetBackfillMarkerCache(): void {
  cache.channel = { state: 'unknown', checkedAt: 0 };
  cache.dashboard = { state: 'unknown', checkedAt: 0 };
  inFlight = null;
}
