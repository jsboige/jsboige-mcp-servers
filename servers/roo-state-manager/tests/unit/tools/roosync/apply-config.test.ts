/**
 * Tests pour roosync_apply_config
 *
 * Vérifie les schemas et métadonnées de l'outil d'application de configuration.
 *
 * @module roosync/apply-config.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_apply_config - Interface', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait exporter roosyncApplyConfig', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');

    expect(module.roosyncApplyConfig).toBeDefined();
    expect(typeof module.roosyncApplyConfig).toBe('function');
  });

  it('devrait exporter ApplyConfigArgsSchema', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');

    expect(module.ApplyConfigArgsSchema).toBeDefined();
  });

  it('devrait exporter applyConfigToolMetadata', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');

    expect(module.applyConfigToolMetadata).toBeDefined();
    expect(module.applyConfigToolMetadata.name).toBe('roosync_apply_config');
  });
});

describe('roosync_apply_config - Schema Validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait accepter un objet vide (tous optionnels)', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = module.ApplyConfigArgsSchema.safeParse({});

    expect(result.success).toBe(true);
  });

  it('devrait accepter version latest', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = module.ApplyConfigArgsSchema.safeParse({
      version: 'latest'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter une version spécifique', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = module.ApplyConfigArgsSchema.safeParse({
      version: '2.1.0'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter dryRun et backup', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = module.ApplyConfigArgsSchema.safeParse({
      dryRun: true,
      backup: false
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter targets array', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = module.ApplyConfigArgsSchema.safeParse({
      targets: ['modes', 'mcp']
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter machineId', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = module.ApplyConfigArgsSchema.safeParse({
      machineId: 'myia-ai-01'
    });

    expect(result.success).toBe(true);
  });
});

describe('roosync_apply_config - Metadata', () => {
  it('devrait avoir les métadonnées correctes', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const metadata = module.applyConfigToolMetadata;

    expect(metadata.name).toBe('roosync_apply_config');
    expect(metadata.description).toContain('configuration');
    expect(metadata.inputSchema).toBeDefined();
    expect(metadata.inputSchema.type).toBe('object');
    expect(metadata.inputSchema.properties).toHaveProperty('version');
    expect(metadata.inputSchema.properties).toHaveProperty('dryRun');
    expect(metadata.inputSchema.properties).toHaveProperty('backup');
  });
});

// =============================================================================
// TESTS PRIORITÉ 1 - Tests Fonctionnels (4 tests)
// =============================================================================

describe('roosync_apply_config - Tests Fonctionnels', () => {
  let mockRooSyncService: any;
  let mockConfigService: any;
  let mockConfigSharingService: any;

  beforeEach(() => {
    vi.resetModules();

    // Mock ConfigService
    mockConfigService = {
      getConfigVersion: vi.fn().mockResolvedValue('1.0.0'),
    };

    // Mock ConfigSharingService
    mockConfigSharingService = {
      applyConfig: vi.fn().mockResolvedValue({
        success: true,
        filesApplied: 5,
        backupPath: '/mock/backup/path',
        errors: []
      })
    };

    // Mock RooSyncService
    mockRooSyncService = {
      getConfigService: vi.fn().mockReturnValue(mockConfigService),
      getConfigSharingService: vi.fn().mockReturnValue(mockConfigSharingService)
    };

    // Mock getRooSyncService
    vi.doMock('../../../../src/services/RooSyncService.js', () => ({
      getRooSyncService: vi.fn().mockReturnValue(mockRooSyncService)
    }));
  });

  it('devrait réussir avec version latest', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({ version: 'latest' });

    expect(result.status).toBe('success');
    expect(result.message).toBe('Configuration appliquée avec succès');
    expect(result.filesApplied).toBe(5);
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: undefined,
      backup: true,
      dryRun: false
    });
  });

  it('devrait réussir avec version spécifique', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({ version: '1.2.3' });

    expect(result.status).toBe('success');
    expect(result.message).toBe('Configuration appliquée avec succès');
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: '1.2.3',
      machineId: undefined,
      targets: undefined,
      backup: true,
      dryRun: false
    });
  });

  it('devrait réussir avec machineId explicite', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({
      version: 'latest',
      machineId: 'myia-ai-01'
    });

    expect(result.status).toBe('success');
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: 'myia-ai-01',
      targets: undefined,
      backup: true,
      dryRun: false
    });
  });

  it('devrait réussir avec ROOSYNC_MACHINE_ID (machineId non fourni)', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({ version: 'latest' });

    expect(result.status).toBe('success');
    // Quand machineId n'est pas fourni, il est undefined et le service utilise ROOSYNC_MACHINE_ID
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: undefined,
      backup: true,
      dryRun: false
    });
  });
});

// =============================================================================
// TESTS PRIORITÉ 1 - Tests Backup (4 tests)
// =============================================================================

describe('roosync_apply_config - Tests Backup', () => {
  let mockRooSyncService: any;
  let mockConfigService: any;
  let mockConfigSharingService: any;

  beforeEach(() => {
    vi.resetModules();

    mockConfigService = {
      getConfigVersion: vi.fn().mockResolvedValue('1.0.0'),
    };

    mockConfigSharingService = {
      applyConfig: vi.fn().mockResolvedValue({
        success: true,
        filesApplied: 3,
        backupPath: '/mock/backup/backup-20250120-123456',
        errors: []
      })
    };

    mockRooSyncService = {
      getConfigService: vi.fn().mockReturnValue(mockConfigService),
      getConfigSharingService: vi.fn().mockReturnValue(mockConfigSharingService)
    };

    vi.doMock('../../../../src/services/RooSyncService.js', () => ({
      getRooSyncService: vi.fn().mockReturnValue(mockRooSyncService)
    }));
  });

  it('devrait créer un backup activé (défaut)', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({ version: 'latest' });

    expect(result.status).toBe('success');
    expect(result.backupPath).toBe('/mock/backup/backup-20250120-123456');
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: undefined,
      backup: true, // Backup activé par défaut
      dryRun: false
    });
  });

  it('devrait désactiver le backup quand backup=false', async () => {
    mockConfigSharingService.applyConfig.mockResolvedValue({
      success: true,
      filesApplied: 3,
      backupPath: undefined,
      errors: []
    });

    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({
      version: 'latest',
      backup: false
    });

    expect(result.status).toBe('success');
    expect(result.backupPath).toBeUndefined();
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: undefined,
      backup: false,
      dryRun: false
    });
  });

  it('devrait retourner le chemin de backup', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({ version: 'latest' });

    expect(result.backupPath).toBeDefined();
    expect(result.backupPath).toBe('/mock/backup/backup-20250120-123456');
    expect(typeof result.backupPath).toBe('string');
  });

  it('devrait avoir un format de nom de backup valide', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({ version: 'latest' });

    // Le format attendu: backup-YYYYMMDD-HHMMSS
    const backupPath = result.backupPath;
    expect(backupPath).toBeDefined();
    const filename = backupPath!.split('/').pop();
    expect(filename).toMatch(/^backup-\d{8}-\d{6}$/);
  });
});

// =============================================================================
// TESTS PRIORITÉ 1 - Tests DryRun (4 tests)
// =============================================================================

describe('roosync_apply_config - Tests DryRun', () => {
  let mockRooSyncService: any;
  let mockConfigService: any;
  let mockConfigSharingService: any;

  beforeEach(() => {
    vi.resetModules();

    mockConfigService = {
      getConfigVersion: vi.fn().mockResolvedValue('1.0.0'),
    };

    mockConfigSharingService = {
      applyConfig: vi.fn().mockResolvedValue({
        success: true,
        filesApplied: 0,
        backupPath: undefined,
        errors: []
      })
    };

    mockRooSyncService = {
      getConfigService: vi.fn().mockReturnValue(mockConfigService),
      getConfigSharingService: vi.fn().mockReturnValue(mockConfigSharingService)
    };

    vi.doMock('../../../../src/services/RooSyncService.js', () => ({
      getRooSyncService: vi.fn().mockReturnValue(mockRooSyncService)
    }));
  });

  it('devrait faire un dryRun true (aucune modification)', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({
      version: 'latest',
      dryRun: true
    });

    expect(result.status).toBe('success');
    expect(result.filesApplied).toBe(0);
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: undefined,
      backup: true,
      dryRun: true
    });
  });

  it('devrait appliquer les modifications quand dryRun=false', async () => {
    mockConfigSharingService.applyConfig.mockResolvedValue({
      success: true,
      filesApplied: 5,
      backupPath: '/mock/backup/path',
      errors: []
    });

    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({
      version: 'latest',
      dryRun: false
    });

    expect(result.status).toBe('success');
    expect(result.filesApplied).toBe(5);
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: undefined,
      backup: true,
      dryRun: false
    });
  });

  it('devrait inclure des détails dans le résultat dryRun', async () => {
    mockConfigSharingService.applyConfig.mockResolvedValue({
      success: true,
      filesApplied: 0,
      backupPath: undefined,
      errors: []
    });

    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({
      version: 'latest',
      dryRun: true
    });

    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('message');
    expect(result).toHaveProperty('filesApplied');
    expect(result).toHaveProperty('backupPath');
    expect(result).toHaveProperty('errors');
  });

  it('devrait faire un dryRun sans backup', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({
      version: 'latest',
      dryRun: true,
      backup: false
    });

    expect(result.status).toBe('success');
    expect(result.backupPath).toBeUndefined();
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: undefined,
      backup: false,
      dryRun: true
    });
  });
});

// =============================================================================
// TESTS PRIORITÉ 1 - Tests Targets (5 tests)
// =============================================================================

describe('roosync_apply_config - Tests Targets', () => {
  let mockRooSyncService: any;
  let mockConfigService: any;
  let mockConfigSharingService: any;

  beforeEach(() => {
    vi.resetModules();

    mockConfigService = {
      getConfigVersion: vi.fn().mockResolvedValue('1.0.0'),
    };

    mockConfigSharingService = {
      applyConfig: vi.fn().mockResolvedValue({
        success: true,
        filesApplied: 2,
        backupPath: '/mock/backup/path',
        errors: []
      })
    };

    mockRooSyncService = {
      getConfigService: vi.fn().mockReturnValue(mockConfigService),
      getConfigSharingService: vi.fn().mockReturnValue(mockConfigSharingService)
    };

    vi.doMock('../../../../src/services/RooSyncService.js', () => ({
      getRooSyncService: vi.fn().mockReturnValue(mockRooSyncService)
    }));
  });

  it('devrait appliquer targets: modes uniquement', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({
      version: 'latest',
      targets: ['modes']
    });

    expect(result.status).toBe('success');
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: ['modes'],
      backup: true,
      dryRun: false
    });
  });

  it('devrait appliquer targets: mcp uniquement', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({
      version: 'latest',
      targets: ['mcp']
    });

    expect(result.status).toBe('success');
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: ['mcp'],
      backup: true,
      dryRun: false
    });
  });

  it('devrait appliquer targets: profiles uniquement', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({
      version: 'latest',
      targets: ['profiles']
    });

    expect(result.status).toBe('success');
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: ['profiles'],
      backup: true,
      dryRun: false
    });
  });

  it('devrait appliquer targets: multiples', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({
      version: 'latest',
      targets: ['modes', 'mcp', 'profiles']
    });

    expect(result.status).toBe('success');
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: ['modes', 'mcp', 'profiles'],
      backup: true,
      dryRun: false
    });
  });

  it('devrait appliquer targets: vide (tous)', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({
      version: 'latest',
      targets: []
    });

    expect(result.status).toBe('success');
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: [],
      backup: true,
      dryRun: false
    });
  });
});

// =============================================================================
// TESTS PRIORITÉ 1 - Tests Version Incompatible (5 tests)
// =============================================================================

describe('roosync_apply_config - Tests Version Incompatible', () => {
  let mockRooSyncService: any;
  let mockConfigService: any;
  let mockConfigSharingService: any;

  beforeEach(() => {
    vi.resetModules();

    mockConfigSharingService = {
      applyConfig: vi.fn().mockResolvedValue({
        success: true,
        filesApplied: 5,
        backupPath: '/mock/backup/path',
        errors: []
      })
    };

    mockRooSyncService = {
      getConfigService: vi.fn().mockReturnValue(mockConfigService),
      getConfigSharingService: vi.fn().mockReturnValue(mockConfigSharingService)
    };

    vi.doMock('../../../../src/services/RooSyncService.js', () => ({
      getRooSyncService: vi.fn().mockReturnValue(mockRooSyncService)
    }));
  });

  it('devrait rejeter une version majeure incompatible', async () => {
    // Configurer le mock avant l'import
    mockConfigService = {
      getConfigVersion: vi.fn().mockResolvedValue('1.0.0'),
    };
    mockRooSyncService.getConfigService = vi.fn().mockReturnValue(mockConfigService);

    const module = await import('../../../../src/tools/roosync/apply-config.js');
    
    await expect(
      module.roosyncApplyConfig({ version: '2.0.0' })
    ).rejects.toThrow('Incompatibilité de version de configuration');
  });

  it('devrait accepter une version compatible', async () => {
    // Configurer le mock avant l'import
    mockConfigService = {
      getConfigVersion: vi.fn().mockResolvedValue('1.0.0'),
    };
    mockRooSyncService.getConfigService = vi.fn().mockReturnValue(mockConfigService);

    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({ version: '1.2.3' });

    expect(result.status).toBe('success');
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalled();
  });

  it('devrait gérer version null (Bug #305)', async () => {
    // Configurer le mock avant l'import
    mockConfigService = {
      getConfigVersion: vi.fn().mockResolvedValue(null),
    };
    mockRooSyncService.getConfigService = vi.fn().mockReturnValue(mockConfigService);

    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = await module.roosyncApplyConfig({ version: '1.2.3' });

    // Quand currentVersion est null, la validation est ignorée et la version demandée est utilisée
    expect(result.status).toBe('success');
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: '1.2.3',
      machineId: undefined,
      targets: undefined,
      backup: true,
      dryRun: false
    });
  });

  it('devrait avoir un message d\'erreur détaillé pour version incompatible', async () => {
    // Configurer le mock avant l'import
    mockConfigService = {
      getConfigVersion: vi.fn().mockResolvedValue('1.0.0'),
    };
    mockRooSyncService.getConfigService = vi.fn().mockReturnValue(mockConfigService);

    const module = await import('../../../../src/tools/roosync/apply-config.js');
    
    await expect(
      module.roosyncApplyConfig({ version: '2.0.0' })
    ).rejects.toThrow('Incompatibilité de version de configuration');

    try {
      await module.roosyncApplyConfig({ version: '2.0.0' });
    } catch (error: any) {
      expect(error.message).toContain('Incompatibilité de version de configuration');
      expect(error.message).toContain('actuelle=1.0.0');
      expect(error.message).toContain('requise=2.0.0');
      expect(error.details).toBeDefined();
      expect(error.details.currentVersion).toBe('1.0.0');
      expect(error.details.requestedVersion).toBe('2.0.0');
      expect(error.details.currentMajor).toBe(1);
      expect(error.details.requestedMajor).toBe(2);
    }
  });

  it('devrait avoir le code d\'erreur correct pour version incompatible', async () => {
    // Configurer le mock avant l'import
    mockConfigService = {
      getConfigVersion: vi.fn().mockResolvedValue('1.0.0'),
    };
    mockRooSyncService.getConfigService = vi.fn().mockReturnValue(mockConfigService);

    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const { ConfigSharingServiceError, ConfigSharingServiceErrorCode } = await import('../../../../src/types/errors.js');
    
    await expect(
      module.roosyncApplyConfig({ version: '2.0.0' })
    ).rejects.toThrow('Incompatibilité de version de configuration');

    try {
      await module.roosyncApplyConfig({ version: '2.0.0' });
    } catch (error: any) {
      expect(error).toBeInstanceOf(ConfigSharingServiceError);
      expect(error.code).toBe(ConfigSharingServiceErrorCode.COLLECTION_FAILED);
    }
  });
});
