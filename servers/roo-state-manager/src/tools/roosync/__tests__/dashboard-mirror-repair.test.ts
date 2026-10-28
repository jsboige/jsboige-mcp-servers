/**
 * #4131 review (minor 1) — `repairDashboardMirrorFromPg` est la seule écriture
 * du module dont le FICHIER est le livrable : partout ailleurs une moitié
 * GDrive dégradée ne fait que dégrader une écriture que PG porte déjà, mais
 * ici le fichier ÉTAIT la panne. Si la fonction rendait sans throw, la passe
 * compterait `mirrorRepaired++` et le miroir pourrirait en silence — le
 * compteur mensonger que cet epic paie depuis le début.
 *
 * @module tools/roosync/__tests__/dashboard-mirror-repair
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { Dashboard } from '../dashboard-schemas.js';

// Le vrai writeFile — récupéré via importActual, JAMAIS via l'import du module
// mocké (qui résoudrait vers le mock et récursionnerait à l'infini).
let fsWriteFileReal: typeof import('fs/promises')['writeFile'];

const {
  mockReadDashboardFromPg,
  mockProbeHydration,
  mockDualWriteSync,
  mockDualWriteSyncChecked,
  mockDualWriteDelete,
  mockWriteFile,
  mockIsDashboardPgPrimary,
  mockReadDashboardFromPgUngated,
} = vi.hoisted(() => ({
  mockReadDashboardFromPg: vi.fn().mockResolvedValue(null),
  mockProbeHydration: vi.fn().mockResolvedValue({ kind: 'empty' }),
  mockDualWriteSync: vi.fn().mockResolvedValue(undefined),
  mockDualWriteSyncChecked: vi.fn().mockResolvedValue({ ok: true, reason: 'written' }),
  mockDualWriteDelete: vi.fn().mockResolvedValue(undefined),
  mockWriteFile: vi.fn(),
  mockIsDashboardPgPrimary: vi.fn().mockReturnValue(true),
  mockReadDashboardFromPgUngated: vi.fn().mockResolvedValue(null),
}));

// La moitié GDrive passe par fs/promises — le mock ne remplace QUE writeFile
// (tout le reste — mkdtemp, readFile, unlink, copyFile… — reste réel).
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, writeFile: mockWriteFile };
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
  // #3782 : couche PG 'unavailable' (hôte sans PG) → pas de contention de
  // verrou flotte dans ce test ; le verrou append procède déverrouillé.
  acquireDashboardSharedLock: vi.fn().mockResolvedValue('unavailable'),
  releaseDashboardSharedLock: vi.fn().mockResolvedValue(undefined),
  readDashboardSharedLock: vi.fn().mockResolvedValue(null),
  fetchArchivedDashboardMessageIds: vi.fn().mockResolvedValue(null),
  isDashboardPgPrimary: mockIsDashboardPgPrimary,
  readDashboardFromPgUngated: mockReadDashboardFromPgUngated,
}));

import { repairDashboardMirrorFromPg } from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-mirror-repair-');

function pgDashboard(key: string): Dashboard {
  const messages = [
    {
      id: 'pg-existing-1',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      author: { machineId: 'other-machine', workspace: 'other-workspace' },
      content: 'message lu dans la vue PG',
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

describe('repairDashboardMirrorFromPg (#4131 review minor 1)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    fsWriteFileReal = actual.writeFile;
    // writeFile réel par défaut : seul le test dégradé le reprogramme.
    mockWriteFile.mockImplementation(
      ((...args: Parameters<typeof fsWriteFileReal>) =>
        fsWriteFileReal(...args)) as typeof fsWriteFileReal
    );
    mockReadDashboardFromPg.mockReset().mockResolvedValue(null);
    mockProbeHydration.mockReset().mockResolvedValue({ kind: 'empty' });
    mockDualWriteSync.mockClear().mockResolvedValue(undefined);
    mockDualWriteSyncChecked.mockClear().mockResolvedValue({ ok: true, reason: 'written' });
    // La réparation ne vit que sur un siège PG-primaire.
    mockIsDashboardPgPrimary.mockReset().mockReturnValue(true);
    mockReadDashboardFromPgUngated.mockReset().mockResolvedValue(null);

    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    process.env.UNIFIED_STORE_DASHBOARD_GDRIVE_WRITE_TIMEOUT_MS = '80';
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
    delete process.env.UNIFIED_STORE_DASHBOARD_GDRIVE_WRITE_TIMEOUT_MS;
  });

  it('une moitié GDrive dégradée est un ÉCHEC : throw, jamais un « réparé »', async () => {
    // Le store fichier est injoignable : l'écriture du miroir (le livrable
    // même de la réparation) échoue. La fonction doit le DIRE, pas rendre.
    mockWriteFile.mockImplementation(
      ((file: unknown, data: unknown, opts: unknown) => {
        const f = String(file);
        if (f.includes('dashboards')) {
          return Promise.reject(new Error('store injoignable'));
        }
        // heartbeats du verrou append et autres fichiers hors dashboards :
        // réels, sinon le mock pend l'acquisition du verrou elle-même.
        return fsWriteFileReal(f, data as string, opts as undefined);
      }) as typeof fsWriteFileReal
    );

    await expect(repairDashboardMirrorFromPg('workspace-a', pgDashboard('workspace-a'))).rejects.toThrow(
      /moitié GDrive dégradée/
    );

    // La vue vient d'être lue DANS PG (`pgPrimaryPreWritten`) : la réparation
    // ne re-pousse pas la moitié PG — le second upsert n'apporterait qu'un
    // risque de throw mensonger (cf. doc de writeDashboardFile).
    expect(mockDualWriteSyncChecked).not.toHaveBeenCalled();
    expect(mockDualWriteSync).not.toHaveBeenCalled();
  });

  it('nominal : le fichier atterrit avec la vue PG, sans repasser par la porte PG', async () => {
    await expect(
      repairDashboardMirrorFromPg('workspace-a', pgDashboard('workspace-a'))
    ).resolves.toBeUndefined();

    const landed = await readFile(path.join(tmpDir, 'dashboards', 'workspace-a.md'), 'utf8');
    expect(landed).toContain('pg-existing-1');
    expect(mockDualWriteSyncChecked).not.toHaveBeenCalled();
    expect(mockDualWriteSync).not.toHaveBeenCalled();
  });
});
