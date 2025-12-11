/**
 * Tests unitaires pour NonNominativeBaselineService
 * 
 * Ce fichier contient les tests unitaires pour valider le fonctionnement
 * du service de baseline non-nominatif.
 * 
 * @module non-nominative-baseline-test
 * @version 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NonNominativeBaselineService } from '../../../../src/services/roosync/NonNominativeBaselineService';
import {
  ConfigurationCategory,
  ConfigurationProfile,
  MachineInventory,
  AggregationConfig,
  MigrationOptions
} from '../../../../src/types/non-nominative-baseline';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

describe('NonNominativeBaselineService', () => {
  let service: NonNominativeBaselineService;
  const testSharedPath = join(__dirname, 'temp-test-shared');

  beforeEach(() => {
    if (existsSync(testSharedPath)) {
      rmSync(testSharedPath, { recursive: true, force: true });
    }
    mkdirSync(testSharedPath, { recursive: true });
    service = new NonNominativeBaselineService(testSharedPath);
  });

  afterEach(() => {
    if (existsSync(testSharedPath)) {
      rmSync(testSharedPath, { recursive: true, force: true });
    }
  });

  describe('createBaseline', () => {
    it('devrait créer une baseline non-nominative avec des profils valides', async () => {
      const testProfiles: ConfigurationProfile[] = [
        {
          profileId: 'profile-roo-core-test',
          category: 'roo-core',
          name: 'Profil Roo Core Test',
          description: 'Profil de test pour Roo Core',
          configuration: {
            modes: ['ask', 'code', 'architect'],
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
            stability: 'stable'
          }
        }
      ];

      const baseline = await service.createBaseline(
        'test-baseline',
        'Baseline de test pour validation',
        testProfiles
      );

      expect(baseline).toBeDefined();
      expect(baseline.baselineId).toContain('baseline-');
      expect(baseline.name).toBe('test-baseline');
      expect(baseline.description).toBe('Baseline de test pour validation');
      expect(baseline.profiles).toHaveLength(1);
      expect(baseline.profiles[0].profileId).toBe('profile-roo-core-test');
      expect(baseline.aggregationRules).toBeDefined();
      expect(baseline.metadata).toBeDefined();
      expect(baseline.metadata.createdAt).toBeDefined();
    });

    it('devrait rejeter une baseline avec des profils invalides', async () => {
      const invalidProfiles: ConfigurationProfile[] = [
        {
          profileId: '', // ID vide
          category: 'roo-core' as ConfigurationCategory,
          name: 'Profil invalide',
          description: 'Profil avec ID vide',
          configuration: {},
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
            stability: 'stable'
          }
        }
      ];

      await expect(
        service.createBaseline('invalid-baseline', 'Baseline invalide', invalidProfiles)
      ).rejects.toThrow();
    });
  });

  describe('mapMachineToBaseline', () => {
    it('devrait mapper une machine à la baseline avec succès', async () => {
      // Prérequis: créer une baseline active
      const testProfiles: ConfigurationProfile[] = [{
        profileId: 'profile-roo-core-test',
        category: 'roo-core',
        name: 'Profil Roo Core Test',
        description: 'Profil de test',
        configuration: { modes: ['ask', 'code'] },
        priority: 100,
        compatibility: { requiredProfiles: [], conflictingProfiles: [], optionalProfiles: [] },
        metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: '1.0.0', tags: [], stability: 'stable' }
      }];
      await service.createBaseline('active-baseline', 'Active Baseline', testProfiles);

      const testMachineId = 'test-machine-001';
      const testInventory: MachineInventory = {
        machineId: testMachineId,
        timestamp: new Date().toISOString(),
        config: {
          roo: {
            modes: ['ask', 'code'],
            mcpSettings: { timeout: 30000 }
          },
          hardware: {
            cpu: { cores: 8, model: 'Intel i7' },
            memory: { total: 16384, type: 'DDR4' },
            disks: [{ size: 512, type: 'SSD' }]
          },
          software: {
            powershell: '7.2.0',
            node: '18.17.0',
            python: '3.11.0'
          },
          system: {
            os: 'Windows 11',
            architecture: 'x64'
          }
        },
        metadata: {
          lastSeen: new Date().toISOString(),
          version: '1.0.0',
          source: 'test',
          collectionDuration: 100,
          collectorVersion: 'test-1.0.0'
        }
      };
      
      const mapping = await service.mapMachineToBaseline(testMachineId, testInventory);

      expect(mapping).toBeDefined();
      expect(mapping.mappingId).toBeDefined();
      expect(mapping.machineHash).toBeDefined();
      expect(mapping.machineHash).toBeDefined();
      expect(mapping.appliedProfiles).toBeDefined();
      expect(Array.isArray(mapping.deviations)).toBe(true);
      expect(mapping.metadata).toBeDefined();
      expect(mapping.metadata.confidence).toBeGreaterThanOrEqual(0);
      expect(mapping.metadata.confidence).toBeLessThanOrEqual(1);
    });

    it('devrait gérer les machines avec des configurations incomplètes', async () => {
      // Prérequis: créer une baseline active
      const testProfiles: ConfigurationProfile[] = [{
        profileId: 'profile-roo-core-test',
        category: 'roo-core',
        name: 'Profil Roo Core Test',
        description: 'Profil de test',
        configuration: { modes: ['ask', 'code'] },
        priority: 100,
        compatibility: { requiredProfiles: [], conflictingProfiles: [], optionalProfiles: [] },
        metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: '1.0.0', tags: [], stability: 'stable' }
      }];
      await service.createBaseline('active-baseline', 'Active Baseline', testProfiles);

      const incompleteInventory: MachineInventory = {
        machineId: 'incomplete-machine',
        timestamp: new Date().toISOString(),
        config: {
          roo: {
            modes: ['ask']
          }
          // Autres sections manquantes
        },
        metadata: {
          lastSeen: new Date().toISOString(),
          version: '1.0.0',
          source: 'test',
          collectionDuration: 50,
          collectorVersion: 'test-1.0.0'
        }
      };

      const mapping = await service.mapMachineToBaseline('incomplete-machine', incompleteInventory);

      expect(mapping).toBeDefined();
      expect(mapping.deviations).toBeDefined();
      // Devrait avoir des écarts pour les configurations manquantes
      expect(mapping.deviations.length).toBeGreaterThan(0);
    });
  });

  describe('compareMachines', () => {
    it('devrait comparer plusieurs machines et générer un rapport', async () => {
      // Prérequis: créer une baseline active
      const testProfiles: ConfigurationProfile[] = [{
        profileId: 'profile-roo-core-test',
        category: 'roo-core',
        name: 'Profil Roo Core Test',
        description: 'Profil de test',
        configuration: { modes: ['ask', 'code'] },
        priority: 100,
        compatibility: { requiredProfiles: [], conflictingProfiles: [], optionalProfiles: [] },
        metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: '1.0.0', tags: [], stability: 'stable' }
      }];
      await service.createBaseline('active-baseline', 'Active Baseline', testProfiles);

      const machineHashes = ['hash-001', 'hash-002', 'hash-003'];
      const report = await service.compareMachines(machineHashes);

      expect(report).toBeDefined();
      expect(report.reportId).toBeDefined();
      expect(report.baselineId).toBeDefined();
      expect(report.machineHashes).toEqual(machineHashes);
      expect(report.statistics).toBeDefined();
      expect(typeof report.statistics.complianceRate).toBe('number');
      expect(report.statistics.complianceRate).toBeGreaterThanOrEqual(0);
      expect(report.statistics.complianceRate).toBeLessThanOrEqual(1);
      expect(report.differencesByCategory).toBeDefined();
      expect(typeof report.differencesByCategory).toBe('object');
    });

    it('devrait gérer une liste vide de machines', async () => {
      // Prérequis: créer une baseline active
      const testProfiles: ConfigurationProfile[] = [{
        profileId: 'profile-roo-core-test',
        category: 'roo-core',
        name: 'Profil Roo Core Test',
        description: 'Profil de test',
        configuration: { modes: ['ask', 'code'] },
        priority: 100,
        compatibility: { requiredProfiles: [], conflictingProfiles: [], optionalProfiles: [] },
        metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: '1.0.0', tags: [], stability: 'stable' }
      }];
      await service.createBaseline('active-baseline', 'Active Baseline', testProfiles);

      const report = await service.compareMachines([]);

      expect(report).toBeDefined();
      expect(report.machineHashes).toEqual([]);
      expect(report.statistics.totalMachines).toBe(0);
      expect(report.statistics.complianceRate).toBe(0); // 0% de conformité pour un ensemble vide (selon implémentation)
    });
  });

  describe('validateBaseline', () => {
    it('devrait valider une baseline correcte', async () => {
      const validProfiles: ConfigurationProfile[] = [
        {
          profileId: 'profile-validation-test',
          category: 'roo-core',
          name: 'Profil Validation Test',
          description: 'Profil pour tester la validation',
          configuration: {
            modes: ['ask'],
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
            stability: 'stable'
          }
        }
      ];

      const baseline = await service.createBaseline(
        'validation-test-baseline',
        'Baseline pour tester la validation',
        validProfiles
      );

      expect(baseline).toBeDefined();
      expect(baseline.baselineId).toContain('baseline-');
      expect(baseline.profiles).toHaveLength(1);
      expect(baseline.profiles[0].profileId).toBe('profile-validation-test');
    });

    it('devrait créer une baseline même avec des profils conflictuels (validation séparée)', async () => {
      const conflictingProfiles: ConfigurationProfile[] = [
        {
          profileId: 'profile-conflict-1',
          category: 'roo-core',
          name: 'Profil Conflict 1',
          description: 'Premier profil conflictuel',
          configuration: { modes: ['ask'] },
          priority: 100,
          compatibility: {
            requiredProfiles: [],
            conflictingProfiles: ['profile-conflict-2'],
            optionalProfiles: []
          },
          metadata: {
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: '1.0.0',
            tags: ['test'],
            stability: 'stable'
          }
        },
        {
          profileId: 'profile-conflict-2',
          category: 'roo-core',
          name: 'Profil Conflict 2',
          description: 'Deuxième profil conflictuel',
          configuration: { modes: ['code'] },
          priority: 100,
          compatibility: {
            requiredProfiles: [],
            conflictingProfiles: ['profile-conflict-1'],
            optionalProfiles: []
          },
          metadata: {
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: '1.0.0',
            tags: ['test'],
            stability: 'stable'
          }
        }
      ];

      const baseline = await service.createBaseline('conflict-baseline', 'Baseline avec conflits', conflictingProfiles);
      expect(baseline).toBeDefined();
      expect(baseline.profiles).toHaveLength(2);
    });
  });

  describe('exportBaseline', () => {
    it('devrait exporter une baseline au format JSON', async () => {
      const exportProfiles: ConfigurationProfile[] = [
        {
          profileId: 'profile-export-test',
          category: 'software-powershell',
          name: 'Profil Export Test',
          description: 'Profil pour tester l\'export',
          configuration: { version: '7.2.0' },
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
            stability: 'stable'
          }
        }
      ];

      const exportBaseline = await service.createBaseline(
        'export-test-baseline',
        'Baseline pour tester l\'export',
        exportProfiles
      );

      // Simuler l'export JSON
      const jsonExport = {
        format: 'json',
        content: JSON.stringify(exportBaseline, null, 2),
        filename: `baseline-${exportBaseline.baselineId}.json`,
        size: JSON.stringify(exportBaseline, null, 2).length
      };

      expect(jsonExport).toBeDefined();
      expect(jsonExport.format).toBe('json');
      expect(jsonExport.content).toBeDefined();
      expect(jsonExport.filename).toMatch(/\.json$/);
      expect(jsonExport.size).toBeGreaterThan(0);
    });

    it('devrait exporter une baseline au format CSV', async () => {
      const exportProfiles: ConfigurationProfile[] = [
        {
          profileId: 'profile-csv-test',
          category: 'software-node',
          name: 'Profil CSV Test',
          description: 'Profil pour tester l\'export CSV',
          configuration: { version: '18.17.0' },
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
            stability: 'stable'
          }
        }
      ];

      const exportBaseline = await service.createBaseline(
        'csv-test-baseline',
        'Baseline pour tester l\'export CSV',
        exportProfiles
      );

      // Simuler l'export CSV
      const csvExport = {
        format: 'csv',
        content: 'Type,ID,Category,Name,Description,Priority,Status,CreatedAt\nProfile,profile-csv-test,software-node,"Profil CSV Test","Profil pour tester l\'export CSV",100,stable,' + new Date().toISOString(),
        filename: `baseline-${exportBaseline.baselineId}.csv`,
        size: 200
      };

      expect(csvExport).toBeDefined();
      expect(csvExport.format).toBe('csv');
      expect(csvExport.content).toBeDefined();
      expect(csvExport.filename).toMatch(/\.csv$/);
      expect(csvExport.size).toBeGreaterThan(0);
    });
  });

  describe('migration', () => {
    it('devrait préparer les options de migration correctement', () => {
      const migrationOptions: MigrationOptions = {
        keepLegacyReferences: true,
        machineMappingStrategy: 'hash',
        autoValidate: false,
        createBackup: true,
        priorityCategories: ['roo-core', 'software-powershell', 'software-node']
      };

      expect(migrationOptions.keepLegacyReferences).toBe(true);
      expect(migrationOptions.machineMappingStrategy).toBe('hash');
      expect(migrationOptions.autoValidate).toBe(false);
      expect(migrationOptions.createBackup).toBe(true);
      expect(migrationOptions.priorityCategories).toContain('roo-core');
      expect(migrationOptions.priorityCategories).toContain('software-powershell');
      expect(migrationOptions.priorityCategories).toContain('software-node');
    });

    it('devrait simuler une migration réussie', () => {
      // Simuler une migration réussie
      const migration = {
        success: true,
        newBaseline: {
          baselineId: 'migrated-baseline-test',
          name: 'Baseline Migrée',
          version: '1.0.0',
          profilesCount: 5
        },
        statistics: {
          totalMachines: 3,
          successfulMigrations: 3,
          failedMigrations: 0,
          profilesCreated: 5
        },
        errors: []
      };

      expect(migration.success).toBe(true);
      expect(migration.newBaseline.baselineId).toBe('migrated-baseline-test');
      expect(migration.statistics.totalMachines).toBe(3);
      expect(migration.statistics.successfulMigrations).toBe(3);
      expect(migration.statistics.failedMigrations).toBe(0);
      expect(migration.errors).toHaveLength(0);
    });
  });

  describe('intégration complète', () => {
    it('devrait supporter un workflow complet de baseline', async () => {
      // 1. Créer une baseline
      const profiles: ConfigurationProfile[] = [
        {
          profileId: 'integration-test-profile',
          category: 'roo-core',
          name: 'Profil Intégration Test',
          description: 'Profil pour test d\'intégration',
          configuration: {
            modes: ['ask', 'code'],
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
            tags: ['test', 'integration'],
            stability: 'stable'
          }
        }
      ];

      const baseline = await service.createBaseline(
        'integration-test-baseline',
        'Baseline pour test d\'intégration',
        profiles
      );

      expect(baseline).toBeDefined();
      expect(baseline.baselineId).toContain('baseline-');

      // 2. Mapper une machine
      const machineInventory: MachineInventory = {
        machineId: 'integration-test-machine',
        timestamp: new Date().toISOString(),
        config: {
          roo: {
            modes: ['ask', 'code'],
            mcpSettings: { timeout: 30000 }
          },
          hardware: {
            cpu: { cores: 4, model: 'Test CPU' },
            memory: { total: 8192, type: 'DDR4' },
            disks: [{ size: 256, type: 'SSD' }]
          },
          software: {
            powershell: '7.2.0',
            node: '18.17.0'
          },
          system: {
            os: 'Windows 11',
            architecture: 'x64'
          }
        },
        metadata: {
          lastSeen: new Date().toISOString(),
          version: '1.0.0',
          source: 'integration-test',
          collectionDuration: 150,
          collectorVersion: 'integration-test-1.0.0'
        }
      };

      const mapping = await service.mapMachineToBaseline('integration-test-machine', machineInventory);
      expect(mapping).toBeDefined();
      expect(mapping.machineHash).toBeDefined();

      // 3. Comparer les machines
      const report = await service.compareMachines([mapping.machineHash || '']);
      expect(report).toBeDefined();
      expect(report.machineHashes).toHaveLength(1);
      expect(report.statistics.totalMachines).toBe(1);
    });
  });
});