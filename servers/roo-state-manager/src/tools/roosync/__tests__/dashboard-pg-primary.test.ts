/**
 * #4131 G-B lot 2 — « PG d'abord, GDrive miroir borné ».
 *
 * Lot 1 avait borné la moitié GDrive et rendu le miroir PG inconditionnel ;
 * le lot 2 inverse l'ordre sous `UNIFIED_STORE_DASHBOARD_PG_PRIMARY=1` : le
 * store PG est écrit PREMIER (checked, sous le verrou append pour l'incrément)
 * et le fichier GDrive devient un miroir best-effort dont l'échec dégrade au
 * lieu d'échouer. Échec PG → repli intégral sur le chemin GDrive-first du
 * lot 1 (contrat d'échec inversé du canal, roosync-channel-write.ts).
 *
 * Ce fichier épingle :
 *  1. la gate elle-même (Null-writer guard : DUAL_WRITE + PG_URL exigés) ;
 *  2. append nominal PG-premier : checked AVANT le fichier, miroir écrit,
 *     pas de dual-write void, verdict store complet ;
 *  3. PG ok + GDrive hang → succès dégradé (gdriveDegraded), message publié ;
 *  4. PG en échec → repli GDrive-first complet (fichier + dual-write void) ;
 *  5. PG en échec + GDrive en échec → échec total « aucune surface » ;
 *  6. full-write miroir (fichier absent) : pas de SECOND checked PG —
 *     pgPrimaryPreWritten neutralise le re-write idempotent et le throw
 *     mensonger ;
 *  7. la lecture initiale hangée ne pend plus l'append : la course borne la
 *     boucle 3-tentatives de readDashboardFromGdrive (drapeau review NanoClaw).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

// Le vrai writeFile — récupéré via importActual, JAMAIS via l'import du module
// mocké (qui résoudrait vers le mock et récursionnerait à l'infini).
let fsWriteFileReal: typeof import('fs/promises')['writeFile'];

const {
  mockReadDashboardFromPg,
  mockReadDashboardFromPgUngated,
  mockProbeHydration,
  mockDualWriteSync,
  mockDualWriteSyncChecked,
  mockWriteFile,
  mockIsDashboardPgPrimary,
} = vi.hoisted(() => ({
  mockReadDashboardFromPg: vi.fn().mockResolvedValue(null),
  mockReadDashboardFromPgUngated: vi.fn().mockResolvedValue(null),
  mockProbeHydration: vi.fn().mockResolvedValue({ kind: 'empty' }),
  mockDualWriteSync: vi.fn().mockResolvedValue(undefined),
  mockDualWriteSyncChecked: vi.fn().mockResolvedValue({ ok: true, reason: 'written' }),
  mockWriteFile: vi.fn(),
  mockIsDashboardPgPrimary: vi.fn().mockReturnValue(false),
}));

// La moitié GDrive passe par fs/promises — writeFile est mocké PAR DÉFAUT vers
// le réel (chaque test le reprogramme explicitement pour faire échouer/pendre).
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, writeFile: mockWriteFile };
});

vi.mock('@/services/unified-store/roosync-dashboard-store', () => ({
  readDashboardFromPg: mockReadDashboardFromPg,
  readDashboardFromPgUngated: mockReadDashboardFromPgUngated,
  probeDashboardJournalForHydration: mockProbeHydration,
  dualWriteDashboardSync: mockDualWriteSync,
  dualWriteDashboardSyncChecked: mockDualWriteSyncChecked,
  dualWriteDashboardDelete: vi.fn().mockResolvedValue(undefined),
  getDashboardPgReader: vi.fn().mockReturnValue(null),
  getDashboardRetirement: vi.fn().mockResolvedValue(null),
  listRetiredDashboardKeys: vi.fn().mockResolvedValue(new Set<string>()),
  retireDashboardKeyChecked: vi.fn().mockResolvedValue({ ok: true, reason: 'written' }),
  acquireDashboardSharedLock: vi.fn().mockResolvedValue('unavailable'),
  releaseDashboardSharedLock: vi.fn().mockResolvedValue(undefined),
  readDashboardSharedLock: vi.fn().mockResolvedValue(null),
  fetchArchivedDashboardMessageIds: vi.fn().mockResolvedValue(null),
  isDashboardPgPrimary: mockIsDashboardPgPrimary,
}));

import { roosyncDashboard, getAppendLockPath } from '../dashboard.js';
import { isDashboardReadPgEnabled } from '@/services/unified-store/pg-read-gates';
import { setBackfillMarkerState } from '@/services/unified-store/pg-backfill-marker';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-pg-primary-');

/**
 * Installe une vue PG dans le mock de `readDashboardFromPg` EN RESPECTANT LA
 * PORTE, comme la production : `getDashboardPgReader` rend null sans
 * `READ_PG` (et sans URL de store), donc `readDashboardFromPg` rend null et
 * l'appelant retombe sur le FICHIER. Un mock qui ignorait la porte laissait un
 * test « prouver » une réparation #3230 qui ne peut pas courir sur ce siège
 * (pré-revue #4286, finding 1) : le test passait sur un câblage inexistant.
 *
 * #4131 : la porte se résout par `isPgFlagOn` — ouverte dès qu'une URL de
 * store est présente, fermée par le kill-switch '0'. Le faux respecte donc
 * la RÉALITÉ de la porte, pas une copie de l'ancienne sémantique `=== '1'`.
 */
