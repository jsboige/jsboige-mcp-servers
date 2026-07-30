/**
 * #3016 — Cloud fallback per-attempt timeout BUDGET bite-test.
 *
 * Root cause: `getFallbackChatOpenAIClient` (openai.ts) gave the cloud fallback a
 * 30000ms default per-attempt ceiling AND silently clamped it at 60000ms
 * (`Math.min(timeout, 60000)`). The SUMMARY condensation call (the largest prompt)
 * needs longer than that; during a vLLM wedge the primary fail-fasts correctly and
 * the fallback carries the call, but its summary generation exceeded 30s and was cut
 * by the client timeout → `outcome: 'fallback-truncated'` with no digest.
 *
 * This file proves the OBSERVABLE end-to-end property required by #3016 criterion #4:
 * a fallback generation that exceeds the OLD 30s ceiling must now succeed (outcome
 * `fallback-cloud`, a summary present), and a generation exceeding the NEW ceiling
 * must still fast-fail (the budget is raised, not removed). It asserts the outcome +
 * summary presence — NOT the existence of a constant or helper (the false mordant
 * explicitly rejected in #3012/#3013).
 *
 * How it stays honest (red on current / green on fixed):
 *  - `@/services/openai` is PARTIALLY mocked: `getChatOpenAIClient` throws (primary
 *    unreachable) but `getFallbackChatOpenAIClient` is the REAL function — so the
 *    real default + clamp logic (the code under test) constructs the client.
 *  - `openai` is mocked so `new OpenAI({ timeout })` is captured and its `create`
 *    simulates the SDK per-request timeout: if the model's generation would outlast
 *    the client's configured timeout, it throws the REAL `APIConnectionTimeoutError`
 *    (the production timeout shape); otherwise it returns the summary.
 *  - `FALLBACK_TIMEOUT_MS` is deliberately UNSET so the code DEFAULT applies
 *    (30000+clamp on current code → 120000 no-clamp on fixed code). A 45s generation
 *    therefore times out on current code (45 > 30) and succeeds on fixed code (45 < 120).
 *
 * @module tools/roosync/__tests__/dashboard.fallback-timeout-budget
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// #3011/#3012 pattern: import the REAL SDK timeout class. The per-file `vi.mock`
// below restores the real exports (so APIConnectionTimeoutError is genuine) while
// overriding only the default `OpenAI` class with the timeout-simulating stand-in.
import { APIConnectionTimeoutError } from 'openai';

// Mutable holder for the simulated generation duration, hoisted so the openai mock
// factory (which runs before module body) can read it.
const fallbackGen = vi.hoisted(() => ({ simulatedGenerationMs: 45000 }));

vi.mock('openai', async (importOriginal) => {
  const real = await importOriginal<typeof import('openai')>();
  // Stand-in for the SDK client. Captures the `timeout` option the real
  // getFallbackChatOpenAIClient passes, then models the SDK per-request timeout in
  // create(): a generation that would outlast the client timeout aborts with the
  // REAL APIConnectionTimeoutError; otherwise the summary is returned.
  class MockOpenAI {
    readonly chat: {
      completions: { create: (req: unknown) => Promise<unknown> };
    };
    constructor(opts: { timeout?: number } = {}) {
      const clientTimeout = typeof opts.timeout === 'number' ? opts.timeout : 120000;
      this.chat = {
        completions: {
          create: async () => {
            if (fallbackGen.simulatedGenerationMs > clientTimeout) {
              throw new real.APIConnectionTimeoutError({ message: 'Request timed out.' });
            }
            return {
              choices: [{ message: { content: '## Cloud summary\n\nArchived traffic salvaged by z.ai on a slow generation.' } }],
            };
          },
        },
      };
    }
  }
  return { ...real, default: MockOpenAI };
});

// Partial mock: primary chat client permanently unavailable (forces the fallback
// path). The fallback client + model-id helpers stay REAL so the budget logic under
// test (default + former clamp) is exercised end-to-end.
vi.mock('@/services/openai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/services/openai')>();
  return {
    ...real,
    getChatOpenAIClient: () => {
      throw new Error('primary vLLM unreachable (test)');
    },
  };
});

import { roosyncDashboard, resetCondenseCircuitBreaker } from '../dashboard.js';
import { resetFallbackChatOpenAIClient } from '@/services/openai';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-fallback-budget-');

describe('#3016 cloud-fallback per-attempt timeout budget', { testTimeout: 30000 }, () => {
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
    // CRITICAL: FALLBACK_TIMEOUT_MS unset so the code DEFAULT applies. The default is
    // what the fix changes (30000+clamp → 120000 no-clamp); setting it here would make
    // the test indistinguishable between current and fixed code.
    delete process.env.FALLBACK_TIMEOUT_MS;
    delete process.env.ZAI_API_KEY;
    delete process.env.ZAI_BASE_URL;
    delete process.env.FALLBACK_BASE_URL;
    delete process.env.FALLBACK_LLM_MODEL_ID;
    // A fallback key must be present or getFallbackChatOpenAIClient returns null (inert).
    process.env.FALLBACK_API_KEY = 'test-fallback-key';
    fallbackGen.simulatedGenerationMs = 45000;
    resetFallbackChatOpenAIClient();
    resetCondenseCircuitBreaker();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
    delete process.env.FALLBACK_API_KEY;
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

  // THE bite-test (#3016 criterion #4). A realistic slow summary generation (45s) —
  // longer than the OLD 30s ceiling but well under the NEW 120s default — must now be
  // carried by the fallback instead of being cut into `fallback-truncated`.
  //
  // Red on current code: clientTimeout = min(30000, 60000) = 30000; 45 > 30 → the SDK
  //   throws APIConnectionTimeoutError → non-retryable (#3011) → fallback-truncated,
  //   no summary. This test FAILS on current code.
  // Green on fixed code: clientTimeout = 120000; 45 < 120 → summary returned →
  //   outcome `fallback-cloud`, a summary is present.
  it('a fallback generation exceeding the OLD 30s ceiling now produces a summary (outcome !== fallback-truncated)', async () => {
    // 45s generation: exceeds the old 30000ms default, under the new 120000ms default.
    fallbackGen.simulatedGenerationMs = 45000;

    const condensedResult = await fillUntilCondensed();

    expect(condensedResult.condenseDiagnostic).toBeDefined();
    // The observable property: at least one pass is NOT fallback-truncated, i.e. the
    // fallback carried it (fallback-cloud). Pre-fix every pass was fallback-truncated.
    const salvagedPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome !== 'fallback-truncated',
    );
    expect(salvagedPasses.length).toBeGreaterThanOrEqual(1);
    const cloudPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-cloud',
    );
    expect(cloudPasses.length).toBeGreaterThanOrEqual(1);
    // And a summary was actually produced via the fallback (not a null-content escape).
    const summaryProduced = cloudPasses.some(
      (d: any) => d.llm?.summary?.fallbackUsed === true,
    );
    expect(summaryProduced).toBe(true);
  });

  // Boundary guard: raising the ceiling must NOT remove the timeout. A generation
  // exceeding the NEW 120s default still fast-fails to `fallback-truncated` (a hung
  // endpoint is non-retryable per #3011, so it does not compound). This proves the
  // fix raised the budget rather than deleting it.
  it('a fallback generation exceeding the NEW 120s ceiling still fast-fails (budget raised, not removed)', async () => {
    // 200s generation: exceeds even the raised 120000ms default.
    fallbackGen.simulatedGenerationMs = 200000;

    const condensedResult = await fillUntilCondensed();

    expect(condensedResult.condenseDiagnostic).toBeDefined();
    const truncatedPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-truncated',
    );
    expect(truncatedPasses.length).toBeGreaterThanOrEqual(1);
    // No pass should be salvaged when every generation outlasts the ceiling.
    const cloudPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-cloud',
    );
    expect(cloudPasses).toHaveLength(0);
  });
});

// #3016 criterion #5: the bite-test must raise the PRODUCTION timeout exception type
// (APIConnectionTimeoutError via the real SDK), with the #3011 sanity-asserts. A
// synthetic Object.assign(new Error(), { name }) is INVERTED on these two fields
// (.name set, constructor.name="Error") and would validate a stale classifier —
// guarded against here.
describe('#3016 production timeout exception shape (sanity)', () => {
  it('APIConnectionTimeoutError is the real SDK instance (.name="Error", constructor.name set)', () => {
    const err = new APIConnectionTimeoutError({ message: 'Request timed out.' });
    // Sanity: the SDK shape the budget test depends on. If these flip, the bite-test
    // itself is validating the wrong shape.
    expect(err.name).toBe('Error');
    expect(err.constructor.name).toBe('APIConnectionTimeoutError');
    expect(err).toBeInstanceOf(Error);
  });
});
