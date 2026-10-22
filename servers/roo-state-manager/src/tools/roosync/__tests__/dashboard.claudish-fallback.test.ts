/**
 * #3962 piste 4 — the cloud tier through claudish roles (user 22/10).
 *
 *   (c1) wire format + text extraction: `FALLBACK_API_FORMAT=anthropic` selects the
 *        Anthropic route; only `text` blocks are the summary, `thinking` is not;
 *   (c2) prompt-sized cloud reserve: without an explicit CONDENSE_CLOUD_RESERVE_MS the
 *        primary leaves the cloud the attempt THIS prompt will request (35-82 s);
 *   (c3) end to end: on the Anthropic route the cloud call is a POST /messages on the
 *        fallback client (no chat-completions call, no `/no_think` prefix) and the
 *        pass is salvaged from the text block of a thinking backend;
 *   (c4) breaker: a pass the cloud rescued counts as a primary failure, so three
 *        rescued passes open the breaker and the fourth skips the primary.
 *
 * @module tools/roosync/__tests__/dashboard.claudish-fallback
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  roosyncDashboard,
  resetCondenseCircuitBreaker,
  resetTruncationAlertLimiterForTest,
  resetFallbackTruncationCountersForTest,
  computePrimaryAttemptTimeoutMs,
  fallbackApiFormat,
  extractAnthropicText,
} from '../dashboard.js';

const mockPrimaryCreate = vi.fn();
const mockGetPrimaryClient = vi.fn();
const mockFallbackCreate = vi.fn();
const mockFallbackPost = vi.fn();
const mockGetFallbackClient = vi.fn();
let fallbackModelId = 'claude-sonnet-5-5';

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetPrimaryClient(),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-primary-model',
  getFallbackChatOpenAIClient: () => mockGetFallbackClient(),
  getFallbackLLMModelId: () => fallbackModelId,
}));

const testTmpBase = path.join(os.tmpdir(), 'dashboard-claudish-fallback-');

/** Primary refused with a non-retryable 401: the condensers go straight to the cloud tier. */
const primaryUnauthorized = (): void => {
  mockGetPrimaryClient.mockReturnValue({ chat: { completions: { create: mockPrimaryCreate } } });
  mockPrimaryCreate.mockRejectedValue(Object.assign(new Error('401 Unauthorized'), { status: 401 }));
};

const THINKING = 'SCRATCHPAD-should-never-reach-the-dashboard';
const anthropicAnswer = (text: string) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: THINKING },
    { type: 'text', text },
  ],
  stop_reason: 'end_turn',
});

/** Appends until a pass condenses; returns that pass's diagnostic outcomes. */
const driveOneCondensation = async (): Promise<string[]> => {
  const filler = 'X'.repeat(3000);
  for (let i = 0; i < 20; i++) {
    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: `${filler} message-${i}`,
    }) as { condensed?: boolean; condenseDiagnostic?: Array<{ outcome: string }> };
    if (result.condensed) return (result.condenseDiagnostic ?? []).map(d => d.outcome);
  }
  throw new Error('dashboard never condensed within 20 appends');
};

