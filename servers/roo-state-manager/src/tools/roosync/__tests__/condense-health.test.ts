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
