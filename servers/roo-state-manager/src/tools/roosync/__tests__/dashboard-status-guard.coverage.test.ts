/**
 * #3962 / Maintenance#33 — garde « jamais pire que l'entrée » du statut de condensation.
 *
 * Incident fondateur (ai-01, 02/10 07:4xZ sur machine-myia-ai-01) : la condensation a
 * accepté comme nouveau statut un artefact d'échec transporté en HTTP 200 —
 * `[Error: The model returned an empty response (finish_reason: stop)…]` — remplaçant
 * ~14,9 Ko de doctrine, non archivés (l'archive ne conserve que l'intercom).
 *
 * Deux garde-fous, dispatch ai-01 03/10 23:02Z :
 *  (a) `isModelFailureStatus` — un statut rendu par le modèle qui est vide après
 *      trim, qui commence par `[Error:`, ou qui est nettement plus court que
 *      l'entrée est un échec du modèle → `executeTruncationFallback`, qui garde
 *      l'ancien statut. Le seuil « nettement plus court » (rétention minimale)
 *      est mesuré sur les archives : une condensation a le droit de raccourcir.
 *  (b) Le statut d'avant condensation est écrit dans le fichier d'archive, à
 *      côté de l'intercom — les DEUX chemins (succès LLM et fallback).
 *
 * Contrats intégration (harnais #2719 condensation-notice, mocks clients OpenAI,
 * routage par prompt système) :
 *  (i1) 200 dont le contenu est `[Error: …]` → statut intact + bandeau fallback.
 *  (i2) 200 dont le contenu est nettement trop court → même garde.
 *  (i3) statut légitime (raccourcissement au-dessus du seuil) → succès.
 *  (i4) l'archive porte le statut d'avant (chemins succès ET fallback).
 *
 * @module tools/roosync/__tests__/dashboard-status-guard
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  roosyncDashboard,
  resetCondenseCircuitBreaker,
  isModelFailureStatus,
  STATUS_MIN_RETENTION_RATIO,
} from '../dashboard.js';

const mockPrimaryCreate = vi.fn();
const mockGetPrimaryClient = vi.fn();
const mockFallbackCreate = vi.fn();
const mockGetFallbackClient = vi.fn();

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetPrimaryClient(),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-primary-model',
  getFallbackChatOpenAIClient: () => mockGetFallbackClient(),
  getFallbackLLMModelId: () => 'glm-4.7-flash',
}));

// ============================================================
// Partie 1 — prédicat pur isModelFailureStatus
// ============================================================

describe('isModelFailureStatus (#3962 — prédicat)', () => {

  it('1. artefact d\'erreur : le datapoint exact de l\'incident → failed/error-artifact', () => {
    const v = isModelFailureStatus(
      '[Error: The model returned an empty response (finish_reason: stop)…]',
      '# Doctrine opérationnelle\n- item 1\n- item 2',
    );
    expect(v.failed).toBe(true);
    if (v.failed) expect(v.reason).toBe('error-artifact');
  });

  it('2. vide après trim (espaces, newlines) et null → failed/empty', () => {
    for (const cand of ['', '   \n\t  ', null, undefined]) {
      const v = isModelFailureStatus(cand as string | null, '# statut précédent');
      expect(v.failed).toBe(true);
      if (v.failed) expect(v.reason).toBe('empty');
    }
  });

  it('3. nettement plus court que l\'entrée → failed/too-short', () => {
    const prev = 'x'.repeat(10_000);
    const cand = 'y'.repeat(400); // 4 % de l'entrée
    const v = isModelFailureStatus(cand, prev);
    expect(v.failed).toBe(true);
    if (v.failed) expect(v.reason).toBe('too-short');
  });

  it('4. raccourcissement LÉGITIME (au-dessus du seuil mesuré) → passed', () => {
    const prev = 'x'.repeat(10_000);
    const cand = 'y'.repeat(Math.ceil(10_000 * STATUS_MIN_RETENTION_RATIO) + 500);
    const v = isModelFailureStatus(cand, prev);
    expect(v.failed).toBe(false);
  });

  it('5. statut plus long ou égal → passed', () => {
    const v = isModelFailureStatus('y'.repeat(5_000), 'x'.repeat(3_000));
    expect(v.failed).toBe(false);
  });

  it('6. première condensation (statut précédent vide) : seul empty/error-artifact s\'appliquent', () => {
    // Pas de previousStatus → un statut court mais substantiel est légitime.
    const v = isModelFailureStatus('## Statut\n- premier point', '');
    expect(v.failed).toBe(false);
    // …mais l'artefact d'erreur reste intercepté même sans entrée.
    const e = isModelFailureStatus('[Error: whatever]', '');
    expect(e.failed).toBe(true);
  });

  it('7. un artefact [Error: long reste un artefact, même au-dessus du seuil de longueur', () => {
    const long = '[Error: ' + 'd'.repeat(20_000) + ']';
    const v = isModelFailureStatus(long, 'x'.repeat(1_000));
    expect(v.failed).toBe(true);
    if (v.failed) expect(v.reason).toBe('error-artifact');
  });

  // #3962 suivi (dispatch c0355) : normalisation de casse + crochet optionnel —
  // `[error:`, `Error:` et `error:` sans crochet passaient la porte du préfixe.
  it('8. variante minuscule crochetée `[error: …]` → error-artifact', () => {
    const v = isModelFailureStatus(
      '[error: The model returned an empty response (finish_reason: stop)…]',
      '# Doctrine opérationnelle\n- item 1',
    );
    expect(v.failed).toBe(true);
    if (v.failed) expect(v.reason).toBe('error-artifact');
  });

  it('9. sans crochet (`Error:`/`error:`) et casse mélangée (`[ERROR:`) → error-artifact', () => {
    for (const cand of [
      'Error: The model returned an empty response…',
      'error: request timed out after 60000ms',
      '[ERROR: bad gateway from provider]',
    ]) {
      const v = isModelFailureStatus(cand, '# Doctrine opérationnelle\n- item 1');
      expect(v.failed).toBe(true);
      if (v.failed) expect(v.reason).toBe('error-artifact');
    }
  });

  it('10. ancrage début-de-texte : `error:` cité en MILIEU de statut légitime passe', () => {
    const legit = '# Statut\n- incident constaté : error: timeout sur la jambe fallback (citation)\n- règle conservée.';
    const v = isModelFailureStatus(legit, 'x'.repeat(300));
    expect(v.failed).toBe(false);
  });
});

// ============================================================
// Partie 2 — intégration : la condensation route vers le fallback
// ============================================================

const testTmpBase = path.join(os.tmpdir(), 'dashboard-status-guard-');

describe('#3962 garde du statut de condensation (intégration)', { timeout: 60_000 }, () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_API_BASE_URL;
    mockGetPrimaryClient.mockImplementation(() => { throw new Error('No chat API key configured'); });
    mockPrimaryCreate.mockReset();
    mockGetFallbackClient.mockImplementation(() => null);
    mockFallbackCreate.mockReset();
    resetCondenseCircuitBreaker();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  // Statut initial substantiel : la doctrine doit survivre à la condensation.
  const DOCTRINE = '# Doctrine DOCTRINE-MARKER-3962\n' +
    Array.from({ length: 120 }, (_, i) => `- règle durable #${i} : ne jamais perdre ce point en condensation.`).join('\n');

  async function fillUntilCondensed(): Promise<any> {
    await roosyncDashboard({ action: 'write', type: 'global', content: DOCTRINE });
    const filler = 'X'.repeat(3000);
    let condensedResult: any = null;
    for (let i = 0; i < 20; i++) {
      const result = await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: `${filler} message-${i}`,
      });
      if ((result as any).condensed && !condensedResult) {
        condensedResult = result;
      }
    }
    expect(condensedResult).not.toBeNull();
    return condensedResult;
  }

  async function readDashboardFile(): Promise<string> {
    return readFile(path.join(tmpDir, 'dashboards', 'global.md'), 'utf8');
  }

  // Le statut répond sur le prompt « synthèse de dashboards de coordination », le
  // résumé sur « synthèse de communications inter-agents » (discriminants #2719 t4).
  function mockPrimaryLegs(statusContent: string, summaryContent = '## Résumé\n\nRésumé valide.'): void {
    mockGetPrimaryClient.mockReturnValue({
      chat: { completions: { create: mockPrimaryCreate } },
    });
    mockPrimaryCreate.mockImplementation(async (req: any) => {
      const sys = req?.messages?.[0]?.content ?? '';
      if (sys.includes('synthèse de communications inter-agents')) {
        return { choices: [{ message: { content: summaryContent } }] };
      }
      return { choices: [{ message: { content: statusContent } }] };
    });
  }

  it('(i1) 200 dont le statut est `[Error: …]` → statut intact, bandeau fallback, pas de résumé', async () => {
    mockPrimaryLegs('[Error: The model returned an empty response (finish_reason: stop)…]');

    const result = await fillUntilCondensed();

    // La passe est dégradée en fallback-truncated, pas un succès.
    expect(result.condenseDiagnostic.some((d: any) => d.outcome === 'fallback-truncated')).toBe(true);
    expect(result.condenseDiagnostic.some((d: any) => d.outcome === 'condensed')).toBe(false);

    const md = await readDashboardFile();
    // La doctrine survit…
    expect(md).toContain('DOCTRINE-MARKER-3962');
    // …l'artefact d'erreur ne JAMAIS atteindre le statut…
    expect(md).not.toContain('[Error:');
    // …et le bandeau de repli est posé (contrat observabilité #2719).
    expect(md).toContain('FALLBACK TRUNCATION');
    expect(md).not.toContain('CONDENSATION-SUMMARY');
  });

  it('(i2) 200 dont le statut est nettement trop court → même garde', async () => {
    // ~250 octets face à une doctrine de ~6 Ko : ratio ≈ 4 %, sous toute rétention légitime.
    mockPrimaryLegs('## Statut\n- un point.');

    const result = await fillUntilCondensed();

    expect(result.condenseDiagnostic.some((d: any) => d.outcome === 'fallback-truncated')).toBe(true);
    const md = await readDashboardFile();
    expect(md).toContain('DOCTRINE-MARKER-3962');
    expect(md).toContain('FALLBACK TRUNCATION');
  });

  it('(i5) 200 dont le statut est `error:` minuscule SANS crochet → mêmes garanties que i1 (c0355)', async () => {
    // Artefact LONG (> seuil de rétention) : le garde too-short ne peut PAS
    // l'attraper — seul le préfixe normalisé (casse + crochet optionnel) peut.
    const artifact = 'error: The model returned an empty response (finish_reason: stop) — ' +
      'retry attempt failed. '.repeat(300);
    mockPrimaryLegs(artifact);

    const result = await fillUntilCondensed();

    expect(result.condenseDiagnostic.some((d: any) => d.outcome === 'fallback-truncated')).toBe(true);
    expect(result.condenseDiagnostic.some((d: any) => d.outcome === 'condensed')).toBe(false);

    const md = await readDashboardFile();
    expect(md).toContain('DOCTRINE-MARKER-3962');
    expect(md).not.toContain('error: The model returned');
    expect(md).toContain('FALLBACK TRUNCATION');
    expect(md).not.toContain('CONDENSATION-SUMMARY');
  });

  it('(i3) statut légitime au-dessus du seuil de rétention → condensation normale', async () => {
    // Raccourcissement réaliste : la doctrine (~6 Ko) devient ~60 % de sa taille.
    const legit = '# Statut DOCTRINE-MARKER-3962\n' +
      Array.from({ length: 70 }, (_, i) => `- règle conservée #${i}.`).join('\n');
    mockPrimaryLegs(legit);

    const result = await fillUntilCondensed();

    expect(result.condenseDiagnostic.some((d: any) => d.outcome === 'condensed')).toBe(true);
    const md = await readDashboardFile();
    expect(md).toContain('Statut DOCTRINE-MARKER-3962');
    expect(md).not.toContain('FALLBACK TRUNCATION');
  });

  it('(i4) l\'archive porte le statut d\'avant condensation — chemins succès ET fallback', async () => {
    // Chemin fallback : statut empoisonné → l'archive -fallback.md doit porter la doctrine.
    mockPrimaryLegs('[Error: empty response]');
    await fillUntilCondensed();

    const archiveDir = path.join(tmpDir, 'dashboards', 'archive');
    let files = await readdir(archiveDir);
    const fallbackArchives = files.filter(f => f.endsWith('-fallback.md'));
    expect(fallbackArchives.length).toBeGreaterThanOrEqual(1);
    const fbContent = await readFile(path.join(archiveDir, fallbackArchives[0]), 'utf8');
    expect(fbContent).toContain('Statut avant condensation');
    expect(fbContent).toContain('DOCTRINE-MARKER-3962');

    // Chemin succès : nouveau tmpdir, statut légitime → l'archive normale la porte aussi.
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    const archiveDir2 = path.join(tmpDir, 'dashboards', 'archive');
    resetCondenseCircuitBreaker();
    const legit = '# Statut DOCTRINE-MARKER-3962\n' +
      Array.from({ length: 70 }, (_, i) => `- règle conservée #${i}.`).join('\n');
    mockPrimaryLegs(legit);
    await fillUntilCondensed();

    files = await readdir(archiveDir2);
    const successArchives = files.filter(f => !f.endsWith('-fallback.md'));
    expect(successArchives.length).toBeGreaterThanOrEqual(1);
    const okContent = await readFile(path.join(archiveDir2, successArchives[0]), 'utf8');
    expect(okContent).toContain('Statut avant condensation');
    expect(okContent).toContain('DOCTRINE-MARKER-3962');
  });
});
