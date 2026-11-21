/**
 * #4434 summary-leg cutover — cloud-first routing (verdict c.6940185160 §4, 17/11).
 *
 * The summary leg goes to the cloud tier (hub, glm-4.7) BEFORE the primary, with
 * the local primary as the FALLBACK — unlike the status leg, whose cloud-first
 * failure takes the floor (0/52 primary successes measured 02-04/11; the summary
 * leg's primary answered 10/38 there and 5/5 in the 17/11 G4-event replay, both
 * arms 5/5 format-ok with stop finishes).
 *
 *   (s1) summaryCloudFirstEnabled(): default on; CONDENSE_SUMMARY_CLOUD_FIRST=0
 *        (any numeric zero) restores primary-first.
 *   (s2) cloud-first route: a configured cloud tier answers the summary BEFORE
 *        the primary is called for that leg — the archive frontmatter carries
 *        summaryCloudFirst + summaryFallbackModel, the notice says
 *        "cloud-first #4434", and the pass outcome is 'condensed' (a route,
 *        not a rescue).
 *   (s3) fall-through: a configured cloud tier that FAILS hands the summary to
 *        the primary (the verdict's "swift local en repli") — primary called,
 *        cloud text absent, outcome 'condensed'.
 *   (s4) kill-switch: CONDENSE_SUMMARY_CLOUD_FIRST=0 keeps the summary on the
 *        primary even with a configured, answering cloud tier.
 *
 * @module tools/roosync/__tests__/dashboard.summary-cloud-first
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  roosyncDashboard,
  resetCondenseCircuitBreaker,
  resetTruncationAlertLimiterForTest,
  resetFallbackTruncationCountersForTest,
  summaryCloudFirstEnabled,
} from '../dashboard.js';

const mockPrimaryCreate = vi.fn();
const mockGetPrimaryClient = vi.fn();
const mockFallbackCreate = vi.fn();
const mockGetFallbackClient = vi.fn();
let fallbackModelId = 'glm-4.7';

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetPrimaryClient(),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-primary-model',
  getFallbackChatOpenAIClient: () => mockGetFallbackClient(),
  getFallbackLLMModelId: () => fallbackModelId,
}));

const testTmpBase = path.join(os.tmpdir(), 'dashboard-summary-cloud-first-');

// A summary in the prompt's imposed format (validateSummaryCompleteness rejects
// a missing section); the status leg accepts it too (no model-failure shape).
const formatted = (label: string): string =>
  `## Résumé\n\n### Thèmes principaux\n- ${label}\n\n### Actions et résultats\n- [DONE] test\n\n### Décisions et métriques\n- none\n\n### États transverses\n- aucun`;

const primaryAnswers = (): void => {
  mockGetPrimaryClient.mockReturnValue({ chat: { completions: { create: mockPrimaryCreate } } });
  // The primary distinguishes the legs by system prompt (summary vs status
  // generator prompts differ from their first line) so the assertions can
  // tell WHICH leg the primary served.
  mockPrimaryCreate.mockImplementation(async (params: { messages: Array<{ role: string; content: string }> }) => {
    const system = params.messages[0]?.content ?? '';
    const isSummary = system.startsWith('Tu es un expert en synthèse de communications');
    return {
      choices: [{ message: { content: formatted(isSummary ? 'RÉSUMÉ PRIMAIRE — swift local' : 'STATUT PRIMAIRE — swift local') }, finish_reason: 'stop' }],
    };
  });
};

const cloudAnswers = (): void => {
  mockGetFallbackClient.mockReturnValue({ chat: { completions: { create: mockFallbackCreate } } });
  mockFallbackCreate.mockImplementation(async () => ({
    choices: [{ message: { content: formatted('RÉSUMÉ CLOUD — hub glm-4.7') }, finish_reason: 'stop' }],
  }));
};

/** Cloud tier configured but failing fast (non-retryable 401, single model). */
const cloudUnauthorized = (): void => {
  mockGetFallbackClient.mockReturnValue({ chat: { completions: { create: mockFallbackCreate } } });
  mockFallbackCreate.mockRejectedValue(Object.assign(new Error('401 Unauthorized'), { status: 401 }));
};

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

/** Frontmatter text of the latest archive of this pass's key. */
const latestArchiveFrontmatter = async (tmpDir: string): Promise<string> => {
  const dir = path.join(tmpDir, 'dashboards', 'archive');
  const names = (await readdir(dir)).filter(n => n.startsWith('workspace-test-workspace-')).sort();
  const raw = await readFile(path.join(dir, names[names.length - 1]), 'utf8');
  return raw.split('---\n')[1] ?? '';
};

