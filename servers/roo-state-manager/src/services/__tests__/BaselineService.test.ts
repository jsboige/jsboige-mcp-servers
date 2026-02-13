/**
 * BaselineService.test.ts - Tests unitaires pour le service BaselineService
 *
 * Couverture exhaustive du service central d'architecture baseline-driven
 * de RooSync v2.1, incluant le constructeur, le chargement/sauvegarde de
 * baselines, la comparaison, la creation de decisions de synchronisation,
 * l'application de decisions et la gestion d'etat.
 *
 * Note: vitest.config.ts utilise mockReset:true et restoreMocks:true,
 * ce qui detruit les implementations de vi.fn() entre chaque test.
 * Les mock instances partagees sont donc re-initialisees dans beforeEach.
 *
 * @module BaselineService.test
 * @version 1.0.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Instances de mock stables (vi.hoisted pour garantir la disponibilite dans vi.mock) ---

const {
  mockBaselineLoaderInstance,
  mockDifferenceDetectorInstance,
  mockChangeApplierInstance,
  mockConfigValidatorInstance,
} = vi.hoisted(() => ({
  mockBaselineLoaderInstance: {
    loadBaseline: vi.fn(),
    readBaselineFile: vi.fn(),
    transformBaselineForDiffDetector: vi.fn(),
  },
  mockDifferenceDetectorInstance: {
    calculateSummary: vi.fn(),
    createSyncDecisions: vi.fn(),
  },
  mockChangeApplierInstance: {
    applyDecision: vi.fn(),
  },
  mockConfigValidatorInstance: {
    validateBaselineConfig: vi.fn().mockReturnValue(true),
    validateBaselineFileConfig: vi.fn().mockReturnValue(true),
    ensureValidBaselineConfig: vi.fn(),
    ensureValidBaselineFileConfig: vi.fn(),
  },
}));

// --- Mocks des modules externes ---

vi.mock('fs', () => {
  return {
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      readdir: vi.fn(),
      stat: vi.fn(),
    },
    existsSync: vi.fn(),
    copyFileSync: vi.fn(),
  };
});

vi.mock('../baseline/BaselineLoader.js', () => ({
  BaselineLoader: vi.fn().mockImplementation(() => mockBaselineLoaderInstance),
}));

vi.mock('../baseline/DifferenceDetector.js', () => ({
  DifferenceDetector: vi.fn().mockImplementation(() => mockDifferenceDetectorInstance),
}));

vi.mock('../baseline/ChangeApplier.js', () => ({
  ChangeApplier: vi.fn().mockImplementation(() => mockChangeApplierInstance),
}));

vi.mock('../baseline/ConfigValidator.js', () => ({
  ConfigValidator: vi.fn().mockImplementation(() => mockConfigValidatorInstance),
}));

// --- Imports apres les mocks ---

import { promises as fs } from 'fs';
import { existsSync, copyFileSync } from 'fs';
import { BaselineService } from '../BaselineService.js';
import { BaselineLoader } from '../baseline/BaselineLoader.js';
import { DifferenceDetector } from '../baseline/DifferenceDetector.js';
import { ChangeApplier } from '../baseline/ChangeApplier.js';
import { ConfigValidator } from '../baseline/ConfigValidator.js';
import {
  BaselineConfig,
  BaselineFileConfig,
  BaselineComparisonReport,
  BaselineDifference,
  SyncDecision,
  DecisionApplicationResult,
  BaselineServiceError,
  BaselineServiceErrorCode,
  IConfigService,
  IInventoryCollector,
  IDiffDetector,
  MachineInventory,
  BaselineServiceConfig,
} from '../../types/baseline.js';

// --- Helpers ---

function createMockConfigService(overrides: Partial<BaselineServiceConfig> = {}): IConfigService {
  const config: BaselineServiceConfig = {
    baselinePath: '/mock/shared/sync-config.ref.json',
    roadmapPath: '/mock/shared/sync-roadmap.md',
    cacheEnabled: true,
    cacheTTL: 3600,
    logLevel: 'ERROR',
    ...overrides,
  };
  return {
    getBaselineServiceConfig: vi.fn().mockReturnValue(config),
    getSharedStatePath: vi.fn().mockReturnValue('/mock/shared'),
    getConfigVersion: vi.fn().mockResolvedValue('2.1.0'),
  };
}

function createMockInventoryCollector(): IInventoryCollector {
  return { collectInventory: vi.fn() };
}

function createMockDiffDetector(): IDiffDetector {
  return { compareBaselineWithMachine: vi.fn() };
}

function createMockBaselineFileConfig(overrides: Partial<BaselineFileConfig> = {}): BaselineFileConfig {
  const now = new Date().toISOString();
  return {
    version: '2.1.0', baselineId: 'baseline-test-001', timestamp: now, lastUpdated: now,
    machineId: 'test-machine', autoSync: false, conflictStrategy: 'manual', logLevel: 'info',
    sharedStatePath: '/mock/shared',
    machines: [{
      id: 'test-machine', name: 'Test Machine', hostname: 'test-host', os: 'Windows',
      architecture: 'x64', lastSeen: now,
      roo: { modes: ['code', 'architect'], mcpServers: [], sdddSpecs: [] },
      hardware: { cpu: { cores: 8, threads: 16 }, memory: { total: 32768 } },
      software: { node: '20.0.0', python: '3.11.0' },
    }],
    syncTargets: [], syncPaths: [], decisions: [], messages: [],
    ...overrides,
  };
}

function createMockBaselineConfig(overrides: Partial<BaselineConfig> = {}): BaselineConfig {
  return {
    machineId: 'test-machine',
    config: {
      roo: { modes: ['code', 'architect'], mcpSettings: {}, userSettings: {} },
      hardware: { cpu: { model: 'Test CPU', cores: 8, threads: 16 }, memory: { total: 32768 }, disks: [], gpu: 'Test GPU' },
      software: { powershell: '7.0', node: '20.0.0', python: '3.11.0' },
      system: { os: 'Windows', architecture: 'x64' },
    },
    lastUpdated: new Date().toISOString(), version: '2.1.0',
    ...overrides,
  };
}

function createMockInventory(overrides: Partial<MachineInventory> = {}): MachineInventory {
  return {
    machineId: 'target-machine', timestamp: new Date().toISOString(),
    config: {
      roo: { modes: ['code'], mcpSettings: {}, userSettings: {} },
      hardware: { cpu: { model: 'Target CPU', cores: 4, threads: 8 }, memory: { total: 16384 }, disks: [] },
      software: { powershell: '5.1', node: '18.0.0', python: '3.10.0' },
      system: { os: 'Windows', architecture: 'x64' },
    },
    metadata: { collectionDuration: 100, source: 'local', collectorVersion: '1.0.0' },
    ...overrides,
  };
}

function createMockDifferences(): BaselineDifference[] {
  return [
    { category: 'config', severity: 'IMPORTANT', path: 'roo.modes', description: 'Modes differents', baselineValue: ['code', 'architect'], actualValue: ['code'], recommendedAction: 'sync_to_baseline' },
    { category: 'software', severity: 'WARNING', path: 'node.version', description: 'Version Node.js differente', baselineValue: '20.0.0', actualValue: '18.0.0', recommendedAction: 'manual_review' },
  ];
}

function createMockSyncDecision(overrides: Partial<SyncDecision> = {}): SyncDecision {
  return {
    id: 'decision-001', machineId: 'target-machine', differenceId: 'config-roo.modes',
    category: 'config', description: 'Modes differents', baselineValue: ['code', 'architect'],
    targetValue: ['code'], action: 'sync_to_baseline', severity: 'IMPORTANT', status: 'pending',
    createdAt: new Date().toISOString(), ...overrides,
  };
}

function createMockComparisonReport(overrides: Partial<BaselineComparisonReport> = {}): BaselineComparisonReport {
  return {
    baselineMachine: 'test-machine', targetMachine: 'target-machine', baselineVersion: '2.1.0',
    differences: createMockDifferences(),
    summary: { total: 2, critical: 0, important: 1, warning: 1, info: 0 },
    generatedAt: new Date().toISOString(), ...overrides,
  };
}

/** Genere un contenu de roadmap markdown valide avec caracteres accentues francais. */
function buildRoadmapMarkdown(id: string, status: string = 'approved'): string {
  const emoji = status === 'approved' ? '\u2705' : status === 'pending' ? '\u23F3' : '\u2753';
  return [
    '# RooSync Roadmap', '',
    '## D\u00e9cisions de Synchronisation', '',
    `## ${emoji} D\u00e9cision ${id}`, '',
    '**Machine:** target-machine',
    '**Cat\u00e9gorie:** config',
    '**Diff\u00e9rence:** config-roo.modes',
    '**S\u00e9v\u00e9rit\u00e9:** \u26A0\uFE0F IMPORTANT',
    `**Statut:** ${status}`,
    '**Cr\u00e9\u00e9e le:** 2026-01-01',
    '**Mise \u00e0 jour le:** 2026-01-01', '',
    '### Description', 'Modes differents', '',
    '### Diff\u00e9rence',
    '- **Valeur baseline:** `["code","architect"]`',
    '- **Valeur cible:** `["code"]`', '',
    '### Action requise', '**Type:** sync_to_baseline', '', '---',
  ].join('\n');
}

