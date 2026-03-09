/**
 * Tests pour roosync_apply_config
 *
 * Vérifie les schemas et métadonnées de l'outil d'application de configuration.
 *
 * Pattern modifié (#609) : Utilise beforeAll pour l'import unique et vi.mock()
 * au niveau module au lieu de vi.resetModules() + vi.doMock() qui causait
 * des timeouts dans le suite complet.
 *
 * @module roosync/apply-config.test
 * @version 1.1.0 (#609 fix)
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

// Module-level mock factory for RooSyncService
// This avoids vi.resetModules() while still allowing fresh mocks per test
const createMockRooSyncService = () => ({
  getConfigService: vi.fn(),
  getConfigSharingService: vi.fn(),
});

vi.mock('../../../../src/services/RooSyncService.js', () => ({
  getRooSyncService: vi.fn(() => createMockRooSyncService()),
}));

describe('roosync_apply_config - Interface', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/apply-config.js');
  });

  it('devrait exporter roosyncApplyConfig', () => {
    expect(module.roosyncApplyConfig).toBeDefined();
    expect(typeof module.roosyncApplyConfig).toBe('function');
  });

  it('devrait exporter ApplyConfigArgsSchema', () => {
    expect(module.ApplyConfigArgsSchema).toBeDefined();
  });

  it('devrait exporter applyConfigToolMetadata', () => {
    expect(module.applyConfigToolMetadata).toBeDefined();
    expect(module.applyConfigToolMetadata.name).toBe('roosync_apply_config');
  });
});

describe('roosync_apply_config - Schema Validation', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/apply-config.js');
  });

  it('devrait accepter un objet vide (tous optionnels)', () => {
    const result = module.ApplyConfigArgsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('devrait accepter version latest', () => {
    const result = module.ApplyConfigArgsSchema.safeParse({
      version: 'latest'
    });
    expect(result.success).toBe(true);
  });

  it('devrait accepter une version spécifique', () => {
    const result = module.ApplyConfigArgsSchema.safeParse({
      version: '2.1.0'
    });
    expect(result.success).toBe(true);
  });

  it('devrait accepter dryRun et backup', () => {
    const result = module.ApplyConfigArgsSchema.safeParse({
      dryRun: true,
      backup: false
    });
    expect(result.success).toBe(true);
  });

  it('devrait accepter targets array', () => {
    const result = module.ApplyConfigArgsSchema.safeParse({
      targets: ['modes', 'mcp']
    });
    expect(result.success).toBe(true);
  });

  it('devrait accepter machineId', () => {
    const result = module.ApplyConfigArgsSchema.safeParse({
      machineId: 'myia-ai-01'
    });
    expect(result.success).toBe(true);
  });
});

describe('roosync_apply_config - Metadata', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/apply-config.js');
  });

  it('devrait avoir les métadonnées correctes', () => {
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
  let module: any;
  let mockRooSyncService: any;
  let mockConfigService: any;
  let mockConfigSharingService: any;
  let getRooSyncServiceMock: any;

  beforeAll(async () => {
    // Import the mocked service module
    const rooSyncServiceModule = await import('../../../../src/services/RooSyncService.js');
    getRooSyncServiceMock = rooSyncServiceModule.getRooSyncService;

    // Import the module under test
    module = await import('../../../../src/tools/roosync/apply-config.js');
  });

  beforeEach(() => {
    // Fresh mock implementations for each test
    mockConfigService = {
      getConfigVersion: vi.fn().mockResolvedValue('1.0.0'),
    };

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

    // Update the mock to return fresh services
    getRooSyncServiceMock.mockReturnValue(mockRooSyncService);
  });

  it('devrait réussir avec version latest', async () => {
    const result = await module.roosyncApplyConfig({ version: 'latest' });

    expect(result.status).toBe('success');
    expect(result.message).toBe('Configuration appliquée avec succès');
    expect(result.filesApplied).toBe(5);
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: [],
      backup: true,
      dryRun: false
    });
  });

  it('devrait réussir avec version spécifique', async () => {
    const result = await module.roosyncApplyConfig({ version: '1.2.3' });

    expect(result.status).toBe('success');
    expect(result.message).toBe('Configuration appliquée avec succès');
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: '1.2.3',
      machineId: undefined,
      targets: [],
      backup: true,
      dryRun: false
    });
  });

  it('devrait réussir avec machineId explicite', async () => {
    const result = await module.roosyncApplyConfig({
      version: 'latest',
      machineId: 'myia-ai-01'
    });

    expect(result.status).toBe('success');
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: 'myia-ai-01',
      targets: [],
      backup: true,
      dryRun: false
    });
  });

  it('devrait réussir avec ROOSYNC_MACHINE_ID (machineId non fourni)', async () => {
    const result = await module.roosyncApplyConfig({ version: 'latest' });

    expect(result.status).toBe('success');
    // Quand machineId n'est pas fourni, il est undefined et le service utilise ROOSYNC_MACHINE_ID
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
// TESTS PRIORITÉ 1 - Tests Backup (4 tests)
// =============================================================================

describe('roosync_apply_config - Tests Backup', () => {
  let module: any;
  let mockRooSyncService: any;
  let mockConfigService: any;
  let mockConfigSharingService: any;
  let getRooSyncServiceMock: any;

  beforeAll(async () => {
    const rooSyncServiceModule = await import('../../../../src/services/RooSyncService.js');
    getRooSyncServiceMock = rooSyncServiceModule.getRooSyncService;
    module = await import('../../../../src/tools/roosync/apply-config.js');
  });

  beforeEach(() => {
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

    getRooSyncServiceMock.mockReturnValue(mockRooSyncService);
  });

  it('devrait créer un backup activé (défaut)', async () => {
    const result = await module.roosyncApplyConfig({ version: 'latest' });

    expect(result.status).toBe('success');
    expect(result.backupPath).toBe('/mock/backup/backup-20250120-123456');
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: [],
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

    const result = await module.roosyncApplyConfig({
      version: 'latest',
      backup: false
    });

    expect(result.status).toBe('success');
    expect(result.backupPath).toBeUndefined();
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: [],
      backup: false,
      dryRun: false
    });
  });

  it('devrait retourner le chemin de backup', async () => {
    const result = await module.roosyncApplyConfig({ version: 'latest' });

    expect(result.backupPath).toBeDefined();
    expect(result.backupPath).toBe('/mock/backup/backup-20250120-123456');
    expect(typeof result.backupPath).toBe('string');
  });

  it('devrait avoir un format de nom de backup valide', async () => {
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
  let module: any;
  let mockRooSyncService: any;
  let mockConfigService: any;
  let mockConfigSharingService: any;
  let getRooSyncServiceMock: any;

  beforeAll(async () => {
    const rooSyncServiceModule = await import('../../../../src/services/RooSyncService.js');
    getRooSyncServiceMock = rooSyncServiceModule.getRooSyncService;
    module = await import('../../../../src/tools/roosync/apply-config.js');
  });

  beforeEach(() => {
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

    getRooSyncServiceMock.mockReturnValue(mockRooSyncService);
  });

  it('devrait faire un dryRun true (aucune modification)', async () => {
    const result = await module.roosyncApplyConfig({
      version: 'latest',
      dryRun: true
    });

    expect(result.status).toBe('success');
    expect(result.filesApplied).toBe(0);
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: [],
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

    const result = await module.roosyncApplyConfig({
      version: 'latest',
      dryRun: false
    });

    expect(result.status).toBe('success');
    expect(result.filesApplied).toBe(5);
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: [],
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
      targets: [],
      backup: false,
      dryRun: true
    });
  });
});

// =============================================================================
// TESTS PRIORITÉ 1 - Tests Targets (8 tests)
// =============================================================================

describe('roosync_apply_config - Tests Targets', () => {
  let module: any;
  let mockRooSyncService: any;
  let mockConfigService: any;
  let mockConfigSharingService: any;
  let getRooSyncServiceMock: any;

  beforeAll(async () => {
    const rooSyncServiceModule = await import('../../../../src/services/RooSyncService.js');
    getRooSyncServiceMock = rooSyncServiceModule.getRooSyncService;
    module = await import('../../../../src/tools/roosync/apply-config.js');
  });

  beforeEach(() => {
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

    getRooSyncServiceMock.mockReturnValue(mockRooSyncService);
  });

  it('devrait appliquer targets: modes uniquement', async () => {
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

  // =============================================================================
  // TESTS #349 - Tests Targets MCP Spécifiques
  // =============================================================================

  it('devrait appliquer targets: mcp:github uniquement (#349)', async () => {
    const result = await module.roosyncApplyConfig({
      version: 'latest',
      targets: ['mcp:github']
    });

    expect(result.status).toBe('success');
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: ['mcp:github'],
      backup: true,
      dryRun: false
    });
  });

  it('devrait appliquer targets: multiples MCP spécifiques (#349)', async () => {
    const result = await module.roosyncApplyConfig({
      version: 'latest',
      targets: ['mcp:win-cli', 'mcp:markitdown']
    });

    expect(result.status).toBe('success');
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: ['mcp:win-cli', 'mcp:markitdown'],
      backup: true,
      dryRun: false
    });
  });

  it('devrait appliquer targets: mélange modes et mcp spécifique (#349)', async () => {
    const result = await module.roosyncApplyConfig({
      version: 'latest',
      targets: ['modes', 'mcp:jupyter']
    });

    expect(result.status).toBe('success');
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: 'latest',
      machineId: undefined,
      targets: ['modes', 'mcp:jupyter'],
      backup: true,
      dryRun: false
    });
  });
});

// =============================================================================
// TESTS #349 - Validation Schema Targets MCP
// =============================================================================

describe('roosync_apply_config - Schema Validation Targets (#349)', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/apply-config.js');
  });

  it('devrait accepter target mcp:github', async () => {
    const result = module.ApplyConfigArgsSchema.safeParse({
      targets: ['mcp:github']
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter multiples targets mcp:*', async () => {
    const result = module.ApplyConfigArgsSchema.safeParse({
      targets: ['mcp:win-cli', 'mcp:markitdown', 'mcp:jupyter']
    });

    expect(result.success).toBe(true);
  });

  it('devrait rejeter target mcp: sans nom de serveur', async () => {
    const result = module.ApplyConfigArgsSchema.safeParse({
      targets: ['mcp:']
    });

    expect(result.success).toBe(false);
  });

  it('devrait rejeter target invalide', async () => {
    const result = module.ApplyConfigArgsSchema.safeParse({
      targets: ['invalid-target']
    });

    expect(result.success).toBe(false);
  });

  it('devrait accepter mélange modes + mcp spécifiques', async () => {
    const result = module.ApplyConfigArgsSchema.safeParse({
      targets: ['modes', 'mcp:github', 'profiles']
    });

    expect(result.success).toBe(true);
  });
});

// =============================================================================
// TESTS PRIORITÉ 1 - Tests Version Incompatible (5 tests)
// =============================================================================

describe('roosync_apply_config - Tests Version Incompatible', () => {
  let module: any;
  let mockRooSyncService: any;
  let mockConfigService: any;
  let mockConfigSharingService: any;
  let getRooSyncServiceMock: any;

  beforeAll(async () => {
    const rooSyncServiceModule = await import('../../../../src/services/RooSyncService.js');
    getRooSyncServiceMock = rooSyncServiceModule.getRooSyncService;
    module = await import('../../../../src/tools/roosync/apply-config.js');
  });

  beforeEach(() => {
    mockConfigService = {
      getConfigVersion: vi.fn().mockResolvedValue('1.0.0'),
    };

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

    getRooSyncServiceMock.mockReturnValue(mockRooSyncService);
  });

  it('devrait rejeter une version majeure incompatible', async () => {
    await expect(
      module.roosyncApplyConfig({ version: '2.0.0' })
    ).rejects.toThrow('Incompatibilité de version de configuration');
  });

  it('devrait accepter une version compatible', async () => {
    const result = await module.roosyncApplyConfig({ version: '1.2.3' });

    expect(result.status).toBe('success');
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalled();
  });

  it('devrait gérer version null (Bug #305)', async () => {
    mockConfigService = {
      getConfigVersion: vi.fn().mockResolvedValue(null),
    };
    mockRooSyncService.getConfigService = vi.fn().mockReturnValue(mockConfigService);
    getRooSyncServiceMock.mockReturnValue(mockRooSyncService);

    const result = await module.roosyncApplyConfig({ version: '1.2.3' });

    // Quand currentVersion est null, la validation est ignorée et la version demandée est utilisée
    expect(result.status).toBe('success');
    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: '1.2.3',
      machineId: undefined,
      targets: [],
      backup: true,
      dryRun: false
    });
  });

  it('devrait avoir un message d\'erreur détaillé pour version incompatible', async () => {
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

// =============================================================================
// TESTS PRIORITÉ 2 - Tests Erreurs (5 tests)
// =============================================================================

describe('roosync_apply_config - Tests Erreurs', () => {
  let module: any;
  let mockRooSyncService: any;
  let mockConfigService: any;
  let mockConfigSharingService: any;
  let getRooSyncServiceMock: any;

  beforeAll(async () => {
    const rooSyncServiceModule = await import('../../../../src/services/RooSyncService.js');
    getRooSyncServiceMock = rooSyncServiceModule.getRooSyncService;
    module = await import('../../../../src/tools/roosync/apply-config.js');
  });

  beforeEach(() => {
    mockConfigService = {
      getConfigVersion: vi.fn().mockResolvedValue('1.0.0'),
    };

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

    getRooSyncServiceMock.mockReturnValue(mockRooSyncService);
  });

  it('devrait rejeter une configuration non trouvée', async () => {
    const { ConfigSharingServiceError, ConfigSharingServiceErrorCode } = await import('../../../../src/types/errors.js');

    mockConfigSharingService.applyConfig.mockRejectedValue(
      new ConfigSharingServiceError(
        'Configuration non trouvée: 1.5.0 (machineId: myia-ai-01)',
        ConfigSharingServiceErrorCode.PATH_NOT_AVAILABLE,
        { version: '1.5.0', machineId: 'myia-ai-01' }
      )
    );

    await expect(
      module.roosyncApplyConfig({ version: '1.5.0', machineId: 'myia-ai-01' })
    ).rejects.toThrow('Configuration non trouvée');

    try {
      await module.roosyncApplyConfig({ version: '1.5.0', machineId: 'myia-ai-01' });
    } catch (error: any) {
      expect(error).toBeInstanceOf(ConfigSharingServiceError);
      expect(error.code).toBe(ConfigSharingServiceErrorCode.PATH_NOT_AVAILABLE);
      expect(error.details.version).toBe('1.5.0');
      expect(error.details.machineId).toBe('myia-ai-01');
    }
  });

  it('devrait rejeter un manifeste non trouvé', async () => {
    const { ConfigSharingServiceError, ConfigSharingServiceErrorCode } = await import('../../../../src/types/errors.js');

    mockConfigSharingService.applyConfig.mockRejectedValue(
      new ConfigSharingServiceError(
        'Manifeste non trouvé: /path/to/manifest.json',
        ConfigSharingServiceErrorCode.PATH_NOT_AVAILABLE,
        { manifestPath: '/path/to/manifest.json', version: '1.0.0' }
      )
    );

    await expect(
      module.roosyncApplyConfig({ version: '1.0.0' })
    ).rejects.toThrow('Manifeste non trouvé');

    try {
      await module.roosyncApplyConfig({ version: '1.0.0' });
    } catch (error: any) {
      expect(error).toBeInstanceOf(ConfigSharingServiceError);
      expect(error.code).toBe(ConfigSharingServiceErrorCode.PATH_NOT_AVAILABLE);
      expect(error.details.manifestPath).toBe('/path/to/manifest.json');
    }
  });

  it('devrait rejeter un inventaire incomplet', async () => {
    const { ConfigSharingServiceError, ConfigSharingServiceErrorCode } = await import('../../../../src/types/errors.js');

    mockConfigSharingService.applyConfig.mockRejectedValue(
      new ConfigSharingServiceError(
        'Inventaire incomplet: paths.rooExtensions non disponible. Impossible d\'appliquer la configuration.',
        ConfigSharingServiceErrorCode.INVENTORY_INCOMPLETE,
        { machineId: 'localhost', missingPath: 'rooExtensions' }
      )
    );

    await expect(
      module.roosyncApplyConfig({ version: 'latest' })
    ).rejects.toThrow('Inventaire incomplet');

    try {
      await module.roosyncApplyConfig({ version: 'latest' });
    } catch (error: any) {
      expect(error).toBeInstanceOf(ConfigSharingServiceError);
      expect(error.code).toBe(ConfigSharingServiceErrorCode.INVENTORY_INCOMPLETE);
      expect(error.details.missingPath).toBe('rooExtensions');
    }
  });

  it('devrait gérer une erreur de lecture fichier', async () => {
    const { ConfigSharingServiceError, ConfigSharingServiceErrorCode } = await import('../../../../src/types/errors.js');

    mockConfigSharingService.applyConfig.mockResolvedValue({
      success: false,
      filesApplied: 0,
      backupPath: undefined,
      errors: ['Erreur lors du traitement de roo-modes/test.json: ENOENT: no such file or directory']
    });

    const result = await module.roosyncApplyConfig({ version: 'latest' });

    expect(result.status).toBe('error');
    expect(result.message).toBe('Échec de l\'application de la configuration');
    expect(result.filesApplied).toBe(0);
    expect(result.errors).toBeDefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0]).toContain('Erreur lors du traitement');
    expect(result.errors![0]).toContain('ENOENT');
  });

  it('devrait gérer une erreur d\'écriture fichier', async () => {
    const { ConfigSharingServiceError, ConfigSharingServiceErrorCode } = await import('../../../../src/types/errors.js');

    mockConfigSharingService.applyConfig.mockResolvedValue({
      success: false,
      filesApplied: 2,
      backupPath: '/mock/backup/path',
      errors: [
        'Erreur lors du traitement de roo-modes/test.json: EACCES: permission denied',
        'Erreur lors du traitement de mcp-settings/mcp_settings.json: EACCES: permission denied'
      ]
    });

    const result = await module.roosyncApplyConfig({ version: 'latest' });

    expect(result.status).toBe('error');
    expect(result.message).toBe('Échec de l\'application de la configuration');
    expect(result.filesApplied).toBe(2);
    expect(result.errors).toBeDefined();
    expect(result.errors).toHaveLength(2);
    expect(result.errors![0]).toContain('EACCES');
    expect(result.errors![1]).toContain('EACCES');
  });
});

// =============================================================================
// TESTS PRIORITÉ 2 - Tests Résultat (4 tests)
// =============================================================================

describe('roosync_apply_config - Tests Résultat', () => {
  let module: any;
  let mockRooSyncService: any;
  let mockConfigService: any;
  let mockConfigSharingService: any;
  let getRooSyncServiceMock: any;

  beforeAll(async () => {
    const rooSyncServiceModule = await import('../../../../src/services/RooSyncService.js');
    getRooSyncServiceMock = rooSyncServiceModule.getRooSyncService;
    module = await import('../../../../src/tools/roosync/apply-config.js');
  });

  beforeEach(() => {
    mockConfigService = {
      getConfigVersion: vi.fn().mockResolvedValue('1.0.0'),
    };

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

    getRooSyncServiceMock.mockReturnValue(mockRooSyncService);
  });

  it('devrait avoir la structure du résultat succès correcte', async () => {
    const result = await module.roosyncApplyConfig({ version: 'latest' });

    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('message');
    expect(result).toHaveProperty('filesApplied');
    expect(result).toHaveProperty('backupPath');
    expect(result).toHaveProperty('errors');
    
    expect(typeof result.status).toBe('string');
    expect(typeof result.message).toBe('string');
    expect(typeof result.filesApplied).toBe('number');
    expect(typeof result.backupPath).toBe('string');
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it('devrait avoir la structure du résultat erreur correcte', async () => {
    mockConfigSharingService.applyConfig.mockResolvedValue({
      success: false,
      filesApplied: 0,
      backupPath: undefined,
      errors: ['Erreur de test']
    });

    const result = await module.roosyncApplyConfig({ version: 'latest' });

    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('message');
    expect(result).toHaveProperty('filesApplied');
    expect(result).toHaveProperty('backupPath');
    expect(result).toHaveProperty('errors');
    
    expect(result.status).toBe('error');
    expect(result.message).toBe('Échec de l\'application de la configuration');
    expect(result.filesApplied).toBe(0);
    expect(result.backupPath).toBeUndefined();
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors).toHaveLength(1);
  });

  it('devrait compter correctement filesApplied', async () => {
    mockConfigSharingService.applyConfig.mockResolvedValue({
      success: true,
      filesApplied: 7,
      backupPath: '/mock/backup/path',
      errors: []
    });

    const result = await module.roosyncApplyConfig({ version: 'latest' });

    expect(result.filesApplied).toBe(7);
    expect(typeof result.filesApplied).toBe('number');
    expect(result.filesApplied).toBeGreaterThanOrEqual(0);
  });

  it('devrait collecter les erreurs dans le tableau errors', async () => {
    mockConfigSharingService.applyConfig.mockResolvedValue({
      success: false,
      filesApplied: 3,
      backupPath: '/mock/backup/path',
      errors: [
        'Erreur 1: fichier non trouvé',
        'Erreur 2: permission refusée',
        'Erreur 3: format invalide'
      ]
    });

    const result = await module.roosyncApplyConfig({ version: 'latest' });

    expect(result.errors).toBeDefined();
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors).toHaveLength(3);
    expect(result.errors![0]).toContain('Erreur 1');
    expect(result.errors![1]).toContain('Erreur 2');
    expect(result.errors![2]).toContain('Erreur 3');
  });
});
