/**
 * Tests pour roosync_get_machine_inventory
 *
 * Vérifie le comportement de l'outil de collecte d'inventaire machine.
 *
 * @module roosync/get-machine-inventory.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_get_machine_inventory - Interface', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait exporter getMachineInventoryTool', async () => {
    const module = await import('../../../../src/tools/roosync/get-machine-inventory.js');

    expect(module.getMachineInventoryTool).toBeDefined();
    expect(module.getMachineInventoryTool.name).toBe('roosync_get_machine_inventory');
  });

  it('devrait avoir les métadonnées correctes', async () => {
    const module = await import('../../../../src/tools/roosync/get-machine-inventory.js');
    const tool = module.getMachineInventoryTool;

    expect(tool.name).toBe('roosync_get_machine_inventory');
    expect(tool.description).toContain('inventaire');
    expect(tool.version).toBe('1.0.0');
  });

  it('devrait avoir un schema d\'entrée valide', async () => {
    const module = await import('../../../../src/tools/roosync/get-machine-inventory.js');
    const tool = module.getMachineInventoryTool;

    expect(tool.inputSchema).toBeDefined();
    // Le schema accepte machineId optionnel
    const parseResult = tool.inputSchema.safeParse({});
    expect(parseResult.success).toBe(true);

    const parseWithId = tool.inputSchema.safeParse({ machineId: 'test-machine' });
    expect(parseWithId.success).toBe(true);
  });
});

describe('roosync_get_machine_inventory - Execution', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  // Créer des mocks pour les interfaces requises
  const createMockServices = () => ({
    storage: {
      detectRooStorage: vi.fn(),
      getStorageStats: vi.fn(),
      getConversationSkeleton: vi.fn()
    },
    cache: {
      get: vi.fn(),
      set: vi.fn(),
      clear: vi.fn(),
      getStats: vi.fn()
    },
    search: {
      searchTasksSemantic: vi.fn(),
      indexTask: vi.fn()
    },
    export: {
      export: vi.fn()
    },
    summary: {
      generateTraceSummary: vi.fn(),
      generateClusterSummary: vi.fn(),
      getConversationSynthesis: vi.fn()
    },
    display: {
      viewConversationTree: vi.fn(),
      getTaskTree: vi.fn(),
      listConversations: vi.fn(),
      viewTaskDetails: vi.fn()
    },
    utility: {
      rebuildSkeletonCache: vi.fn(),
      manageMcpSettings: vi.fn(),
      readVscodeLogs: vi.fn()
    }
  });

  const createMockSecurity = () => ({
    validateInput: true,
    sanitizeOutput: true
  });

  const createMockMonitoring = () => ({
    recordExecution: vi.fn(),
    getMetrics: vi.fn(() => Promise.resolve({ executionTime: 0, success: true }))
  });

  const createMockBackgroundMonitoring = () => ({
    recordBackground: vi.fn(),
    recordExecution: vi.fn(),
    getMetrics: vi.fn(() => Promise.resolve({ executionTime: 0, success: true }))
  });

  const createMockCacheManager = () => ({
    get: vi.fn(),
    store: vi.fn(),
    evictOldEntries: vi.fn(),
    getTotalSize: vi.fn(() => 0)
  });

  it('devrait retourner une structure de résultat valide', async () => {
    // Mock du service d'inventaire
    vi.doMock('../../../../src/services/roosync/InventoryService.js', () => ({
      InventoryService: {
        getInstance: vi.fn().mockReturnValue({
          getMachineInventory: vi.fn().mockResolvedValue({
            machineId: 'test-machine',
            hostname: 'TEST-HOST',
            timestamp: '2026-01-15T12:00:00Z',
            inventory: {
              system: { os: 'Windows' }
            }
          })
        })
      }
    }));

    const module = await import('../../../../src/tools/roosync/get-machine-inventory.js');
    const tool = module.getMachineInventoryTool;

    const result = await tool.execute({}, {
      services: createMockServices(),
      security: createMockSecurity(),
      monitoring: {
        immediate: createMockMonitoring(),
        background: createMockBackgroundMonitoring()
      },
      cacheManager: createMockCacheManager()
    });

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('metrics');
    expect(result.metrics).toHaveProperty('executionTime');
  });

  it('devrait gérer les erreurs gracieusement', async () => {
    // Mock du service qui échoue
    vi.doMock('../../../../src/services/roosync/InventoryService.js', () => ({
      InventoryService: {
        getInstance: vi.fn().mockReturnValue({
          getMachineInventory: vi.fn().mockRejectedValue(new Error('Service unavailable'))
        })
      }
    }));

    const module = await import('../../../../src/tools/roosync/get-machine-inventory.js');
    const tool = module.getMachineInventoryTool;

    const result = await tool.execute({}, {
      services: createMockServices(),
      security: createMockSecurity(),
      monitoring: {
        immediate: createMockMonitoring(),
        background: createMockBackgroundMonitoring()
      },
      cacheManager: createMockCacheManager()
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('INVENTORY_COLLECTION_FAILED');
  });
});
