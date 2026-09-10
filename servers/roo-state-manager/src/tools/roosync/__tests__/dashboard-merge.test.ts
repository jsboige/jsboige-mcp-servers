/**
 * #3537 §6.2 — action `merge` : la seule opération qui répare une clé fork
 * dans le store. Un dashboard vit dans DEUX artefacts co-égaux (fichier GDrive
 * + tables PG) ; ces tests verrouillent que le merge écrit la cible via le
 * chemin dual-write ET retire la source des deux côtés (archivée d'abord).
 *
 * Couverture :
 *   - RENAME pur : cible manquante (cas po-2025 — canonique absent), le
 *     contenu de la source devient la cible, source supprimée des deux artefacts ;
 *   - UNION divergente : journaux partiellement disjoints, doublon par id
 *     résolu vers la copie au timestamp le plus récent, tri par timestamp,
 *     compteur totalMessages monotone (jamais régressé) ;
 *   - refus : sourceKey absent, source === cible, source inexistante,
 *     type mismatch (workspace → machine) ;
 *   - deleteSource=false : la source survit, AUCUN delete PG ;
 *   - archives : la source est archivée AVANT retrait (renommage atomique) ;
 *   - rework #1134 ask 1 : verrou append FAIL-CLOSED — pas de verrou, pas de
 *     merge (le fail-open du verrou append des write/append serait destructif
 *     ici : read-modify-write complet + retrait de source) ;
 *   - rework #1134 ask 2 : le retrait de la source est GATING sur la
 *     persistance PG VÉRIFIÉE de l'union (outcome checked) — échec PG ⇒ source
 *     intacte + rapport honnête ; `disabled` (hôte sans moitié PG) ⇒ retrait.
 *
 * Preuves d'artefacts : spies sur dualWriteDashboardSync (le write dual-write
 * de la cible) + dualWriteDashboardSyncChecked / dualWriteDashboardDeleteChecked
 * (les issues PG vérifiées) + lecture directe des fichiers sur disque.
 *
 * Non couvert ici (ininjectable sans point d'injection) : la re-union
 * post-rename (append concurrent DANS la fenêtre lecture→rename) et le re-stat
 * de recréation post-suppression — leurs chemins sont couverts par le code et
 * rapportés par les logs [MERGE].
 *
 * Isolation : store tmpdir UNIQUE par test, env sauvegardé/restauré à
 * l'identique, gates PG fermées (lectures fichier, writers espionnés) —
 * pattern dashboard-empty-key-guard.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';

// Spies sur le chemin dual-write PG — la preuve que le merge écrit/retire
// la moitié PG, pas seulement le fichier. Le reste du module store reste RÉEL,
// sauf readDashboardFromPg (contrôlable : simule la vue PG d'un hôte à porte
// ouverte — défaut null = pas de vue PG, comme une porte fermée) et les
// variantes checked (issues PG simulables).
const { dualWriteSyncSpy, dualWriteDeleteSpy, pgReadSpy, pgSyncCheckedSpy, pgDeleteCheckedSpy } = vi.hoisted(() => ({
  dualWriteSyncSpy: vi.fn(),
  dualWriteDeleteSpy: vi.fn(),
  pgReadSpy: vi.fn(),
  pgSyncCheckedSpy: vi.fn(),
  pgDeleteCheckedSpy: vi.fn(),
}));
vi.mock('../../../services/unified-store/roosync-dashboard-store.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dualWriteDashboardSync: dualWriteSyncSpy,
    dualWriteDashboardDelete: dualWriteDeleteSpy,
    dualWriteDashboardSyncChecked: pgSyncCheckedSpy,
    dualWriteDashboardDeleteChecked: pgDeleteCheckedSpy,
    readDashboardFromPg: pgReadSpy,
  };
});

// #858 / #864: client LLM (condensation) inert — aucune condensation attendue.
vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

import { roosyncDashboard } from '../dashboard.js';

// --- Isolation : un store unique par test --------------------------------
let testDir = '';
let dashboardsDir = '';

const WATCHED_ENV = [
  'ROOSYNC_SHARED_PATH',
  'ROOSYNC_MACHINE_ID',
  'ROOSYNC_WORKSPACE_ID',
  'UNIFIED_STORE_DASHBOARD_READ_PG',
  'UNIFIED_STORE_DUAL_WRITE',
  'UNIFIED_STORE_PG_URL',
  'UNIFIED_STORE_CHANNEL_READ_PG',
  'UNIFIED_STORE_CHANNEL_PG_PRIMARY',
  'APPEND_LOCK_ACQUIRE_BUDGET_MS',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'EMBEDDING_API_KEY',
  'EMBEDDING_API_BASE_URL',
] as const;
let savedEnv: Partial<Record<typeof WATCHED_ENV[number], string | undefined>> = {};

let testSerial = 0;

interface SeedMessage {
  id: string;
  timestamp: string;
  machine?: string;
  content: string;
}

/** Fixture : écrire un dashboard .md complet sur disque (format store réel). */
function seedDashboard(
  filename: string,
  type: 'machine' | 'workspace',
  lastModified: string,
  messages: SeedMessage[],
  extraFrontmatter: Record<string, string> = {}
): void {
  mkdirSync(dashboardsDir, { recursive: true });
  const fm = [
    '---',
    `type: ${type}`,
    `lastModified: ${lastModified}`,
    'lastModifiedBy:',
    '  machineId: seeder',
    '  workspace: test',
    ...Object.entries(extraFrontmatter).map(([k, v]) => `${k}: ${v}`),
    '---',
    '',
    '## Status',
    '',
    `*Statut de ${filename} (lastModified ${lastModified}).*`,
    '',
    `## Intercom (${messages.length} messages)`,
    ''
  ].join('\n');
  const body = messages
    .map(m => `### [${m.timestamp}] ${m.machine ?? 'myia-po-2025'}|CoursIA\n[msg: ${m.id}]\n\n${m.content}`)
    .join('\n\n---\n\n');
  writeFileSync(path.join(dashboardsDir, filename), `${fm}\n${messages.length ? body : '*Aucun message.*'}\n`, 'utf8');
}

