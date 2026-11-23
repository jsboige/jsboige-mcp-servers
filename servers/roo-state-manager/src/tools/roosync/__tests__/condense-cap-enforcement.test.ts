/**
 * Regression guard for the #2598 follow-up: Mechanism 2 (the dedicated "status too
 * big" condenser, condenseTextIfTooLarge) MUST make its byte cap a HARD guarantee.
 *
 * Before this fix, condenseTextIfTooLarge was best-effort: on the success path it
 * returned the LLM output WITHOUT re-checking its size, and on no-client / empty /
 * exception it returned the oversized original. The 15 KB status cap was decorative,
 * so a status could grow to ~21 KB (CoursIA-2, 2026-06-15) and wedge the dashboard
 * at the preemptive condensation threshold — re-condensing on every post.
 *
 * These tests assert the invariant the bug violated: every exit path yields
 * output <= maxSizeBytes, whatever the (mocked) LLM does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { condenseTextIfTooLarge, truncateToMaxSize } from '../dashboard.js';

// Mirror the LLM-client mock used by dashboard.test.ts.
const mockChatCreate = vi.fn();
const mockGetChatClient = vi.fn();
// #4872: the cloud chain's client is mockable too — inert (null) by default so the
// deterministic HARD-cap behavior these tests guard remains unchanged; the
// cloud-first describe below flips it to a simulated cloud client.
const mockFallbackCreate = vi.fn();
const mockGetFallbackClient = vi.fn();

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetChatClient(),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  // #2719: cloud fallback is inert in this suite (returns null) so the
  // deterministic HARD-cap behavior these tests guard remains unchanged.
  getFallbackChatOpenAIClient: () => mockGetFallbackClient(),
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

const CAP = 2 * 1024; // small cap keeps fixtures tiny; the function takes the cap as a param

// Over-cap, multi-line input so the deterministic floor has real lines to drop.
const oversizedText = (`${'X'.repeat(100)}\n`).repeat(80); // 80 lines × 101 B ≈ 8 KB
const oversizedLLMReply = (`${'Y'.repeat(120)}\n`).repeat(80); // still ≈ 9.7 KB > CAP
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const savedFallbackApiFormat = process.env.FALLBACK_API_FORMAT;

beforeEach(() => {
  mockChatCreate.mockReset();
  // Default: LLM available, wired to mockChatCreate.
  mockGetChatClient.mockReset();
  mockGetChatClient.mockReturnValue({ chat: { completions: { create: mockChatCreate } } });
  // Default: cloud chain unconfigured (#2719 inert), same as before #4872.
  mockGetFallbackClient.mockReset();
  mockGetFallbackClient.mockReturnValue(null);
  mockFallbackCreate.mockReset();
  delete process.env.OPENAI_BASE_URL;
  // #4872 hermeticity (ai-01 review, file-scope pin convention ms#1551): the seat .env
  // carries FALLBACK_API_FORMAT=anthropic — without a pin, cloudCondenseOnce takes the
  // /messages route and the chat-completions mock is never called (2/14 red on Windows).
  process.env.FALLBACK_API_FORMAT = 'openai';
});

afterEach(() => {
  if (savedFallbackApiFormat === undefined) delete process.env.FALLBACK_API_FORMAT;
  else process.env.FALLBACK_API_FORMAT = savedFallbackApiFormat;
});

describe('truncateToMaxSize (deterministic floor #2463)', () => {
  it('returns text unchanged when already under cap', () => {
    const t = 'line1\nline2\nline3';
    expect(truncateToMaxSize(t, CAP, 'Status')).toBe(t);
  });

  it('truncates multi-line over-cap text to <= cap', () => {
    const out = truncateToMaxSize(oversizedText, CAP, 'Status');
    expect(bytes(out)).toBeLessThanOrEqual(CAP);
    expect(bytes(out)).toBeGreaterThan(0);
  });

  it('hard-truncates a single giant line to <= cap', () => {
    const out = truncateToMaxSize('Z'.repeat(20 * 1024), 1 * 1024, 'Status');
    expect(bytes(out)).toBeLessThanOrEqual(1 * 1024);
  });
});

describe('condenseTextIfTooLarge — cap is a hard guarantee', () => {
  it('returns input unchanged (no LLM call) when already under cap', async () => {
    const small = 'already small';
    const out = await condenseTextIfTooLarge(small, CAP, 'Status');
    expect(out).toBe(small);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('returns the LLM output when it converges under the cap on attempt 1', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: 'condensed under cap' } }] });
    const out = await condenseTextIfTooLarge(oversizedText, CAP, 'Status');
    expect(out).toBe('condensed under cap');
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
  });

  it('falls back to deterministic truncation when the LLM stays over cap (the #2598 bug)', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: oversizedLLMReply } }] });
    const out = await condenseTextIfTooLarge(oversizedText, CAP, 'Status');
    expect(bytes(out)).toBeLessThanOrEqual(CAP); // never returns the oversized LLM reply
    expect(mockChatCreate).toHaveBeenCalledTimes(2); // one bounded retry before the floor
  });

  it('falls back to deterministic truncation when no LLM client is available', async () => {
    mockGetChatClient.mockImplementation(() => { throw new Error('No chat API key configured'); });
    const out = await condenseTextIfTooLarge(oversizedText, CAP, 'Status');
    expect(bytes(out)).toBeLessThanOrEqual(CAP);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('falls back to deterministic truncation when the LLM call throws', async () => {
    mockChatCreate.mockRejectedValue(new Error('gateway 502'));
    const out = await condenseTextIfTooLarge(oversizedText, CAP, 'Status');
    expect(bytes(out)).toBeLessThanOrEqual(CAP);
    expect(mockChatCreate).toHaveBeenCalledTimes(2);
  });

  it('falls back to deterministic truncation when the LLM returns empty content', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '' } }] });
    const out = await condenseTextIfTooLarge(oversizedText, CAP, 'Status');
    expect(bytes(out)).toBeLessThanOrEqual(CAP);
    expect(mockChatCreate).toHaveBeenCalledTimes(2);
  });

  it('prefers the smallest over-cap candidate for the floor (retry shrinks but still over)', async () => {
    // Attempt 1 returns a big reply, attempt 2 a smaller (still over-cap) one — the
    // floor should run on the smaller candidate, and the result must be <= cap.
    const bigger = (`${'Y'.repeat(120)}\n`).repeat(80);  // ≈ 9.7 KB
    const smaller = (`${'Y'.repeat(120)}\n`).repeat(30);  // ≈ 3.6 KB, still > 2 KB cap
    mockChatCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: bigger } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: smaller } }] });
    const out = await condenseTextIfTooLarge(oversizedText, CAP, 'Status');
    expect(bytes(out)).toBeLessThanOrEqual(CAP);
    expect(mockChatCreate).toHaveBeenCalledTimes(2);
  });
});

describe('#4872 — cloud-first order for the size guard', () => {
  const cloudReply = (content: string) => ({ choices: [{ message: { content }, finish_reason: 'stop' }] });

  it('cloudFirst sends the FIRST attempt to the cloud — the primary is never called', async () => {
    // The issue's failing-on-base assertion: a simulated cloud client is available
    // and the guard is asked cloud-first → attempt 1 goes to the cloud chain. On the
    // base (no cloudFirst order) this FAILS: the primary gets the first call.
    mockGetFallbackClient.mockReturnValue({ chat: { completions: { create: mockFallbackCreate } } });
    mockFallbackCreate.mockResolvedValue(cloudReply('cloud condensed under cap'));
    const out = await condenseTextIfTooLarge(oversizedText, CAP, 'Status', undefined, undefined, true);
    expect(out).toBe('cloud condensed under cap');
    expect(bytes(out)).toBeLessThanOrEqual(CAP);
    expect(mockFallbackCreate).toHaveBeenCalledTimes(1); // first and only attempt: cloud
    expect(mockChatCreate).not.toHaveBeenCalled(); // primary NEVER called
  });

  it('cloudFirst with no cloud client falls back to the primary attempts', async () => {
    // Cloud unconfigured (null client, the #2719 inert default) → the primary LLM
    // remains the repli, then the deterministic floor. Order is cloud-first but the
    // cloud leg is absent: behavior must match the legacy path.
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: 'primary condensed under cap' } }] });
    const out = await condenseTextIfTooLarge(oversizedText, CAP, 'Status', undefined, undefined, true);
    expect(out).toBe('primary condensed under cap');
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    expect(mockFallbackCreate).not.toHaveBeenCalled();
  });

  it('cloudFirst with still-oversized cloud content falls back to the primary', async () => {
    // Cloud answers but stays over the cap → best-candidate tracked, primary
    // attempts run, its under-cap answer wins. The trailing legacy cloud block must
    // NOT run a second cloud chain (the cloud already had its turn).
    mockGetFallbackClient.mockReturnValue({ chat: { completions: { create: mockFallbackCreate } } });
    mockFallbackCreate.mockResolvedValue(cloudReply(oversizedLLMReply));
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: 'primary condensed under cap' } }] });
    const out = await condenseTextIfTooLarge(oversizedText, CAP, 'Status', undefined, undefined, true);
    expect(out).toBe('primary condensed under cap');
    expect(mockFallbackCreate).toHaveBeenCalledTimes(1); // exactly one cloud round
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
  });

  it('default (no cloudFirst flag) keeps the legacy order: primary first, cloud untouched', async () => {
    mockGetFallbackClient.mockReturnValue({ chat: { completions: { create: mockFallbackCreate } } });
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: 'primary condensed under cap' } }] });
    const out = await condenseTextIfTooLarge(oversizedText, CAP, 'Status');
    expect(out).toBe('primary condensed under cap');
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    expect(mockFallbackCreate).not.toHaveBeenCalled();
  });

  it('#4872 (a): cloud-first keeps serving the primary while the pass has time left', async () => {
    // Measured defect (ai-01, 23/11): in cloud-first order the trailing cloud block
    // is SKIPPED, but the primary's clamp still subtracted the #3962 cloud reserve —
    // the shared pass deadline is mostly consumed by the time the Summary guard
    // runs, so the 35-82s reserve refused the primary every pass ("pass deadline
    // reached the cloud reserve") while the budget it protected was never spent.
    // Here: 20s left, reserve pinned to 18s → the BASE refuses the primary (< 5s
    // floor) and truncates; cloud-first drops the reserve → the primary runs.
    const savedReserve = process.env.CONDENSE_CLOUD_RESERVE_MS;
    process.env.CONDENSE_CLOUD_RESERVE_MS = '18000';
    try {
      // Timeout-shaped (APIConnectionTimeoutError by constructor.name) =
      // non-retryable for isRetryableFallbackError → the chain fails fast, no
      // backoff sleeps eating the 20s budget the test manipulates.
      class APIConnectionTimeoutError extends Error {}
      mockGetFallbackClient.mockReturnValue({ chat: { completions: { create: mockFallbackCreate } } });
      mockFallbackCreate.mockRejectedValue(new APIConnectionTimeoutError('Request timed out.'));
      mockChatCreate.mockResolvedValue({ choices: [{ message: { content: 'primary condensed under cap' } }] });
      const passDeadline = Date.now() + 20000;
      const out = await condenseTextIfTooLarge(oversizedText, CAP, 'Status', passDeadline, undefined, true);
      expect(out).toBe('primary condensed under cap');
      expect(mockChatCreate).toHaveBeenCalledTimes(1);
    } finally {
      if (savedReserve === undefined) delete process.env.CONDENSE_CLOUD_RESERVE_MS;
      else process.env.CONDENSE_CLOUD_RESERVE_MS = savedReserve;
    }
  });

  it("#4872 (c): the guard's cloud chain sizes its output budget to the cap, not the shared ceiling", async () => {
    // Measured defect (ai-01, 23/11): glm-4.7 spent the shared 7200-token budget
    // reasoning before any text and the attempt expired (~36s for a ~1500-token
    // summary). The guard's cloud chain now asks for cap/2 BYTES of tokens (≈1.5x
    // the largest legitimate sub-cap answer): a 2 KB cap → 1024, not 7200 — an
    // overthinking model fails fast on its output budget (finish_reason 'length'
    // → next model) instead of hanging to the attempt timeout.
    mockGetFallbackClient.mockReturnValue({ chat: { completions: { create: mockFallbackCreate } } });
    mockFallbackCreate.mockResolvedValue(cloudReply('cloud condensed under cap'));
    await condenseTextIfTooLarge(oversizedText, CAP, 'Status', undefined, undefined, true);
    expect(mockFallbackCreate).toHaveBeenCalledTimes(1);
    expect(mockFallbackCreate.mock.calls[0][0].max_tokens).toBe(Math.ceil(CAP / 2));
  });
});