describe('#4434 summary-leg cutover — cloud-first routing', { timeout: 120000 }, () => {
  let tmpDir: string;

  beforeEach(async () => {
    process.env.CONDENSE_DETACHED = '0';
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
    delete process.env.CONDENSE_STATUS_CLOUD_FIRST;
    delete process.env.CONDENSE_SUMMARY_CLOUD_FIRST;
    delete process.env.FALLBACK_API_FORMAT;
    fallbackModelId = 'glm-4.7';
    mockPrimaryCreate.mockReset();
    mockGetPrimaryClient.mockReset();
    mockFallbackCreate.mockReset();
    mockGetFallbackClient.mockReset();
    resetTruncationAlertLimiterForTest();
    resetCondenseCircuitBreaker();
    resetFallbackTruncationCountersForTest();
  });

  afterEach(async () => {
    delete process.env.DASHBOARD_CONDENSE_STATUS_MODE;
    delete process.env.CONDENSE_CLOUD_RESERVE_MS;
    delete process.env.CONDENSE_PASS_DEADLINE_MS;
    delete process.env.CONDENSE_STATUS_CLOUD_FIRST;
    delete process.env.CONDENSE_SUMMARY_CLOUD_FIRST;
    delete process.env.FALLBACK_API_FORMAT;
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  it('(s1) summaryCloudFirstEnabled: default on, numeric-zero off', () => {
    expect(summaryCloudFirstEnabled()).toBe(true);
    for (const zero of ['0', '0.0', '00']) {
      process.env.CONDENSE_SUMMARY_CLOUD_FIRST = zero;
      expect(summaryCloudFirstEnabled()).toBe(false);
    }
    process.env.CONDENSE_SUMMARY_CLOUD_FIRST = '1';
    expect(summaryCloudFirstEnabled()).toBe(true);
    process.env.CONDENSE_SUMMARY_CLOUD_FIRST = '';
    expect(summaryCloudFirstEnabled()).toBe(true); // empty = unset
  });

  it('(s2) cloud-first: the cloud tier serves the summary before the primary is called for it', async () => {
    // Pin the STATUS leg to primary-first so any primary call in this pass is the
    // status leg's — the summary must NOT reach the primary (cloud went first).
    process.env.CONDENSE_STATUS_CLOUD_FIRST = '0';
    primaryAnswers();
    cloudAnswers();

    await roosyncDashboard({ action: 'write', type: 'workspace', content: '# Init' });
    const outcomes = await driveOneCondensation();

    // Route, not rescue: no 'fallback-cloud' when both legs succeeded on their routes.
    expect(outcomes).toContain('condensed');
    expect(outcomes).not.toContain('fallback-cloud');

    // The dashboard carries the CLOUD summary text, not the primary's.
    const md = await readFile(path.join(tmpDir, 'dashboards', 'workspace-test-workspace.md'), 'utf8');
    expect(md).toContain('RÉSUMÉ CLOUD — hub glm-4.7');
    expect(md).not.toContain('RÉSUMÉ PRIMAIRE — swift local');
    // The CONDENSATION notice names the cloud-first route.
    expect(md).toContain('cloud-first #4434');

    // Frontmatter: the route and the model survive the pass on disk (#4434 G2/G4).
    const fm = await latestArchiveFrontmatter(tmpDir);
    expect(fm).toContain('summaryCloudFirst: true');
    expect(fm).toContain('summaryFallbackModel: glm-4.7');
  });

  it('(s3) cloud-first failure falls through to the primary (local fallback)', async () => {
    process.env.CONDENSE_STATUS_CLOUD_FIRST = '0';
    primaryAnswers();
    cloudUnauthorized();

    await roosyncDashboard({ action: 'write', type: 'workspace', content: '# Init' });
    const outcomes = await driveOneCondensation();

    expect(outcomes).toContain('condensed');
    expect(outcomes).not.toContain('fallback-cloud');
    // The primary WAS exercised (it took the summary after the cloud failed).
    expect(mockPrimaryCreate.mock.calls.length).toBeGreaterThan(0);
    expect(mockFallbackCreate.mock.calls.length).toBeGreaterThan(0); // the cloud was tried first

    const md = await readFile(path.join(tmpDir, 'dashboards', 'workspace-test-workspace.md'), 'utf8');
    expect(md).toContain('RÉSUMÉ PRIMAIRE — swift local');
    // No cloud-first claim on a pass the primary served.
    const fm = await latestArchiveFrontmatter(tmpDir);
    expect(fm).not.toContain('summaryCloudFirst: true');
  });

  it('(s4) kill-switch: CONDENSE_SUMMARY_CLOUD_FIRST=0 keeps the summary on the primary', async () => {
    process.env.CONDENSE_STATUS_CLOUD_FIRST = '0';
    process.env.CONDENSE_SUMMARY_CLOUD_FIRST = '0';
    primaryAnswers();
    cloudAnswers();

    await roosyncDashboard({ action: 'write', type: 'workspace', content: '# Init' });
    const outcomes = await driveOneCondensation();

    expect(outcomes).toContain('condensed');
    expect(outcomes).not.toContain('fallback-cloud');
    // No cloud call at all: both legs primary-first and the primary answered.
    expect(mockFallbackCreate).not.toHaveBeenCalled();
    const md = await readFile(path.join(tmpDir, 'dashboards', 'workspace-test-workspace.md'), 'utf8');
    expect(md).toContain('RÉSUMÉ PRIMAIRE — swift local');
  });
});