const fileExists = (name: string) => existsSync(path.join(dashboardsDir, name));
const fileText = (name: string) => readFileSync(path.join(dashboardsDir, name), 'utf8');

const M = {
  m1old: { id: 'm1', timestamp: '2026-09-05T17:02:00.000Z', content: 'm1 — copie ancienne (cible et fork)' },
  m1new: { id: 'm1', timestamp: '2026-09-07T10:49:00.000Z', content: 'm1 — copie récente (fork)' },
  m2: { id: 'm2', timestamp: '2026-09-06T09:00:00.000Z', content: 'm2 — cible seule' },
  m3: { id: 'm3', timestamp: '2026-09-08T12:48:00.000Z', content: 'm3 — fork seul (écriture du jour)' }
};

beforeEach(() => {
  testDir = path.join(os.tmpdir(), `roosync-merge-${Date.now()}-${process.pid}-${++testSerial}`);
  dashboardsDir = path.join(testDir, 'shared-state', 'dashboards');
  // Le store doit EXISTER (#3459 fail-closed).
  mkdirSync(path.join(testDir, 'shared-state'), { recursive: true });

  savedEnv = {};
  for (const key of WATCHED_ENV) savedEnv[key] = process.env[key];
  process.env.ROOSYNC_SHARED_PATH = path.join(testDir, 'shared-state');
  process.env.ROOSYNC_MACHINE_ID = 'myia-po-2026';
  process.env.ROOSYNC_WORKSPACE_ID = 'roo-extensions';
  // Gates #3151 fermées : lecture fichier, writers espionnés.
  delete process.env.UNIFIED_STORE_DASHBOARD_READ_PG;
  delete process.env.UNIFIED_STORE_DUAL_WRITE;
  delete process.env.UNIFIED_STORE_PG_URL;
  delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
  delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
  delete process.env.APPEND_LOCK_ACQUIRE_BUDGET_MS;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_API_BASE_URL;

  dualWriteSyncSpy.mockClear();
  dualWriteDeleteSpy.mockClear();
  pgSyncCheckedSpy.mockReset();
  pgDeleteCheckedSpy.mockReset();
  // Défaut : PG sain et vérifié (outcome checked nominal).
  pgSyncCheckedSpy.mockResolvedValue({ ok: true, reason: 'written' });
  pgDeleteCheckedSpy.mockResolvedValue({ ok: true, reason: 'written' });
  // Défaut : pas de vue PG (équivalent porte fermée SANS l'asymétrie
  // écrit-sans-lire — le writer est aussi OFF dans cet env).
  pgReadSpy.mockReset();
  pgReadSpy.mockResolvedValue(null);
});