/** Re-initialise les mocks detruits par vitest.config.ts mockReset/restoreMocks. */
function reinitMocks(): void {
  vi.mocked(BaselineLoader).mockImplementation(() => mockBaselineLoaderInstance as any);
  vi.mocked(DifferenceDetector).mockImplementation(() => mockDifferenceDetectorInstance as any);
  vi.mocked(ChangeApplier).mockImplementation(() => mockChangeApplierInstance as any);
  vi.mocked(ConfigValidator).mockImplementation(() => mockConfigValidatorInstance as any);

  Object.assign(mockBaselineLoaderInstance, {
    loadBaseline: vi.fn(), readBaselineFile: vi.fn(), transformBaselineForDiffDetector: vi.fn(),
  });
  Object.assign(mockDifferenceDetectorInstance, {
    calculateSummary: vi.fn(), createSyncDecisions: vi.fn(),
  });
  Object.assign(mockChangeApplierInstance, { applyDecision: vi.fn() });
  Object.assign(mockConfigValidatorInstance, {
    validateBaselineConfig: vi.fn().mockReturnValue(true),
    validateBaselineFileConfig: vi.fn().mockReturnValue(true),
    ensureValidBaselineConfig: vi.fn(), ensureValidBaselineFileConfig: vi.fn(),
  });

  vi.mocked(existsSync).mockReturnValue(false);
}

