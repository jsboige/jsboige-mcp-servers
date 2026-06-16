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

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { condenseTextIfTooLarge, truncateToMaxSize } from '../dashboard.js';

// Mirror the LLM-client mock used by dashboard.test.ts.
const mockChatCreate = vi.fn();
const mockGetChatClient = vi.fn();

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetChatClient(),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
}));

const CAP = 2 * 1024; // small cap keeps fixtures tiny; the function takes the cap as a param

// Over-cap, multi-line input so the deterministic floor has real lines to drop.
const oversizedText = (`${'X'.repeat(100)}\n`).repeat(80); // 80 lines × 101 B ≈ 8 KB
const oversizedLLMReply = (`${'Y'.repeat(120)}\n`).repeat(80); // still ≈ 9.7 KB > CAP
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

beforeEach(() => {
  mockChatCreate.mockReset();
  // Default: LLM available, wired to mockChatCreate.
  mockGetChatClient.mockReset();
  mockGetChatClient.mockReturnValue({ chat: { completions: { create: mockChatCreate } } });
  delete process.env.OPENAI_BASE_URL;
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