afterEach(() => {
  for (const key of WATCHED_ENV) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(testDir, { recursive: true, force: true });
});

describe('action merge — refus (aucune écriture)', () => {
  it('sourceKey absent → refus explicite, zéro fichier, zéro dual-write', async () => {
    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025'
    }) as any;

    expect(result.success).toBe(false);
    expect(String(result.message)).toContain('sourceKey est requis');
    expect(dualWriteSyncSpy).not.toHaveBeenCalled();
    expect(pgSyncCheckedSpy).not.toHaveBeenCalled();
    expect(dualWriteDeleteSpy).not.toHaveBeenCalled();
    expect(pgDeleteCheckedSpy).not.toHaveBeenCalled();
  });

  it('source === cible → refus, rien à fusionner', async () => {
    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025'
    }) as any;

    expect(result.success).toBe(false);
    expect(String(result.message)).toContain('rien à fusionner');
    expect(dualWriteSyncSpy).not.toHaveBeenCalled();
  });

  it('source inexistante → refus (les clés de action=list font foi)', async () => {
    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(false);
    expect(String(result.message)).toContain("n'existe ni dans le store PG ni sur GDrive");
    expect(dualWriteSyncSpy).not.toHaveBeenCalled();
    expect(dualWriteDeleteSpy).not.toHaveBeenCalled();
  });

  it('type mismatch (source workspace → cible machine) → refus, aucun artefact touché', async () => {
    seedDashboard('workspace-Foo.md', 'workspace', '2026-09-01T00:00:00.000Z', [M.m2]);

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'workspace-Foo'
    }) as any;

    expect(result.success).toBe(false);
    expect(String(result.message)).toContain('type mismatch');
    expect(fileExists('workspace-Foo.md')).toBe(true);
    expect(fileExists('machine-myia-po-2025.md')).toBe(false);
    expect(dualWriteSyncSpy).not.toHaveBeenCalled();
    expect(dualWriteDeleteSpy).not.toHaveBeenCalled();
  });
});

