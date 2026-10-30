/**
 * #4434 — Mechanism 2 (condenseTextIfTooLarge) must never return a model's refusal.
 *
 * Incident 30/10 17:11Z (`global`): the status handed to the "too big" condenser was
 * cut mid-word; the cloud fallback answered "I cannot complete this request as
 * specified. [...] Would you like me to proceed on that basis…?" — 1.5 KB, under the
 * cap, so it was returned and written as the status. Unlike the status leg (which
 * runs isModelFailureStatus inside the chain), Mechanism 2 checked nothing but size.
 *
 * Contract asserted here: a refusal / error artifact is never a candidate — the
 * primary moves to its next attempt, the cloud chain to its next model, and with no
 * valid candidate the deterministic floor runs on the REAL text.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { condenseTextIfTooLarge, truncateToMaxSize } from '../dashboard.js';

const mockPrimaryCreate = vi.fn();
const mockGetPrimaryClient = vi.fn();
const mockFallbackCreate = vi.fn();
const mockGetFallbackClient = vi.fn();
const mockFallbackModelId = vi.fn(() => 'glm-5.3-flash');

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetPrimaryClient(),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-primary-model',
  getFallbackChatOpenAIClient: () => mockGetFallbackClient(),
  getFallbackLLMModelId: () => mockFallbackModelId(),
}));

const CAP = 2 * 1024;
const oversizedText = (`${'X'.repeat(100)}\n`).repeat(80); // ≈ 8 KB > CAP
const REFUSAL = 'I cannot complete this request as specified.\n\nThe text is already truncated.\n\n'
  + 'Would you like me to proceed on that basis?';
const validCondensed = `## Statut\n${'v'.repeat(600)}`; // under CAP, not an artifact
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const reply = (content: string) => ({ choices: [{ message: { content } }] });

beforeEach(() => {
  mockPrimaryCreate.mockReset();
  mockGetPrimaryClient.mockReset();
  mockGetPrimaryClient.mockReturnValue({ chat: { completions: { create: mockPrimaryCreate } } });
  mockFallbackCreate.mockReset();
  mockGetFallbackClient.mockReset();
  mockGetFallbackClient.mockReturnValue(null); // cloud inert unless a test arms it
  mockFallbackModelId.mockImplementation(() => 'glm-5.3-flash');
  delete process.env.OPENAI_BASE_URL;
  delete process.env.FALLBACK_API_FORMAT; // a seat's .env must not flip the dialect
});

describe('condenseTextIfTooLarge — refusal is never a candidate (#4434)', () => {
  it('primary refuses on both attempts, cloud inert → floor on the real text, never the refusal', async () => {
    mockPrimaryCreate.mockResolvedValue(reply(REFUSAL));
    const out = await condenseTextIfTooLarge(oversizedText, CAP, 'Status');
    expect(out).not.toContain('I cannot complete');
    expect(out).toBe(truncateToMaxSize(oversizedText, CAP, 'Status'));
    expect(bytes(out)).toBeLessThanOrEqual(CAP);
    expect(mockPrimaryCreate).toHaveBeenCalledTimes(2); // the refusal moved it to attempt 2
  });

  it('primary refuses, then condenses → the second attempt is returned', async () => {
    mockPrimaryCreate
      .mockResolvedValueOnce(reply(REFUSAL))
      .mockResolvedValueOnce(reply(validCondensed));
    const out = await condenseTextIfTooLarge(oversizedText, CAP, 'Status');
    expect(out).toBe(validCondensed);
  });

  it('cloud chain: the first model refuses → the next model is tried and its condensation returned', async () => {
    mockPrimaryCreate.mockRejectedValue(new Error('vLLM down'));
    mockFallbackModelId.mockImplementation(() => 'deepseek-v4-flash,claude-sonnet-5-5');
    mockGetFallbackClient.mockReturnValue({ chat: { completions: { create: mockFallbackCreate } } });
    mockFallbackCreate.mockImplementation(async (req: any) =>
      req.model === 'deepseek-v4-flash' ? reply(REFUSAL) : reply(validCondensed));
    const out = await condenseTextIfTooLarge(oversizedText, CAP, 'Status');
    expect(out).toBe(validCondensed);
    const models = mockFallbackCreate.mock.calls.map((c: any[]) => c[0].model);
    expect(models).toEqual(['deepseek-v4-flash', 'claude-sonnet-5-5']);
  });

  it('cloud chain: every model refuses → floor on the real text (the 30/10 incident path)', async () => {
    mockPrimaryCreate.mockRejectedValue(new Error('vLLM down'));
    mockGetFallbackClient.mockReturnValue({ chat: { completions: { create: mockFallbackCreate } } });
    mockFallbackCreate.mockResolvedValue(reply(REFUSAL));
    const out = await condenseTextIfTooLarge(oversizedText, CAP, 'Status');
    expect(out).not.toContain('Would you like me to');
    expect(out).toBe(truncateToMaxSize(oversizedText, CAP, 'Status'));
  });

  it('control: a legitimate under-cap condensation from the primary is returned unchanged', async () => {
    mockPrimaryCreate.mockResolvedValue(reply(validCondensed));
    const out = await condenseTextIfTooLarge(oversizedText, CAP, 'Status');
    expect(out).toBe(validCondensed);
    expect(mockPrimaryCreate).toHaveBeenCalledTimes(1);
  });
});
