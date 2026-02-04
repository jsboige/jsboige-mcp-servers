/**
 * Tests unitaires pour roosync_inventory
 *
 * Couvre tous les types de l'outil consolidé :
 * - type: 'machine' : Inventaire machine
 * - type: 'heartbeat' : État heartbeat
 * - type: 'all' : Les deux
 *
 * Framework: Vitest
 * Coverage cible: >80%
 *
 * @module roosync/inventory.test
 * @version 1.0.0 (CONS-6)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';

// Mock InventoryService
vi.mock('../../../services/roosync/InventoryService.js', () => ({
  InventoryService: {
    getInstance: vi.fn(() => ({
      getMachineInventory: vi.fn((machineId) => ({
        machineId: machineId || 'test-hostname',
        timestamp: new Date().toISOString(),
        config: {
          modes: ['code', 'architect', 'ask'],
          mcp: ['quickfiles', 'jinavigator']
        }
      }))
    }))
  }
}));

// Mock RooSyncService et HeartbeatService
vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: vi.fn(() => ({
    getHeartbeatService: vi.fn(() => ({
      getState: vi.fn(() => ({
        onlineMachines: ['machine-1', 'machine-2'],
        offlineMachines: ['machine-3'],
        warningMachines: ['machine-4'],
        statistics: {
          totalMachines: 4,
          onlineCount: 2,
          offlineCount: 1,
          warningCount: 1,
          lastHeartbeatCheck: new Date().toISOString()
        },
        heartbeats: new Map([
          ['machine-1', {
            machineId: 'machine-1',
            lastHeartbeat: new Date().toISOString(),
            status: 'online',
            missedHeartbeats: 0,
            metadata: {
              firstSeen: new Date().toISOString(),
              lastUpdated: new Date().toISOString(),
              version: '1.0.0'
            }
          }]
        ])
      }))
    }))
  }))
}));

// Mock ExecutionContext complet
const mockExecutionContext: any = {
  services: {
    storage: {
      read: vi.fn(),
      write: vi.fn(),
      delete: vi.fn()
    },
    cache: {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn()
    },
    search: {
      search: vi.fn(),
      index: vi.fn()
    },
    export: {
      export: vi.fn(),
      format: vi.fn()
    },
    summary: {
      summarize: vi.fn(),
      aggregate: vi.fn()
    },
    display: {
      display: vi.fn(),
      format: vi.fn()
    },
    utility: {
      validate: vi.fn(),
      transform: vi.fn()
    }
  },
  security: {
    validateInput: vi.fn(() => true),
    sanitizeOutput: vi.fn((x) => x)
  },
  monitoring: {
    immediate: {
      logEvent: vi.fn(),
      logError: vi.fn()
    },
    background: {
      logEvent: vi.fn(),
      logError: vi.fn()
    }
  },
  cacheManager: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn()
  }
};

// Import après les mocks
import { inventoryTool } from '../inventory.js';

describe('inventoryTool', () => {
  beforeEach(() => {
    // Reset mocks avant chaque test
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Cleanup
    vi.restoreAllMocks();
  });

  // ============================================================
  // Tests pour type: 'machine'
  // ============================================================

  describe('type: machine', () => {
    test('should return machine inventory', async () => {
      const result = await inventoryTool.execute(
        { type: 'machine' },
        mockExecutionContext
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.machineInventory).toBeDefined();
      expect(result.data.machineInventory.machineId).toBe('test-hostname');
      expect(result.data.heartbeatState).toBeUndefined();
    });

    test('should return machine inventory with custom machineId', async () => {
      const result = await inventoryTool.execute(
        { type: 'machine', machineId: 'custom-machine' },
        mockExecutionContext
      );

      expect(result.success).toBe(true);
      expect(result.data.machineInventory.machineId).toBe('custom-machine');
    });

    test('should handle errors gracefully', async () => {
      // Mock pour simuler une erreur
      const { InventoryService } = await import('../../../services/roosync/InventoryService.js');
      vi.mocked(InventoryService.getInstance).mockImplementationOnce(() => {
        throw new Error('Inventory service error');
      });

      const result = await inventoryTool.execute(
        { type: 'machine' },
        mockExecutionContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('INVENTORY_COLLECTION_FAILED');
    });
  });

  // ============================================================
  // Tests pour type: 'heartbeat'
  // ============================================================

  describe('type: heartbeat', () => {
    test('should return heartbeat state', async () => {
      const result = await inventoryTool.execute(
        { type: 'heartbeat' },
        mockExecutionContext
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.heartbeatState).toBeDefined();
      expect(result.data.heartbeatState.onlineMachines).toEqual(['machine-1', 'machine-2']);
      expect(result.data.heartbeatState.offlineMachines).toEqual(['machine-3']);
      expect(result.data.heartbeatState.warningMachines).toEqual(['machine-4']);
      expect(result.data.machineInventory).toBeUndefined();
    });

    test('should include heartbeat data by default', async () => {
      const result = await inventoryTool.execute(
        { type: 'heartbeat' },
        mockExecutionContext
      );

      expect(result.data.heartbeatState.heartbeats).toBeDefined();
      expect(result.data.heartbeatState.heartbeats['machine-1']).toBeDefined();
    });

    test('should exclude heartbeat data when includeHeartbeats=false', async () => {
      const result = await inventoryTool.execute(
        { type: 'heartbeat', includeHeartbeats: false },
        mockExecutionContext
      );

      expect(result.data.heartbeatState.heartbeats).toBeUndefined();
    });

    test('should return statistics', async () => {
      const result = await inventoryTool.execute(
        { type: 'heartbeat' },
        mockExecutionContext
      );

      expect(result.data.heartbeatState.statistics).toBeDefined();
      expect(result.data.heartbeatState.statistics.totalMachines).toBe(4);
      expect(result.data.heartbeatState.statistics.onlineCount).toBe(2);
      expect(result.data.heartbeatState.statistics.offlineCount).toBe(1);
      expect(result.data.heartbeatState.statistics.warningCount).toBe(1);
    });
  });

  // ============================================================
  // Tests pour type: 'all'
  // ============================================================

  describe('type: all', () => {
    test('should return both machine inventory and heartbeat state', async () => {
      const result = await inventoryTool.execute(
        { type: 'all' },
        mockExecutionContext
      );

      expect(result.success).toBe(true);
      expect(result.data.machineInventory).toBeDefined();
      expect(result.data.heartbeatState).toBeDefined();
    });

    test('should include heartbeat data in all mode', async () => {
      const result = await inventoryTool.execute(
        { type: 'all' },
        mockExecutionContext
      );

      expect(result.data.heartbeatState.heartbeats).toBeDefined();
    });

    test('should exclude heartbeat data in all mode when includeHeartbeats=false', async () => {
      const result = await inventoryTool.execute(
        { type: 'all', includeHeartbeats: false },
        mockExecutionContext
      );

      expect(result.data.heartbeatState.heartbeats).toBeUndefined();
    });
  });

  // ============================================================
  // Tests de validation
  // ============================================================

  describe('validation', () => {
    test('should have correct metadata', () => {
      const { inventoryToolMetadata } = require('../inventory.js');

      expect(inventoryToolMetadata.name).toBe('roosync_inventory');
      expect(inventoryToolMetadata.description).toContain('inventaire');
      expect(inventoryToolMetadata.inputSchema.properties.type).toBeDefined();
      expect(inventoryToolMetadata.inputSchema.properties.type.enum).toEqual(['machine', 'heartbeat', 'all']);
    });

    test('should require type parameter', () => {
      const { inventoryToolMetadata } = require('../inventory.js');

      expect(inventoryToolMetadata.inputSchema.required).toContain('type');
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration', () => {
    test('should handle multiple calls with different types', async () => {
      const r1 = await inventoryTool.execute({ type: 'machine' }, mockExecutionContext);
      const r2 = await inventoryTool.execute({ type: 'heartbeat' }, mockExecutionContext);
      const r3 = await inventoryTool.execute({ type: 'all' }, mockExecutionContext);

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      expect(r3.success).toBe(true);
    });

    test('should return execution time metrics', async () => {
      const result = await inventoryTool.execute(
        { type: 'machine' },
        mockExecutionContext
      );

      expect(result.metrics).toBeDefined();
      expect(result.metrics.executionTime).toBeGreaterThanOrEqual(0);
    });
  });
});
