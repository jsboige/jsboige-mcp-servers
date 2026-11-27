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
 *
 * #4731 lever (a) — background sweeps (expired-message cleanup, expiry
 * reminders) report to their OWN failure accounting and defer while this
 * breaker is open or their previous run measured slow: those sweeps run inline
 * before the inbox listing (tools/roosync/read.ts), and a slow sweep tripping
 * the breaker was failing the very inbox read that followed it (209 opens in
 * 24 h on one seat). They must never be what fails the interactive inbox
 * closed.
 */

import { createLogger } from '@vibesync/core/utils/logger';

const logger = createLogger('channel-pg-breaker');

/** Breaker open-until timestamp (ms epoch); 0 = closed. */
let openUntil = 0;
/** Total trips this process — observability (diagnose env / tests). */
let trips = 0;
/** #4731 — background sweep failures: counted separately, never open the breaker. */
let backgroundFailures = 0;
/** #4731 — epoch ms of the last background sweep failure (diagnostics). */
let lastBackgroundFailureAt = 0;
/** #4731 — last background sweep duration in ms; null before the first sweep. */
let lastSweepDurationMs: number | null = null;
/** #4731 — slow-sweep backoff: further sweeps deferred until this epoch ms. */
let sweepSlowUntil = 0;
/** #4731 W1 — deferral counters per sweep (measurement + tool reporting). */
let cleanupDeferred = 0;
let reminderDeferred = 0;
/** #4731 W1 — reminder own budget: epoch ms of its last PG probe. */
let reminderLastProbeAt = 0;

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

/**
 * #4731 lever (a) — a background sweep's PG read failed. Counted separately:
 * a slow or failing housekeeping scan must not open the breaker that fails
 * the interactive inbox closed (the sweeps run inline before the inbox
 * listing, so a sweep failure was tripping the very read that followed it).
 */
export function noteChannelPgBackgroundFailure(now: number = Date.now()): void {
  backgroundFailures++;
  lastBackgroundFailureAt = now;
  logger.warn(
    `[channel-pg-breaker] background sweep PG read failed (#4731 separate accounting, breaker untouched) — count=${backgroundFailures}`
  );
}

/**
 * #4731 — a background sweep reports its measured duration. A duration at or
 * above the slow threshold arms the backoff window (same length as the
 * breaker trip): the next sweeps defer instead of piling a full-pool scan on
 * a path that just measured slow ("ils reculent quand la latence mesurée est
 * haute").
 */
export function noteChannelPgSweepDuration(durationMs: number, now: number = Date.now()): void {
  lastSweepDurationMs = durationMs;
  const slow = durationMs >= sweepSlowThresholdMs();
  sweepSlowUntil = slow ? now + breakerTripMs() : 0;
  if (slow) {
    logger.warn(
      `[channel-pg-breaker] background sweep took ${Math.round(durationMs)}ms (≥ ${sweepSlowThresholdMs()}ms) — further sweeps deferred ${Math.round(breakerTripMs() / 1000)}s (#4731 latency backoff)`
    );
  }
}

/** True while the previous sweep measured slow and the backoff window holds. */
export function channelPgSweepSlow(now: number = Date.now()): boolean {
  return now < sweepSlowUntil;
}

/**
 * #4731 W1 — a sweep records a deferral. Counted per kind so starvation is
 * MEASURED (state) and reported (manage tool) instead of silent.
 */
export function noteChannelPgSweepDeferred(kind: 'cleanup' | 'reminder'): void {
  if (kind === 'cleanup') cleanupDeferred++;
  else reminderDeferred++;
  logger.warn(
    `[channel-pg-breaker] ${kind} sweep deferred (#4731 backoff) — deferrals: cleanup=${cleanupDeferred}, reminder=${reminderDeferred}`
  );
}

/**
 * #4731 W1 — the reminder sweep's OWN budget: true when a PG probe is due
 * even under backoff. A chronically degraded seat must not starve expiry
 * reminders forever: at least one probe per budget window is forced through.
 * Default: twice the breaker trip window. CHANNEL_PG_REMINDER_BUDGET_MS.
 */
export function channelPgReminderProbeDue(now: number = Date.now()): boolean {
  return now - reminderLastProbeAt >= reminderBudgetMs();
}

/** #4731 W1 — the reminder sweep is about to probe PG: budget consumed. */
export function noteChannelPgReminderProbe(now: number = Date.now()): void {
  reminderLastProbeAt = now;
}

function reminderBudgetMs(): number {
  const raw = Number(process.env.CHANNEL_PG_REMINDER_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2 * breakerTripMs();
}

/**
 * Duration at or above which a sweep arms the backoff. Default 30 s.
 * CHANNEL_PG_SWEEP_SLOW_MS must be > 0 — 0 or negative values are REJECTED
 * (#4731 I4): a 0 threshold would mark every sweep slow and defer both
 * sweeps forever (self-starvation footgun).
 */
function sweepSlowThresholdMs(): number {
  const raw = Number(process.env.CHANNEL_PG_SWEEP_SLOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

/** Breaker state for tests and diagnostics. */
export function channelPgBreakerState(now: number = Date.now()): {
  open: boolean;
  openUntilMs: number;
  trips: number;
  tripMs: number;
  backgroundFailures: number;
  lastBackgroundFailureAt: number;
  lastSweepDurationMs: number | null;
  sweepSlow: boolean;
  cleanupDeferred: number;
  reminderDeferred: number;
  reminderLastProbeAt: number;
} {
  return {
    open: channelPgBreakerOpen(now),
    openUntilMs: openUntil,
    trips,
    tripMs: breakerTripMs(),
    backgroundFailures,
    lastBackgroundFailureAt,
    lastSweepDurationMs,
    sweepSlow: channelPgSweepSlow(now),
    cleanupDeferred,
    reminderDeferred,
    reminderLastProbeAt,
  };
}

/** Test seam: reset to a pristine closed state. */
export function resetChannelPgBreakerForTests(): void {
  openUntil = 0;
  trips = 0;
  backgroundFailures = 0;
  lastBackgroundFailureAt = 0;
  lastSweepDurationMs = null;
  sweepSlowUntil = 0;
  cleanupDeferred = 0;
  reminderDeferred = 0;
  reminderLastProbeAt = 0;
}
