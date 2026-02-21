/**
 * Tests pour roosync_config (CONS-3)
 *
 * Vérifie les schemas et métadonnées de l'outil consolidé de configuration.
 * Consolide les tests de collect-config, publish-config, et apply-config.
 *
 * @module roosync/config.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_config - Interface', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait exporter roosyncConfig', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');

    expect(module.roosyncConfig).toBeDefined();
    expect(typeof module.roosyncConfig).toBe('function');
  });

  it('devrait exporter ConfigArgsSchema', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');

    expect(module.ConfigArgsSchema).toBeDefined();
  });

  it('devrait exporter configToolMetadata', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');

    expect(module.configToolMetadata).toBeDefined();
    expect(module.configToolMetadata.name).toBe('roosync_config');
  });
});

describe('roosync_config - Schema Validation - Action Collect', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait accepter action=collect avec paramètres par défaut', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const result = module.ConfigArgsSchema.safeParse({
      action: 'collect'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action=collect avec targets', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const result = module.ConfigArgsSchema.safeParse({
      action: 'collect',
      targets: ['modes', 'mcp', 'profiles']
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action=collect avec dryRun', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const result = module.ConfigArgsSchema.safeParse({
      action: 'collect',
      dryRun: true
    });

    expect(result.success).toBe(true);
  });

  it('devrait valider les targets (modes, mcp, profiles, mcp:<nom>)', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');

    // Valide: targets standards
    const validStandard = module.ConfigArgsSchema.safeParse({
      action: 'collect',
      targets: ['modes', 'mcp', 'profiles']
    });
    expect(validStandard.success).toBe(true);

    // Valide: targets avec mcp:<nom>
    const validGranular = module.ConfigArgsSchema.safeParse({
      action: 'collect',
      targets: ['mcp:jupyter', 'modes']
    });
    expect(validGranular.success).toBe(true);

    // Invalide: target inconnu
    const invalidTarget = module.ConfigArgsSchema.safeParse({
      action: 'collect',
      targets: ['invalid']
    });
    expect(invalidTarget.success).toBe(false);

    // Invalide: mcp: sans nom
    const invalidEmpty = module.ConfigArgsSchema.safeParse({
      action: 'collect',
      targets: ['mcp:']
    });
    expect(invalidEmpty.success).toBe(false);
  });

  it('devrait accepter les nouveaux targets (roomodes, model-configs, rules)', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');

    // Valide: roomodes seul
    const roomodes = module.ConfigArgsSchema.safeParse({
      action: 'collect',
      targets: ['roomodes']
    });
    expect(roomodes.success).toBe(true);

    // Valide: model-configs seul
    const modelConfigs = module.ConfigArgsSchema.safeParse({
      action: 'collect',
      targets: ['model-configs']
    });
    expect(modelConfigs.success).toBe(true);

    // Valide: rules seul
    const rules = module.ConfigArgsSchema.safeParse({
      action: 'collect',
      targets: ['rules']
    });
    expect(rules.success).toBe(true);

    // Valide: combinaison anciens et nouveaux targets
    const combined = module.ConfigArgsSchema.safeParse({
      action: 'collect',
      targets: ['roomodes', 'rules', 'modes', 'mcp:jupyter']
    });
    expect(combined.success).toBe(true);
  });

  it('devrait accepter publish atomique avec les nouveaux targets', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');

    const result = module.ConfigArgsSchema.safeParse({
      action: 'publish',
      targets: ['roomodes', 'rules'],
      version: '1.0.0',
      description: 'Deploy modes + rules'
    });
    expect(result.success).toBe(true);
  });

  it('devrait accepter apply avec les nouveaux targets', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');

    const result = module.ConfigArgsSchema.safeParse({
      action: 'apply',
      targets: ['roomodes', 'rules', 'model-configs'],
      machineId: 'myia-ai-01'
    });
    expect(result.success).toBe(true);
  });
});

describe('roosync_config - Schema Validation - Action Publish', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devait rejeter action=publish sans version et description', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const result = module.ConfigArgsSchema.safeParse({
      action: 'publish'
    });

    expect(result.success).toBe(false);
  });

  it('devait accepter action=publish avec packagePath, version, et description', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const result = module.ConfigArgsSchema.safeParse({
      action: 'publish',
      packagePath: '/tmp/package.tar.gz',
      version: '2.3.0',
      description: 'Test publish'
    });

    expect(result.success).toBe(true);
  });

  it('devait accepter action=publish avec targets (workflow atomique collect+publish)', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const result = module.ConfigArgsSchema.safeParse({
      action: 'publish',
      targets: ['modes', 'mcp'],
      version: '2.3.0',
      description: 'Atomic collect+publish'
    });

    expect(result.success).toBe(true);
  });

  it('devait accepter action=publish avec machineId', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const result = module.ConfigArgsSchema.safeParse({
      action: 'publish',
      packagePath: '/tmp/package.tar.gz',
      version: '2.3.0',
      description: 'Test publish',
      machineId: 'myia-ai-01'
    });

    expect(result.success).toBe(true);
  });

  it('devait rejeter action=publish avec version mais sans description', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const result = module.ConfigArgsSchema.safeParse({
      action: 'publish',
      packagePath: '/tmp/package.tar.gz',
      version: '2.3.0'
      // description manquante
    });

    expect(result.success).toBe(false);
  });
});

describe('roosync_config - Schema Validation - Action Apply', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait accepter action=apply avec paramètres par défaut', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const result = module.ConfigArgsSchema.safeParse({
      action: 'apply'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action=apply avec version', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const result = module.ConfigArgsSchema.safeParse({
      action: 'apply',
      version: '2.3.0'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action=apply avec version=latest', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const result = module.ConfigArgsSchema.safeParse({
      action: 'apply',
      version: 'latest'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action=apply avec targets', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const result = module.ConfigArgsSchema.safeParse({
      action: 'apply',
      targets: ['modes', 'mcp']
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action=apply avec targets granulaires (mcp:<nom>)', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const result = module.ConfigArgsSchema.safeParse({
      action: 'apply',
      targets: ['mcp:jupyter', 'modes']
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action=apply avec backup=false', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const result = module.ConfigArgsSchema.safeParse({
      action: 'apply',
      backup: false
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action=apply avec machineId', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const result = module.ConfigArgsSchema.safeParse({
      action: 'apply',
      machineId: 'myia-ai-01',
      version: 'latest'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action=apply avec dryRun', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const result = module.ConfigArgsSchema.safeParse({
      action: 'apply',
      dryRun: true
    });

    expect(result.success).toBe(true);
  });
});

describe('roosync_config - Schema Validation - Actions Invalides', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait rejeter une action manquante', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const result = module.ConfigArgsSchema.safeParse({});

    expect(result.success).toBe(false);
  });

  it('devrait rejeter une action invalide', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const result = module.ConfigArgsSchema.safeParse({
      action: 'invalid_action'
    });

    expect(result.success).toBe(false);
  });
});

describe('roosync_config - Metadata', () => {
  it('devrait avoir les métadonnées correctes', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const metadata = module.configToolMetadata;

    expect(metadata.name).toBe('roosync_config');
    expect(metadata.description).toContain('Gestion');
    expect(metadata.description).toContain('configuration RooSync');
    expect(metadata.inputSchema).toBeDefined();
    expect(metadata.inputSchema.type).toBe('object');
    expect(metadata.inputSchema.properties).toHaveProperty('action');
    expect(metadata.inputSchema.properties).toHaveProperty('targets');
    expect(metadata.inputSchema.properties).toHaveProperty('version');
    expect(metadata.inputSchema.properties).toHaveProperty('description');
    expect(metadata.inputSchema.properties).toHaveProperty('packagePath');
    expect(metadata.inputSchema.properties).toHaveProperty('backup');
    expect(metadata.inputSchema.properties).toHaveProperty('machineId');
    expect(metadata.inputSchema.properties).toHaveProperty('dryRun');
    expect(metadata.inputSchema.required).toContain('action');
  });

  it('devrait documenter les 3 actions (collect, publish, apply)', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const metadata = module.configToolMetadata;

    expect(metadata.description).toContain('collect');
    expect(metadata.description).toContain('publish');
    expect(metadata.description).toContain('apply');
  });

  it('devrait documenter le workflow atomique collect+publish', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const metadata = module.configToolMetadata;

    // Test simplifié après cleanup #443 - description compacte sans détails techniques
    expect(metadata.description).toContain('collecte');
    expect(metadata.description).toContain('publication');
  });

  it('devrait avoir enum correct pour action', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const metadata = module.configToolMetadata;

    expect(metadata.inputSchema.properties.action.enum).toEqual(['collect', 'publish', 'apply']);
  });
});

describe('roosync_config - Retrocompatibilité', () => {
  it('devrait couvrir tous les cas d\'usage de collect_config', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');

    // Cas 1: collect avec targets par défaut
    const case1 = module.ConfigArgsSchema.safeParse({ action: 'collect' });
    expect(case1.success).toBe(true);

    // Cas 2: collect avec targets spécifiques
    const case2 = module.ConfigArgsSchema.safeParse({
      action: 'collect',
      targets: ['modes', 'mcp']
    });
    expect(case2.success).toBe(true);

    // Cas 3: collect avec dryRun
    const case3 = module.ConfigArgsSchema.safeParse({
      action: 'collect',
      dryRun: true
    });
    expect(case3.success).toBe(true);
  });

  it('devrait couvrir tous les cas d\'usage de publish_config', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');

    // Cas 1: publish avec packagePath existant
    const case1 = module.ConfigArgsSchema.safeParse({
      action: 'publish',
      packagePath: '/tmp/pkg',
      version: '2.3.0',
      description: 'Test'
    });
    expect(case1.success).toBe(true);

    // Cas 2: publish avec machineId custom
    const case2 = module.ConfigArgsSchema.safeParse({
      action: 'publish',
      packagePath: '/tmp/pkg',
      version: '2.3.0',
      description: 'Test',
      machineId: 'custom-machine'
    });
    expect(case2.success).toBe(true);
  });

  it('devrait couvrir tous les cas d\'usage de apply_config', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');

    // Cas 1: apply latest
    const case1 = module.ConfigArgsSchema.safeParse({
      action: 'apply'
    });
    expect(case1.success).toBe(true);

    // Cas 2: apply version spécifique
    const case2 = module.ConfigArgsSchema.safeParse({
      action: 'apply',
      version: '2.3.0'
    });
    expect(case2.success).toBe(true);

    // Cas 3: apply avec targets granulaires
    const case3 = module.ConfigArgsSchema.safeParse({
      action: 'apply',
      targets: ['mcp:jupyter']
    });
    expect(case3.success).toBe(true);

    // Cas 4: apply avec backup désactivé
    const case4 = module.ConfigArgsSchema.safeParse({
      action: 'apply',
      backup: false
    });
    expect(case4.success).toBe(true);

    // Cas 5: apply avec dryRun
    const case5 = module.ConfigArgsSchema.safeParse({
      action: 'apply',
      dryRun: true
    });
    expect(case5.success).toBe(true);

    // Cas 6: apply avec nouveaux targets (roomodes, rules, model-configs)
    const case6 = module.ConfigArgsSchema.safeParse({
      action: 'apply',
      targets: ['roomodes', 'rules', 'model-configs']
    });
    expect(case6.success).toBe(true);
  });
});

describe('roosync_config - Integration Tests - Action Collect', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mock('../../../../src/services/RooSyncService.js', () => ({
      getRooSyncService: vi.fn(() => ({
        getConfigSharingService: vi.fn(() => ({
          collectConfig: vi.fn()
        }))
      }))
    }));
  });

  it('devrait collecter avec targets vides', async () => {
    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');
    
    const mockConfigSharingService = vi.fn(() => ({
      collectConfig: vi.fn().mockResolvedValue({
        packagePath: '/tmp/package.tar.gz',
        totalSize: 0,
        manifest: {}
      })
    }));
    
    vi.mocked(
      (await import('../../../../src/services/RooSyncService.js')).getRooSyncService
    ).mockReturnValue({
      getConfigSharingService: mockConfigSharingService
    });

    const result = await roosyncConfig({ action: 'collect' });

    expect(result.status).toBe('success');
    expect(result.totalSize).toBe(0);
    expect(result.manifest).toEqual({});
  });

  it('devrait collecter avec targets multiples (modes, mcp, profiles)', async () => {
    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');
    
    const mockConfigSharingService = vi.fn(() => ({
      collectConfig: vi.fn().mockResolvedValue({
        packagePath: '/tmp/package.tar.gz',
        totalSize: 1024000,
        manifest: {
          modes: { count: 5, files: ['modes.json'] },
          mcp: { count: 8, files: ['mcp.json'] },
          profiles: { count: 2, files: ['profiles.json'] }
        }
      })
    }));
    
    vi.mocked(
      (await import('../../../../src/services/RooSyncService.js')).getRooSyncService
    ).mockReturnValue({
      getConfigSharingService: mockConfigSharingService
    });

    const result = await roosyncConfig({
      action: 'collect',
      targets: ['modes', 'mcp', 'profiles']
    });

    expect(result.status).toBe('success');
    expect(result.totalSize).toBe(1024000);
    expect(result.manifest.modes.count).toBe(5);
    expect(result.manifest.mcp.count).toBe(8);
    expect(result.manifest.profiles.count).toBe(2);
  });

  it('devrait collecter avec dryRun=true', async () => {
    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');
    
    const mockConfigSharingService = vi.fn(() => ({
      collectConfig: vi.fn().mockResolvedValue({
        packagePath: '/tmp/package-dryrun.tar.gz',
        totalSize: 512000,
        manifest: { modes: { count: 5 } }
      })
    }));
    
    vi.mocked(
      (await import('../../../../src/services/RooSyncService.js')).getRooSyncService
    ).mockReturnValue({
      getConfigSharingService: mockConfigSharingService
    });

    const result = await roosyncConfig({
      action: 'collect',
      dryRun: true
    });

    expect(result.status).toBe('success');
    expect(result.message).toContain('Configuration collectée');
    expect(result.packagePath).toBe('/tmp/package-dryrun.tar.gz');
    expect(result.totalSize).toBe(512000);
  });

  it('devrait gérer l\'erreur de lecture fichier', async () => {
    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');
    
    const mockConfigSharingService = vi.fn(() => ({
      collectConfig: vi.fn().mockRejectedValue(
        new Error('Erreur de lecture du fichier modes.json')
      )
    }));
    
    vi.mocked(
      (await import('../../../../src/services/RooSyncService.js')).getRooSyncService
    ).mockReturnValue({
      getConfigSharingService: mockConfigSharingService
    });

    await expect(roosyncConfig({ action: 'collect' }))
      .rejects
      .toThrow('Erreur de lecture du fichier modes.json');
  });

  it('devrait collecter avec targets granulaires (mcp:jupyter)', async () => {
    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');
    
    const mockConfigSharingService = vi.fn(() => ({
      collectConfig: vi.fn().mockResolvedValue({
        packagePath: '/tmp/package-mcp.tar.gz',
        totalSize: 256000,
        manifest: {
          'mcp:jupyter': { count: 3, files: ['jupyter.json'] }
        }
      })
    }));
    
    vi.mocked(
      (await import('../../../../src/services/RooSyncService.js')).getRooSyncService
    ).mockReturnValue({
      getConfigSharingService: mockConfigSharingService
    });

    const result = await roosyncConfig({
      action: 'collect',
      targets: ['mcp:jupyter']
    });

    expect(result.status).toBe('success');
    expect(result.totalSize).toBe(256000);
    expect(result.manifest['mcp:jupyter'].count).toBe(3);
  });
});

describe('roosync_config - Metadata New Targets', () => {
  it('devrait documenter les nouveaux targets dans la description', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const metadata = module.configToolMetadata;

    expect(metadata.description).toContain('roomodes');
    expect(metadata.description).toContain('model-configs');
    expect(metadata.description).toContain('rules');
  });

  it('devrait documenter les targets dans le inputSchema', async () => {
    const module = await import('../../../../src/tools/roosync/config.js');
    const metadata = module.configToolMetadata;

    expect(metadata.inputSchema.properties.targets.description).toContain('roomodes');
    expect(metadata.inputSchema.properties.targets.description).toContain('model-configs');
    expect(metadata.inputSchema.properties.targets.description).toContain('rules');
  });
});

describe('roosync_config - Integration Tests - Action Publish', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mock('../../../../src/services/RooSyncService.js', () => ({
      getRooSyncService: vi.fn(() => ({
        getConfigSharingService: vi.fn(() => ({
          collectConfig: vi.fn(),
          publishConfig: vi.fn()
        }))
      }))
    }));
  });

  it('devrait publier avec packagePath valide', async () => {
    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');
    const mockService = await import('../../../../src/services/RooSyncService.js');
    
    mockService.getRooSyncService.mockReturnValue({
      getConfigSharingService: vi.fn(() => ({
        collectConfig: vi.fn(),
        publishConfig: vi.fn().mockResolvedValue({
          version: '2.3.0',
          path: '/storage/configs/2.3.0.tar.gz',
          machineId: 'myia-ai-01'
        })
      }))
    });

    const result = await roosyncConfig({
      action: 'publish',
      packagePath: '/tmp/package.tar.gz',
      version: '2.3.0',
      description: 'Test publish'
    });

    expect(result.status).toBe('success');
    expect(result.version).toBe('2.3.0');
    expect(result.targetPath).toBe('/storage/configs/2.3.0.tar.gz');
    expect(result.machineId).toBe('myia-ai-01');
  });

  it('devrait publier avec version et description', async () => {
    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');
    const mockService = await import('../../../../src/services/RooSyncService.js');
    
    mockService.getRooSyncService.mockReturnValue({
      getConfigSharingService: vi.fn(() => ({
        collectConfig: vi.fn(),
        publishConfig: vi.fn().mockResolvedValue({
          version: '2.4.0',
          path: '/storage/configs/2.4.0.tar.gz',
          machineId: 'myia-po-2025'
        })
      }))
    });

    const result = await roosyncConfig({
      action: 'publish',
      packagePath: '/tmp/package.tar.gz',
      version: '2.4.0',
      description: 'Version 2.4.0'
    });

    expect(result.status).toBe('success');
    expect(result.version).toBe('2.4.0');
    expect(result.message).toContain('myia-po-2025');
  });

  it('devrait publier avec targets atomiques', async () => {
    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');
    const mockService = await import('../../../../src/services/RooSyncService.js');
    
    mockService.getRooSyncService.mockReturnValue({
      getConfigSharingService: vi.fn(() => ({
        collectConfig: vi.fn().mockResolvedValue({
          filesCount: 10,
          packagePath: '/tmp/atomic-package.tar.gz',
          totalSize: 512000,
          manifest: { modes: { count: 5 } }
        }),
        publishConfig: vi.fn().mockResolvedValue({
          version: '2.5.0',
          path: '/storage/configs/2.5.0.tar.gz',
          machineId: 'myia-ai-01'
        })
      }))
    });

    const result = await roosyncConfig({
      action: 'publish',
      targets: ['modes', 'mcp'],
      version: '2.5.0',
      description: 'Atomic collect+publish'
    });

    expect(result.status).toBe('success');
    expect(result.version).toBe('2.5.0');
    expect(result.message).toContain('myia-ai-01');
  });

  it('devrait gérer l\'erreur d\'écriture', async () => {
    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');
    const mockService = await import('../../../../src/services/RooSyncService.js');
    
    mockService.getRooSyncService.mockReturnValue({
      getConfigSharingService: vi.fn(() => ({
        collectConfig: vi.fn(),
        publishConfig: vi.fn().mockRejectedValue(
          new Error('Erreur d\'écriture sur le stockage')
        )
      }))
    });

    await expect(roosyncConfig({
      action: 'publish',
      packagePath: '/tmp/package.tar.gz',
      version: '2.3.0',
      description: 'Test'
    }))
      .rejects
      .toThrow('Erreur d\'écriture sur le stockage');
  });

  it('devrait gérer le cas où packagePath est manquant', async () => {
    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');
    const mockService = await import('../../../../src/services/RooSyncService.js');
    
    mockService.getRooSyncService.mockReturnValue({
      getConfigSharingService: vi.fn(() => ({
        collectConfig: vi.fn(),
        publishConfig: vi.fn()
      }))
    });

    await expect(roosyncConfig({
      action: 'publish',
      version: '2.3.0',
      description: 'Test'
    }))
      .rejects
      .toThrow('packagePath requis pour publish');
  });
});

describe('roosync_config - Integration Tests - Action Apply', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mock('../../../../src/services/RooSyncService.js', () => ({
      getRooSyncService: vi.fn(() => ({
        getConfigSharingService: vi.fn(() => ({
          applyConfig: vi.fn()
        })),
        getConfigService: vi.fn(() => ({
          getConfigVersion: vi.fn().mockResolvedValue('2.3.0')
        }))
      }))
    }));
  });

  it('devrait appliquer avec version spécifique', async () => {
    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');
    const mockService = await import('../../../../src/services/RooSyncService.js');
    
    mockService.getRooSyncService.mockReturnValue({
      getConfigSharingService: vi.fn(() => ({
        applyConfig: vi.fn().mockResolvedValue({
          success: true,
          filesApplied: 15,
          backupPath: '/backup/config-2.3.0-20260221.tar.gz',
          errors: []
        })
      })),
      getConfigService: vi.fn(() => ({
        getConfigVersion: vi.fn().mockResolvedValue('2.3.0')
      }))
    });

    const result = await roosyncConfig({
      action: 'apply',
      version: '2.3.0',
      targets: ['modes', 'mcp']
    });

    expect(result.status).toBe('success');
    expect(result.filesApplied).toBe(15);
    expect(result.backupPath).toContain('2.3.0');
    expect(result.errors).toEqual([]);
  });

  it('devrait appliquer avec version=latest', async () => {
    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');
    const mockService = await import('../../../../src/services/RooSyncService.js');
    
    mockService.getRooSyncService.mockReturnValue({
      getConfigSharingService: vi.fn(() => ({
        applyConfig: vi.fn().mockResolvedValue({
          success: true,
          filesApplied: 10,
          backupPath: '/backup/config-latest-20260221.tar.gz',
          errors: []
        })
      })),
      getConfigService: vi.fn(() => ({
        getConfigVersion: vi.fn().mockResolvedValue('2.3.0')
      }))
    });

    const result = await roosyncConfig({
      action: 'apply',
      version: 'latest'
    });

    expect(result.status).toBe('success');
    expect(result.filesApplied).toBe(10);
    expect(result.backupPath).toContain('latest');
  });

  it('devrait appliquer avec backup=false', async () => {
    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');
    const mockService = await import('../../../../src/services/RooSyncService.js');
    
    mockService.getRooSyncService.mockReturnValue({
      getConfigSharingService: vi.fn(() => ({
        applyConfig: vi.fn().mockResolvedValue({
          success: true,
          filesApplied: 8,
          backupPath: null,
          errors: []
        })
      })),
      getConfigService: vi.fn(() => ({
        getConfigVersion: vi.fn().mockResolvedValue('2.3.0')
      }))
    });

    const result = await roosyncConfig({
      action: 'apply',
      version: '2.3.0',
      backup: false
    });

    expect(result.status).toBe('success');
    expect(result.filesApplied).toBe(8);
    expect(result.backupPath).toBeNull();
  });

  it('devrait appliquer avec dryRun=true', async () => {
    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');
    const mockService = await import('../../../../src/services/RooSyncService.js');
    
    mockService.getRooSyncService.mockReturnValue({
      getConfigSharingService: vi.fn(() => ({
        applyConfig: vi.fn().mockResolvedValue({
          success: true,
          filesApplied: 12,
          backupPath: null,
          errors: []
        })
      })),
      getConfigService: vi.fn(() => ({
        getConfigVersion: vi.fn().mockResolvedValue('2.3.0')
      }))
    });

    const result = await roosyncConfig({
      action: 'apply',
      version: '2.3.0',
      dryRun: true
    });

    expect(result.status).toBe('success');
    expect(result.filesApplied).toBe(12);
    expect(result.backupPath).toBeNull();
    expect(result.message).toBe('Configuration appliquée avec succès');
  });

  it('devrait appliquer avec targets granulaires', async () => {
    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');
    const mockService = await import('../../../../src/services/RooSyncService.js');
    
    mockService.getRooSyncService.mockReturnValue({
      getConfigSharingService: vi.fn(() => ({
        applyConfig: vi.fn().mockResolvedValue({
          success: true,
          filesApplied: 5,
          backupPath: '/backup/config-mcp-jupyter-20260221.tar.gz',
          errors: []
        })
      })),
      getConfigService: vi.fn(() => ({
        getConfigVersion: vi.fn().mockResolvedValue('2.3.0')
      }))
    });

    const result = await roosyncConfig({
      action: 'apply',
      version: '2.3.0',
      targets: ['mcp:jupyter']
    });

    expect(result.status).toBe('success');
    expect(result.filesApplied).toBe(5);
    expect(result.backupPath).toContain('mcp-jupyter');
  });

  it('devrait gérer l\'erreur d\'incompatibilité de version', async () => {
    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');
    const mockService = await import('../../../../src/services/RooSyncService.js');
    
    mockService.getRooSyncService.mockReturnValue({
      getConfigSharingService: vi.fn(() => ({
        applyConfig: vi.fn()
      })),
      getConfigService: vi.fn(() => ({
        // currentVersion=1.x vs requested=2.x → major mismatch → erreur d'incompatibilité
        getConfigVersion: vi.fn().mockResolvedValue('1.5.0')
      }))
    });

    await expect(roosyncConfig({
      action: 'apply',
      version: '2.3.0'
    }))
      .rejects
      .toThrow('Incompatibilité de version');
  });

  it('devrait gérer l\'erreur d\'application', async () => {
    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');
    const mockService = await import('../../../../src/services/RooSyncService.js');
    
    mockService.getRooSyncService.mockReturnValue({
      getConfigSharingService: vi.fn(() => ({
        applyConfig: vi.fn().mockResolvedValue({
          success: false,
          filesApplied: 0,
          backupPath: null,
          errors: ['Erreur lors de l\'application des fichiers']
        })
      })),
      getConfigService: vi.fn(() => ({
        getConfigVersion: vi.fn().mockResolvedValue('2.3.0')
      }))
    });

    const result = await roosyncConfig({
      action: 'apply',
      version: '2.3.0'
    });

    expect(result.status).toBe('error');
    expect(result.filesApplied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Erreur lors de l\'application');
  });
});
