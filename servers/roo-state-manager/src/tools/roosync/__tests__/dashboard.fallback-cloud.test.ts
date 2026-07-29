/**
 * #2719 — Cloud fallback condensation telemetry.
 *
 * The cloud fallback client (`getFallbackChatOpenAIClient` / `cloudCondenseOnce`)
 * was implemented in a prior PR but the top-level `CondenseAttemptInfo.outcome`
 * did not distinguish a condensation *salvaged by the cloud* from a clean primary
 * success — both were labelled `'condensed'`. Acceptance criterion #2 of #2719
 * requires the telemetry to distinguish `fallback-cloud` from `fallback-truncated`.
 *
 * This file covers the three acceptance paths (#2719 criterion #6 a/b/c):
 *   (a) primary down → cloud fallback succeeds → outcome `fallback-cloud`
 *   (b) primary down AND cloud down → outcome `fallback-truncated` (graceful degradation)
 *   (c) primary ok → outcome `condensed` (fallback NOT flagged as used)
 *
 * The existing `dashboard.test.ts` suite mocks `getFallbackChatOpenAIClient: () => null`
 * (inert), so it never exercises the fallback-success path — hence a dedicated file.
 *
 * @module tools/roosync/__tests__/dashboard.fallback-cloud
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { roosyncDashboard, resetCondenseCircuitBreaker, isRetryableFallbackError } from '../dashboard.js';

// Primary chat client + create — lazy indirection so each test can swap behaviour.
const mockPrimaryCreate = vi.fn();
const mockGetPrimaryClient = vi.fn();
// Fallback (cloud) chat client + create.
const mockFallbackCreate = vi.fn();
const mockGetFallbackClient = vi.fn();

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetPrimaryClient(),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-primary-model',
  // #2719: per-test configurable via mockGetFallbackClient (null = inert, like prod-unprovisioned).
  getFallbackChatOpenAIClient: () => mockGetFallbackClient(),
  getFallbackLLMModelId: () => 'glm-4.7-flash',
}));

const testTmpBase = path.join(os.tmpdir(), 'dashboard-fallback-cloud-');

describe('#2719 cloud-fallback condensation telemetry', () => {
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
    // Default: primary unavailable, no fallback configured (inert).
    mockGetPrimaryClient.mockImplementation(() => { throw new Error('No chat API key configured'); });
    mockPrimaryCreate.mockReset();
    mockGetFallbackClient.mockImplementation(() => null);
    mockFallbackCreate.mockReset();
    resetCondenseCircuitBreaker();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  /**
   * Fill the dashboard past the 92% preemptive-condense threshold until a
   * condensation pass fires, returning the first result that condensed.
   * Each message is ~3 KB; ~16 messages reliably cross the 50 KB dashboard cap.
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

  it('(a) primary down → cloud fallback succeeds → outcome `fallback-cloud` (#2719 criterion #2/#6a)', async () => {
    // Primary client present but its create rejects (vLLM endpoint down).
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockRejectedValue(new Error('vLLM 192.168.0.47:5002 connection refused'));
    // Cloud fallback client present + its create resolves with a real summary.
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    mockFallbackCreate.mockResolvedValue({
      choices: [{ message: { content: '## Cloud summary\n\nArchived traffic salvaged by z.ai.' } }],
    });

    const condensedResult = await fillUntilCondensed();

    expect(condensedResult.condenseDiagnostic).toBeDefined();
    const cloudPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-cloud',
    );
    expect(cloudPasses.length).toBeGreaterThanOrEqual(1);
    // The fallback client must actually have been called.
    expect(mockFallbackCreate).toHaveBeenCalled();
    // And the per-call stats must record the fallback was used.
    for (const pass of cloudPasses) {
      expect(pass.llm).toBeDefined();
      const usedFallback = pass.llm.summary?.fallbackUsed === true || pass.llm.status?.fallbackUsed === true;
      expect(usedFallback).toBe(true);
    }
  });

  it('(b) primary down AND cloud down → outcome `fallback-truncated` (graceful degradation, #2719 criterion #6b)', async () => {
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockRejectedValue(new Error('vLLM down'));
    // Cloud fallback client present but its create ALSO rejects.
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    mockFallbackCreate.mockRejectedValue(new Error('z.ai 503 unavailable'));

    const condensedResult = await fillUntilCondensed();

    expect(condensedResult.condenseDiagnostic).toBeDefined();
    const truncatedPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-truncated',
    );
    expect(truncatedPasses.length).toBeGreaterThanOrEqual(1);
    // No pass should be labelled fallback-cloud when the cloud also failed.
    const cloudPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-cloud',
    );
    expect(cloudPasses).toHaveLength(0);
  });

  it('(c) primary ok → outcome `condensed` (fallback NOT flagged, #2719 criterion #6c)', async () => {
    // Primary succeeds — the cloud client is configured but must NOT be used.
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockResolvedValue({
      choices: [{ message: { content: '## Primary summary\n\nCondensed by local vLLM.' } }],
    });
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });

    const condensedResult = await fillUntilCondensed();

    expect(condensedResult.condenseDiagnostic).toBeDefined();
    const condensedPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'condensed',
    );
    expect(condensedPasses.length).toBeGreaterThanOrEqual(1);
    // The fallback client was available but the primary succeeded, so it stays idle.
    expect(mockFallbackCreate).not.toHaveBeenCalled();
    // No condensed pass should be mislabelled as fallback-cloud.
    const cloudPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-cloud',
    );
    expect(cloudPasses).toHaveLength(0);
  });

  // #2998 Fix A: Retry on 429 — the fallback endpoint intermittently returns 429
  // (rate limit). The first attempt fails with 429, the second succeeds. Without
  // retry, this would be `fallback-truncated`. With retry, it should be `fallback-cloud`.
  it('(d) #2998 primary down → fallback 429 then 200 → outcome `fallback-cloud` (retry works)', async () => {
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockRejectedValue(new Error('vLLM down'));
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    // First fallback attempt(s): 429 (rate limited). Subsequent: success.
    // Two LLM calls (summary + status) run concurrently, each with its own retry loop,
    // so the first N calls may all get 429 before the retry succeeds.
    const error429 = Object.assign(new Error('429 Rate Limited — code 1305'), { status: 429 });
    mockFallbackCreate
      .mockRejectedValueOnce(error429)
      .mockResolvedValue({
        choices: [{ message: { content: '## Cloud summary (after retry)\n\nSalvaged by z.ai on 2nd attempt.' } }],
      });

    const condensedResult = await fillUntilCondensed();

    expect(condensedResult.condenseDiagnostic).toBeDefined();
    const cloudPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-cloud',
    );
    expect(cloudPasses.length).toBeGreaterThanOrEqual(1);
    // The fallback client must have been called at least twice (first 429, then 200).
    expect(mockFallbackCreate.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // #2998 Fix A: No retry on 401 (auth errors don't heal with backoff).
  it('(e) #2998 primary down → fallback 401 → single attempt, no retry', async () => {
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockRejectedValue(new Error('vLLM down'));
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    // 401 auth error — should NOT be retried.
    const error401 = Object.assign(new Error('401 Unauthorized'), { status: 401 });
    mockFallbackCreate.mockRejectedValue(error401);

    const condensedResult = await fillUntilCondensed();

    expect(condensedResult.condenseDiagnostic).toBeDefined();
    const truncatedPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-truncated',
    );
    expect(truncatedPasses.length).toBeGreaterThanOrEqual(1);
    // The fallback client should have been called exactly ONCE per condensation pass
    // (401 is not retryable). Each condense pass makes 2 LLM calls (summary + status),
    // so verify that each individual call site only invoked once by checking there's
    // no retry doubling. At least 1 call happened, and less than 6 (= 2 calls × 3 retries).
    expect(mockFallbackCreate.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mockFallbackCreate.mock.calls.length).toBeLessThan(6);
  });

  // #2998 Fix B: When fallback fails, diagnostic stats must include
  // fallbackAttempted + fallbackError so operators can distinguish "unconfigured"
  // from "attempted but rejected".
  it('(f) #2998 primary down AND fallback 429 (all retries) → diagnostic shows fallbackAttempted', async () => {
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockRejectedValue(new Error('vLLM down'));
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    // All fallback attempts fail with 429.
    const error429 = Object.assign(new Error('429 Rate Limited'), { status: 429 });
    mockFallbackCreate.mockRejectedValue(error429);

    const condensedResult = await fillUntilCondensed();

    expect(condensedResult.condenseDiagnostic).toBeDefined();
    const truncatedPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-truncated',
    );
    expect(truncatedPasses.length).toBeGreaterThanOrEqual(1);

    // #2998 Fix B: At least one truncated pass must surface the fallback attempt in stats.
    const passesWithFallbackAttempt = truncatedPasses.filter((d: any) => {
      const s = d.llm?.summary;
      const st = d.llm?.status;
      return (s?.fallbackAttempted === true || st?.fallbackAttempted === true);
    });
    expect(passesWithFallbackAttempt.length).toBeGreaterThanOrEqual(1);

    // And the fallbackError must be set (not undefined).
    const passesWithFallbackError = passesWithFallbackAttempt.filter((d: any) => {
      const s = d.llm?.summary;
      const st = d.llm?.status;
      return (s?.fallbackError && typeof s.fallbackError === 'string')
        || (st?.fallbackError && typeof st.fallbackError === 'string');
    });
    expect(passesWithFallbackError.length).toBeGreaterThanOrEqual(1);
  });

  // #3011: A timeout must NOT be retried. A hung endpoint won't recover in a 2-8s
  // backoff — retrying burns another full FALLBACK_TIMEOUT_MS (3×30s = ~90s today).
  // Mirrors the primary's #2267 rule. Bite-test: pre-fix, a timeout (no .status) was
  // classified retryable and retried 3×; post-fix it is non-retryable → single attempt.
  it('(g) #3011 primary down → fallback timeout (APIConnectionTimeoutError) → single attempt, no retry', async () => {
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockRejectedValue(new Error('vLLM down'));
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    // OpenAI SDK client-timeout expiry: APIConnectionTimeoutError (no .status).
    const timeoutErr = Object.assign(new Error('Request timed out'), {
      name: 'APIConnectionTimeoutError',
    });
    mockFallbackCreate.mockRejectedValue(timeoutErr);

    const condensedResult = await fillUntilCondensed();

    expect(condensedResult.condenseDiagnostic).toBeDefined();
    const truncatedPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-truncated',
    );
    expect(truncatedPasses.length).toBeGreaterThanOrEqual(1);
    // Bite: the timeout must land in the NON-retryable regime (like 401, test e),
    // not the retryable regime (like 429, test d). Each condensation pass makes up
    // to 2 LLM calls (summary + status); pre-fix each would retry 3× → ≥6 calls per
    // pass. Post-fix each attempts once → ≤2 per pass. Asserting < 4 separates the
    // two regimes unambiguously (2 post-fix < 4 < 6 pre-fix).
    expect(mockFallbackCreate.mock.calls.length).toBeLessThan(4);
    expect(mockFallbackCreate.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// #3011: Direct classification tests. The integration test (g) proves end-to-end
// behaviour, but the call-count boundary can be muddied by concurrent condensation
// passes. These assert the classifier itself, unambiguously.
describe('#3011 isRetryableFallbackError classification', () => {
  it('retries 429 (rate limit)', () => {
    const err = Object.assign(new Error('429 Rate Limited'), { status: 429 });
    expect(isRetryableFallbackError(err)).toBe(true);
  });

  it('retries 5xx (server error)', () => {
    const err = Object.assign(new Error('503 Service Unavailable'), { status: 503 });
    expect(isRetryableFallbackError(err)).toBe(true);
  });

  it('does NOT retry 401 (auth — will not heal with backoff)', () => {
    const err = Object.assign(new Error('401 Unauthorized'), { status: 401 });
    expect(isRetryableFallbackError(err)).toBe(false);
  });

  // Bite-test: pre-fix this returned `true` (timeout has no .status → retryable).
  it('#3011 does NOT retry APIConnectionTimeoutError (hung endpoint)', () => {
    const err = Object.assign(new Error('Request timed out'), {
      name: 'APIConnectionTimeoutError',
    });
    expect(isRetryableFallbackError(err)).toBe(false);
  });

  it('#3011 does NOT retry AbortError (fetch abort)', () => {
    const err = Object.assign(new Error('The user aborted a request'), {
      name: 'AbortError',
    });
    expect(isRetryableFallbackError(err)).toBe(false);
  });

  // #3011 guard: a failed-FAST connection (ECONNREFUSED, no .status, plain Error
  // name) stays retryable — it rejects immediately so the retry is cheap.
  it('retries ECONNREFUSED (failed-fast connection)', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:5002');
    expect(isRetryableFallbackError(err)).toBe(true);
  });
});