const setPgView = (view: unknown): void => {
  mockReadDashboardFromPg.mockImplementation(async () => {
    // #4131 + review ms#1540 — la porte de lecture se résout par
    // `isDashboardReadPgEnabled()` : ouverte sur '1' explicite, fermée par le
    // kill-switch '0', et — à défaut — conditionnée au MARQUEUR de backfill.
    const readGateOpen = isDashboardReadPgEnabled();
    const storeUrlPresent = !!process.env.UNIFIED_STORE_PG_URL;
    return readGateOpen && storeUrlPresent ? view : null;
  });
};

/**
 * Attend la FIN du miroir fichier détaché (#4286) : sa tâche de fond rend le
 * verrou append dans son `.finally`, donc l'absence du fichier de verrou est le
 * signal de complétion. Sans cette attente, le miroir d'un test déborde sur le
 * suivant et appelle ses mocks (pré-revue #4286, finding 2).
 */
const waitForDetachedMirror = async (key: string): Promise<void> => {
  await vi.waitFor(() => {
    expect(existsSync(getAppendLockPath(key))).toBe(false);
  }, { timeout: 5000, interval: 10 });
};

describe('PG-premier, GDrive miroir borné (#4131 G-B lot 2)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    fsWriteFileReal = actual.writeFile;
    mockWriteFile.mockImplementation(((file: unknown, data: unknown, opts: unknown) =>
      fsWriteFileReal(file as string, data as string, opts as undefined)) as typeof fsWriteFileReal);
    mockReadDashboardFromPg.mockReset().mockResolvedValue(null);
    mockReadDashboardFromPgUngated.mockReset().mockResolvedValue(null);
    mockProbeHydration.mockReset().mockResolvedValue({ kind: 'empty' });
    mockDualWriteSync.mockClear().mockResolvedValue(undefined);
    mockDualWriteSyncChecked.mockClear().mockResolvedValue({ ok: true, reason: 'written' });
    // Gate OFF par défaut : chaque test l'allume explicitement.
    mockIsDashboardPgPrimary.mockReset().mockReturnValue(false);

    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    process.env.UNIFIED_STORE_DASHBOARD_GDRIVE_WRITE_TIMEOUT_MS = '150';
    delete process.env.UNIFIED_STORE_DASHBOARD_READ_PG;
    delete process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY;
    // Marqueur de backfill dashboards : absent par défaut (store non
    // importé ⇒ GDrive reste en charge). Un état FRAIS (jamais 'unknown')
    // évite toute consultation PG parasite pendant les tests.
    setBackfillMarkerState('dashboard', 'absent');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
    delete process.env.UNIFIED_STORE_DASHBOARD_GDRIVE_WRITE_TIMEOUT_MS;
    delete process.env.UNIFIED_STORE_DASHBOARD_READ_PG;
    delete process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY;
    delete process.env.UNIFIED_STORE_DUAL_WRITE;
    delete process.env.UNIFIED_STORE_PG_URL;
    setBackfillMarkerState('dashboard', 'absent');
  });

  it('gate : PG_PRIMARY exige DUAL_WRITE + PG_URL (Null-writer guard, pattern canal #1030)', async () => {
    const actual = await vi.importActual<typeof import('@/services/unified-store/roosync-dashboard-store')>(
      '@/services/unified-store/roosync-dashboard-store'
    );
    process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY = '1';
    // #4131: the DUAL_WRITE half now DEFAULTS ON wherever a PG URL is set —
    // the Null-writer config is expressed by the explicit kill-switch '0'.
    process.env.UNIFIED_STORE_DUAL_WRITE = '0';
    delete process.env.UNIFIED_STORE_PG_URL;
    expect(actual.isDashboardPgPrimary()).toBe(false);
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    expect(actual.isDashboardPgPrimary()).toBe(false); // PG_URL manque
    process.env.UNIFIED_STORE_PG_URL = 'postgresql://test';
    expect(actual.isDashboardPgPrimary()).toBe(true);
    // #4131 + review ms#1540 — le DÉFAUT de la porte PG_PRIMARY est
    // conditionné à la DONNÉE : sans le marqueur de backfill dashboards, le
    // store n'est pas complet (un dashboard importé à moitié se lirait VIDE
    // au lieu de retomber sur le fichier GDrive). Un '1' explicite force
    // toujours la porte ouverte ; le kill-switch '0' la ferme.
    delete process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY;
    setBackfillMarkerState('dashboard', 'absent');
    expect(actual.isDashboardPgPrimary()).toBe(false);
    setBackfillMarkerState('dashboard', 'complete');
    expect(actual.isDashboardPgPrimary()).toBe(true);
    process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY = '0';
    expect(actual.isDashboardPgPrimary()).toBe(false);
  });

  it('append nominal PG-premier : checked AVANT le fichier, miroir écrit, jamais de void, verdict store lu sans gate READ_PG', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);
    // La vue initiale vient de PG (READ_PG armé) : le fichier n'existe pas
    // encore — le premier append le crée via le full-write miroir. L'URL est
    // posée aussi : la porte de lecture exige les DEUX (cf. setPgView).
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgresql://test';
    // #4131 — DUAL_WRITE est ON PAR DÉFAUT dès qu'une URL PG est posée, et
    // le contrat #4286 en déduit que le miroir FICHIER sort du chemin critique
    // (view PG-dérivée + PG capable de porter l'écriture). Ce cas épingle
    // l'autre moitié : quand PG NE PEUT PAS porter l'écriture (kill-switch
    // DUAL_WRITE='0'), la moitié fichier reste SUR le chemin de l'appelant.
    // Le contrat différé par défaut est mesuré par le bloc #4286 plus bas.
    process.env.UNIFIED_STORE_DUAL_WRITE = '0';
    setPgView({
      type: 'workspace',
      key: 'workspace-test-workspace',
      lastModified: new Date().toISOString(),
      lastModifiedBy: { machineId: 'other-machine', workspace: 'w' },
      status: { markdown: 'status' },
      intercom: { messages: [], totalMessages: 0 },
    });

    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'premier append sous PG-premier',
    });

    expect(result.success).toBe(true);
    // PG écrit PREMIER : le checked a cours, la variante void jamais.
    expect(mockDualWriteSyncChecked).toHaveBeenCalledTimes(1);
    expect(mockDualWriteSync).not.toHaveBeenCalled();
    // Pas de dégradation : le miroir fichier a atterri.
    expect(result.writeVerification?.gdriveDegraded).toBeFalsy();
    // Le verdict store (critère 2 #3774) a lu la surface primaire SANS le
    // gate READ_PG — c'est le câblage readDashboardFromPgUngated du lot 2.
    expect(mockReadDashboardFromPgUngated).toHaveBeenCalled();
    // Le MIROIR fichier porte le message (full-write fichier-seul, preWritten :
    // pas de SECOND checked PG malgré le détour par writeDashboardFile).
    expect(mockDualWriteSyncChecked).toHaveBeenCalledTimes(1);
    const filePath = path.join(tmpDir, 'dashboards', `${result.key}.md`);
    const content = await readFile(filePath, 'utf8');
    expect(content).toContain('premier append sous PG-premier');
  });

  it('PG ok + GDrive hang : succès DÉGRADÉ, le store PG porte seul le message', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgresql://test';
    // #4131: avec DUAL_WRITE armé (désarmé ici par le kill-switch '0'), la
    // moitié FILE reste sur le chemin de l'appelant — c'est ce chemin-là que
    // ce test mesure : la borne temporelle du staging GDrive qui rend la
    // dégradation VISIBLE au caller. Armé, le miroir fichier partirait en
    // arrière-plan (contrat #4286) et l'échec ne remonterait plus ici.
    process.env.UNIFIED_STORE_DUAL_WRITE = '0';
    setPgView({
      type: 'workspace',
      key: 'workspace-test-workspace',
      lastModified: new Date().toISOString(),
      lastModifiedBy: { machineId: 'm', workspace: 'w' },
      status: { markdown: '' },
      intercom: { messages: [], totalMessages: 0 },
    });
    // DriveFS hangé sur le staging du dashboard uniquement (verrou en tmpdir OK).
    mockWriteFile.mockImplementation(((file: unknown, data: unknown, opts: unknown) => {
      const f = String(file);
      if (f.includes('dashboards') && f.endsWith('.tmp')) {
        return new Promise(() => { /* DriveFS hangé */ });
      }
      return fsWriteFileReal(f, data as string, opts as undefined);
    }) as typeof fsWriteFileReal);

    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'message sous DriveFS hangé, PG primaire',
    });

    expect(result.success).toBe(true);
    expect(result.writeVerification?.gdriveDegraded).toBeTruthy();
    // UNE seule écriture PG (le checked du haut) — le miroir dégradé n'a pas
    // re-tenté, le fallback GDrive-first n'a pas cours.
    expect(mockDualWriteSyncChecked).toHaveBeenCalledTimes(1);
    expect(mockDualWriteSync).not.toHaveBeenCalled();
  });

  it('PG en échec : repli intégral sur le chemin GDrive-first du lot 1 (fichier + dual-write void)', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);
    mockDualWriteSyncChecked.mockResolvedValue({ ok: false, reason: 'exhausted' });

    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'repli GDrive-first après panne PG',
    });

    expect(result.success).toBe(true);
    // Le repli a couru COMPLET : fichier primaire + miroir PG void. Le checked
    // a couru DEUX fois (appendDashboardIncremental PUIS le writeDashboardFile
    // du repli — pgPrimaryPreWritten n'était pas posé puisque le premier PG
    // avait échoué) : chaque site retente PG une fois avant de se replier.
    expect(mockDualWriteSyncChecked).toHaveBeenCalledTimes(2);
    expect(mockDualWriteSync).toHaveBeenCalledTimes(1);
    expect(result.writeVerification?.gdriveDegraded).toBeFalsy();
    const filePath = path.join(tmpDir, 'dashboards', `${result.key}.md`);
    const content = await readFile(filePath, 'utf8');
    expect(content).toContain('repli GDrive-first après panne PG');
  });

  it('PG en échec + GDrive en échec : échec TOTAL — aucune surface ne porte le message', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);
    mockDualWriteSyncChecked.mockResolvedValue({ ok: false, reason: 'exhausted' });
    // DriveFS hangé sur le staging : la moitié GDrive du repli expirera.
    mockWriteFile.mockImplementation(((file: unknown, data: unknown, opts: unknown) => {
      const f = String(file);
      if (f.includes('dashboards') && f.endsWith('.tmp')) {
        return new Promise(() => { /* DriveFS hangé */ });
      }
      return fsWriteFileReal(f, data as string, opts as undefined);
    }) as typeof fsWriteFileReal);

    await expect(roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'double panne',
    })).rejects.toThrow(/aucune surface ne porte le message/);
  });

  it('lecture initiale hangée : la course borne la boucle 3-tentatives, l’append ne pend pas (drapeau NanoClaw)', async () => {
    // Gate OFF ici : on épingle le bornage de readDashboardFromGdrive lui-même,
    // indépendant du mode PG-premier (il protège aussi le chemin lot 1).
    mockIsDashboardPgPrimary.mockReturnValue(false);
    // Un dashboard existant au fichier (vue fichier, READ_PG off).
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    await actual.mkdir(path.join(tmpDir, 'dashboards'), { recursive: true });
    await fsWriteFileReal(
      path.join(tmpDir, 'dashboards', 'workspace-test-workspace.md'),
      `---
type: workspace
lastModified: '2026-10-14T10:00:00.000Z'
lastModifiedBy:
  machineId: m
  workspace: w
totalMessages: 1
---

## Status

status existant

## Intercom (1 messages)

### [2026-10-14T10:00:00.000Z] m|w
[msg: seed-1]

seed
`,
      'utf8'
    );
    // readFile hangé qui IGNORE l'AbortSignal (hang pur au-delà du signal) —
    // c'est la COURSE (withWriteDeadline) qui doit trancher à la borne.
    // Le readFile du incrément (appendDashboardIncremental) pend aussi, mais
    // son signal est respecté par la vraie API ; seul le mock pendent existe
    // pour illustrer le pire cas — la borne globale arrête tout.
    const { readFile: realReadFile } = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    const fsMocked = await import('fs/promises');
    vi.spyOn(fsMocked, 'readFile').mockImplementation(((file: unknown, opts: unknown) => {
      const f = String(file);
      if (f.includes('dashboards') && f.endsWith('.md')) {
        return new Promise(() => { /* lecture GDrive hangée */ });
      }
      return realReadFile(file as string, opts as undefined);
    }) as typeof realReadFile);

    // La vue initiale EST la lecture : sans elle, l'append refuse (publier
    // depuis une vue possiblement périmée fermerait les yeux sur un fork).
    // Ce que le lot 2 garantit : le refus arrive à la BORNE (150 ms) au lieu
    // de l'hang indéfini d'avant — la course withWriteDeadline tranche.
    const t0 = Date.now();
    await expect(roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'append pendant que la lecture GDrive pend',
    })).rejects.toThrow(/borne GDrive/);
    // Garde de vitesse : la borne (150 ms) est respectée avec marge CI — le
    // comportement d'avant le lot 2 ne rendait JAMAIS la main.
    expect(Date.now() - t0).toBeLessThan(2500);
  });
});

