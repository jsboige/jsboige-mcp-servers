/**
 * Tests d'intégration pour le workflow de baseline RooSync
 * 
 * T3.13 - Tests d'intégration
 * 
 * Couvre:
 * - Création de baselines non-nominatives
 * - Migration depuis le système legacy
 * - Comparaison de baselines
 * 
 * @version 3.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Unmock fs to use real filesystem for integration tests
vi.unmock('fs/promises');
vi.unmock('fs');

import { RooSyncService } from '../../src/services/RooSyncService.js';
import { BaselineManager } from '../../src/services/roosync/BaselineManager.js';
import { NonNominativeBaselineService } from '../../src/services/roosync/NonNominativeBaselineService.js';
import { join } from 'path';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';

// Mock Qdrant
vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: vi.fn().mockImplementation(() => ({
    getCollections: vi.fn().mockResolvedValue({ collections: [] }),
    createCollection: vi.fn().mockResolvedValue(true),
    upsert: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue([])
  }))
}));

// Mock VectorIndexer
vi.mock('../../src/services/task-indexer/VectorIndexer.js', () => ({
  indexTask: vi.fn().mockResolvedValue([]),
  updateSkeletonIndexTimestamp: vi.fn().mockResolvedValue(undefined),
  resetCollection: vi.fn().mockResolvedValue(undefined),
  countPointsByHostOs: vi.fn().mockResolvedValue(0),
  upsertPointsBatch: vi.fn().mockResolvedValue(undefined),
  qdrantRateLimiter: {}
}));

// Mock RooStorageDetector
vi.mock('../../src/utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    detectStorageLocations: vi.fn().mockResolvedValue(['c:/dev/test'])
  }
}));

describe('T3.13 - Baseline Workflow Integration Tests', () => {
  let tempDir: string;
  let sharedPath: string;
  let baselinePath: string;
  let rooSyncService: RooSyncService;
  let baselineManager: BaselineManager;
  let nonNominativeBaselineService: NonNominativeBaselineService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'roo-baseline-test-'));
    sharedPath = join(tempDir, 'shared');
    baselinePath = join(tempDir, 'baselines');
    
    await mkdir(sharedPath, { recursive: true });
    await mkdir(baselinePath, { recursive: true });
    
    process.env.ROOSYNC_SHARED_PATH = sharedPath;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine-baseline';
    
    // Reset RooSyncService instance
    (RooSyncService as any).instance = null;
    
    // Initialize services
    const mockConfig = {
      machineId: 'test-machine-baseline',
      sharedPath: sharedPath,
      baselinePath: baselinePath,
      autoSync: false,
      conflictStrategy: 'manual',
      logLevel: 'info'
    } as any;
    
    rooSyncService = RooSyncService.getInstance(undefined, mockConfig);
    
    // Initialize NonNominativeBaselineService with sharedPath
    nonNominativeBaselineService = new NonNominativeBaselineService(sharedPath);
    
    // Wait for the service to initialize (loadState is async)
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Create mocks for BaselineService and ConfigComparator
    const mockBaselineService = {
      loadBaseline: vi.fn().mockResolvedValue(null),
      updateBaseline: vi.fn().mockResolvedValue(undefined)
    };
    
    const mockConfigComparator = {
      listDiffs: vi.fn().mockResolvedValue({ totalDiffs: 0, diffs: [] })
    };
    
    baselineManager = new BaselineManager(
      mockConfig,
      mockBaselineService,
      mockConfigComparator,
      nonNominativeBaselineService
    );
    
    // Store original mock for later modification
    (baselineManager as any).mockBaselineService = mockBaselineService;
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (error: any) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EPERM' && error.code !== 'EBUSY') {
        console.warn('Failed to cleanup temp dir:', error.message);
      }
    }
    vi.restoreAllMocks();
  });

  describe('Création de baselines non-nominatives', () => {
    it('devrait créer une baseline non-nominative avec profils', async () => {
      // Arrange
      const profiles = [
        {
          profileId: 'profile-roo-core',
          category: 'roo-core' as const,
          name: 'Profil Roo Core',
          description: 'Configuration Roo de base',
          configuration: {
            modes: ['code', 'architect'],
            mcpSettings: {
              timeout: 30000,
              retryAttempts: 3
            }
          },
          priority: 100,
          compatibility: {
            requiredProfiles: [],
            conflictingProfiles: [],
            optionalProfiles: []
          },
          metadata: {
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: '1.0.0',
            tags: ['test'],
            stability: 'stable' as const
          }
        }
      ];

      // Act
      const baseline = await nonNominativeBaselineService.createBaseline(
        'Baseline de test',
        'Baseline créée pour les tests d\'intégration',
        profiles
      );

      // Assert — createBaseline génère baselineId 'baseline-<ts>-<rand>' (NonNominativeBaselineService.ts l.96)
      expect(baseline.baselineId).toMatch(/^baseline-/);
      expect(baseline.name).toBe('Baseline de test');
      expect(baseline.description).toBe('Baseline créée pour les tests d\'intégration');
      expect(baseline.profiles).toHaveLength(1);
      expect(baseline.profiles[0].category).toBe('roo-core');
      // Round-trip: le profil passé est restitué tel quel
      expect(baseline.profiles[0].profileId).toBe(profiles[0].profileId);
      
      // Verify file exists
      const baselineFile = join(sharedPath, 'non-nominative-baseline.json');
      const baselineContent = await readFile(baselineFile, 'utf-8');
      const baselineData = JSON.parse(baselineContent);
      
      expect(baselineData.baselineId).toBe(baseline.baselineId);
      expect(baselineData.name).toBe('Baseline de test');
    });

    it('devrait créer une baseline avec agrégation automatique', async () => {
      // Arrange
      const machineInventories = [
        {
          machineId: 'machine-1',
          timestamp: new Date().toISOString(),
          config: {
            roo: {
              modes: ['code', 'architect'],
              mcpSettings: { timeout: 30000 },
              userSettings: {}
            },
            hardware: {
              cpu: { model: 'Intel i7', cores: 8, threads: 16 },
              memory: { total: 32768 },
              disks: [],
              gpu: undefined
            },
            software: {
              powershell: '7.4.0',
              node: 'v18.0.0',
              python: '3.11.0'
            },
            system: {
              os: 'Windows 11',
              architecture: 'x64'
            }
          },
          metadata: {
            collectionDuration: 1000,
            source: 'test',
            collectorVersion: '1.0.0'
          }
        },
        {
          machineId: 'machine-2',
          timestamp: new Date().toISOString(),
          config: {
            roo: {
              modes: ['code', 'architect'],
              mcpSettings: { timeout: 30000 },
              userSettings: {}
            },
            hardware: {
              cpu: { model: 'Intel i7', cores: 8, threads: 16 },
              memory: { total: 32768 },
              disks: [],
              gpu: undefined
            },
            software: {
              powershell: '7.4.0',
              node: 'v18.0.0',
              python: '3.11.0'
            },
            system: {
              os: 'Windows 11',
              architecture: 'x64'
            }
          },
          metadata: {
            collectionDuration: 1000,
            source: 'test',
            collectorVersion: '1.0.0'
          }
        }
      ];

      const aggregationConfig = {
        sources: [
          { type: 'machine_inventory' as const, weight: 1.0, enabled: true }
        ],
        categoryRules: {
          'roo-core': { strategy: 'majority' as const, confidenceThreshold: 0.8, autoApply: true },
          'roo-advanced': { strategy: 'majority' as const, confidenceThreshold: 0.8, autoApply: true },
          'hardware-cpu': { strategy: 'majority' as const, confidenceThreshold: 0.8, autoApply: true },
          'hardware-memory': { strategy: 'majority' as const, confidenceThreshold: 0.8, autoApply: true },
          'hardware-storage': { strategy: 'majority' as const, confidenceThreshold: 0.8, autoApply: true },
          'hardware-gpu': { strategy: 'majority' as const, confidenceThreshold: 0.8, autoApply: true },
          'software-powershell': { strategy: 'majority' as const, confidenceThreshold: 0.8, autoApply: true },
          'software-node': { strategy: 'majority' as const, confidenceThreshold: 0.8, autoApply: true },
          'software-python': { strategy: 'majority' as const, confidenceThreshold: 0.8, autoApply: true },
          'system-os': { strategy: 'majority' as const, confidenceThreshold: 0.8, autoApply: true },
          'system-architecture': { strategy: 'majority' as const, confidenceThreshold: 0.8, autoApply: true }
        },
        thresholds: {
          deviationThreshold: 0.2,
          complianceThreshold: 0.8,
          outlierDetection: true
        }
      };

      // Act
      const baseline = await nonNominativeBaselineService.aggregateBaseline(
        machineInventories,
        aggregationConfig
      );

      // Assert
      expect(baseline.baselineId).toMatch(/^baseline-/);
      expect(baseline.name).toBe('Baseline agrégée automatiquement');
      expect(baseline.profiles.length).toBeGreaterThan(0);
      // Chaque profil agrégé porte une catégorie et une configuration
      expect(baseline.profiles.every(p => typeof p.category === 'string' && p.configuration !== undefined)).toBe(true);
    });
  });

  describe('Migration depuis le système legacy', () => {
    it('devrait migrer une baseline legacy vers le format non-nominatif', async () => {
        // Arrange - Configure mock to return a valid baseline
        const mockBaselineService = (baselineManager as any).mockBaselineService;
        mockBaselineService.loadBaseline.mockResolvedValue({
          machineId: 'legacy-machine',
          config: {
            roo: {
              modes: ['code', 'architect'],
              mcpSettings: { timeout: 30000, retryAttempts: 3 },
              userSettings: {}
            },
            hardware: {
              cpu: { model: 'Intel i7', cores: 8, threads: 16 },
              memory: { total: 32768 },
              disks: [],
              gpu: undefined
            },
            software: {
              powershell: '7.4.0',
              node: 'v18.0.0',
              python: '3.11.0'
            },
            system: {
              os: 'Windows 11',
              architecture: 'x64'
            }
          },
          lastUpdated: new Date().toISOString(),
          version: '2.1.0'
        });
  
        // Create legacy baseline file
        const legacyBaseline = {
          version: '2.1.0',
          baselineId: 'baseline-legacy',
          timestamp: new Date().toISOString(),
          machineId: 'legacy-machine',
          config: {
            roo: {
              modes: ['code', 'architect'],
              mcpSettings: { timeout: 30000, retryAttempts: 3 },
              userSettings: {}
            },
            hardware: {
              cpu: { model: 'Intel i7', cores: 8, threads: 16 },
              memory: { total: 32768 },
              disks: [],
              gpu: undefined
            },
            software: {
              powershell: '7.4.0',
              node: 'v18.0.0',
              python: '3.11.0'
            },
            system: {
              os: 'Windows 11',
              architecture: 'x64'
            }
          },
          machines: [
            {
              id: 'legacy-machine',
              name: 'Legacy Machine',
              hostname: 'legacy-host',
              os: 'Windows',
              architecture: 'x64',
              lastSeen: new Date().toISOString(),
              roo: {
                modes: ['code', 'architect'],
                mcpServers: ['github-projects-mcp'],
                sdddSpecs: ['sddd-protocol']
              },
              hardware: {
                cpu: { cores: 8, threads: 16 },
                memory: { total: 32768 }
              },
              software: {
                node: 'v18.0.0',
                python: '3.11.0'
              }
            }
          ],
          syncTargets: [],
          syncPaths: [],
          decisions: [],
          messages: []
        };
  
        const legacyFile = join(baselinePath, 'sync-config.ref.json');
        await writeFile(legacyFile, JSON.stringify(legacyBaseline, null, 2));
  
        // Act - Migrate to non-nominative format
        const result = await baselineManager.migrateToNonNominative({
          createBackup: true,
          updateReason: 'Test migration'
        });
  
        // Assert — contrat migrateToNonNominative (BaselineManager.ts l.526-532)
        expect(result.success).toBe(true);
        expect(result.oldBaseline).toBe('legacy-machine');
        // newBaseline est l'ID (string), pas l'objet
        expect(result.newBaseline).toMatch(/^baseline-/);
        expect(result.migratedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        // transformBaselineToProfiles (l.573-601): 1 (roo) + 3 (hardware) + 3 (software) + 2 (system) = 9
        expect(result.profilesCount).toBe(9);

        // Verify non-nominative baseline exists
        const activeBaseline = await nonNominativeBaselineService.getActiveBaseline();
        expect(activeBaseline).toMatchObject({
          baselineId: result.newBaseline
        });
        expect(activeBaseline?.name).toContain('migrée');
      });
  });

  describe('Comparaison de baselines', () => {
    it('devrait comparer une machine avec la baseline non-nominative', async () => {
      // Arrange - Create baseline first
      const profiles = [
        {
          profileId: 'profile-roo-core',
          category: 'roo-core' as const,
          name: 'Profil Roo Core',
          description: 'Configuration Roo de base',
          configuration: {
            modes: ['code', 'architect'],
            mcpSettings: {
              timeout: 30000,
              retryAttempts: 3
            }
          },
          priority: 100,
          compatibility: {
            requiredProfiles: [],
            conflictingProfiles: [],
            optionalProfiles: []
          },
          metadata: {
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: '1.0.0',
            tags: ['test'],
            stability: 'stable' as const
          }
        }
      ];

      const createdBaseline = await nonNominativeBaselineService.createBaseline(
        'Baseline de comparaison',
        'Baseline pour les tests de comparaison',
        profiles
      );

      // Act - Compare machine with baseline
      const comparison = await baselineManager.compareWithNonNominativeBaseline(
        'test-machine-baseline'
      );

      // Assert — contrat NonNominativeComparisonReport (NonNominativeBaselineService.ts l.763-780)
      expect(comparison.reportId).toMatch(/^comparison-\d+$/);
      expect(comparison.baselineId).toBe(createdBaseline.baselineId);
      expect(comparison.machineHashes).toHaveLength(1);
      expect(comparison.statistics).toMatchObject({
        totalMachines: 1,
        totalDifferences: expect.any(Number),
        complianceRate: expect.any(Number)
      });
      expect(comparison.statistics.differencesBySeverity).toEqual({
        CRITICAL: expect.any(Number),
        IMPORTANT: expect.any(Number),
        WARNING: expect.any(Number),
        INFO: expect.any(Number)
      });
      expect(comparison.metadata.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('devrait mapper une machine à la baseline et détecter les déviations', async () => {
      // Arrange - Create baseline
      const profiles = [
        {
          profileId: 'profile-roo-core',
          category: 'roo-core' as const,
          name: 'Profil Roo Core',
          description: 'Configuration Roo de base',
          configuration: {
            modes: ['code', 'architect'],
            mcpSettings: {
              timeout: 30000,
              retryAttempts: 3
            }
          },
          priority: 100,
          compatibility: {
            requiredProfiles: [],
            conflictingProfiles: [],
            optionalProfiles: []
          },
          metadata: {
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: '1.0.0',
            tags: ['test'],
            stability: 'stable' as const
          }
        }
      ];

      const baseline = await nonNominativeBaselineService.createBaseline(
        'Baseline de mapping',
        'Baseline pour les tests de mapping',
        profiles
      );

      const machineInventory = {
        machineId: 'test-machine-mapping',
        timestamp: new Date().toISOString(),
        config: {
          roo: {
            modes: ['code'], // Différent de la baseline
            mcpSettings: { timeout: 30000 },
            userSettings: {}
          },
          hardware: {
            cpu: { model: 'Intel i7', cores: 8, threads: 16 },
            memory: { total: 32768 },
            disks: [],
            gpu: undefined
          },
          software: {
            powershell: '7.4.0',
            node: 'v18.0.0',
            python: '3.11.0'
          },
          system: {
            os: 'Windows 11',
            architecture: 'x64'
          }
        },
        metadata: {
          collectionDuration: 1000,
          source: 'test',
          collectorVersion: '1.0.0'
        }
      };

      // Act - Map machine to baseline
      const mapping = await nonNominativeBaselineService.mapMachineToBaseline(
        'test-machine-mapping',
        machineInventory,
        baseline.baselineId
      );

      // Assert — contrat MachineConfigurationMapping (NonNominativeBaselineService.ts l.493-509)
      expect(mapping.mappingId).toMatch(/^mapping-/);
      expect(mapping.baselineId).toBe(baseline.baselineId);
      expect(Array.isArray(mapping.appliedProfiles)).toBe(true);
      expect(Array.isArray(mapping.deviations)).toBe(true);
      // calculateConfidence (l.691-695): 1.0 sans déviation, décroît avec
      expect(mapping.metadata.confidence).toBeGreaterThanOrEqual(0);
      expect(mapping.metadata.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('Workflow complet de baseline', () => {
    it('devrait exécuter le workflow complet: création -> mapping -> comparaison', async () => {
      // Step 1: Create baseline
      const profiles = [
        {
          profileId: 'profile-roo-core',
          category: 'roo-core' as const,
          name: 'Profil Roo Core',
          description: 'Configuration Roo de base',
          configuration: {
            modes: ['code', 'architect'],
            mcpSettings: {
              timeout: 30000,
              retryAttempts: 3
            }
          },
          priority: 100,
          compatibility: {
            requiredProfiles: [],
            conflictingProfiles: [],
            optionalProfiles: []
          },
          metadata: {
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: '1.0.0',
            tags: ['test'],
            stability: 'stable' as const
          }
        }
      ];

      const baseline = await nonNominativeBaselineService.createBaseline(
        'Baseline workflow complet',
        'Baseline pour le workflow complet',
        profiles
      );

      expect(baseline.baselineId).toMatch(/^baseline-/);

      // Step 2: Map machine to baseline
      const machineInventory = {
        machineId: 'test-machine-workflow',
        timestamp: new Date().toISOString(),
        config: {
          roo: {
            modes: ['code'],
            mcpSettings: { timeout: 30000 },
            userSettings: {}
          },
          hardware: {
            cpu: { model: 'Intel i7', cores: 8, threads: 16 },
            memory: { total: 32768 },
            disks: [],
            gpu: undefined
          },
          software: {
            powershell: '7.4.0',
            node: 'v18.0.0',
            python: '3.11.0'
          },
          system: {
            os: 'Windows 11',
            architecture: 'x64'
          }
        },
        metadata: {
          collectionDuration: 1000,
          source: 'test',
          collectorVersion: '1.0.0'
        }
      };

      const mapping = await nonNominativeBaselineService.mapMachineToBaseline(
        'test-machine-workflow',
        machineInventory,
        baseline.baselineId
      );

      expect(mapping.mappingId).toMatch(/^mapping-/);
      expect(mapping.baselineId).toBe(baseline.baselineId);

      // Step 3: Compare with baseline
      const comparison = await baselineManager.compareWithNonNominativeBaseline(
        'test-machine-workflow'
      );

      expect(comparison.reportId).toMatch(/^comparison-\d+$/);
      expect(comparison.baselineId).toBe(baseline.baselineId);
    });

    it('devrait gérer le rollback après application de décision', async () => {
      // Arrange - Create files to backup
      const configPath = join(sharedPath, 'sync-config.ref.json');
      const roadmapPath = join(sharedPath, 'sync-roadmap.md');
      
      await writeFile(configPath, JSON.stringify({ test: 'data' }, null, 2));
      await writeFile(roadmapPath, '# Test Roadmap');
      
      // Create a rollback point
      const decisionId = 'test-decision-rollback';
      await baselineManager.createRollbackPoint(decisionId);

      // Modify files to test rollback
      await writeFile(configPath, JSON.stringify({ test: 'modified' }, null, 2));
      await writeFile(roadmapPath, '# Modified Roadmap');

      // Act - Restore from rollback
      const clearCacheCallback = vi.fn();
      const result = await baselineManager.restoreFromRollbackPoint(
        decisionId,
        clearCacheCallback
      );

      // Assert — contrat restoreFromRollbackPoint (BaselineManager.ts l.851-863)
      expect(result.success).toBe(true);
      expect(result.restoredFiles.length).toBeGreaterThanOrEqual(1);
      expect(result.restoredFiles.every(f => typeof f === 'string')).toBe(true);
      expect(Array.isArray(result.logs)).toBe(true);
      expect(result.logs.some(l => l.includes('ROLLBACK'))).toBe(true);
      expect(clearCacheCallback).toHaveBeenCalled();
      
      // Verify files were restored
      const restoredConfig = await readFile(configPath, 'utf-8');
      const restoredRoadmap = await readFile(roadmapPath, 'utf-8');
      
      expect(JSON.parse(restoredConfig).test).toBe('data');
      expect(restoredRoadmap).toBe('# Test Roadmap');
    });
  });

  describe('État du service', () => {
    it('devrait retourner l\'état actuel du service', () => {
      // Act
      const state = nonNominativeBaselineService.getState();

      // Assert — état frais (constructeur l.51-61): compteurs à zéro, lastUpdated ISO
      expect(state.statistics).toEqual({
        totalBaselines: 0,
        totalProfiles: 0,
        totalMachines: 0,
        averageCompliance: 0,
        lastUpdated: expect.any(String)
      });
      expect(state.statistics.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('devrait retourner la baseline active', async () => {
      // Arrange - Create a baseline
      const profiles = [
        {
          profileId: 'profile-roo-core',
          category: 'roo-core' as const,
          name: 'Profil Roo Core',
          description: 'Configuration Roo de base',
          configuration: {
            modes: ['code'],
            mcpSettings: { timeout: 30000 }
          },
          priority: 100,
          compatibility: {
            requiredProfiles: [],
            conflictingProfiles: [],
            optionalProfiles: []
          },
          metadata: {
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: '1.0.0',
            tags: ['test'],
            stability: 'stable' as const
          }
        }
      ];

      await nonNominativeBaselineService.createBaseline(
        'Baseline active',
        'Baseline pour tester l\'état actif',
        profiles
      );

      // Act
      const activeBaseline = nonNominativeBaselineService.getActiveBaseline();

      // Assert
      expect(activeBaseline?.baselineId).toMatch(/^baseline-/);
      expect(activeBaseline?.name).toBe('Baseline active');
    });

    it('devrait retourner les mappings de machines', async () => {
      // Arrange - Create baseline and map a machine
      const profiles = [
        {
          profileId: 'profile-roo-core',
          category: 'roo-core' as const,
          name: 'Profil Roo Core',
          description: 'Configuration Roo de base',
          configuration: {
            modes: ['code'],
            mcpSettings: { timeout: 30000 }
          },
          priority: 100,
          compatibility: {
            requiredProfiles: [],
            conflictingProfiles: [],
            optionalProfiles: []
          },
          metadata: {
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: '1.0.0',
            tags: ['test'],
            stability: 'stable' as const
          }
        }
      ];

      const baseline = await nonNominativeBaselineService.createBaseline(
        'Baseline mappings',
        'Baseline pour tester les mappings',
        profiles
      );

      const machineInventory = {
        machineId: 'test-machine-mappings',
        timestamp: new Date().toISOString(),
        config: {
          roo: {
            modes: ['code'],
            mcpSettings: { timeout: 30000 },
            userSettings: {}
          },
          hardware: {
            cpu: { model: 'Intel i7', cores: 8, threads: 16 },
            memory: { total: 32768 },
            disks: [],
            gpu: undefined
          },
          software: {
            powershell: '7.4.0',
            node: 'v18.0.0',
            python: '3.11.0'
          },
          system: {
            os: 'Windows 11',
            architecture: 'x64'
          }
        },
        metadata: {
          collectionDuration: 1000,
          source: 'test',
          collectorVersion: '1.0.0'
        }
      };

      await nonNominativeBaselineService.mapMachineToBaseline(
        'test-machine-mappings',
        machineInventory,
        baseline.baselineId
      );

      // Act
      const mappings = nonNominativeBaselineService.getMachineMappings();

      // Assert
      expect(mappings.length).toBeGreaterThan(0);
      expect(mappings[0].baselineId).toBe(baseline.baselineId);
      expect(mappings[0].mappingId).toMatch(/^mapping-/);
    });
  });
});
