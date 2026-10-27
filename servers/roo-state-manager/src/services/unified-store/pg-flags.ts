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
 * THE KILL-SWITCH IS NOT `0`-ONLY (review NanoClaw, C1) — an operator who
 * writes `off`, `no`, `n`, `disable` or `disabled` MEANS "stop": before this
 * change those values fell through to the DEFAULT, which ARMS the cutover
 * when a PG URL is present — the exact opposite of the intent. Every
 * recognised "no" spelling is now an explicit OFF. Any OTHER unknown value
 * keeps the default: an unknown value must not fail-closed (that would
 * silently disable the cutover on a seat that simply holds a typo).
 *
 * EVERY read is at CALL time (not import time) so a config reload or a test
 * toggles the gate without a process restart — the invariant the existing
 * call sites already carry.
 *
 * SCOPE — this module answers the WRITE gates and the plain defaults. The
 * READ gates (`*_READ_PG` / `*_PG_PRIMARY`) have one extra rule: their
 * default is gated on the backfill completeness marker in PG, not on the
 * presence of a URL — see `pg-read-gates.ts` (#4131, review ms#1540). A PG
 * URL alone is not proof that the store was imported.
 */

import { createLogger } from '../../utils/logger.js';

/**
 * The logger is built LAZILY, on the first warning.
 *
 * `new Logger()` touches the filesystem (it creates its log directory), and
 * this module is imported by the whole unified-store chain — a module-scope
 * `createLogger()` would run that filesystem work at IMPORT time, in every
 * process that loads the store, and it breaks the suites that mock `fs`
 * without `existsSync` (review ms#1540, CI run 9).
 */
let logger: ReturnType<typeof createLogger> | null = null;

/** Name of the env var that holds the PostgreSQL connection string. */
export const PG_URL_ENV = 'UNIFIED_STORE_PG_URL';

/**
 * A PG URL must carry a real PostgreSQL scheme.
 *
 * A placeholder (`none`, `changeme`, `postgres://` with no host…) is not a
 * store: treating it as one arms the dual-write and pays a connect timeout
 * on EVERY write (review NanoClaw, C2). Case-insensitive, and the value may
 * be surrounded by whitespace.
 */
const PG_URL_SCHEME = /^postgres(?:ql)?:\/\//i;

/**
 * The values that mean "OFF" when an operator writes them.
 *
 * `'0'` / `'false'` were the historical spellings; the word forms are the
 * ones an operator actually types (review NanoClaw, C1).
 */
const EXPLICIT_OFF_VALUES: ReadonlySet<string> = new Set([
  '0',
  'false',
  'off',
  'no',
  'n',
  'disable',
  'disabled',
]);

/** One warning per process for an ignored (non-postgres) PG URL. */
let warnedIgnoredPgUrl = false;

/**
 * True when this host holds a PG connection string.
 *
 * The PG half is only reachable on a host that has one; every gate that
 * routes to PG is conditioned on this.
 *
 * A non-empty value that is NOT a `postgres://` / `postgresql://` URL is a
 * placeholder: it is ignored (the default resolves OFF) and logged ONCE per
 * process — the value is NEVER printed (it is masked, the name is not).
 */
export function hasPgUrl(): boolean {
  const raw = process.env[PG_URL_ENV];
  if (!raw) return false;
  const trimmed = raw.trim();
  if (PG_URL_SCHEME.test(trimmed)) return true;

  if (!warnedIgnoredPgUrl) {
    warnedIgnoredPgUrl = true;
    if (!logger) logger = createLogger('pg-flags');
    logger.warn(
      `[pg-flags] ${PG_URL_ENV} is set but does not start with postgres:// or postgresql:// — ` +
      'ignored (value masked). The PG gates stay OFF on this host; a placeholder URL would ' +
      'arm the dual-write and pay a connect timeout on every write.',
      { value: `<redacted:${PG_URL_ENV}>` },
    );
  }
  return false;
}

/** Test seam: forget that the ignored-URL warning was already emitted. */
export function resetIgnoredPgUrlWarning(): void {
  warnedIgnoredPgUrl = false;
}

/**
 * The three states a PG cutover flag can be in.
 *
 * - `'on'`     — the operator wrote an explicit ON value (`'1'` / `'true'`).
 * - `'off'`    — the operator wrote an explicit OFF value (`'0'` / `'false'` /
 *                `off` / `no` / `n` / `disable` / `disabled`), i.e. the
 *                emergency kill-switch.
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
    if (EXPLICIT_OFF_VALUES.has(normalized)) return 'off';
  }
  return 'default';
}

/** True when the operator explicitly turned the flag ON (`'1'` / `'true'`). */
export function isPgFlagExplicitlyOn(name: string): boolean {
  return pgFlagState(name) === 'on';
}

/**
 * True when the operator explicitly turned the flag OFF.
 *
 * This is the emergency kill-switch, and it is honoured at CALL time: a seat
 * can be flipped back to the GDrive-only behaviour without a restart.
 *
 * The recognised OFF spellings are `'0'`, `'false'`, `'off'`, `'no'`, `'n'`,
 * `'disable'` and `'disabled'` — an operator who writes "off" means off, and
 * must not ARM the cutover by accident (review NanoClaw, C1).
 */
export function isPgFlagExplicitlyOff(name: string): boolean {
  return pgFlagState(name) === 'off';
}

/**
 * Resolve a PG cutover flag.
 *
 * @param name - the env var name, e.g. `UNIFIED_STORE_DUAL_WRITE`.
 * @returns true when the flag is on. Explicit `'1'`/`'true'` → on,
 *   an explicit OFF spelling (`'0'`, `'false'`, `'off'`, `'no'`, `'n'`,
 *   `'disable'`, `'disabled'`) → off (kill-switch), otherwise the default:
 *   on iff this host holds a PG URL.
 */
export function isPgFlagOn(name: string): boolean {
  const state = pgFlagState(name);
  if (state === 'on') return true;
  if (state === 'off') return false;
  return hasPgUrl();
}
