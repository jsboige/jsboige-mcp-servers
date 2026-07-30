/**
 * #3012 bite-test — isLLMTimeoutError detects the SDK timeout the primary path throws.
 *
 * Root cause (verified firsthand against openai@4.x error.js): the primary condensation
 * call passes `{ timeout }` to the SDK (no AbortController), so a hung endpoint throws
 * `APIConnectionTimeoutError`. That subclass never assigns `this.name` → instances
 * inherit `Error.prototype.name = "Error"`. The old guard `error.name === 'AbortError'`
 * was therefore DEAD for the only timeout this path produces, and the #2267 "do NOT
 * retry a timeout" decision was never honored — a hung endpoint burned 3× full
 * CONDENSE_LLM_TIMEOUT_MS (~36 min) instead of failing fast.
 *
 * This test mords: `new APIConnectionTimeoutError(...).name === 'AbortError'` is false,
 * so the pre-fix expression returned `isTimeout = false` for the SDK timeout and the
 * retry guard fired. `isLLMTimeoutError` returns true via `instanceof`.
 *
 * @module tools/roosync/dashboard-timeout-guard.test
 */

import { describe, test, expect, vi } from 'vitest';
import { APIConnectionTimeoutError } from 'openai';
import { isLLMTimeoutError } from '../dashboard.js';

// tests/setup/jest.setup.js mocks 'openai' globally (only exposes OpenAI), which would
// make APIConnectionTimeoutError undefined here AND inside dashboard.js (so instanceof
// could never match). This test needs the REAL APIConnectionTimeoutError class to prove
// the instanceof check works. isLLMTimeoutError makes no network call, so unmocking
// 'openai' for this file is safe. A per-file vi.mock overrides the setup-file mock.
vi.mock('openai', async (importOriginal) => {
  return { ...(await importOriginal<typeof import('openai')>()) };
});

describe('isLLMTimeoutError — #3012', () => {
  test('APIConnectionTimeoutError (the SDK timeout) is detected as a timeout', () => {
    // The exact error the primary path throws on a hung endpoint.
    const sdkTimeout = new APIConnectionTimeoutError({ message: 'Request timed out' });

    // Bug repro: the pre-fix guard expression is false here — this is why #2267 was dead.
    expect(sdkTimeout instanceof Error && sdkTimeout.name === 'AbortError').toBe(false);
    // The SDK never sets this.name (inherits "Error"); constructor.name holds the type.
    expect(sdkTimeout.name).toBe('Error');
    expect(sdkTimeout.constructor.name).toBe('APIConnectionTimeoutError');

    // Fix: the helper matches on constructor.name (see isLLMTimeoutError JSDoc for why
    // not instanceof — the global test mock stubs 'openai' without the class).
    expect(isLLMTimeoutError(sdkTimeout)).toBe(true);
  });

  test('a genuine AbortController abort (error.name === "AbortError") is still detected', () => {
    // Retained for native fetch / browser paths that use an AbortController.
    const abortErr = new Error('The user aborted a request');
    abortErr.name = 'AbortError';
    expect(isLLMTimeoutError(abortErr)).toBe(true);
  });

  test('a non-timeout Error (429 / generic) is NOT a timeout → stays retryable', () => {
    expect(isLLMTimeoutError(new Error('something else'))).toBe(false);
    const rateLimit = new Error('Rate limit');
    rateLimit.name = 'RateLimitError';
    expect(isLLMTimeoutError(rateLimit)).toBe(false);
  });

  test('non-Error values are safe (no throw, returns false)', () => {
    expect(isLLMTimeoutError(null)).toBe(false);
    expect(isLLMTimeoutError(undefined)).toBe(false);
    expect(isLLMTimeoutError('string error')).toBe(false);
    expect(isLLMTimeoutError({ message: 'plain object' })).toBe(false);
  });
});
