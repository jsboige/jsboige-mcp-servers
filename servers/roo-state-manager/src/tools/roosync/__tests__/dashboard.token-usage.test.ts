/**
 * #4434 G2 — per-leg token accounting for the condensation LLM calls.
 *
 * G2 (issue body, "5 grains ordonnés"): "journaliser les tokens d'entrée et de
 * sortie du résumé et du statut, en principal et en repli". The measurement the
 * cost axis reads (claudish#713 measured the fallback billed per-use at 2.8 %
 * cache on the hub; the 24h publish needs the volume per leg, per tier).
 *
 * Covered paths:
 *   (t1) primary answers both legs WITH usage → `primaryTokens` per leg, values
 *        distinct per leg (proves the accounting is per-leg, not per-pass)
 *   (t2) primary answers WITHOUT usage (silent gateway) → fields stay unset,
 *        the pass still condenses — absence of `usage` is not a failure
 *   (t3) primary 401 → cloud fallback (OpenAI-compat) answers with usage →
 *        `fallbackTokens` on both legs + the ARCHIVE FRONTMATTER carries
 *        `summaryFallbackTokens`/`statusFallbackTokens` (the proof must survive
 *        the pass on disk, same doctrine as statusFallbackModel #3962)
 *   (t4) anthropic wire format (`FALLBACK_API_FORMAT=anthropic`) names usage
 *        `input_tokens`/`output_tokens` → extracted all the same
 *   (t5) primary answers null-content WITH usage (thinking ate max_tokens) →
 *        `primaryTokens` is stamped even on the failed leg: the input is spent
 *   (t6) cloud answers empty-content WITH usage (billed 200, rejected by the
 *        chain) → `fallbackTokens` is stamped on the failed legs too: a rejected
 *        round-trip is still a billed one (claudish#713: 2 empty bodies in 3)
 *   (t7) primary null-content retry then success → `primaryTokens` ACCUMULATED
 *        across attempts (review 13/11): billed retries add, not overwrite
 *
 * @module tools/roosync/__tests__/dashboard.token-usage
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  roosyncDashboard,
  resetCondenseCircuitBreaker,
} from '../dashboard.js';

// Primary chat client + create — lazy indirection so each test can swap behaviour.
const mockPrimaryCreate = vi.fn();
const mockGetPrimaryClient = vi.fn();
// Fallback (cloud) chat client: OpenAI-compat `create` and anthropic `post`.
const mockFallbackCreate = vi.fn();
const mockFallbackPost = vi.fn();
const mockGetFallbackClient = vi.fn();
const mockFallbackModelId = vi.fn(() => 'glm-5.3-flash');

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetPrimaryClient(),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-primary-model',
  getFallbackChatOpenAIClient: () => mockGetFallbackClient(),
  getFallbackLLMModelId: () => mockFallbackModelId(),
}));

const testTmpBase = path.join(os.tmpdir(), 'dashboard-token-usage-');

// A cloud/primary answer in the summary prompt's imposed format: passes BOTH
// the summary completeness guard and the status retention guard (same trick as
// dashboard.fallback-cloud.test.ts — one mock answers both legs).
const formatted = (label: string): string =>
  `## Résumé\n\n### Thèmes principaux\n- ${label}\n\n### Actions et résultats\n- [DONE] test\n\n### Décisions et métriques\n- none`;

// The summary leg's user prompt, as built by generateLLMSummary — the discriminator
// that lets one mockImplementation answer each leg with its OWN usage numbers.
const isSummaryRequest = (req: any): boolean =>
  JSON.stringify(req?.messages ?? []).includes('messages retirés du dashboard à synthétiser');

const chatAnswer = (label: string, usage?: { prompt_tokens: number; completion_tokens: number }) => ({
  choices: [{ message: { content: formatted(label) }, finish_reason: 'stop' }],
  ...(usage ? { usage } : {}),
});

describe('#4434 G2 — per-leg token accounting (primary + fallback tiers)', { timeout: 120000 }, () => {
  let tmpDir: string;

  beforeEach(async () => {
    // #4527 — the suite tests the pass SEMANTICS: synchronous path kept.
    process.env.CONDENSE_DETACHED = '0';
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    // Force status regeneration — without this, filler without state signals
    // skips the status leg (#4205) and primaryTokens.status never exists.
    process.env.DASHBOARD_CONDENSE_STATUS_MODE = 'always';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_API_BASE_URL;
    delete process.env.CONDENSE_CLOUD_RESERVE_MS;
    delete process.env.CONDENSE_PASS_DEADLINE_MS;
    // #4434: status leg routes cloud-first by default; with the fallback inert
    // (mockGetFallbackClient → null) the leg falls through to the primary.
    delete process.env.CONDENSE_STATUS_CLOUD_FIRST;
    delete process.env.FALLBACK_API_FORMAT;
    // Default: no fallback configured (inert) — tests that need one set it up.
    mockPrimaryCreate.mockReset();
    mockGetPrimaryClient.mockReset();
    mockFallbackCreate.mockReset();
    mockFallbackPost.mockReset();
    mockGetFallbackClient.mockReset();
    mockGetFallbackClient.mockImplementation(() => null);
    mockFallbackModelId.mockImplementation(() => 'glm-5.3-flash');
    resetCondenseCircuitBreaker();
  });

  afterEach(async () => {
    delete process.env.DASHBOARD_CONDENSE_STATUS_MODE;
    delete process.env.CONDENSE_CLOUD_RESERVE_MS;
    delete process.env.CONDENSE_PASS_DEADLINE_MS;
    delete process.env.CONDENSE_STATUS_CLOUD_FIRST;
    delete process.env.FALLBACK_API_FORMAT;
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  /** Appends until a pass condenses; returns that pass's full result. */
  async function driveOneCondensedPass(): Promise<any> {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    const filler = 'X'.repeat(3000);
    for (let i = 0; i < 20; i++) {
      const result = await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: `${filler} message-${i}`,
      });
      if ((result as any).condensed) return result;
    }
    throw new Error('dashboard never condensed within 20 appends');
  }

  it('(t1) primary answers both legs with usage → primaryTokens per leg, distinct values', async () => {
    mockGetPrimaryClient.mockReturnValue({ chat: { completions: { create: mockPrimaryCreate } } });
    // Distinct usage per leg: proves the accounting is per-leg, not per-pass.
    mockPrimaryCreate.mockImplementation(async (req: any) =>
      isSummaryRequest(req)
        ? chatAnswer('summary from primary', { prompt_tokens: 5000, completion_tokens: 400 })
        : chatAnswer('status from primary', { prompt_tokens: 7000, completion_tokens: 900 }),
    );

    const condensed = await driveOneCondensedPass();
    const pass = condensed.condenseDiagnostic.find((d: any) => d.outcome === 'condensed');
    expect(pass).toBeDefined();
    expect(pass.llm.summary.primaryTokens).toEqual({ input: 5000, output: 400 });
    expect(pass.llm.status.primaryTokens).toEqual({ input: 7000, output: 900 });
    // The fallback tier never answered: no fallbackTokens anywhere.
    expect(pass.llm.summary.fallbackTokens).toBeUndefined();
    expect(pass.llm.status.fallbackTokens).toBeUndefined();
  });

  it('(t2) primary answers WITHOUT usage (silent gateway) → fields unset, pass still condenses', async () => {
    mockGetPrimaryClient.mockReturnValue({ chat: { completions: { create: mockPrimaryCreate } } });
    // No `usage` key at all — some gateways omit it.
    mockPrimaryCreate.mockResolvedValue(chatAnswer('primary without usage'));

    const condensed = await driveOneCondensedPass();
    const pass = condensed.condenseDiagnostic.find((d: any) => d.outcome === 'condensed');
    expect(pass).toBeDefined();
    expect(pass.llm.summary.primaryTokens).toBeUndefined();
    expect(pass.llm.status.primaryTokens).toBeUndefined();
  });

  it('(t3) primary 401 → OpenAI-compat fallback with usage → fallbackTokens on both legs + archive frontmatter', async () => {
    // Non-retryable 401: both legs go straight to the cloud tier (status is
    // cloud-first by default; the summary fails over after one attempt).
    mockGetPrimaryClient.mockReturnValue({ chat: { completions: { create: mockPrimaryCreate } } });
    mockPrimaryCreate.mockRejectedValue(Object.assign(new Error('401 Unauthorized'), { status: 401 }));
    mockGetFallbackClient.mockReturnValue({ chat: { completions: { create: mockFallbackCreate } } });
    mockFallbackCreate.mockResolvedValue(
      chatAnswer('salvaged by the cloud', { prompt_tokens: 900, completion_tokens: 120 }),
    );

    const condensed = await driveOneCondensedPass();
    const pass = condensed.condenseDiagnostic.find((d: any) => d.outcome === 'fallback-cloud');
    expect(pass).toBeDefined();
    expect(pass.llm.summary.fallbackTokens).toEqual({ input: 900, output: 120 });
    expect(pass.llm.status.fallbackTokens).toEqual({ input: 900, output: 120 });
    // The primary never answered: no primaryTokens.
    expect(pass.llm.summary.primaryTokens).toBeUndefined();
    expect(pass.llm.status.primaryTokens).toBeUndefined();

    // The proof must survive the pass on disk (#3962 doctrine): the archive
    // frontmatter carries the per-leg token volume for the 24h measure.
    const archiveFiles = (await readdir(path.join(tmpDir, 'dashboards', 'archive')))
      .filter(f => f.endsWith('.md') && !f.endsWith('-fallback.md'));
    expect(archiveFiles.length).toBeGreaterThanOrEqual(1);
    const archiveContent = await readFile(
      path.join(tmpDir, 'dashboards', 'archive', archiveFiles[0]), 'utf8',
    );
    expect(archiveContent).toContain('summaryFallbackTokens');
    expect(archiveContent).toContain('statusFallbackTokens');
    expect(archiveContent).toContain('input: 900');
    expect(archiveContent).toContain('output: 120');
    expect(archiveContent).not.toContain('summaryPrimaryTokens');
    expect(archiveContent).not.toContain('statusPrimaryTokens');
  });

  it('(t4) anthropic wire format: input_tokens/output_tokens extracted as fallbackTokens', async () => {
    process.env.FALLBACK_API_FORMAT = 'anthropic';
    mockGetPrimaryClient.mockReturnValue({ chat: { completions: { create: mockPrimaryCreate } } });
    mockPrimaryCreate.mockRejectedValue(Object.assign(new Error('401 Unauthorized'), { status: 401 }));
    mockGetFallbackClient.mockReturnValue({ post: mockFallbackPost });
    mockFallbackPost.mockResolvedValue({
      content: [{ type: 'text', text: formatted('claudish role answer') }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2100, output_tokens: 260 },
    });

    const condensed = await driveOneCondensedPass();
    const pass = condensed.condenseDiagnostic.find((d: any) => d.outcome === 'fallback-cloud');
    expect(pass).toBeDefined();
    expect(pass.llm.summary.fallbackTokens).toEqual({ input: 2100, output: 260 });
    expect(pass.llm.status.fallbackTokens).toEqual({ input: 2100, output: 260 });
  });

  it('(t5) primary null-content WITH usage (thinking ate max_tokens) → primaryTokens stamped on the failed leg', async () => {
    // Thinking spent the input before the output budget cut the text: the
    // response answers 200 with usage and NO content. The leg ultimately fails
    // (fallback inert → truncation floor), but the spent input must be counted.
    mockGetPrimaryClient.mockReturnValue({ chat: { completions: { create: mockPrimaryCreate } } });
    mockPrimaryCreate.mockResolvedValue({
      choices: [{ message: { content: null }, finish_reason: 'length' }],
      usage: { prompt_tokens: 12345, completion_tokens: 4096 },
    });

    const condensed = await driveOneCondensedPass();
    // Both legs fail null-content with no cloud tier → the truncation floor takes
    // the pass. The diagnostic was populated BEFORE the floor (diagnostic.llm is
    // set right after the parallel calls), so the spent tokens stay quotable.
    const pass = condensed.condenseDiagnostic.find(
      (d: any) => d.outcome === 'fallback-truncated' || d.outcome === 'llm-failed-dedup' || d.outcome === 'llm-failed-injected',
    );
    expect(pass).toBeDefined();
    expect(pass.llm).toBeDefined();
    // Review 13/11: usage ACCUMULATES across the 3 billed null-content attempts
    // (LLM_MAX_RETRIES) — 3 × (12345, 4096) per leg, not the last attempt's value.
    expect(pass.llm.summary.primaryTokens).toEqual({ input: 37035, output: 12288 });
    expect(pass.llm.status.primaryTokens).toEqual({ input: 37035, output: 12288 });
  });

  it('(t6) cloud answers empty-content WITH usage (billed 200, rejected) → fallbackTokens stamped on the failed legs', async () => {
    // claudish#713 measured the hub answering empty two calls out of three: the
    // failed round-trips are billed all the same. The chain fails (non-retryable
    // empty-content), the pass falls to the truncation floor — but the tokens of
    // the answered cloud response must be counted per leg.
    mockGetPrimaryClient.mockReturnValue({ chat: { completions: { create: mockPrimaryCreate } } });
    mockPrimaryCreate.mockRejectedValue(Object.assign(new Error('401 Unauthorized'), { status: 401 }));
    mockGetFallbackClient.mockReturnValue({ chat: { completions: { create: mockFallbackCreate } } });
    mockFallbackCreate.mockResolvedValue({
      choices: [{ message: { content: null }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3000, completion_tokens: 5 },
    });

    const condensed = await driveOneCondensedPass();
    const pass = condensed.condenseDiagnostic.find(
      (d: any) => d.outcome === 'fallback-truncated' || d.outcome === 'llm-failed-dedup' || d.outcome === 'llm-failed-injected',
    );
    expect(pass).toBeDefined();
    expect(pass.llm).toBeDefined();
    expect(pass.llm.summary.fallbackTokens).toEqual({ input: 3000, output: 5 });
    expect(pass.llm.status.fallbackTokens).toEqual({ input: 3000, output: 5 });
    expect(pass.llm.summary.fallbackAttempted).toBe(true);
    expect(String(pass.llm.summary.fallbackError)).toContain('empty-content');
  });

  it('(t7) primary null-content retry then success → usage ACCUMULATED across attempts (review 13/11)', async () => {
    // The exact scenario of the review: attempt 1 answers 200 with usage but no
    // content (thinking overran max_tokens) — billed — attempt 2 succeeds.
    // Overwrite kept only attempt 2's usage; the accumulator adds both.
    mockGetPrimaryClient.mockReturnValue({ chat: { completions: { create: mockPrimaryCreate } } });
    let summaryCalls = 0;
    mockPrimaryCreate.mockImplementation(async (req: any) => {
      if (isSummaryRequest(req)) {
        summaryCalls += 1;
        if (summaryCalls === 1) {
          return {
            choices: [{ message: { content: null }, finish_reason: 'length' }],
            usage: { prompt_tokens: 1000, completion_tokens: 100 },
          };
        }
        return chatAnswer('summary recovered on retry', { prompt_tokens: 2000, completion_tokens: 200 });
      }
      return chatAnswer('status from primary', { prompt_tokens: 7000, completion_tokens: 900 });
    });

    const condensed = await driveOneCondensedPass();
    const pass = condensed.condenseDiagnostic.find((d: any) => d.outcome === 'condensed');
    expect(pass).toBeDefined();
    // The billed retry ADDS: 1000+2000 input, 100+200 output — not just the last.
    expect(pass.llm.summary.primaryTokens).toEqual({ input: 3000, output: 300 });
    // The status leg answered once — its single usage passes through unchanged.
    expect(pass.llm.status.primaryTokens).toEqual({ input: 7000, output: 900 });
  });
});
