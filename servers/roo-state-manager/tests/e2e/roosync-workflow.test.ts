/**
 * Tests E2E RooSync - Workflows complets (#2639 lot 2, réparation + renforcement)
 *
 * Contexte de la réparation (mesuré firsthand 20/10) : comme roosync-error-handling,
 * ce fichier tournait contre le stub global de jest.setup.js vidé par mockReset —
 * les parcours « detect → approve → apply » n'exerçaient rien (catch-swallow,
 * expect().toBeDefined(), un test zéro assertion). Il fait maintenant tourner le
 * VRAI service sur des fixtures de fichiers partagés (roadmap + dashboard JSON)
 * servies par un mock fs CONSCIENT DU CHEMIN (clé = basename du fichier).
 *
 * Contrats réels vérifiés ici (lus dans le source, observés au run) :
 * - getStatus dérive {machineId, overallStatus, lastSync, pendingDecisions,
 *   diffsCount} de sync-dashboard.json (BaselineManager.getStatus) et
 *   AUTO-ENREGISTRE la machine courante si elle en est absente.
 * - loadPendingDecisions = statut pending (filterDecisionsByStatus) ∩ machines
 *   cibles contenant notre machine | 'all' | vide (filterDecisionsByMachine).
 * - executeDecision en dryRun : approuve dans la roadmap, exécute PowerShell,
 *   puis RESTAURE la roadmap d'origine (writeFile du backup).
 * - restoreFromRollbackPoint rend un échec PROPRE (success:false + error),
 *   jamais un crash, quand aucun répertoire rollback n'existe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { basename } from 'path';

// Le vrai service, pas le stub global (jest.setup.js) vidé par mockReset.
vi.unmock('../../src/services/RooSyncService.js');

import { RooSyncService } from '../../src/services/RooSyncService.js';
import * as fs from 'fs';

// PowerShellExecutor reste simulé : fabrique locale qui enregistre ses instances
// pour spier CELLE du service (l'exécution passe par service.executeDecision).
vi.mock('../../src/services/PowerShellExecutor.js', () => {
  class PowerShellExecutor {
    static instances: PowerShellExecutor[] = [];
    executeScript: (...args: unknown[]) => Promise<unknown> = async () => ({
      success: true,
      stdout: '',
      stderr: '',
      exitCode: 0,
      executionTime: 1,
    });
    constructor() {
      PowerShellExecutor.instances.push(this);
    }
    static lastInstance(): PowerShellExecutor {
      const last = PowerShellExecutor.instances[PowerShellExecutor.instances.length - 1];
      if (!last) throw new Error('Aucune instance PowerShellExecutor (mock) construite');
      return last;
    }
  }
  return { PowerShellExecutor };
});

// fs simulé, conscient du chemin : chaque fixture est servie par basename.
// Un fichier sans fixture = absent (existsSync false, lectures ENOENT).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => { throw new Error('ENOENT (simulé)'); }),
    statSync: vi.fn(() => { throw new Error('ENOENT (simulé)'); }),
    mkdirSync: vi.fn(() => undefined),
    promises: {
      ...actual.promises,
      access: vi.fn(async () => { throw new Error('ENOENT (simulé)'); }),
      readFile: vi.fn(async () => { throw new Error('ENOENT (simulé)'); }),
      readdir: vi.fn(async () => [] as string[]),
      writeFile: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
      copyFile: vi.fn(async () => undefined),
      stat: vi.fn(async () => { throw new Error('ENOENT (simulé)'); }),
    },
  };
});

/** Decision block markdown (format parser : **ID:** `...` etc.). */
const decisionBlock = (fields: Record<string, string>): string =>
  [
    '<!-- DECISION_BLOCK_START -->',
    `**ID:** \`${fields.id}\``,
    `**Titre:** ${fields.titre}`,
    `**Statut:** ${fields.statut}`,
    `**Type:** ${fields.type}`,
    `**Chemin:** \`${fields.chemin}\``,
    `**Machine Source:** ${fields.source}`,
    `**Machines Cibles:** ${fields.cibles}`,
    '<!-- DECISION_BLOCK_END -->',
  ].join('\n');