describe('action merge — RENAME pur (cible manquante, cas po-2025 #3537 §3)', () => {
  it('le contenu du fork devient la cible canonique ; source archivée puis retirée des DEUX artefacts', async () => {
    // Fork seul sur disque : 10 messages dans le cas réel, 2 ici — dont une
    // écriture du jour. Canonique ABSENT.
    seedDashboard('machine-myia-po-2025 (1).md', 'machine', '2026-09-08T12:48:00.000Z',
      [M.m1new, M.m3], { totalMessages: '10' });

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(true);
    expect(result.key).toBe('machine-myia-po-2025');
    expect(result.messageCount).toBe(2);
    expect(String(result.message)).toContain('RENAME');

    // La cible canonique existe et porte TOUT le journal du fork.
    expect(fileExists('machine-myia-po-2025.md')).toBe(true);
    const merged = fileText('machine-myia-po-2025.md');
    expect(merged).toContain('[msg: m1]');
    expect(merged).toContain('[msg: m3]');
    expect(merged).toContain('m3 — fork seul');

    // Le fork est retiré du disque…
    expect(fileExists('machine-myia-po-2025 (1).md')).toBe(false);
    // …et de la moitié PG (le geste fichier seul ne l'aurait JAMAIS fait) —
    // par le chemin CHECKED (issue vérifiée), pas le void avalé.
    expect(pgDeleteCheckedSpy).toHaveBeenCalledWith('machine-myia-po-2025 (1)');
    // La cible est écrite via le chemin dual-write (les deux artefacts)…
    expect(dualWriteSyncSpy).toHaveBeenCalledTimes(1);
    expect(dualWriteSyncSpy.mock.calls[0][0].key).toBe('machine-myia-po-2025');
    // …et son upsert PG est CONFIRMÉ avant tout retrait (rework ask 2).
    expect(pgSyncCheckedSpy).toHaveBeenCalledTimes(1);
    expect(pgSyncCheckedSpy.mock.calls[0][0].key).toBe('machine-myia-po-2025');

    // Filet de sécurité : archive pré-merge du contenu source (renommage atomique).
    const archiveDir = path.join(dashboardsDir, 'archive');
    const archives = readdirSync(archiveDir).filter(f => f.startsWith('machine-myia-po-2025 (1)-pre-merge-'));
    expect(archives.length).toBe(1);
    expect(readFileSync(path.join(archiveDir, archives[0]), 'utf8')).toContain('[msg: m3]');
  });

  it('totalMessages ne régresse jamais (compteur monotone flotte, garde #3482)', async () => {
    seedDashboard('machine-myia-po-2025 (1).md', 'machine', '2026-09-08T12:48:00.000Z',
      [M.m3], { totalMessages: '10' });

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(true);
    expect(fileText('machine-myia-po-2025.md')).toMatch(/totalMessages: 10/);
  });
});

describe('action merge — UNION de journaux divergents (fork + cible vivants)', () => {
  beforeEach(() => {
    // Cible canonique figée au 05/09 : m1 (copie ancienne) + m2.
    seedDashboard('machine-myia-po-2025.md', 'machine', '2026-09-05T17:02:00.000Z',
      [M.m1old, M.m2], { totalMessages: '9' });
    // Fork vivant : m1 (copie récente) + m3 (écriture du jour).
    seedDashboard('machine-myia-po-2025 (1).md', 'machine', '2026-09-08T12:48:00.000Z',
      [M.m1new, M.m3], { totalMessages: '10' });
  });

  it('union par id, la copie au timestamp le plus récent gagne, tri chronologique', async () => {
    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(true);
    expect(result.messageCount).toBe(3); // m1 + m2 + m3
    expect(String(result.message)).toContain('1 doublon(s) par id');
    expect(String(result.message)).toContain('1 résolu(s) vers la copie plus récente');

    const merged = fileText('machine-myia-po-2025.md');
    // Le doublon m1 est résolu vers la copie RÉCENTE (celle du fork).
    expect(merged).toContain('m1 — copie récente (fork)');
    expect(merged).not.toContain('m1 — copie ancienne (cible et fork)');
    // Les deux messages non partagés survivent.
    expect(merged).toContain('m2 — cible seule');
    expect(merged).toContain('m3 — fork seul');
    // Tri chronologique : m1new=07/09, m2=06/09, m3=08/09 → ordre m2, m1, m3.
    const iM2 = merged.indexOf('m2 — cible seule');
    const iM1 = merged.indexOf('m1 — copie récente (fork)');
    const iM3 = merged.indexOf('m3 — fork seul');
    expect(iM2).toBeGreaterThan(-1);
    expect(iM1).toBeGreaterThan(iM2);
    expect(iM3).toBeGreaterThan(iM1);

    // Source retirée des deux artefacts.
    expect(fileExists('machine-myia-po-2025 (1).md')).toBe(false);
    expect(pgDeleteCheckedSpy).toHaveBeenCalledWith('machine-myia-po-2025 (1)');
    expect(dualWriteSyncSpy).toHaveBeenCalledTimes(1);
    expect(dualWriteSyncSpy.mock.calls[0][0].key).toBe('machine-myia-po-2025');
  });

  it('le statut retenu est celui du dashboard le plus récent (le fork ici)', async () => {
    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(true);
    expect(String(result.message)).toContain('Statut retenu : source');
    // Le STATUT du fork survit dans la cible (le seed l'identifie par son
    // nom de fichier) — c'est bien le markdown de la source la plus récente.
    expect(fileText('machine-myia-po-2025.md')).toContain('Statut de machine-myia-po-2025 (1).md');
  });

  it('deleteSource=false : la source survit, aucun delete PG, cible quand même fusionnée', async () => {
    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)', deleteSource: false
    }) as any;

    expect(result.success).toBe(true);
    expect(String(result.message)).toContain('Source préservée');
    expect(fileExists('machine-myia-po-2025 (1).md')).toBe(true);
    expect(dualWriteDeleteSpy).not.toHaveBeenCalled();
    expect(pgDeleteCheckedSpy).not.toHaveBeenCalled();
    // La cible porte quand même l'union complète.
    const merged = fileText('machine-myia-po-2025.md');
    expect(merged).toContain('m3 — fork seul');
    expect(merged).toContain('m2 — cible seule');
    expect(dualWriteSyncSpy).toHaveBeenCalledTimes(1);
  });
});

