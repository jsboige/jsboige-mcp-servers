/**
 * Tests unitaires pour les outils MCP de baseline non-nominative
 * 
 * Ce fichier contient les tests unitaires pour valider le fonctionnement
 * des outils MCP liés au système de baseline non-nominatif.
 * 
 * @module non-nominative-tools-test
 * @version 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  create_non_nominative_baseline,
  map_machine_to_non_nominative_baseline,
  compare_machines_non_nominative,
  migrate_to_non_nominative,
  get_non_nominative_baseline_state,
  validate_non_nominative_baseline,
  export_non_nominative_baseline
} from '../../../../src/tools/non-nominative-baseline-tools';

// Mock du service RooSync
const mockRooSyncService = {
  createNonNominativeBaseline: vi.fn(),
  mapMachineToNonNominativeBaseline: vi.fn(),
  compareMachinesNonNominative: vi.fn(),
  migrateToNonNominative: vi.fn(),
  getNonNominativeState: vi.fn(),
  getActiveNonNominativeBaseline: vi.fn(),
  getNonNominativeMachineMappings: vi.fn()
};

// Mock de getRooSyncService
vi.mock('../../../../src/services/RooSyncService.js', () => ({
  getRooSyncService: () => mockRooSyncService
}));

describe('Outils MCP de baseline non-nominative', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('create_non_nominative_baseline', () => {
    it('devrait avoir la bonne structure d\'outil MCP', () => {
      expect(create_non_nominative_baseline).toBeDefined();
      expect(create_non_nominative_baseline.name).toBe('create_non_nominative_baseline');
      expect(create_non_nominative_baseline.description).toBe(
        'Crée une baseline non-nominative par agrégation automatique des configurations existantes'
      );
      expect(create_non_nominative_baseline.inputSchema).toBeDefined();
      expect(create_non_nominative_baseline.handler).toBeDefined();
      expect(typeof create_non_nominative_baseline.handler).toBe('function');
    });

    it('devrait créer une baseline avec des paramètres valides', async () => {
      const args = {
        name: 'Test Baseline',
        description: 'Baseline de test',
        aggregationConfig: {
          sources: [
            { type: 'machine_inventory', weight: 1.0, enabled: true }
          ]
        }
      };

      const expectedBaseline = {
        baselineId: 'test-baseline-001',
        version: '1.0.0',
        name: 'Test Baseline',
        description: 'Baseline de test',
        profiles: [
          {
            profileId: 'profile-test',
            category: 'roo-core',
            configuration: { modes: ['ask', 'code'] }
          }
        ],
        metadata: {
          createdAt: new Date().toISOString(),
          status: 'active'
        }
      };

      mockRooSyncService.createNonNominativeBaseline.mockResolvedValue(expectedBaseline);

      const result = await create_non_nominative_baseline.handler(args);

      expect(mockRooSyncService.createNonNominativeBaseline).toHaveBeenCalledWith(
        args.name,
        args.description,
        args.aggregationConfig
      );
      expect(result.success).toBe(true);
      expect(result.baseline?.baselineId).toBe('test-baseline-001');
      expect(result.baseline?.name).toBe('Test Baseline');
      expect(result.baseline?.profilesCount).toBe(1);
    });

    it('devrait gérer les erreurs de création', async () => {
      const args = {
        name: 'Test Baseline',
        description: 'Baseline de test'
      };

      const errorMessage = 'Service indisponible';
      mockRooSyncService.createNonNominativeBaseline.mockRejectedValue(
        new Error(errorMessage)
      );

      const result = await create_non_nominative_baseline.handler(args);

      expect(result.success).toBe(false);
      expect(result.error).toBe(errorMessage);
      expect(result.message).toContain('Échec de la création de la baseline');
    });
  });

  describe('map_machine_to_non_nominative_baseline', () => {
    it('devrait avoir la bonne structure d\'outil MCP', () => {
      expect(map_machine_to_non_nominative_baseline).toBeDefined();
      expect(map_machine_to_non_nominative_baseline.name).toBe('map_machine_to_non_nominative_baseline');
      expect(map_machine_to_non_nominative_baseline.description).toBe(
        'Mappe une machine spécifique à la baseline non-nominative active'
      );
      expect(map_machine_to_non_nominative_baseline.inputSchema).toBeDefined();
      expect(map_machine_to_non_nominative_baseline.handler).toBeDefined();
    });

    it('devrait mapper une machine avec succès', async () => {
      const args = { machineId: 'test-machine-001' };

      const expectedMapping = {
        mappingId: 'mapping-001',
        machineHash: 'hash-abc123',
        baselineId: 'baseline-001',
        appliedProfiles: [
          {
            profileId: 'profile-test',
            category: 'roo-core',
            appliedAt: new Date().toISOString(),
            source: 'auto'
          }
        ],
        deviations: [],
        metadata: {
          confidence: 0.95,
          lastSeen: new Date().toISOString()
        }
      };

      mockRooSyncService.mapMachineToNonNominativeBaseline.mockResolvedValue(expectedMapping);

      const result = await map_machine_to_non_nominative_baseline.handler(args);

      expect(mockRooSyncService.mapMachineToNonNominativeBaseline).toHaveBeenCalledWith(
        args.machineId
      );
      expect(result.success).toBe(true);
      expect(result.mapping?.machineHash).toBe('hash-abc123');
      expect(result.mapping?.appliedProfiles).toHaveLength(1);
      expect(result.deviations).toHaveLength(0);
    });

    it('devrait gérer les erreurs de mapping', async () => {
      const args = { machineId: 'invalid-machine' };

      mockRooSyncService.mapMachineToNonNominativeBaseline.mockRejectedValue(
        new Error('Machine non trouvée')
      );

      const result = await map_machine_to_non_nominative_baseline.handler(args);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Machine non trouvée');
    });
  });

  describe('compare_machines_non_nominative', () => {
    it('devrait avoir la bonne structure d\'outil MCP', () => {
      expect(compare_machines_non_nominative).toBeDefined();
      expect(compare_machines_non_nominative.name).toBe('compare_machines_non_nominative');
      expect(compare_machines_non_nominative.description).toBe(
        'Compare plusieurs machines avec la baseline non-nominative active'
      );
      expect(compare_machines_non_nominative.inputSchema).toBeDefined();
      expect(compare_machines_non_nominative.handler).toBeDefined();
    });

    it('devrait comparer plusieurs machines', async () => {
      const args = {
        machineIds: ['hash-001', 'hash-002'],
        includeDetails: true
      };

      const expectedReport = {
        reportId: 'report-001',
        baselineId: 'baseline-001',
        statistics: {
          totalMachines: 2,
          totalDifferences: 1,
          complianceRate: 0.5,
          differencesBySeverity: {
            WARNING: 1,
            CRITICAL: 0
          },
          differencesByCategory: {
            'roo-core': 1
          }
        },
        differencesByCategory: {
          'roo-core': [
            {
              machineHash: 'hash-001',
              profileId: 'profile-test',
              field: 'modes',
              severity: 'WARNING',
              description: 'Mode manquant',
              expectedValue: ['ask', 'code'],
              actualValue: ['ask']
            }
          ]
        }
      };

      mockRooSyncService.compareMachinesNonNominative.mockResolvedValue(expectedReport);

      const result = await compare_machines_non_nominative.handler(args);

      expect(mockRooSyncService.compareMachinesNonNominative).toHaveBeenCalledWith(
        args.machineIds
      );
      expect(result.success).toBe(true);
      expect(result.report.totalMachines).toBe(2);
      expect(result.report.totalDifferences).toBe(1);
      expect(result.report.complianceRate).toBe(50); // 0.5 * 100
      expect(result.differences).toBeDefined();
    });

    it('devrait gérer les erreurs de comparaison', async () => {
      const args = { machineIds: ['invalid-hash'] };

      mockRooSyncService.compareMachinesNonNominative.mockRejectedValue(
        new Error('Baseline non trouvée')
      );

      const result = await compare_machines_non_nominative.handler(args);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Baseline non trouvée');
    });
  });

  describe('migrate_to_non_nominative', () => {
    it('devrait avoir la bonne structure d\'outil MCP', () => {
      expect(migrate_to_non_nominative).toBeDefined();
      expect(migrate_to_non_nominative.name).toBe('migrate_to_non_nominative');
      expect(migrate_to_non_nominative.description).toBe(
        'Migre les données depuis l\'ancien système de baseline vers le nouveau système non-nominatif'
      );
      expect(migrate_to_non_nominative.inputSchema).toBeDefined();
      expect(migrate_to_non_nominative.handler).toBeDefined();
    });

    it('devrait migrer avec succès', async () => {
      const args = {
        keepLegacyReferences: true,
        machineMappingStrategy: 'hash',
        autoValidate: false,
        createBackup: true
      };

      const expectedResult = {
        success: true,
        newBaseline: {
          baselineId: 'migrated-baseline',
          name: 'Baseline Migrée',
          version: '1.0.0',
          profiles: [
            { profileId: 'profile-1', category: 'roo-core' },
            { profileId: 'profile-2', category: 'software-powershell' }
          ]
        },
        statistics: {
          totalMachines: 5,
          successfulMigrations: 5,
          failedMigrations: 0
        },
        errors: []
      };

      mockRooSyncService.migrateToNonNominative.mockResolvedValue(expectedResult);

      const result = await migrate_to_non_nominative.handler(args);

      expect(mockRooSyncService.migrateToNonNominative).toHaveBeenCalledWith({
        keepLegacyReferences: true,
        machineMappingStrategy: 'hash',
        autoValidate: false,
        createBackup: true,
        priorityCategories: ['roo-core', 'software-powershell', 'software-node', 'software-python']
      });
      expect(result.success).toBe(true);
      expect(result.migration?.newBaseline?.baselineId).toBe('migrated-baseline');
      expect(result.migration?.statistics?.successfulMigrations).toBe(5);
    });
  });

  describe('get_non_nominative_baseline_state', () => {
    it('devrait avoir la bonne structure d\'outil MCP', () => {
      expect(get_non_nominative_baseline_state).toBeDefined();
      expect(get_non_nominative_baseline_state.name).toBe('get_non_nominative_baseline_state');
      expect(get_non_nominative_baseline_state.description).toBe(
        'Obtient l\'état actuel du système de baseline non-nominatif'
      );
      expect(get_non_nominative_baseline_state.inputSchema).toBeDefined();
      expect(get_non_nominative_baseline_state.handler).toBeDefined();
    });

    it('devrait retourner l\'état du système', async () => {
      const args = {
        includeBaseline: true,
        includeMappings: true
      };

      const mockState = {
        statistics: {
          totalBaselines: 2,
          totalProfiles: 10,
          totalMachines: 5,
          averageCompliance: 0.85
        }
      };

      const mockActiveBaseline = {
        baselineId: 'active-baseline',
        name: 'Baseline Active',
        version: '1.0.0',
        description: 'Baseline actuellement active',
        profiles: [
          { profileId: 'profile-1', category: 'roo-core' }
        ],
        metadata: {
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      };

      const mockMappings = [
        {
          mappingId: 'mapping-1',
          machineHash: 'hash-1',
          baselineId: 'active-baseline',
          appliedProfiles: [{ profileId: 'profile-1' }],
          deviations: [],
          metadata: {
            confidence: 0.9,
            lastSeen: new Date().toISOString()
          }
        }
      ];

      mockRooSyncService.getNonNominativeState.mockReturnValue(mockState);
      mockRooSyncService.getActiveNonNominativeBaseline.mockReturnValue(mockActiveBaseline);
      mockRooSyncService.getNonNominativeMachineMappings.mockReturnValue(mockMappings);

      const result = await get_non_nominative_baseline_state.handler(args);

      expect(result.success).toBe(true);
      expect(result.state.statistics.totalBaselines).toBe(2);
      expect(result.activeBaseline.baselineId).toBe('active-baseline');
      expect(result.machineMappings).toHaveLength(1);
      expect(result.machineMappings[0].machineHash).toBe('hash-1');
    });
  });

  describe('validate_non_nominative_baseline', () => {
    it('devrait avoir la bonne structure d\'outil MCP', () => {
      expect(validate_non_nominative_baseline).toBeDefined();
      expect(validate_non_nominative_baseline.name).toBe('validate_non_nominative_baseline');
      expect(validate_non_nominative_baseline.description).toBe(
        'Valide la cohérence d\'une baseline non-nominative'
      );
      expect(validate_non_nominative_baseline.inputSchema).toBeDefined();
      expect(validate_non_nominative_baseline.handler).toBeDefined();
    });

    it('devrait valider une baseline correcte', async () => {
      const args = {
        checkProfileCompatibility: true,
        checkMappingConsistency: true,
        generateReport: true
      };

      const mockActiveBaseline = {
        baselineId: 'valid-baseline',
        name: 'Baseline Valide',
        profiles: [
          {
            profileId: 'profile-1',
            category: 'roo-core',
            configuration: { modes: ['ask', 'code'] }
          }
        ]
      };

      const mockMappings = [
        {
          mappingId: 'mapping-1',
          baselineId: 'valid-baseline'
        }
      ];

      mockRooSyncService.getNonNominativeState.mockReturnValue({});
      mockRooSyncService.getActiveNonNominativeBaseline.mockReturnValue(mockActiveBaseline);
      mockRooSyncService.getNonNominativeMachineMappings.mockReturnValue(mockMappings);

      const result = await validate_non_nominative_baseline.handler(args);

      expect(result.success).toBe(true);
      expect(result.validation.isValid).toBe(true);
      expect(result.validation.summary.profilesValid).toBe(1);
      expect(result.validation.summary.profilesInvalid).toBe(0);
      expect(result.validation.summary.mappingsValid).toBe(1);
      expect(result.validation.summary.mappingsInvalid).toBe(0);
      expect(result.report).toBeDefined();
      expect(result.report.recommendations).toContain('Aucune action requise - la baseline est valide');
    });

    it('devrait détecter une baseline invalide', async () => {
      const args = {};

      const mockActiveBaseline = {
        baselineId: 'invalid-baseline',
        profiles: [] // Pas de profils
      };

      mockRooSyncService.getNonNominativeState.mockReturnValue({});
      mockRooSyncService.getActiveNonNominativeBaseline.mockReturnValue(mockActiveBaseline);

      const result = await validate_non_nominative_baseline.handler(args);

      expect(result.success).toBe(true);
      expect(result.validation.isValid).toBe(false);
      expect(result.validation.summary.profilesInvalid).toBe(0);
      expect(result.validation.issues).toContain('Baseline invalide: champs requis manquants');
    });

    it('devrait gérer l\'absence de baseline active', async () => {
      const args = {};

      mockRooSyncService.getNonNominativeState.mockReturnValue({});
      mockRooSyncService.getActiveNonNominativeBaseline.mockReturnValue(null);

      const result = await validate_non_nominative_baseline.handler(args);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Aucune baseline active trouvée');
      expect(result.message).toBe('Aucune baseline non-nominative active à valider');
    });
  });

  describe('export_non_nominative_baseline', () => {
    it('devrait avoir la bonne structure d\'outil MCP', () => {
      expect(export_non_nominative_baseline).toBeDefined();
      expect(export_non_nominative_baseline.name).toBe('export_non_nominative_baseline');
      expect(export_non_nominative_baseline.description).toBe(
        'Exporte une baseline non-nominative vers différents formats (JSON, YAML, CSV)'
      );
      expect(export_non_nominative_baseline.inputSchema).toBeDefined();
      expect(export_non_nominative_baseline.handler).toBeDefined();
    });

    it('devrait exporter en format JSON', async () => {
      const args = {
        format: 'json',
        includeMetadata: true,
        includeMappings: true
      };

      const mockActiveBaseline = {
        baselineId: 'test-baseline',
        name: 'Baseline Test',
        version: '1.0.0',
        description: 'Baseline de test',
        profiles: [
          {
            profileId: 'profile-1',
            category: 'roo-core',
            name: 'Profil Test',
            description: 'Profil de test',
            priority: 100,
            configuration: { modes: ['ask', 'code'] },
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
        ],
        aggregationRules: {
          defaultPriority: 100,
          conflictResolution: 'highest_priority'
        },
        metadata: {
          createdAt: new Date().toISOString(),
          status: 'active'
        }
      };

      const mockMappings = [
        {
          mappingId: 'mapping-1',
          baselineId: 'test-baseline',
          machineHash: 'hash-1',
          appliedProfiles: [{ profileId: 'profile-1' }],
          deviations: []
        }
      ];

      mockRooSyncService.getActiveNonNominativeBaseline.mockReturnValue(mockActiveBaseline);
      mockRooSyncService.getNonNominativeMachineMappings.mockReturnValue(mockMappings);

      const result = await export_non_nominative_baseline.handler(args);

      expect(result.success).toBe(true);
      expect(result.export?.format).toBe('json');
      expect(result.export?.filename).toBe('baseline-test-baseline.json');
      expect(result.export?.content).toContain('"baselineId": "test-baseline"');
      expect(result.export?.size).toBeGreaterThan(0);
    });

    it('devrait exporter en format CSV', async () => {
      const args = {
        format: 'csv'
      };

      const mockActiveBaseline = {
        baselineId: 'test-baseline',
        name: 'Baseline Test',
        profiles: [
          {
            profileId: 'profile-1',
            category: 'roo-core',
            name: 'Profil Test',
            description: 'Profil de test',
            priority: 100,
            metadata: {
              createdAt: '2023-01-01T00:00:00.000Z',
              stability: 'stable'
            }
          }
        ]
      };

      mockRooSyncService.getActiveNonNominativeBaseline.mockReturnValue(mockActiveBaseline);
      mockRooSyncService.getNonNominativeMachineMappings.mockReturnValue([]);

      const result = await export_non_nominative_baseline.handler(args);

      expect(result.success).toBe(true);
      expect(result.export?.format).toBe('csv');
      expect(result.export?.filename).toBe('baseline-test-baseline.csv');
      expect(result.export?.content).toContain('Type,ID,Category,Name,Description,Priority,Status,CreatedAt');
      expect(result.export?.content).toContain('Profile,profile-1,roo-core,"Profil Test"');
    });

    it('devrait gérer l\'absence de baseline active', async () => {
      const args = { format: 'json' };

      mockRooSyncService.getActiveNonNominativeBaseline.mockReturnValue(null);

      const result = await export_non_nominative_baseline.handler(args);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Aucune baseline active trouvée');
      expect(result.message).toBe('Aucune baseline non-nominative active à exporter');
    });
  });

  describe('validation des schémas d\'entrée', () => {
    it('devrait valider le schéma de create_non_nominative_baseline', () => {
      const schema = create_non_nominative_baseline.inputSchema;
      expect(schema).toBeDefined();
      
      const validResult = schema.safeParse({
        name: 'Test',
        description: 'Test description',
        aggregationConfig: {
          sources: [{ type: 'machine_inventory', weight: 1.0, enabled: true }]
        }
      });
      expect(validResult.success).toBe(true);

      const invalidResult = schema.safeParse({
        name: 'Test'
        // description manquante
      });
      expect(invalidResult.success).toBe(false);
    });

    it('devrait valider le schéma de map_machine_to_non_nominative_baseline', () => {
      const schema = map_machine_to_non_nominative_baseline.inputSchema;
      expect(schema).toBeDefined();
      
      const result = schema.safeParse({
        machineId: 'test-machine'
      });
      expect(result.success).toBe(true);
    });

    it('devrait valider le schéma de compare_machines_non_nominative', () => {
      const schema = compare_machines_non_nominative.inputSchema;
      expect(schema).toBeDefined();
      
      const result = schema.safeParse({
        machineIds: ['hash-001', 'hash-002'],
        includeDetails: true
      });
      expect(result.success).toBe(true);
    });

    it('devrait valider le schéma de export_non_nominative_baseline', () => {
      const schema = export_non_nominative_baseline.inputSchema;
      expect(schema).toBeDefined();
      
      const result = schema.safeParse({
        format: 'json',
        includeMetadata: true
      });
      expect(result.success).toBe(true);

      const invalidResult = schema.safeParse({
        format: 'invalid'
      });
      expect(invalidResult.success).toBe(false);
    });
  });
});