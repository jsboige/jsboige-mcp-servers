/**
 * #4434 G7a-3 — the primary fallback and the 5 KB re-condenser carry the summary
 * section contract (hole 1, fold c.7066988306).
 *
 * G7a-1 put the guard in the cloud chain (per-model rejection); two paths could
 * still write a section-less summary as the window's only trace:
 *   1. the PRIMARY local leg: in cloud-first, when the whole cloud chain is
 *      guard-rejected the leg falls through to the primary, which accepted ANY
 *      non-empty answer — the four imposed sections included. On a seat with no
 *      cloud tier, the primary was the ONLY leg, unguarded from the start.
 *   2. the 5 KB re-condenser (condenseTextIfTooLarge): a summary that passed the
 *      guard at generation but exceeded MAX_SUMMARY_SIZE_BYTES could come back
 *      from the shrink pass with « ### États transverses » amputated — silently,
 *      under the cap, looking complete.
 *
 * This file pins the G7a-3 semantics:
 *   - a guard-rejected primary answer RETRIES (bounded), then hands the leg to
 *     the cloud tier if it has not run yet;
 *   - when every tier is exhausted the partial digest is accepted STAMPED
 *     ('ok-guard-rejected' + summaryLegError in the archive frontmatter) rather
 *     than discarded to truncation — G6a measured these digests faithful on
 *     numbers/ids, missing only the standing states;
 *   - the cloud-first route does NOT re-run the already-rejected cloud chain;
 *   - the re-condenser rejects a section-dropping candidate (primary and cloud),
 *     and does not enforce sections the input itself lacks.
 *
 * Mutant contract (grain offer, DM ai-01 21/11 19:09Z; both mutants measured
 * on this file 21/11): reverting the primary guard turns (1)-(4) red; reverting
 * the re-condenser validation (candidate rejection + cloud validator section
 * check) turns (5) red. (6) is the complement pin — a compliant shrink must
 * pass — and correctly stays green under that mutant; it goes red only if the
 * contract starts over-rejecting.
 *
 * The harness mirrors dashboard.summary-transverse-states.test.ts (mocked
 * '@/services/openai' seam, mocked primary AND fallback clients).
 *
 * @module tools/roosync/__tests__/dashboard.summary-primary-guard
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { roosyncDashboard, resetCondenseCircuitBreaker, condenseTextIfTooLarge } from '../dashboard.js';

// Primary chat client + create — the leg under test.
const mockPrimaryCreate = vi.fn();
const mockGetPrimaryClient = vi.fn();
// Fallback (cloud) chat client + create.
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

const testTmpBase = path.join(os.tmpdir(), 'dashboard-primary-guard-');

const isSummaryRequest = (req: any): boolean =>
  JSON.stringify(req?.messages ?? []).includes('messages retirés du dashboard à synthétiser');

// The G6a-shaped 3-section summary — faithful on numbers, every standing state gone.
const g6aShapedSummary = `## Résumé des 16 messages archivés

### Thèmes principaux
- RULES-DEPLOY déployé sur plusieurs sièges (81→87 lignes, 5/5 OK).

### Actions et résultats
- [DONE] pré-vols passés ; 26/26 tests verts.

### Décisions et métriques
- 31 fichiers +3275/−202 ; 72 événements traités.`;

function transverseSummary(label: string): string {
  return `## Résumé\n\n### Thèmes principaux\n- ${label}\n\n### Actions et résultats\n- [DONE] test\n\n### Décisions et métriques\n- none\n\n### États transverses\n- ${label}: fenêtre UAC Q70 attendue sur ai-01 (21/11)`;
}

describe('#4434 G7a-3 — primary fallback + re-condenser carry the section contract', { timeout: 120000 }, () => {
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
    delete process.env.FALLBACK_API_FORMAT;
    delete process.env.CONDENSE_STATUS_CLOUD_FIRST;
    // Primary-first routing by default (the cloud tier is the OTHER tier here).
    process.env.CONDENSE_SUMMARY_CLOUD_FIRST = '0';
    // Default: primary answers every request; no cloud tier configured.
    mockGetPrimaryClient.mockReturnValue({ chat: { completions: { create: mockPrimaryCreate } } });
    mockPrimaryCreate.mockReset();
    mockGetFallbackClient.mockImplementation(() => null);
    mockFallbackCreate.mockReset();
    mockFallbackModelId.mockImplementation(() => 'glm-5.3-flash');
    resetCondenseCircuitBreaker();
  });

  afterEach(async () => {
    delete process.env.DASHBOARD_CONDENSE_STATUS_MODE;
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
    delete process.env.CONDENSE_SUMMARY_CLOUD_FIRST;
  });

  /** Primary answers summary requests with `summaryFor(callIndex)`; status requests get a valid status. */
  function primaryAnswers(summaryFor: (callIndex: number) => string): void {
    let summaryCallIndex = 0;
    mockPrimaryCreate.mockImplementation(async (req: any) => ({
      choices: [{ message: { content: isSummaryRequest(req)
        ? summaryFor(summaryCallIndex++)
        : '## Statut\n\nnominal' }, finish_reason: 'stop' }],
    }));
  }

  async function fillUntilCondensed(): Promise<void> {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    const filler = 'X'.repeat(3000);
    let condensed = false;
    for (let i = 0; i < 20 && !condensed; i++) {
      const result = await roosyncDashboard({ action: 'append', type: 'global', content: `${filler} message-${i}` }) as any;
      if (result.condensed) condensed = true;
    }
    expect(condensed).toBe(true);
  }

  /** Newest condensation-archive frontmatter (yaml) of the pass just run —
   *  js-yaml folded scalars unfolded (same trick as dashboard.fallback-cloud (u)),
   *  single quotes stripped. */
  async function readArchiveFrontmatter(): Promise<Record<string, any>> {
    const dir = path.join(tmpDir, 'dashboards', 'archive');
    const files = (await readdir(dir))
      .filter(f => /^global-.*\.md$/.test(f) && !f.includes('-fallback'))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    const raw = await readFile(path.join(dir, files[files.length - 1]), 'utf-8');
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    const unfolded = fmMatch![1].replace(/\n\s+/g, ' ');
    const fm: Record<string, any> = {};
    for (const line of unfolded.split('\n')) {
      const m = line.match(/^([A-Za-z]+): (.*)$/);
      if (m) fm[m[1]] = m[2].replace(/^'(.*)'$/, '$1');
    }
    return fm;
  }

  it('(1) retries then accepts the partial digest STAMPED when no other tier exists', async () => {
    primaryAnswers(() => g6aShapedSummary); // every attempt guard-rejected
    await fillUntilCondensed();

    const fm = await readArchiveFrontmatter();
    expect(fm.summaryOutcome).toBe('ok-guard-rejected');
    expect(fm.summaryLegError).toContain('incomplete-summary (missing: etats transverses)');
    // The partial digest IS the visible summary — not a truncation.
    const live = await readFile(path.join(tmpDir, 'dashboards', 'global.md'), 'utf-8');
    expect(live).toContain('### Thèmes principaux');
    // The primary was retried (not accepted on first rejection).
    const summaryCalls = mockPrimaryCreate.mock.calls.map((c: any[]) => c[0]).filter(isSummaryRequest);
    expect(summaryCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('(2) a compliant retry becomes the ok summary', async () => {
    let first = true;
    primaryAnswers(() => { if (first) { first = false; return g6aShapedSummary; } return transverseSummary('second try'); });
    await fillUntilCondensed();

    const fm = await readArchiveFrontmatter();
    expect(fm.summaryOutcome).toBe('ok');
    const live = await readFile(path.join(tmpDir, 'dashboards', 'global.md'), 'utf-8');
    expect(live).toContain('### États transverses');
  });

  it('(3) primary-first: retries exhausted hand the leg to the guarded cloud chain (rescue)', async () => {
    primaryAnswers(() => g6aShapedSummary);
    mockGetFallbackClient.mockReturnValue({ chat: { completions: { create: mockFallbackCreate } } });
    mockFallbackCreate.mockImplementation(async (req: any) => ({
      choices: [{ message: { content: isSummaryRequest(req)
        ? transverseSummary('cloud rescue')
        : '## Statut\n\nnominal' }, finish_reason: 'stop' }],
    }));
    await fillUntilCondensed();

    const fm = await readArchiveFrontmatter();
    expect(fm.summaryOutcome).toBe('ok-with-fallback');
    expect(fm.summaryFallbackModel).toBe('glm-5.3-flash');
    const live = await readFile(path.join(tmpDir, 'dashboards', 'global.md'), 'utf-8');
    expect(live).toContain('cloud rescue');
    expect(live).not.toContain('81→87 lignes'); // the partial primary digest did NOT win
  });

  it('(4) cloud-first: a fully-rejected chain does NOT re-run when the primary is guard-rejected', async () => {
    delete process.env.CONDENSE_SUMMARY_CLOUD_FIRST; // cloud-first default (on)
    // Cloud chain: every model answers the G6a shape → per-model guard rejection.
    mockGetFallbackClient.mockReturnValue({ chat: { completions: { create: mockFallbackCreate } } });
    mockFallbackCreate.mockImplementation(async (req: any) => ({
      choices: [{ message: { content: isSummaryRequest(req)
        ? g6aShapedSummary
        : '## Statut\n\nnominal' }, finish_reason: 'stop' }],
    }));
    // Primary: partial on every attempt.
    primaryAnswers(() => g6aShapedSummary);
    await fillUntilCondensed();

    const fm = await readArchiveFrontmatter();
    // NB: no summaryCloudFirst stamp here — it marks the cloud ROUTE (a success),
    // and this pass's chain was fully rejected; the route evidence is the call
    // count below. The pass's primary was exercised (stats.cloudFirst unset), so
    // the breaker judgment at the pass level stays on the exercised-primary path.
    expect(fm.summaryOutcome).toBe('ok-guard-rejected');
    // Exactly ONE cloud pass over the (single-model) chain for the summary leg —
    // the guard-rejected primary must not trigger a second one.
    const cloudSummaryCalls = mockFallbackCreate.mock.calls.map((c: any[]) => c[0]).filter(isSummaryRequest);
    expect(cloudSummaryCalls.length).toBe(1);
  });

  describe('re-condenser (condenseTextIfTooLarge) — section contract', { timeout: 30000 }, () => {
    const SECTIONS = ['themes principaux', 'actions et resultats', 'decisions et metriques', 'etats transverses'] as const;
    const CAP = 2 * 1024;
    const sectionCompleteInput = [
      '## Résumé des N messages archivés',
      '### Thèmes principaux', '- ' + 'A'.repeat(700),
      '### Actions et résultats', '- ' + 'B'.repeat(700),
      '### Décisions et métriques', '- ' + 'C'.repeat(700),
      '### États transverses', '- fenêtre UAC Q70 attendue (21/11)',
    ].join('\n'); // ≈ 2.2 KB > CAP, all four sections present
    // Under the cap but the states section amputated.
    const sectionDroppingCandidate = [
      '### Thèmes principaux', '- A',
      '### Actions et résultats', '- B',
      '### Décisions et métriques', '- C',
    ].join('\n');
    const compliantCandidate = sectionDroppingCandidate + '\n### États transverses\n- Q70 (21/11)';

    beforeEach(() => {
      delete process.env.OPENAI_BASE_URL;
    });

    it('(5) a section-dropping candidate is never returned (nor becomes the floor input)', async () => {
      mockPrimaryCreate.mockImplementation(async () => ({
        choices: [{ message: { content: sectionDroppingCandidate }, finish_reason: 'stop' }],
      }));
      const out = await condenseTextIfTooLarge(sectionCompleteInput, CAP, 'Summary', undefined, SECTIONS);
      // Not the amputated candidate: the deterministic floor over the ORIGINAL
      // (omission-marked) is preferred to a compliant-looking amputation.
      expect(out).not.toBe(sectionDroppingCandidate);
      expect(out.includes('États transverses') || out.includes('omis')).toBe(true);
    });

    it('(6) a compliant shrink passes through unchanged', async () => {
      mockPrimaryCreate.mockImplementation(async () => ({
        choices: [{ message: { content: compliantCandidate }, finish_reason: 'stop' }],
      }));
      const out = await condenseTextIfTooLarge(sectionCompleteInput, CAP, 'Summary', undefined, SECTIONS);
      expect(out).toBe(compliantCandidate);
    });

    it('(7) no over-constraint when the input itself lacks the sections', async () => {
      mockPrimaryCreate.mockImplementation(async () => ({
        choices: [{ message: { content: 'condensed body without sections' }, finish_reason: 'stop' }],
      }));
      // 3-section input (a G7a-3 accepted-stamped digest): the re-condenser
      // shrinks it without demanding sections the input never had.
      const partialInput = sectionDroppingCandidate + '\n- ' + 'D'.repeat(2200);
      const out = await condenseTextIfTooLarge(partialInput, CAP, 'Summary', undefined, SECTIONS);
      expect(out).toBe('condensed body without sections');
    });

    it('(8) the section rule reaches the shrink prompt when the contract is active', async () => {
      mockPrimaryCreate.mockImplementation(async () => ({
        choices: [{ message: { content: compliantCandidate }, finish_reason: 'stop' }],
      }));
      await condenseTextIfTooLarge(sectionCompleteInput, CAP, 'Summary', undefined, SECTIONS);
      const sysPrompt = String(mockPrimaryCreate.mock.calls[0][0]?.messages?.[0]?.content ?? '');
      expect(sysPrompt).toContain('CONSERVER les titres de sections');
      // And NOT when no contract is passed (status leg shape).
      mockPrimaryCreate.mockClear();
      const statusLike = '## Statut\n- ' + 'S'.repeat(2200);
      await condenseTextIfTooLarge(statusLike, CAP, 'Status');
      const sysPrompt2 = String(mockPrimaryCreate.mock.calls[0][0]?.messages?.[0]?.content ?? '');
      expect(sysPrompt2).not.toContain('CONSERVER les titres de sections');
    });
  });
});