/**
 * #4286 §2/§3 — « PG d'abord, GDrive en asynchrone ».
 *
 * Mesure de l'issue : un append sur `workspace-roo-extensions` coûtait 54-99 s
 * d'écriture sur ai-01, décomposition à l'appui (log SLOW-WRITE du 22/10 :
 * `gdriveReadMs` 15,7-24,3 s + `gdriveWriteMs` 30,0 s à la borne, contre
 * `pgMirrorWriteMs` 15-1342 ms et `lockWaitMs` 34-316 ms — le verrou était hors
 * de cause). Le terme dominant est donc la moitié fichier, et elle n'a aucune
 * raison de tenir l'appelant quand aucun lecteur ne dépend d'elle.
 *
 * Ce bloc épingle :
 *  1. le report effectif : l'append rend la main pendant que l'écriture fichier
 *     est encore bloquée, puis le miroir atterrit quand même (le message n'est
 *     pas perdu, il arrive plus tard) ;
 *  2. la porte : sans lecteur PG ni PG-primaire, le fichier reste synchrone —
 *     différer ferait lire à un consommateur un message que sa surface n'a pas ;
 *  3. l'échec PG d'abord : pas de report, repli GDrive-first complet ;
 *  4. la décomposition ne ment pas : une étape non exécutée sur le chemin de
 *     l'appelant n'est pas rapportée (sinon la somme « étapes ≤ writeMs »
 *     couvrirait un travail fait ailleurs) ;
 *  5. la TROISIÈME combinaison de la porte (PG-primaire SANS READ_PG) : report
 *     ouvert et PG porte le message, MAIS la garde #3230 y est INERTE — la vue
 *     de l'append vient du fichier (readDashboardFromPg est gatée), donc la
 *     « réparation » comparerait le fichier à lui-même (finding 1 de la
 *     pré-revue) ; le cas READ_PG=1 correspondant, où la réparation court
 *     vraiment, est épinglé juste après ;
 *  6. le chemin `.catch` du miroir détaché : rejet avalé + logué, verrou TENU
 *     pendant le miroir puis rendu par le `.finally`.
 *
 * Les miroirs détachés sont ATTENDUS en fin de test (`waitForDetachedMirror`) :
 * sans cela la tâche de fond d'un test déborde sur le suivant et appelle ses
 * mocks (finding 2 de la pré-revue — 1 échec sur 6 observé en revue).
 */
