/**
 * #4527 — l'append ne bloque plus l'appelant pendant la passe de condensation.
 *
 * Mesuré ai-01 03/11 ~21:0xZ : `elapsedMs: 108505` pour un append dont le
 * message était DÉJÀ persisté (WRITE-FIRST). Le timeout primaire (90 s, KV à
 * 90,1 %) était payé par l'appelant pour un résultat qui n'intéresse que la
 * condensation suivante.
 *
 * Ces tests portent les quatre cas du critère de fermeture :
 *   1. un append qui franchit 92 % rend la main AVANT la fin de la passe ;
 *   2. la passe détachée termine et le dashboard est condensé (`lastCondensedAt`) ;
 *   3. une passe détachée qui échoue laisse le message ET le statut précédent
 *      intacts ;
 *   4. deux franchissements ne lancent pas deux passes en parallèle.
 * Plus le volet secondaire : l'avis de remplissage (85 %) arrive AVANT le 92 %.
 *
 * NB config : `mockReset: true` (vitest.config.ts) wipe les implémentations
 * posées dans `vi.hoisted` — chaque comportement est ré-armé dans le beforeEach
 * (pattern #2639 lot 2), pas seulement déclaré.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const mocks = vi.hoisted(() => ({
  isDashboardPgPrimary: vi.fn(),
  readDashboardFromPgUngated: vi.fn(),
  readDashboardFromPg: vi.fn(),
  probeDashboardJournalForHydration: vi.fn(),
  dualWriteDashboardSync: vi.fn(),
  dualWriteDashboardDelete: vi.fn(),
  getDashboardRetirement: vi.fn(),
  listRetiredDashboardKeys: vi.fn(),
  retireDashboardKeyChecked: vi.fn(),
  acquireDashboardSharedLock: vi.fn(),
  releaseDashboardSharedLock: vi.fn(),
  readDashboardSharedLock: vi.fn(),
  fetchArchivedDashboardMessageIds: vi.fn(),
}));

vi.mock('@/services/unified-store/roosync-dashboard-store', () => ({
  // Gate OFF + PG null : la passe ancre son delta sur le fichier local.
  ...mocks,
}));

// Le faux client LLM est PILOTÉ par le test : `llmGate` permet de tenir la
// passe en vol (preuve que l'append n'attend pas), `llmMode` choisit succès ou
// échec de la passe.
let llmGate: Promise<void> | null = null;
let releaseLlmGate: (() => void) | null = null;
let llmMode: 'ok' | 'throw' = 'ok';
let llmCalls = 0;
const LLM_STATUS = 'STATUT RESUME PAR LLM (#4527)';

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => ({
    chat: {
      completions: {
        create: async () => {
          llmCalls += 1;
          if (llmGate) await llmGate;
          if (llmMode === 'throw') throw new Error('injected primary failure (#4527)');
          return { choices: [{ message: { content: LLM_STATUS } }] };
        },
      },
    },
  }),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

import { roosyncDashboard, awaitDetachedCondense, resetCondenseCircuitBreaker } from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-condense-detached-');
const PREEMPTIVE_THRESHOLD = Math.floor(50 * 1024 * 0.92); // ~46 KB, cf. dashboard.ts

describe('condensation détachée de la réponse d\'append (#4527)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    process.env.DASHBOARD_CONDENSE_STATUS_MODE = 'always';
    delete process.env.CONDENSE_DETACHED; // défaut = détaché
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_API_BASE_URL;
    llmGate = null;
    releaseLlmGate = null;
    llmMode = 'ok';
    llmCalls = 0;
    // Le disjoncteur est de l'état MODULE : un test d'échec le laisserait ouvert
    // pour les suivants (passe primaire sautée → 0 appel LLM au lieu de 2).
    resetCondenseCircuitBreaker();
    mocks.isDashboardPgPrimary.mockReturnValue(false);
    mocks.readDashboardFromPgUngated.mockResolvedValue(null);
    mocks.readDashboardFromPg.mockResolvedValue(null);
    mocks.probeDashboardJournalForHydration.mockResolvedValue({ kind: 'empty' });
    mocks.dualWriteDashboardSync.mockResolvedValue(undefined);
    mocks.dualWriteDashboardDelete.mockResolvedValue(undefined);
    mocks.getDashboardRetirement.mockResolvedValue(null);
    mocks.listRetiredDashboardKeys.mockResolvedValue(new Set<string>());
    mocks.retireDashboardKeyChecked.mockResolvedValue({ ok: true, reason: 'written' });
    mocks.acquireDashboardSharedLock.mockResolvedValue('unavailable');
    mocks.releaseDashboardSharedLock.mockResolvedValue(undefined);
    mocks.readDashboardSharedLock.mockResolvedValue(null);
    mocks.fetchArchivedDashboardMessageIds.mockResolvedValue(null);
  });

  afterEach(async () => {
    // Ne jamais laisser une passe en vol franchir l'afterEach : le gate est
    // relâché puis la passe attendue, sinon la suppression du tmpDir course
    // les écritures de la condensation (flake d'ordre, pas de logique).
    if (releaseLlmGate) {
      llmMode = 'ok';
      releaseLlmGate();
      releaseLlmGate = null;
    }
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
    delete process.env.DASHBOARD_CONDENSE_STATUS_MODE;
    delete process.env.CONDENSE_DETACHED;
  });

  function getDashboardFilePath(key: string): string {
    return path.join(tmpDir, 'dashboards', `${key}.md`);
  }

  async function readStatusSection(key: string): Promise<string> {
    const content = await readFile(getDashboardFilePath(key), 'utf8');
    const match = content.match(/## Status\n\n([\s\S]*?)\n\n## Intercom/);
    return match ? match[1] : '(section Status introuvable)';
  }

  /** Le message survit-il, dans la vue vivante OU dans une archive ? */
  async function messageSurvivesAnywhere(token: string): Promise<boolean> {
    const dashboardsDir = path.join(tmpDir, 'dashboards');
    const entries = await readdir(dashboardsDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const full = path.join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name);
      const content = await readFile(full, 'utf8').catch(() => '');
      if (content.includes(token)) return true;
    }
    return false;
  }

  /** Remplit SOUS le seuil 92 %, pour que l'append final soit celui qui franchit. */
  async function populateBelowThreshold(): Promise<{ key: string; status: string }> {
    const status = 'STATUT INITIAL #4527';
    const writeResult = await roosyncDashboard({
      action: 'write',
      type: 'workspace',
      content: status,
      createIfNotExists: true,
    });
    const key = writeResult.key;
    for (let i = 0; i < 40; i++) {
      await roosyncDashboard({
        action: 'append',
        type: 'workspace',
        content: `Message ${i}: ${'x'.repeat(900)}`,
        tags: ['INFO'],
      });
    }
    return { key, status };
  }

  /** Taille du dernier append qui fait franchir le seuil de condensation. */
  function crossingContent(status: string, token: string): string {
    const statusLen = Buffer.byteLength(status, 'utf8');
    let estimated = 200 + statusLen;
    for (let i = 0; i < 40; i++) {
      estimated += 110 + Buffer.byteLength(`Message ${i}: ${'x'.repeat(900)}`, 'utf8');
    }
    const fill = Math.max(400, PREEMPTIVE_THRESHOLD - estimated + 150);
    return `${token}: ${'y'.repeat(fill)}`;
  }

  it('rend la main avant la fin de la passe, puis condense (critère de fermeture)', async () => {
    const { key, status } = await populateBelowThreshold();
    const token = 'APPEND-CROISEMENT-4527';

    // La passe ne peut pas finir : le gate LLM est fermé. Un append synchrone
    // ne rendrait donc jamais la main — c'est le témoin négatif du test.
    llmGate = new Promise<void>(resolve => { releaseLlmGate = resolve; });

    const startedAt = Date.now();
    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: crossingContent(status, token),
      tags: ['INFO'],
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.success).toBe(true);
    expect(result.condensationDeferred).toBe(true);
    expect(elapsedMs).toBeLessThan(5000); // critère de fermeture : < 5 s
    // Le message est déjà lisible AVANT que la passe ait produit quoi que ce soit.
    expect(await messageSurvivesAnywhere(token)).toBe(true);

    // …et la passe, une fois débloquée, condense bien le dashboard.
    llmMode = 'ok';
    releaseLlmGate?.();
    releaseLlmGate = null;
    await awaitDetachedCondense(key);

    expect(llmCalls).toBeGreaterThan(0);
    const finalStatus = await readStatusSection(key);
    expect(finalStatus).toContain(LLM_STATUS);
    expect(await messageSurvivesAnywhere(token)).toBe(true);
  });

  it('n\'entame pas la condensation alors que le seuil n\'est pas franchi', async () => {
    const { key } = await populateBelowThreshold();
    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'petit message sous le seuil',
      tags: ['INFO'],
    });

    expect(result.success).toBe(true);
    expect(result.condensationDeferred).toBeUndefined();
    expect(result.condensed).toBe(false);
    await awaitDetachedCondense(key);
    expect(llmCalls).toBe(0);
  });

  it('laisse le message et le statut précédent intacts quand la passe détachée échoue', async () => {
    const { key, status } = await populateBelowThreshold();
    const token = 'APPEND-ECHEC-4527';
    llmMode = 'throw';

    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: crossingContent(status, token),
      tags: ['INFO'],
    });
    expect(result.success).toBe(true);
    expect(result.condensationDeferred).toBe(true);

    await awaitDetachedCondense(key);

    // Aucune perte : le message neuf est là, et le statut métier précédent
    // n'a pas été remplacé par un artefact d'échec du modèle.
    expect(await messageSurvivesAnywhere(token)).toBe(true);
    // Le statut précédent survit : la passe en échec ne substitue pas un
    // résumé LLM, elle ajoute au plus le bandeau de repli #3962 au-dessus.
    const finalStatus = await readStatusSection(key);
    expect(finalStatus).toContain(status);
    expect(finalStatus).not.toContain(LLM_STATUS);
  });

  it('deux franchissements ne lancent pas deux passes en parallèle', async () => {
    const { key, status } = await populateBelowThreshold();

    llmGate = new Promise<void>(resolve => { releaseLlmGate = resolve; });

    const first = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: crossingContent(status, 'PREMIER-4527'),
      tags: ['INFO'],
    });
    expect(first.condensationDeferred).toBe(true);

    // Le verrou est tenu par la passe en vol : le second franchissement doit
    // s'arrêter au verrou, pas ouvrir une seconde passe.
    const second = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: crossingContent(status, 'SECOND-4527'),
      tags: ['INFO'],
    });
    expect(second.condensationDeferred).toBeUndefined();
    expect(second.condensationStalled).toBe('lock-held');

    llmMode = 'ok';
    releaseLlmGate?.();
    releaseLlmGate = null;
    await awaitDetachedCondense(key);

    // Deux appels LLM = UNE passe (statut + résumé en parallèle), pas deux.
    expect(llmCalls).toBe(2);
  });

  it('signale le remplissage avant le seuil de condensation (avis 85 %)', async () => {
    const { status } = await populateBelowThreshold();

    // Calibrage sur l'ESTIMÉ (200 + statut + Σ(110 + contenu)) comme le gate
    // needsCondense, pour atterrir entre 85 % et 92 % — sans condensation.
    const statusLen = Buffer.byteLength(status, 'utf8');
    let estimated = 200 + statusLen;
    for (let i = 0; i < 40; i++) {
      estimated += 110 + Buffer.byteLength(`Message ${i}: ${'x'.repeat(900)}`, 'utf8');
    }
    const warnThreshold = Math.floor(50 * 1024 * 0.85);
    const fill = Math.max(100, warnThreshold - estimated + 200);
    expect(estimated + 110 + Buffer.byteLength(`PRE-SEUIL: ${'z'.repeat(fill)}`, 'utf8'))
      .toBeLessThan(PREEMPTIVE_THRESHOLD);

    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: `PRE-SEUIL: ${'z'.repeat(fill)}`,
      tags: ['INFO'],
    });

    expect(result.success).toBe(true);
    expect(result.warning).toContain('#4527');
    expect(result.warning).toContain('seuil d\'avis');
    expect(result.condensed).toBe(false);
    expect(result.condensationDeferred).toBeUndefined();
  });
});
