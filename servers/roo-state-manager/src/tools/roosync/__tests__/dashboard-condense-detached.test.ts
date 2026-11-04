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
 * #4536 (follow-up) — l'échec détaché laisse une trace : le warn porte le diag
 * COMPLET, et l'issue de la dernière passe (ok / error) est retenue par clé et
 * rendue à la lecture/append suivants (`condensationLastOutcome`).
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
  getDashboardPgReader: vi.fn(),
}));

vi.mock('@/services/unified-store/roosync-dashboard-store', () => ({
  // Gate OFF + PG null : la passe ancre son delta sur le fichier local.
  ...mocks,
}));

// #4536 — capture du WARN de l'échec détaché : le diag complet doit voyager
// dans le log, pas seulement {key, elapsedMs, error}. `vi.hoisted` car
// `createLogger()` tourne à l'éval de dashboard.ts, avant le corps de ce
// module — un `const` nu serait en TDZ.
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() })),
}));

// #4536 — injection d'échec ARCHIVE : `writeFile` vers dashboards/archive/
// rejette à la demande. Les échecs LLM sont absorbés en interne par la passe
// (truncation fallback) ; c'est l'erreur d'écriture d'archive qui fait
// sortir `condenseIntercom` par le throw et atteint le catch détaché.
const fsFail = vi.hoisted(() => ({ archiveWriteFails: false }));

// #4527 review (ai-01, 04/11) — point d'injection du test de verrou : chaque
// écriture de dashboard se termine par une copie in-place (staging → copyFile).
// Le test tient OUVERTE celle de la relecture-fusion détachée : c'est la fenêtre
// où un append concurrent pouvait s'intercaler puis être écrasé. `gateAtCall`
// désigne ce numéro d'appel — les DEUX chemins d'écriture comptent (l'append
// incrémental de l'appelant, puis la fusion détachée), donc la copie #1 est
// l'append, la #2 la passe détachée. `copyAfterGateEntered` dit si un autre
// writer a franchi SON écriture pendant que celle-ci est tenue. Désactivé par
// défaut : les autres tests de ce fichier ne voient qu'un passe-plat.
const fsGate = vi.hoisted(() => ({
  enabled: false,
  gateAtCall: 0,
  copyCalls: 0,
  copyAfterGateEntered: false,
  onGatedCopy: null as null | (() => void),
  onCopyAfterGate: null as null | (() => void),
  gatedCopyBarrier: null as null | Promise<void>,
  releaseGated: null as null | (() => void),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    copyFile: async (
      src: Parameters<typeof actual.copyFile>[0],
      dest: Parameters<typeof actual.copyFile>[1]
    ) => {
      if (fsGate.enabled) {
        fsGate.copyCalls += 1;
        if (fsGate.copyCalls === fsGate.gateAtCall) {
          const barrier = fsGate.gatedCopyBarrier;
          fsGate.onGatedCopy?.();
          if (barrier) await barrier;
        } else if (fsGate.copyCalls > fsGate.gateAtCall) {
          fsGate.copyAfterGateEntered = true;
          fsGate.onCopyAfterGate?.();
        }
      }
      return actual.copyFile(src, dest);
    },
    writeFile: async (
      file: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
      options?: Parameters<typeof actual.writeFile>[2]
    ) => {
      if (fsFail.archiveWriteFails && String(file).replace(/\\/g, '/').includes('/archive/')) {
        throw new Error('injected archive write failure (#4536)');
      }
      return actual.writeFile(file, data, options);
    },
  };
});

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