describe('PG d\'abord, miroir fichier hors du chemin critique (#4286)', () => {
  let tmpDir: string;

  /** Rejette après `ms` — transforme un blocage en échec lisible. */
  const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_res, rej) => setTimeout(() => rej(new Error(`bloqué: ${label} (${ms} ms)`)), ms)),
    ]);

  const pgView = () => ({
    type: 'workspace' as const,
    key: 'workspace-test-workspace',
    lastModified: new Date().toISOString(),
    lastModifiedBy: { machineId: 'other-machine', workspace: 'w' },
    status: { markdown: 'status' },
    intercom: { messages: [], totalMessages: 0 },
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    fsWriteFileReal = actual.writeFile;
    mockWriteFile.mockReset().mockImplementation(((file: unknown, data: unknown, opts: unknown) =>
      fsWriteFileReal(file as string, data as string, opts as undefined)) as typeof fsWriteFileReal);
    mockReadDashboardFromPg.mockReset().mockResolvedValue(null);
    mockReadDashboardFromPgUngated.mockReset().mockResolvedValue(null);
    mockProbeHydration.mockReset().mockResolvedValue({ kind: 'empty' });
    mockDualWriteSync.mockClear().mockResolvedValue(undefined);
    mockDualWriteSyncChecked.mockClear().mockResolvedValue({ ok: true, reason: 'written' });
    mockIsDashboardPgPrimary.mockReset().mockReturnValue(false);

    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    process.env.UNIFIED_STORE_DASHBOARD_GDRIVE_WRITE_TIMEOUT_MS = '150';
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
    delete process.env.UNIFIED_STORE_DASHBOARD_GDRIVE_WRITE_TIMEOUT_MS;
    delete process.env.UNIFIED_STORE_DASHBOARD_READ_PG;
    delete process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY;
    delete process.env.UNIFIED_STORE_DUAL_WRITE;
    delete process.env.UNIFIED_STORE_PG_URL;
  });

  it('report effectif : l\'append rend la main pendant que l\'écriture fichier pend, le miroir atterrit ensuite', async () => {
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgresql://test';
    setPgView(pgView());

    // Une porte que le test ouvre lui-même : l'écriture du staging reste
    // bloquée tant qu'elle est fermée — c'est le DriveFS qui rampe, en
    // contrôlable.
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    mockWriteFile.mockImplementation(((file: unknown, data: unknown, opts: unknown) => {
      const f = String(file);
      if (f.includes('dashboards') && f.endsWith('.tmp')) {
        return gate.then(() => fsWriteFileReal(f, data as string, opts as undefined));
      }
      return fsWriteFileReal(file as string, data as string, opts as unknown as undefined);
    }) as typeof fsWriteFileReal);

    const t0 = Date.now();
    const result = await withTimeout(
      roosyncDashboard({ action: 'append', type: 'workspace', content: 'append sous miroir différé' }),
      1500,
      'append bloqué par la moitié fichier — le report n\'a pas eu lieu'
    );
    const elapsed = Date.now() - t0;

    expect(result.success).toBe(true);
    // PG a porté l'écriture autoritaire, une seule fois, et le report est dit.
    expect(mockDualWriteSyncChecked).toHaveBeenCalledTimes(1);
    expect(result.writeVerification?.gdriveDeferred).toBe(true);
    expect(result.writeVerification?.gdriveDegraded).toBeFalsy();
    // L'étape GDrive n'est PAS rapportée sur le chemin de l'appelant : elle se
    // mesure dans la tâche de fond, où plus personne ne l'attend.
    expect(result.durationBreakdown?.writeBreakdown?.gdriveWriteMs).toBeUndefined();
    expect(elapsed).toBeLessThan(1000);

    // Le miroir atterrit après coup — le message n'est pas perdu, il est tardif.
    openGate();
    const filePath = path.join(tmpDir, 'dashboards', `${result.key}.md`);
    await vi.waitFor(async () => {
      const content = await readFile(filePath, 'utf8').catch(() => '');
      expect(content).toContain('append sous miroir différé');
    }, { timeout: 3000, interval: 25 });
    // Le fichier qui atterrit n'est PAS la fin du miroir : la tâche de fond
    // vérifie l'atterrissage puis rend le verrou. L'attendre ici empêche son
    // débordement sur le test suivant (finding 2 de la pré-revue #4286).
    await waitForDetachedMirror(result.key);
  });

  it('porte : sans lecteur PG ni PG-primaire, le fichier reste SYNCHRONE (pas de report)', async () => {
    // DUAL_WRITE + PG_URL présents, mais PAS de lecteur PG (READ_PG fermé par
    // le kill-switch '0') et PG_PRIMARY off : le fichier est encore une
    // surface de lecture, il ne peut pas être différé.
    // #4131: l'absence de READ_PG ne ferme plus la porte (le défaut suit la
    // présence d'une URL PG) — le kill-switch explicite est ce qui la ferme.
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgresql://test';
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '0';
    // Dashboard préexistant : on veut le chemin INCRÉMENTAL (lecture + écriture
    // GDrive), pas le full-write du premier append.
    await roosyncDashboard({ action: 'write', type: 'workspace', content: '# Init' });

    const result = await roosyncDashboard({ action: 'append', type: 'workspace', content: 'append synchrone ordinaire' });

    expect(result.success).toBe(true);
    expect(result.writeVerification?.gdriveDeferred).toBeFalsy();
    // La moitié GDrive a bien couru SUR le chemin de l'appelant : ses deux
    // étapes sont mesurées ici et pas ailleurs.
    expect(result.durationBreakdown?.writeBreakdown?.gdriveReadMs).toBeGreaterThanOrEqual(0);
    expect(result.durationBreakdown?.writeBreakdown?.gdriveWriteMs).toBeGreaterThanOrEqual(0);
    // Pas de PG d'abord : aucune écriture PG sous verrou n'a couru.
    expect(result.durationBreakdown?.writeBreakdown?.pgPrimaryWriteMs).toBeUndefined();
    expect(mockDualWriteSyncChecked).not.toHaveBeenCalled();
  });

  it('échec PG d\'abord : aucun report, repli GDrive-first complet, le message atterrit', async () => {
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgresql://test';
    setPgView(pgView());
    mockDualWriteSyncChecked.mockResolvedValue({ ok: false, reason: 'exhausted' });

    const result = await roosyncDashboard({ action: 'append', type: 'workspace', content: 'repli après échec PG d\'abord' });

    expect(result.success).toBe(true);
    expect(result.writeVerification?.gdriveDeferred).toBeFalsy();
    const filePath = path.join(tmpDir, 'dashboards', `${result.key}.md`);
    const content = await readFile(filePath, 'utf8');
    expect(content).toContain('repli après échec PG d\'abord');
  });

  /**
   * Copie locale EN RETARD : elle porte `file-only-1` mais PAS `seed-1`, que
   * la vue PG détient — la forme du lag qu'un miroir différé peut créer.
   */
  const writeLaggingDashFile = async (): Promise<string> => {
    const dashDir = path.join(tmpDir, 'dashboards');
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    await actual.mkdir(dashDir, { recursive: true });
    const filePath = path.join(dashDir, 'workspace-test-workspace.md');
    await fsWriteFileReal(
      filePath,
      `---
type: workspace
lastModified: '2026-10-14T10:00:00.000Z'
lastModifiedBy:
  machineId: other-machine
  workspace: w
totalMessages: 1
---

## Status

status

## Intercom (1 messages)

### [2026-10-14T10:00:00.000Z] other-machine|w
[msg: file-only-1]

message présent seulement sur le fichier
`,
      'utf8'
    );
    return filePath;
  };

  /** Vue PG du même dashboard : elle détient `seed-1`, absent du fichier. */
  const pgViewWithSeed = () => ({
    ...pgView(),
    intercom: {
      messages: [{
        id: 'seed-1',
        timestamp: '2026-10-14T10:05:00.000Z',
        author: { machineId: 'other-machine', workspace: 'w' },
        content: 'message vivant côté PG',
      }],
      totalMessages: 1,
    },
  });

  /**
   * Revues jsboige / po-2024 — la TROISIÈME combinaison de la porte :
   * `PG_PRIMARY=1` + `DUAL_WRITE=1` + `PG_URL`, `READ_PG` ABSENT.
   *
   * Version HONNÊTE (pré-revue #4286, finding 1) : ici la porte de report
   * s'ouvre — et c'est voulu, le journal PG porte le message et ne perd rien —
   * mais la réparation #3230 n'y court PAS. `handleAppend` lit sa vue via
   * `readDashboardFile`, dont la moitié PG est GATÉE sur READ_PG : sans la
   * porte, la vue EST le fichier et la garde #3230 compare le fichier à
   * lui-même (armée, inerte). L'ancienne version de ce test ne passait que
   * parce que le mock de `readDashboardFromPg` ignorait la porte : elle
   * prouvait un câblage qui n'existe pas en production.
   *
   * Le cas où la réparation court VRAIMENT (READ_PG=1, vue PG) est épinglé
   * juste après.
   */
  it('PG-premier SANS READ_PG : report ouvert, PG reçoit le message, garde #3230 INERTE (vue = fichier)', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgresql://test';
    // #4131: la porte de LECTURE se ferme par le kill-switch '0' — son
    // ABSENCE ne la ferme plus (le défaut suit la présence d'une URL PG, donc
    // ce siège serait PG-lecteur et la garde #3230 ne serait plus inerte).
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '0';
    // READ_PG fermé — tout le point du cas (#4131 : par le kill-switch '0',
    // l'absence de la variable ne ferme plus la porte).
    expect(process.env.UNIFIED_STORE_DASHBOARD_READ_PG).toBe('0');

    const filePath = await writeLaggingDashFile();
    // Vue PG posée derrière la PORTE : sans READ_PG elle est ignorée à la
    // lecture, exactement comme en production.
    setPgView(pgViewWithSeed());

    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'append sous PG-premier sans READ_PG',
    });

    // 1) Le report est effectif, et PG a bien reçu l'écriture vérifiée — le
    //    message n'est pas perdu, il est dans le journal PG.
    expect(result.success).toBe(true);
    expect(result.writeVerification?.gdriveDeferred).toBe(true);
    expect(mockDualWriteSyncChecked).toHaveBeenCalledTimes(1);

    // 2) Le miroir de fond atterrit, mais depuis la VUE FICHIER : le message
    //    neuf et `file-only-1` y sont ; `seed-1` (PG seul) N'Y ARRIVE PAS.
    //    C'est la mesure de l'inertie de la garde : si elle se déclenchait, le
    //    fichier serait réécrit depuis la vue PG et `seed-1` apparaîtrait.
    await vi.waitFor(async () => {
      const content = await readFile(filePath, 'utf8').catch(() => '');
      expect(content).toContain('append sous PG-premier sans READ_PG');
    }, { timeout: 3000, interval: 25 });
    await waitForDetachedMirror(result.key);

    const finalContent = await readFile(filePath, 'utf8');
    expect(finalContent).toContain('file-only-1');
    expect(finalContent).not.toContain('seed-1');
  });

  /**
   * Contrepartie du test précédent : MÊME copie en retard, mais `READ_PG=1` —
   * la vue vient de PG, donc la garde #3230 est armée ET effective. La
   * réparation court DANS le miroir détaché (#4286) : `seed-1` arrive au
   * fichier, l'id file-only est réinjecté (cas mixte), le message neuf est
   * écrit. C'est ce cas qui prouve que le prédicat partagé répare là où il dit
   * réparer.
   */
  it('READ_PG=1 : même copie en retard, la réparation #3230 court dans le miroir détaché', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgresql://test';

    const filePath = await writeLaggingDashFile();
    setPgView(pgViewWithSeed());

    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'append sous PG-premier, réparation dans le miroir',
    });

    expect(result.success).toBe(true);
    expect(result.writeVerification?.gdriveDeferred).toBe(true);
    // PG a porté l'écriture autoritaire une seule fois : la réparation est un
    // full-write fichier (pgPrimaryPreWritten), pas un second checked.
    expect(mockDualWriteSyncChecked).toHaveBeenCalledTimes(1);

    // La réparation réécrit le fichier COMPLET depuis la vue PG en arrière-plan.
    await vi.waitFor(async () => {
      const content = await readFile(filePath, 'utf8').catch(() => '');
      expect(content).toContain('seed-1');
    }, { timeout: 3000, interval: 25 });
    await waitForDetachedMirror(result.key);

    // Cas mixte #3230 : l'id file-only est réinjecté, le message neuf écrit.
    const finalContent = await readFile(filePath, 'utf8');
    expect(finalContent).toContain('file-only-1');
    expect(finalContent).toContain('append sous PG-premier, réparation dans le miroir');
  });

  /**
   * Réserve R3 (po-2023 / po-2024 / jsboige) — le SEUL chemin `.catch` du
   * miroir détaché n'était épinglé par aucun test. On force un vrai REJET (pas
   * un blocage) de la moitié fichier : PG d'abord réussit, la lecture du
   * fichier absent part en full-write, l'écriture fichier rejette, et le
   * dual-write du repli échoue aussi → `writeDashboardFile` lève « aucune
   * surface » DANS la tâche de fond. Attendu : le `.catch` logue et avale, le
   * verrou est TENU pendant le miroir puis rendu par le `.finally`, et l'append
   * a déjà répondu `success` + `gdriveDeferred`.
   */
  it('rejet du miroir de fond : le chemin .catch s\'exécute, le verrou tenu puis rendu', async () => {
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgresql://test';
    setPgView(pgView());

    // 1er appel PG (le « PG d'abord ») réussit ; les suivants (le repli interne
    // du full-write) échouent → la moitié fichier lève dans la tâche de fond.
    mockDualWriteSyncChecked
      .mockResolvedValueOnce({ ok: true, reason: 'written' })
      .mockResolvedValue({ ok: false, reason: 'exhausted' });

    // Rejet franc sur le staging (pas un hang) : c'est le rejet que le `.catch`
    // du miroir détaché doit avaler. On en profite pour CAPTURER l'état du
    // verrou à l'instant de l'écriture du miroir : c'est la preuve qu'il était
    // tenu pendant le travail de fond (finding 3 de la pré-revue #4286).
    const lockPath = getAppendLockPath('workspace-test-workspace');
    let lockHeldDuringMirror: boolean | null = null;
    mockWriteFile.mockImplementation(((file: unknown, data: unknown, opts: unknown) => {
      const f = String(file);
      if (f.includes('dashboards') && f.endsWith('.tmp')) {
        lockHeldDuringMirror = existsSync(lockPath);
        return Promise.reject(new Error('DriveFS indisponible (test .catch #4286)'));
      }
      return fsWriteFileReal(file as string, data as string, opts as undefined);
    }) as typeof fsWriteFileReal);

    const logged: string[] = [];
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    }) as typeof console.error);

    try {
      const result = await roosyncDashboard({
        action: 'append', type: 'workspace', content: 'append dont le miroir rejette',
      });

      // L'appelant a eu sa réponse AVANT l'échec : PG porte le message.
      expect(result.success).toBe(true);
      expect(result.writeVerification?.gdriveDeferred).toBe(true);
      expect(result.writeVerification?.gdriveDegraded).toBeFalsy();

      // Le `.catch` a couru (log dédié).
      await vi.waitFor(() => {
        expect(logged.some(line => line.includes('[GDRIVE-MIRROR #4286] miroir fichier en arrière-plan rejeté'))).toBe(true);
      }, { timeout: 3000, interval: 25 });

      // Le verrou était TENU pendant le miroir (présence capturée au moment de
      // son écriture, avant le rejet)…
      expect(lockHeldDuringMirror).toBe(true);
      // … puis RENDU par le `.finally` : un rejet ne doit pas laisser le verrou
      // au sol pour les appenders suivants.
      await vi.waitFor(() => {
        expect(existsSync(lockPath)).toBe(false);
      }, { timeout: 3000, interval: 25 });

      // NOTE (finding 3) : pas d'assertion `unhandledRejection` ici. Le `.catch`
      // est attaché AU MOMENT DE L'APPEL, donc l'événement ne peut jamais
      // partir — l'assertion serait vacuité, pas preuve. Le contrat se prouve
      // par le log dédié ci-dessus, la tenue puis le rendu du verrou, et le
      // résultat rendu à l'appelant. Si le `.catch` disparaissait un jour, ce
      // sont le log et le verrou qui tomberaient d'abord (eux sont réels).
      // Le miroir a échoué avant d'écrire : le fichier n'existe pas, PG seul.
      expect(existsSync(path.join(tmpDir, 'dashboards', 'workspace-test-workspace.md'))).toBe(false);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
