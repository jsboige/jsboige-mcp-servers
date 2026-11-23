/**
 * #4731 lever (a) — background sweeps (cleanupExpiredMessages,
 * sendExpiryReminders) must NOT open the shared channel-pg breaker that
 * fails the interactive inbox closed.
 *
 * Measured mechanism (14-15/11, myia-po-2027 seat): the inbox tool runs both
 * sweeps inline BEFORE the listing (tools/roosync/read.ts, throttled 5 min);
 * each sweep does a full-pool `readWholeChannelFromPg` (6 605 rows measured,
 * 5-73 s per scan when the path is slow); when that read failed it called
 * `noteChannelPgReadFailure()` — opening the breaker that the SAME inbox
 * call checks right after (readInbox l.1844) → the inbox failed closed
 * `pg-unavailable` because its own housekeeping sweep was slow. 209 breaker
 * opens in 24 h on one seat (#4731).
 *
 * Contract pinned here:
 *   1. a FAILED sweep counts as a background failure only — the shared
 *      breaker stays closed, so the inbox right after still serves from PG;
 *   2. with the breaker already open (interactive PG failures), the cleanup
 *      sweep defers WITHOUT probing PG (PG_PRIMARY only, per B16 doctrine:
 *      on a non-primary READ_PG seat the per-call GDrive fallback is the
 *      design, pinned by tests/unit/services/unified-store/
 *      channel-pg-paths-4302.test.ts) — and the deferral is COUNTED, not
 *      silent (W3 measurement);
 *   2b. W1 (#4731 review) — the reminder sweep has its OWN budget: at least
 *      one PG probe per budget window (default 2× the breaker trip) is
 *      forced through even under backoff, so a chronically degraded seat
 *      cannot starve expiry reminders forever; a failed forced probe counts
 *      a background failure and never re-trips the breaker;
 *   3. a measured-slow previous sweep defers the next one the same way
 *      ("ils reculent quand la latence mesurée est haute");
 *   4. a successful sweep still closes an open breaker (pool evidence) and
 *      serves — the sweeps stay functional when PG is healthy.
 *
 * The interactive surfaces keep their B16 fail-closed contract unchanged
 * (pinned by MessageManager.b16-pg-primary-no-gdrive-fanout.test.ts).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const MACHINE = 'myia-po-2027';
const WORKSPACE = 'roo-extensions';

const mocks = vi.hoisted(() => ({
  pgActive: true,
  wholeFails: false,
  wholeCalls: 0,
  wholeOpts: [] as unknown[],
  inboxFails: false,
  inboxItems: [] as Array<Record<string, unknown>>,
  sharedPath: '',
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// PG channel read surface doubled (transport only — the gates under test are
// the real ones: isChannelPgPrimary reads env, the breaker is the real module).
vi.mock('../unified-store/roosync-channel-read.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getChannelPgReader: () => (mocks.pgActive ? { stub: true } : null),
    readWholeChannelFromPg: async (_reader: unknown, opts?: unknown) => {
      mocks.wholeCalls++;
      mocks.wholeOpts.push(opts);
      return mocks.wholeFails ? null : [];
    },
    readChannelInboxFromPg: async () => (mocks.inboxFails ? null : mocks.inboxItems),
  };
});

import { MessageManager } from '../MessageManager.js';
import {
  resetChannelPgBreakerForTests,
  channelPgBreakerState,
  noteChannelPgReadFailure,
  noteChannelPgReminderProbe,
  noteChannelPgSweepDuration,
} from '../unified-store/channel-pg-breaker.js';

let previousEnv: Record<string, string | undefined>;
let manager: MessageManager;

const ENV_KEYS = [
  'ROOSYNC_MACHINE_ID',
  'ROOSYNC_WORKSPACE_ID',
  'UNIFIED_STORE_CHANNEL_READ_PG',
  'UNIFIED_STORE_CHANNEL_PG_PRIMARY',
  'UNIFIED_STORE_DUAL_WRITE',
  'UNIFIED_STORE_PG_URL',
  'CHANNEL_PG_BREAKER_MS',
  'CHANNEL_PG_SWEEP_SLOW_MS',
  'CHANNEL_PG_REMINDER_BUDGET_MS',
  'ROOSYNC_CHANNEL_SWEEP_BODYLESS',
] as const;

const PG_MESSAGE = {
  id: 'msg-20261115T060000-4731a',
  from: 'myia-ai-01:roo-extensions',
  to: MACHINE,
  subject: '#4731 fixture — served over PG',
  body: 'body',
  priority: 'MEDIUM',
  status: 'unread',
  timestamp: new Date().toISOString(),
  tags: [],
};

function setPgPrimaryEnv(): void {
  process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
  process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY = '1';
  process.env.UNIFIED_STORE_DUAL_WRITE = '1';
  process.env.UNIFIED_STORE_PG_URL = 'postgres://unit-test.invalid:5432/rsm';
}

describe('#4731 lever (a) — background sweeps never fail the interactive inbox closed', () => {
  beforeEach(() => {
    mocks.pgActive = true;
    mocks.wholeFails = false;
    mocks.wholeCalls = 0;
    mocks.wholeOpts = [];
    mocks.inboxFails = false;
    mocks.inboxItems = [];
    mocks.sharedPath = mkdtempSync(join(tmpdir(), 'rsm-4731-'));
    for (const dir of ['inbox', 'sent', 'archive']) {
      mkdirSync(join(mocks.sharedPath, 'messages', dir), { recursive: true });
    }

    previousEnv = {};
    for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
    process.env.ROOSYNC_MACHINE_ID = MACHINE;
    process.env.ROOSYNC_WORKSPACE_ID = WORKSPACE;
    delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
    delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
    delete process.env.UNIFIED_STORE_DUAL_WRITE;
    delete process.env.UNIFIED_STORE_PG_URL;
    delete process.env.CHANNEL_PG_SWEEP_SLOW_MS;
    delete process.env.CHANNEL_PG_REMINDER_BUDGET_MS;
    delete process.env.ROOSYNC_CHANNEL_SWEEP_BODYLESS;
    resetChannelPgBreakerForTests();

    manager = new MessageManager(mocks.sharedPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetChannelPgBreakerForTests();
    for (const key of ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(mocks.sharedPath, { recursive: true, force: true });
  });

  test('failed cleanup sweep → background failure counted, breaker stays CLOSED, inbox right after still serves from PG', async () => {
    setPgPrimaryEnv();
    mocks.wholeFails = true; // the full-pool scan fails (slow/unavailable path)
    mocks.inboxItems = [PG_MESSAGE]; // the mailbox read itself would succeed

    const destroyed = await manager.cleanupExpiredMessages();
    expect(destroyed).toBe(0); // deferred under PG_PRIMARY
    // THE regression: the sweep used to open the shared breaker here.
    expect(channelPgBreakerState().open).toBe(false);
    expect(channelPgBreakerState().backgroundFailures).toBe(1);

    // The inbox in the SAME process (the read.ts inline order: sweeps, then
    // listing) must NOT fail closed because of the sweep above.
    const items = await manager.readInbox(MACHINE, 'all', undefined, WORKSPACE);
    expect(items.map((i) => i.id)).toContain(PG_MESSAGE.id);
  });

  test('failed reminder sweep → same contract: breaker stays closed', async () => {
    setPgPrimaryEnv();
    mocks.wholeFails = true;

    const sent = await manager.sendExpiryReminders();
    expect(sent).toBe(0);
    expect(channelPgBreakerState().open).toBe(false);
    expect(channelPgBreakerState().backgroundFailures).toBe(1);
  });

  test('breaker already open → cleanup defers WITHOUT probing; the reminder sweep spends its own-budget probe (W1)', async () => {
    setPgPrimaryEnv();
    noteChannelPgReadFailure(); // interactive PG failures opened the breaker
    expect(channelPgBreakerState().open).toBe(true);
    mocks.wholeFails = false; // PG would answer

    expect(await manager.cleanupExpiredMessages()).toBe(0);
    expect(mocks.wholeCalls).toBe(0); // cleanup: no full-pool probe while degraded
    expect(channelPgBreakerState().cleanupDeferred).toBe(1); // measured, not silent

    // W1 (#4731 review): the reminder sweep has its OWN budget — fresh
    // process, budget never consumed → exactly one forced probe despite the
    // open breaker, so reminders cannot be starved forever.
    expect(await manager.sendExpiryReminders()).toBe(0);
    expect(mocks.wholeCalls).toBe(1);
    expect(channelPgBreakerState().reminderDeferred).toBe(0);
    expect(channelPgBreakerState().backgroundFailures).toBe(0); // the probe succeeded
  });

  test('W1 — once the budget probe is spent, the immediate reminder retry defers and is counted', async () => {
    setPgPrimaryEnv();
    noteChannelPgReadFailure(); // breaker open
    mocks.wholeFails = false;

    await manager.sendExpiryReminders(); // budget probe spent
    expect(mocks.wholeCalls).toBe(1);

    const second = await manager.sendExpiryReminders(); // within budget window
    expect(second).toBe(0);
    expect(mocks.wholeCalls).toBe(1); // no second probe
    expect(channelPgBreakerState().reminderDeferred).toBe(1); // starvation measured
  });

  test('W1 — a forced reminder probe that FAILS counts a background failure and never re-trips the breaker', async () => {
    setPgPrimaryEnv();
    noteChannelPgReadFailure(); // breaker open from an interactive failure
    const openUntilBefore = channelPgBreakerState().openUntilMs;
    mocks.wholeFails = true; // the forced probe fails too

    const sent = await manager.sendExpiryReminders();
    expect(sent).toBe(0);
    expect(mocks.wholeCalls).toBe(1); // the budget forced the probe
    expect(channelPgBreakerState().backgroundFailures).toBe(1);
    // The sweep failure must not extend the breaker window (lever (a) intact).
    expect(channelPgBreakerState().openUntilMs).toBe(openUntilBefore);
  });

  test('measured-slow previous sweep → the cleanup sweep defers without probing (latency backoff)', async () => {
    setPgPrimaryEnv();
    noteChannelPgSweepDuration(45_000); // measured: full scans ran 5-73 s
    mocks.wholeFails = false;

    expect(await manager.cleanupExpiredMessages()).toBe(0);
    expect(mocks.wholeCalls).toBe(0);
    // The reminder sweep is NOT pinned here: its own budget (W1) may force a
    // probe under slow-backoff — that carve-out has its own tests above.
  });

  test('control — seat healthy: sweep runs, serves from PG, counts nothing as failure', async () => {
    setPgPrimaryEnv();
    mocks.wholeFails = false;

    const destroyed = await manager.cleanupExpiredMessages();
    expect(destroyed).toBe(0); // empty pool, but the sweep RAN
    expect(mocks.wholeCalls).toBe(1);
    expect(channelPgBreakerState().open).toBe(false);
    expect(channelPgBreakerState().backgroundFailures).toBe(0);
    expect(channelPgBreakerState().sweepSlow).toBe(false);
  });

  test('non-primary READ_PG seat: the cleanup sweep does NOT defer under backoff (PG_PRIMARY-only guard)', async () => {
    // On a non-primary seat (CHANNEL_PG_PRIMARY unset) the per-call GDrive
    // fallback IS the design (B16 doctrine, MessageManager l.2636), so the
    // sweep keeps its contract even while the breaker is open. Dropping
    // `isChannelPgPrimary() &&` from the guard would defer it here — red.
    process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://unit-test.invalid:5432/rsm';
    noteChannelPgReadFailure(); // breaker open (interactive PG failures)
    expect(channelPgBreakerState().open).toBe(true);
    mocks.wholeFails = false;

    expect(await manager.cleanupExpiredMessages()).toBe(0);
    expect(mocks.wholeCalls).toBe(1); // the sweep probed: not deferred
    expect(channelPgBreakerState().cleanupDeferred).toBe(0);
  });

  test('non-primary READ_PG seat: the reminder sweep keeps probing after its budget probe is spent', async () => {
    // Same non-primary seat. The own-budget probe is spent FIRST, so a guard
    // stripped to `backoffHeld && !due` would defer this call: this test pins
    // the PG_PRIMARY-only scope of BOTH reminder guards (l.2717-2728).
    process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://unit-test.invalid:5432/rsm';
    noteChannelPgReadFailure(); // breaker open
    noteChannelPgReminderProbe(); // budget window consumed: not due anymore
    mocks.wholeFails = false;

    expect(await manager.sendExpiryReminders()).toBe(0);
    expect(mocks.wholeCalls).toBe(1); // probed despite backoff + spent budget
    expect(channelPgBreakerState().reminderDeferred).toBe(0);
  });

  test('#4731 — both sweeps read the channel WITHOUT bodies by default (bodyChars: 0)', async () => {
    // The bodies are 79 % of the full-pool payload (8.66 MB of 10.90 MB,
    // measured po-204 23/11) and neither consumer reads `body`: cleanup
    // decides on options.expires_at/auto_destruct, reminders on options +
    // subject. The option must be asked for by BOTH sweep call sites.
    setPgPrimaryEnv();
    mocks.wholeFails = false;

    await manager.cleanupExpiredMessages();
    await manager.sendExpiryReminders();

    expect(mocks.wholeCalls).toBe(2);
    expect(mocks.wholeOpts).toEqual([{ bodyChars: 0 }, { bodyChars: 0 }]);
  });

  test('#4731 — kill-switch ROOSYNC_CHANNEL_SWEEP_BODYLESS=0 restores the full body (diagnosis only)', async () => {
    // Fleet convention: the fix IS the default; the env var only turns it off.
    setPgPrimaryEnv();
    process.env.ROOSYNC_CHANNEL_SWEEP_BODYLESS = '0';
    mocks.wholeFails = false;

    await manager.cleanupExpiredMessages();

    expect(mocks.wholeCalls).toBe(1);
    expect((mocks.wholeOpts[0] as { bodyChars?: number }).bodyChars).toBeUndefined();
  });
});
