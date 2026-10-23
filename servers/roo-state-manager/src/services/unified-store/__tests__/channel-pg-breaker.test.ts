/**
 * B16 (#4131) — process-wide channel PG breaker.
 *
 * Open on a read failure, sticky for N minutes (no PG probe, no G: fan-out),
 * half-open on the next call after the window, closed by a success.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  channelPgBreakerOpen,
  channelPgBreakerState,
  noteChannelPgReadFailure,
  noteChannelPgReadSuccess,
  resetChannelPgBreakerForTests,
} from '../channel-pg-breaker.js';

describe('channel-pg-breaker (#4131 B16)', () => {
  let savedMs: string | undefined;

  beforeEach(() => {
    resetChannelPgBreakerForTests();
    savedMs = process.env.CHANNEL_PG_BREAKER_MS;
    process.env.CHANNEL_PG_BREAKER_MS = '60000';
  });

  afterEach(() => {
    resetChannelPgBreakerForTests();
    if (savedMs === undefined) delete process.env.CHANNEL_PG_BREAKER_MS;
    else process.env.CHANNEL_PG_BREAKER_MS = savedMs;
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
});
