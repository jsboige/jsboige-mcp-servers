/**
 * #1130 — Non-retryable auth errors (401/403) fail fast on the condensation
 * primary, instead of burning LLM_MAX_RETRIES (~3 × CONDENSE_LLM_TIMEOUT_MS per
 * pass) on a call that cannot heal before the cloud fallback.
 *
 * The fix reuses the fallback's classifier (`isRetryableFallbackError`) on the
 * primary retry guard: a 401/403 → cloud fallback on attempt 1; transient
 * (429/5xx) and connection-class errors still retry as before (the #3012
 * timeout guard and the #2267 follow-up are preserved by the same predicate).
 *
 * Acceptance (per ai-01 review, 08/09): the bite-test MUST redden when the two
 * dashboard.ts guard lines are reverted. Pre-fix, a 401 kept the
 * `!isTimeout && attempt < LLM_MAX_RETRIES` branch alive → 3 attempts per LLM
 * pass; post-fix → 1. This mirrors the #3012 timeout harness, which is why the
 * same `fillUntilCondensed` / `mockPrimaryCreate` machinery is used here.
 *
 * @module tools/roosync/__tests__/dashboard-failfast-auth
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { roosyncDashboard, resetCondenseCircuitBreaker } from '../dashboard.js';

const mockPrimaryCreate = vi.fn();
const mockGetPrimaryClient = vi.fn();

// Cloud fallback deliberately inert — we are testing the PRIMARY path's retry
// behavior. A configured fallback would salvage the pass and mask the retry
// count, defeating the bite-test (same rationale as the #3012 harness).
vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetPrimaryClient(),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-primary-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

const testTmpBase = path.join(os.tmpdir(), 'dashboard-failfast-auth-');

describe('#1130 non-retryable auth error (401) fails fast on the primary', { testTimeout: 30000 }, () => {
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
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockReset();
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
   * condensation pass fires (copied from the #3012 harness). Each message is
   * ~3 KB; ~16 messages reliably cross the cap.
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

  it('fails fast on a 401 (1 attempt per LLM pass, not 3)', async () => {
    // A non-retryable auth error with an HTTP status. isRetryableFallbackError
    // must classify this as NOT retryable (401 is neither 429 nor >=500), so the
    // primary bails on attempt 1 and falls back.
    const http401 = Object.assign(new Error('HTTP 401 Unauthorized'), { status: 401 });
    mockPrimaryCreate.mockRejectedValue(http401);

    const condensedResult = await fillUntilCondensed();

    expect(condensedResult.condenseDiagnostic).toBeDefined();
    const passes = condensedResult.condenseDiagnostic!;
    expect(passes.length).toBeGreaterThanOrEqual(1);

    // The BITE-TEST: pre-fix code retried 3× per pass (the !isTimeout branch
    // stayed alive for a 401), so this assertion fails with `expected 1, got 3`.
    for (const pass of passes) {
      const summaryAttempts = pass.llm?.summary?.attempts;
      const statusAttempts = pass.llm?.status?.attempts;
      if (typeof summaryAttempts === 'number') {
        expect(summaryAttempts).toBe(1);
      }
      if (typeof statusAttempts === 'number') {
        expect(statusAttempts).toBe(1);
      }
    }

    // Global assertion: total primary create() calls should equal the number of
    // LLM passes × 2 (summary + status), NOT passes × 2 × 3. Strongest form of
    // the bite-test — if the guard is dead, the count is 3× higher.
    const expectedCallCount = passes.length * 2;
    expect(mockPrimaryCreate.mock.calls.length).toBeLessThanOrEqual(expectedCallCount);
    expect(mockPrimaryCreate.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('still retries a transient 429 (unchanged retryable path)', async () => {
    // A 429 is retryable (status 429 → isRetryableFallbackError true) and must
    // NOT be swallowed by the auth fail-fast. This locks the boundary of #1130:
    // only non-retryable statuses change behavior.
    const http429 = Object.assign(new Error('HTTP 429 Too Many Requests'), { status: 429 });
    mockPrimaryCreate.mockRejectedValue(http429);

    const condensedResult = await fillUntilCondensed();

    const passes = condensedResult.condenseDiagnostic!;
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
});
