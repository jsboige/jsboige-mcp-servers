/**
 * Process-wide circuit breaker on channel PG reads (#4131 B16).
 *
 * @module services/unified-store/channel-pg-breaker
 * @issue #4131 B16 (mechanism c.6353386994, arbitration c.6353630611)
 *
 * WHY — under `CHANNEL_PG_PRIMARY` a PG connect timeout used to send every
 * caller to G: immediately (per-call graceful fallback). With 74 RSM
 * processes on a host, one PG timeout therefore fanned out into a herd of G:
 * reads that stalled on the SAME libuv threadpool the PG connects need — the
 * self-feeding loop of the 22-23/10 incident. The breaker makes the
 * degradation sticky: after a channel PG read failure, this process serves
 * degraded (stale cache / fail-closed) WITHOUT re-attempting PG and WITHOUT
 * touching G: for N minutes, then lets the next call probe PG again
 * (half-open: success closes the breaker, failure re-trips it).
 *
 * Scope: the channel READ surfaces of MessageManager (inbox read, count,
 * bulk enumeration). A success on ANY of them closes the breaker — they share
 * one PG pool, so a served query is evidence the pool answers.
 *
 * State is process-local by design: PG reachability is per-host (per-seat PG
 * URL), and cross-process coordination would need the very PG that is down.
 */

import { createLogger } from '../../utils/logger.js';

const logger = createLogger('channel-pg-breaker');

/** Breaker open-until timestamp (ms epoch); 0 = closed. */
let openUntil = 0;
/** Total trips this process — observability (diagnose env / tests). */
let trips = 0;

/** Breaker trip duration. Default 5 min; tunable via CHANNEL_PG_BREAKER_MS. */
function breakerTripMs(): number {
  const raw = Number(process.env.CHANNEL_PG_BREAKER_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5 * 60_000;
}

/** True while the breaker is open — callers serve degraded without probing PG. */
export function channelPgBreakerOpen(now: number = Date.now()): boolean {
  return now < openUntil;
}

/** A channel PG read failed (null/throw at the call site): open the breaker. */
export function noteChannelPgReadFailure(now: number = Date.now()): void {
  if (now >= openUntil) trips++;
  openUntil = now + breakerTripMs();
  logger.warn(
    `[channel-pg-breaker] channel PG read failed — breaker OPEN for ${Math.round(breakerTripMs() / 1000)}s (trip #${trips}): degraded service, no PG probe and no GDrive fan-out until it releases (#4131 B16)`
  );
}

/** A channel PG read succeeded: close the breaker (half-open probe passed). */
export function noteChannelPgReadSuccess(): void {
  if (openUntil !== 0) {
    openUntil = 0;
    logger.info('[channel-pg-breaker] channel PG read succeeded — breaker CLOSED');
  }
}

/** Breaker state for tests and diagnostics. */
export function channelPgBreakerState(now: number = Date.now()): {
  open: boolean;
  openUntilMs: number;
  trips: number;
  tripMs: number;
} {
  return { open: channelPgBreakerOpen(now), openUntilMs: openUntil, trips, tripMs: breakerTripMs() };
}

/** Test seam: reset to a pristine closed state. */
export function resetChannelPgBreakerForTests(): void {
  openUntil = 0;
  trips = 0;
}
