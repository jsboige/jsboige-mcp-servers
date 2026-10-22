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

import { roosyncDashboard } from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-pg-primary-');

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

  it('gate : PG_PRIMARY exige DUAL_WRITE + PG_URL (Null-writer guard, pattern canal #1030)', async () => {
    const actual = await vi.importActual<typeof import('@/services/unified-store/roosync-dashboard-store')>(
      '@/services/unified-store/roosync-dashboard-store'
    );
    process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY = '1';
    delete process.env.UNIFIED_STORE_DUAL_WRITE;
    delete process.env.UNIFIED_STORE_PG_URL;
    expect(actual.isDashboardPgPrimary()).toBe(false);
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    expect(actual.isDashboardPgPrimary()).toBe(false); // PG_URL manque
    process.env.UNIFIED_STORE_PG_URL = 'postgresql://test';
    expect(actual.isDashboardPgPrimary()).toBe(true);
    delete process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY;
    expect(actual.isDashboardPgPrimary()).toBe(false);
  });

  it('append nominal PG-premier : checked AVANT le fichier, miroir écrit, jamais de void, verdict store lu sans gate READ_PG', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);
    // La vue initiale vient de PG (READ_PG armé) : le fichier n'existe pas
    // encore — le premier append le crée via le full-write miroir.
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
    mockReadDashboardFromPg.mockResolvedValue({
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
    mockReadDashboardFromPg.mockResolvedValue({
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
 *     couvrirait un travail fait ailleurs).
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
    mockReadDashboardFromPg.mockResolvedValue(pgView());

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
  });

  it('porte : sans lecteur PG ni PG-primaire, le fichier reste SYNCHRONE (pas de report)', async () => {
    // DUAL_WRITE + PG_URL présents, mais READ_PG absent et PG_PRIMARY off :
    // le fichier est encore une surface de lecture, il ne peut pas être différé.
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgresql://test';
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
    mockReadDashboardFromPg.mockResolvedValue(pgView());
    mockDualWriteSyncChecked.mockResolvedValue({ ok: false, reason: 'exhausted' });

    const result = await roosyncDashboard({ action: 'append', type: 'workspace', content: 'repli après échec PG d\'abord' });

    expect(result.success).toBe(true);
    expect(result.writeVerification?.gdriveDeferred).toBeFalsy();
    const filePath = path.join(tmpDir, 'dashboards', `${result.key}.md`);
    const content = await readFile(filePath, 'utf8');
    expect(content).toContain('repli après échec PG d\'abord');
  });
});
