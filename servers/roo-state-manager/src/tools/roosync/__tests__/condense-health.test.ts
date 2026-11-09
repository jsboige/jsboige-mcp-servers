/**
 * #4608 — condensation health state (durable, roosync_store_meta).
 *
 * The module under test is pure state-machine over a mocked KV store; the
 * wire-in points (append relaunch, list organ) live in dashboard.ts and are
 * covered by the wiring assertions in dashboard-condense-detached.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory KV backing the mocked store-meta module. `mockReset: true`
// (vitest.config.ts) wipe les implémentations posées dans la factory — elles
// sont ré-armées dans le beforeEach (pattern #2639 lot 2, cf.
// dashboard-condense-detached.test.ts).
const meta = new Map<string, string>();
const storeMetaMocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
}));

vi.mock('../../../services/unified-store/store-meta.js', () => ({
  readStoreMetaValue: storeMetaMocks.read,
  upsertStoreMetaValue: storeMetaMocks.write,
}));

import {
  noteOverThreshold,
  noteLandingSighting,
  isDeadPass,
  markCondenseAttempt,
  markCondenseOutcome,
  markDeadPassRecovered,
  readCondenseHealth,
  condenseHealthMetaKey,
} from '../condense-health.js';

const KEY = 'machine-myia-po-2025';
const HOUR = 3_600_000;

/** Mutate the stored row without going through the API (time travel). */
async function patchRow(patch: Record<string, unknown>): Promise<void> {
  const raw = meta.get(condenseHealthMetaKey(KEY));
  const current = raw ? JSON.parse(raw) : {};
  meta.set(condenseHealthMetaKey(KEY), JSON.stringify({ ...current, ...patch }));
}

beforeEach(() => {
  meta.clear();
  storeMetaMocks.read.mockReset();
  storeMetaMocks.read.mockImplementation(async (k: string) => meta.get(k) ?? null);
  storeMetaMocks.write.mockReset();
  storeMetaMocks.write.mockImplementation(async (k: string, v: string) => {
    meta.set(k, v);
  });
});

describe('#4608 noteOverThreshold — the stall clock', () => {
  it('first sighting arms the clock and does NOT warn (just crossing is not an incident)', async () => {
    const v = await noteOverThreshold(KEY, true, 1_000_000);
    expect(v.warn).toBe(false);
    const state = await readCondenseHealth(KEY);
    expect(state?.overThresholdSince).toBeTypeOf('string');
    expect(state?.lastWarnAt).toBeNull();
  });

  it('warns once when the clock passes the threshold hours, then stays silent inside the cooldown', async () => {
    await noteOverThreshold(KEY, true, 1_000_000); // arm at t0
    const young = await noteOverThreshold(KEY, true, 1_000_000 + 2 * HOUR);
    expect(young.warn).toBe(false); // 2h < 6h default
    const due = await noteOverThreshold(KEY, true, 1_000_000 + 7 * HOUR);
    expect(due.warn).toBe(true);
    expect(due.hoursOver).toBe(7);
    expect((await readCondenseHealth(KEY))?.lastWarnAt).toBeTypeOf('string');
    const againSoon = await noteOverThreshold(KEY, true, 1_000_000 + 8 * HOUR);
    expect(againSoon.warn).toBe(false); // cooldown 6h
  });

  it('warns again after the cooldown elapses', async () => {
    await noteOverThreshold(KEY, true, 1_000_000);
    await noteOverThreshold(KEY, true, 1_000_000 + 7 * HOUR); // warn #1
    const retry = await noteOverThreshold(KEY, true, 1_000_000 + 13 * HOUR + 1);
    expect(retry.warn).toBe(true); // 6h cooldown passed
  });

  it('a sighting back under the threshold clears the clock', async () => {
    await noteOverThreshold(KEY, true, 1_000_000);
    const cleared = await noteOverThreshold(KEY, false, 1_000_000 + 30 * 60_000);
    expect(cleared.warn).toBe(false);
    expect((await readCondenseHealth(KEY))?.overThresholdSince).toBeNull();
  });
});