describe('action merge — gardes d’intégrité (revue #1134)', () => {
  it('hôte qui dual-écrit PG sans le lire → REFUS (union aveugle, écrasement du journal PG)', async () => {
    // Asymétrie exacte : writer armé, porte de lecture fermée. La garde lit
    // l'env (miroir du writer-factory) — aucun writer n’est instantié ici.
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://test:test@localhost:5432/test';
    seedDashboard('machine-myia-po-2025 (1).md', 'machine', '2026-09-08T12:48:00.000Z', [M.m3]);

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(false);
    expect(String(result.message)).toContain('union aveugle');
    // RIEN n’a bougé : ni fichier, ni dual-write.
    expect(fileExists('machine-myia-po-2025 (1).md')).toBe(true);
    expect(fileExists('machine-myia-po-2025.md')).toBe(false);
    expect(dualWriteSyncSpy).not.toHaveBeenCalled();
    expect(pgSyncCheckedSpy).not.toHaveBeenCalled();
    expect(dualWriteDeleteSpy).not.toHaveBeenCalled();
    expect(pgDeleteCheckedSpy).not.toHaveBeenCalled();
  });

  it('fork DriveFS ÉTRANGER suspecté sur l’écriture cible → suppression de la source ABANDONNÉE', async () => {
    // Source = alias (ne matche pas le pattern fork ` (N)` de la cible) ;
    // un sibling ` (3)` FRAIS simule une déviation DriveFS pendant l’écriture
    // cible (mtime ≥ fenêtre d’écriture — discriminateur #2 de la garde).
    seedDashboard('workspace-CoursIA-2.md', 'workspace', '2026-09-08T10:00:00.000Z',
      [{ id: 'a1', timestamp: '2026-09-08T10:00:00.000Z', content: 'alias msg' }]);
    seedDashboard('workspace-CoursIA.md', 'workspace', '2026-09-08T11:00:00.000Z',
      [{ id: 'a2', timestamp: '2026-09-08T11:00:00.000Z', content: 'canonique msg' }]);
    // Sibling de collision frais, ni source ni canonique.
    writeFileSync(path.join(dashboardsDir, 'workspace-CoursIA (3).md'), '---\ntype: workspace\n---\n', 'utf8');

    const result = await roosyncDashboard({
      action: 'merge', type: 'workspace', workspace: 'CoursIA',
      sourceKey: 'workspace-CoursIA-2'
    }) as any;

    // L’union est écrite (succès), MAIS la source survit : sa suppression est
    // irréversible et le canonique est suspect.
    expect(result.success).toBe(true);
    expect(String(result.message)).toContain('SUPPRESSION DE LA SOURCE ABANDONNÉE');
    expect(result.writeVerification?.forkSuspected).toBe(true);
    expect(fileExists('workspace-CoursIA-2.md')).toBe(true);
    expect(pgDeleteCheckedSpy).not.toHaveBeenCalled();
    expect(dualWriteDeleteSpy).not.toHaveBeenCalled();
    // La cible a bien reçu l’union (le write est passé, seul le retrait est abandonné).
    expect(dualWriteSyncSpy).toHaveBeenCalledTimes(1);
    expect(fileText('workspace-CoursIA.md')).toContain('alias msg');
  });
});

