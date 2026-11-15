/**
 * B16 (#4131) — process-wide channel PG breaker.
 *
 * Open on a read failure, sticky for N minutes (no PG probe, no G: fan-out),
 * half-open on the next call after the window, closed by a success.
 * Plus the #4731 background-sweep accounting: separate failure counter,
 * slow-sweep backoff (I4: threshold must be > 0), reminder own budget (W1).
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  channelPgBreakerOpen,
  channelPgBreakerState,
  channelPgReminderProbeDue,
  channelPgSweepSlow,
  noteChannelPgReadFailure,
  noteChannelPgReadSuccess,
  noteChannelPgReminderProbe,
  noteChannelPgSweepDeferred,
  noteChannelPgSweepDuration,
  resetChannelPgBreakerForTests,
} from '../channel-pg-breaker.js';

describe('channel-pg-breaker (#4131 B16)', () => {
  let savedMs: string | undefined;
  let savedSlowMs: string | undefined;

  beforeEach(() => {
    resetChannelPgBreakerForTests();
    savedMs = process.env.CHANNEL_PG_BREAKER_MS;
    process.env.CHANNEL_PG_BREAKER_MS = '60000';
    savedSlowMs = process.env.CHANNEL_PG_SWEEP_SLOW_MS;
    delete process.env.CHANNEL_PG_SWEEP_SLOW_MS;
  });

  afterEach(() => {
    resetChannelPgBreakerForTests();
    if (savedMs === undefined) delete process.env.CHANNEL_PG_BREAKER_MS;
    else process.env.CHANNEL_PG_BREAKER_MS = savedMs;
    if (savedSlowMs === undefined) delete process.env.CHANNEL_PG_SWEEP_SLOW_MS;
    else process.env.CHANNEL_PG_SWEEP_SLOW_MS = savedSlowMs;
  });

  test('closed by default; a failure opens it for the configured window', () => {
    const t0 = 1_000_000;
    expect(channelPgBreakerOpen(t0)).toBe(false);

    noteChannelPgReadFailure(t0);

    expect(channelPgBreakerOpen(t0 + 59_999)).toBe(true);
    expect(channelPgBreakerOpen(t0 + 60_000)).toBe(false); // window elapsed → half-open probe allowed
    expect(channelPgBreakerState(t0).trips).toBe(1);
  });

  test('repeated failures inside the window do not multiply trips', () => {
    const t0 = 2_000_000;
    noteChannelPgReadFailure(t0);
    noteChannelPgReadFailure(t0 + 1_000);
    expect(channelPgBreakerState(t0 + 2_000).trips).toBe(1);
  });

  test('a success closes the breaker', () => {
    const t0 = 3_000_000;
    noteChannelPgReadFailure(t0);
    expect(channelPgBreakerOpen(t0 + 10)).toBe(true);

    noteChannelPgReadSuccess();

    expect(channelPgBreakerOpen(t0 + 10)).toBe(false);
  });

  test('CHANNEL_PG_BREAKER_MS=0 disables the sticky window (probe every call)', () => {
    process.env.CHANNEL_PG_BREAKER_MS = '0';
    const t0 = 4_000_000;
    noteChannelPgReadFailure(t0);
    expect(channelPgBreakerOpen(t0)).toBe(false);
  });

  test('I4 (#4731) — CHANNEL_PG_SWEEP_SLOW_MS=0 is rejected: a 1 ms sweep is not slow', () => {
    process.env.CHANNEL_PG_SWEEP_SLOW_MS = '0'; // would arm the backoff on EVERY sweep
    const t0 = 5_000_000;
    noteChannelPgSweepDuration(1, t0);
    expect(channelPgSweepSlow(t0)).toBe(false);
    expect(channelPgBreakerState(t0).sweepSlow).toBe(false);
  });

  test('I4 (#4731) — negative CHANNEL_PG_SWEEP_SLOW_MS is rejected too', () => {
    process.env.CHANNEL_PG_SWEEP_SLOW_MS = '-5';
    const t0 = 5_500_000;
    noteChannelPgSweepDuration(1, t0);
    expect(channelPgSweepSlow(t0)).toBe(false);
  });

  test('a slow sweep (default 30 s threshold) arms the backoff for one trip window', () => {
    const t0 = 6_000_000;
    noteChannelPgSweepDuration(45_000, t0);
    expect(channelPgSweepSlow(t0 + 59_999)).toBe(true);
    expect(channelPgSweepSlow(t0 + 60_000)).toBe(false); // window elapsed (BREAKER_MS=60000)
    expect(channelPgBreakerState(t0).lastSweepDurationMs).toBe(45_000);
  });

  test('W1 (#4731) — reminder own budget: due before any probe, not due right after, due again after 2× trip', () => {
    const t0 = 7_000_000; // budget default = 2 × 60000 = 120000
    expect(channelPgReminderProbeDue(t0)).toBe(true); // never probed
    noteChannelPgReminderProbe(t0);
    expect(channelPgReminderProbeDue(t0 + 119_999)).toBe(false);
    expect(channelPgReminderProbeDue(t0 + 120_000)).toBe(true);
    expect(channelPgBreakerState(t0).reminderLastProbeAt).toBe(t0);
  });

  test('W1 (#4731) — sweep deferrals are counted per kind (measurement)', () => {
    noteChannelPgSweepDeferred('cleanup');
    noteChannelPgSweepDeferred('cleanup');
    noteChannelPgSweepDeferred('reminder');
    const s = channelPgBreakerState();
    expect(s.cleanupDeferred).toBe(2);
    expect(s.reminderDeferred).toBe(1);
  });
});