// --- Tests ---

describe('BaselineService', () => {
  let configService: IConfigService;
  let inventoryCollector: IInventoryCollector;
  let diffDetector: IDiffDetector;
  let service: BaselineService;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    reinitMocks();
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.SHARED_STATE_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    configService = createMockConfigService();
    inventoryCollector = createMockInventoryCollector();
    diffDetector = createMockDiffDetector();
    service = new BaselineService(configService, inventoryCollector, diffDetector);
  });

  afterEach(() => { process.env = { ...originalEnv }; });

  // ---- CONSTRUCTOR ----

  describe('constructor', () => {
    it('devrait initialiser le service avec les dependances fournies', () => {
      expect(service).toBeDefined();
      expect(configService.getBaselineServiceConfig).toHaveBeenCalledOnce();
    });

    it('devrait initialiser l\'etat par defaut', () => {
      const state = service.getState();
      expect(state.isBaselineLoaded).toBe(false);
      expect(state.pendingDecisions).toBe(0);
      expect(state.approvedDecisions).toBe(0);
      expect(state.appliedDecisions).toBe(0);
      expect(state.baselineMachine).toBeUndefined();
      expect(state.baselineVersion).toBeUndefined();
    });

    it('devrait utiliser ROOSYNC_SHARED_PATH quand defini', () => {
      process.env.ROOSYNC_SHARED_PATH = '/env/roosync/shared';
      vi.mocked(existsSync).mockReturnValue(false);
      expect(new BaselineService(configService, inventoryCollector, diffDetector)).toBeDefined();
    });

    it('devrait prioriser SHARED_STATE_PATH en env de test', () => {
      process.env.SHARED_STATE_PATH = '/test/shared';
      vi.mocked(existsSync).mockReturnValue(false);
      expect(new BaselineService(configService, inventoryCollector, diffDetector)).toBeDefined();
    });

    it('devrait creer les 4 modules delegues', () => {
      expect(ConfigValidator).toHaveBeenCalled();
      expect(BaselineLoader).toHaveBeenCalled();
      expect(DifferenceDetector).toHaveBeenCalled();
      expect(ChangeApplier).toHaveBeenCalled();
    });

    it('devrait verifier l\'existence du fichier baseline', () => {
      expect(existsSync).toHaveBeenCalled();
    });
  });

  // ---- getState ----

  describe('getState', () => {
    it('devrait retourner une copie de l\'etat, pas une reference', () => {
      const s1 = service.getState();
      const s2 = service.getState();
      expect(s1).toEqual(s2);
      expect(s1).not.toBe(s2);
    });

    it('devrait refleter les mises a jour d\'etat apres chargement', async () => {
      mockBaselineLoaderInstance.loadBaseline.mockResolvedValue(createMockBaselineConfig());
      vi.mocked(existsSync).mockReturnValue(true);
      await service.loadBaseline();
      const state = service.getState();
      expect(state.isBaselineLoaded).toBe(true);
      expect(state.baselineMachine).toBe('test-machine');
      expect(state.baselineVersion).toBe('2.1.0');
    });
  });

  // ---- loadBaseline ----

  describe('loadBaseline', () => {
    it('devrait charger une baseline existante avec succes', async () => {
      const baseline = createMockBaselineConfig();
      vi.mocked(existsSync).mockReturnValue(true);
      mockBaselineLoaderInstance.loadBaseline.mockResolvedValue(baseline);
      const result = await service.loadBaseline();
      expect(result).toEqual(baseline);
      expect(mockBaselineLoaderInstance.loadBaseline).toHaveBeenCalled();
    });

    it('devrait mettre a jour l\'etat apres chargement reussi', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      mockBaselineLoaderInstance.loadBaseline.mockResolvedValue(createMockBaselineConfig({ machineId: 'machine-A', version: '3.0.0' }));
      await service.loadBaseline();
      const state = service.getState();
      expect(state.isBaselineLoaded).toBe(true);
      expect(state.baselineMachine).toBe('machine-A');
      expect(state.baselineVersion).toBe('3.0.0');
    });

    it('devrait creer une baseline par defaut si le fichier n\'existe pas', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFile).mockResolvedValue();
      mockBaselineLoaderInstance.loadBaseline.mockResolvedValue(null);
      await service.loadBaseline();
      expect(fs.writeFile).toHaveBeenCalled();
      const writtenJson = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0][1] as string);
      expect(writtenJson.version).toBe('2.1.0');
      expect(writtenJson.autoSync).toBe(false);
      expect(writtenJson.conflictStrategy).toBe('manual');
    });

    it('devrait retourner null si le BaselineLoader retourne null', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      mockBaselineLoaderInstance.loadBaseline.mockResolvedValue(null);
      expect(await service.loadBaseline()).toBeNull();
      expect(service.getState().isBaselineLoaded).toBe(false);
    });

    it('devrait propager les erreurs du BaselineLoader', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      mockBaselineLoaderInstance.loadBaseline.mockRejectedValue(new Error('Erreur de lecture'));
      await expect(service.loadBaseline()).rejects.toThrow('Erreur de lecture');
    });

    it('devrait utiliser ROOSYNC_MACHINE_ID pour la baseline par defaut', async () => {
      process.env.ROOSYNC_MACHINE_ID = 'custom-machine-id';
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFile).mockResolvedValue();
      mockBaselineLoaderInstance.loadBaseline.mockResolvedValue(null);
      const svc = new BaselineService(configService, inventoryCollector, diffDetector);
      await svc.loadBaseline();
      const calls = vi.mocked(fs.writeFile).mock.calls;
      const writtenJson = JSON.parse(calls[calls.length - 1][1] as string);
      expect(writtenJson.machineId).toBe('custom-machine-id');
      expect(writtenJson.machines[0].id).toBe('custom-machine-id');
    });
  });

  // ---- readBaselineFile ----

  describe('readBaselineFile', () => {
    it('devrait lire un fichier baseline existant via BaselineLoader', async () => {
      const baselineFile = createMockBaselineFileConfig();
      vi.mocked(existsSync).mockReturnValue(true);
      mockBaselineLoaderInstance.readBaselineFile.mockResolvedValue(baselineFile);
      expect(await service.readBaselineFile()).toEqual(baselineFile);
      expect(mockBaselineLoaderInstance.readBaselineFile).toHaveBeenCalled();
    });

    it('devrait creer une baseline par defaut si le fichier n\'existe pas', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFile).mockResolvedValue();
      const result = await service.readBaselineFile();
      expect(result).toBeDefined();
      expect(result!.version).toBe('2.1.0');
      expect(result!.autoSync).toBe(false);
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('devrait propager les erreurs du BaselineLoader', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      mockBaselineLoaderInstance.readBaselineFile.mockRejectedValue(new Error('Parse failed'));
      await expect(service.readBaselineFile()).rejects.toThrow('Parse failed');
    });

    it('devrait retourner null si le BaselineLoader retourne null', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      mockBaselineLoaderInstance.readBaselineFile.mockResolvedValue(null);
      expect(await service.readBaselineFile()).toBeNull();
    });
  });

  // ---- compareWithBaseline ----

  describe('compareWithBaseline', () => {
    function setupComparisonMocks(baselineFileOverrides = {}, inventoryOverrides = {}, differences: BaselineDifference[] = []) {
      const baselineFile = createMockBaselineFileConfig(baselineFileOverrides);
      const transformed = createMockBaselineConfig();
      const inventory = createMockInventory(inventoryOverrides);
      const summary = differences.reduce((acc, d) => {
        acc.total++; acc[d.severity.toLowerCase() as keyof typeof acc]++; return acc;
      }, { total: 0, critical: 0, important: 0, warning: 0, info: 0 });

      vi.mocked(existsSync).mockReturnValue(true);
      mockBaselineLoaderInstance.readBaselineFile.mockResolvedValue(baselineFile);
      mockBaselineLoaderInstance.transformBaselineForDiffDetector.mockReturnValue(transformed);
      vi.mocked(inventoryCollector.collectInventory).mockResolvedValue(inventory);
      vi.mocked(diffDetector.compareBaselineWithMachine).mockResolvedValue(differences);
      mockDifferenceDetectorInstance.calculateSummary.mockReturnValue(summary);
      return { baselineFile, transformed, inventory, summary };
    }

    it('devrait comparer avec succes une machine avec la baseline', async () => {
      const differences = createMockDifferences();
      setupComparisonMocks({}, {}, differences);
      const result = await service.compareWithBaseline('target-machine');
      expect(result).toBeDefined();
      expect(result!.baselineMachine).toBe('test-machine');
      expect(result!.targetMachine).toBe('target-machine');
      expect(result!.differences).toEqual(differences);
      expect(result!.generatedAt).toBeDefined();
    });

    it('devrait lever une erreur si la baseline n\'est pas disponible', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('write fail'));
      await expect(service.compareWithBaseline('target-machine')).rejects.toThrow();
    });

    it('devrait lever INVENTORY_COLLECTION_FAILED si l\'inventaire est null', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      mockBaselineLoaderInstance.readBaselineFile.mockResolvedValue(createMockBaselineFileConfig());
      vi.mocked(inventoryCollector.collectInventory).mockResolvedValue(null);
      try {
        await service.compareWithBaseline('target-machine');
        expect.unreachable('Aurait du lever une erreur');
      } catch (error: any) {
        expect(error).toBeInstanceOf(BaselineServiceError);
        expect(error.code).toBe(BaselineServiceErrorCode.INVENTORY_COLLECTION_FAILED);
      }
    });

    it('devrait passer forceRefresh au collecteur d\'inventaire', async () => {
      setupComparisonMocks();
      await service.compareWithBaseline('target-machine', true);
      expect(inventoryCollector.collectInventory).toHaveBeenCalledWith('target-machine', true);
    });

    it('devrait mettre a jour lastComparison dans l\'etat', async () => {
      setupComparisonMocks();
      await service.compareWithBaseline('target-machine');
      expect(service.getState().lastComparison).toBeDefined();
    });

    it('devrait re-emballer les erreurs generiques en COMPARISON_FAILED', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      mockBaselineLoaderInstance.readBaselineFile.mockResolvedValue(createMockBaselineFileConfig());
      vi.mocked(inventoryCollector.collectInventory).mockRejectedValue(new Error('network error'));
      try {
        await service.compareWithBaseline('target-machine');
        expect.unreachable('Aurait du lever une erreur');
      } catch (error: any) {
        expect(error).toBeInstanceOf(BaselineServiceError);
        expect(error.code).toBe(BaselineServiceErrorCode.COMPARISON_FAILED);
        expect(error.message).toContain('network error');
      }
    });

    it('devrait preserver les BaselineServiceError sans les re-emballer', async () => {
      const originalError = new BaselineServiceError('Erreur originale', BaselineServiceErrorCode.BASELINE_INVALID);
      vi.mocked(existsSync).mockReturnValue(true);
      mockBaselineLoaderInstance.readBaselineFile.mockResolvedValue(createMockBaselineFileConfig());
      vi.mocked(inventoryCollector.collectInventory).mockRejectedValue(originalError);
      try {
        await service.compareWithBaseline('target-machine');
        expect.unreachable('Aurait du lever une erreur');
      } catch (error: any) {
        expect(error).toBe(originalError);
        expect(error.code).toBe(BaselineServiceErrorCode.BASELINE_INVALID);
      }
    });

    it('devrait transformer la baseline pour le DiffDetector', async () => {
      const { baselineFile, transformed, inventory } = setupComparisonMocks();
      await service.compareWithBaseline('target-machine');
      expect(mockBaselineLoaderInstance.transformBaselineForDiffDetector).toHaveBeenCalledWith(baselineFile);
      expect(diffDetector.compareBaselineWithMachine).toHaveBeenCalledWith(transformed, inventory);
    });

    it('devrait construire le rapport avec baselineVersion depuis le fichier', async () => {
      setupComparisonMocks({ version: '5.0.0', machineId: 'baseline-src' });
      const result = await service.compareWithBaseline('target-machine');
      expect(result!.baselineVersion).toBe('5.0.0');
      expect(result!.baselineMachine).toBe('baseline-src');
    });
  });

  // ---- createSyncDecisions ----

  describe('createSyncDecisions', () => {
    it('devrait creer des decisions a partir d\'un rapport', async () => {
      const report = createMockComparisonReport();
      const decisions = [createMockSyncDecision()];
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFile).mockResolvedValue();
      mockDifferenceDetectorInstance.createSyncDecisions.mockReturnValue(decisions);
      expect(await service.createSyncDecisions(report)).toEqual(decisions);
      expect(mockDifferenceDetectorInstance.createSyncDecisions).toHaveBeenCalledWith(report, 'IMPORTANT');
    });

    it('devrait respecter le seuil de severite CRITICAL', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFile).mockResolvedValue();
      mockDifferenceDetectorInstance.createSyncDecisions.mockReturnValue([]);
      await service.createSyncDecisions(createMockComparisonReport(), 'CRITICAL');
      expect(mockDifferenceDetectorInstance.createSyncDecisions).toHaveBeenCalledWith(expect.anything(), 'CRITICAL');
    });

    it('devrait respecter le seuil de severite WARNING', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFile).mockResolvedValue();
      mockDifferenceDetectorInstance.createSyncDecisions.mockReturnValue([]);
      await service.createSyncDecisions(createMockComparisonReport(), 'WARNING');
      expect(mockDifferenceDetectorInstance.createSyncDecisions).toHaveBeenCalledWith(expect.anything(), 'WARNING');
    });

    it('devrait incrementer pendingDecisions dans l\'etat', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFile).mockResolvedValue();
      mockDifferenceDetectorInstance.createSyncDecisions.mockReturnValue([createMockSyncDecision(), createMockSyncDecision({ id: 'dec-2' })]);
      await service.createSyncDecisions(createMockComparisonReport());
      expect(service.getState().pendingDecisions).toBe(2);
    });

    it('devrait cumuler pendingDecisions sur plusieurs appels', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFile).mockResolvedValue();
      mockDifferenceDetectorInstance.createSyncDecisions.mockReturnValue([createMockSyncDecision()]);
      await service.createSyncDecisions(createMockComparisonReport());
      mockDifferenceDetectorInstance.createSyncDecisions.mockReturnValue([createMockSyncDecision({ id: 'dec-2' }), createMockSyncDecision({ id: 'dec-3' })]);
      await service.createSyncDecisions(createMockComparisonReport());
      expect(service.getState().pendingDecisions).toBe(3);
    });

    it('devrait ecrire les decisions dans le roadmap', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFile).mockResolvedValue();
      mockDifferenceDetectorInstance.createSyncDecisions.mockReturnValue([createMockSyncDecision()]);
      await service.createSyncDecisions(createMockComparisonReport());
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('devrait ajouter les decisions a un roadmap existant', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue('# Existing Roadmap\n\nContent\n');
      vi.mocked(fs.writeFile).mockResolvedValue();
      mockDifferenceDetectorInstance.createSyncDecisions.mockReturnValue([createMockSyncDecision()]);
      await service.createSyncDecisions(createMockComparisonReport());
      const content = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      expect(content).toContain('# Existing Roadmap');
      expect(content).toContain('decision-001');
    });

    it('devrait creer un en-tete si le roadmap n\'existe pas', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFile).mockResolvedValue();
      mockDifferenceDetectorInstance.createSyncDecisions.mockReturnValue([createMockSyncDecision()]);
      await service.createSyncDecisions(createMockComparisonReport());
      const content = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      expect(content).toContain('# RooSync Roadmap');
    });

    it('devrait propager les erreurs du DifferenceDetector', async () => {
      mockDifferenceDetectorInstance.createSyncDecisions.mockImplementation(() => { throw new Error('Decision creation failed'); });
      await expect(service.createSyncDecisions(createMockComparisonReport())).rejects.toThrow('Decision creation failed');
    });

    it('devrait emballer les erreurs d\'ecriture en ROADMAP_UPDATE_FAILED', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Permission denied'));
      mockDifferenceDetectorInstance.createSyncDecisions.mockReturnValue([createMockSyncDecision()]);
      try {
        await service.createSyncDecisions(createMockComparisonReport());
        expect.unreachable('Aurait du lever une erreur');
      } catch (error: any) {
        expect(error).toBeInstanceOf(BaselineServiceError);
        expect(error.code).toBe(BaselineServiceErrorCode.ROADMAP_UPDATE_FAILED);
      }
    });
  });

  // ---- applyDecision ----

  describe('applyDecision', () => {
    it('devrait appliquer une decision trouvee dans le roadmap', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(buildRoadmapMarkdown('dec-apply-1'));
      vi.mocked(fs.writeFile).mockResolvedValue();
      mockChangeApplierInstance.applyDecision.mockResolvedValue({ success: true, decisionId: 'dec-apply-1', appliedAt: new Date().toISOString(), message: 'Applied' });
      const result = await service.applyDecision('dec-apply-1');
      expect(result.success).toBe(true);
      expect(result.decisionId).toBe('dec-apply-1');
      expect(mockChangeApplierInstance.applyDecision).toHaveBeenCalled();
    });

    it('devrait lever DECISION_NOT_FOUND si la decision n\'existe pas', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue('# Empty Roadmap\n');
      try { await service.applyDecision('non-existent'); expect.unreachable('err'); } catch (e: any) {
        expect(e).toBeInstanceOf(BaselineServiceError);
        expect(e.code).toBe(BaselineServiceErrorCode.DECISION_NOT_FOUND);
      }
    });

    it('devrait lever DECISION_NOT_FOUND quand le roadmap n\'existe pas', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      try { await service.applyDecision('any-id'); expect.unreachable('err'); } catch (e: any) {
        expect(e).toBeInstanceOf(BaselineServiceError);
        expect(e.code).toBe(BaselineServiceErrorCode.DECISION_NOT_FOUND);
      }
    });

    it('devrait incrementer appliedDecisions apres application reussie', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(buildRoadmapMarkdown('dec-track-1'));
      vi.mocked(fs.writeFile).mockResolvedValue();
      mockChangeApplierInstance.applyDecision.mockResolvedValue({ success: true, decisionId: 'dec-track-1', appliedAt: new Date().toISOString(), message: 'Applied' });
      await service.applyDecision('dec-track-1');
      expect(service.getState().appliedDecisions).toBe(1);
    });

    it('devrait ne pas incrementer appliedDecisions si l\'application echoue', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(buildRoadmapMarkdown('dec-fail-1'));
      mockChangeApplierInstance.applyDecision.mockResolvedValue({ success: false, decisionId: 'dec-fail-1', appliedAt: new Date().toISOString(), message: 'Failed', error: 'err' });
      const result = await service.applyDecision('dec-fail-1');
      expect(result.success).toBe(false);
      expect(service.getState().appliedDecisions).toBe(0);
    });

    it('devrait mettre a jour le roadmap apres application reussie', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(buildRoadmapMarkdown('dec-upd-1'));
      vi.mocked(fs.writeFile).mockResolvedValue();
      mockChangeApplierInstance.applyDecision.mockResolvedValue({ success: true, decisionId: 'dec-upd-1', appliedAt: new Date().toISOString(), message: 'Applied' });
      await service.applyDecision('dec-upd-1');
      expect(fs.readFile).toHaveBeenCalledTimes(2);
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('devrait propager les erreurs du ChangeApplier', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(buildRoadmapMarkdown('dec-err-1'));
      mockChangeApplierInstance.applyDecision.mockRejectedValue(new Error('Apply failed'));
      await expect(service.applyDecision('dec-err-1')).rejects.toThrow('Apply failed');
    });

    it('devrait gerer les erreurs de lecture du roadmap', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('File corrupted'));
      try { await service.applyDecision('any-id'); expect.unreachable('err'); } catch (e: any) {
        expect(e).toBeInstanceOf(BaselineServiceError);
        expect(e.code).toBe(BaselineServiceErrorCode.DECISION_NOT_FOUND);
      }
    });
  });

  // ---- updateBaseline ----

  describe('updateBaseline', () => {
    it('devrait mettre a jour la baseline avec succes', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();
      expect(await service.updateBaseline(createMockBaselineConfig({ machineId: 'upd', version: '3.0' }))).toBe(true);
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('devrait valider la nouvelle baseline avant ecriture', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();
      const baseline = createMockBaselineConfig();
      await service.updateBaseline(baseline);
      expect(mockConfigValidatorInstance.ensureValidBaselineConfig).toHaveBeenCalledWith(baseline);
    });

    it('devrait mettre a jour l\'etat apres mise a jour reussie', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();
      await service.updateBaseline(createMockBaselineConfig({ machineId: 'new-m', version: '4.0' }));
      const state = service.getState();
      expect(state.isBaselineLoaded).toBe(true);
      expect(state.baselineMachine).toBe('new-m');
      expect(state.baselineVersion).toBe('4.0');
    });

    it('devrait creer une sauvegarde si createBackup et fichier existe', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.writeFile).mockResolvedValue();
      await service.updateBaseline(createMockBaselineConfig(), { createBackup: true });
      expect(copyFileSync).toHaveBeenCalled();
      expect(String(vi.mocked(copyFileSync).mock.calls[0][1])).toContain('.backup.');
    });

    it('devrait ne pas creer de sauvegarde si createBackup false', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.writeFile).mockResolvedValue();
      await service.updateBaseline(createMockBaselineConfig(), { createBackup: false });
      expect(copyFileSync).not.toHaveBeenCalled();
    });

    it('devrait ne pas creer de sauvegarde si le fichier n\'existe pas', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFile).mockResolvedValue();
      await service.updateBaseline(createMockBaselineConfig(), { createBackup: true });
      expect(copyFileSync).not.toHaveBeenCalled();
    });

    it('devrait lever une erreur si la validation echoue', async () => {
      mockConfigValidatorInstance.ensureValidBaselineConfig.mockImplementation(() => { throw new BaselineServiceError('Invalid', BaselineServiceErrorCode.BASELINE_INVALID); });
      await expect(service.updateBaseline(createMockBaselineConfig())).rejects.toThrow(BaselineServiceError);
    });

    it('devrait emballer les erreurs generiques en BASELINE_INVALID', async () => {
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('disk full'));
      try { await service.updateBaseline(createMockBaselineConfig()); expect.unreachable('err'); } catch (e: any) {
        expect(e).toBeInstanceOf(BaselineServiceError);
        expect(e.code).toBe(BaselineServiceErrorCode.BASELINE_INVALID);
        expect(e.message).toContain('disk full');
      }
    });

    it('devrait preserver les BaselineServiceError sans re-emballer', async () => {
      const orig = new BaselineServiceError('Specific', BaselineServiceErrorCode.BASELINE_NOT_FOUND);
      mockConfigValidatorInstance.ensureValidBaselineConfig.mockImplementation(() => { throw orig; });
      try { await service.updateBaseline(createMockBaselineConfig()); expect.unreachable('err'); } catch (e: any) {
        expect(e).toBe(orig);
      }
    });

    it('devrait ecrire la baseline au format JSON indente', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();
      await service.updateBaseline(createMockBaselineConfig());
      const content = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      expect(content).toContain('\n');
      expect(content).toContain('  ');
      expect(() => JSON.parse(content)).not.toThrow();
    });
  });

  // ---- createDefaultBaseline (via loadBaseline) ----

  describe('createDefaultBaseline (via loadBaseline)', () => {
    it('devrait creer une baseline avec tous les champs requis', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFile).mockResolvedValue();
      mockBaselineLoaderInstance.loadBaseline.mockResolvedValue(null);
      await service.loadBaseline();
      const baseline = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0][1] as string) as BaselineFileConfig;
      expect(baseline.version).toBe('2.1.0');
      expect(baseline.baselineId).toMatch(/^baseline-/);
      expect(baseline.timestamp).toBeDefined();
      expect(baseline.autoSync).toBe(false);
      expect(baseline.machines).toHaveLength(1);
      expect(baseline.syncTargets).toEqual([]);
      expect(baseline.decisions).toEqual([]);
    });

    it('devrait creer une machine par defaut avec les champs requis', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFile).mockResolvedValue();
      mockBaselineLoaderInstance.loadBaseline.mockResolvedValue(null);
      await service.loadBaseline();
      const baseline = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0][1] as string) as BaselineFileConfig;
      const m = baseline.machines[0];
      expect(m.id).toBeDefined();
      expect(m.os).toBe('Unknown');
      expect(m.architecture).toBe('Unknown');
      expect(m.roo.modes).toEqual([]);
      expect(m.hardware.cpu.cores).toBe(0);
      expect(m.hardware.memory.total).toBe(0);
      expect(m.software.node).toBe('Unknown');
    });
  });

  // ---- Flux complet d'integration ----

  describe('Flux complet: chargement -> comparaison -> decisions', () => {
    it('devrait executer le flux complet sans erreur', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      mockBaselineLoaderInstance.loadBaseline.mockResolvedValue(createMockBaselineConfig());
      await service.loadBaseline();
      expect(service.getState().isBaselineLoaded).toBe(true);

      mockBaselineLoaderInstance.readBaselineFile.mockResolvedValue(createMockBaselineFileConfig());
      mockBaselineLoaderInstance.transformBaselineForDiffDetector.mockReturnValue(createMockBaselineConfig());
      vi.mocked(inventoryCollector.collectInventory).mockResolvedValue(createMockInventory());
      const diffs = createMockDifferences();
      vi.mocked(diffDetector.compareBaselineWithMachine).mockResolvedValue(diffs);
      mockDifferenceDetectorInstance.calculateSummary.mockReturnValue({ total: 2, critical: 0, important: 1, warning: 1, info: 0 });
      const report = await service.compareWithBaseline('target-machine');
      expect(report!.differences).toHaveLength(2);

      vi.mocked(fs.writeFile).mockResolvedValue();
      mockDifferenceDetectorInstance.createSyncDecisions.mockReturnValue([createMockSyncDecision()]);
      const created = await service.createSyncDecisions(report!);
      expect(created).toHaveLength(1);
      expect(service.getState().pendingDecisions).toBe(1);
    });
  });

  // ---- Cas limites et robustesse ----

  describe('Cas limites et robustesse', () => {
    it('devrait gerer un rapport sans differences', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      mockBaselineLoaderInstance.readBaselineFile.mockResolvedValue(createMockBaselineFileConfig());
      mockBaselineLoaderInstance.transformBaselineForDiffDetector.mockReturnValue(createMockBaselineConfig());
      vi.mocked(inventoryCollector.collectInventory).mockResolvedValue(createMockInventory());
      vi.mocked(diffDetector.compareBaselineWithMachine).mockResolvedValue([]);
      mockDifferenceDetectorInstance.calculateSummary.mockReturnValue({ total: 0, critical: 0, important: 0, warning: 0, info: 0 });
      const report = await service.compareWithBaseline('target-machine');
      expect(report!.differences).toHaveLength(0);
      expect(report!.summary.total).toBe(0);
    });

    it('devrait gerer createSyncDecisions avec rapport vide', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFile).mockResolvedValue();
      mockDifferenceDetectorInstance.createSyncDecisions.mockReturnValue([]);
      const decisions = await service.createSyncDecisions(createMockComparisonReport({ differences: [] }));
      expect(decisions).toHaveLength(0);
      expect(service.getState().pendingDecisions).toBe(0);
    });

    it('devrait gerer les erreurs d\'ecriture dans addDecisionsToRoadmap', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Permission denied'));
      mockDifferenceDetectorInstance.createSyncDecisions.mockReturnValue([createMockSyncDecision()]);
      try { await service.createSyncDecisions(createMockComparisonReport()); expect.unreachable('err'); } catch (e: any) {
        expect(e).toBeInstanceOf(BaselineServiceError);
        expect(e.code).toBe(BaselineServiceErrorCode.ROADMAP_UPDATE_FAILED);
      }
    });

    it('devrait gerer les erreurs de lecture dans loadDecisionsFromRoadmap', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('File corrupted'));
      try { await service.applyDecision('any-id'); expect.unreachable('err'); } catch (e: any) {
        expect(e).toBeInstanceOf(BaselineServiceError);
        expect(e.code).toBe(BaselineServiceErrorCode.DECISION_NOT_FOUND);
      }
    });

    it('devrait ne pas modifier l\'etat si loadBaseline echoue', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      mockBaselineLoaderInstance.loadBaseline.mockRejectedValue(new Error('Critical failure'));
      const stateBefore = service.getState();
      try { await service.loadBaseline(); } catch { /* attendu */ }
      const stateAfter = service.getState();
      expect(stateAfter.isBaselineLoaded).toBe(stateBefore.isBaselineLoaded);
      expect(stateAfter.baselineMachine).toBe(stateBefore.baselineMachine);
    });
  });
});