describe('action merge — gardes d’intégrité, 2e série (revue #1134, bis)', () => {
  it('sourceKey = chemin (traversal) → REFUS avant tout path.join, rien touché', async () => {
    mkdirSync(dashboardsDir, { recursive: true });
    for (const bad of ['../../secret', 'a/b', 'a\\b', 'C:\\x', 'a:b', '..']) {
      const result = await roosyncDashboard({
        action: 'merge', type: 'machine', machineId: 'myia-po-2025', sourceKey: bad
      }) as any;
      expect(result.success, `sourceKey '${bad}' doit être refusé`).toBe(false);
      expect(String(result.message)).toContain('caractères de chemin');
    }
    // Aucun fichier créé nulle part dans le store.
    expect(readdirSync(dashboardsDir).length).toBe(0);
    expect(dualWriteSyncSpy).not.toHaveBeenCalled();
    expect(dualWriteDeleteSpy).not.toHaveBeenCalled();
  });

  it('union des QUATRE vues : un message PG-seul ET un message fichier-seul survivent tous deux', async () => {
    // Divergence mesurée #3537 §2 (15/63) : la vue PG de la cible ne contient
    // PAS le message fichier-seul, et le fichier ne contient PAS le message
    // PG-seul. Une union fondée sur une seule vue en écraserait un des deux.
    seedDashboard('machine-myia-po-2025 (1).md', 'machine', '2026-09-08T12:48:00.000Z',
      [{ id: 'f1', timestamp: '2026-09-08T12:48:00.000Z', content: 'f1 — fichier seul (source)' }]);
    seedDashboard('machine-myia-po-2025.md', 'machine', '2026-09-08T11:00:00.000Z',
      [{ id: 'f2', timestamp: '2026-09-08T11:00:00.000Z', content: 'f2 — fichier seul (cible)' }]);
    const pgOnlyView = {
      type: 'machine' as const,
      key: 'machine-myia-po-2025',
      lastModified: '2026-09-08T10:00:00.000Z',
      lastModifiedBy: { machineId: 'pg', workspace: 'pg' },
      status: { markdown: '*Statut PG (le plus ancien — ne doit PAS gagner).*' },
      intercom: {
        messages: [{
          id: 'p1', timestamp: '2026-09-08T10:00:00.000Z',
          author: { machineId: 'pg', workspace: 'pg' },
          content: 'p1 — PG seul (cible)'
        }],
        totalMessages: 1
      }
    };
    pgReadSpy.mockImplementation(async (k: string) =>
      k === 'machine-myia-po-2025' ? pgOnlyView : null);

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(true);
    expect(result.messageCount).toBe(3);
    const merged = fileText('machine-myia-po-2025.md');
    // Les trois messages — chaque artefact contribuait un message que l'autre
    // ne voyait pas — sont dans la cible.
    expect(merged).toContain('f1 — fichier seul (source)');
    expect(merged).toContain('f2 — fichier seul (cible)');
    expect(merged).toContain('p1 — PG seul (cible)');
    // Statut : la vue la plus RÉCENTE (fichier source 12:48) gagne, pas la vue PG.
    expect(merged).toContain('Statut de machine-myia-po-2025 (1).md');
    expect(merged).not.toContain('Statut PG');
    expect(fileExists('machine-myia-po-2025 (1).md')).toBe(false);
    expect(pgDeleteCheckedSpy).toHaveBeenCalledWith('machine-myia-po-2025 (1)');
  });

  it('source statut-seul (0 message) → ARCHIVÉE quand même avant retrait (revue #1134 mineur)', async () => {
    // 0 message mais Status non trivial : sans la garde, cette source serait
    // supprimée des deux artefacts SANS archive — son statut ne survivrait
    // que s'il était le plus frais.
    seedDashboard('machine-myia-po-2025 (1).md', 'machine', '2026-09-08T09:00:00.000Z', []);
    seedDashboard('machine-myia-po-2025.md', 'machine', '2026-09-08T13:00:00.000Z', [M.m2]);

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(true);
    expect(fileExists('machine-myia-po-2025 (1).md')).toBe(false);
    const archiveDir = path.join(dashboardsDir, 'archive');
    const archives = readdirSync(archiveDir).filter(f => f.startsWith('machine-myia-po-2025 (1)-pre-merge-'));
    expect(archives.length).toBe(1);
    expect(readFileSync(path.join(archiveDir, archives[0]), 'utf8')).toContain('Statut de machine-myia-po-2025 (1).md');
  });
});

