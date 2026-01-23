import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock du RooSyncService AVANT les imports
vi.mock('../../src/services/RooSyncService.js', () => {
  return {
    RooSyncService: {
      getInstance: vi.fn()
    },
    getRooSyncService: vi.fn(),
    RooSyncServiceError: class extends Error {
        constructor(message: string) {
            super(message);
            this.name = 'RooSyncServiceError';
        }
    }
  };
});

describe('Legacy Compatibility Integration Test', () => {
  let mockRooSyncService: any;
  let mockConfigSharingService: any;

  // Modules à tester (importés dynamiquement)
  let roosyncCollectConfig: any;
  let roosyncCompareConfig: any;
  let roosyncApplyConfig: any;
  let RooSyncServiceMock: any;
  let getRooSyncServiceMock: any;

  beforeEach(async () => {
    // Reset des modules pour s'assurer que le mock est pris en compte
    vi.resetModules();

    // Import dynamique des mocks et des modules testés
    const serviceModule = await import('../../src/services/RooSyncService.js');
    RooSyncServiceMock = serviceModule.RooSyncService;
    getRooSyncServiceMock = serviceModule.getRooSyncService;

    const collectModule = await import('../../src/tools/roosync/collect-config.js');
    roosyncCollectConfig = collectModule.roosyncCollectConfig;

    const compareModule = await import('../../src/tools/roosync/compare-config.js');
    roosyncCompareConfig = compareModule.roosyncCompareConfig;

    const applyModule = await import('../../src/tools/roosync/apply-config.js');
    roosyncApplyConfig = applyModule.roosyncApplyConfig;

    // Setup des mocks objets
    mockConfigSharingService = {
      collectConfig: vi.fn().mockResolvedValue({
        filesCount: 10,
        packagePath: '/tmp/package.zip',
        totalSize: 1024,
        manifest: { version: '1.0.0' }
      }),
      applyConfig: vi.fn().mockResolvedValue({
        success: true,
        filesApplied: 5,
        backupPath: '/tmp/backup.zip',
        errors: []
      })
    };

    // Mock ConfigService pour roosyncApplyConfig (getConfigVersion est appelé)
    const mockConfigService = {
      getConfigVersion: vi.fn().mockResolvedValue('1.0.0')
    };

    mockRooSyncService = {
      getConfigService: vi.fn().mockReturnValue({
        getConfigVersion: vi.fn().mockResolvedValue('1.0.0'),
        get: vi.fn(),
        set: vi.fn(),
        getAll: vi.fn().mockReturnValue({}),
        getBaselineServiceConfig: vi.fn().mockReturnValue({
          baselinePath: undefined,
          roadmapPath: undefined,
          logLevel: 'INFO'
        }),
        getSharedStatePath: vi.fn().mockReturnValue('/tmp/test-shared-state')
      }),
      getConfigSharingService: vi.fn().mockReturnValue(mockConfigSharingService),
      getConfig: vi.fn().mockReturnValue({ machineId: 'local-machine' }),
      loadDashboard: vi.fn().mockResolvedValue({ machines: { 'remote-machine': {} } }),
      compareRealConfigurations: vi.fn().mockResolvedValue({
        sourceMachine: 'local-machine',
        targetMachine: 'remote-machine',
        differences: [],
        summary: { total: 0, critical: 0, important: 0, warning: 0, info: 0 }
      })
    };

    // Configuration du mock getInstance pour retourner notre mock de service
    RooSyncServiceMock.getInstance.mockReturnValue(mockRooSyncService);
    // Configuration de getRooSyncService pour retourner notre mock
    getRooSyncServiceMock.mockReturnValue(mockRooSyncService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('devrait supporter le workflow complet collect -> compare -> update (apply)', async () => {
    // 1. Test Collect (Legacy)
    const collectResult = await roosyncCollectConfig({
      dryRun: true,
      targets: ['modes', 'mcp']
    });

    expect(mockRooSyncService.getConfigSharingService).toHaveBeenCalled();
    expect(mockConfigSharingService.collectConfig).toHaveBeenCalledWith({
      targets: ['modes', 'mcp'],
      dryRun: true
    });
    expect(collectResult.status).toBe('success');
    expect(collectResult.message).toContain('10 fichiers');

    // 2. Test Compare (Legacy)
    const compareResult = await roosyncCompareConfig({
      target: 'remote-machine'
    });

    // Note: compareConfig appelle directement le service, pas via ConfigComparator dans l'implémentation actuelle visible
    // mais dans le code source lu, il appelle compareRealConfigurations sur le service
    expect(mockRooSyncService.compareRealConfigurations).toHaveBeenCalledWith(
      'local-machine', // default source
      'remote-machine',
      false // default force_refresh
    );
    expect(compareResult.source).toBe('local-machine');
    expect(compareResult.target).toBe('remote-machine');

    // 3. Test Apply (Legacy Update)
    const applyResult = await roosyncApplyConfig({
      version: '1.0.0',
      dryRun: true,
      backup: true
    });

    expect(mockConfigSharingService.applyConfig).toHaveBeenCalledWith({
      version: '1.0.0',
      targets: [],
      backup: true,
      dryRun: true
    });
    expect(applyResult.status).toBe('success');
    expect(applyResult.filesApplied).toBe(5);
  });

  it('devrait gérer les erreurs de manière compatible', async () => {
    // Simulation d'une erreur
    mockConfigSharingService.collectConfig.mockRejectedValue(new Error('Erreur simulée'));

    await expect(roosyncCollectConfig({ dryRun: true }))
      .rejects
      .toThrow('Erreur lors de la collecte de configuration: Erreur simulée');
  });
});