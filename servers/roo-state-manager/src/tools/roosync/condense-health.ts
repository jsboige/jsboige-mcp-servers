/**
 * Durable per-key condensation health state — #4608.
 *
 * WHY — measured 08/11 on the live store: active dashboards sit over the 100 %
 * hard-cap for days (machine-po-2027 114 %, machine-po-2025 108 %,
 * machine-web1 105 %) with ZERO condensation landing, while the machinery
 * itself works (the `global` condensed fine at 19:41Z via the cloud tier).
 * Three blind spots, all sharing one root cause — condensation state lives
 * ONLY in the launching process's memory:
 *
 *   1. a detached pass (#4527) that dies with its host session leaves no
 *      trace anywhere except the `condense:*` lock row (web1: orphan row held
 *      47 min by a dead pid, measured 19:55Z);
 *   2. `detachedCondenseOutcomes` is an in-process Map — the failure outcome
 *      of a pass launched by host A is invisible to hosts B..N and to every
 *      operator;
 *   3. nothing ever looks at a dashboard's utilization unless an append
 *      arrives, so stale dashboards (workspace-roo-state-manager 111 % since
 *      11-03) never condense and never alert.
 *
 * This module persists the per-key state in `roosync_store_meta`
 * (migrations/012 — generic KV, no new migration) so that ANY host can see
 * when a pass is dead, and a list-side organ can warn when a dashboard stays
 * over the condensation threshold for hours. Fail-safe by design: PG absent
 * or slow → every function degrades to "no opinion" and the historical
 * behavior (in-process state only) is unchanged.
 *
 * @module tools/roosync/condense-health
 * @issue #4608 (mandate user 04/11 — « La condensation RSM est tjs HS »)
 */

import { createLogger } from '../../utils/logger.js';
import { readStoreMetaValue, upsertStoreMetaValue } from '../../services/unified-store/store-meta.js';

/**
 * Lazy logger — same reason as store-meta.ts: this module is imported
 * transitively by unit tests that mock `fs` with a partial double.
 */
let cachedLogger: ReturnType<typeof createLogger> | null = null;
function getLogger(): ReturnType<typeof createLogger> {
  if (!cachedLogger) cachedLogger = createLogger('condense-health');
  return cachedLogger;
}

/** Meta key prefix — one row per dashboard key. */
const META_KEY_PREFIX = 'condense_state:';

export function condenseHealthMetaKey(dashboardKey: string): string {
  return `${META_KEY_PREFIX}${dashboardKey}`;
}

export type CondensePassOutcome =
  | 'attempting'          // a pass started and has not recorded an outcome yet
  | 'ok'                  // a pass completed and its shrink landed
  | 'truncated'           // completed via the truncation fallback (still a shrink)
  | 'error'               // the pass threw (message + status intact)
  | 'dead-pass-recovered'; // an `attempting` row whose age passed the dead horizon

export interface CondenseHealthState {
  /** ISO timestamp of the last pass START (`attempting` write). */
  lastAttemptAt: string | null;
  /** Outcome of the last pass, or `attempting` while it runs. */
  lastOutcome: CondensePassOutcome | null;
  /** ISO timestamp of the last pass whose shrink actually landed. */
  lastSuccessAt: string | null;
  /**
   * First sighting (ISO) of utilization over the warn threshold with no
   * landed success since — the start of the stall clock for the [WARN] organ.
   */
  overThresholdSince: string | null;
  /** ISO timestamp of the last stall [WARN] posted for this key. */
  lastWarnAt: string | null;
}

const EMPTY_STATE: CondenseHealthState = {
  lastAttemptAt: null,
  lastOutcome: null,
  lastSuccessAt: null,
  overThresholdSince: null,
  lastWarnAt: null,
};