describe('action merge — rework #1134 ask 2 : retrait GATING sur la persistance PG vérifiée', () => {
  beforeEach(() => {
    seedDashboard('machine-myia-po-2025 (1).md', 'machine', '2026-09-08T12:48:00.000Z',
      [M.m3], { totalMessages: '10' });
    seedDashboard('machine-myia-po-2025.md', 'machine', '2026-09-05T17:02:00.000Z',
      [M.m1old], { totalMessages: '2' });
  });

  it("échec du upsert PG de l'union (épuisement retries) → union écrite côté FICHIER, source INTACTE, aucun delete", async () => {
    // L'ancien chemin avalait cet échec (dualWriteDashboardSync → withRetry
    // void) et retirait quand même la source : les messages n'existant qu'en
    // PG étaient anéantis. La rework gating le retrait sur l'outcome.
    pgSyncCheckedSpy.mockResolvedValue({ ok: false, reason: 'exhausted', detail: 'simulated PG outage' });

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(true);
    expect(result.messageCount).toBe(2); // m1 + m3
    expect(String(result.message)).toContain('DIFFÉRÉE');
    expect(String(result.message)).toContain('exhausted');
    // L'union EST dans le fichier cible…
    expect(fileText('machine-myia-po-2025.md')).toContain('m3 — fork seul');
    // …mais la source est intacte (fichier présent, aucun delete PG).
    expect(fileExists('machine-myia-po-2025 (1).md')).toBe(true);
    expect(dualWriteDeleteSpy).not.toHaveBeenCalled();
    expect(pgDeleteCheckedSpy).not.toHaveBeenCalled();
  });

  it("breaker OPEN sur le upsert PG → même gating (skip silencieux ≠ écrit)", async () => {
    pgSyncCheckedSpy.mockResolvedValue({ ok: false, reason: 'breaker-skip', detail: 'circuit breaker OPEN' });

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(true);
    expect(String(result.message)).toContain('breaker-skip');
    expect(fileExists('machine-myia-po-2025 (1).md')).toBe(true);
    expect(pgDeleteCheckedSpy).not.toHaveBeenCalled();
  });

  it("outcome `disabled` (hôte sans moitié PG, Null writer) → retrait AUTORISÉ", async () => {
    pgSyncCheckedSpy.mockResolvedValue({ ok: false, reason: 'disabled' });
    pgDeleteCheckedSpy.mockResolvedValue({ ok: false, reason: 'disabled' });

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(true);
    expect(fileExists('machine-myia-po-2025 (1).md')).toBe(false);
    expect(fileText('machine-myia-po-2025.md')).toContain('m3 — fork seul');
    expect(String(result.message)).not.toContain('DIFFÉRÉE');
  });

  it("échec du DELETE PG de la source (union persistée) → retrait partiel RAPPORTÉ honnêtement, archive conservée", async () => {
    pgDeleteCheckedSpy.mockResolvedValue({ ok: false, reason: 'breaker-skip', detail: 'circuit breaker OPEN' });

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(true);
    // L'union est bien dans la cible ET persistée (sync checked nominal).
    expect(fileText('machine-myia-po-2025.md')).toContain('m3 — fork seul');
    expect(pgSyncCheckedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'machine-myia-po-2025' })
    );
    // Moitié fichier retirée (renommage vers l'archive)…
    expect(fileExists('machine-myia-po-2025 (1).md')).toBe(false);
    const archiveDir = path.join(dashboardsDir, 'archive');
    const archives = readdirSync(archiveDir).filter(f => f.startsWith('machine-myia-po-2025 (1)-pre-merge-'));
    expect(archives.length).toBe(1);
    // …moitié PG résiduelle RAPPORTÉE (pas avalée).
    expect(String(result.message)).toContain('retrait partiel');
    expect(String(result.message)).toContain('breaker-skip');
  });
});

