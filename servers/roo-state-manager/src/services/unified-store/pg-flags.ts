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
 *
 * SCOPE — this module answers the WRITE gates and the plain defaults. The
 * READ gates (`*_READ_PG` / `*_PG_PRIMARY`) have one extra rule: their
 * default is gated on the backfill completeness marker in PG, not on the
 * presence of a URL — see `pg-read-gates.ts` (#4131, review ms#1540). A PG
 * URL alone is not proof that the store was imported.
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
 * The three states a PG cutover flag can be in.
 *
 * - `'on'`     — the operator wrote an explicit ON value (`'1'` / `'true'`).
 * - `'off'`    — the operator wrote an explicit OFF value (`'0'` / `'false'`),
 *                i.e. the emergency kill-switch.
 * - `'default'`— the flag is unset (or holds an unrecognised value): the
 *                behaviour is the DEFAULT, resolved by the caller.
 *
 * The distinction matters for the READ gates (review ms#1540): the default
 * read is gated on DATA (a completed backfill), while an explicit `'1'`
 * still forces the read on — an operator who wrote it meant it.
 */
export type PgFlagState = 'on' | 'off' | 'default';

/**
 * Resolve a PG cutover flag to its three states.
 *
 * @param name - the env var name, e.g. `UNIFIED_STORE_DUAL_WRITE`.
 */
export function pgFlagState(name: string): PgFlagState {
  const raw = process.env[name];
  if (raw !== undefined) {
    const normalized = raw.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true') return 'on';
    if (normalized === '0' || normalized === 'false') return 'off';
  }
  return 'default';
}

/** True when the operator explicitly turned the flag ON (`'1'` / `'true'`). */
export function isPgFlagExplicitlyOn(name: string): boolean {
  return pgFlagState(name) === 'on';
}

/**
 * True when the operator explicitly turned the flag OFF (`'0'` / `'false'`).
 *
 * This is the emergency kill-switch, and it is honoured at CALL time: a seat
 * can be flipped back to the GDrive-only behaviour without a restart.
 */
export function isPgFlagExplicitlyOff(name: string): boolean {
  return pgFlagState(name) === 'off';
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
  const state = pgFlagState(name);
  if (state === 'on') return true;
  if (state === 'off') return false;
  return hasPgUrl();
}