import { roosyncDashboard, awaitDetachedCondense, resetCondenseCircuitBreaker, resetDetachedCondenseOutcomes } from '../dashboard.js';

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
    fsFail.archiveWriteFails = false;
    warn.mockClear();
    // #4536 — le registre des issues détachées est un état de module : sans
    // reset, un test lirait le verdict de la passe du test précédent.
    resetDetachedCondenseOutcomes();
    fsGate.enabled = false;
    fsGate.gateAtCall = 0;
    fsGate.copyCalls = 0;
    fsGate.copyAfterGateEntered = false;
    fsGate.onGatedCopy = null;
    fsGate.onCopyAfterGate = null;
    fsGate.gatedCopyBarrier = null;
    fsGate.releaseGated = null;
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
    mocks.getDashboardPgReader.mockReturnValue(null);
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
    // Même contrat pour le gate fs : un test qui expire en le tenant laisserait
    // le verrou de clé armé pour le suivant (la clé est la même d'un test à
    // l'autre) — la cascade transforme un rouge en deux.
    if (fsGate.releaseGated) {
      fsGate.enabled = false;
      fsGate.releaseGated();
      fsGate.releaseGated = null;
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
    // #4527 review — un lock-held causé par NOTRE passe détachée est un état
    // nominal, pas un stall étranger : la réponse le qualifie (télémétrie, sans
    // épingler d'âge ni de durée).
    expect(second.condensationStallLockOwnPass).toBe(true);
    expect(second.message).toContain('passe détachée de CE process');

    llmMode = 'ok';
    releaseLlmGate?.();
    releaseLlmGate = null;
    await awaitDetachedCondense(key);

    // Deux appels LLM = UNE passe (statut + résumé en parallèle), pas deux.
    expect(llmCalls).toBe(2);
  });

  it('l\'écriture détachée ré-entre dans le verrou de clé : un append concurrent ne peut pas être écrasé', async () => {
    const { key, status } = await populateBelowThreshold();
    const tokenB = 'APPEND-CONCURRENT-4527';

    let enteredGatedCopy!: () => void;
    const gatedCopyEntered = new Promise<void>(resolve => { enteredGatedCopy = resolve; });
    let enteredCopyAfterGate!: () => void;
    const copyAfterGateEntered = new Promise<void>(resolve => { enteredCopyAfterGate = resolve; });
    let releaseGatedCopy!: () => void;
    const gatedCopyBarrier = new Promise<void>(resolve => { releaseGatedCopy = resolve; });

    // Copie #1 = l'écriture incrémentale de l'append A (celle qui rend la main à
    // l'appelant) ; copie #2 = l'écriture FUSIONNÉE de la passe détachée, celle
    // qu'on tient ouverte pour ouvrir la fenêtre de course.
    fsGate.enabled = true;
    fsGate.gateAtCall = 2;
    fsGate.copyCalls = 0;
    fsGate.copyAfterGateEntered = false;
    fsGate.onGatedCopy = enteredGatedCopy;
    fsGate.onCopyAfterGate = enteredCopyAfterGate;
    fsGate.gatedCopyBarrier = gatedCopyBarrier;
    fsGate.releaseGated = releaseGatedCopy;

    // A franchit le seuil : sa passe détachée part, et va jusqu'à l'écriture
    // finale (relecture-fusion faite, copyFile en vol).
    const a = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: crossingContent(status, 'A-VERROU-4527'),
      tags: ['INFO'],
    });
    expect(a.condensationDeferred).toBe(true);
    await gatedCopyEntered;

    // B arrive pendant cette écriture. Sous le verrou de clé il doit ATTENDRE —
    // sans lui, il franchit sa propre copyFile sur une vue antérieure à la fusion
    // et son message est ensuite écrasé (la course reproduite par Hermes).
    const bPromise = roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: `B ${tokenB} ${'w'.repeat(800)}`,
      tags: ['INFO'],
    });
    // Témoin négatif : sous le verrou, B n'entre JAMAIS dans son écriture ; sans
    // le verrou il y entre en quelques millisecondes. La course est bornée des
    // deux côtés (signal positif vs délai), pas par un sleep nu.
    const outcome = await Promise.race([
      copyAfterGateEntered.then(() => 'entered' as const),
      new Promise<'not-entered'>(resolve => setTimeout(() => resolve('not-entered'), 300)),
    ]);
    expect(outcome).toBe('not-entered');

    releaseGatedCopy();
    fsGate.releaseGated = null;
    const b = await bPromise;
    await awaitDetachedCondense(key);

    expect(b.success).toBe(true);
    expect(await messageSurvivesAnywhere(tokenB)).toBe(true);
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

  it('rend l\'issue de la passe ok à la lecture ET à l\'append suivants (#4536)', async () => {
    const { key, status } = await populateBelowThreshold();

    const a = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: crossingContent(status, 'SUCCES-ISSUE-4536'),
      tags: ['INFO'],
    });
    expect(a.condensationDeferred).toBe(true);
    // Au départ de la passe : son issue n'existe pas encore — rien de retenu.
    expect(a.condensationLastOutcome).toBeUndefined();

    await awaitDetachedCondense(key);

    const read = await roosyncDashboard({ action: 'read', type: 'workspace', section: 'status' });
    expect(read.condensationLastOutcome).toMatchObject({
      outcome: 'ok',
      diag: {
        phase: 'post-append',
        outcome: 'condensed',
      },
    });
    expect(read.condensationLastOutcome!.diag.archivedMessageCount).toBeGreaterThan(0);
    expect(read.condensationLastOutcome!.diag.llm).toBeDefined();
    expect(Number.isNaN(Date.parse(read.condensationLastOutcome!.finishedAt))).toBe(false);

    // Même verdict depuis l'append suivant de la même clé.
    const b = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'petit message après la passe',
      tags: ['INFO'],
    });
    expect(b.condensationLastOutcome).toMatchObject({ outcome: 'ok' });
  });

  it('journalise le diag COMPLET au warn d\'échec — le mutant « diag retiré du log » rougit (#4536)', async () => {
    const { key, status } = await populateBelowThreshold();
    const token = 'ECHEC-DIAG-4536';
    // Les échecs LLM sont absorbés (truncation fallback) : c'est l'écriture
    // d'archive qui fait sortir condenseIntercom par le throw et atteint le
    // catch détaché.
    fsFail.archiveWriteFails = true;

    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: crossingContent(status, token),
      tags: ['INFO'],
    });
    expect(result.condensationDeferred).toBe(true);
    await awaitDetachedCondense(key);

    const failWarn = warn.mock.calls.find(([m]) => String(m).includes('Detached condensation failed'));
    expect(failWarn).toBeDefined();
    const meta = failWarn![1] as Record<string, unknown>;
    expect(meta.key).toBe(key);
    expect(meta.error).toBe('injected archive write failure (#4536)');
    // Le diag complet voyage dans le warn : sans ce champ, l'échec ne disait
    // rien de sa cause (jambe LLM, tentatives, durée de la passe).
    expect(meta.diag).toMatchObject({
      phase: 'post-append',
      outcome: 'llm-failed-injected',
    });
    expect(typeof (meta.diag as Record<string, unknown>).elapsedMs).toBe('number');
    expect((meta.diag as Record<string, unknown>).llm).toBeDefined();
    expect(typeof meta.elapsedMs).toBe('number');

    // Aucune perte : le message et le statut précédent survivent à l'échec.
    expect(await messageSurvivesAnywhere(token)).toBe(true);
    expect(await readStatusSection(key)).toContain(status);
  });

  it('rend l\'issue error à la lecture suivante quand la passe détachée échoue (#4536)', async () => {
    const { key, status } = await populateBelowThreshold();
    fsFail.archiveWriteFails = true;

    await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: crossingContent(status, 'ECHEC-ISSUE-4536'),
      tags: ['INFO'],
    });
    await awaitDetachedCondense(key);

    const read = await roosyncDashboard({ action: 'read', type: 'workspace', section: 'status' });
    expect(read.condensationLastOutcome).toMatchObject({
      outcome: 'error',
      error: 'injected archive write failure (#4536)',
      diag: {
        phase: 'post-append',
        outcome: 'llm-failed-injected',
      },
    });
  });
});