/** How long a dashboard may sit over the threshold before the [WARN] fires (default 6 h). */
export function condenseStallWarnHours(): number {
  const raw = Number(process.env.CONDENSE_STALL_WARN_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 6;
}

/** Cooldown between two stall [WARN]s for the same key (default 6 h). */
export function condenseStallWarnCooldownMs(): number {
  const raw = Number(process.env.CONDENSE_STALL_WARN_COOLDOWN_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 6 * 60 * 60 * 1000;
}

/**
 * A pass whose `attempting` mark is older than this horizon is dead — its
 * host died with it (#4527: the detached pass lives in the host process).
 * Two lock TTLs (~30 min): beyond one TTL the lock steal already lets a new
 * pass start, so an `attempting` row that old can no longer be a live pass.
 */
export function condenseDeadPassHorizonMs(): number {
  const raw = Number(process.env.CONDENSE_DEAD_PASS_HORIZON_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000;
}

function parseState(raw: string | null): CondenseHealthState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CondenseHealthState>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return {
      lastAttemptAt: typeof parsed.lastAttemptAt === 'string' ? parsed.lastAttemptAt : null,
      lastOutcome: (typeof parsed.lastOutcome === 'string' ? parsed.lastOutcome : null) as CondensePassOutcome | null,
      lastSuccessAt: typeof parsed.lastSuccessAt === 'string' ? parsed.lastSuccessAt : null,
      overThresholdSince: typeof parsed.overThresholdSince === 'string' ? parsed.overThresholdSince : null,
      lastWarnAt: typeof parsed.lastWarnAt === 'string' ? parsed.lastWarnAt : null,
    };
  } catch {
    return null;
  }
}

/** Best-effort write — a failed write logs and leaves the previous row intact. */
async function writeState(key: string, state: CondenseHealthState): Promise<void> {
  try {
    await upsertStoreMetaValue(condenseHealthMetaKey(key), JSON.stringify(state));
  } catch (err) {
    getLogger().debug('condense-health write failed (non-fatal)', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Read the durable state of `key`. Null when the row is absent, PG is off,
 * or the row is unreadable — absence is the pre-#4608 state, never an error.
 */
export async function readCondenseHealth(key: string): Promise<CondenseHealthState | null> {
  try {
    return parseState(await readStoreMetaValue(condenseHealthMetaKey(key)));
  } catch (err) {
    getLogger().debug('condense-health read failed (non-fatal)', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Is the recorded pass dead? True when an `attempting` mark is older than the
 * dead-pass horizon — the relaunch-at-next-append organ keys off this.
 */
export function isDeadPass(state: CondenseHealthState | null, now: number = Date.now()): boolean {
  if (!state || state.lastOutcome !== 'attempting' || !state.lastAttemptAt) return false;
  const startedAt = new Date(state.lastAttemptAt).getTime();
  if (!Number.isFinite(startedAt)) return false;
  return now - startedAt >= condenseDeadPassHorizonMs();
}

/**
 * Mark a pass as started. Called by the append path right before the lock
 * acquisition, so the next host to touch the key can tell a live pass from a
 * dead one. Preserves the stall clock (`overThresholdSince`).
 */
export async function markCondenseAttempt(key: string): Promise<void> {
  const prev = (await readCondenseHealth(key)) ?? EMPTY_STATE;
  const now = new Date().toISOString();
  await writeState(key, {
    ...prev,
    lastAttemptAt: now,
    lastOutcome: 'attempting',
  });
}

/**
 * Mark a dead `attempting` row as recovered. The relaunch is the pass the
 * caller is about to start — this write only makes the death durable and
 * visible instead of letting the row say `attempting` forever.
 */
export async function markDeadPassRecovered(key: string): Promise<void> {
  const prev = (await readCondenseHealth(key)) ?? EMPTY_STATE;
  await writeState(key, { ...prev, lastOutcome: 'dead-pass-recovered' });
}

/**
 * Record the outcome of a completed pass. `ok`/`truncated` both landed a
 * shrink (the truncation fallback rewrites the dashboard too, #1792), so both
 * count as a success for the stall clock and disarm `overThresholdSince` —
 * if the dashboard is STILL over the threshold, the next list sighting
 * re-arms the clock from now, never inheriting a stale start.
 */
export async function markCondenseOutcome(
  key: string,
  outcome: Exclude<CondensePassOutcome, 'attempting' | 'dead-pass-recovered'>
): Promise<void> {
  const prev = (await readCondenseHealth(key)) ?? EMPTY_STATE;
  const now = new Date().toISOString();
  const landed = outcome === 'ok' || outcome === 'truncated';
  await writeState(key, {
    ...prev,
    lastOutcome: outcome,
    ...(landed ? { lastSuccessAt: now, overThresholdSince: null } : {}),
  });
}

export interface StallWarnVerdict {
  /** Post the stall [WARN] now (age ≥ threshold AND cooldown elapsed). */
  warn: boolean;
  /** Hours over the threshold, rounded — for the message. */
  hoursOver: number;
}

/**
 * Detection organ core — called list-side for every key whose utilization is
 * over the condensation threshold (92 %). State machine:
 *
 *   - no `overThresholdSince` → arm the clock now, no warn (a dashboard that
 *     just crossed is the condensation's business, not an incident);
 *   - clock younger than `condenseStallWarnHours` → nothing;
 *   - clock older AND no warn inside the cooldown → warn once, stamp
 *     `lastWarnAt`;
 *   - utilization back under the threshold → caller passes `overThreshold:
 *     false` and the clock is cleared (a condensation that landed resets the
 *     latch, exactly like the in-process `fillWarnLatched`).
 *
 * Returns the verdict; the CALLER posts the warn (this module must stay
 * side-effect-free beyond its own row).
 */
export async function noteOverThreshold(
  key: string,
  overThreshold: boolean,
  now: number = Date.now()
): Promise<StallWarnVerdict> {
  const prev = (await readCondenseHealth(key)) ?? EMPTY_STATE;

  if (!overThreshold) {
    if (prev.overThresholdSince !== null) {
      await writeState(key, { ...prev, overThresholdSince: null });
    }
    return { warn: false, hoursOver: 0 };
  }

  if (prev.overThresholdSince === null) {
    await writeState(key, { ...prev, overThresholdSince: new Date(now).toISOString() });
    getLogger().info('condense-health: dashboard over condensation threshold — stall clock armed (#4608)', { key });
    return { warn: false, hoursOver: 0 };
  }

  const sinceMs = now - new Date(prev.overThresholdSince).getTime();
  if (!Number.isFinite(sinceMs) || sinceMs <= 0) {
    return { warn: false, hoursOver: 0 };
  }
  const hoursOver = sinceMs / 3_600_000;

  if (hoursOver < condenseStallWarnHours()) {
    return { warn: false, hoursOver };
  }

  const lastWarnMs = prev.lastWarnAt ? now - new Date(prev.lastWarnAt).getTime() : Number.POSITIVE_INFINITY;
  if (lastWarnMs < condenseStallWarnCooldownMs()) {
    return { warn: false, hoursOver };
  }

  await writeState(key, { ...prev, lastWarnAt: new Date(now).toISOString() });
  return { warn: true, hoursOver: Math.round(hoursOver) };
}
