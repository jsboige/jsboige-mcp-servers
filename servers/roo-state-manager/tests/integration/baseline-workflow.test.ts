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

      // Assert
      expect(baseline).toBeDefined();
      expect(baseline.baselineId).toBeDefined();
      expect(baseline.name).toBe('Baseline de test');
      expect(baseline.description).toBe('Baseline créée pour les tests d\'intégration');
      expect(baseline.profiles).toHaveLength(1);
      expect(baseline.profiles[0].category).toBe('roo-core');
      
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
      expect(baseline).toBeDefined();
      expect(baseline.baselineId).toBeDefined();
      expect(baseline.name).toBe('Baseline agrégée automatiquement');
      expect(baseline.profiles.length).toBeGreaterThan(0);
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
  
        // Assert
        expect(result.success).toBe(true);
        expect(result.newBaseline).toBeDefined();
        expect(result.profilesCount).toBeGreaterThan(0);
        
        // Verify non-nominative baseline exists
        const activeBaseline = await nonNominativeBaselineService.getActiveBaseline();
        expect(activeBaseline).toBeDefined();
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

      await nonNominativeBaselineService.createBaseline(
        'Baseline de comparaison',
        'Baseline pour les tests de comparaison',
        profiles
      );

      // Act - Compare machine with baseline
      const comparison = await baselineManager.compareWithNonNominativeBaseline(
        'test-machine-baseline'
      );

      // Assert
      expect(comparison).toBeDefined();
      expect(comparison.reportId).toBeDefined();
      expect(comparison.baselineId).toBeDefined();
      expect(comparison.statistics).toBeDefined();
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

      // Assert
      expect(mapping).toBeDefined();
      expect(mapping.mappingId).toBeDefined();
      expect(mapping.baselineId).toBe(baseline.baselineId);
      expect(mapping.appliedProfiles).toBeDefined();
      expect(mapping.deviations).toBeDefined();
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

      expect(baseline).toBeDefined();
      expect(baseline.baselineId).toBeDefined();

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

      expect(mapping).toBeDefined();
      expect(mapping.baselineId).toBe(baseline.baselineId);

      // Step 3: Compare with baseline
      const comparison = await baselineManager.compareWithNonNominativeBaseline(
        'test-machine-workflow'
      );

      expect(comparison).toBeDefined();
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

      // Assert
      expect(result.success).toBe(true);
      expect(result.restoredFiles).toBeDefined();
      expect(result.logs).toBeDefined();
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

      // Assert
      expect(state).toBeDefined();
      expect(state.statistics).toBeDefined();
      expect(state.statistics.totalBaselines).toBeGreaterThanOrEqual(0);
      expect(state.statistics.totalProfiles).toBeGreaterThanOrEqual(0);
      expect(state.statistics.totalMachines).toBeGreaterThanOrEqual(0);
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
      expect(activeBaseline).toBeDefined();
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
      expect(mappings).toBeDefined();
      expect(mappings.length).toBeGreaterThan(0);
      expect(mappings[0].baselineId).toBe(baseline.baselineId);
    });
  });
});
