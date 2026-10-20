/**
 * Tests E2E RooSync - Gestion des erreurs (#2639 lot 2, réparation + renforcement)
 *
 * Contexte de la réparation (mesuré firsthand 20/10) : sous vitest.config.ts, le
 * module RooSyncService est remplacé par le stub global de tests/setup/jest.setup.js
 * (sans executeDecision/getStatus/createRollbackPoint) dont les implémentations sont
 * de toute façon effacées par `mockReset: true` — les anciens tests n'exerçaient plus
 * rien (8/8 échecs ou passes faibles). Ce fichier fait maintenant tourner le VRAI
 * service contre une simulation fs possédée localement, ré-armée dans beforeEach
 * (résistante au reset), avec des assertions de valeur/forme/contenu.
 *
 * Contrats réels vérifiés ici (lus dans le source, observés au run) :
 * - loadDecisions LANCE RooSyncServiceError FILE_NOT_FOUND quand la roadmap est
 *   absente (SyncDecisionManager.checkFileExists, fs.promises.access) — l'ancien
 *   « rend un tableau, jamais un crash » était une fiction du stub.
 * - parseRoadmapMarkdown rend [] pour du contenu sans blocs, et LANCE
 *   RooSyncParseError si la lecture échoue (guard anti-undefined inclus).
 * - executeDecision convertit TOUTE erreur interne en { success: false, error }
 *   (try/catch SyncDecisionManager) — y compris roadmap absente et timeout PowerShell.
 * - isDegraded() n'est vrai qu'APRÈS un échec d'init (getInstance a échoué).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Le vrai service, pas le stub global (jest.setup.js) vidé par mockReset.
vi.unmock('../../src/services/RooSyncService.js');

import { RooSyncService, RooSyncServiceError } from '../../src/services/RooSyncService.js';
import { RooSyncParseError } from '../../src/utils/roosync-parsers.js';
import * as fs from 'fs';

// PowerShellExecutor reste simulé (jamais de vrai powershell.exe dans un test) :
// fabrique locale qui enregistre ses instances pour que les tests spient CELLE
// du service (l'exécution passe par service.executeDecision, pas par le mock nu).
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

// fs simulé : fabrique locale (vient AVANT les imports du service dans le graphe),
// implémentations armées dans beforeEach — mockReset n'y touche plus après armement.
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

/** Roadmap valide avec UNE décision pending ciblant cette machine. */
const ROADMAP_WITH_DECISION = [
  '# Sync Roadmap (fixture e2e)',
  '',
  '<!-- DECISION_BLOCK_START -->',
  '**ID:** `DEC-E2E-001`',
  '**Titre:** Décision de test e2e',
  '**Statut:** pending',
  '**Type:** config-sync',
  '**Chemin:** `settings.json`',
  '**Machine Source:** myia-ai-01',
  '**Machines Cibles:** test-machine-001',
  '<!-- DECISION_BLOCK_END -->',
  '',
].join('\n');

/** Roadmap valide sans aucune décision. */
const ROADMAP_EMPTY = '# Sync Roadmap (fixture e2e, vide)\n';