describe('#4608 markCondenseOutcome — the landed-pass semantics', () => {
  it('ok and truncated both count as a landed shrink: success stamped, stall clock disarmed', async () => {
    await noteOverThreshold(KEY, true, 1_000_000); // arm the clock
    await markCondenseOutcome(KEY, 'truncated');
    const state = await readCondenseHealth(KEY);
    expect(state?.lastOutcome).toBe('truncated');
    expect(state?.lastSuccessAt).toBeTypeOf('string');
    expect(state?.overThresholdSince).toBeNull();
  });

  it('error keeps the stall clock running and stamps no success', async () => {
    await noteOverThreshold(KEY, true, 1_000_000);
    await markCondenseOutcome(KEY, 'error');
    const state = await readCondenseHealth(KEY);
    expect(state?.lastOutcome).toBe('error');
    expect(state?.lastSuccessAt).toBeNull();
    expect(state?.overThresholdSince).toBeTypeOf('string');
  });
});

describe('#4608 dead-pass detection (relaunch-at-next-append organ)', () => {
  it('an attempting mark older than the horizon is dead', async () => {
    await markCondenseAttempt(KEY);
    await patchRow({ lastAttemptAt: new Date(Date.now() - 31 * 60_000).toISOString() });
    expect(isDeadPass(await readCondenseHealth(KEY))).toBe(true);
  });

  it('a fresh attempting mark is NOT dead (a live pass from another host)', async () => {
    await markCondenseAttempt(KEY);
    expect(isDeadPass(await readCondenseHealth(KEY))).toBe(false);
  });

  it('a terminated outcome is never dead, whatever its age', async () => {
    await markCondenseAttempt(KEY);
    await patchRow({ lastAttemptAt: new Date(Date.now() - 48 * 60_000).toISOString() });
    await markCondenseOutcome(KEY, 'error');
    expect(isDeadPass(await readCondenseHealth(KEY))).toBe(false);
  });

  it('markDeadPassRecovered flips the outcome without touching the clock', async () => {
    await noteOverThreshold(KEY, true, 1_000_000);
    await markCondenseAttempt(KEY);
    await patchRow({ lastAttemptAt: new Date(Date.now() - 31 * 60_000).toISOString() });
    await markDeadPassRecovered(KEY);
    const state = await readCondenseHealth(KEY);
    expect(state?.lastOutcome).toBe('dead-pass-recovered');
    expect(state?.overThresholdSince).toBeTypeOf('string');
  });
});

describe('#4608 lastSeat — which seat ran the pass (measured 09/11)', () => {
  it('an attempt records the seat that owns the pass', async () => {
    await markCondenseAttempt(KEY, 'myia-web2:roo-extensions');
    const state = await readCondenseHealth(KEY);
    expect(state?.lastOutcome).toBe('attempting');
    expect(state?.lastSeat).toBe('myia-web2:roo-extensions');
  });

  it('an outcome records the seat alongside the verdict', async () => {
    await markCondenseOutcome(KEY, 'ok', 'myia-ai-01:roo-extensions');
    const state = await readCondenseHealth(KEY);
    expect(state?.lastOutcome).toBe('ok');
    expect(state?.lastSeat).toBe('myia-ai-01:roo-extensions');
  });

  it('a caller that passes no seat never erases the seat already known', async () => {
    await markCondenseAttempt(KEY, 'myia-po-2023:roo-extensions');
    await markCondenseOutcome(KEY, 'error');
    const state = await readCondenseHealth(KEY);
    expect(state?.lastOutcome).toBe('error');
    expect(state?.lastSeat).toBe('myia-po-2023:roo-extensions');
  });

  it('a row written before the field existed reads as null, not undefined', async () => {
    meta.set(condenseHealthMetaKey(KEY), JSON.stringify({
      lastAttemptAt: '2026-11-09T07:36:16.354Z',
      lastOutcome: 'ok',
      lastSuccessAt: '2026-11-09T07:38:10.370Z',
      overThresholdSince: null,
      lastWarnAt: null,
    }));
    const state = await readCondenseHealth(KEY);
    expect(state?.lastSeat).toBeNull();
  });
});

