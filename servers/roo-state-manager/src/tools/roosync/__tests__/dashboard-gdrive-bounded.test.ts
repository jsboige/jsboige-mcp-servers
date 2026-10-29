/**
 * #4131 G-B lot 1 — « GDrive borné, PG inconditionnel ».
 *
 * Incident 07/10 : DriveFS hangé → 86 s/write, sondes 300 Ko sans retour en
 * 120 s — et l'opération entière partait avec la moitié GDrive alors que la
 * moitié PG allait bien (demande 3 de l'arbitrage user 08/10 : échec
 * asymétrique acceptable plutôt que hang symétrique).
 *
 * Ce fichier épingle les trois comportements du lot 1 :
 *  1. un copyFile staging→store qui ne rend jamais la main ne pend PLUS l'append — la
 *     moitié GDrive est bornée, le message est publié sur le miroir PG seul,
 *     et la réponse porte la dégradation ;
 *  2. un échec fs rapide (store injoignable) avec PG vivant → même contrat ;
 *  3. un échec GDrive SANS miroir PG reste un échec total — l'opération ne
 *     peut pas « réussir » sans avoir atterri nulle part ;
 *  4. B2 : G: absent + READ_PG=1 → l'append ne refuse plus d'entrée
 *     (PG-seul dégradé), et G: absent SANS READ_PG garde le refus #3459.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { Dashboard } from '../dashboard-schemas.js';

// Le vrai writeFile — récupéré via importActual, JAMAIS via l'import du module
// mocké (qui résoudrait vers le mock et récursionnerait à l'infini).
let fsWriteFileReal: typeof import('fs/promises')['writeFile'];
let fsCopyFileReal: typeof import('fs/promises')['copyFile'];

const {
  mockReadDashboardFromPg,
  mockProbeHydration,
  mockDualWriteSync,
  mockDualWriteSyncChecked,
  mockDualWriteDelete,
  mockWriteFile,
  mockCopyFile,
  mockIsDashboardPgPrimary,
  mockReadDashboardFromPgUngated,
} = vi.hoisted(() => ({
  mockReadDashboardFromPg: vi.fn().mockResolvedValue(null),
  mockProbeHydration: vi.fn().mockResolvedValue({ kind: 'empty' }),
  mockDualWriteSync: vi.fn().mockResolvedValue(undefined),
  mockDualWriteSyncChecked: vi.fn().mockResolvedValue({ ok: true, reason: 'written' }),
  mockDualWriteDelete: vi.fn().mockResolvedValue(undefined),
  mockWriteFile: vi.fn(),
  mockCopyFile: vi.fn(),
  // #4131 G-B lot 2 — la porte write-primary, off par défaut (les tests du
  // lot 1 épingle le chemin GDrive-first ; le lot 2 a son propre fichier).
  mockIsDashboardPgPrimary: vi.fn().mockReturnValue(false),
  mockReadDashboardFromPgUngated: vi.fn().mockResolvedValue(null),
}));

// La moitié GDrive passe par fs/promises — le mock ne remplace QUE writeFile
// (tout le reste — mkdtemp, readFile, unlink… — reste réel).
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, writeFile: mockWriteFile, copyFile: mockCopyFile };
});

vi.mock('@/services/unified-store/roosync-dashboard-store', () => ({
  readDashboardFromPg: mockReadDashboardFromPg,
  probeDashboardJournalForHydration: mockProbeHydration,
  dualWriteDashboardSync: mockDualWriteSync,
  dualWriteDashboardSyncChecked: mockDualWriteSyncChecked,
  dualWriteDashboardDelete: mockDualWriteDelete,
  getDashboardPgReader: vi.fn().mockReturnValue(null),
  getDashboardRetirement: vi.fn().mockResolvedValue(null),
  listRetiredDashboardKeys: vi.fn().mockResolvedValue(new Set<string>()),
  retireDashboardKeyChecked: vi.fn().mockResolvedValue({ ok: true, reason: 'written' }),
  // #3782 : couche PG 'unavailable' (hôte sans PG) → fallback fichier local.
  acquireDashboardSharedLock: vi.fn().mockResolvedValue('unavailable'),
  releaseDashboardSharedLock: vi.fn().mockResolvedValue(undefined),
  readDashboardSharedLock: vi.fn().mockResolvedValue(null),
  fetchArchivedDashboardMessageIds: vi.fn().mockResolvedValue(null),
  // #4131 G-B lot 2 — exports consommés par dashboard.ts.
  isDashboardPgPrimary: mockIsDashboardPgPrimary,
  readDashboardFromPgUngated: mockReadDashboardFromPgUngated,
}));

import { roosyncDashboard } from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-gdrive-bounded-');
const sourcePath = path.join(__dirname, '..', 'dashboard.ts');

function pgDashboard(key: string): Dashboard {
  const messages = [
    {
      id: 'pg-existing-1',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      author: { machineId: 'other-machine', workspace: 'other-workspace' },
      content: 'message déjà publié sur le miroir PG',
    },
  ];
  return {
    type: 'workspace',
    key,
    lastModified: new Date().toISOString(),
    lastModifiedBy: { machineId: 'other-machine', workspace: 'other-workspace' },
    status: { markdown: 'status pg' },
    intercom: { messages, totalMessages: messages.length },
  };
}

describe('GDrive borné, PG inconditionnel (#4131 G-B lot 1)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    fsWriteFileReal = actual.writeFile;
    fsCopyFileReal = actual.copyFile;
    // writeFile/copyFile réels par défaut : chaque test qui veut faire
    // échouer/pendre la moitié GDrive le reprogramme explicitement.
    mockWriteFile.mockImplementation(((file: unknown, data: unknown, opts: unknown) =>
      fsWriteFileReal(file as string, data as string, opts as undefined)) as typeof fsWriteFileReal);
    mockCopyFile.mockImplementation(((src: unknown, dest: unknown) =>
      fsCopyFileReal(src as string, dest as string)) as typeof fsCopyFileReal);
    mockReadDashboardFromPg.mockReset().mockResolvedValue(null);
    mockProbeHydration.mockReset().mockResolvedValue({ kind: 'empty' });
    mockDualWriteSync.mockClear().mockResolvedValue(undefined);
    mockDualWriteSyncChecked.mockClear().mockResolvedValue({ ok: true, reason: 'written' });
    mockIsDashboardPgPrimary.mockReset().mockReturnValue(false);
    mockReadDashboardFromPgUngated.mockReset().mockResolvedValue(null);

    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    process.env.UNIFIED_STORE_DASHBOARD_GDRIVE_WRITE_TIMEOUT_MS = '80';
    delete process.env.UNIFIED_STORE_DASHBOARD_READ_PG;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
    delete process.env.UNIFIED_STORE_DASHBOARD_GDRIVE_WRITE_TIMEOUT_MS;
    delete process.env.UNIFIED_STORE_DASHBOARD_READ_PG;
    delete process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY;
  });

  it('un copyFile staging→store qui ne rend jamais la main : append borné, publié sur PG seul, dégradation visible', async () => {
    // DriveFS hangé sur la COPIE vers le store (staging hors-arbre → dashboards/)
    // — le staging vit maintenant dans le tmpdir local, seul le copyFile vers
    // le store peut pendre. Le reste (verrou append en tmpdir, heartbeats…)
    // écrit normalement, sinon le mock pend l'acquisition du verrou elle-même
    // et le test mesure autre chose.
    mockCopyFile.mockImplementation(((src: unknown, dest: unknown) => {
      if (String(dest).includes('dashboards')) {
        return new Promise(() => { /* DriveFS hangé */ });
      }
      return fsCopyFileReal(src as string, dest as string);
    }) as typeof fsCopyFileReal);

    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'message sous DriveFS hangé',
      tags: ['INFO'],
    });

    expect(result.success).toBe(true);
    expect(result.writeVerification?.gdriveDegraded).toBeTruthy();
    expect(result.message).toContain('GDRIVE DÉGRADÉ');
    // La moitié PG a PRIS l'écriture — c'est elle qui fait le succès.
    expect(mockDualWriteSyncChecked).toHaveBeenCalledTimes(1);
    // La variante void (chemin nominal) n'a pas cours sur le chemin dégradé.
    expect(mockDualWriteSync).not.toHaveBeenCalled();
  });

  it('échec fs rapide (racine du store non réplicable) + PG vivant : succès dégradé, miroir écrit', async () => {
    // La racine du store est un FICHIER : existsSync passe, mais ni mkdir du
    // sous-répertoire ni copyFile vers le store ne peuvent réussir — échec GDrive immédiat.
    // La lecture est armée côté PG (même patron que le test B2 ci-dessous) :
    // sous cette racine-fichier, le READ GDrive rend ENOTDIR sous Linux
    // (rethrow après retries → l'append meurt AVANT la moitié écriture, cf. CI
    // 38486520162) mais ENOENT sous Windows (dashboard absent → le flux
    // continue) — armer PG rend le test plateforme-neutre : la lecture vient
    // du miroir, le flux atteint la moitié écriture, où l'échec de la
    // racine-fichier est identique partout. Le chemin de lecture reste le lot 2.
    const fileAsStore = path.join(tmpDir, 'faux-store');
    await fsWriteFileReal(fileAsStore, 'not a directory', 'utf8');
    process.env.ROOSYNC_SHARED_PATH = fileAsStore;
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
    mockReadDashboardFromPg.mockImplementation(async (key: string) => pgDashboard(key as string));

    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'message alors que G: est un fichier',
      tags: ['INFO'],
    });

    // Garde anti-régression plateforme : la lecture DOIT venir du miroir —
    // si le READ_PG disparaît, le test redevient ENOTDIR/ENOENT-dépendant
    // sans que Windows le voie localement.
    expect(mockReadDashboardFromPg).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.writeVerification?.gdriveDegraded).toBeTruthy();
    expect(mockDualWriteSyncChecked).toHaveBeenCalledTimes(1);
  });

  it('échec GDrive + miroir PG indisponible : échec TOTAL, aucune surface ne porte le message', async () => {
    // Lecture armée côté PG pour la même raison plateforme (ENOTDIR Linux vs
    // ENOENT Windows, cf. CI 38486520162) : l'échec testé est celui de la
    // moitié écriture, pas de la lecture.
    const fileAsStore = path.join(tmpDir, 'faux-store-2');
    await fsWriteFileReal(fileAsStore, 'not a directory', 'utf8');
    process.env.ROOSYNC_SHARED_PATH = fileAsStore;
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
    mockReadDashboardFromPg.mockImplementation(async (key: string) => pgDashboard(key as string));
    mockDualWriteSyncChecked.mockResolvedValue({ ok: false, reason: 'disabled' });

    await expect(
      roosyncDashboard({
        action: 'append',
        type: 'workspace',
        content: 'message sans aucune surface',
        tags: ['INFO'],
      })
    ).rejects.toThrow(/aucune surface ne porte le message/);
    // Même garde plateforme que le test précédent (suggestion dogfood #4085).
    expect(mockReadDashboardFromPg).toHaveBeenCalled();
  });

  it('B2 : store G: absent + READ_PG=1 → append PG-seul dégradé, plus de refus d\'entrée', async () => {
    process.env.ROOSYNC_SHARED_PATH = path.join(tmpDir, 'lecteur-absent');
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
    // La lecture vient de PG (porte ouverte) — le dashboard existe côté miroir.
    mockReadDashboardFromPg.mockImplementation(async (key: string) => pgDashboard(key as string));

    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'message alors que G: est démonté',
      tags: ['INFO'],
    });

    expect(result.success).toBe(true);
    expect(result.writeVerification?.gdriveDegraded).toBeTruthy();
    expect(result.message).toContain('GDRIVE DÉGRADÉ');
  });

  it('B2 négatif : store G: absent SANS READ_PG → refus fail-closed #3459 inchangé', async () => {
    process.env.ROOSYNC_SHARED_PATH = path.join(tmpDir, 'lecteur-absent-2');

    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'message sans store ni porte PG',
      tags: ['INFO'],
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('inaccessible');
  });

  it('chemin nominal inchangé : succès sans dégradation, dual-write void (jamais Checked)', async () => {
    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'message nominal',
      tags: ['INFO'],
    });

    expect(result.success).toBe(true);
    expect(result.writeVerification).toBeUndefined();
    expect(mockDualWriteSync).toHaveBeenCalledTimes(1);
    expect(mockDualWriteSyncChecked).not.toHaveBeenCalled();

    // Le message atterrit réellement sur le fichier.
    const filePath = path.join(tmpDir, 'dashboards', `${result.key}.md`);
    const content = await readFile(filePath, 'utf8');
    expect(content).toContain('message nominal');
  });

  it('drift-guard statique : la borne câble les DEUX sites d\'écriture + la lecture incrémentale', async () => {
    const src = await readFile(sourcePath, 'utf8');
    // Signal fs sur les writeFile (helper full-write + incrément append) + les
    // DEUX readFile bornés (lecture incrémentale + lecture initiale, #4131
    // G-B lot 2 : les 3 tentatives de readDashboardFromGdrive sont signalées).
    expect(src.match(/AbortSignal\.timeout\(writeTimeoutMs\)/g)?.length).toBe(4);
    // La course borde les DEUX moitiés GDrive de writeDashboardFile (miroir
    // PG-primary + chemin nominal), la moitié incrémentale de l'append, et la
    // boucle de lecture initiale (lot 2).
    expect(src.match(/withWriteDeadline\(/g)?.length).toBe(4);
    // Le kill du verrou d'append est bien de courte durée : la borne existe.
    expect(src).toContain('UNIFIED_STORE_DASHBOARD_GDRIVE_WRITE_TIMEOUT_MS');
    // #4131 G-B lot 2 — la porte PG-premier est câblée sur les deux writers,
    // la vérification store et l'ancre de condensation ; #4286 ajoute le 5e
    // site — `isDashboardFileMirrorDeferrable`, qui décide si la moitié fichier
    // peut quitter le chemin critique. Un site de plus sans mise à jour de la
    // borne se verrait ici.
    expect(src.match(/isDashboardPgPrimary\(\)/g)?.length).toBe(5);
  });
});
