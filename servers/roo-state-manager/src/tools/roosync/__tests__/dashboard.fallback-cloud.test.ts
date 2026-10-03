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
 * 2026-09-19 (po-2024 discriminant spec, po-2027 datapoint): (h)/(i) extend the
 * frontmatter discriminant — an empty 200 body is stamped 'empty-content' (no longer
 * the null "unconfigured" shape), and a pass salvaged on ONE call by the cloud reads
 * 'no-fallback-failure-captured' instead of 'not-attempted-or-unconfigured'.
 *
 * @module tools/roosync/__tests__/dashboard.fallback-cloud
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { roosyncDashboard, resetCondenseCircuitBreaker, isRetryableFallbackError } from '../dashboard.js';

// #3011 second tour: import the REAL SDK timeout class so the bite-test constructs the
// exact error the fallback path throws on a hung endpoint. The global test setup
// (tests/setup/jest.setup.js) mocks 'openai' (overriding OpenAI); this per-file override
// restores the real exports so APIConnectionTimeoutError is the genuine class — the only
// shape that proves the classifier works on a production error (mirrors #932's pattern).
import { APIConnectionTimeoutError } from 'openai';
vi.mock('openai', async (importOriginal) => {
  return { ...(await importOriginal<typeof import('openai')>()) };
});

// Primary chat client + create — lazy indirection so each test can swap behaviour.
const mockPrimaryCreate = vi.fn();
const mockGetPrimaryClient = vi.fn();
// Fallback (cloud) chat client + create.
const mockFallbackCreate = vi.fn();
const mockGetFallbackClient = vi.fn();
// #2719 (22/09): the model chain reads FALLBACK_LLM_MODEL_ID through this getter.
const mockFallbackModelId = vi.fn(() => 'glm-4.7-flash');

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetPrimaryClient(),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-primary-model',
  // #2719: per-test configurable via mockGetFallbackClient (null = inert, like prod-unprovisioned).
  getFallbackChatOpenAIClient: () => mockGetFallbackClient(),
  getFallbackLLMModelId: () => mockFallbackModelId(),
}));

const testTmpBase = path.join(os.tmpdir(), 'dashboard-fallback-cloud-');

