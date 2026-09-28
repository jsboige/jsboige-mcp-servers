/**
 * #2719 borne (ai-01 arbitration 27/09) — prompt-proportional cloud-fallback timeout
 * + per-PASS deadline, bite-tests.
 *
 * Two bounds, both derived from the MEASURED append client timeout of 180s
 * (intercom-append-timeout.md, po-2024 c.327):
 *  - per-attempt timeout = clamp(FALLBACK_TIMEOUT_MIN_MS + FALLBACK_TIMEOUT_MS_PER_KB × KB,
 *    floor, FALLBACK_TIMEOUT_MS ceiling) — a ~50KB near-cap dashboard yields ~74s,
 *    BELOW the flat 120s default, so a 100s slow generation must now fast-fail where
 *    the flat ceiling (#3016) would have carried it;
 *  - CONDENSE_PASS_DEADLINE_MS bounds the WHOLE pass (parallel paths + model chain):
 *    past it, attempts are refused with 'budget-exhausted' WITHOUT any SDK traffic.
 *
 * How it stays honest (same pattern as dashboard.fallback-timeout-budget.test.ts):
 *  - `openai` is mocked with a stand-in that captures BOTH the constructor timeout and
 *    the per-REQUEST `{ timeout }` options, and simulates the SDK timeout against the
 *    EFFECTIVE value (per-request wins over constructor) using the REAL
 *    APIConnectionTimeoutError;
 *  - `@/services/openai` is partially mocked (primary throws, fallback REAL);
 *  - FALLBACK_TIMEOUT_* env deliberately unset in beforeEach so CODE DEFAULTS apply.
 *
 * @module tools/roosync/__tests__/dashboard.fallback-timeout-proportional
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { APIConnectionTimeoutError } from 'openai';

// Hoisted mutable holders: simulated generation duration + record of every create()
// call's effective per-request timeout (the quantity the #2719 borne governs).
const fb = vi.hoisted(() => ({
  simulatedGenerationMs: 60000,
  requestTimeouts: [] as number[],
  createCalls: 0,
}));

vi.mock('openai', async (importOriginal) => {
  const real = await importOriginal<typeof import('openai')>();
  class MockOpenAI {
    readonly chat: {
      completions: { create: (req: unknown, options?: { timeout?: number }) => Promise<unknown> };
    };
    constructor(opts: { timeout?: number } = {}) {
      const clientTimeout = typeof opts.timeout === 'number' ? opts.timeout : 120000;
      this.chat = {
        completions: {
          create: async (_req: unknown, options?: { timeout?: number }) => {
            // Effective timeout: per-request override (the #2719 borne) wins over the
            // constructor default — this is the SDK's documented precedence.
            const effectiveTimeout =
              typeof options?.timeout === 'number' ? options.timeout : clientTimeout;
            fb.createCalls++;
            fb.requestTimeouts.push(effectiveTimeout);
            if (fb.simulatedGenerationMs > effectiveTimeout) {
              throw new real.APIConnectionTimeoutError({ message: 'Request timed out.' });
            }
            return {
              choices: [{ message: { content: '## Cloud summary\n\nBorne-proportional salvage.' } }],
            };
          },
        },
      };
    }
  }
  return { ...real, default: MockOpenAI };
});

vi.mock('@/services/openai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/services/openai')>();
  return {
    ...real,
    getChatOpenAIClient: () => {
      throw new Error('primary vLLM unreachable (test)');
    },
  };
});

import {
  roosyncDashboard,
  resetCondenseCircuitBreaker,
  computeFallbackAttemptTimeoutMs,
  computePrimaryAttemptTimeoutMs,
} from '../dashboard.js';
import { resetFallbackChatOpenAIClient } from '@/services/openai';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-fallback-proportional-');

describe('#2719 borne — computeFallbackAttemptTimeoutMs (unit)', () => {
  beforeEach(() => {
    delete process.env.FALLBACK_TIMEOUT_MS;
    delete process.env.FALLBACK_TIMEOUT_MIN_MS;
    delete process.env.FALLBACK_TIMEOUT_MS_PER_KB;
  });

  it('floor at zero bytes, slope per KB, no deadline', () => {
    expect(computeFallbackAttemptTimeoutMs(0)).toBe(30000);
    // 30 KiB = 30720 bytes → 30000 + 900 × 30 = 57000 (KB fraction, rounded)
    expect(computeFallbackAttemptTimeoutMs(30720)).toBe(57000);
  });

  it('ceiling clamp honours FALLBACK_TIMEOUT_MS', () => {
    process.env.FALLBACK_TIMEOUT_MS = '40000';
    // 50 KB prompt would compute ~73945ms; clamped to the 40s ceiling.
    expect(computeFallbackAttemptTimeoutMs(50 * 1024)).toBe(40000);
  });

  it('deadline clips the attempt to the remaining budget', () => {
    const deadline = Date.now() + 10000; // 10s left
    const t = computeFallbackAttemptTimeoutMs(50 * 1024, deadline);
    expect(t).not.toBeNull();
    expect(t!).toBeLessThanOrEqual(10000);
    expect(t!).toBeGreaterThanOrEqual(5000); // above the skip floor
  });

  it('returns null (refuse, no traffic) when less than the skip floor remains', () => {
    expect(computeFallbackAttemptTimeoutMs(50 * 1024, Date.now() + 4000)).toBeNull();
    expect(computeFallbackAttemptTimeoutMs(50 * 1024, Date.now() - 1)).toBeNull();
  });
});

describe('#2719 seconde borne — computePrimaryAttemptTimeoutMs (unit)', () => {
  beforeEach(() => {
    delete process.env.CONDENSE_LLM_TIMEOUT_MS;
    delete process.env.FALLBACK_TIMEOUT_MS;
    delete process.env.FALLBACK_TIMEOUT_MIN_MS;
    delete process.env.FALLBACK_TIMEOUT_MS_PER_KB;
    delete process.env.FALLBACK_LLM_MODEL_ID;
    delete process.env.ZAI_API_KEY;
    process.env.FALLBACK_API_KEY = 'test-fallback-key';
  });

  afterEach(() => {
    delete process.env.FALLBACK_API_KEY;
  });

  it('no pass deadline → flat ceiling (non-append callers unchanged)', () => {
    expect(computePrimaryAttemptTimeoutMs(50 * 1024)).toBe(720000);
  });

  it('no armed cloud tier → ceiling even under a deadline that would clip/refuse (GO #1)', () => {
    delete process.env.FALLBACK_API_KEY;
    // Armed, this deadline would clip to ~5000ms (< the 15s plancher) → null (refusal).
    // Unarmed, the function must behave exactly as before the second bound: no clip.
    expect(computePrimaryAttemptTimeoutMs(50 * 1024, Date.now() + 80000)).toBe(720000);
  });

  it('clips to remaining − fallback reserve (75000ms reserve on a 50 KB prompt)', () => {
    // 50 KB → reserve = 30000 + 900 × 50 = 75000 (< the 120000 reserve ceiling).
    // deadline +200s → clip ≈ 125000ms, strictly below the 720s ceiling.
    const t = computePrimaryAttemptTimeoutMs(50 * 1024, Date.now() + 200000);
    expect(t).not.toBeNull();
    expect(t!).toBeLessThanOrEqual(125000);
    expect(t!).toBeGreaterThan(124000);
  });

  it('keeps the 720s ceiling when the remaining budget can host it', () => {
    // remaining − reserve ≈ 825000 > ceiling → min() keeps the flat ceiling.
    expect(computePrimaryAttemptTimeoutMs(50 * 1024, Date.now() + 900000)).toBe(720000);
  });

  it('refuses (null) below the 15s plancher — no attempt started', () => {
    expect(computePrimaryAttemptTimeoutMs(50 * 1024, Date.now() + 75000 + 14000)).toBeNull();
    expect(computePrimaryAttemptTimeoutMs(50 * 1024, Date.now() - 1)).toBeNull();
  });

  it('returns the clipped budget when it sits just above the plancher', () => {
    const t = computePrimaryAttemptTimeoutMs(50 * 1024, Date.now() + 75000 + 16000);
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThanOrEqual(15000);
    expect(t!).toBeLessThanOrEqual(16000);
  });
});

describe('#2719 borne — prompt-proportional timeout end-to-end', { testTimeout: 30000 }, () => {
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
    // Code defaults must apply (30000 floor + 900/KB + 120000 ceiling + 165000 deadline).
    delete process.env.FALLBACK_TIMEOUT_MS;
    delete process.env.FALLBACK_TIMEOUT_MIN_MS;
    delete process.env.FALLBACK_TIMEOUT_MS_PER_KB;
    delete process.env.CONDENSE_PASS_DEADLINE_MS;
    delete process.env.ZAI_API_KEY;
    delete process.env.ZAI_BASE_URL;
    delete process.env.FALLBACK_BASE_URL;
    delete process.env.FALLBACK_LLM_MODEL_ID;
    process.env.FALLBACK_API_KEY = 'test-fallback-key';
    fb.simulatedGenerationMs = 60000;
    fb.requestTimeouts = [];
    fb.createCalls = 0;
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

  it('the per-request timeout is proportional (below the flat 120s ceiling) and a 60s generation is salvaged', async () => {
    fb.simulatedGenerationMs = 60000;
    const condensedResult = await fillUntilCondensed();

    // The fallback really ran with a per-request timeout (the borne is wired).
    expect(fb.createCalls).toBeGreaterThan(0);
    expect(fb.requestTimeouts.length).toBeGreaterThan(0);
    // Proportionality engaged on a near-cap (~50KB) dashboard: ~30s + 0.9s/KB ≈ 74s,
    // strictly below the flat 120000 default — never above it.
    const maxReqTimeout = Math.max(...fb.requestTimeouts);
    expect(maxReqTimeout).toBeLessThan(120000);
    // And 60s < ~74s → the cloud carried the pass (outcome fallback-cloud, summary present).
    const cloudPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-cloud',
    );
    expect(cloudPasses.length).toBeGreaterThanOrEqual(1);
    expect(cloudPasses.some((d: any) => d.llm?.summary?.fallbackUsed === true)).toBe(true);
  });

  it('a 100s generation fast-fails under the proportional timeout (would pass the flat 120s ceiling)', async () => {
    fb.simulatedGenerationMs = 100000;
    const condensedResult = await fillUntilCondensed();

    // Every issued attempt carried a proportional timeout that the 100s generation
    // outlasts → real SDK timeout → non-retryable (#3011) → truncation.
    expect(fb.requestTimeouts.length).toBeGreaterThan(0);
    for (const t of fb.requestTimeouts) {
      expect(t).toBeLessThan(100000);
    }
    const truncatedPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-truncated',
    );
    expect(truncatedPasses.length).toBeGreaterThanOrEqual(1);
    const cloudPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-cloud',
    );
    expect(cloudPasses).toHaveLength(0);
  });

  it('an exhausted pass deadline refuses attempts WITHOUT any SDK traffic (budget-exhausted)', async () => {
    // 1ms deadline: by the time the fallback tier runs, less than the 5s skip floor
    // remains → every attempt is refused before any request leaves the process.
    process.env.CONDENSE_PASS_DEADLINE_MS = '1';
    fb.simulatedGenerationMs = 1000; // would trivially succeed if attempted

    const condensedResult = await fillUntilCondensed();

    expect(fb.createCalls).toBe(0);
    const truncatedPasses = condensedResult.condenseDiagnostic!.filter(
      (d: any) => d.outcome === 'fallback-truncated',
    );
    expect(truncatedPasses.length).toBeGreaterThanOrEqual(1);
    // The refusal is stamped so the archive frontmatter names the cause.
    const budgetStamped = truncatedPasses.some(
      (d: any) =>
        (d.llm?.summary?.fallbackError ?? d.llm?.status?.fallbackError ?? '').includes('budget-exhausted'),
    );
    expect(budgetStamped).toBe(true);
  });
});