describe('#4608 fail-safety', () => {
  it('an unreadable row degrades to the pre-#4608 state (no opinion)', async () => {
    meta.set(condenseHealthMetaKey(KEY), 'not-json{');
    expect(await readCondenseHealth(KEY)).toBeNull();
    expect(isDeadPass(null)).toBe(false);
    // noteOverThreshold treats it as empty state: arms the clock, no warn.
    const v = await noteOverThreshold(KEY, true, 1_000_000);
    expect(v.warn).toBe(false);
  });
});

// ─── contrôle d'atterrissage (landing control, mesuré 09/11) ──────────────────
//
// `condense_state:global` = ok @ 07:38:10Z alors que le fichier G: portait
// lastCondensedAt 00:52:45Z (mtime 04:16:44) ; workspace-CoursIA suivait
// normalement (écart 0,7 s). Le verdict `ok` ne prouve pas l'atterrissage
// fichier — ce contrôle rend l'écart visible et attribué.
describe('#4608 noteLandingSighting — the landing control', () => {
  const NOW = 100_000_000;

  /** Row shortcut: a pass that succeeded `hoursAgo` from `seat`. */
  async function seedPass(outcome: 'ok' | 'truncated', hoursAgo: number, seat: string): Promise<void> {
    meta.set(condenseHealthMetaKey(KEY), JSON.stringify({
      lastAttemptAt: new Date(NOW - hoursAgo * HOUR - 60_000).toISOString(),
      lastOutcome: outcome,
      lastSuccessAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
      overThresholdSince: null,
      lastWarnAt: null,
      lastLandingWarnAt: null,
      lastSeat: seat,
      lastDeadPassAt: null,
      lastDeadPassSeat: null,
    }));
  }

  it('a file written at/after the pass landed — no warn however old the pass', async () => {
    await seedPass('ok', 3, 'myia-po-2023:roo-extensions'); // pass 3h ago
    const v = await noteLandingSighting(KEY, { fileMtimeMs: NOW - 2 * HOUR }, NOW); // file 2h ago
    expect(v.warn).toBe(false);
  });

  it('a fresh file short-circuits without touching the store (zero-cost path)', async () => {
    const readCalls = storeMetaMocks.read.mock.calls.length;
    const v = await noteLandingSighting(KEY, { fileMtimeMs: NOW - 10 * 60_000 }, NOW);
    expect(v.warn).toBe(false);
    expect(storeMetaMocks.read.mock.calls.length).toBe(readCalls);
  });

  it('a pass younger than the grace window is not flagged even on a stale file (DriveFS may still absorb)', async () => {
    await seedPass('ok', 10 / 60, 'myia-po-2023:roo-extensions'); // pass 10 min ago
    const v = await noteLandingSighting(KEY, { fileMtimeMs: NOW - 90 * 60_000 }, NOW); // file 90 min ago
    expect(v.warn).toBe(false);
  });

  it('ok pass older than grace, file untouched since before the pass → warn, attributed', async () => {
    await seedPass('ok', 2, 'myia-web2:roo-extensions'); // pass 2h ago
    const v = await noteLandingSighting(KEY, { fileMtimeMs: NOW - 5 * HOUR }, NOW); // file 5h ago
    expect(v.warn).toBe(true);
    expect(v.lagMinutes).toBe(300);
    expect(v.seat).toBe('myia-web2:roo-extensions');
    expect(v.passAt).toBeTypeOf('string');
    expect((await readCondenseHealth(KEY))?.lastLandingWarnAt).toBeTypeOf('string');
  });

  it('truncated is a landed-write outcome too — eligible for the landing check', async () => {
    await seedPass('truncated', 2, 'myia-po-2025:roo-extensions');
    const v = await noteLandingSighting(KEY, { fileMtimeMs: NOW - 5 * HOUR }, NOW);
    expect(v.warn).toBe(true);
  });

  it('error outcome never flags (no success to land)', async () => {
    await seedPass('ok', 2, 'myia-po-2025:roo-extensions');
    await patchRow({ lastOutcome: 'error', lastSuccessAt: null });
    const v = await noteLandingSighting(KEY, { fileMtimeMs: NOW - 5 * HOUR }, NOW);
    expect(v.warn).toBe(false);
  });

  it('stays silent inside the cooldown, warns again after it', async () => {
    await seedPass('ok', 2, 'myia-web2:roo-extensions');
    expect((await noteLandingSighting(KEY, { fileMtimeMs: NOW - 5 * HOUR }, NOW)).warn).toBe(true);
    // still missed 1h later, but cooldown 6h
    const tooSoon = await noteLandingSighting(KEY, { fileMtimeMs: NOW - 6 * HOUR }, NOW + HOUR);
    expect(tooSoon.warn).toBe(false);
    expect(tooSoon.seat).toBe('myia-web2:roo-extensions'); // facts still served for the annotation
    const due = await noteLandingSighting(KEY, { fileMtimeMs: NOW - 12 * HOUR }, NOW + 7 * HOUR + 1);
    expect(due.warn).toBe(true);
  });

  it('a stall WARN never masks a landing miss (separate latch)', async () => {
    await seedPass('ok', 2, 'myia-web2:roo-extensions');
    await patchRow({ lastWarnAt: new Date(NOW - 30 * 60_000).toISOString() }); // stall warn 30 min ago
    const v = await noteLandingSighting(KEY, { fileMtimeMs: NOW - 5 * HOUR }, NOW);
    expect(v.warn).toBe(true);
  });

  it('mirror-off is no opinion — and never reads the row', async () => {
    const readCalls = storeMetaMocks.read.mock.calls.length;
    const v = await noteLandingSighting(KEY, { fileMtimeMs: NOW - 5 * HOUR, mirrorOff: true }, NOW);
    expect(v.warn).toBe(false);
    expect(storeMetaMocks.read.mock.calls.length).toBe(readCalls);
  });

  it('no file at all (PG-only key) is no opinion', async () => {
    await seedPass('ok', 2, 'myia-po-2027:roo-extensions');
    const v = await noteLandingSighting(KEY, { fileMtimeMs: undefined }, NOW);
    expect(v.warn).toBe(false);
  });
});