describe('#3962 piste 4 — cloud tier through claudish roles', { timeout: 120000 }, () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    process.env.DASHBOARD_CONDENSE_STATUS_MODE = 'always';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_API_BASE_URL;
    delete process.env.CONDENSE_CLOUD_RESERVE_MS;
    delete process.env.CONDENSE_PASS_DEADLINE_MS;
    delete process.env.FALLBACK_API_FORMAT;
    delete process.env.FALLBACK_TIMEOUT_MIN_MS;
    delete process.env.FALLBACK_TIMEOUT_MS_PER_KB;
    delete process.env.FALLBACK_TIMEOUT_MS;
    fallbackModelId = 'claude-sonnet-5-5';
    mockPrimaryCreate.mockReset();
    mockGetPrimaryClient.mockReset();
    mockFallbackCreate.mockReset();
    mockFallbackPost.mockReset();
    mockGetFallbackClient.mockReset();
    resetTruncationAlertLimiterForTest();
    resetCondenseCircuitBreaker();
    resetFallbackTruncationCountersForTest();
  });

  afterEach(async () => {
    delete process.env.DASHBOARD_CONDENSE_STATUS_MODE;
    delete process.env.CONDENSE_CLOUD_RESERVE_MS;
    delete process.env.CONDENSE_PASS_DEADLINE_MS;
    delete process.env.FALLBACK_API_FORMAT;
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  it('(c1) wire format selection and text-only extraction', () => {
    expect(fallbackApiFormat()).toBe('openai');
    process.env.FALLBACK_API_FORMAT = ' Anthropic ';
    expect(fallbackApiFormat()).toBe('anthropic');
    process.env.FALLBACK_API_FORMAT = 'openai';
    expect(fallbackApiFormat()).toBe('openai');
    process.env.FALLBACK_API_FORMAT = 'messages';
    expect(fallbackApiFormat()).toBe('openai'); // unknown value keeps the historical route

    expect(extractAnthropicText(anthropicAnswer('Résumé.'))).toBe('Résumé.');
    expect(extractAnthropicText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('ab');
    expect(extractAnthropicText({ content: [{ type: 'thinking' }] })).toBe('');
    expect(extractAnthropicText({})).toBe('');
    expect(extractAnthropicText(null)).toBe('');
  });

  it('(c2) the default cloud reserve is sized to the prompt, 35-82 s; an explicit value wins', () => {
    const slice = (promptBytes?: number): number => {
      const deadline = Date.now() + 165000;
      const t = computePrimaryAttemptTimeoutMs(720000, deadline, promptBytes);
      expect(t).not.toBeNull();
      return 165000 - t!; // ≈ the reserve held back (± a few ms of clock)
    };
    const near = (actual: number, expected: number): void => {
      expect(actual).toBeGreaterThanOrEqual(expected - 50);
      expect(actual).toBeLessThanOrEqual(expected + 50);
    };

    near(slice(), 35000);              // no prompt size → historical fixed reserve
    near(slice(0), 35000);             // 30 s floor + 5 s skip floor
    near(slice(1024), 35900);          // 30 s + 0.9 s + 5 s
    near(slice(30 * 1024), 62000);     // 30 s + 27 s + 5 s
    near(slice(400 * 1024), 82000);    // capped: the primary keeps half of the pass

    process.env.FALLBACK_TIMEOUT_MIN_MS = '60000'; // one knob drives attempt AND reserve
    near(slice(10 * 1024), 74000);     // 60 s + 9 s + 5 s
    delete process.env.FALLBACK_TIMEOUT_MIN_MS;

    process.env.CONDENSE_CLOUD_RESERVE_MS = '75000';
    near(slice(400 * 1024), 75000);    // explicit operator value as-is
    process.env.CONDENSE_CLOUD_RESERVE_MS = '0';
    near(slice(30 * 1024), 0);
  });

  it('(c3) Anthropic route: POST /messages on the fallback client salvages the pass from the text block', async () => {
    process.env.FALLBACK_API_FORMAT = 'anthropic';
    primaryUnauthorized();
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
      post: mockFallbackPost,
    });
    mockFallbackPost.mockResolvedValue(anthropicAnswer('Résumé claudish de secours — synthèse complète des messages archivés.'));

    await roosyncDashboard({ action: 'write', type: 'workspace', content: '# Init' });
    const outcomes = await driveOneCondensation();

    expect(outcomes).toContain('fallback-cloud');
    expect(outcomes).not.toContain('fallback-truncated');
    expect(mockFallbackCreate).not.toHaveBeenCalled();
    expect(mockFallbackPost).toHaveBeenCalled();
    for (const [route, options] of mockFallbackPost.mock.calls) {
      expect(route).toBe('/messages');
      expect(options.body.model).toBe('claude-sonnet-5-5');
      expect(typeof options.body.system).toBe('string');
      expect(options.body.messages).toHaveLength(1);
      expect(options.body.messages[0].role).toBe('user');
      expect(options.body.messages[0].content.startsWith('/no_think')).toBe(false);
      expect(options.body.max_tokens).toBeGreaterThan(0);
      expect(options.body.thinking).toEqual({ type: 'disabled' });
      expect(options.headers['anthropic-version']).toBe('2023-06-01');
      expect(options.timeout).toBeGreaterThanOrEqual(30000);
    }

    const md = await readFile(path.join(tmpDir, 'dashboards', 'workspace-test-workspace.md'), 'utf8');
    expect(md).toContain('Résumé claudish de secours');
    expect(md).not.toContain(THINKING);
  });

  it('(c3b) OpenAI route unchanged when the format is unset', async () => {
    fallbackModelId = 'glm-5.3-flash';
    primaryUnauthorized();
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
      post: mockFallbackPost,
    });
    mockFallbackCreate.mockResolvedValue({ choices: [{ message: { content: 'Résumé OpenAI de secours — synthèse des messages archivés.' } }] });

    await roosyncDashboard({ action: 'write', type: 'workspace', content: '# Init' });
    const outcomes = await driveOneCondensation();

    expect(outcomes).toContain('fallback-cloud');
    expect(mockFallbackPost).not.toHaveBeenCalled();
    expect(mockFallbackCreate).toHaveBeenCalled();
    expect(mockFallbackCreate.mock.calls[0][0].messages[1].content.startsWith('/no_think')).toBe(true);
  });

  it('(c4) three rescued passes open the breaker; the fourth skips the primary', async () => {
    process.env.FALLBACK_API_FORMAT = 'anthropic';
    primaryUnauthorized();
    mockGetFallbackClient.mockReturnValue({
      chat: { completions: { create: mockFallbackCreate } },
      post: mockFallbackPost,
    });
    mockFallbackPost.mockResolvedValue(anthropicAnswer('Résumé claudish de secours — synthèse complète des messages archivés.'));

    await roosyncDashboard({ action: 'write', type: 'workspace', content: '# Init' });
    for (let pass = 1; pass <= 3; pass++) {
      expect(await driveOneCondensation()).toContain('fallback-cloud');
    }
    const primaryCallsAfterThree = mockPrimaryCreate.mock.calls.length;
    expect(primaryCallsAfterThree).toBeGreaterThan(0);

    const fourth = await driveOneCondensation();
    expect(fourth).toContain('fallback-cloud');
    // Breaker OPEN: the fourth pass went to the cloud tier without touching the primary.
    expect(mockPrimaryCreate.mock.calls.length).toBe(primaryCallsAfterThree);
  });
});