// NOTE on the suite option below: it must be `timeout`, NOT `testTimeout` —
// vitest 3 suite options silently ignore an unknown `testTimeout` key, so the
// 30s ceiling declared here was never in effect and the unit config's 15s
// applied instead. Test (b) alone runs ~15s of deliberate backoff (primary +
// cloud retry storms, 2s+4s twice) — knife-edge at 15s. Key fixed 2026-09-19
// alongside tests (h)/(i) so the suite runs under its intended envelope.
describe('#2719 cloud-fallback condensation telemetry', { timeout: 30000 }, () => {
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
    mockFallbackModelId.mockImplementation(() => 'glm-4.7-flash');
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

    // #2719 observability (2026-09-03): the fallback archive frontmatter must
    // identify the condensing machine and the cloud-fallback outcome so fleet
    // truncation datapoints are attributable without machine-local logs.
    const archiveFiles = await readdir(path.join(tmpDir, 'dashboards', 'archive'));
    const fallbackArchives = archiveFiles.filter(f => f.endsWith('-fallback.md'));
    expect(fallbackArchives.length).toBeGreaterThanOrEqual(1);
    const archiveContent = await readFile(
      path.join(tmpDir, 'dashboards', 'archive', fallbackArchives[0]),
      'utf8',
    );
    expect(archiveContent).toContain('condensedBy: test-machine');
    expect(archiveContent).toContain('fallbackError:');
    // The cloud create rejected with 'z.ai 503 unavailable' — the archive must
    // carry that error, distinguishing "attempted but rejected" from "unconfigured".
    expect(archiveContent).toContain('z.ai 503 unavailable');
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
  // backoff — retrying burns another full FALLBACK_TIMEOUT_MS (3×120s ≈ 6 min at the #3016 default).
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
    // OpenAI SDK client-timeout expiry: the REAL APIConnectionTimeoutError class
    // (no .status; .name="Error", constructor.name="APIConnectionTimeoutError").
    const timeoutErr = new APIConnectionTimeoutError({ message: 'Request timed out' });
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

  // #2719 discriminant fix (2026-09-19, po-2024 spec — po-2027 datapoint 2026-09-07):
  // a 200 with EMPTY completion content used to return the null "unconfigured" shape,
  // so the archive frontmatter read 'not-attempted-or-unconfigured' while the cloud
  // WAS configured and HAD answered. It must now be stamped as a non-retryable
  // 'empty-content' error so fleet datapoints stop conflating the two states.
  it('(h) #2719 primary down → fallback 200 with empty content → archive stamps empty-content', async () => {
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockRejectedValue(new Error('vLLM down'));
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    // HTTP 200 but no completion content (e.g. a reasoning model burning the whole
    // max_tokens budget in reasoning_content — the glm-4.7-flash behaviour
    // documented in #2719 c.12).
    mockFallbackCreate.mockResolvedValue({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
    });

    const condensedResult = await fillUntilCondensed();

    expect(condensedResult.condenseDiagnostic).toBeDefined();
    const truncatedPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-truncated',
    );
    expect(truncatedPasses.length).toBeGreaterThanOrEqual(1);

    // Per-call stats must carry the stamped fallback error (mirrors test f's shape).
    const passesWithEmptyContent = truncatedPasses.filter((d: any) => {
      const s = d.llm?.summary;
      const st = d.llm?.status;
      return s?.fallbackAttempted === true && typeof s.fallbackError === 'string' && s.fallbackError.startsWith('empty-content')
        || st?.fallbackAttempted === true && typeof st.fallbackError === 'string' && st.fallbackError.startsWith('empty-content');
    });
    expect(passesWithEmptyContent.length).toBeGreaterThanOrEqual(1);

    // The archive frontmatter must NOT read 'not-attempted-or-unconfigured' — the
    // cloud was configured and answered (200, empty body).
    const archiveFiles = await readdir(path.join(tmpDir, 'dashboards', 'archive'));
    const fallbackArchives = archiveFiles.filter(f => f.endsWith('-fallback.md'));
    expect(fallbackArchives.length).toBeGreaterThanOrEqual(1);
    const archiveContent = await readFile(
      path.join(tmpDir, 'dashboards', 'archive', fallbackArchives[0]),
      'utf8',
    );
    expect(archiveContent).not.toContain('not-attempted-or-unconfigured');
    expect(archiveContent).toContain('empty-content (HTTP 200');
  });

  // #2719 discriminant fix, second half: when one call of the pass is SALVAGED by
  // the cloud (`fallbackUsed` — never stamped `fallbackAttempted`) while the other
  // call has no fallback marker at all, the frontmatter must not claim
  // 'not-attempted-or-unconfigured' — the cloud just worked for the other call.
  // This is the exact po-2027 signature (summary salvaged by gpt-5-mini, status
  // failed → archive said "not attempted"). Reproduced here by arming the fallback
  // client for exactly one of the two concurrent LLM calls.
  it('(i) #2719 one call salvaged by cloud, other call without fallback → archive says no-fallback-failure-captured', async () => {
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockRejectedValue(new Error('vLLM down'));
    const okClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '## Cloud summary\n\nSalvaged by the cloud on one call.' } }],
          }),
        },
      },
    };
    // Whichever LLM call (summary/status) reaches cloudCondenseOnce FIRST gets a
    // working cloud client; the other sees it unconfigured (null → no marker).
    // Either race order yields the same archive discriminant: exactly one call
    // with fallbackUsed, none with fallbackAttempted.
    mockGetFallbackClient
      .mockImplementationOnce(() => okClient)
      .mockImplementation(() => null);

    const condensedResult = await fillUntilCondensed();

    expect(condensedResult.condenseDiagnostic).toBeDefined();
    const truncatedPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-truncated',
    );
    expect(truncatedPasses.length).toBeGreaterThanOrEqual(1);

    // The po-2027 signature on the truncated pass: one call salvaged (fallbackUsed),
    // none marked fallbackAttempted.
    const mixedPasses = truncatedPasses.filter((d: any) => {
      const used = d.llm?.summary?.fallbackUsed === true || d.llm?.status?.fallbackUsed === true;
      const attempted = d.llm?.summary?.fallbackAttempted === true || d.llm?.status?.fallbackAttempted === true;
      return used && !attempted;
    });
    expect(mixedPasses.length).toBeGreaterThanOrEqual(1);

    // And the archive must carry the new discriminant, not the mislabel.
    const archiveFiles = await readdir(path.join(tmpDir, 'dashboards', 'archive'));
    const fallbackArchives = archiveFiles.filter(f => f.endsWith('-fallback.md'));
    expect(fallbackArchives.length).toBeGreaterThanOrEqual(1);
    const archiveContent = await readFile(
      path.join(tmpDir, 'dashboards', 'archive', fallbackArchives[0]),
      'utf8',
    );
    expect(archiveContent).not.toContain('not-attempted-or-unconfigured');
    expect(archiveContent).toContain('no-fallback-failure-captured');
  });

  // #2719 (22/09, fleet escalation): the primary's circuit breaker used to skip EVERY
  // LLM call, cloud tier included — a sustained primary outage (exactly when the
  // fallback is needed) ended in truncation stamped 'not-attempted-or-unconfigured'.
  it('(j) #2719 primary circuit breaker OPEN → primary skipped, cloud tier still tried', { timeout: 90000 }, async () => {
    // Phase 1: primary down, cloud unconfigured → failing passes open the breaker.
    for (let i = 0; i < 4; i++) {
      await fillUntilCondensed();
    }
    // Phase 2: breaker open. Arm the cloud; the primary would now SUCCEED if called,
    // so any 'condensed' outcome would prove it was not skipped.
    mockGetPrimaryClient.mockReset();
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockResolvedValue({
      choices: [{ message: { content: '## Primary summary' } }],
    });
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    mockFallbackCreate.mockResolvedValue({
      choices: [{ message: { content: '## Cloud summary\n\nSalvaged while the primary breaker was open.' } }],
    });

    const condensedResult = await fillUntilCondensed();

    const outcomes = condensedResult.condenseDiagnostic!.map((d: any) => d.outcome);
    expect(outcomes).toContain('fallback-cloud');
    expect(outcomes).not.toContain('fallback-truncated');
    expect(mockFallbackCreate).toHaveBeenCalled();
    // The breaker still guards the primary: not a single primary call while open.
    expect(mockGetPrimaryClient).not.toHaveBeenCalled();
    const cloudPass = condensedResult.condenseDiagnostic!.find((d: any) => d.outcome === 'fallback-cloud');
    expect(cloudPass.llm.summary.finalOutcome).toBe('ok-with-fallback');
  });

  // #2719 (22/09): FALLBACK_LLM_MODEL_ID as a CHAIN — the next model takes over on
  // any failure of the previous one, an empty 200 body included (mode C of the
  // escalation: it used to go straight to truncation).
  it('(k) #2719 model chain: first model answers empty → second model salvages', async () => {
    mockFallbackModelId.mockImplementation(() => 'glm-4.7, deepseek-v4-flash');
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    mockFallbackCreate.mockImplementation(async (req: any) => req.model === 'glm-4.7'
      ? { choices: [{ message: { content: '' }, finish_reason: 'length' }] }
      : { choices: [{ message: { content: '## Sonnet summary\n\nSalvaged by the second tier.' } }] });

    const condensedResult = await fillUntilCondensed();

    const cloudPasses = condensedResult.condenseDiagnostic!.filter((d: any) => d.outcome === 'fallback-cloud');
    expect(cloudPasses.length).toBeGreaterThanOrEqual(1);
    expect(cloudPasses[0].llm.summary.fallbackModel).toBe('deepseek-v4-flash');
    const models = mockFallbackCreate.mock.calls.map((c: any[]) => c[0].model);
    // Order matters: the nominal model first, the failover second.
    expect(models.indexOf('glm-4.7')).toBeGreaterThanOrEqual(0);
    expect(models.indexOf('glm-4.7')).toBeLessThan(models.indexOf('deepseek-v4-flash'));
  });

  it('(l) #2719 model chain: every model fails → archive names each model and its error', async () => {
    mockFallbackModelId.mockImplementation(() => 'glm-4.7,deepseek-v4-flash');
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    const error401 = Object.assign(new Error('401 invalid proxy authentication'), { status: 401 });
    mockFallbackCreate.mockImplementation(async (req: any) => {
      if (req.model === 'glm-4.7') return { choices: [{ message: { content: '' }, finish_reason: 'length' }] };
      throw error401;
    });

    const condensedResult = await fillUntilCondensed();

    const outcomes = condensedResult.condenseDiagnostic!.map((d: any) => d.outcome);
    expect(outcomes).toContain('fallback-truncated');
    const archiveFiles = await readdir(path.join(tmpDir, 'dashboards', 'archive'));
    const fallbackArchives = archiveFiles.filter(f => f.endsWith('-fallback.md'));
    expect(fallbackArchives.length).toBeGreaterThanOrEqual(1);
    const archiveContent = await readFile(
      path.join(tmpDir, 'dashboards', 'archive', fallbackArchives[0]),
      'utf8',
    );
    // yaml.dump folds a long scalar (`>-`) across lines — compare the unfolded text.
    const unfolded = archiveContent.replace(/\n\s+/g, ' ');
    expect(unfolded).toContain('glm-4.7: empty-content (HTTP 200, 0-byte completion) | deepseek-v4-flash: 401 invalid proxy authentication');
  });

  // #2719 review of PR #1194 (W2): three attempts PER MODEL multiplied the worst-case
  // wait by the chain length. The first model keeps its retries (transient 429/5xx);
  // every next model gets ONE attempt — the chain already is the retry.
  it('(m) #2719 model chain: retries stay on the first model, the next one gets a single attempt', { timeout: 60000 }, async () => {
    mockFallbackModelId.mockImplementation(() => 'glm-4.7,deepseek-v4-flash');
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    mockFallbackCreate.mockRejectedValue(Object.assign(new Error('503 Service Unavailable'), { status: 503 }));

    await fillUntilCondensed();

    const models = mockFallbackCreate.mock.calls.map((c: any[]) => c[0].model);
    const first = models.filter((m: string) => m === 'glm-4.7').length;
    const next = models.filter((m: string) => m === 'deepseek-v4-flash').length;
    expect(next).toBeGreaterThanOrEqual(1);
    expect(first).toBe(3 * next);
  });

  // #2719 review of PR #1194 (W3): with the primary skipped and the cloud tier failing,
  // the stats kept lastError empty and elapsedMs 0 — the notice read "circuit-open
  // (0 attempts, 0s)" and named no cause.
  it('(n) #2719 breaker OPEN and cloud tier fails → lastError names the skipped primary and the cloud error', { timeout: 90000 }, async () => {
    // Primary down, cloud unconfigured → failing passes open the breaker (as in (j)).
    for (let i = 0; i < 4; i++) {
      await fillUntilCondensed();
    }
    const unconfigured = await fillUntilCondensed();
    const openPass = unconfigured.condenseDiagnostic!.find((d: any) => d.outcome === 'fallback-truncated');
    expect(openPass.llm.summary.finalOutcome).toBe('circuit-open');
    expect(openPass.llm.summary.lastError).toBe('primary skipped (circuit breaker open); cloud tier unconfigured');

    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    mockFallbackCreate.mockRejectedValue(Object.assign(new Error('401 invalid proxy authentication'), { status: 401 }));

    const rejected = await fillUntilCondensed();

    const rejectedPass = rejected.condenseDiagnostic!.find((d: any) => d.outcome === 'fallback-truncated');
    expect(rejectedPass.llm.summary.finalOutcome).toBe('circuit-open');
    expect(rejectedPass.llm.summary.lastError).toBe('primary skipped (circuit breaker open); cloud: 401 invalid proxy authentication');
  });

  /**
   * #2719 observability (web1 c.450 §3, mesure 14/09) — the truncation notice lived
   * ONLY in the intercom, which is ephemeral by construction: the next condensation
   * archives it, and while the LLM stays down it archives it *by truncation*, leaving
   * no successor. Measured on `workspace-roo-extensions` after two fallback archives:
   * the `## Status` block — the surface the rules designate as the primary read —
   * carried ZERO occurrence of "truncation|fallback". This test reads the STATUS
   * SECTION ONLY, which is exactly what that reader does.
   */
  it('(o) #2719 both legs down → the Status block carries a persistent truncation marker, and it does not accumulate', { timeout: 90000 }, async () => {
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockRejectedValue(new Error('vLLM down'));
    // Cloud configured AND attempted, so the marker must name the cloud cause —
    // "unconfigured" and "attempted but rejected" stay distinguishable there too.
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
    });
    mockFallbackCreate.mockRejectedValue(Object.assign(new Error('z.ai 503 unavailable'), { status: 503 }));

    await fillUntilCondensed();

    const read = await roosyncDashboard({ action: 'read', type: 'global', section: 'status' });
    const statusMarkdown: string = (read as any).data?.status?.markdown ?? '';

    // Discrimination: greppable on the outcome label, in the section a Status-only reader opens.
    expect(statusMarkdown).toContain('lastCondense: fallback-truncated');
    // BOTH legs are named (ai-01 addendum 12/09 §2: the discriminant needs the leg
    // dimension, not just a code). Without the cloud half, a Status-only reader cannot
    // tell "cloud unconfigured" from "cloud attempted and rejected".
    expect(statusMarkdown).toContain('primary: ');
    expect(statusMarkdown).toContain('vLLM down');
    expect(statusMarkdown).toContain('cloud: z.ai 503 unavailable');
    // The breaker state rides along, as in the intercom notice.
    expect(statusMarkdown).toMatch(/breaker \d+\/\d+/);

    // #2463 invariant holds for the WHOLE block, marker included (the caller reserves
    // the marker's bytes out of the cap rather than truncating to the full budget).
    expect(Buffer.byteLength(statusMarkdown, 'utf8')).toBeLessThanOrEqual(15 * 1024);

    // A second failing pass must REPLACE the marker, not append a second one.
    await fillUntilCondensed();
    const after = await roosyncDashboard({ action: 'read', type: 'global', section: 'status' });
    const afterMarkdown: string = (after as any).data?.status?.markdown ?? '';
    const markerLines = afterMarkdown
      .split('\n')
      .filter(l => l.startsWith('> [!WARNING] **lastCondense: fallback-truncated**'));
    expect(markerLines).toHaveLength(1);
    expect(Buffer.byteLength(afterMarkdown, 'utf8')).toBeLessThanOrEqual(15 * 1024);
  });

  it('(p) #2719 successful condensation clears a previously stamped marker (self-clearing, not sticky)', { timeout: 90000 }, async () => {
    // Pass 1: both legs down → marker stamped.
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockRejectedValue(new Error('vLLM down'));
    mockGetFallbackClient.mockReturnValue(null); // cloud unconfigured
    await fillUntilCondensed();

    const afterFailure = await roosyncDashboard({ action: 'read', type: 'global', section: 'status' });
    expect((afterFailure as any).data?.status?.markdown ?? '').toContain('lastCondense: fallback-truncated');

    // Pass 2: primary healthy again → the LLM regenerates the status and the marker
    // must be gone. A marker that survived a successful pass would be a stale claim.
    resetCondenseCircuitBreaker();
    mockPrimaryCreate.mockReset();
    mockPrimaryCreate.mockResolvedValue({
      choices: [{ message: { content: '## Status\n\nAll nominal. Condensation healthy.' } }],
    });
    await fillUntilCondensed();

    const afterSuccess = await roosyncDashboard({ action: 'read', type: 'global', section: 'status' });
    const markdown: string = (afterSuccess as any).data?.status?.markdown ?? '';
    expect(markdown).not.toContain('lastCondense: fallback-truncated');
    expect(markdown).toContain('All nominal');
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
  // #3011 second tour: constructed from the REAL SDK class so it cannot silently
  // regress to the synthetic inverse (name set, constructor.name="Error"). Sanity-
  // asserts the SDK shape (.name="Error", constructor.name set) — the classifier
  // must work on this exact production shape, not a synthetic stand-in.
  it('#3011 does NOT retry APIConnectionTimeoutError (real SDK instance, hung endpoint)', () => {
    const err = new APIConnectionTimeoutError({ message: 'Request timed out' });
    // Sanity: confirm the SDK shape the fix depends on (.name inherited = "Error",
    // real type on constructor.name). If these ever flip, the test itself is wrong.
    expect(err.name).toBe('Error');
    expect(err.constructor.name).toBe('APIConnectionTimeoutError');
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
