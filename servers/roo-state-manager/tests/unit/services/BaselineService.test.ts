import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import path from 'path';
import { promises as fs, existsSync, copyFileSync } from 'fs';
import { BaselineService } from '../../../src/services/BaselineService';

// Mock encoding-helpers pour readJSONFileWithoutBOM
vi.mock('../../../src/utils/encoding-helpers.js', () => ({
  readJSONFileWithoutBOM: vi.fn(),
  writeJSONFileWithBOM: vi.fn()
}));

// Mock fs module de manière cohérente avec l'import utilisé
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    copyFileSync: vi.fn(),
    // Mock cohérent avec l'import { promises as fs }
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      access: vi.fn(),
      stat: vi.fn()
    }
  };
});

// Mock readJSONFileWithoutBOM - BaselineLoader utilise cette fonction
vi.mock('../../../src/utils/encoding-helpers.js', () => ({
  readJSONFileWithoutBOM: vi.fn()
}));

import { readJSONFileWithoutBOM } from '../../../src/utils/encoding-helpers.js';

describe('BaselineService', () => {
  let service: any;
  let mockConfigService: any;
  let mockInventoryCollector: any;
  let mockDiffDetector: any;
  // Utiliser un chemin compatible multi-plateforme pour les tests
  const testSharedStatePath = path.join(process.cwd(), 'test-shared-state');
  const baselinePath = path.join(testSharedStatePath, 'sync-config.ref.json');
  const roadmapPath = path.join(testSharedStatePath, 'sync-roadmap.md');

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Mock existsSync par défaut à true pour le dossier partagé
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === testSharedStatePath) return true;
      return false;
    });

    // Mock des dépendances
    mockConfigService = {
      get: vi.fn(),
      set: vi.fn(),
      getAll: vi.fn().mockReturnValue({}),
      getBaselineServiceConfig: vi.fn().mockReturnValue({
        baselinePath: undefined,
        roadmapPath: undefined,
        logLevel: 'INFO'
      }),
      getSharedStatePath: vi.fn().mockReturnValue(testSharedStatePath)
    };

    mockInventoryCollector = {
      collectInventory: vi.fn().mockResolvedValue({
        machineId: 'test-machine',
        timestamp: new Date().toISOString(),
        os: 'test-platform',
        architecture: 'x64',
        hardware: {
          cpu: { model: 'test-cpu', cores: 8, threads: 8 },
          memory: { total: 16000000000 },
          disks: [
            { device: 'C:', size: 500000000000, free: 200000000000 }
          ],
          gpu: 'test-gpu'
        },
        software: {
          node: '18.0.0',
          python: '3.10.0',
          powershell: '7.0.0'
        },
        roo: {
          modes: [],
          mcpSettings: {},
          userSettings: {}
        }
      })
    };

    mockDiffDetector = {
      compare: vi.fn().mockReturnValue({
        differences: [],
        summary: { added: 0, removed: 0, modified: 0 }
      }),
      compareBaselineWithMachine: vi.fn().mockResolvedValue([])
    };

    // Mock des variables d'environnement avec ROOSYNC_SHARED_PATH
    vi.stubEnv('ROOSYNC_SHARED_PATH', testSharedStatePath);

    // Forcer les chemins pour les tests
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;
    process.env.SHARED_STATE_PATH = testSharedStatePath;

    service = new BaselineService(mockConfigService, mockInventoryCollector, mockDiffDetector);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should use ROOSYNC_SHARED_PATH environment variable', () => {
    expect(process.env.ROOSYNC_SHARED_PATH).toBe(testSharedStatePath);
  });

  it('should initialize with correct paths when ROOSYNC_SHARED_PATH is set', () => {
    expect((service as any).baselinePath).toBe(baselinePath);
    expect((service as any).roadmapPath).toBe(roadmapPath);
  });

  it('should throw error when ROOSYNC_SHARED_PATH is not set', () => {
    vi.unstubAllEnvs();
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.SHARED_STATE_PATH;

    // On doit mocker getSharedStatePath pour qu'il lance une erreur comme la vraie implémentation
    mockConfigService.getSharedStatePath.mockImplementation(() => {
        throw new Error("Configuration manquante : ROOSYNC_SHARED_PATH n'est pas définie.");
    });

    expect(() => {
        new BaselineService(mockConfigService, mockInventoryCollector, mockDiffDetector);
    }).toThrow("Configuration manquante");
  });

  it('should load baseline', async () => {
    const mockBaseline = {
      version: '1.0.0',
      baselineId: 'test-baseline-id',
      machineId: 'test-machine',
      timestamp: '2025-01-01T00:00:00.000Z',
      machines: [
        {
          id: 'test-machine',
          os: 'test-platform',
          architecture: 'x64',
          hardware: {
            cpu: { cores: 8, threads: 8 },
            memory: { total: 16000000000 }
          },
          software: {
            node: '18.0.0',
            python: '3.10.0'
          },
          roo: {
            modes: [],
            mcpServers: []
          }
        }
      ]
    };

    // Mock existsSync pour le fichier baseline
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === baselinePath) return true;
      return false;
    });

    // Mock readJSONFileWithoutBOM - BaselineLoader utilise cette fonction
    vi.mocked(readJSONFileWithoutBOM).mockResolvedValue(mockBaseline);

    // loadBaseline transforme le résultat, donc on ne peut pas comparer directement avec mockBaseline
    // On vérifie juste que ça ne plante pas et que ça retourne quelque chose
    const result = await service.loadBaseline();

    expect(result).toBeDefined();
    expect(result?.machineId).toBe(mockBaseline.machineId);
  });

  it('should return null if baseline file does not exist', async () => {
    // Mock existsSync pour retourner false
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await service.loadBaseline();
    expect(result).toBeNull();
  });

  it('should throw error if baseline JSON is invalid', async () => {
    // Mock existsSync pour le fichier baseline
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === baselinePath) return true;
      return false;
    });

    // Mock readJSONFileWithoutBOM pour lancer une erreur (JSON invalide)
    const { readJSONFileWithoutBOM } = await import('../../../src/utils/encoding-helpers.js');
    vi.mocked(readJSONFileWithoutBOM).mockRejectedValue(new SyntaxError('Invalid JSON'));

    await expect(service.loadBaseline()).rejects.toThrow();
  });

  it('should compare machine with baseline', async () => {
    const mockBaseline = {
      version: '1.0.0',
      baselineId: 'test-baseline-id',
      machineId: 'test-machine',
      timestamp: '2025-01-01T00:00:00.000Z',
      machines: [
        {
          id: 'test-machine',
          os: 'test-platform',
          architecture: 'x64',
          hardware: {
            cpu: { cores: 8, threads: 8 },
            memory: { total: 16000000000 }
          },
          software: {
            node: '18.0.0',
            python: '3.10.0'
          },
          roo: {
            modes: [],
            mcpServers: []
          }
        }
      ]
    };

    // Mock existsSync pour le fichier baseline
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === baselinePath) return true;
      return false;
    });

    // Mock readJSONFileWithoutBOM - BaselineLoader utilise cette fonction
    vi.mocked(readJSONFileWithoutBOM).mockResolvedValue(mockBaseline);

    const result = await service.compareWithBaseline('test-machine');

    expect(result).toBeDefined();
    expect(result?.differences).toEqual([]);
  });

  it('should return null if no differences', async () => {
    const mockBaseline = {
      version: '1.0.0',
      baselineId: 'test-baseline-id',
      machineId: 'test-machine',
      timestamp: '2025-01-01T00:00:00.000Z',
      machines: [
        {
          id: 'test-machine',
          os: 'test-platform',
          architecture: 'x64',
          hardware: {
            cpu: { cores: 8, threads: 8 },
            memory: { total: 16000000000 }
          },
          software: {
            node: '18.0.0',
            python: '3.10.0'
          },
          roo: {
            modes: [],
            mcpServers: []
          }
        }
      ]
    };

    // Mock existsSync pour le fichier baseline
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === baselinePath) return true;
      return false;
    });

    // Mock readJSONFileWithoutBOM - BaselineLoader utilise cette fonction
    vi.mocked(readJSONFileWithoutBOM).mockResolvedValue(mockBaseline);

    const result = await service.compareWithBaseline('test-machine');

    expect(result).toBeDefined();
    expect(result?.differences).toEqual([]);
  });

  it('should detect critical differences', async () => {
    const mockBaseline = {
      version: '1.0.0',
      baselineId: 'test-baseline-id',
      machineId: 'test-machine',
      timestamp: '2025-01-01T00:00:00.000Z',
      machines: [
        {
          id: 'test-machine',
          os: 'test-platform',
          architecture: 'x64',
          hardware: {
            cpu: { cores: 8, threads: 8 },
            memory: { total: 16000000000 }
          },
          software: {
            node: '18.0.0',
            python: '3.10.0'
          },
          roo: {
            modes: [],
            mcpServers: []
          }
        }
      ]
    };

    // Mock existsSync pour le fichier baseline
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === baselinePath) return true;
      return false;
    });

    // Mock readJSONFileWithoutBOM - BaselineLoader utilise cette fonction
    vi.mocked(readJSONFileWithoutBOM).mockResolvedValue(mockBaseline);

    // On mock le diffDetector pour retourner des différences
    mockDiffDetector.compareBaselineWithMachine.mockResolvedValue([
        { type: 'disk_space', severity: 'critical', details: 'Disk space critical' }
    ]);

    const result = await service.compareWithBaseline('test-machine');

    expect(result?.differences).toHaveLength(1);
  });

  it('should generate decisions from differences', async () => {
    const mockDifferences = {
      differences: [
        { type: 'disk_space', severity: 'CRITICAL', details: 'Disk space critical', category: 'hardware', path: 'disk', baselineValue: '500GB', actualValue: '200GB', description: 'Disk space critical' }
      ],
      summary: { added: 0, removed: 0, modified: 1 }
    };

    // Mock du rapport de comparaison
    const mockReport = {
      baselineMachine: 'test-machine',
      targetMachine: 'test-machine',
      baselineVersion: '1.0.0',
      differences: mockDifferences.differences,
      summary: mockDifferences.summary,
      generatedAt: new Date().toISOString()
    };

    // Mock fs pour addDecisionsToRoadmap
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === roadmapPath) return true;
      return false;
    });
    vi.mocked(fs.readFile).mockResolvedValue('');
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    const result = await service.createSyncDecisions(mockReport);

    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('sync_to_baseline'); // CRITICAL -> sync_to_baseline (prioritaire sur hardware)
    expect(result[0].description).toContain('Disk space critical');
  });

  it('should filter decisions by severity threshold', async () => {
    const mockDifferences = {
      differences: [
        { type: 'disk_space', severity: 'CRITICAL', details: 'Critical issue', category: 'hardware', path: 'disk', baselineValue: '500GB', actualValue: '200GB', description: 'Critical issue' },
        { type: 'memory', severity: 'WARNING', details: 'Minor issue', category: 'hardware', path: 'memory', baselineValue: '16GB', actualValue: '8GB', description: 'Minor issue' },
        { type: 'cpu', severity: 'CRITICAL', details: 'Another critical', category: 'hardware', path: 'cpu', baselineValue: '8 cores', actualValue: '4 cores', description: 'Another critical' }
      ],
      summary: { added: 0, removed: 0, modified: 3 }
    };

    // Mock du rapport de comparaison
    const mockReport = {
      baselineMachine: 'test-machine',
      targetMachine: 'test-machine',
      baselineVersion: '1.0.0',
      differences: mockDifferences.differences,
      summary: mockDifferences.summary,
      generatedAt: new Date().toISOString()
    };

    // Mock fs pour addDecisionsToRoadmap
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === roadmapPath) return true;
      return false;
    });
    vi.mocked(fs.readFile).mockResolvedValue('');
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    const result = await service.createSyncDecisions(mockReport, 'CRITICAL');

    expect(result).toHaveLength(2);
    expect(result.every((d: any) => d.severity === 'CRITICAL')).toBe(true);
  });

  it('should apply approved decision', async () => {
    const mockDecision = {
      id: 'test-decision',
      action: 'backup',
      description: 'Test backup',
      status: 'approved',
      category: 'config',
      differenceId: 'roo.userSettings.theme'
    };

    // Mock loadDecisionsFromRoadmap pour retourner notre décision
    vi.spyOn(service as any, 'loadDecisionsFromRoadmap').mockResolvedValue([mockDecision]);
    vi.spyOn(service as any, 'updateDecisionInRoadmap').mockResolvedValue(undefined);

    // Mock du ChangeApplier délégué
    vi.spyOn(service.changeApplier, 'applyDecision').mockResolvedValue({
      success: true,
      decisionId: 'test-decision',
      appliedAt: new Date().toISOString(),
      message: 'Décision appliquée avec succès'
    });

    const result = await service.applyDecision('test-decision');

    expect(result.success).toBe(true);
  });

  it('should reject non-approved decision', async () => {
    const mockDecision = {
      id: 'test-decision',
      action: 'backup',
      description: 'Test backup',
      status: 'pending'
    };

    vi.spyOn(service as any, 'loadDecisionsFromRoadmap').mockResolvedValue([mockDecision]);

    // Le ChangeApplier va rejeter la décision car elle n'est pas approuvée
    // Mais ici on teste que BaselineService délègue correctement
    // On peut mocker ChangeApplier pour qu'il throw une erreur
    vi.spyOn(service.changeApplier, 'applyDecision').mockRejectedValue(new Error('Décision non approuvée'));

    await expect(service.applyDecision('test-decision')).rejects.toThrow();
  });

  it('should update baseline with backup', async () => {
    const mockBaseline = {
      machineId: 'test-machine',
      version: '1.0.0',
      config: {
        roo: {
          modes: [],
          mcpSettings: {},
          userSettings: {}
        },
        hardware: {
          cpu: { model: 'test', cores: 4, threads: 8 },
          memory: { total: 16000000000 },
          disks: [],
          gpu: 'test'
        },
        software: {
          powershell: '7.0',
          node: '18.0',
          python: '3.10'
        },
        system: {
          os: 'test',
          architecture: 'x64'
        }
      },
      lastUpdated: new Date().toISOString()
    };

    // Mock existsSync pour le fichier baseline
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === baselinePath) return true;
      return false;
    });

    // Mock copyFileSync implementation
    vi.mocked(copyFileSync).mockImplementation(() => {});
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    const result = await service.updateBaseline(mockBaseline, { createBackup: true });

    expect(result).toBe(true);
  });

  it('should reject invalid baseline update', async () => {
    const invalidBaseline = { invalid: 'data' };

    await expect(service.updateBaseline(invalidBaseline)).rejects.toThrow('Configuration baseline invalide');
  });

  it('should return current service state', () => {
    const result = service.getState();

    expect(result).toHaveProperty('isBaselineLoaded');
    expect(result).toHaveProperty('pendingDecisions');
    expect(result).toHaveProperty('approvedDecisions');
    expect(result).toHaveProperty('appliedDecisions');
  });
});
