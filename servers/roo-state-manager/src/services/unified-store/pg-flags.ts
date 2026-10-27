/**
 * PG cutover flags — the default path, not an opt-in.
 *
 * @module services/unified-store/pg-flags
 * @issue #4131 (PostgreSQL cutover — GDrive is the measured SPOF)
 *
 * WHY — the cutover was gated behind `=== '1'` env flags. A seat that has a
 * PG URL therefore got NOTHING unless someone edited its gitignored `.env` by
 * hand: the fix existed, but it was not deployed. User directive (27/10):
 * « Je n'ai pas besoin "d'options" pour les corrections. ON corrige, on
 * déploie, basta » — the fix MUST be the default code path.
 *
 * THE CONTRACT — a flag is ON by default on any seat that holds a PG URL:
 *
 *   - `'1'` / `'true'`   → ON   (explicit opt-in, kept for backward compat)
 *   - `'0'` / `'false'`  → OFF  (EMERGENCY KILL-SWITCH back to the old
 *                                  GDrive-only behaviour)
 *   - unset / other      → ON if `UNIFIED_STORE_PG_URL` is set, else OFF
 *
 * A seat WITHOUT `UNIFIED_STORE_PG_URL` sees NO behaviour change: the
 * default resolves to OFF exactly like the old `=== '1'` gate did.
 *
 * Every read is at CALL time (not import time) so a config reload or a test
 * toggles the gate without a process restart — the invariant the existing
 * call sites already carry.
 */

/** Name of the env var that holds the PostgreSQL connection string. */
export const PG_URL_ENV = 'UNIFIED_STORE_PG_URL';

/**
 * True when this host holds a PG connection string.
 *
 * The PG half is only reachable on a host that has one; every gate that
 * routes to PG is conditioned on this.
 */
export function hasPgUrl(): boolean {
  return !!process.env[PG_URL_ENV];
}

/**
 * Resolve a PG cutover flag.
 *
 * @param name - the env var name, e.g. `UNIFIED_STORE_DUAL_WRITE`.
 * @returns true when the flag is on. Explicit `'1'`/`'true'` → on,
 *   explicit `'0'`/`'false'` → off (kill-switch), otherwise the default:
 *   on iff this host holds a PG URL.
 */
export function isPgFlagOn(name: string): boolean {
  const raw = process.env[name];
  if (raw !== undefined) {
    const normalized = raw.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true') return true;
    if (normalized === '0' || normalized === 'false') return false;
  }
  return hasPgUrl();
}
