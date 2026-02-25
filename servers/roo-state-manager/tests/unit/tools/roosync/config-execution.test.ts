/**
 * Tests d'exécution pour roosync_config
 *
 * Couvre les chemins d'exécution de la fonction roosyncConfig
 * pour améliorer la couverture de tests.
 *
 * @module roosync/config-execution.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock du service RooSync
const mockCollectConfig = vi.fn();
const mockPublishConfig = vi.fn();
const mockApplyConfig = vi.fn();
const mockGetConfigVersion = vi.fn();

vi.mock('../../../../src/services/RooSyncService.js', () => ({
  getRooSyncService: () => ({
    getConfigSharingService: () => ({
      collectConfig: mockCollectConfig,
      publishConfig: mockPublishConfig,
      applyConfig: mockApplyConfig
    }),
    getConfigService: () => ({
      getConfigVersion: mockGetConfigVersion
    })
  })
}));

describe('roosync_config - Execution - Action Collect', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('devrait collecter la configuration avec succès', async () => {
    mockCollectConfig.mockResolvedValueOnce({
      packagePath: '/tmp/config-collect-test',
      totalSize: 12345,
      filesCount: 3,
      manifest: {
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        files: []
      }
    });

    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');

    const result = await roosyncConfig({ action: 'collect' });

    expect(result.status).toBe('success');
    expect(result.packagePath).toBe('/tmp/config-collect-test');
    expect(result.totalSize).toBe(12345);
    expect(mockCollectConfig).toHaveBeenCalledWith({
      targets: ['modes', 'mcp'],
      dryRun: false
    });
  });

  it('devrait collecter la configuration avec targets personnalisés', async () => {
    mockCollectConfig.mockResolvedValueOnce({
      packagePath: '/tmp/config-collect-custom',
      totalSize: 5432,
      filesCount: 2,
      manifest: { version: '1.0.0', timestamp: new Date().toISOString(), files: [] }
    });

    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');

    const result = await roosyncConfig({
      action: 'collect',
      targets: ['modes', 'profiles']
    });

    expect(result.status).toBe('success');
    expect(mockCollectConfig).toHaveBeenCalledWith({
      targets: ['modes', 'profiles'],
      dryRun: false
    });
  });

  it('devrait collecter en mode dryRun', async () => {
    mockCollectConfig.mockResolvedValueOnce({
      packagePath: '/tmp/config-collect-dryrun',
      totalSize: 0,
      filesCount: 0,
      manifest: { version: '1.0.0', timestamp: new Date().toISOString(), files: [] }
    });

    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');

    const result = await roosyncConfig({
      action: 'collect',
      dryRun: true
    });

    expect(result.status).toBe('success');
    expect(mockCollectConfig).toHaveBeenCalledWith({
      targets: ['modes', 'mcp'],
      dryRun: true
    });
  });
});

describe('roosync_config - Execution - Action Publish', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('devrait publier la configuration avec packagePath', async () => {
    mockPublishConfig.mockResolvedValueOnce({
      machineId: 'test-machine',
      version: '2.0.0',
      path: '/shared/configs/test-machine/v2.0.0'
    });

    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');

    const result = await roosyncConfig({
      action: 'publish',
      packagePath: '/tmp/package.tar.gz',
      version: '2.0.0',
      description: 'Test publish'
    });

    expect(result.status).toBe('success');
    expect(result.version).toBe('2.0.0');
    expect(result.targetPath).toBe('/shared/configs/test-machine/v2.0.0');
  });

  it('devrait faire un collect+publish atomique avec targets', async () => {
    mockCollectConfig.mockResolvedValueOnce({
      packagePath: '/tmp/auto-collect',
      totalSize: 5000,
      filesCount: 2,
      manifest: { version: '1.0.0', timestamp: new Date().toISOString(), files: [] }
    });

    mockPublishConfig.mockResolvedValueOnce({
      machineId: 'myia-po-2024',
      version: '1.0.0',
      path: '/shared/configs/myia-po-2024/v1.0.0'
    });

    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');

    const result = await roosyncConfig({
      action: 'publish',
      targets: ['modes', 'mcp'],
      version: '1.0.0',
      description: 'Atomic collect+publish'
    });

    expect(result.status).toBe('success');
    expect(mockCollectConfig).toHaveBeenCalled();
    expect(mockPublishConfig).toHaveBeenCalled();
  });

  it('devrait publier avec machineId personnalisé', async () => {
    mockPublishConfig.mockResolvedValueOnce({
      machineId: 'custom-machine-id',
      version: '1.5.0',
      path: '/shared/configs/custom-machine-id/v1.5.0'
    });

    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');

    const result = await roosyncConfig({
      action: 'publish',
      packagePath: '/tmp/pkg',
      version: '1.5.0',
      description: 'Custom machine',
      machineId: 'custom-machine-id'
    });

    expect(result.status).toBe('success');
    expect(result.machineId).toBe('custom-machine-id');
  });
});

describe('roosync_config - Execution - Action Apply', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('devrait appliquer la configuration avec succès', async () => {
    mockGetConfigVersion.mockResolvedValueOnce('2.0.0');
    mockApplyConfig.mockResolvedValueOnce({
      success: true,
      filesApplied: ['modes.json', 'mcp_settings.json'],
      backupPath: '/tmp/backup',
      errors: []
    });

    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');

    const result = await roosyncConfig({
      action: 'apply',
      version: 'latest'
    });

    expect(result.status).toBe('success');
    expect(result.filesApplied).toContain('modes.json');
    expect(result.backupPath).toBe('/tmp/backup');
  });

  it('devrait appliquer avec backup=false', async () => {
    mockGetConfigVersion.mockResolvedValueOnce('2.0.0');
    mockApplyConfig.mockResolvedValueOnce({
      success: true,
      filesApplied: ['modes.json'],
      backupPath: null,
      errors: []
    });

    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');

    await roosyncConfig({
      action: 'apply',
      backup: false
    });

    expect(mockApplyConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        backup: false
      })
    );
  });

  it('devrait appliquer avec targets granulaires', async () => {
    mockGetConfigVersion.mockResolvedValueOnce('2.0.0');
    mockApplyConfig.mockResolvedValueOnce({
      success: true,
      filesApplied: ['jupyter-config.json'],
      backupPath: '/tmp/backup',
      errors: []
    });

    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');

    await roosyncConfig({
      action: 'apply',
      targets: ['mcp:jupyter']
    });

    expect(mockApplyConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: ['mcp:jupyter']
      })
    );
  });

  it('devrait appliquer en mode dryRun', async () => {
    mockGetConfigVersion.mockResolvedValueOnce('2.0.0');
    mockApplyConfig.mockResolvedValueOnce({
      success: true,
      filesApplied: [],
      backupPath: null,
      errors: []
    });

    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');

    await roosyncConfig({
      action: 'apply',
      dryRun: true
    });

    expect(mockApplyConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true
      })
    );
  });

  it('devrait gérer les erreurs d\'application', async () => {
    mockGetConfigVersion.mockResolvedValueOnce('2.0.0');
    mockApplyConfig.mockResolvedValueOnce({
      success: false,
      filesApplied: [],
      backupPath: null,
      errors: ['Permission denied']
    });

    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');

    const result = await roosyncConfig({
      action: 'apply'
    });

    expect(result.status).toBe('error');
    expect(result.errors).toContain('Permission denied');
  });
});

describe('roosync_config - Execution - Error Handling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('devrait propager les erreurs ConfigSharingServiceError', async () => {
    const { ConfigSharingServiceError, ConfigSharingServiceErrorCode } =
      await import('../../../../src/types/errors.js');

    mockCollectConfig.mockRejectedValueOnce(
      new ConfigSharingServiceError(
        'Collect failed',
        ConfigSharingServiceErrorCode.COLLECTION_FAILED,
        {}
      )
    );

    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');

    await expect(roosyncConfig({ action: 'collect' })).rejects.toThrow(ConfigSharingServiceError);
  });

  it('devrait envelopper les erreurs inconnues', async () => {
    mockCollectConfig.mockRejectedValueOnce(new Error('Unknown error'));

    const { roosyncConfig } = await import('../../../../src/tools/roosync/config.js');

    await expect(roosyncConfig({ action: 'collect' })).rejects.toThrow('Erreur lors de l\'opération collect');
  });
});