describe('RooSync E2E Error Handling', () => {
  let service: RooSyncService;

  // Environnement RooSync absent : tout fichier manque, toute lecture échoue,
  // mais mkdir « réussit » (le chemin existe, il est juste vide).
  const armMissingFs = () => {
    vi.mocked(fs.existsSync).mockImplementation(() => false);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT (simulé)'); });
    vi.mocked(fs.statSync).mockImplementation(() => { throw new Error('ENOENT (simulé)'); });
    vi.mocked(fs.promises.access).mockImplementation(async () => { throw new Error('ENOENT (simulé)'); });
    vi.mocked(fs.promises.readFile).mockImplementation(async () => { throw new Error('ENOENT (simulé)'); });
    vi.mocked(fs.promises.writeFile).mockImplementation(async () => undefined);
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
  };

  // Roadmap présente et lisible : access + lectures (sync et promises) servent le contenu.
  const armRoadmap = (content: string) => {
    vi.mocked(fs.existsSync).mockImplementation(() => true);
    vi.mocked(fs.promises.access).mockImplementation(async () => undefined);
    vi.mocked(fs.readFileSync).mockImplementation(() => content);
    vi.mocked(fs.promises.readFile).mockImplementation(async () => content);
  };

  beforeEach(() => {
    // NODE_ENV=test rend loadRooSyncConfig exigeant : ces variables sont REQUIRED.
    process.env.NODE_ENV = 'test';
    process.env.ROOSYNC_SHARED_PATH = '/tmp/roosync-test';
    process.env.ROOSYNC_MACHINE_ID = 'test-machine-001';
    delete process.env.SHARED_STATE_PATH;
    armMissingFs();
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

  describe('Décisions invalides', () => {
    it('getDecision rend la décision réelle parsée depuis la roadmap, et null pour un ID inconnu', async () => {
      armRoadmap(ROADMAP_WITH_DECISION);
      const found = await service.getDecision('DEC-E2E-001');
      expect(found).toMatchObject({ id: 'DEC-E2E-001' });
      expect(found?.status).toBe('pending');

      const missing = await service.getDecision('ID_QUI_NEXISTE_PAS_12345');
      expect(missing).toBeNull();
    }, 30000);

    it('signale l’échec pour un ID de décision null', async () => {
      const result = await service.executeDecision(null as unknown as string);
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    }, 30000);

    it('signale l’échec pour un ID avec caractères spéciaux sans l’exécuter', async () => {
      const result = await service.executeDecision('<script>alert("test")</script>');
      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    }, 30000);
  });

  describe('Configuration manquante', () => {
    it('passe en mode dégradé quand le chemin partagé est inaccessible', () => {
      // Hors NODE_ENV=test, loadRooSyncConfig vérifie que le chemin partagé EXISTE
      // (roosync-config.ts:135, existsSync) : chemin absent → RooSyncConfigError →
      // constructeur échoue → état dégradé CONSIGNÉ (isDegraded/getInitError),
      // jamais de faux service en mémoire (#2017).
      delete process.env.NODE_ENV;
      RooSyncService.resetInstance();
      try {
        expect(() => RooSyncService.getInstance()).toThrow(RooSyncServiceError);
        expect(RooSyncService.isDegraded()).toBe(true);
        expect(RooSyncService.getInitError()).toBeInstanceOf(Error);
      } finally {
        process.env.NODE_ENV = 'test';
      }
    }, 30000);

    it('refuse une seconde instance pendant le backoff après un échec d’init', () => {
      // Forcer un échec d'initialisation : variables requises absentes.
      delete process.env.ROOSYNC_SHARED_PATH;
      delete process.env.ROOSYNC_MACHINE_ID;
      RooSyncService.resetInstance();
      expect(() => RooSyncService.getInstance()).toThrow(RooSyncServiceError);

      // #2017 : pendant le backoff, getInstance explique le problème et le délai.
      let message = '';
      try {
        RooSyncService.getInstance();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/RooSync non disponible/);
      expect(message).toMatch(/réessai automatique/i);
    }, 30000);
  });

  describe('PowerShell', () => {
    it('signale l’échec pour un script inexistant', async () => {
      const result = await service.executeDecision('nonexistent-script.ps1');
      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    }, 10000);

    it('propage l’échec exit!=0 de PowerShell avec son stderr (via le service)', async () => {
      armRoadmap(ROADMAP_WITH_DECISION);
      const { PowerShellExecutor } = await import('../../src/services/PowerShellExecutor.js');
      const executor = (PowerShellExecutor as unknown as {
        lastInstance: () => { executeScript: (...a: unknown[]) => Promise<unknown> };
      }).lastInstance();
      vi.spyOn(executor, 'executeScript').mockResolvedValue({
        stdout: '',
        stderr: 'Simulated PS failure',
        exitCode: 1,
        success: false,
        executionTime: 5,
      } as never);

      const result = await service.executeDecision('DEC-E2E-001');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Simulated PS failure');
      expect(result.changes).toEqual({
        filesModified: [],
        filesCreated: [],
        filesDeleted: [],
      });
      expect(Array.isArray(result.logs)).toBe(true);
    }, 30000);

    it('convertit un timeout PowerShell en échec propre avec sa cause', async () => {
      armRoadmap(ROADMAP_WITH_DECISION);
      const { PowerShellExecutor } = await import('../../src/services/PowerShellExecutor.js');
      const executor = (PowerShellExecutor as unknown as {
        lastInstance: () => { executeScript: (...a: unknown[]) => Promise<unknown> };
      }).lastInstance();
      vi.spyOn(executor, 'executeScript').mockRejectedValue(
        new Error('Script execution timed out after 60000ms')
      );

      const result = await service.executeDecision('DEC-E2E-001');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timed out/i);
    }, 30000);

    it('appelle réellement la couche PowerShell avec le script et le timeout attendus', async () => {
      armRoadmap(ROADMAP_WITH_DECISION);
      const { PowerShellExecutor } = await import('../../src/services/PowerShellExecutor.js');
      const executor = (PowerShellExecutor as unknown as {
        lastInstance: () => { executeScript: (...a: unknown[]) => Promise<unknown> };
      }).lastInstance();
      const spy = vi.spyOn(executor, 'executeScript').mockResolvedValue({
        stdout: 'OK',
        stderr: '',
        exitCode: 0,
        success: true,
        executionTime: 3,
      } as never);

      const result = await service.executeDecision('DEC-E2E-001');
      expect(result.success).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        'src/sync-manager.ps1',
        ['-Action', 'Apply-Decisions'],
        expect.objectContaining({ timeout: 60000 })
      );
    }, 30000);
  });

  describe('Rollback', () => {
    it('échoue proprement sur un rollback sans environnement RooSync', async () => {
      // Chemin partagé illisible : l'écriture du point de rollback échoue —
      // jamais de faux succès silencieux.
      armRoadmap(ROADMAP_WITH_DECISION);
      vi.mocked(fs.promises.writeFile).mockImplementation(async () => {
        throw new Error('EACCES: shared path read-only (simulé)');
      });
      await expect(service.createRollbackPoint('DEC-E2E-001'))
        .rejects.toThrowError(/EACCES/);
    }, 30000);
  });

  describe('Singleton et reset', () => {
    it('deux getInstance renvoient la MÊME instance', () => {
      const service1 = RooSyncService.getInstance();
      const service2 = RooSyncService.getInstance();
      expect(service1).toBe(service2);
      expect(service1).toBeInstanceOf(RooSyncService);
    }, 30000);

    it('resetInstance force une NOUVELLE instance', () => {
      const service1 = RooSyncService.getInstance();
      RooSyncService.resetInstance();
      const service2 = RooSyncService.getInstance();
      expect(service2).toBeInstanceOf(RooSyncService);
      expect(service1).not.toBe(service2);
    }, 30000);
  });

  describe('Cache', () => {
    it('sert le cache sans re-lire, puis re-lit après clearCache', async () => {
      armRoadmap(ROADMAP_EMPTY);
      const first = await service.loadDecisions();
      expect(first).toEqual([]);
      const readsAfterFirst = vi.mocked(fs.readFileSync).mock.calls.length;

      const second = await service.loadDecisions();
      expect(second).toEqual(first);
      expect(vi.mocked(fs.readFileSync).mock.calls.length).toBe(readsAfterFirst);

      service.clearCache();
      await service.loadDecisions();
      expect(vi.mocked(fs.readFileSync).mock.calls.length).toBeGreaterThan(readsAfterFirst);
    }, 30000);
  });

  describe('Validation des données', () => {
    it('échoue avec l’erreur typée FILE_NOT_FOUND quand la roadmap est absente', async () => {
      // Contrat réel : l'absence de roadmap est une ERREUR typée, pas un tableau vide.
      await expect(service.loadDecisions()).rejects.toThrow(RooSyncServiceError);
      await expect(service.loadDecisions()).rejects.toThrow(
        /Fichier RooSync introuvable: sync-roadmap\.md/
      );
    }, 30000);

    it('rend un tableau vide pour un contenu roadmap sans aucun bloc de décision', async () => {
      armRoadmap('# Titre seul, pas de bloc\n\ngarbage \x00 not-a-roadmap');
      const decisions = await service.loadDecisions();
      expect(decisions).toEqual([]);
    }, 30000);

    it('échoue avec RooSyncParseError quand la roadmap est illisible', async () => {
      // Le fichier existe mais la lecture échoue (corruption) : erreur typée du parser.
      vi.mocked(fs.existsSync).mockImplementation(() => true);
      vi.mocked(fs.promises.access).mockImplementation(async () => undefined);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('EIO: corruption disque (simulé)');
      });
      await expect(service.loadDecisions()).rejects.toThrow(RooSyncParseError);
      await expect(service.loadDecisions()).rejects.toThrow(/Erreur lors du parsing/);
    }, 30000);
  });

  describe('Configuration exposée', () => {
    it('getConfig rend exactement l’environnement fourni', () => {
      const config = service.getConfig();
      expect(config.sharedPath).toBe('/tmp/roosync-test');
      expect(config.machineId).toBe('test-machine-001');
    }, 30000);
  });
});