describe('action merge — rework #1134 ask 1 : verrou append FAIL-CLOSED', () => {
  it("verrou append non acquis (holder frais concurrent, budget épuisé) → REFUS, zéro écriture", async () => {
    // Le verrou append des write/append est fail-open PAR CONCEPTION (un
    // append rarissime non sérialisé vaut mieux qu'un append perdu). Pour le
    // merge — read-modify-write COMPLET + retrait de source — le fail-open
    // serait destructif : il doit REFUSER.
    seedDashboard('machine-myia-po-2025 (1).md', 'machine', '2026-09-08T12:48:00.000Z', [M.m3]);
    // Holder frais d'un autre process sur la clé CIBLE (première de l'ordre
    // trié), budget d'acquisition court → acquisition impossible.
    process.env.APPEND_LOCK_ACQUIRE_BUDGET_MS = '60';
    writeFileSync(
      path.join(dashboardsDir, 'machine-myia-po-2025.append.lock'),
      JSON.stringify({
        machineId: 'myia-po-2026', workspace: 'roo-extensions',
        pid: 999999, acquiredAt: new Date().toISOString()
      }),
      'utf8'
    );

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(false);
    expect(String(result.message)).toContain('verrou append non acquis');
    expect(String(result.message)).toContain('fail-closed');
    // RIEN n'a bougé : ni cible créée, ni source touchée, ni dual-write.
    expect(fileExists('machine-myia-po-2025.md')).toBe(false);
    expect(fileExists('machine-myia-po-2025 (1).md')).toBe(true);
    expect(dualWriteSyncSpy).not.toHaveBeenCalled();
    expect(pgSyncCheckedSpy).not.toHaveBeenCalled();
    expect(dualWriteDeleteSpy).not.toHaveBeenCalled();
    expect(pgDeleteCheckedSpy).not.toHaveBeenCalled();
  });
});

describe('action merge — workspace (cas CoursIA-like, cible vivante)', () => {
  it('merge workspace fork → clé dérivée workspace', async () => {
    seedDashboard('workspace-CoursIA (1).md', 'workspace', '2026-09-08T12:53:31.000Z',
      [{ id: 'w1', timestamp: '2026-09-08T12:53:31.000Z', content: 'w1 fork' }]);
    seedDashboard('workspace-CoursIA.md', 'workspace', '2026-09-08T13:54:45.000Z',
      [{ id: 'w2', timestamp: '2026-09-08T13:54:45.000Z', content: 'w2 canonique' }]);

    const result = await roosyncDashboard({
      action: 'merge', type: 'workspace', workspace: 'CoursIA',
      sourceKey: 'workspace-CoursIA (1)'
    }) as any;

    expect(result.success).toBe(true);
    expect(result.key).toBe('workspace-CoursIA');
    expect(result.messageCount).toBe(2);
    // Statut : cible plus récente (13:54:45 > 12:53:31).
    expect(String(result.message)).toContain('Statut retenu : cible');
    expect(fileExists('workspace-CoursIA (1).md')).toBe(false);
    expect(fileExists('workspace-CoursIA.md')).toBe(true);
    expect(pgDeleteCheckedSpy).toHaveBeenCalledWith('workspace-CoursIA (1)');
  });
});
