/**
 * #4434 G7a-1 — cross-cutting standing states in the intercom-summary leg.
 *
 * G6a (independent re-read, c.7059518187, lane po-2027) measured 12 critical
 * omissions on the 3 post-cutover summaries of workspace-roo-extensions — ALL of
 * the same class: standing, user-facing states that the three thematic sections
 * never asked for and so reliably dropped:
 *
 *   A (04:36Z): expected UAC window (Q70) · pending handoff (Luna → claudish#1055)
 *               · live config change (nbcoder 600→1500 s) · dated pause (#4831)
 *   B (00:36Z): user constraint (site Tournai, no UAC window before Sunday)
 *               · scheduled deadline (#2307 tir 21/11) · handoff to coordinator
 *               (#4736/#4819) · open user-question registry (5 questions)
 *   C (22:24Z): live disk risk (po-2025 D: 7,7 % URGENT) · degraded instrument
 *               (po-2028 exit 1, incomplete) · registry (5 questions) ·
 *               DENY-blocked capacity (NotebookEdit po-2024)
 *
 * The 12 omissions collapse to 8 distinct classes, exactly the ones the FORMAT
 * block of generateLLMSummary now enumerates under « ### États transverses ».
 * This file pins the three halves of the fix:
 *   1. the chain guard (SUMMARY_REQUIRED_SECTIONS) rejects a 3-section summary
 *      exactly like G6a's real ones, and accepts the 4-section shape (incl. the
 *      « - aucun » empty form);
 *   2. the summary prompt ASKS for those classes (contract at the mocked client
 *      seam — G7a-2, lane po-2027, measures whether the model obeys);
 *   3. the guard has teeth end-to-end: a G6a-shaped first-model answer is
 *      guard-rejected per model and the next model writes the archive summary.
 *
 * Mutant contract (spec c.7062255933: « un mutant doit échouer sans le
 * correctif »): reverting the guard entry 'etats transverses' turns (1) and (3)
 * red; reverting the prompt section turns (2) red.
 *
 * The harness mirrors dashboard.fallback-cloud.test.ts (mocked '@/services/openai'
 * seam, CONDENSE_SUMMARY_CLOUD_FIRST='0' rescue shape) — the prompt and the
 * per-model validate are identical on the cloud-first and rescue paths, and the
 * rescue path is the shape with proven telemetry assertions.
 *
 * @module tools/roosync/__tests__/dashboard.summary-transverse-states
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { roosyncDashboard, resetCondenseCircuitBreaker, validateSummaryCompleteness } from '../dashboard.js';

// Primary chat client + create — lazy indirection so each test can swap behaviour.
const mockPrimaryCreate = vi.fn();
const mockGetPrimaryClient = vi.fn();
// Fallback (cloud) chat client + create.
const mockFallbackCreate = vi.fn();
const mockGetFallbackClient = vi.fn();
// The model chain reads FALLBACK_LLM_MODEL_ID through this getter.
const mockFallbackModelId = vi.fn(() => 'glm-5.3-flash');

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetPrimaryClient(),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-primary-model',
  getFallbackChatOpenAIClient: () => mockGetFallbackClient(),
  getFallbackLLMModelId: () => mockFallbackModelId(),
}));

const testTmpBase = path.join(os.tmpdir(), 'dashboard-transverse-states-');

// The summary leg's user prompt, as built by generateLLMSummary.
const isSummaryRequest = (req: any): boolean =>
  JSON.stringify(req?.messages ?? []).includes('messages retirés du dashboard à synthétiser');

// A cloud answer in the summary prompt's imposed FOUR-section format (post G7a-1).
function transverseSummary(label: string): string {
  return `## Résumé\n\n### Thèmes principaux\n- ${label}\n\n### Actions et résultats\n- [DONE] test\n\n### Décisions et métriques\n- none\n\n### États transverses\n- ${label}: fenêtre UAC Q70 attendue sur ai-01 (21/11)`;
}

// G6a summary B (00:36Z, 16 messages) distilled to its actual failure shape:
// complete-looking, all three legacy sections, numbers plausible — and every
// standing state of the window silently gone. This is what glm-4.7 really
// produced three times in a row, not a synthetic worst case.
const g6aShapedSummary = `## Résumé des 16 messages archivés

### Thèmes principaux
- RULES-DEPLOY déployé sur plusieurs sièges (81→87 lignes, 5/5 OK).
- Merge ms#1811 enregistré ; 21 PR/24 h côté flotte.

### Actions et résultats
- [DONE] pré-vols passés ; 26/26 tests verts.
- [DONE] condensation cloud 3,5 KB.

### Décisions et métriques
- 31 fichiers +3275/−202 ; 72 événements traités ; 276 s.`;

// The 12 G6a omissions, collapsed to their 8 classes — the exact standing states
// the fixtures inject into the window (verbatim markers in parentheses are what
// the contract test greps back out of the user prompt).
const G6A_TRANSVERSE_STATES: string[] = [
  'fenêtre UAC attendue : redéploiement garde anti-gel sur ai-01 derrière une fenêtre UAC Q70 (tick Maintenance 00:11Z)', // A1
  'handoff en attente : jambe Luna transférée à claudish#1055, transfert accepté', // A2
  'changement de config vivant : nbcoder timeout 600 → 1500 s sur ai-01', // A3
  'pause datée : #4831 en pause (claim ai-01 ; vllm porte la tranche ms#1810 en amont)', // A4
  'contrainte user planifiée : site Tournai jusqu\'à dimanche, aucune fenêtre UAC attendue d\'ici là', // B1
  'handoff en attente : décision de clôture #4736/#4819 renvoyée au coordinateur (c.7049517955)', // B3
  'question user ouverte (registre) : 5 questions ouvertes — Q11/Q76, Q6, Q3, Q4, Q8', // B4 + C3
  'risque vivant disque : po-2025 D: 7,7 % URGENT, rebond +61 Gio non expliqué', // C1
  'organe dégradé ou incomplet : exit 1 mesuré par po-2028 — instrument incomplet (2 dashboards CoursIA-3 illisibles)', // C2
  'capacité bloquée (DENY) : NotebookEdit deny sur po-2024, jupyter-papermill absent, registre Q19, pas de workaround', // C4
];

// One short, unique substring per fixture line — asserted present in the user
// prompt of the summary request (the state was IN the window the model saw).
const G6A_STATE_MARKERS = ['Q70', 'claudish#1055', '1500 s', '#4831', 'Tournai', '#4736/#4819', 'Q11/Q76', '7,7 %', 'exit 1', 'NotebookEdit'];

describe('#4434 G7a-1 — summary leg keeps cross-cutting standing states', { timeout: 60000 }, () => {
  let tmpDir: string;

  beforeEach(async () => {
    // #4527 - keep the synchronous semantics of the pass under test.
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
    // Rescue shape (same as dashboard.fallback-cloud.test.ts): primary down, the
    // summary leg salvaged through the cloud chain — the per-model validate and
    // the systemPrompt are identical on both routings.
    process.env.CONDENSE_SUMMARY_CLOUD_FIRST = '0';
    // Default: primary unavailable, no fallback configured (inert).
    mockGetPrimaryClient.mockImplementation(() => { throw new Error('No chat API key configured'); });
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
    delete process.env.CONDENSE_STATUS_CLOUD_FIRST;
    delete process.env.CONDENSE_SUMMARY_CLOUD_FIRST;
  });

  /**
   * Fill the dashboard past the 92% preemptive-condense threshold until a
   * condensation pass fires, injecting one G6A fixture state per message so the
   * archived window genuinely carries the standing states G6a saw dropped.
   */
  async function fillWithStatesUntilCondensed(): Promise<any> {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    const filler = 'X'.repeat(3000);
    let condensedResult: any = null;
    for (let i = 0; i < 20 && !condensedResult; i++) {
      const state = G6A_TRANSVERSE_STATES[i % G6A_TRANSVERSE_STATES.length];
      const line = i < G6A_TRANSVERSE_STATES.length
        ? `${filler} état-${i}: ${state}`
        : `${filler} message-${i}`;
      const result = await roosyncDashboard({ action: 'append', type: 'global', content: line });
      if ((result as any).condensed) condensedResult = result;
    }
    expect(condensedResult).not.toBeNull();
    return condensedResult;
  }

  it('guard: a G6a-shaped 3-section summary is rejected naming the missing section', () => {
    // Bite-test vs the pre-fix guard: this returned null (the summary looked
    // complete) and the omission was archived as the window's only trace.
    expect(validateSummaryCompleteness(g6aShapedSummary))
      .toBe('incomplete-summary (missing: etats transverses)');
  });

  it('guard: the 4-section shape passes, including the « - aucun » empty form and case/accents', () => {
    expect(validateSummaryCompleteness(transverseSummary('x'))).toBeNull();
    expect(validateSummaryCompleteness(
      '### Thèmes principaux\n### Actions et résultats\n### Décisions et métriques\n### États transverses\n- aucun',
    )).toBeNull();
    // NFD accent-strip + lowercase, as for the three legacy sections.
    expect(validateSummaryCompleteness(
      '### THEMES PRINCIPAUX\n### Actions et resultats\n### décisions et MÉTRIQUES\n### ETATS TRANSVERSES\n- aucun',
    )).toBeNull();
  });

  it('guard: older failure shapes now name the 4th section too', () => {
    expect(validateSummaryCompleteness('## Résumé des 9 messages archivés\n\n### Thèmes principaux\n- Limite'))
      .toBe('incomplete-summary (missing: actions et resultats, decisions et metriques, etats transverses)');
    expect(validateSummaryCompleteness('free text'))
      .toBe('incomplete-summary (missing: themes principaux, actions et resultats, decisions et metriques, etats transverses)');
  });

  it('prompt: the summary request asks for the transverse-states contract, and the G6a states are in the window it summarizes', async () => {
    mockGetFallbackClient.mockReturnValue({ chat: { completions: { create: mockFallbackCreate } } });
    mockFallbackCreate.mockImplementation(async (req: any) => ({
      choices: [{ message: { content: isSummaryRequest(req)
        ? transverseSummary('contract probe')
        : '## Statut\n\nnominal' }, finish_reason: 'stop' }],
    }));

    await fillWithStatesUntilCondensed();

    const summaryRequests = mockFallbackCreate.mock.calls
      .map((c: any[]) => c[0])
      .filter(isSummaryRequest);
    expect(summaryRequests.length).toBeGreaterThanOrEqual(1);
    const req: any = summaryRequests[summaryRequests.length - 1];
    expect(req.messages.length).toBeGreaterThanOrEqual(2);

    // (a) The system prompt imposes the contract — every G6a class is named,
    // the dedicated section exists, the empty form is defined, and the line
    // budget grew to fit it.
    const system = req.messages[0].content as string;
    expect(system).toContain("ZÉRO perte d'ÉTATS TRANSVERSES");
    expect(system).toContain('### États transverses');
    expect(system).toContain('« - aucun »');
    expect(system).toContain('Maximum 25 lignes');
    for (const cls of ['fenêtre UAC', 'registre', 'exit 1', 'risque vivant', 'pause datée', 'handoff', 'DENY', 'timeouts']) {
      expect(system).toContain(cls);
    }

    // (b) The fixtures reached the user prompt: the states G6a saw dropped were
    // present in the summarized window (so the omission was a prompt contract
    // failure, not an input gap). G7a-2 measures whether the model now keeps them.
    const user = req.messages[1].content as string;
    for (const marker of G6A_STATE_MARKERS) {
      expect(user).toContain(marker);
    }
  });

  it('chain: a G6a-shaped first-model summary is guard-rejected and the next model writes the archive', async () => {
    mockGetFallbackClient.mockReturnValue({ chat: { completions: { create: mockFallbackCreate } } });
    mockFallbackModelId.mockImplementation(() => 'deepseek-v4-flash,claude-sonnet-5-5');
    mockFallbackCreate.mockImplementation(async (req: any) => {
      if (!isSummaryRequest(req)) return { choices: [{ message: { content: '## Statut\n\nnominal' }, finish_reason: 'stop' }] };
      return req.model === 'deepseek-v4-flash'
        ? { choices: [{ message: { content: g6aShapedSummary }, finish_reason: 'stop' }] }
        : { choices: [{ message: { content: transverseSummary('rescued with the states section') }, finish_reason: 'stop' }] };
    });

    const condensedResult = await fillWithStatesUntilCondensed();

    const cloudPasses = condensedResult.condenseDiagnostic!.filter((d: any) => d.outcome === 'fallback-cloud');
    expect(cloudPasses.length).toBeGreaterThanOrEqual(1);
    // Bite-test vs the pre-fix guard: without 'etats transverses' in
    // SUMMARY_REQUIRED_SECTIONS, model 1's G6a-shaped answer was ACCEPTED
    // (finalOutcome ok-with-fallback, fallbackModel deepseek-v4-flash) and every
    // standing state of the window left the dashboard silently.
    expect(cloudPasses[0].llm.summary.finalOutcome).toBe('ok-with-fallback');
    expect(cloudPasses[0].llm.summary.fallbackModel).toBe('claude-sonnet-5-5');

    // The RESCUED summary — not model 1's — is the window's only visible trace.
    // (A rescued pass writes the normal archive, no `-fallback.md`; the per-model
    // rejection trace of a rescued chain lives in the logs, and the truncation
    // variant naming it per model is pinned by dashboard.fallback-cloud.test.ts (u).)
    const dashboardMd = await readFile(path.join(tmpDir, 'dashboards', 'global.md'), 'utf8');
    expect(dashboardMd).toContain('### États transverses');
    expect(dashboardMd).toContain('rescued with the states section');
    expect(dashboardMd).not.toContain('RULES-DEPLOY déployé sur plusieurs sièges');
  });
});
