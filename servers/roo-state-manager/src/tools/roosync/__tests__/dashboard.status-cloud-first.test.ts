/**
 * #4434 (04/11) — the status leg goes to the cloud tier FIRST.
 *
 * Measured on ai-01, 02-04/11: 52 primary status calls, 0 succeeded (38 timed out at
 * the ~90 s slice the pass deadline leaves). The summary leg keeps the primary.
 *
 * Contracts pinned here:
 *   (a) default: the status request never reaches the primary while the summary does;
 *       the pass is `condensed` (a route, not a rescue), the archive says
 *       `statusCloudFirst: true`, the notice names the cloud-first route, and the
 *       append message does not claim "primary LLM down".
 *   (b) lever spellings: `0`, `00`, `0.0`, ` 0 ` turn it off; unset, empty, `1`,
 *       `abc`, `true` keep it on.
 *   (c) `CONDENSE_STATUS_CLOUD_FIRST=0` restores primary-first.
 *   (d) no cloud tier on the seat → the status leg falls through to the primary.
 *   (e) the cloud tier fails → `cloud-first-failed`, the primary is NOT tried, floor.
 *   (f) breaker: cloud-first status + primary summary vouches for the primary
 *       (2 seeded failures are cleared, the breaker stays closed).
 *   (g) breaker: cloud-first-failed status + primary summary is not a primary failure.
 *   (h) breaker: a summary the cloud had to rescue still counts as a primary failure.
 *   (i) truncation: cloud-first status + summary dead on both tiers → the `-fallback`
 *       archive says `statusCloudFirst: true`, and the notice and append suffix name
 *       the route (`ok-cloud-first`), never `ok-with-fallback`.
 *   (j) `legOutcomeLabel` relabels only a cloud-first ok; a real rescue keeps its name.
 *   (k) #4536: (a) replayed on the DETACHED default (no CONDENSE_DETACHED pin) —
 *       the pass telemetry surfaces on the next read via condensationLastOutcome.
 *
 * @module tools/roosync/__tests__/dashboard.status-cloud-first
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { readFileSync } from 'fs';
import {
  roosyncDashboard,
  resetCondenseCircuitBreaker,
  statusCloudFirstEnabled,
  legOutcomeLabel,
  awaitDetachedCondense,
  __condenseBreakerHooks,
} from '../dashboard.js';

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

const testTmpBase = path.join(os.tmpdir(), 'dashboard-status-cloud-first-');

// The summary leg's user prompt, as built by generateLLMSummary.
const isSummaryRequest = (req: any): boolean =>
  JSON.stringify(req?.messages ?? []).includes('messages retirés du dashboard à synthétiser');
// A summary in the imposed format (the cloud chain's summary guard checks the sections).
const summaryAnswer = (label: string): string =>
  `## Résumé\n\n### Thèmes principaux\n- ${label}\n\n### Actions et résultats\n- [DONE] test\n\n### Décisions et métriques\n- none`;
const statusAnswer = (label: string): string => `## Statut\n\n- nominal (${label})`;

const statusCalls = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls.filter((c: any[]) => !isSummaryRequest(c[0]));
const summaryCalls = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls.filter((c: any[]) => isSummaryRequest(c[0]));

function primaryAnswersBothLegs(): void {
  mockGetPrimaryClient.mockReturnValue({ chat: { completions: { create: mockPrimaryCreate } } });
  mockPrimaryCreate.mockImplementation(async (req: any) => ({
    choices: [{ message: { content: isSummaryRequest(req) ? summaryAnswer('primary') : statusAnswer('primary') }, finish_reason: 'stop' }],
  }));
}

function cloudAnswersBothLegs(): void {
  mockGetFallbackClient.mockReturnValue({ chat: { completions: { create: mockFallbackCreate } } });
  mockFallbackCreate.mockImplementation(async (req: any) => ({
    choices: [{ message: { content: isSummaryRequest(req) ? summaryAnswer(`cloud ${req.model}`) : statusAnswer(`cloud ${req.model}`) }, finish_reason: 'stop' }],
  }));
}

// The cloud answers the status leg with content far under the 20 % retention floor:
// a per-model guard rejection, no backoff.
function cloudRejectsTheStatus(): void {
  mockGetFallbackClient.mockReturnValue({ chat: { completions: { create: mockFallbackCreate } } });
  mockFallbackCreate.mockImplementation(async (req: any) => ({
    choices: [{ message: { content: isSummaryRequest(req) ? summaryAnswer(`cloud ${req.model}`) : `## Court\n\n${'c'.repeat(40)}` }, finish_reason: 'stop' }],
  }));
}

function readBreaker(): { consecutiveFailures: number; isOpen: boolean } | null {
  try {
    return JSON.parse(readFileSync(__condenseBreakerHooks.stateFile(), 'utf8'));
  } catch {
    return null;
  }
}

describe('#4434 status leg cloud-first', { timeout: 30000 }, () => {
  let tmpDir: string;

  beforeEach(async () => {
    // #4527: these contracts are the pass's semantics — synchronous path.
    process.env.CONDENSE_DETACHED = '0';
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    // #4205: forced regeneration — the status leg must run on every pass.
    process.env.DASHBOARD_CONDENSE_STATUS_MODE = 'always';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_API_BASE_URL;
    delete process.env.FALLBACK_API_FORMAT;
    delete process.env.CONDENSE_STATUS_CLOUD_FIRST;
    mockGetPrimaryClient.mockImplementation(() => { throw new Error('No chat API key configured'); });
    mockPrimaryCreate.mockReset();
    mockGetFallbackClient.mockImplementation(() => null);
    mockFallbackCreate.mockReset();
    mockFallbackModelId.mockImplementation(() => 'glm-5.3-flash');
    resetCondenseCircuitBreaker();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
    delete process.env.DASHBOARD_CONDENSE_STATUS_MODE;
    delete process.env.CONDENSE_STATUS_CLOUD_FIRST;
    resetCondenseCircuitBreaker();
  });

  async function fillUntilCondensed(initialStatus = '# Init'): Promise<any> {
    await roosyncDashboard({ action: 'write', type: 'global', content: initialStatus });
    const filler = 'X'.repeat(3000);
    let condensedResult: any = null;
    for (let i = 0; i < 20; i++) {
      const result = await roosyncDashboard({ action: 'append', type: 'global', content: `${filler} message-${i}` });
      if ((result as any).condensed && !condensedResult) condensedResult = result;
    }
    expect(condensedResult).not.toBeNull();
    return condensedResult;
  }

  async function readArchives(kind: 'llm' | 'fallback'): Promise<string[]> {
    const dir = path.join(tmpDir, 'dashboards', 'archive');
    const names = (await readdir(dir)).filter(n => (kind === 'fallback') === n.endsWith('-fallback.md'));
    // yaml.dump folds long scalars across lines — compare the unfolded text.
    return Promise.all(names.map(async n => (await readFile(path.join(dir, n), 'utf8')).replace(/\n\s+/g, ' ')));
  }

  it('(a) default: status to the cloud, summary to the primary, an honest `condensed` pass', async () => {
    primaryAnswersBothLegs();
    cloudAnswersBothLegs();

    const result = await fillUntilCondensed();

    expect(statusCalls(mockPrimaryCreate)).toHaveLength(0);
    expect(summaryCalls(mockPrimaryCreate).length).toBeGreaterThanOrEqual(1);
    expect(statusCalls(mockFallbackCreate).length).toBeGreaterThanOrEqual(1);
    expect(summaryCalls(mockFallbackCreate)).toHaveLength(0);

    const diags = result.condenseDiagnostic as any[];
    expect(diags.some(d => d.outcome === 'condensed')).toBe(true);
    expect(diags.some(d => d.outcome === 'fallback-cloud')).toBe(false);
    expect(result.message).not.toContain('primary LLM down');

    const archives = await readArchives('llm');
    expect(archives.length).toBeGreaterThanOrEqual(1);
    expect(archives[0]).toContain('statusCloudFirst: true');
    expect(archives[0]).toContain('statusOutcome: ok-with-fallback');
    expect(archives[0]).toContain('summaryOutcome: ok');
    expect(archives[0]).not.toContain('summaryFallbackModel');

    const md = await readFile(path.join(tmpDir, 'dashboards', 'global.md'), 'utf8');
    expect(md).toContain('Statut mis à jour via cloud (cloud-first #4434)');
    expect(md).not.toContain('Statut mis à jour via fallback cloud');
    expect(md).toContain('résumé LLM généré (');
  });

  it('(b) lever spellings: only a numeric zero turns it off', () => {
    for (const off of ['0', '00', '0.0', ' 0 ']) {
      process.env.CONDENSE_STATUS_CLOUD_FIRST = off;
      expect(statusCloudFirstEnabled(), `'${off}' should turn it off`).toBe(false);
    }
    for (const on of ['', '   ', '1', 'abc', 'true']) {
      process.env.CONDENSE_STATUS_CLOUD_FIRST = on;
      expect(statusCloudFirstEnabled(), `'${on}' should keep it on`).toBe(true);
    }
    delete process.env.CONDENSE_STATUS_CLOUD_FIRST;
    expect(statusCloudFirstEnabled()).toBe(true);
  });

  it('(c) CONDENSE_STATUS_CLOUD_FIRST=0 → the status leg goes to the primary first', async () => {
    process.env.CONDENSE_STATUS_CLOUD_FIRST = '0';
    primaryAnswersBothLegs();
    cloudAnswersBothLegs();

    const result = await fillUntilCondensed();

    expect(statusCalls(mockPrimaryCreate).length).toBeGreaterThanOrEqual(1);
    expect(mockFallbackCreate).not.toHaveBeenCalled();
    expect((result.condenseDiagnostic as any[]).some(d => d.outcome === 'condensed')).toBe(true);
    const archives = await readArchives('llm');
    expect(archives[0]).toContain('statusOutcome: ok');
    expect(archives[0]).not.toContain('statusCloudFirst');
  });

  it('(d) no cloud tier on the seat → the status leg falls through to the primary', async () => {
    primaryAnswersBothLegs();
    // mockGetFallbackClient stays null (beforeEach): unprovisioned seat.

    const result = await fillUntilCondensed();

    expect(statusCalls(mockPrimaryCreate).length).toBeGreaterThanOrEqual(1);
    expect((result.condenseDiagnostic as any[]).some(d => d.outcome === 'condensed')).toBe(true);
    const archives = await readArchives('llm');
    expect(archives[0]).toContain('statusOutcome: ok');
    expect(archives[0]).not.toContain('statusCloudFirst');
  });

  it('(e) the cloud tier fails the status → cloud-first-failed, primary not tried, floor', async () => {
    primaryAnswersBothLegs();
    cloudRejectsTheStatus();

    const result = await fillUntilCondensed(`# Statut\n\n${'S'.repeat(1000)}`);

    expect(statusCalls(mockPrimaryCreate)).toHaveLength(0);
    expect(summaryCalls(mockPrimaryCreate).length).toBeGreaterThanOrEqual(1);
    expect((result.condenseDiagnostic as any[]).some(d => d.outcome === 'fallback-truncated')).toBe(true);
    const archives = await readArchives('fallback');
    expect(archives.length).toBeGreaterThanOrEqual(1);
    expect(archives[0]).toContain('statusOutcome: cloud-first-failed');
    expect(archives[0]).toContain('summaryOutcome: ok');
  });

  it('(f) breaker: cloud-first status + primary summary clears two seeded failures', async () => {
    __condenseBreakerHooks.recordFailure();
    __condenseBreakerHooks.recordFailure();
    expect(readBreaker()?.consecutiveFailures).toBe(2);
    primaryAnswersBothLegs();
    cloudAnswersBothLegs();

    await fillUntilCondensed();

    expect(__condenseBreakerHooks.shouldBypass()).toBe(false);
    expect(readBreaker()?.consecutiveFailures).toBe(0);
  });

  it('(g) breaker: a cloud-first status that failed is not a primary failure', async () => {
    __condenseBreakerHooks.recordFailure();
    __condenseBreakerHooks.recordFailure();
    primaryAnswersBothLegs();
    cloudRejectsTheStatus();

    await fillUntilCondensed(`# Statut\n\n${'S'.repeat(1000)}`);

    expect(__condenseBreakerHooks.shouldBypass()).toBe(false);
    expect(readBreaker()?.consecutiveFailures).toBe(0);
  });

  it('(h) breaker: a summary the cloud had to rescue still counts against the primary', async () => {
    __condenseBreakerHooks.recordFailure();
    __condenseBreakerHooks.recordFailure();
    // Primary client cannot init (beforeEach default): the summary leg is rescued.
    cloudAnswersBothLegs();

    const result = await fillUntilCondensed();

    expect(summaryCalls(mockFallbackCreate).length).toBeGreaterThanOrEqual(1);
    expect((result.condenseDiagnostic as any[]).some(d => d.outcome === 'fallback-cloud')).toBe(true);
    expect(__condenseBreakerHooks.shouldBypass()).toBe(true);
  });

  it('(i) truncation: a cloud-first status next to a dead summary is named as a route, not a rescue', async () => {
    // Primary client cannot init (beforeEach default). The cloud answers the status and
    // returns empty content for the summary (non-retryable): the summary dies on both tiers.
    mockGetFallbackClient.mockReturnValue({ chat: { completions: { create: mockFallbackCreate } } });
    mockFallbackCreate.mockImplementation(async (req: any) => ({
      choices: [{ message: { content: isSummaryRequest(req) ? '' : statusAnswer(`cloud ${req.model}`) }, finish_reason: 'stop' }],
    }));

    const result = await fillUntilCondensed();

    expect(statusCalls(mockFallbackCreate).length).toBeGreaterThanOrEqual(1);
    expect((result.condenseDiagnostic as any[]).some(d => d.outcome === 'fallback-truncated')).toBe(true);

    const archives = await readArchives('fallback');
    expect(archives.length).toBeGreaterThanOrEqual(1);
    expect(archives[0]).toContain('statusCloudFirst: true');
    expect(archives[0]).toContain('statusOutcome: ok-with-fallback');

    const md = await readFile(path.join(tmpDir, 'dashboards', 'global.md'), 'utf8');
    expect(md).toContain('Status: ok-cloud-first (0 attempts');
    expect(md).not.toContain('Status: ok-with-fallback');
    expect(result.message).toContain('status=ok-cloud-first×0');
    expect(result.message).not.toContain('status=ok-with-fallback');

    // The summary failed on the primary: the breaker counts it.
    expect(readBreaker()?.consecutiveFailures ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('(j) legOutcomeLabel: only a cloud-first ok is relabelled; a real rescue keeps its name', () => {
    const base = { attempts: 0, elapsedMs: 0, nullCount: 0, errorCount: 0, timeoutCount: 0 };
    expect(legOutcomeLabel({ ...base, finalOutcome: 'ok-with-fallback', cloudFirst: true } as any)).toBe('ok-cloud-first');
    expect(legOutcomeLabel({ ...base, finalOutcome: 'ok-with-fallback' } as any)).toBe('ok-with-fallback');
    expect(legOutcomeLabel({ ...base, finalOutcome: 'cloud-first-failed', cloudFirst: true } as any)).toBe('cloud-first-failed');
    expect(legOutcomeLabel({ ...base, finalOutcome: 'timeout' } as any)).toBe('timeout');
  });

  it('(k) #4536 replay of (a) on the DETACHED default (CONDENSE_DETACHED unset): the telemetry surfaces on the next read', async () => {
    // #4536 — la voie de production (détachée) doit garder sa garde de
    // télémétrie : le reste de ce fichier épinglant CONDENSE_DETACHED=0,
    // (a) est rejoué ici SANS épingle, et la télémétrie lue via le registre
    // des issues détachées (condensationLastOutcome) au lieu de
    // condenseDiagnostic (vide sur la voie détachée).
    delete process.env.CONDENSE_DETACHED;
    primaryAnswersBothLegs();
    cloudAnswersBothLegs();

    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    const filler = 'X'.repeat(3000);
    let deferredKey: string | null = null;
    for (let i = 0; i < 20; i++) {
      const result = await roosyncDashboard({ action: 'append', type: 'global', content: `${filler} message-${i}` });
      if ((result as any).condensationDeferred && !deferredKey) deferredKey = result.key;
    }
    expect(deferredKey).not.toBeNull();
    await awaitDetachedCondense(deferredKey!);

    // (a) toujours vrai sur la voie détachée : statut au cloud, résumé au primaire.
    expect(statusCalls(mockPrimaryCreate)).toHaveLength(0);
    expect(summaryCalls(mockPrimaryCreate).length).toBeGreaterThanOrEqual(1);
    expect(statusCalls(mockFallbackCreate).length).toBeGreaterThanOrEqual(1);

    // La télémétrie #4434 survit au détachement : elle remonte à la lecture
    // suivante via le verdict retenu, diagnostic complet compris.
    const read = await roosyncDashboard({ action: 'read', type: 'global', section: 'status' });
    const last = (read as any).condensationLastOutcome;
    expect(last).toBeDefined();
    expect(last.outcome).toBe('ok');
    expect(last.diag.outcome).toBe('condensed');
    expect(last.diag.llm?.status?.cloudFirst).toBe(true);
    expect(last.diag.llm?.status?.finalOutcome).toBe('ok-with-fallback');
    expect(last.diag.llm?.summary?.finalOutcome).toBe('ok');
  });
});
