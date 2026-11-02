/**
 * Single source of truth for the suite-level env pins (#4131 item 3 (A)).
 *
 * @module tests/setup/test-env-pins
 *
 * WHY this module exists — ai-01's review of ms#1558 (drift guard, 28/10): the
 * pin list was copied into FOUR places (both vitest configs, jest.setup.js and
 * the tripwire test) and nothing asserted that any copy still covered the flags
 * `pg-read-gates.ts` actually reads. A gate added tomorrow would be pinned
 * nowhere, and the hole would reopen only on a seat whose `.env` sets it — the
 * exact class ms#1553 measured. One exported constant, imported by all four,
 * removes the copy; the tripwire's coverage test removes the staleness.
 *
 * WHAT a pin is — an EMPTY STRING, never a deletion. A deleted key is not
 * host-owned (host-env-snapshot.ts), so `applyEnvFileForNonHostKeys` refills it
 * with the seat's REAL value when `src/index.ts:49` re-loads the `.env` at
 * import. A present key is host-owned and dotenv never overrides it, so both
 * refill vectors stay closed.
 *
 * SCOPE — the read gates of `pg-read-gates.ts`, the root flag they all depend
 * on (`UNIFIED_STORE_PG_URL`), and the pacer captured at module load
 * (`VectorIndexer.ts:195` — a seat value would make every embedding test pace
 * itself against a production rate).
 */

export const PINNED_TEST_ENV_KEYS = Object.freeze([
  'UNIFIED_STORE_PG_URL',
  'UNIFIED_STORE_DUAL_WRITE',
  'UNIFIED_STORE_CHANNEL_READ_PG',
  'UNIFIED_STORE_CHANNEL_PG_PRIMARY',
  'UNIFIED_STORE_DASHBOARD_READ_PG',
  'UNIFIED_STORE_DASHBOARD_PG_PRIMARY',
  'UNIFIED_STORE_INVENTORY_PG_PRIMARY',
  'EMBEDDING_OPS_PER_MINUTE',
]);

/**
 * The `env` block both vitest configs feed to `test.env`.
 *
 * A plain assignment, performed by vitest BEFORE any test or setup file runs —
 * no import can observe a seat value (the config block is NOT an `??=`
 * fallback: an existing seat value is overwritten, which is the point).
 */
export function pinnedTestEnvEmpty() {
  return Object.fromEntries(PINNED_TEST_ENV_KEYS.map((key) => [key, '']));
}
