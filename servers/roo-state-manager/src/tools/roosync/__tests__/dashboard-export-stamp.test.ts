/**
 * #4131 G-MES — périmètre élargi (ai-01, c.6728973761) : sous la porte
 * PG-primaire, TOUTE moitié fichier écrite après une écriture PG réussie est,
 * par construction, un EXPORT de PG — elle doit porter `mirrorExportAt`, le
 * marqueur que lit `scripts/diagnostic/measure-gdrive-write-freeze.ps1` pour ne
 * pas compter l'écriture comme un écrivain résiduel. Le repli GDrive-first
 * (PG en échec) redevient une écriture PRIMAIRE : pas de marqueur, sinon
 * l'instrument ne distingue plus un export d'un résidu.
 *
 * Un test par chemin. La condensation est couverte par
 * `dashboard-condense-pg-anchor.test.ts` (elle passe par `writeDashboardFile`
 * via `applyCondensedWithMerge`) ; ici les DEUX writers distincts restants :
 *   - `append` incrémental (réécriture en place du frontmatter, l.3907+) ;
 *   - `update` du bloc statut et `crossPost` (tous deux `writeDashboardFile`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const {
  mockReadDashboardFromPg,
  mockReadDashboardFromPgUngated,
  mockProbeHydration,
  mockDualWriteSync,
  mockDualWriteSyncChecked,
  mockIsDashboardPgPrimary,
} = vi.hoisted(() => ({
  mockReadDashboardFromPg: vi.fn().mockResolvedValue(null),
  mockReadDashboardFromPgUngated: vi.fn().mockResolvedValue(null),
  mockProbeHydration: vi.fn().mockResolvedValue({ kind: 'empty' }),
  mockDualWriteSync: vi.fn().mockResolvedValue(undefined),
  mockDualWriteSyncChecked: vi.fn().mockResolvedValue({ ok: true, reason: 'written' }),
  mockIsDashboardPgPrimary: vi.fn().mockReturnValue(false),
}));

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

// Aucun LLM dans ce fichier : une condensation éventuelle retombe sur la
// troncature (#1792), ce qui ne change pas le writer testé.
vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

import { roosyncDashboard } from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-export-stamp-');

const frontmatterOf = (content: string): string => {
  const fm = content.match(/^---\n([\s\S]+?)\n---/);
  expect(fm).not.toBeNull();
  return fm![1];
};

describe('#4131 G-MES — le marqueur d\'export sur chaque chemin d\'écriture', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    process.env.CONDENSE_DETACHED = '0';
    // DUAL_WRITE/URL absents : la moitié fichier reste synchrone (aucun report
    // de fond à attendre), le marqueur n'en dépend pas.
    delete process.env.UNIFIED_STORE_DUAL_WRITE;
    delete process.env.UNIFIED_STORE_PG_URL;
    delete process.env.UNIFIED_STORE_DASHBOARD_APPEND_MIRROR;
    mockReadDashboardFromPg.mockReset().mockResolvedValue(null);
    mockReadDashboardFromPgUngated.mockReset().mockResolvedValue(null);
    mockProbeHydration.mockReset().mockResolvedValue({ kind: 'empty' });
    mockDualWriteSync.mockClear().mockResolvedValue(undefined);
    mockDualWriteSyncChecked.mockClear().mockResolvedValue({ ok: true, reason: 'written' });
    mockIsDashboardPgPrimary.mockReset().mockReturnValue(false);

    const write = await roosyncDashboard({
      action: 'write', type: 'workspace', content: 'status initial', createIfNotExists: true,
    });
    filePath = path.join(tmpDir, 'dashboards', `${write.key}.md`);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
    delete process.env.CONDENSE_DETACHED;
    delete process.env.UNIFIED_STORE_DUAL_WRITE;
    delete process.env.UNIFIED_STORE_PG_URL;
    delete process.env.UNIFIED_STORE_DASHBOARD_APPEND_MIRROR;
    vi.clearAllMocks();
  });

  // ---- append : writer INCRÉMENTAL (frontmatter réécrit en place) ----

  it('append + PG-primaire réussi : l\'incrément porte mirrorExportAt', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);

    const result = await roosyncDashboard({ action: 'append', type: 'workspace', content: 'message mirror', tags: ['INFO'] });
    expect(result.success).toBe(true);

    const landed = await readFile(filePath, 'utf8');
    // Le message a bien atterri : sans cette garde, un test de marqueur passerait
    // sur un fichier jamais écrit.
    expect(landed).toContain('message mirror');
    expect(frontmatterOf(landed)).toMatch(/^mirrorExportAt:/m);
  });

  it('append + repli PG en échec : la moitié fichier est primaire, PAS de marqueur', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);
    mockDualWriteSyncChecked.mockResolvedValue({ ok: false, reason: 'pg down' });

    const result = await roosyncDashboard({ action: 'append', type: 'workspace', content: 'message repli', tags: ['INFO'] });
    expect(result.success).toBe(true);

    const landed = await readFile(filePath, 'utf8');
    expect(landed).toContain('message repli');
    expect(frontmatterOf(landed)).not.toMatch(/mirrorExportAt/);
  });

  // ---- update : writeDashboardFile ----

  it('update du statut + PG-primaire réussi : writeDashboardFile pose le marqueur', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);

    const result = await roosyncDashboard({
      action: 'update', type: 'workspace', section: 'status', content: 'statut mis à jour',
    });
    expect(result.success).toBe(true);

    const landed = await readFile(filePath, 'utf8');
    expect(landed).toContain('statut mis à jour');
    expect(frontmatterOf(landed)).toMatch(/^mirrorExportAt:/m);
  });

  it('update du statut + repli PG en échec : aucun marqueur', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);
    mockDualWriteSyncChecked.mockResolvedValue({ ok: false, reason: 'pg down' });

    const result = await roosyncDashboard({
      action: 'update', type: 'workspace', section: 'status', content: 'statut en repli',
    });
    expect(result.success).toBe(true);

    const landed = await readFile(filePath, 'utf8');
    expect(landed).toContain('statut en repli');
    expect(frontmatterOf(landed)).not.toMatch(/mirrorExportAt/);
  });

  // ---- crossPost : writeDashboardFile sur la cible ----

  it('crossPost + PG-primaire réussi : le fichier CIBLE porte le marqueur', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);

    const result = await roosyncDashboard({
      action: 'append', type: 'workspace', content: 'message croisé', crossPost: [{ type: 'global' }],
    });
    expect(result.success).toBe(true);

    const targetPath = path.join(tmpDir, 'dashboards', 'global.md');
    const landed = await readFile(targetPath, 'utf8');
    expect(landed).toContain('message croisé');
    expect(frontmatterOf(landed)).toMatch(/^mirrorExportAt:/m);
  });

  it('crossPost + repli PG en échec : le fichier cible reste sans marqueur', async () => {
    mockIsDashboardPgPrimary.mockReturnValue(true);
    mockDualWriteSyncChecked.mockResolvedValue({ ok: false, reason: 'pg down' });

    const result = await roosyncDashboard({
      action: 'append', type: 'workspace', content: 'message croisé en repli', crossPost: [{ type: 'global' }],
    });
    expect(result.success).toBe(true);

    const targetPath = path.join(tmpDir, 'dashboards', 'global.md');
    const landed = await readFile(targetPath, 'utf8');
    expect(landed).toContain('message croisé en repli');
    expect(frontmatterOf(landed)).not.toMatch(/mirrorExportAt/);
  });
});
