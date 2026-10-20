/**
 * #4284 — la condensation ne doit pas effacer un `update section:status`
 * concurrent posé pendant sa fenêtre LLM.
 *
 * Mesuré ai-01 20/10 sur workspace-roo-extensions : un append status 11:19Z
 * (statusLength 14666 → 17258) était effacé par la passe de condensation
 * ~11:28Z, qui réécrivait le statut depuis l'instantané pris AVANT ses appels
 * LLM (relecture : 8245, en-tête antérieur à l'ajout). `applyCondensedWithMerge`
 * ne réintégrait que le delta INTERCOM (#2328, messages par id) ; le statut
 * n'était jamais comparé, donc tout `update status` sans message intercom
 * tombait dans la branche `delta.length === 0` et était écrasé tel quel.
 *
 * Ces tests simulent le writer concurrent par injection directe du statut dans
 * le fichier PENDANT la fenêtre LLM (le faux client injecte à son premier
 * appel), puis assertent que le statut final porte l'écriture concurrente.
 * Rouge sur main avant le CAS (#4284), vert après.
 *
 * NB config : `mockReset: true` (vitest.config.ts) wipe les implémentations
 * posées dans `vi.hoisted` — chaque comportement est ré-armé dans le
 * beforeEach (pattern #2639 lot 2), pas seulement déclaré.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
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
  fetchArchivedDashboardMessageIds: vi.fn(),
}));

vi.mock('@/services/unified-store/roosync-dashboard-store', () => ({
  // Gate OFF + PG null : applyCondensedWithMerge ancre son delta sur le fichier
  // (cf. dashboard-condense-pg-anchor.test.ts, même surface mockée).
  ...mocks,
}));

// Le faux client LLM : à son PREMIER appel create() — pendant la fenêtre de la
// condensation, entre l'instantané et applyCondensedWithMerge — il injecte le
// statut concurrent dans le fichier, puis répond. C'est la fenêtre mesurée
// dans l'incident (l'update concurrent d'ai-01 a atterri pendant les appels
// LLM de la condensation tenue par po-2028).
const CONCURRENT_ADD = 'AJOUT CONCURRENT #4284 — update status mode:append pendant la fenetre LLM';
const CONCURRENT_REPLACE = 'STATUT REMPLACE #4284 — update status mode:replace pendant la fenetre LLM';
const LLM_STATUS = 'STATUT RESUME PAR LLM (#4284)';
let concurrentInjector: (() => Promise<void>) | null = null;
let llmCalls = 0;

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => ({
    chat: {
      completions: {
        create: async () => {
          llmCalls += 1;
          if (concurrentInjector) {
            const inject = concurrentInjector;
            concurrentInjector = null;
            await inject();
          }
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

import { roosyncDashboard } from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-condense-status-cas-');

describe('condensation × update status concurrent (#4284)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    // Scénario mesuré : la passe réécrit le statut (pas le skip on-change #4205).
    process.env.DASHBOARD_CONDENSE_STATUS_MODE = 'always';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_API_BASE_URL;
    concurrentInjector = null;
    llmCalls = 0;
    // mockReset:true wipe les implémentations hoisted — ré-armement par test.
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
    mocks.fetchArchivedDashboardMessageIds.mockResolvedValue(null);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
    delete process.env.DASHBOARD_CONDENSE_STATUS_MODE;
  });

  function getDashboardFilePath(key: string): string {
    return path.join(tmpDir, 'dashboards', `${key}.md`);
  }

  /** Lit le contenu de la section Status sérialisée. */
  async function readStatusSection(key: string): Promise<string> {
    const content = await readFile(getDashboardFilePath(key), 'utf8');
    const match = content.match(/## Status\n\n([\s\S]*?)\n\n## Intercom/);
    return match ? match[1] : '(section Status introuvable)';
  }

  /** Remplace le contenu de la section Status (simulation d'un writer concurrent). */
  async function writeStatusSection(key: string, newStatus: string): Promise<void> {
    const filePath = getDashboardFilePath(key);
    const content = await readFile(filePath, 'utf8');
    const updated = content.replace(
      /## Status\n\n([\s\S]*?)\n\n## Intercom/,
      () => `## Status\n\n${newStatus}\n\n## Intercom`
    );
    if (updated === content) throw new Error('section Status non trouvée pour injection concurrente');
    await writeFile(filePath, updated, 'utf8');
  }

  /**
   * Populate SOUS le seuil preemptive (92 % de 50 Ko ≈ 47 104 o), puis un append
   * final calibré sur la taille mesurée du fichier pour que CE soit lui qui
   * franchisse le seuil — sinon la condensation part pendant le populate et le
   * scénario (injection pendant la fenêtre LLM) n'est jamais exercé.
   */
  async function populateBelowThresholdAndTrigger(): Promise<{ key: string; result: ReturnType<typeof roosyncDashboard> }> {
    const writeResult = await roosyncDashboard({
      action: 'write',
      type: 'workspace',
      content: 'STATUT INITIAL #4284',
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
    // Calibration sur l'ESTIMÉ (estimateDashboardSize : 200 + status + Σ(110+content)),
    // pas sur la taille du fichier — le gate needsCondense compare l'estimé au seuil.
    const statusLen = Buffer.byteLength('STATUT INITIAL #4284', 'utf8');
    let estimated = 200 + statusLen;
    for (let i = 0; i < 40; i++) {
      estimated += 110 + Buffer.byteLength(`Message ${i}: ${'x'.repeat(900)}`, 'utf8');
    }
    const PREEMPTIVE_THRESHOLD = Math.floor(50 * 1024 * 0.92); // cf. dashboard.ts (~46 KB)
    const fill = Math.max(400, PREEMPTIVE_THRESHOLD - estimated + 150);
    const result = roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: `Final: ${'y'.repeat(fill)}`,
      tags: ['INFO'],
    });
    return { key, result };
  }

  it("réintègre un append status concurrent tombé pendant la fenêtre LLM de la condensation", async () => {
    const { key, result: resultPromise } = await populateBelowThresholdAndTrigger();

    // Le writer concurrent : append (`${existing}\n\n${content}` — le mode du handler update)
    // injecté au premier appel LLM, i.e. après l'instantané, avant applyCondensedWithMerge.
    concurrentInjector = async () => {
      const current = await readStatusSection(key);
      await writeStatusSection(key, `${current}\n\n${CONCURRENT_ADD}`);
    };

    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(llmCalls).toBeGreaterThan(0); // la condensation a bien ouvert la fenêtre LLM

    const finalStatus = await readStatusSection(key);
    // Le résumé LLM s'applique (la passe a bien réécrit le statut)…
    expect(finalStatus).toContain(LLM_STATUS);
    // …et l'ajout concurrent survit. ROUGE sur main : seule la réécriture LLM reste.
    expect(finalStatus).toContain(CONCURRENT_ADD);
  });

  it('conserve le statut disque quand un replace divergent a eu lieu pendant la fenêtre LLM', async () => {
    const { key, result: resultPromise } = await populateBelowThresholdAndTrigger();

    // Writer concurrent en mode replace : aucun lien préfixe/suffixe avec le statut
    // de l'instantané — la fusion ne peut pas réintégrer un delta identifiable.
    concurrentInjector = async () => {
      await writeStatusSection(key, CONCURRENT_REPLACE);
    };

    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(llmCalls).toBeGreaterThan(0);

    const finalStatus = await readStatusSection(key);
    // Écriture la plus récente = le disque. La passe de résumé suivante le reprendra.
    // ROUGE sur main : la réécriture LLM écrase le replace.
    expect(finalStatus).toContain(CONCURRENT_REPLACE);
  });
});
