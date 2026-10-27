/**
 * PG READ gates — the default is gated on DATA, not on a human flag.
 *
 * @module services/unified-store/pg-read-gates
 * @issue #4131 (PostgreSQL cutover) — review ms#1540
 *
 * WHY this module exists — the review of ms#1540 blocked the "default ON"
 * cutover on one hole: a seat that holds a PG URL but whose channel history
 * was never imported would read an EMPTY mailbox. No error, no breaker trip,
 * no GDrive fallback — under-show, the one failure this channel cannot
 * tolerate (`scripts/backfill-roosync-channel.mjs:9-10`).
 *
 * So the DEFAULT read resolves ON only when the backfill wrote its
 * completeness marker in PG (pg-backfill-marker.ts, migrations/012). The
 * flag keeps its two explicit jobs:
 *
 *   - `'1'`  — the operator forces PG on (backward compatibility: a seat
 *              already running PG-primary keeps working without a marker);
 *   - `'0'`  — the emergency kill-switch, honoured at CALL time.
 *
 * The gates are read at CALL time (not import time), so a config reload
 * flips a seat back to GDrive without a restart.
 *
 * THE DUAL-WRITE KILL-SWITCH — `UNIFIED_STORE_DUAL_WRITE=0` is documented as
 * "back to the old GDrive-only behaviour". That is true for the WRITES
 * (the writer factory builds the Null writer) and — since review ms#1540 —
 * for the READS too: the reader singleton is created once per process, so
 * without an explicit check the flag would stop the writes while the reads
 * kept hitting PG. The check below restores the documented meaning at call
 * time, without touching the singleton.
 *
 * NOT GATED HERE — `UNIFIED_STORE_CONVERSATION_READ_PG`: the conversation
 * tier is ADDITIVE (it contributes only taskIds no earlier tier produced,
 * list-conversations.tool.ts:695-712), so an un-imported store adds rows
 * and never removes one. It stays a plain default-on flag.
 */

import {
  hasPgUrl,
  isPgFlagExplicitlyOff,
  isPgFlagExplicitlyOn,
} from './pg-flags.js';
import { getBackfillMarkerState, type BackfillScope } from './pg-backfill-marker.js';

/**
 * True when the operator turned the shared dual-write gate OFF.
 *
 * `UNIFIED_STORE_DUAL_WRITE=0` is the seat-wide kill-switch: no PG write,
 * no PG read — the pre-cutover behaviour, exactly.
 */
export function isDualWriteExplicitlyOff(): boolean {
  return isPgFlagExplicitlyOff('UNIFIED_STORE_DUAL_WRITE');
}

/**
 * Resolve a READ gate.
 *
 * @param readFlag - the `*_READ_PG` flag of the surface.
 * @param primaryFlag - the `*_PG_PRIMARY` flag of the same surface (a
 *   primary writer MUST read what it writes, so it implies the read).
 * @param scope - which backfill marker gates the default.
 */
function resolveReadGate(readFlag: string, primaryFlag: string, scope: BackfillScope): boolean {
  // The seat-wide kill-switch wins over everything: GDrive-only.
  if (isDualWriteExplicitlyOff()) return false;
  // A primary seat reads what it writes — the explicit primary wins over an
  // explicit read kill-switch (same precedence as the historical
  // `!READ_PG && !PG_PRIMARY` rule: a PG_PRIMARY seat that did not read PG
  // would write into a store it never looks at).
  if (isPgFlagExplicitlyOn(primaryFlag)) return true;
  if (isPgFlagExplicitlyOn(readFlag)) return true;
  // An explicit read kill-switch closes the read (the primary is closed too,
  // or it would be the configuration above).
  if (isPgFlagExplicitlyOff(readFlag)) return false;
  // DEFAULT: PG only when the store is proven complete.
  if (!hasPgUrl()) return false;
  return getBackfillMarkerState(scope) === 'complete';
}

/**
 * Resolve a PRIMARY gate.
 *
 * @param primaryFlag - the `*_PG_PRIMARY` flag of the surface.
 * @param scope - which backfill marker gates the default.
 */
function resolvePrimaryGate(primaryFlag: string, scope: BackfillScope): boolean {
  if (isDualWriteExplicitlyOff()) return false;
  if (isPgFlagExplicitlyOff(primaryFlag)) return false;
  if (isPgFlagExplicitlyOn(primaryFlag)) return true;
  if (!hasPgUrl()) return false;
  return getBackfillMarkerState(scope) === 'complete';
}

/** The channel read gate (`UNIFIED_STORE_CHANNEL_READ_PG` / `..._PG_PRIMARY`). */
export function isChannelReadPgEnabled(): boolean {
  return resolveReadGate(
    'UNIFIED_STORE_CHANNEL_READ_PG',
    'UNIFIED_STORE_CHANNEL_PG_PRIMARY',
    'channel'
  );
}

/** The channel write-primary gate (`UNIFIED_STORE_CHANNEL_PG_PRIMARY`). */
export function isChannelPgPrimaryEnabled(): boolean {
  return resolvePrimaryGate('UNIFIED_STORE_CHANNEL_PG_PRIMARY', 'channel');
}

/** The dashboard read gate (`UNIFIED_STORE_DASHBOARD_READ_PG` / `..._PG_PRIMARY`). */
export function isDashboardReadPgEnabled(): boolean {
  return resolveReadGate(
    'UNIFIED_STORE_DASHBOARD_READ_PG',
    'UNIFIED_STORE_DASHBOARD_PG_PRIMARY',
    'dashboard'
  );
}

/** The dashboard write-primary gate (`UNIFIED_STORE_DASHBOARD_PG_PRIMARY`). */
export function isDashboardPgPrimaryEnabled(): boolean {
  return resolvePrimaryGate('UNIFIED_STORE_DASHBOARD_PG_PRIMARY', 'dashboard');
}