describe('#4608 markDeadPassRecovered — the dead pass stays attributable', () => {
  it('copies the dead pass attempt time and seat before the relaunch overwrites them', async () => {
    const deadAt = new Date(Date.now() - 31 * 60_000).toISOString();
    await markCondenseAttempt(KEY, 'myia-po-2027:roo-extensions');
    await patchRow({ lastAttemptAt: deadAt }); // time travel past the horizon
    await markDeadPassRecovered(KEY);
    // the relaunch that follows immediately (dashboard.ts wiring)
    await markCondenseAttempt(KEY, 'myia-po-2024:roo-extensions');
    const state = await readCondenseHealth(KEY);
    expect(state?.lastDeadPassAt).toBe(deadAt);
    expect(state?.lastDeadPassSeat).toBe('myia-po-2027:roo-extensions');
    expect(state?.lastSeat).toBe('myia-po-2024:roo-extensions'); // the relaunch owns the row now
    expect(state?.lastOutcome).toBe('attempting');
  });

  it('a recovery called on a non-attempting row leaves the recorded dead pass intact', async () => {
    await markCondenseAttempt(KEY, 'myia-po-2027:roo-extensions');
    await patchRow({
      lastOutcome: 'dead-pass-recovered',
      lastDeadPassAt: '2026-11-08T18:59:17.000Z',
      lastDeadPassSeat: 'myia-web1:roo-extensions',
    });
    await markDeadPassRecovered(KEY); // degenerate call, not from the isDeadPass branch
    const state = await readCondenseHealth(KEY);
    expect(state?.lastDeadPassAt).toBe('2026-11-08T18:59:17.000Z');
    expect(state?.lastDeadPassSeat).toBe('myia-web1:roo-extensions');
  });

  it('a legacy row (fields absent) reads the new fields as null', async () => {
    meta.set(condenseHealthMetaKey(KEY), JSON.stringify({
      lastAttemptAt: '2026-11-09T07:36:16.354Z',
      lastOutcome: 'ok',
      lastSuccessAt: '2026-11-09T07:38:10.370Z',
      overThresholdSince: null,
      lastWarnAt: null,
      lastSeat: null,
    }));
    const state = await readCondenseHealth(KEY);
    expect(state?.lastLandingWarnAt).toBeNull();
    expect(state?.lastDeadPassAt).toBeNull();
    expect(state?.lastDeadPassSeat).toBeNull();
  });
});
