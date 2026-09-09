/**
 * #3549 Option A — tests v3 de roosync_dashboard(action: "update").
 *
 * Couvre les critères d'acceptation de l'arbitrage user (2026-09-09) :
 *   1. read / write / append / update adressent la MÊME famille de clés v3
 *      (contrôles avant/après sur les trois types global/machine/workspace).
 *   2. Création d'une section absente puis remplacement (create-or-replace),
 *      sans recommander une initialisation legacy.
 *   3. Dualité fichier + PostgreSQL : la réussite n'est jamais déduite d'une
 *      écriture fichier seule — le dual-write PG est asserté à chaque mutation.
 *   4. Sections legacy (machine/global/decisions/metrics/intercom/all)
 *      rejetées avec guidage v3, sans fallback DASHBOARD.md.
 *
 * Le service PG est mocké au boundary module (pattern dashboard-pg-store.test.ts) ;
 * le fichier GDrive est réel (tmpdir), donc les deux moitiés de la dualité sont
 * vérifiées séparément.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const {
  mockReadDashboardFromPg,
  mockDualWriteDashboardSync,
  mockRecordRooSyncActivityAsync,
} = vi.hoisted(() => ({
  mockReadDashboardFromPg: vi.fn().mockResolvedValue(null),
  mockDualWriteDashboardSync: vi.fn().mockResolvedValue(undefined),
  mockRecordRooSyncActivityAsync: vi.fn(),
}));

vi.mock('@/services/unified-store/roosync-dashboard-store', () => ({
  readDashboardFromPg: mockReadDashboardFromPg,
  dualWriteDashboardSync: mockDualWriteDashboardSync,
  dualWriteDashboardDelete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

vi.mock('../heartbeat-activity.js', () => ({
  recordRooSyncActivityAsync: mockRecordRooSyncActivityAsync,
}));

import { roosyncDashboard } from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-update-v3-');

describe('roosync_dashboard update — v3 create-or-replace (#3549 Option A)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    mockReadDashboardFromPg.mockReset().mockResolvedValue(null);
    mockDualWriteDashboardSync.mockReset().mockResolvedValue(undefined);
    mockRecordRooSyncActivityAsync.mockClear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  // === AC 1 : mêmes clés v3 pour read/write/append/update, avant/après ===

  it.each([
    { type: 'global' as const, args: {}, key: 'global', file: 'global.md' },
    { type: 'machine' as const, args: { machineId: 'test-machine' }, key: 'machine-test-machine', file: 'machine-test-machine.md' },
    { type: 'workspace' as const, args: { workspace: 'roo-ext-3549' }, key: 'workspace-roo-ext-3549', file: 'workspace-roo-ext-3549.md' },
  ])('update/write/append/read adressent la même clé v3 pour type=$type ($key)', async ({ type, args, key, file }) => {
    // Contrôle AVANT : la clé n'existe nulle part (ni read ni fichier)
    const before = await roosyncDashboard({ action: 'read', type, ...args });
    expect(before.success).toBe(false);
    await expect(readFile(path.join(tmpDir, 'dashboards', file), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // update crée la clé v3 — même famille que write/append
    const upd = await roosyncDashboard({ action: 'update', type, section: 'status', content: '# Statut v3', ...args });
    expect(upd.success).toBe(true);
    expect(upd.key).toBe(key);

    // write et append résolvent la MÊME clé et le MÊME fichier
    const w = await roosyncDashboard({ action: 'write', type, content: '# Statut via write', ...args });
    expect(w.key).toBe(key);
    const a = await roosyncDashboard({ action: 'append', type, content: 'message append', ...args });
    expect(a.key).toBe(key);

    const filePath = path.join(tmpDir, 'dashboards', file);
    const fileContent = await readFile(filePath, 'utf8');
    expect(fileContent).toContain('# Statut via write');
    expect(fileContent).toContain('message append');

    // Contrôle APRÈS : read voit la même clé
    const after = await roosyncDashboard({ action: 'read', type, ...args });
    expect(after.success).toBe(true);
    expect(after.key).toBe(key);
  });

  it('type est requis pour update (même contrainte Zod que read/write/append)', async () => {
    await expect(roosyncDashboard({
      action: 'update',
      content: 'x',
    })).rejects.toThrow(/type is required/);
  });

  // === AC 2 : création d'une section absente puis remplacement ===

  it('crée le dashboard absent (createIfNotExists par défaut) puis remplace son statut', async () => {
    // Absent avant
    const before = await roosyncDashboard({ action: 'read', type: 'workspace', workspace: 'roo-ext-3549' });
    expect(before.success).toBe(false);

    // Création par update — le contenu fourni EST la section créée
    const created = await roosyncDashboard({
      action: 'update',
      type: 'workspace',
      workspace: 'roo-ext-3549',
      section: 'status',
      content: '# Première version',
    });
    expect(created.success).toBe(true);
    expect(created.action).toBe('update');
    expect(created.message).toContain("mise à jour");

    // Remplacement
    const replaced = await roosyncDashboard({
      action: 'update',
      type: 'workspace',
      workspace: 'roo-ext-3549',
      section: 'status',
      content: '# Deuxième version',
      mode: 'replace',
    });
    expect(replaced.success).toBe(true);

    const filePath = path.join(tmpDir, 'dashboards', 'workspace-roo-ext-3549.md');
    const fileContent = await readFile(filePath, 'utf8');
    expect(fileContent).toContain('# Deuxième version');
    expect(fileContent).not.toContain('# Première version');

    // Aucune recommandation d'initialisation legacy dans les messages de succès
    expect(JSON.stringify(created)).not.toMatch(/roosync_init|DASHBOARD\.md/);
  });

  it('section absente par défaut = status (pas de section requise)', async () => {
    const r = await roosyncDashboard({
      action: 'update',
      type: 'workspace',
      workspace: 'roo-ext-3549',
      content: 'Sans section explicite',
    });
    expect(r.success).toBe(true);
    const fileContent = await readFile(path.join(tmpDir, 'dashboards', 'workspace-roo-ext-3549.md'), 'utf8');
    expect(fileContent).toContain('Sans section explicite');
  });

  it('modes append et prepend fusionnent avec le statut existant', async () => {
    const base = { type: 'workspace' as const, workspace: 'roo-ext-3549' };
    await roosyncDashboard({ action: 'update', ...base, content: 'LIGNE-A' });

    await roosyncDashboard({ action: 'update', ...base, content: 'LIGNE-B', mode: 'append' });
    let file = await readFile(path.join(tmpDir, 'dashboards', 'workspace-roo-ext-3549.md'), 'utf8');
    expect(file.indexOf('LIGNE-A')).toBeLessThan(file.indexOf('LIGNE-B'));

    await roosyncDashboard({ action: 'update', ...base, content: 'LIGNE-0', mode: 'prepend' });
    file = await readFile(path.join(tmpDir, 'dashboards', 'workspace-roo-ext-3549.md'), 'utf8');
    expect(file.indexOf('LIGNE-0')).toBeLessThan(file.indexOf('LIGNE-A'));
    expect(file.indexOf('LIGNE-A')).toBeLessThan(file.indexOf('LIGNE-B'));
  });

  it('createIfNotExists=false sur clé absente → success:false sans création', async () => {
    const r = await roosyncDashboard({
      action: 'update',
      type: 'workspace',
      workspace: 'roo-ext-3549',
      content: 'x',
      createIfNotExists: false,
    });
    expect(r.success).toBe(false);
    expect(r.message).toContain("introuvable et createIfNotExists=false");
    await expect(readFile(path.join(tmpDir, 'dashboards', 'workspace-roo-ext-3549.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it("l'update ne détruit pas l'intercom existant (read-modify-write sous verrou)", async () => {
    await roosyncDashboard({ action: 'append', type: 'workspace', workspace: 'roo-ext-3549', content: 'message à préserver' });
    const r = await roosyncDashboard({ action: 'update', type: 'workspace', workspace: 'roo-ext-3549', content: '# Statut neuf' });
    expect(r.success).toBe(true);
    const file = await readFile(path.join(tmpDir, 'dashboards', 'workspace-roo-ext-3549.md'), 'utf8');
    expect(file).toContain('# Statut neuf');
    expect(file).toContain('message à préserver');
  });

  // === AC 3 : dualité fichier + PostgreSQL ===

  it('chaque update écrit le fichier ET dual-write vers PG avec le même contenu', async () => {
    const args = { type: 'workspace' as const, workspace: 'roo-ext-3549' };
    await roosyncDashboard({ action: 'update', ...args, content: '# V1' });
    await roosyncDashboard({ action: 'update', ...args, content: '# V2', mode: 'append' });

    // Un dual-write PG par writeDashboardFile
    expect(mockDualWriteDashboardSync).toHaveBeenCalledTimes(2);

    // Le payload PG et le fichier portent le MÊME état (pas de succès déduit du fichier seul)
    const lastSynced = mockDualWriteDashboardSync.mock.calls.at(-1)![0];
    expect(lastSynced.key).toBe('workspace-roo-ext-3549');
    expect(lastSynced.status.markdown).toBe('# V1\n\n# V2');
    const file = await readFile(path.join(tmpDir, 'dashboards', 'workspace-roo-ext-3549.md'), 'utf8');
    expect(file).toContain('# V1');
    expect(file).toContain('# V2');
  });

  it('update enregistre l’activité heartbeat (parité write, #1791)', async () => {
    await roosyncDashboard({ action: 'update', type: 'global', content: '# G' });
    expect(mockRecordRooSyncActivityAsync).toHaveBeenCalledWith(
      'dashboard-write',
      expect.objectContaining({ key: 'global', type: 'global', action: 'update' })
    );
  });

  // === AC 4 : sections legacy rejetées avec guidage v3, sans fallback ===

  it.each(['machine', 'global', 'decisions', 'metrics'] as const)(
    'section legacy %s rejetée avec guidage v3 — aucune écriture, aucune mention roosync_init',
    async (section) => {
      const err = await roosyncDashboard({
        action: 'update',
        type: 'workspace',
        workspace: 'roo-ext-3549',
        section,
        content: 'x',
      }).then(
        () => { throw new Error('update legacy section devrait rejeter'); },
        (e: Error) => e
      );
      expect(err.message).toMatch(/store v3/);
      expect(err.message).toMatch(/section='status'/);
      // Pas de recommandation d'initialisation legacy
      expect(err.message).not.toMatch(/roosync_init/);
      // Aucun fichier créé par l'appel rejeté
      await expect(readFile(path.join(tmpDir, 'dashboards', 'workspace-roo-ext-3549.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it("section intercom rejetée : l'intercom v3 est append-only (action=append)", async () => {
    await expect(roosyncDashboard({
      action: 'update',
      type: 'workspace',
      workspace: 'roo-ext-3549',
      section: 'intercom',
      content: 'x',
    })).rejects.toThrow(/append-only/);
  });

  it('content est requis', async () => {
    await expect(roosyncDashboard({
      action: 'update',
      type: 'global',
      section: 'status',
    })).rejects.toThrow('content est requis pour action=update');
  });

  it("l'erreur absent+createIfNotExists=false ne recommande pas d'initialisation legacy", async () => {
    const r = await roosyncDashboard({
      action: 'update',
      type: 'workspace',
      workspace: 'roo-ext-3549',
      content: 'x',
      createIfNotExists: false,
    });
    expect(r.success).toBe(false);
    expect(r.message).not.toMatch(/roosync_init/);
  });
});
