/**
 * #3012 — Primary-path timeout detection (the #2267 guard that never fired).
 *
 * The condensation primary path passes `{ timeout: ms }` to the OpenAI SDK and
 * has NO `AbortController`. On a hung endpoint the SDK throws
 * `APIConnectionTimeoutError`, whose `.name` inherits `"Error"` (the SDK never
 * sets `this.name`). The previous guard tested `error.name === 'AbortError'`,
 * which is unreachable on this path — so every real timeout was retried 3×
 * (~3 × CONDENSE_LLM_TIMEOUT_MS = ~36 min per call) before falling back to
 * truncation, instead of failing fast as #2267 intended.
 *
 * Acceptance criteria (per issue #3012):
 *   - The bite-test MUST construct the error with the real SDK class
 *     (`new APIConnectionTimeoutError({})`), not a synthetic
 *     `Object.assign(new Error(...), { name: 'APIConnectionTimeoutError' })`.
 *     The synthetic form is the mirror image of the real one on `.name` and
 *     would pass on dead code — exactly the trap that let PR #931 ship green
 *     without fixing its defect.
 *   - The test MUST observe exactly 1 attempt per LLM pass on the post-fix
 *     code (was 3 pre-fix).
 *
 * @module tools/roosync/__tests__/dashboard-timeout-guard
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// #3012 bite-test: the global setup (jest.setup.js) mocks `openai` without
// exporting `APIConnectionTimeoutError`. Override the mock HERE with
// importOriginal so this file gets the real SDK class for constructing test
// errors. The @/services/openai mock still intercepts client construction;
// no real OpenAI client is instantiated. This override is scoped to THIS file
// only — other test files keep the simpler global mock.
vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>();
  return { ...actual };
});

// REAL SDK class — not a synthetic stand-in. This is the whole point of #3012.
// Verifiable: `new APIConnectionTimeoutError({}).name === "Error"`, but
// `constructor.name === "APIConnectionTimeoutError"`.
import { APIConnectionTimeoutError } from 'openai';
import { roosyncDashboard, resetCondenseCircuitBreaker } from '../dashboard.js';

const mockPrimaryCreate = vi.fn();
const mockGetPrimaryClient = vi.fn();

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetPrimaryClient(),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-primary-model',
  // Cloud fallback explicitly inert — we are testing the PRIMARY path's retry
  // behavior. A configured fallback would salvage the pass and mask the retry
  // count, defeating the bite-test.
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

const testTmpBase = path.join(os.tmpdir(), 'dashboard-timeout-guard-');

describe('#3012 primary-path timeout guard — APIConnectionTimeoutError', { testTimeout: 30000 }, () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_API_BASE_URL;
    // Primary client present; create() rejects with the REAL SDK timeout class.
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockReset();
    mockPrimaryCreate.mockRejectedValue(new APIConnectionTimeoutError({}));
    resetCondenseCircuitBreaker();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  /**
   * Drive the dashboard past the 92% preemptive-condense threshold so a
   * condensation pass fires. Each message is ~3 KB; ~16 messages reliably
   * cross the 50 KB cap.
   */
  async function fillUntilCondensed(): Promise<any> {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    const filler = 'X'.repeat(3000);
    let condensedResult: any = null;
    for (let i = 0; i < 20; i++) {
      const result = await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: `${filler} message-${i}`,
      });
      if ((result as any).condensed && !condensedResult) {
        condensedResult = result;
      }
    }
    expect(condensedResult).not.toBeNull();
    return condensedResult;
  }

  it('fails fast on SDK timeout (1 attempt per LLM pass, not 3)', async () => {
    const condensedResult = await fillUntilCondensed();

    // Sanity: a condensation pass did fire and produced diagnostics.
    expect(condensedResult.condenseDiagnostic).toBeDefined();
    const passes = condensedResult.condenseDiagnostic!;
    expect(passes.length).toBeGreaterThanOrEqual(1);

    // The primary create() must be called exactly ONCE per LLM pass.
    // Pre-fix code retried 3× per pass (the #2267 guard was dead), so this
    // assertion is the bite-test: it fails on the pre-fix code with
    // `expected 3, got N` where N ≥ 3.
    for (const pass of passes) {
      // Each pass invokes generateLLMSummary + generateStatusUpdate. Each of
      // those should call the primary create() exactly once on timeout before
      // bailing out (no retry).
      // The per-pass attempt count is surfaced in the LLM stats; if the stats
      // are unavailable, fall back to the global mock call count divided by
      // the number of passes.
      const summaryAttempts = pass.llm?.summary?.attempts;
      const statusAttempts = pass.llm?.status?.attempts;
      if (typeof summaryAttempts === 'number') {
        expect(summaryAttempts).toBe(1);
      }
      if (typeof statusAttempts === 'number') {
        expect(statusAttempts).toBe(1);
      }
    }

    // Global assertion: total primary create() calls should equal the number
    // of LLM passes × 2 (summary + status), NOT passes × 2 × 3.
    // This is the strongest form of the bite-test — if the guard is dead,
    // the count is 3× higher.
    const expectedCallCount = passes.length * 2;
    expect(mockPrimaryCreate.mock.calls.length).toBeLessThanOrEqual(expectedCallCount);
    // And at least one call must have happened (sanity).
    expect(mockPrimaryCreate.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('records timeout outcome in diagnostic (not generic error)', async () => {
    const condensedResult = await fillUntilCondensed();

    const passes = condensedResult.condenseDiagnostic!;
    // At least one pass must surface a timeout signal. Pre-fix code recorded
    // these as generic 'error' because isTimeout was always false.
    const timeoutSignals = passes.filter((p: any) => {
      const s = p.llm?.summary;
      const st = p.llm?.status;
      return (
        s?.finalOutcome === 'timeout' ||
        st?.finalOutcome === 'timeout' ||
        (typeof s?.timeoutCount === 'number' && s.timeoutCount > 0) ||
        (typeof st?.timeoutCount === 'number' && st.timeoutCount > 0)
      );
    });
    expect(timeoutSignals.length).toBeGreaterThanOrEqual(1);
  });

  it('distinguishes SDK timeout from generic 502 error (502 still retries)', async () => {
    // A 502-like error (HTTP status 502) must NOT be classified as a timeout.
    // The timeout guard only applies to APIConnectionTimeoutError / AbortError.
    // This locks in criterion: "Aucun autre comportement de retry modifié
    // (502 / contenu vide continuent de réessayer)".
    const http502 = Object.assign(new Error('HTTP 502 Bad Gateway'), { status: 502 });
    mockPrimaryCreate.mockRejectedValue(http502);

    const condensedResult = await fillUntilCondensed();

    const passes = condensedResult.condenseDiagnostic!;
    // The 502 path should have retried (3 attempts per pass), NOT fast-failed.
    // This verifies the timeout guard didn't accidentally swallow 502s.
    const retriedPasses = passes.filter((p: any) => {
      const s = p.llm?.summary;
      const st = p.llm?.status;
      return (
        (typeof s?.attempts === 'number' && s.attempts > 1) ||
        (typeof st?.attempts === 'number' && st.attempts > 1)
      );
    });
    expect(retriedPasses.length).toBeGreaterThanOrEqual(1);
  });

  it('AbortError (legacy signal path) still classified as timeout', async () => {
    // Even though no current call site produces AbortError on the primary path,
    // the legacy detection must remain functional so a future `signal`
    // introduction doesn't silently regress.
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    mockPrimaryCreate.mockRejectedValue(abortErr);

    const condensedResult = await fillUntilCondensed();

    const passes = condensedResult.condenseDiagnostic!;
    const timeoutSeen = passes.some((p: any) => {
      const s = p.llm?.summary;
      const st = p.llm?.status;
      return (
        s?.finalOutcome === 'timeout' ||
        st?.finalOutcome === 'timeout' ||
        (typeof s?.timeoutCount === 'number' && s.timeoutCount > 0) ||
        (typeof st?.timeoutCount === 'number' && st.timeoutCount > 0)
      );
    });
    expect(timeoutSeen).toBe(true);
  });
});
