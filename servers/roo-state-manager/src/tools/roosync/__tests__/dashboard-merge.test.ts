/**
 * #3537 §6.2 — action `merge` : la seule opération qui répare une clé fork
 * dans le store. Un dashboard vit dans DEUX artefacts co-égaux (fichier GDrive
 * + tables PG) ; ces tests verrouillent que le merge écrit la cible via le
 * chemin dual-write ET retire la source des deux côtés (archivée d'abord).
 *
 * Couverture :
 *   - RENAME pur : cible manquante (cas po-2025 — canonique absent), le
 *     contenu de la source devient la cible, source retirée des deux artefacts ;
 *   - UNION divergente : journaux partiellement disjoints, doublon par id
 *     résolu vers la copie au timestamp le plus récent, tri par timestamp,
 *     compteur totalMessages monotone (jamais régressé) ;
 *   - refus : sourceKey absent, source === cible, source inexistante,
 *     type mismatch (workspace → machine) ;
 *   - #3782 : `deleteSource` ne gouverne QUE le fichier — le journal retire
 *     la source par une MARQUE (`roosync_dashboard_retirements`) dans les DEUX
 *     cas, jamais par le DELETE cascade (les lignes restent en base, gel des
 *     purges) ; deleteSource=false : fichier préservé + marque posée ;
 *   - archives : la source est archivée AVANT retrait (renommage atomique) ;
 *   - rework #1134 ask 1 : verrou append FAIL-CLOSED — pas de verrou, pas de
 *     merge (le fail-open du verrou append des write/append serait destructif
 *     ici : read-modify-write complet + retrait de source) ;
 *   - rework #1134 ask 2 : le retrait de la source est GATING sur la
 *     persistance PG VÉRIFIÉE de l'union (outcome checked) — échec PG ⇒ source
 *     intacte + rapport honnête ; `disabled` (hôte sans moitié PG) ⇒ retrait.
 *
 * Preuves d'artefacts : spies sur dualWriteDashboardSync (le write dual-write
 * de la cible) + dualWriteDashboardSyncChecked (l'issue PG vérifiée de
 * l'union) + retireDashboardKeyChecked (la marque #3782 — le DELETE cascade
 * reste l'apanage du delete explicite) + lecture directe des fichiers sur disque.
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
const { dualWriteSyncSpy, dualWriteDeleteSpy, pgReadSpy, pgSyncCheckedSpy, pgDeleteCheckedSpy, retireCheckedSpy, getRetirementSpy, listRetiredSpy, archivedIdsSpy } = vi.hoisted(() => ({
  dualWriteSyncSpy: vi.fn(),
  dualWriteDeleteSpy: vi.fn(),
  pgReadSpy: vi.fn(),
  pgSyncCheckedSpy: vi.fn(),
  pgDeleteCheckedSpy: vi.fn(),
  retireCheckedSpy: vi.fn(),
  getRetirementSpy: vi.fn(),
  listRetiredSpy: vi.fn(),
  archivedIdsSpy: vi.fn(),
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
    retireDashboardKeyChecked: retireCheckedSpy,
    getDashboardRetirement: getRetirementSpy,
    listRetiredDashboardKeys: listRetiredSpy,
    fetchArchivedDashboardMessageIds: archivedIdsSpy,
  };
});

// #4439 — namespace 'fs/promises' rendu spaiable (pass-through pur : toutes
// les fonctions restent les vraies). Un namespace ESM nu jette « not
// configurable » au spyOn (cf. cascade-env-file.test.ts) ; le passthrough
// permet aux tests de garde canonique d'injecter une déviation copyFile
// DriveFS le temps d'un test (pattern dashboard-pg-primary.test.ts).
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual };
});

// #858 / #864: client LLM (condensation) inert — aucune condensation attendue.
vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

import { roosyncDashboard, getAppendLockPath } from '../dashboard.js';

// --- Isolation : un store unique par test --------------------------------
let testDir = '';
let dashboardsDir = '';

const WATCHED_ENV = [
  'ROOSYNC_SHARED_PATH',
  'ROOSYNC_LOCK_DIR',
  'ROOSYNC_MACHINE_ID',
  'ROOSYNC_WORKSPACE_ID',
  'ROOSYNC_TRUSTED_CALLER_IDS',
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
  // #4135 — ce harnais simule un siège qui merge le dashboard D'UNE AUTRE
  // MACHINE (`machineId: 'myia-po-2025'`, plusieurs appels par test) depuis un
  // process 'myia-po-2026'. `merge` stampe `lastModifiedBy` : le gate d'auteur
  // exige donc que la machine simulée soit déclarée, exactement comme un
  // opérateur réel mergeant un dashboard étranger doit le faire. Remède #3591
  // appliqué à ses propres tests : l'intention des tests est inchangée, seule
  // la déclaration de confiance est nouvelle.
  process.env.ROOSYNC_TRUSTED_CALLER_IDS = 'myia-po-2025';
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
  // #3782 — défauts : marque posée au premier tour, aucune marque active côté
  // lectures (fail-open, aucune clé retirée).
  retireCheckedSpy.mockReset();
  retireCheckedSpy.mockResolvedValue({ ok: true, reason: 'written' });
  getRetirementSpy.mockReset();
  getRetirementSpy.mockResolvedValue(null);
  listRetiredSpy.mockReset();
  listRetiredSpy.mockResolvedValue(new Set<string>());
  // Défaut : pas de vue PG (équivalent porte fermée SANS l'asymétrie
  // écrit-sans-lire — le writer est aussi OFF dans cet env).
  pgReadSpy.mockReset();
  pgReadSpy.mockResolvedValue(null);
  // #3782 tombstones — défaut : pas d'histoire PG archivée (fail-open).
  archivedIdsSpy.mockReset();
  archivedIdsSpy.mockResolvedValue(null);
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

describe('action merge — #3782 tombstones d’archive (résurrection CoursIA 26/09)', () => {
  // Reproduction du scénario mesuré : la vue source (fichier fork périmé OU
  // journal fork jamais condensé) porte des messages que la cible a déjà
  // CONDENSÉS (rows archived_at posés). Sans filtre, l'union les réimporte
  // vivants (84 messages, dashboard à 332 %). Avec tombstones : exclus, et
  // rapportés dans le message du résultat.
  const t1 = { id: 't1', timestamp: '2026-09-26T08:00:00.000Z', content: 't1 — déjà archivé sur la cible (résurrection bloquée)' };
  const t2 = { id: 't2', timestamp: '2026-09-26T09:00:00.000Z', content: 't2 — déjà archivé sur la cible (résurrection bloquée)' };
  const live1 = { id: 'live1', timestamp: '2026-09-26T10:00:00.000Z', content: 'live1 — message vivant du fork' };
  const live2 = { id: 'live2', timestamp: '2026-09-26T11:00:00.000Z', content: 'live2 — message vivant de la cible' };

  function seedForkPair(): void {
    // Cible : 1 message vivant.
    seedDashboard('workspace-tomb.md', 'workspace', '2026-09-26T11:00:00.000Z', [live2]);
    // Source fork : porte les 2 archivés + 1 vivant (vue périmée).
    seedDashboard('workspace-tomb (1).md', 'workspace', '2026-09-26T10:00:00.000Z', [t1, t2, live1]);
  }

  it('exclut de l’union les ids déjà archivés sur la cible et le rapporte', async () => {
    seedForkPair();
    // Le journal PG de la CIBLE connaît t1/t2 comme archivés.
    archivedIdsSpy.mockResolvedValue(new Set(['t1', 't2']));

    const result = await roosyncDashboard({
      action: 'merge', type: 'workspace', workspace: 'tomb',
      sourceKey: 'workspace-tomb (1)'
    }) as any;

    expect(result.success).toBe(true);
    // live1 + live2 seulement — t1/t2 exclus.
    expect(result.messageCount).toBe(2);
    expect(String(result.message)).toContain('2 message(s) déjà archivé(s)');
    expect(String(result.message)).toContain('tombstones #3782');
    // L'union persistée ne porte PAS les exclus.
    const synced = pgSyncCheckedSpy.mock.calls[0][0];
    expect(synced.intercom.messages.map((m: { id: string }) => m.id).sort()).toEqual(['live1', 'live2']);
    // Le fichier cible non plus.
    expect(fileText('workspace-tomb.md')).not.toContain('résurrection bloquée');
    expect(fileText('workspace-tomb.md')).toContain('live1');
    // La requête tombstone a bien porté la clé CIBLE.
    expect(archivedIdsSpy).toHaveBeenCalledWith('workspace-tomb');
    // Union vérifiée contre l'archive : pas d'avertissement d'indisponibilité.
    expect((result as any).tombstonesUnavailable).toBeUndefined();
  });

  it('fail-open : fetch → null (hôte sans histoire PG) laisse l’union inchangée + AVERTIT (WARNING NanoClaw #1242)', async () => {
    seedForkPair();
    archivedIdsSpy.mockResolvedValue(null);

    const result = await roosyncDashboard({
      action: 'merge', type: 'workspace', workspace: 'tomb',
      sourceKey: 'workspace-tomb (1)'
    }) as any;

    expect(result.success).toBe(true);
    // 4 messages : la cible + tout le fork, résurrection incluse (comportement d'avant).
    expect(result.messageCount).toBe(4);
    expect(String(result.message)).not.toContain('tombstones #3782');
    // Sens sûr : l'exposition est STRUCTURÉE et nommée — t1/t2/live1 viennent
    // des vues sources et n'ont pas pu être vérifiés contre les archives.
    expect(result.tombstonesUnavailable).toBe(true);
    expect(String(result.message)).toContain('Tombstones d\'archive INDISPONIBLES');
    expect(String(result.message)).toContain('3 message(s) repris');
    expect(String(result.message)).toContain('risque de résurrection');
  });

  it('null + source strictement incluse dans la cible : pas d\'avertissement (aucune exposition)', async () => {
    // La source n'amène RIEN que la cible ne connaisse déjà → rien à vérifier.
    seedDashboard('workspace-tomb.md', 'workspace', '2026-09-26T11:00:00.000Z', [t1, t2, live1, live2]);
    seedDashboard('workspace-tomb (1).md', 'workspace', '2026-09-26T10:00:00.000Z', [t1, live1]);
    archivedIdsSpy.mockResolvedValue(null);

    const result = await roosyncDashboard({
      action: 'merge', type: 'workspace', workspace: 'tomb',
      sourceKey: 'workspace-tomb (1)'
    }) as any;

    expect(result.success).toBe(true);
    expect(result.tombstonesUnavailable).toBeUndefined();
    expect(String(result.message)).not.toContain('INDISPONIBLES');
  });

  it('set vide (aucun archivé) : union inchangée, pas de mention, union VÉRIFIÉE (pas d\'avertissement)', async () => {
    seedForkPair();
    archivedIdsSpy.mockResolvedValue(new Set<string>());

    const result = await roosyncDashboard({
      action: 'merge', type: 'workspace', workspace: 'tomb',
      sourceKey: 'workspace-tomb (1)'
    }) as any;

    expect(result.success).toBe(true);
    expect(result.messageCount).toBe(4);
    expect(String(result.message)).not.toContain('tombstones #3782');
    // L'histoire était disponible (vide) : l'union a été vérifiée — pas de warning.
    expect(result.tombstonesUnavailable).toBeUndefined();
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
    // …et de la moitié journal par la MARQUE #3782 (le geste fichier seul ne
    // l'aurait JAMAIS fait) — jamais par le DELETE cascade, qui détruirait les
    // lignes (gel des purges).
    expect(retireCheckedSpy).toHaveBeenCalledWith('machine-myia-po-2025 (1)', 'machine-myia-po-2025', expect.any(String));
    expect(pgDeleteCheckedSpy).not.toHaveBeenCalled();
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

    // Source retirée des deux artefacts — fichier par renommage, journal par
    // la marque #3782 (jamais le DELETE cascade).
    expect(fileExists('machine-myia-po-2025 (1).md')).toBe(false);
    expect(retireCheckedSpy).toHaveBeenCalledWith('machine-myia-po-2025 (1)', 'machine-myia-po-2025', expect.any(String));
    expect(pgDeleteCheckedSpy).not.toHaveBeenCalled();
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

  it('deleteSource=false : le fichier survit, aucun delete PG, mais le journal est RETIRÉ par la marque #3782', async () => {
    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)', deleteSource: false
    }) as any;

    expect(result.success).toBe(true);
    expect(String(result.message)).toContain('Source préservée');
    // deleteSource gouverne le FICHIER : la source survit sur disque…
    expect(fileExists('machine-myia-po-2025 (1).md')).toBe(true);
    // …mais le journal retire la source dans les DEUX cas (arbitrage #3782) —
    // marque, jamais delete (les lignes restent en base, gel des purges).
    expect(retireCheckedSpy).toHaveBeenCalledWith('machine-myia-po-2025 (1)', 'machine-myia-po-2025', expect.any(String));
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
    // #4131: la porte de lecture est fermée par le kill-switch explicite
    // '0' — son ABSENCE ne la ferme plus (le défaut suit la présence d'une
    // URL PG, donc le siège serait PG-lecteur).
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://test:test@localhost:5432/test';
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '0';
    seedDashboard('machine-myia-po-2025 (1).md', 'machine', '2026-09-08T12:48:00.000Z', [M.m3]);

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(false);
    expect(String(result.message)).toContain('union aveugle');
    // #3537 revue : le refus ne doit pas désigner un hôte nommément. La chaîne
    // « ex. myia-ai-01 » était littérale — affichée à l'identique à tout appelant,
    // y compris à ai-01 lui-même refusé sur sa propre machine — et lue comme une
    // affirmation sur ai-01 par plusieurs sièges.
    expect(String(result.message)).not.toMatch(/myia-ai-01|myia-po-|myia-web1/);
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
    expect(retireCheckedSpy).toHaveBeenCalledWith('machine-myia-po-2025 (1)', 'machine-myia-po-2025', expect.any(String));
    expect(pgDeleteCheckedSpy).not.toHaveBeenCalled();
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

  it("échec de la MARQUE de retraite (union persistée) → retrait partiel RAPPORTÉ honnêtement, archive conservée", async () => {
    retireCheckedSpy.mockResolvedValue({ ok: false, reason: 'breaker-skip', detail: 'circuit breaker OPEN' });

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
    // #3782 locks-off-Drive : verrou fichier en tmpdir dédié (hashé), pas
    // dans dashboards/ du store.
    process.env.APPEND_LOCK_ACQUIRE_BUDGET_MS = '60';
    process.env.ROOSYNC_LOCK_DIR = path.join(testDir, 'locks');
    mkdirSync(process.env.ROOSYNC_LOCK_DIR, { recursive: true });
    writeFileSync(
      getAppendLockPath('machine-myia-po-2025'),
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
    expect(retireCheckedSpy).toHaveBeenCalledWith('workspace-CoursIA (1)', 'workspace-CoursIA', expect.any(String));
    expect(pgDeleteCheckedSpy).not.toHaveBeenCalled();
  });
});

// #3782 §3 — le statut ne doit pas régresser : un fork VIVANT (donc de
// `lastModified` plus récent, bumpé par ses appends) portait une copie FIGÉE du
// statut et l'emportait. Mesure du 23/09 sur `workspace-CoursIA (1)` :
// 11 964 caractères de statut dans le fork contre 14 993 sur la canonique — la
// fusion aurait rendu le statut 3 Ko plus court que la clé qu'elle remplace.
describe('action merge — le fork appendé ne peut pas imposer son statut périmé (#3782 §3)', () => {
  it("statut retenu sur l'horodatage de condensation, pas sur lastModified", async () => {
    // Cible : fichier plus ancien (05/09) mais statut condensé le PLUS RÉCEMMENT.
    seedDashboard('machine-myia-po-2025.md', 'machine', '2026-09-05T17:02:00.000Z',
      [M.m1old, M.m2],
      { totalMessages: '9', lastCondensedAt: '2026-09-08T12:00:00.000Z' });
    // Fork : fichier plus récent (appends) mais statut gelé AVANT cette
    // condensation — sous l'ancien critère (`lastModified`), il l'emportait.
    seedDashboard('machine-myia-po-2025 (1).md', 'machine', '2026-09-08T12:48:00.000Z',
      [M.m1new, M.m3],
      { totalMessages: '10', lastCondensedAt: '2026-09-07T10:00:00.000Z' });

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(true);
    expect(String(result.message)).toContain('Statut retenu : cible');
    expect(String(result.message)).toContain("arbitré par l'horodatage de condensation");
    const merged = fileText('machine-myia-po-2025.md');
    expect(merged).toContain('Statut de machine-myia-po-2025.md');
    expect(merged).not.toContain('Statut de machine-myia-po-2025 (1).md');
    // L'union des journaux, elle, reste inchangée : rien n'est perdu côté messages.
    expect(merged).toContain('m3 — fork seul');
    expect(merged).toContain('m2 — cible seule');
  });

  it('aucune vue horodatée → repli inchangé sur lastModified (critère rapporté)', async () => {
    seedDashboard('machine-myia-po-2025.md', 'machine', '2026-09-05T17:02:00.000Z', [M.m2]);
    seedDashboard('machine-myia-po-2025 (1).md', 'machine', '2026-09-08T12:48:00.000Z', [M.m3]);

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(true);
    expect(String(result.message)).toContain('Statut retenu : source');
    expect(String(result.message)).toContain('arbitré par lastModified');
  });

  // Limite NOMMÉE, pas un comportement souhaité : `write`/`update` écrivent le
  // statut sans poser d'horodatage, donc deux vues dont le statut a été
  // réécrit hors condensation partagent le même `lastCondensedAt` alors que
  // leur contenu diverge — l'ordre reste indécidable et le critère retombe sur
  // `lastModified`. Ce test fixe l'état actuel pour qu'il soit visible ; le
  // remède serait un horodatage de statut posé par `write`/`update` aussi.
  it('horodatages ÉGAUX + statuts divergents → indécidable, repli lastModified (limite nommée)', async () => {
    seedDashboard('machine-myia-po-2025.md', 'machine', '2026-09-05T17:02:00.000Z', [M.m2],
      { lastCondensedAt: '2026-09-07T10:00:00.000Z' });
    seedDashboard('machine-myia-po-2025 (1).md', 'machine', '2026-09-08T12:48:00.000Z', [M.m3],
      { lastCondensedAt: '2026-09-07T10:00:00.000Z' });

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(true);
    expect(String(result.message)).toContain('Statut retenu : source');
    expect(String(result.message)).toContain('arbitré par lastModified');
  });
});

// Suivi #1219 (review ai-01) : le choix du statut se fait PAR PAIRE, mais le
// rapport le reconstituait GLOBALEMENT. Avec des vues mixtes — certaines
// horodatées, d'autres non — l'ancien `statusBasis` global annonçait
// `lastModified` dès qu'UNE vue manquait d'horodatage, alors que la paire
// décisive avait pu être tranchée par l'horodatage. Le rapport doit dire ce
// qui a réellement ordonné la dernière paire évaluée.
describe('action merge — critère de statut rapporté par paire (suivi #1219)', () => {
  it('vues mixtes : paire finale arbitrée par horodatage alors que toutes les vues ne sont pas horodatées', async () => {
    // Cible, vue FICHIER : PAS d'horodatage de condensation (jamais condensée),
    // et copie PLUS ANCIENNE que la vue PG (fichier en retard sur PG) — elle ne
    // doit jamais déloger l'incumbent horodaté avant la paire décisive.
    seedDashboard('machine-myia-po-2025.md', 'machine', '2026-09-08T09:00:00.000Z',
      [{ id: 'f2', timestamp: '2026-09-08T09:00:00.000Z', content: 'f2 — fichier cible' }]);
    // Cible, vue PG : horodatage de condensation LE PLUS RÉCENT (12:00) — c'est
    // elle qui doit détenir le statut.
    const targetPgView = {
      type: 'machine' as const,
      key: 'machine-myia-po-2025',
      lastModified: '2026-09-08T10:00:00.000Z',
      lastModifiedBy: { machineId: 'pg', workspace: 'pg' },
      status: { markdown: '*Statut PG cible (détenteur attendu).*' },
      intercom: {
        messages: [{
          id: 'p1', timestamp: '2026-09-08T10:00:00.000Z',
          author: { machineId: 'pg', workspace: 'pg' },
          content: 'p1 — PG seul (cible)'
        }],
        totalMessages: 1,
        lastCondensedAt: '2026-09-08T12:00:00.000Z'
      }
    };
    // Source (fork) : fichier le plus récent (12:48 — l'emporterait sous un
    // critère lastModified pur) mais horodatage de condensation PLUS ANCIEN.
    seedDashboard('machine-myia-po-2025 (1).md', 'machine', '2026-09-08T12:48:00.000Z',
      [{ id: 'f1', timestamp: '2026-09-08T12:48:00.000Z', content: 'f1 — fichier source' }],
      { lastCondensedAt: '2026-09-07T10:00:00.000Z' });
    pgReadSpy.mockImplementation(async (k: string) =>
      k === 'machine-myia-po-2025' ? targetPgView : null);

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(true);
    // Le statut vient bien de la vue PG (cible) — l'union des journaux reste
    // par id, les messages fichier cible/fichier source/PG seul survivent.
    expect(String(result.message)).toContain('Statut retenu : cible');
    // LE point du suivi #1219 : la paire finale (source horodatée vs cible PG
    // horodatée) a été tranchée par l'horodatage — l'ancien statusBasis global
    // aurait annoncé `lastModified` (la vue fichier cible n'a pas d'horodatage).
    expect(String(result.message)).toContain("arbitré par l'horodatage de condensation");
    const merged = fileText('machine-myia-po-2025.md');
    expect(merged).toContain('Statut PG cible (détenteur attendu)');
    expect(merged).not.toContain('Statut de machine-myia-po-2025 (1).md');
    expect(merged).toContain('f1 — fichier source');
    expect(merged).toContain('f2 — fichier cible');
    expect(merged).toContain('p1 — PG seul (cible)');
  });

  it('vue unique (RENAME pur) → rapport « aucune concurrence »', async () => {
    seedDashboard('machine-myia-po-2025 (1).md', 'machine', '2026-09-08T12:48:00.000Z', [M.m3]);

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(true);
    expect(String(result.message)).toContain('RENAME — cible créée depuis la source');
    expect(String(result.message)).toContain('aucune concurrence — vue unique');
  });
});

// #4439 Attendé 2 (5e récidive de la famille fork, mesuré web1 30/10) — la
// preuve d'un merge réparateur est la RELECTURE du canonique, pas la réponse
// de l'appel. Aucune garde existante ne relisait le canonique comme un TOUT :
// verifyDashboardWriteLanded cherche un seul id d'atterrissage (verdict nominal
// vacant pour un writer qui réécrit un dashboard existant, cf. #3774),
// verifyWriteVisibleInStore relit le store PG. Ces tests injectent la déviation
// DriveFS mesurée AU NIVEAU DU copyFile : la moitié fichier de
// writeDashboardFile est writeFile(staging) + copyFile(staging → canonique)
// (#3782 copy-in-place) — un copyFile DriveFS peut matérialiser l'écriture en
// copie de conflit ` (N)` et laisser le canonique absent, ou « réussir » en
// conservant l'ancien contenu. La vue PG reste mockée (pgReadSpy → null :
// porte fermée), donc la garde ne témoigne que par le fichier — exactement le
// siège web1 du constat.
describe('action merge — garde canonique post-union (#4439 Attendé 2)', () => {
  /** Spy copyFile : détourne l'écriture du canonique vers un fork ` (9)` (canonique jamais créé). */
  async function spyCopyFileDeviatedToFork(canonicalName: string): Promise<ReturnType<typeof vi.spyOn>> {
    const { copyFile: realCopyFile } = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    const fsMocked = await import('fs/promises');
    return vi.spyOn(fsMocked, 'copyFile').mockImplementation(((src: unknown, dest: unknown) => {
      const destStr = String(dest);
      if (path.basename(destStr) === canonicalName) {
        // DriveFS matérialise l'écriture en copie de conflit : le canonique
        // n'est jamais créé, le contenu atterrit sur le sibling.
        return realCopyFile(src as string, path.join(path.dirname(destStr), canonicalName.replace(/\.md$/, ' (9).md')));
      }
      return realCopyFile(src as string, destStr);
    }) as typeof realCopyFile);
  }

  /** Spy copyFile : l'écriture « réussit » mais le canonique garde son ANCIEN contenu (conflit résolu côté Drive par la version cloud périmée). */
  async function spyCopyFileKeepsStale(canonicalName: string, staleBody: string): Promise<ReturnType<typeof vi.spyOn>> {
    const { copyFile: realCopyFile, writeFile: realWriteFile } = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    const fsMocked = await import('fs/promises');
    return vi.spyOn(fsMocked, 'copyFile').mockImplementation(((src: unknown, dest: unknown) => {
      const destStr = String(dest);
      if (path.basename(destStr) === canonicalName) {
        return realWriteFile(destStr, staleBody, 'utf8');
      }
      return realCopyFile(src as string, destStr);
    }) as typeof realCopyFile);
  }

  it('canonique ABSENT des deux vues après une écriture déviée → ÉCHEC, source INTACTE, aucun retrait', async () => {
    // Fork seul (canonique absent avant le merge — cas RENAME pur du 30/10).
    seedDashboard('machine-myia-po-2025 (1).md', 'machine', '2026-09-08T12:48:00.000Z', [M.m3]);
    const spy = await spyCopyFileDeviatedToFork('machine-myia-po-2025.md');

    try {
      const result = await roosyncDashboard({
        action: 'merge', type: 'machine', machineId: 'myia-po-2025',
        sourceKey: 'machine-myia-po-2025 (1)'
      }) as any;

      expect(result.success).toBe(false);
      expect(String(result.message)).toContain('ABSENT');
      expect(String(result.message)).toContain('#4439');
      expect(result.canonicalGuard?.ok).toBe(false);
      expect(result.canonicalGuard?.reason).toBe('canonical-absent');
      expect(result.canonicalGuard?.missingIds).toEqual(['m3']);
      // La déviation est réelle : le contenu a atterri sur le sibling, le
      // canonique n'existe pas.
      expect(fileExists('machine-myia-po-2025.md')).toBe(false);
      expect(fileExists('machine-myia-po-2025 (9).md')).toBe(true);
      // Source INTACTE : ni retrait fichier, ni marque #3782, ni delete PG.
      expect(fileExists('machine-myia-po-2025 (1).md')).toBe(true);
      expect(retireCheckedSpy).not.toHaveBeenCalled();
      expect(pgDeleteCheckedSpy).not.toHaveBeenCalled();
      expect(dualWriteDeleteSpy).not.toHaveBeenCalled();
      // L'union a bien été ÉCRITE (le write est passé) : c'est la relecture
      // qui échoue, pas l'écriture — le rapport le distingue.
      expect(dualWriteSyncSpy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('canonique présent mais SANS les messages de l’union → ÉCHEC (le remède n’a pas tenu)', async () => {
    // Cible vivante + fork divergent : union = m1 + m2 + m3.
    seedDashboard('machine-myia-po-2025.md', 'machine', '2026-09-05T17:02:00.000Z', [M.m1old, M.m2]);
    seedDashboard('machine-myia-po-2025 (1).md', 'machine', '2026-09-08T12:48:00.000Z', [M.m1new, M.m3]);
    const staleBody = fileText('machine-myia-po-2025.md');
    const spy = await spyCopyFileKeepsStale('machine-myia-po-2025.md', staleBody);

    try {
      const result = await roosyncDashboard({
        action: 'merge', type: 'machine', machineId: 'myia-po-2025',
        sourceKey: 'machine-myia-po-2025 (1)'
      }) as any;

      expect(result.success).toBe(false);
      expect(result.canonicalGuard?.ok).toBe(false);
      expect(result.canonicalGuard?.reason).toBe('union-incomplete');
      // Le canonique relu porte m1+m2 (stale) ; seul m3 (fork seul) manque.
      expect(result.canonicalGuard?.missingIds).toEqual(['m3']);
      expect(String(result.message)).toContain('m3');
      // Source INTACTE : aucune marque, aucun delete.
      expect(fileExists('machine-myia-po-2025 (1).md')).toBe(true);
      expect(retireCheckedSpy).not.toHaveBeenCalled();
      expect(pgDeleteCheckedSpy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('condensation détachée entre écriture et relecture : un message de l’union fraîchement ARCHIVÉ est pardonné (#4527)', async () => {
    // Même canonique périmé que ci-dessus, MAIS entre l'écriture et la garde
    // une condensation détachée archive m3 : le refetch de tombstones à
    // l'instant de la garde le témoigne — condensé, pas perdu → garde VERTE,
    // le merge termine (source retirée).
    seedDashboard('machine-myia-po-2025.md', 'machine', '2026-09-05T17:02:00.000Z', [M.m1old, M.m2]);
    seedDashboard('machine-myia-po-2025 (1).md', 'machine', '2026-09-08T12:48:00.000Z', [M.m1new, M.m3]);
    const staleBody = fileText('machine-myia-po-2025.md');
    const spy = await spyCopyFileKeepsStale('machine-myia-po-2025.md', staleBody);
    // 1er fetch = filtre d'union (avant écriture : rien d'archivé) ;
    // 2e fetch = garde post-écriture : m3 vient d'être condensé.
    let tombstoneCalls = 0;
    archivedIdsSpy.mockImplementation(async () => {
      tombstoneCalls++;
      return tombstoneCalls <= 1 ? new Set<string>() : new Set(['m3']);
    });

    try {
      const result = await roosyncDashboard({
        action: 'merge', type: 'machine', machineId: 'myia-po-2025',
        sourceKey: 'machine-myia-po-2025 (1)'
      }) as any;

      expect(result.success).toBe(true);
      expect(result.canonicalGuard).toBeUndefined();
      // La garde a bien refetché (2 appels : filtre d'union + garde).
      expect(tombstoneCalls).toBe(2);
      // La garde VERTE ne court-circuite PAS le fail-closed #3774 : avec le
      // canonique périmé injecté, le scan d'id de verifyDashboardWriteLanded
      // trouve m3 dans la SOURCE (forkSuspected sans forkPath) et la
      // suppression de la source reste ABANDONNÉE — la garde pardonne le
      // message condensé, elle ne neutralise pas la garde anti-déviation.
      expect(String(result.message)).toContain('SUPPRESSION DE LA SOURCE ABANDONNÉE');
      expect(fileExists('machine-myia-po-2025 (1).md')).toBe(true);
      expect(retireCheckedSpy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('action merge — clé source portant un caractère de nom illicite (#4439)', () => {
  it("assainit le nom d'archive pré-merge : la source PG-only est retirée au lieu d'échouer en EINVAL", async () => {
    // Cas réel mesuré le 05/11 (ai-01, c.6665485237) : `workspace:"vllm"}PMC_JSON_DOWN`
    // est une clé née d'une erreur de parse JSON. Elle n'a AUCUN fichier (PG-only),
    // et l'archive pré-merge portait le `"` — `fs.rename`/`open` rendait EINVAL,
    // donc `merge` ne pouvait jamais retirer la clé : le seul outil de réparation
    // des clés fork était aveugle à la population même qui l'exige.
    const BAD_KEY = 'machine-myia-po-2025"}DUP';
    seedDashboard('machine-myia-po-2025.md', 'machine', '2026-09-05T17:02:00.000Z', [M.m2]);
    const pgOnlySource = {
      type: 'machine' as const,
      key: BAD_KEY,
      lastModified: '2026-09-08T12:48:00.000Z',
      lastModifiedBy: { machineId: 'pg', workspace: 'pg' },
      status: { markdown: '*Statut PG de la clé malformée.*' },
      intercom: {
        messages: [{
          id: 'q1', timestamp: '2026-09-08T12:48:00.000Z',
          author: { machineId: 'pg', workspace: 'pg' },
          content: 'q1 — PG seul (clé malformée)'
        }],
        totalMessages: 1
      }
    };
    pgReadSpy.mockImplementation(async (k: string) => (k === BAD_KEY ? pgOnlySource : null));

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: BAD_KEY
    }) as any;

    // Le merge aboutit : le contenu de la source est dans la cible…
    expect(result.success).toBe(true);
    expect(fileText('machine-myia-po-2025.md')).toContain('q1 — PG seul (clé malformée)');
    // …et la source est RETIRÉE (marque #3782) — c'est ce que l'EINVAL empêchait.
    expect(retireCheckedSpy).toHaveBeenCalledWith(BAD_KEY, 'machine-myia-po-2025', expect.any(String));

    // L'archive existe, et son NOM ne porte aucun caractère illicite : le `"`
    // de la clé est remplacé, la clé elle-même reste brute côté journal.
    const archiveDir = path.join(dashboardsDir, 'archive');
    const archives = readdirSync(archiveDir).filter(f => f.includes('-pre-merge-'));
    expect(archives.length).toBe(1);
    expect(archives[0]).not.toMatch(/[<>:"|?*]/);
    expect(archives[0].startsWith('machine-myia-po-2025_}DUP-pre-merge-')).toBe(true);
    expect(readFileSync(path.join(archiveDir, archives[0]), 'utf8')).toContain('q1 — PG seul (clé malformée)');
  });

  it("laisse INTACT un nom de clé légal (parenthèses, espaces internes) — pas de régression sur les forks ` (N)`", async () => {
    seedDashboard('machine-myia-po-2025 (1).md', 'machine', '2026-09-08T12:48:00.000Z', [M.m3]);

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: 'machine-myia-po-2025 (1)'
    }) as any;

    expect(result.success).toBe(true);
    const archiveDir = path.join(dashboardsDir, 'archive');
    const archives = readdirSync(archiveDir).filter(f => f.includes('-pre-merge-'));
    expect(archives.length).toBe(1);
    expect(archives[0].startsWith('machine-myia-po-2025 (1)-pre-merge-')).toBe(true);
  });
});

describe('action merge — collision de noms d’archive pré-merge (#4439, suite ms#1666)', () => {
  const ARCHIVE_NAME = /^machine-myia-po-2025_a-pre-merge-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{12})\.md$/;

  it('deux clés hostiles qui s’assainissent vers le MÊME nom → DEUX archives distinctes (suffixe sha256 de la clé brute)', async () => {
    // `a"b` et `a*b` s’assainissent toutes deux vers `a_b` (ms#1666) : sans
    // suffixe, le second merge ÉCRASE l’archive du premier sans erreur
    // (fs.rename/fs.writeFile), et la preuve de préservation du premier
    // merge disparaît. Le hash porte la clé BRUTE : deux clés distinctes ne
    // peuvent pas produire le même suffixe, même seconde et même nom assaini.
    const KEY_QUOTE = 'machine-myia-po-2025"a';
    const KEY_STAR = 'machine-myia-po-2025*a';
    const pgView = (key: string, id: string, content: string) => ({
      type: 'machine' as const,
      key,
      lastModified: '2026-09-08T12:48:00.000Z',
      lastModifiedBy: { machineId: 'pg', workspace: 'pg' },
      status: { markdown: `*Statut PG de ${content}.*` },
      intercom: {
        messages: [{
          id, timestamp: '2026-09-08T12:48:00.000Z',
          author: { machineId: 'pg', workspace: 'pg' },
          content
        }],
        totalMessages: 1
      }
    });
    seedDashboard('machine-myia-po-2025.md', 'machine', '2026-09-05T17:02:00.000Z', [M.m2]);
    pgReadSpy.mockImplementation(async (k: string) =>
      k === KEY_QUOTE ? pgView(KEY_QUOTE, 'q-quote', 'q-quote — clé au guillemet')
      : k === KEY_STAR ? pgView(KEY_STAR, 'q-star', 'q-star — clé à l’astérisque')
      : null);

    const first = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025', sourceKey: KEY_QUOTE
    }) as any;
    const second = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025', sourceKey: KEY_STAR
    }) as any;
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    const archiveDir = path.join(dashboardsDir, 'archive');
    const archives = readdirSync(archiveDir).filter(f => f.includes('-pre-merge-')).sort();
    // Les DEUX archives existent — l’écrasement silencieux est le défaut visé.
    expect(archives.length).toBe(2);
    // Chaque nom porte le format complet : préfixe assaini commun, suffixe hash 12 hex.
    const hashes = archives.map(f => {
      const m = f.match(ARCHIVE_NAME);
      expect(m).not.toBeNull();
      return m![1];
    });
    // Les suffixes — donc les noms complets — sont DISTINCTS : c’est le hash de
    // la clé brute qui discriminate, pas la seconde (les deux merges ci-dessus
    // peuvent tomber dans la même seconde comme dans deux secondes voisines).
    expect(hashes[0]).not.toBe(hashes[1]);
    // Chaque archive conserve SON contenu : la preuve de préservation des deux merges.
    expect(readFileSync(path.join(archiveDir, archives[0]), 'utf8')).toContain('clé au guillemet');
    expect(readFileSync(path.join(archiveDir, archives[1]), 'utf8')).toContain('clé à l’astérisque');
  });

  it('frontmatter d’archive : sourceKey échappé — une clé au retour ligne ne peut pas injecter de lignes YAML', async () => {
    // La garde ne refuse que `\/:`, `..` : un contrôle (retour ligne) passe.
    // Interpolé brut, il découperait la valeur en lignes arbitraires du
    // frontmatter (falsification des métadonnées d’archive). JSON.stringify
    // rend un scalaire double-quoté, round-trip identique sous yaml.load.
    const KEY_LF = 'machine-myia-po-2025_x\nEVIL_FRONTMATTER_LINE';
    seedDashboard('machine-myia-po-2025.md', 'machine', '2026-09-05T17:02:00.000Z', [M.m2]);
    pgReadSpy.mockImplementation(async (k: string) => (k === KEY_LF ? {
      type: 'machine' as const,
      key: KEY_LF,
      lastModified: '2026-09-08T12:48:00.000Z',
      lastModifiedBy: { machineId: 'pg', workspace: 'pg' },
      status: { markdown: '*Statut PG de la clé au retour ligne.*' },
      intercom: {
        messages: [{
          id: 'q-lf', timestamp: '2026-09-08T12:48:00.000Z',
          author: { machineId: 'pg', workspace: 'pg' },
          content: 'q-lf — PG seul (clé au retour ligne)'
        }],
        totalMessages: 1
      }
    } : null));

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025', sourceKey: KEY_LF
    }) as any;
    expect(result.success).toBe(true);

    const archiveDir = path.join(dashboardsDir, 'archive');
    const archives = readdirSync(archiveDir).filter(f => f.includes('-pre-merge-'));
    expect(archives.length).toBe(1);
    const archText = readFileSync(path.join(archiveDir, archives[0]), 'utf8');
    // Forme échappée, UNE ligne : `sourceKey: "…_x\nEVIL_FRONTMATTER_LINE"` avec
    // backslash-n littéral (pas de saut de ligne réel dans le fichier).
    expect(archText).toContain('sourceKey: "machine-myia-po-2025_x\\nEVIL_FRONTMATTER_LINE"');
    // L’ancienne interpolation brute aurait posé `EVIL_FRONTMATTER_LINE` comme
    // ligne PROPRE du frontmatter — jamais sous forme échappée.
    expect(archText).not.toMatch(/^EVIL_FRONTMATTER_LINE$/m);
  });
});