/** Roadmap : 3 décisions — seule DEC-E2E-001 est pending ET ciblée sur nous. */
const ROADMAP = [
  '# Sync Roadmap (fixture e2e workflow)',
  decisionBlock({
    id: 'DEC-E2E-001', titre: 'Sync settings', statut: 'pending',
    type: 'config-sync', chemin: 'settings.json',
    source: 'myia-ai-01', cibles: 'test-machine-001',
  }),
  decisionBlock({
    id: 'DEC-E2E-002', titre: 'Sync autre machine', statut: 'pending',
    type: 'config-sync', chemin: 'settings.json',
    source: 'myia-ai-01', cibles: 'myia-po-2024',
  }),
  decisionBlock({
    id: 'DEC-E2E-003', titre: 'Déjà appliquée', statut: 'approved',
    type: 'config-sync', chemin: 'modes.json',
    source: 'myia-ai-01', cibles: 'test-machine-001',
  }),
].join('\n\n');

/** Dashboard partagé (sync-dashboard.json) avec notre machine présente. */
const DASHBOARD = JSON.stringify({
  overallStatus: 'healthy',
  machines: {
    'test-machine-001': {
      lastSync: '2026-10-20T08:30:00.000Z',
      status: 'synced',
      diffsCount: 1,
      pendingDecisions: 2,
    },
    'myia-ai-01': {
      lastSync: '2026-10-20T08:00:00.000Z',
      status: 'synced',
      diffsCount: 0,
      pendingDecisions: 0,
    },
  },
}, null, 2);

/** Dashboard sans notre machine (cas auto-enregistrement). */
const DASHBOARD_FOREIGN = JSON.stringify({
  overallStatus: 'degraded',
  machines: {
    'myia-ai-01': {
      lastSync: '2026-10-20T08:00:00.000Z',
      status: 'synced',
      diffsCount: 0,
      pendingDecisions: 0,
    },
  },
}, null, 2);

