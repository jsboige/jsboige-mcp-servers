/**
 * Tests unitaires pour NonNominativeBaselineService
 *
 * Ce fichier contient les tests unitaires pour valider le fonctionnement
 * du service de baseline non-nominatif.
 *
 * Renforcement #2639 (lot 4, rang 12) : chaque assertion porte une valeur
 * vérifiée contre la source (NonNominativeBaselineService.ts +
 * ProfileApplicabilityHelper.ts). Les anciens tests d'« export » et de
 * « migration simulée » construisaient leurs propres objets et n'avaient
 * aucune valeur de vérification — remplacés par le contrat de persistance
 * réel (fichiers écrits dans sharedPath) et par migrateFromLegacy réel.
 *
 * @module non-nominative-baseline-test
 * @version 1.1.0
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
import type { BaselineConfig } from '../../../../src/types/baseline';
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/** Profil roo-core minimal réutilisable (roo-core = toujours applicable, helper l.24-26). */
function makeProfile(profileId: string, configuration: Record<string, unknown> = { modes: ['ask', 'code'] }): ConfigurationProfile {
  return {
    profileId,
    category: 'roo-core',
    name: `Profil ${profileId}`,
    description: 'Profil de test',
    configuration,
    priority: 100,
    compatibility: { requiredProfiles: [], conflictingProfiles: [], optionalProfiles: [] },
    metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: '1.0.0', tags: [], stability: 'stable' }
  };
}

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

  describe('generateMachineHash (contrat non-nominatif)', () => {
    it('devrait produire un hash sha256 tronqué déterministe de 16 caractères hex', () => {
      const h1 = service.generateMachineHash('test-machine-001');
      const h2 = service.generateMachineHash('test-machine-001');
      const other = service.generateMachineHash('test-machine-002');

      // sha256(machineId + 'roosync-salt-2024').hex.substring(0, 16) — service l.81-86
      expect(h1).toMatch(/^[a-f0-9]{16}$/);
      expect(h2).toBe(h1); // déterministe : même entrée, même hash
      expect(other).toMatch(/^[a-f0-9]{16}$/);
      expect(other).not.toBe(h1); // machines distinctes → hashes distincts
    });
  });

  describe('createBaseline', () => {
    it('devrait créer une baseline non-nominative avec des profils valides', async () => {
      const baseline = await service.createBaseline(
        'test-baseline',
        'Baseline de test pour validation',
        [makeProfile('profile-roo-core-test', { modes: ['ask', 'code', 'architect'], mcpSettings: { timeout: 30000 } })]
      );

      // ID : `baseline-${Date.now()}-${random36}` — service l.96
      expect(baseline.baselineId).toMatch(/^baseline-\d+-[a-z0-9]{1,9}$/);
      expect(baseline.name).toBe('test-baseline');
      expect(baseline.description).toBe('Baseline de test pour validation');
      expect(baseline.version).toBe('1.0.0'); // service l.100
      expect(baseline.profiles).toHaveLength(1);
      expect(baseline.profiles[0].profileId).toBe('profile-roo-core-test');
      // Règles d'agrégation par défaut exactes — service l.104-108
      expect(baseline.aggregationRules).toEqual({
        defaultPriority: 100,
        conflictResolution: 'highest_priority',
        autoMergeCategories: ['roo-core', 'software-powershell', 'software-node', 'software-python']
      });
      // Métadonnées système exactes — service l.109-116
      expect(baseline.metadata).toMatchObject({
        createdBy: 'system',
        lastModifiedBy: 'system',
        tags: ['auto-generated'],
        status: 'active'
      });
      expect(baseline.metadata.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('devrait rejeter une baseline avec des profils invalides', async () => {
      const invalidProfiles = [makeProfile('')]; // ID vide → profil invalide

      await expect(
        service.createBaseline('invalid-baseline', 'Baseline invalide', invalidProfiles)
      ).rejects.toThrow('Profil invalide: champs requis manquants'); // service l.997
    });
  });

  describe('mapMachineToBaseline', () => {
    it('devrait mapper une machine à la baseline avec succès', async () => {
      const baseline = await service.createBaseline('active-baseline', 'Active Baseline', [makeProfile('profile-roo-core-test')]);

      const testMachineId = 'test-machine-001';
      const expectedHash = service.generateMachineHash(testMachineId);
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

      // Identifiants : `mapping-${machineHash}-${Date.now()}` — service l.493
      expect(mapping.machineHash).toBe(expectedHash);
      expect(mapping.mappingId).toMatch(new RegExp(`^mapping-${expectedHash}-\\d+$`));
      expect(mapping.baselineId).toBe(baseline.baselineId);
      // roo-core = toujours applicable (helper l.24-26) → le profil unique est appliqué
      expect(mapping.appliedProfiles).toHaveLength(1);
      expect(mapping.appliedProfiles[0]).toMatchObject({
        profileId: 'profile-roo-core-test',
        category: 'roo-core',
        source: 'auto'
      });
      // Deviation attendue : l'état réel porte mcpSettings absent du profil attendu
      // (comparaison JSON.stringify stricte, service l.666-668) → catégorie roo-*
      // = IMPORTANT (service l.679-681) → confiance = 1 - 0.1*1 = 0.9 (l.698)
      expect(mapping.deviations).toHaveLength(1);
      expect(mapping.deviations[0]).toMatchObject({ category: 'roo-core', severity: 'IMPORTANT' });
      expect(mapping.metadata.confidence).toBe(0.9);

      // Persistance réelle : machine-mappings.json écrit dans sharedPath (l.1059-1086)
      const mappingsPath = join(testSharedPath, 'machine-mappings.json');
      expect(existsSync(mappingsPath)).toBe(true);
      const persisted = JSON.parse(readFileUtf8(mappingsPath));
      expect(persisted).toHaveLength(1);
      expect(persisted[0].machineHash).toBe(expectedHash);
    });

    it('devrait gérer les machines avec des configurations incomplètes', async () => {
      await service.createBaseline('active-baseline', 'Active Baseline', [makeProfile('profile-roo-core-test')]);

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

      // modes ['ask'] != modes attendus ['ask','code'] → exactement 1 deviation roo-core
      expect(mapping.deviations).toHaveLength(1);
      expect(mapping.deviations[0]).toMatchObject({ category: 'roo-core', severity: 'IMPORTANT' });
    });
  });

  describe('compareMachines', () => {
    it('devrait comparer plusieurs machines et générer un rapport', async () => {
      const baseline = await service.createBaseline('active-baseline', 'Active Baseline', [makeProfile('profile-roo-core-test')]);

      const machineHashes = ['hash-001', 'hash-002', 'hash-003'];
      const report = await service.compareMachines(machineHashes);

      // Rapport : `comparison-${Date.now()}` — service l.715
      expect(report.reportId).toMatch(/^comparison-\d+$/);
      expect(report.baselineId).toBe(baseline.baselineId);
      expect(report.machineHashes).toEqual(machineHashes);
      // Aucun mapping enregistré pour ces hashes → aucune difference agrégée :
      // statistiques exactes du constructeur (service l.744-761)
      expect(report.statistics).toEqual({
        totalMachines: 3,
        totalDifferences: 0,
        differencesBySeverity: { CRITICAL: 0, IMPORTANT: 0, WARNING: 0, INFO: 0 },
        differencesByCategory: {},
        // 1 - 0/(3*1 profil) : des machines inconnues ne produisent aucune deviation
        complianceRate: 1
      });
      expect(report.metadata).toMatchObject({ generatedBy: 'system', version: '2.2.0' }); // service l.775-779
    });

    it('devrait agréger les deviations réelles des machines mappées', async () => {
      const baseline = await service.createBaseline('active-baseline', 'Active Baseline', [makeProfile('profile-roo-core-test')]);

      const inventory: MachineInventory = {
        machineId: 'known-machine',
        timestamp: new Date().toISOString(),
        config: { roo: { modes: ['ask'] } },
        metadata: { lastSeen: new Date().toISOString(), version: '1.0.0', source: 'test', collectionDuration: 10, collectorVersion: 't' }
      };
      const mapping = await service.mapMachineToBaseline('known-machine', inventory);

      const report = await service.compareMachines([mapping.machineHash]);

      // La deviation IMPORTANT roo-core du mapping apparaît dans le rapport
      expect(report.statistics.totalDifferences).toBe(1);
      expect(report.statistics.differencesBySeverity).toEqual({ CRITICAL: 0, IMPORTANT: 1, WARNING: 0, INFO: 0 });
      expect(report.statistics.differencesByCategory).toEqual({ 'roo-core': 1 });
      expect(report.differencesByCategory['roo-core']).toHaveLength(1);
      expect(report.differencesByCategory['roo-core'][0]).toMatchObject({
        machineHash: mapping.machineHash,
        severity: 'IMPORTANT'
      });
      // 1 - 1/(1 machine * 1 profil) = 0
      expect(report.statistics.complianceRate).toBe(0);
    });

    it('devrait gérer une liste vide de machines', async () => {
      await service.createBaseline('active-baseline', 'Active Baseline', [makeProfile('profile-roo-core-test')]);

      const report = await service.compareMachines([]);

      expect(report.machineHashes).toEqual([]);
      expect(report.statistics.totalMachines).toBe(0);
      expect(report.statistics.complianceRate).toBe(0); // liste vide → 0 par construction (service l.760-761)
    });
  });

  describe('validateBaseline', () => {
    it('devrait valider une baseline correcte', async () => {
      const baseline = await service.createBaseline(
        'validation-test-baseline',
        'Baseline pour tester la validation',
        [makeProfile('profile-validation-test')]
      );

      expect(baseline.baselineId).toMatch(/^baseline-\d+-[a-z0-9]{1,9}$/);
      expect(baseline.profiles).toHaveLength(1);
      expect(baseline.profiles[0].profileId).toBe('profile-validation-test');
    });

    it('devrait créer une baseline même avec des profils conflictuels (validation séparée)', async () => {
      const p1 = makeProfile('profile-conflict-1');
      const p2 = makeProfile('profile-conflict-2');
      p1.compatibility.conflictingProfiles = ['profile-conflict-2'];
      p2.compatibility.conflictingProfiles = ['profile-conflict-1'];

      const baseline = await service.createBaseline('conflict-baseline', 'Baseline avec conflits', [p1, p2]);

      // La validation ne rejette pas les conflits (seuls les champs requis sont vérifiés, l.983-1004)
      expect(baseline.profiles).toHaveLength(2);
      expect(baseline.profiles.map(p => p.profileId)).toEqual(['profile-conflict-1', 'profile-conflict-2']);
    });
  });

  describe('persistance (contrat de sérialisation)', () => {
    // L'ancien bloc « exportBaseline » construisait ses propres objets jsonExport/csvExport
    // puis les assertait : zéro appel au service. Le service n'a PAS de méthode d'export —
    // sa sérialisation réelle est l'écriture des fichiers JSON dans sharedPath.

    it('devrait persister la baseline, les mappings et l\'état dans sharedPath', async () => {
      const baseline = await service.createBaseline(
        'export-test-baseline',
        'Baseline pour tester la sérialisation',
        [makeProfile('profile-export-test')]
      );

      // 1. Baseline : non-nominative-baseline.json (service l.47, l.1044-1054)
      const baselinePath = join(testSharedPath, 'non-nominative-baseline.json');
      expect(existsSync(baselinePath)).toBe(true);
      const persistedBaseline = JSON.parse(readFileUtf8(baselinePath));
      expect(persistedBaseline.baselineId).toBe(baseline.baselineId);
      expect(persistedBaseline.version).toBe('1.0.0');
      expect(persistedBaseline.profiles).toHaveLength(1);
      expect(persistedBaseline.profiles[0].profileId).toBe('profile-export-test');
      expect(persistedBaseline.aggregationRules.conflictResolution).toBe('highest_priority');

      // 2. État : non-nominative-state.json avec les compteurs à jour (l.1105-1112)
      const statePath = join(testSharedPath, 'non-nominative-state.json');
      expect(existsSync(statePath)).toBe(true);
      const persistedState = JSON.parse(readFileUtf8(statePath));
      expect(persistedState.statistics.totalBaselines).toBe(1);
      expect(persistedState.statistics.totalProfiles).toBe(0); // compteur non incrémenté par createBaseline
      expect(persistedState.activeBaseline.baselineId).toBe(baseline.baselineId);

      // 3. Mappings : fichier créé au premier mapMachineToBaseline (l.1059-1086)
      const mappingsPath = join(testSharedPath, 'machine-mappings.json');
      expect(existsSync(mappingsPath)).toBe(false); // aucun mapping → fichier non écrit
      const inventory: MachineInventory = {
        machineId: 'machine-persist',
        timestamp: new Date().toISOString(),
        config: { roo: { modes: ['ask'] } },
        metadata: { lastSeen: new Date().toISOString(), version: '1.0.0', source: 'test', collectionDuration: 1, collectorVersion: 't' }
      };
      await service.mapMachineToBaseline('machine-persist', inventory);
      expect(existsSync(mappingsPath)).toBe(true);
      const persistedMappings = JSON.parse(readFileUtf8(mappingsPath));
      expect(persistedMappings).toHaveLength(1);
      expect(persistedMappings[0].machineHash).toBe(service.generateMachineHash('machine-persist'));
      // totalMachines suit les mappings enregistrés (l.516)
      expect(JSON.parse(readFileUtf8(statePath)).statistics.totalMachines).toBe(1);
    });
  });

  describe('migration (migrateFromLegacy réel)', () => {
    // L'ancien bloc fabriquait un objet « migration réussie » local et l'assertait.
    // Le service expose migrateFromLegacy (l.791-865) — testé ici pour de vrai.

    function makeLegacyBaseline(): BaselineConfig {
      return {
        machineId: 'legacy-machine-1',
        config: {
          roo: {
            modes: ['ask', 'code'],
            mcpSettings: { timeout: 60000 },
            userSettings: {}
          },
          hardware: {
            cpu: { model: 'Intel i7', cores: 8, threads: 16 },
            memory: { total: 16384 },
            disks: []
          },
          software: { powershell: '7.2.0', node: '18.17.0', python: '3.11.0' },
          system: { os: 'Windows 11', architecture: 'x64' }
        },
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };
    }

    it('devrait migrer une baseline legacy vers 2 profils avec backup', async () => {
      const legacy = makeLegacyBaseline();
      const options: MigrationOptions = {
        keepLegacyReferences: true,
        machineMappingStrategy: 'hash',
        autoValidate: false,
        createBackup: true,
        priorityCategories: ['roo-core']
      };

      const result = await service.migrateFromLegacy(legacy, options);

      // Succès sans machines legacy à migrer → aucune erreur (l.836-853)
      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.migratedMachines).toEqual([]);

      // extractProfilesFromLegacy (l.870-931) : exactement 2 profils depuis BaselineConfig
      expect(result.newBaseline.profiles).toHaveLength(2);
      const [rooProfile, cpuProfile] = result.newBaseline.profiles;
      expect(rooProfile.profileId).toMatch(/^profile-roo-core-\d+$/);
      expect(rooProfile).toMatchObject({
        category: 'roo-core',
        name: 'Profil Roo Core (migré)',
        configuration: { modes: ['ask', 'code'], mcpSettings: { timeout: 60000 } }
      });
      expect(rooProfile.metadata.tags).toEqual(['migrated', 'legacy']);
      expect(cpuProfile.profileId).toMatch(/^profile-hardware-cpu-\d+$/);
      expect(cpuProfile).toMatchObject({
        category: 'hardware-cpu',
        name: 'Profil CPU (migré)',
        // La configuration CPU est l'objet legacy tel quel (l.911)
        configuration: { model: 'Intel i7', cores: 8, threads: 16 }
      });

      // Statistiques exactes : sans clé `machines`, totalMachines = 1 (l.842)
      expect(result.statistics).toEqual({
        totalMachines: 1,
        successfulMigrations: 0,
        failedMigrations: 0,
        profilesCreated: 2,
        deviationsDetected: 0
      });
      expect(result.metadata).toMatchObject({ migratedBy: 'system' });
      expect(result.metadata.migratedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Backup legacy écrit quand createBackup: true (l.974-978)
      const backupFiles = readdirSync(testSharedPath).filter(f => /^legacy-backup-\d+\.json$/.test(f));
      expect(backupFiles).toHaveLength(1);
      expect(JSON.parse(readFileUtf8(join(testSharedPath, backupFiles[0])))).toEqual(legacy);

      // La baseline migrée devient la baseline active persistée
      expect(service.getActiveBaseline()?.baselineId).toBe(result.newBaseline.baselineId);
    });

    it('devrait migrer sans backup quand createBackup est faux', async () => {
      const result = await service.migrateFromLegacy(makeLegacyBaseline(), {
        keepLegacyReferences: false,
        machineMappingStrategy: 'hash',
        autoValidate: false,
        createBackup: false,
        priorityCategories: []
      });

      expect(result.success).toBe(true);
      const backupFiles = readdirSync(testSharedPath).filter(f => /^legacy-backup-\d+\.json$/.test(f));
      expect(backupFiles).toHaveLength(0);
    });
  });

  describe('intégration complète', () => {
    it('devrait supporter un workflow complet de baseline', async () => {
      // 1. Créer une baseline dont la configuration correspond exactement à l'inventaire
      //    (modes + mcpSettings identiques → aucune deviation attendue)
      const baseline = await service.createBaseline(
        'integration-test-baseline',
        'Baseline pour test d\'intégration',
        [makeProfile('integration-test-profile', { modes: ['ask', 'code'], mcpSettings: { timeout: 30000 } })]
      );
      expect(baseline.baselineId).toMatch(/^baseline-\d+-[a-z0-9]{1,9}$/);

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

      const expectedHash = service.generateMachineHash('integration-test-machine');
      const mapping = await service.mapMachineToBaseline('integration-test-machine', machineInventory);
      expect(mapping.machineHash).toBe(expectedHash);
      // État réel = état attendu (modes + mcpSettings) → zéro deviation, confiance 1.0
      expect(mapping.deviations).toHaveLength(0);
      expect(mapping.metadata.confidence).toBe(1);

      // 3. Comparer les machines : rapport exact pour 1 machine conforme sur 1 profil
      const report = await service.compareMachines([mapping.machineHash]);
      expect(report.machineHashes).toEqual([expectedHash]);
      expect(report.statistics).toEqual({
        totalMachines: 1,
        totalDifferences: 0,
        differencesBySeverity: { CRITICAL: 0, IMPORTANT: 0, WARNING: 0, INFO: 0 },
        differencesByCategory: {},
        complianceRate: 1
      });
    });
  });

  describe('aggregateByMajority', () => {
    it('devrait retourner la valeur la plus fréquente pour des primitives', async () => {
      const testInventories: MachineInventory[] = [
        { machineId: 'machine-1', config: { software: { powershell: '7.2.0', node: '18.17.0', python: '3.11.0' } }, metadata: { lastSeen: new Date().toISOString(), version: '1.0.0' } },
        { machineId: 'machine-2', config: { software: { powershell: '7.2.0', node: '18.17.0', python: '3.11.0' } }, metadata: { lastSeen: new Date().toISOString(), version: '1.0.0' } },
        { machineId: 'machine-3', config: { software: { powershell: '7.3.0', node: '18.17.0', python: '3.11.0' } }, metadata: { lastSeen: new Date().toISOString(), version: '1.0.0' } }
      ];

      const aggregationConfig = {
        sources: [{ type: 'machine_inventory', weight: 1, enabled: true }],
        categoryRules: {
          'software-powershell': { strategy: 'majority', confidenceThreshold: 0.7, autoApply: true },
          'software-node': { strategy: 'majority', confidenceThreshold: 0.7, autoApply: true },
          'software-python': { strategy: 'majority', confidenceThreshold: 0.7, autoApply: true }
        },
        thresholds: { deviationThreshold: 0.2, complianceThreshold: 0.8, outlierDetection: false }
      } as AggregationConfig;

      const baseline = await service.aggregateBaseline(testInventories, aggregationConfig);

      // Seules les catégories logicielles sont présentes dans les inventaires → 3 profils exactement
      expect(baseline.name).toBe('Baseline agrégée automatiquement'); // service l.161-165
      expect(baseline.profiles).toHaveLength(3);
      expect(baseline.profiles.map(p => p.category)).toEqual(
        expect.arrayContaining(['software-powershell', 'software-node', 'software-python'])
      );
      for (const p of baseline.profiles) {
        expect(p.profileId).toMatch(new RegExp(`^profile-${p.category}-\\d+$`)); // service l.298
        expect(p.metadata).toMatchObject({ tags: ['auto-generated', 'aggregated'], stability: 'stable' }); // l.315-316
      }

      // Versions majoritaires mesurées : powershell 2/3, node 3/3, python 3/3
      const byCategory = new Map(baseline.profiles.map(p => [p.category as string, p]));
      expect(byCategory.get('software-powershell')?.configuration.version).toBe('7.2.0');
      expect(byCategory.get('software-node')?.configuration.version).toBe('18.17.0');
      expect(byCategory.get('software-python')?.configuration.version).toBe('3.11.0');
    });

    it('devrait gérer les objets imbriqués', async () => {
      const testInventories: MachineInventory[] = [
        { machineId: 'machine-1', config: { roo: { modes: ['ask', 'code'], mcpSettings: { timeout: 30000 } } }, metadata: { lastSeen: new Date().toISOString(), version: '1.0.0' } },
        { machineId: 'machine-2', config: { roo: { modes: ['ask', 'code'], mcpSettings: { timeout: 30000 } } }, metadata: { lastSeen: new Date().toISOString(), version: '1.0.0' } },
        { machineId: 'machine-3', config: { roo: { modes: ['ask', 'architect'], mcpSettings: { timeout: 30000 } } }, metadata: { lastSeen: new Date().toISOString(), version: '1.0.0' } }
      ];

      const aggregationConfig = {
        sources: [{ type: 'machine_inventory', weight: 1, enabled: true }],
        categoryRules: {
          // Seule règle : roo-core. La catégorie roo-advanced est collectée (l.188-199)
          // mais sans règle → generateProfileForCategory renvoie null → 1 profil exactement.
          'roo-core': { strategy: 'majority', confidenceThreshold: 0.7, autoApply: true }
        },
        thresholds: { deviationThreshold: 0.2, complianceThreshold: 0.8, outlierDetection: false }
      } as AggregationConfig;

      const baseline = await service.aggregateBaseline(testInventories, aggregationConfig);

      expect(baseline.profiles).toHaveLength(1);
      expect(baseline.profiles[0].category).toBe('roo-core');
      // Majorité par propriété (l.336-365) : modes 2/3, mcpSettings 3/3
      expect(baseline.profiles[0].configuration).toEqual({ modes: ['ask', 'code'], mcpSettings: { timeout: 30000 } });
    });
  });

  describe('aggregateByWeightedAverage', () => {
    it('devrait calculer la moyenne pour les valeurs numériques', async () => {
      const testInventories: MachineInventory[] = [
        { machineId: 'machine-1', config: { hardware: { cpu: { cores: 4, model: 'Intel i5' }, memory: { total: 8192, type: 'DDR4' } } }, metadata: { lastSeen: new Date().toISOString(), version: '1.0.0' } },
        { machineId: 'machine-2', config: { hardware: { cpu: { cores: 8, model: 'Intel i7' }, memory: { total: 16384, type: 'DDR4' } } }, metadata: { lastSeen: new Date().toISOString(), version: '1.0.0' } },
        { machineId: 'machine-3', config: { hardware: { cpu: { cores: 16, model: 'Intel i9' }, memory: { total: 32768, type: 'DDR4' } } }, metadata: { lastSeen: new Date().toISOString(), version: '1.0.0' } }
      ];

      const aggregationConfig = {
        sources: [{ type: 'machine_inventory', weight: 1, enabled: true }],
        categoryRules: {
          'hardware-cpu': { strategy: 'weighted_average', confidenceThreshold: 0.7, autoApply: true },
          'hardware-memory': { strategy: 'weighted_average', confidenceThreshold: 0.7, autoApply: true }
        },
        thresholds: { deviationThreshold: 0.2, complianceThreshold: 0.8, outlierDetection: false }
      } as AggregationConfig;

      const baseline = await service.aggregateBaseline(testInventories, aggregationConfig);

      // Règles cpu + memory uniquement → 2 profils exactement
      expect(baseline.profiles).toHaveLength(2);
      const byCategory = new Map(baseline.profiles.map(p => [p.category as string, p]));
      // Moyennes numériques (l.407-410) : cores (4+8+16)/3 = 9.33, total (8192+16384+32768)/3 = 19114.67
      expect(byCategory.get('hardware-cpu')?.configuration.cores).toBeCloseTo(9.33, 1);
      expect(byCategory.get('hardware-memory')?.configuration.total).toBeCloseTo(19114.67, 1);
      // Les chaînes passent par la majorité (l.412-429) : 3 modèles distincts à 1 occurrence
      // → la première valeur l'emporte (maxCount initialisé à 0, valeurs[0] conservée)
      expect(byCategory.get('hardware-cpu')?.configuration.model).toBe('Intel i5');
    });

    it('devrait utiliser la majorité pour les chaînes de caractères', async () => {
      const testInventories: MachineInventory[] = [
        { machineId: 'machine-1', config: { system: { os: 'Windows 11', architecture: 'x64' } }, metadata: { lastSeen: new Date().toISOString(), version: '1.0.0' } },
        { machineId: 'machine-2', config: { system: { os: 'Windows 11', architecture: 'x64' } }, metadata: { lastSeen: new Date().toISOString(), version: '1.0.0' } },
        { machineId: 'machine-3', config: { system: { os: 'Windows 10', architecture: 'x64' } }, metadata: { lastSeen: new Date().toISOString(), version: '1.0.0' } }
      ];

      const aggregationConfig = {
        sources: [{ type: 'machine_inventory', weight: 1, enabled: true }],
        categoryRules: {
          'system-os': { strategy: 'weighted_average', confidenceThreshold: 0.7, autoApply: true },
          'system-architecture': { strategy: 'weighted_average', confidenceThreshold: 0.7, autoApply: true }
        },
        thresholds: { deviationThreshold: 0.2, complianceThreshold: 0.8, outlierDetection: false }
      } as AggregationConfig;

      const baseline = await service.aggregateBaseline(testInventories, aggregationConfig);

      expect(baseline.profiles).toHaveLength(2);
      const byCategory = new Map(baseline.profiles.map(p => [p.category as string, p]));
      // Chaînes sous weighted_average → majorité : os 2/3, arch 3/3 (l.412-429)
      expect(byCategory.get('system-os')?.configuration.os).toBe('Windows 11');
      expect(byCategory.get('system-architecture')?.configuration.arch).toBe('x64');
    });

    it('devrait gérer les données mixtes (numériques et chaînes)', async () => {
      const testInventories: MachineInventory[] = [
        { machineId: 'machine-1', config: { hardware: { cpu: { cores: 4, model: 'Intel i5' }, memory: { total: 8192, type: 'DDR4' } } }, metadata: { lastSeen: new Date().toISOString(), version: '1.0.0' } },
        { machineId: 'machine-2', config: { hardware: { cpu: { cores: 8, model: 'Intel i7' }, memory: { total: 16384, type: 'DDR4' } } }, metadata: { lastSeen: new Date().toISOString(), version: '1.0.0' } }
      ];

      const aggregationConfig = {
        sources: [{ type: 'machine_inventory', weight: 1, enabled: true }],
        categoryRules: {
          'hardware-cpu': { strategy: 'weighted_average', confidenceThreshold: 0.7, autoApply: true }
        },
        thresholds: { deviationThreshold: 0.2, complianceThreshold: 0.8, outlierDetection: false }
      } as AggregationConfig;

      const baseline = await service.aggregateBaseline(testInventories, aggregationConfig);

      expect(baseline.profiles).toHaveLength(1);
      const cpuProfile = baseline.profiles[0];
      // cores est numérique → moyenne exacte (4+8)/2 = 6 ; model est une chaîne → majorité
      // entre 2 valeurs distinctes → première valeur (l.419-426)
      expect(cpuProfile.configuration.cores).toBe(6);
      expect(cpuProfile.configuration.model).toBe('Intel i5');
    });
  });

  describe('edge cases agrégation', () => {
    it('devrait gérer un tableau vide', async () => {
      const aggregationConfig = {
        sources: [{ type: 'machine_inventory', weight: 1, enabled: true }],
        categoryRules: { 'roo-core': { strategy: 'majority', confidenceThreshold: 0.7, autoApply: true } },
        thresholds: { deviationThreshold: 0.2, complianceThreshold: 0.8, outlierDetection: false }
      } as AggregationConfig;

      const baseline = await service.aggregateBaseline([], aggregationConfig);

      // Aucun inventaire → aucune catégorie collectée → baseline vide (l.148-165)
      expect(baseline.profiles).toHaveLength(0);
    });

    it('devrait gérer un seul élément', async () => {
      const testInventories: MachineInventory[] = [
        { machineId: 'machine-1', config: { software: { powershell: '7.2.0', node: '18.17.0', python: '3.11.0' } }, metadata: { lastSeen: new Date().toISOString(), version: '1.0.0' } }
      ];

      const aggregationConfig = {
        sources: [{ type: 'machine_inventory', weight: 1, enabled: true }],
        categoryRules: { 'software-powershell': { strategy: 'majority', confidenceThreshold: 0.7, autoApply: true } },
        thresholds: { deviationThreshold: 0.2, complianceThreshold: 0.8, outlierDetection: false }
      } as AggregationConfig;

      const baseline = await service.aggregateBaseline(testInventories, aggregationConfig);

      // 1 seule règle → 1 profil, valeur unique passée telle quelle (l.331-333)
      expect(baseline.profiles).toHaveLength(1);
      expect(baseline.profiles[0].category).toBe('software-powershell');
      expect(baseline.profiles[0].configuration.version).toBe('7.2.0');
    });
  });
});

/** Lecture UTF-8 synchrone (les fichiers de persistance sont écrits en UTF-8 par fs.writeFile). */
function readFileUtf8(p: string): string {
  return readFileSync(p, 'utf-8');
}
