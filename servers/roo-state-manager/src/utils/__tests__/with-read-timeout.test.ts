/**
 * Direct unit tests for the shared `withReadTimeout` util (#828, Epic C3 #833).
 *
 * The util is exercised transitively by AttachmentManager.timeout.test.ts and
 * MessageManager.timeout.test.ts, but BOTH of those mock `fs.readFile` to
 * *never resolve* (simulating a GDrive cloud-only hang). That covers exactly
 * one arm of the race — the timeout wins → `null`. The transitive suites never
 * produce a promise that *rejects* (e.g. ENOENT / permission error before the
 * timeout), so the rejection-propagation contract is uncovered:
 *
 *     withReadTimeout(rejectingRead, 1000)  →  REJECTS with the read's error
 *                                              (NOT swallowed to `null`)
 *
 * That contract matters: MessageManager's inbox path feeds `withReadTimeout`
 * results into `Promise.allSettled`, which must see a *rejection* (not a
 * `null`) for its rejected-handler to log+skip a genuinely broken file
 * differently from a timed-out one. This suite pins that behavior plus the
 * timer-lifecycle guarantees (clearTimeout on both race exits, `.unref()` so a
 * hung read can't keep a short-lived process alive).
 *
 * Add-only, 0 source touched (#1936). Pure function over its args — no fs, no
 * logger, no mocks beyond timer spies.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withReadTimeout } from '../with-read-timeout.js';

describe('withReadTimeout — race semantics (real timers)', () => {
  // Short, real delays so the race is exercised deterministically without
  // slowing the suite. 30ms timeout / 0ms-or-never settle gives a clear winner.
  it('resolves with the promise value when it settles before the timeout', async () => {
    const result = await withReadTimeout(Promise.resolve('payload'), 30);
    expect(result).toBe('payload');
  });

  it('resolves null when the timeout fires before the promise settles', async () => {
    // A promise that never settles = the cloud-only hang shape.
    const hung = new Promise<string>(() => {});
    const result = await withReadTimeout(hung, 10);
    expect(result).toBeNull();
  });

  it('propagates the rejection when the promise rejects before the timeout (NOT swallowed to null)', async () => {
    // The contract that the transitive never-resolve suites cannot cover:
    // a read that genuinely errors (ENOENT etc.) must reject through, so
    // Promise.allSettled's rejected-handler sees a real rejection.
    const readError = new Error('ENOENT: no such file');
    await expect(withReadTimeout(Promise.reject(readError), 30)).rejects.toBe(readError);
  });

  it('resolves the value when both the promise and a racing value are present (winner = promise)', async () => {
    // Promise.race is fairness-agnostic; pin that a settling promise wins over
    // a timeout that has not yet fired. Resolving synchronously-microtask vs a
    // 20ms timeout guarantees the promise lands first.
    const result = await withReadTimeout(Promise.resolve(42), 20);
    expect(result).toBe(42);
  });
});

describe('withReadTimeout — timer lifecycle (mocked)', () => {
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;
  let clearTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears the timeout when the promise wins the race (no leaked timer)', async () => {
    // Fake timer so no real scheduling happens; the resolved promise wins the
    // race immediately, and `.finally` must clear the timer.
    const fakeTimer = { unref: vi.fn(), ref: vi.fn() };
    setTimeoutSpy.mockReturnValue(fakeTimer as unknown as ReturnType<typeof setTimeout>);

    await withReadTimeout(Promise.resolve('ok'), 1000);

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(fakeTimer);
  });

  it('clears the timeout when the promise rejects (cleanup on the reject path)', async () => {
    const fakeTimer = { unref: vi.fn(), ref: vi.fn() };
    setTimeoutSpy.mockReturnValue(fakeTimer as unknown as ReturnType<typeof setTimeout>);

    await expect(withReadTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');

    // The `.finally` runs on both resolve and reject exits — verify the reject
    // path also clears the timer so it can't fire late after a rejection.
    expect(clearTimeoutSpy).toHaveBeenCalledWith(fakeTimer);
  });

  it('unrefs the timer so a hung read does not keep the process alive', () => {
    const fakeTimer = { unref: vi.fn(), ref: vi.fn() };
    setTimeoutSpy.mockReturnValue(fakeTimer as unknown as ReturnType<typeof setTimeout>);

    // NOT awaited: the timeout executor runs synchronously when the inner
    // `new Promise(resolve => { timer = setTimeout(...) })` is constructed,
    // which happens before `Promise.race` even returns — so `unref` is invoked
    // by the time `withReadTimeout` returns. Awaiting would deadlock: the
    // mocked setTimeout never schedules its callback AND the never-settling
    // read never resolves, so the race would never settle.
    const pending = withReadTimeout(new Promise<string>(() => {}), 1000);
    void pending; // floating, harmless — fake timer schedules nothing
    expect(fakeTimer.unref).toHaveBeenCalledTimes(1);
  });
});