describe('RooSync E2E Workflow', () => {
  let service: RooSyncService;

  const armFiles = (files: Record<string, string>) => {
    const has = (p: unknown) => basename(String(p)) in files;
    vi.mocked(fs.existsSync).mockImplementation(has);
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const content = files[basename(String(p))];
      if (content === undefined) throw new Error(`ENOENT (simulé): ${String(p)}`);
      return content;
    });
    vi.mocked(fs.promises.access).mockImplementation(async (p) => {
      if (!has(p)) throw new Error(`ENOENT (simulé): ${String(p)}`);
    });
    vi.mocked(fs.promises.readFile).mockImplementation(async (p) => {
      const content = files[basename(String(p))];
      if (content === undefined) throw new Error(`ENOENT (simulé): ${String(p)}`);
      return content;
    });
  };

  const lastExecutor = async () => {
    const { PowerShellExecutor } = await import('../../src/services/PowerShellExecutor.js');
    return (PowerShellExecutor as unknown as {
      lastInstance: () => { executeScript: (...a: unknown[]) => Promise<unknown> };
    }).lastInstance();
  };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.ROOSYNC_SHARED_PATH = '/tmp/roosync-test';
    process.env.ROOSYNC_MACHINE_ID = 'test-machine-001';
    delete process.env.SHARED_STATE_PATH;
    vi.mocked(fs.existsSync).mockImplementation(() => false);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT (simulé)'); });
    vi.mocked(fs.promises.access).mockImplementation(async () => { throw new Error('ENOENT (simulé)'); });
    vi.mocked(fs.promises.readFile).mockImplementation(async () => { throw new Error('ENOENT (simulé)'); });
    vi.mocked(fs.promises.writeFile).mockImplementation(async () => undefined);
    RooSyncService.resetInstance();
    try {
      service = RooSyncService.getInstance();
    } catch {
      service = undefined as unknown as RooSyncService;
    }
  });

  afterEach(() => {
    RooSyncService.resetInstance();
    vi.restoreAllMocks();
  });

  describe('Workflow 1 : détecter → approuver → appliquer', () => {
    it('getStatus rend l’état exact dérivé du dashboard partagé', async () => {
      armFiles({ 'sync-roadmap.md': ROADMAP, 'sync-dashboard.json': DASHBOARD });
      const status = await service.getStatus();
      expect(status).toEqual({
        machineId: 'test-machine-001',
        overallStatus: 'healthy',
        lastSync: '2026-10-20T08:30:00.000Z',
        pendingDecisions: 2,
        diffsCount: 1,
      });
    }, 30000);

    it('loadPendingDecisions ne rend QUE les décisions pending ciblées sur cette machine', async () => {
      armFiles({ 'sync-roadmap.md': ROADMAP });
      const pending = await service.loadPendingDecisions();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        id: 'DEC-E2E-001',
        status: 'pending',
        title: 'Sync settings',
      });
      // DEC-E2E-002 (autre machine) et DEC-E2E-003 (approved) sont exclues.
      expect(pending.map((d) => d.id)).toEqual(['DEC-E2E-001']);
    }, 30000);

    it('executeDecision en dryRun réussit, appelle PowerShell et restaure la roadmap', async () => {
      armFiles({ 'sync-roadmap.md': ROADMAP, 'sync-dashboard.json': DASHBOARD });
      const spy = vi.spyOn(await lastExecutor(), 'executeScript').mockResolvedValue({
        stdout: 'Apply-Decisions terminé',
        stderr: '',
        exitCode: 0,
        success: true,
        executionTime: 12,
      } as never);

      const result = await service.executeDecision('DEC-E2E-001', { dryRun: true });

      expect(result.success).toBe(true);
      expect(result.executionTime).toBeGreaterThan(0);
      expect(Array.isArray(result.logs)).toBe(true);
      expect(Object.keys(result.changes).sort())
        .toEqual(['filesCreated', 'filesDeleted', 'filesModified']);
      expect(spy).toHaveBeenCalledWith(
        'src/sync-manager.ps1',
        ['-Action', 'Apply-Decisions'],
        expect.objectContaining({ timeout: 60000 })
      );

      // dryRun = aucun effet persistant : la roadmap d'origine (statut pending)
      // est réécrite telle quelle après exécution.
      const roadmapWrites = vi.mocked(fs.promises.writeFile).mock.calls
        .filter(([path]) => String(path).includes('sync-roadmap.md'))
        .map(([, content]) => String(content));
      expect(roadmapWrites.length).toBeGreaterThan(0);
      expect(roadmapWrites.some((c) => c.includes('**Statut:** pending'))).toBe(true);
    }, 30000);
  });

  describe('Workflow 2 : appliquer → rollback', () => {
    it('restoreFromRollbackPoint rend un échec propre sans répertoire rollback', async () => {
      armFiles({ 'sync-roadmap.md': ROADMAP });
      const result = await service.restoreFromRollbackPoint('DEC_SANS_ROLLBACK');
      expect(result.success).toBe(false);
      expect(result.restoredFiles).toEqual([]);
      expect(result.error).toBe('No rollback directory found');
      expect(result.logs.some((l) => l.includes('Aucun répertoire rollback'))).toBe(true);
    }, 30000);

    it('createRollbackPoint réussit quand l’environnement partagé est disponible', async () => {
      armFiles({ 'sync-roadmap.md': ROADMAP });
      await expect(service.createRollbackPoint('DEC-E2E-001')).resolves.toBeUndefined();
    }, 30000);
  });

  describe('Intégration Dashboard', () => {
    it('loadDashboard rend le contenu parsé du fichier partagé', async () => {
      armFiles({ 'sync-dashboard.json': DASHBOARD });
      const dashboard = await service.loadDashboard();
      expect(dashboard.overallStatus).toBe('healthy');
      expect(Object.keys(dashboard.machines).sort())
        .toEqual(['myia-ai-01', 'test-machine-001']);
      expect(dashboard.machines['test-machine-001']).toMatchObject({
        status: 'synced',
        diffsCount: 1,
        pendingDecisions: 2,
      });
    }, 30000);

    it('auto-enregistre la machine courante absente du dashboard', async () => {
      armFiles({ 'sync-dashboard.json': DASHBOARD_FOREIGN });
      const status = await service.getStatus();
      expect(status.machineId).toBe('test-machine-001');
      expect(status.overallStatus).toBe('degraded');
      expect(status.pendingDecisions).toBe(0);
      expect(status.diffsCount).toBe(0);
      expect(typeof status.lastSync).toBe('string');
      expect(status.lastSync.length).toBeGreaterThan(0);
    }, 30000);
  });

  describe('Performance', () => {
    it('charge les décisions en moins de 5 secondes', async () => {
      armFiles({ 'sync-roadmap.md': ROADMAP });
      const start = Date.now();
      const decisions = await service.loadDecisions();
      const duration = Date.now() - start;
      expect(decisions).toHaveLength(3);
      expect(duration).toBeLessThan(5000);
    }, 30000);
  });
});
