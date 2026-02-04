/**
 * Tests unitaires pour roosync_machines
 *
 * Couvre tous les status de l'outil consolidé :
 * - status: 'offline' : Machines offline
 * - status: 'warning' : Machines en avertissement
 * - status: 'all' : Les deux
 *
 * Framework: Vitest
 * Coverage cible: >80%
 *
 * @module roosync/machines.test
 * @version 1.0.0 (CONS-6)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';

// Mock RooSyncService et HeartbeatService
vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: vi.fn(() => ({
    getHeartbeatService: vi.fn(() => ({
      getOfflineMachines: vi.fn(() => ['machine-3', 'machine-5']),
      getWarningMachines: vi.fn(() => ['machine-4', 'machine-6']),
      getHeartbeatData: vi.fn((machineId) => {
        const data: any = {
          machineId,
          lastHeartbeat: new Date().toISOString(),
          missedHeartbeats: 3,
          metadata: {
            firstSeen: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            version: '1.0.0'
          }
        };

        // Ajouter offlineSince pour les machines offline
        if (machineId === 'machine-3' || machineId === 'machine-5') {
          data.offlineSince = new Date(Date.now() - 3600000).toISOString();
        }

        return data;
      })
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
import { roosyncMachines } from '../machines.js';

describe('roosyncMachines', () => {
  beforeEach(() => {
    // Reset mocks avant chaque test
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Cleanup
    vi.restoreAllMocks();
  });

  // ============================================================
  // Tests pour status: 'offline'
  // ============================================================

  describe('status: offline', () => {
    test('should return offline machines', async () => {
      const result = await roosyncMachines(
        { status: 'offline' },
        mockExecutionContext
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.offlineMachines).toEqual(['machine-3', 'machine-5']);
      expect(result.data.warningMachines).toBeUndefined();
    });

    test('should return offline machines with details', async () => {
      const result = await roosyncMachines(
        { status: 'offline', includeDetails: true },
        mockExecutionContext
      );

      expect(result.success).toBe(true);
      expect(result.data.offlineMachines![0].offlineSince).toBeDefined();
    });

    test('should handle errors gracefully', async () => {
      // Mock pour simuler une erreur
      const { getRooSyncService } = await import('../../../services/RooSyncService.js');
      vi.mocked(getRooSyncService).mockImplementationOnce(() => {
        throw new Error('Heartbeat service error');
      });

      const result = await roosyncMachines(
        { status: 'offline' },
        mockExecutionContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('MACHINES_COLLECTION_FAILED');
    });
  });

  // ============================================================
  // Tests pour status: 'warning'
  // ============================================================

  describe('status: warning', () => {
    test('should return warning machines', async () => {
      const result = await roosyncMachines(
        { status: 'warning' },
        mockExecutionContext
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.warningMachines).toEqual(['machine-4', 'machine-6']);
      expect(result.data.offlineMachines).toBeUndefined();
    });

    test('should return warning machines with details', async () => {
      const result = await roosyncMachines(
        { status: 'warning', includeDetails: true },
        mockExecutionContext
      );

      expect(result.success).toBe(true);
      expect(result.data.warningMachines![0].missedHeartbeats).toBe(3);
    });
  });

  // ============================================================
  // Tests pour status: 'all'
  // ============================================================

  describe('status: all', () => {
    test('should return both offline and warning machines', async () => {
      const result = await roosyncMachines(
        { status: 'all' },
        mockExecutionContext
      );

      expect(result.success).toBe(true);
      expect(result.data.offlineMachines).toEqual(['machine-3', 'machine-5']);
      expect(result.data.warningMachines).toEqual(['machine-4', 'machine-6']);
    });

    test('should include details when requested', async () => {
      const result = await roosyncMachines(
        { status: 'all', includeDetails: true },
        mockExecutionContext
      );

      expect(result.data.offlineMachines![0].offlineSince).toBeDefined();
      expect(result.data.warningMachines![0].missedHeartbeats).toBe(3);
    });
  });

  // ============================================================
  // Tests de validation
  // ============================================================

  describe('validation', () => {
    test('should have correct metadata', () => {
      const { machinesToolMetadata } = require('../machines.js');

      expect(machinesToolMetadata.name).toBe('roosync_machines');
      expect(machinesToolMetadata.description).toContain('machines');
      expect(machinesToolMetadata.inputSchema.properties.status).toBeDefined();
      expect(machinesToolMetadata.inputSchema.properties.status.enum).toEqual(['offline', 'warning', 'all']);
    });

    test('should require status parameter', () => {
      const { machinesToolMetadata } = require('../machines.js');

      expect(machinesToolMetadata.inputSchema.required).toContain('status');
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration', () => {
    test('should handle multiple calls with different status', async () => {
      const r1 = await roosyncMachines({ status: 'offline' }, mockExecutionContext);
      const r2 = await roosyncMachines({ status: 'warning' }, mockExecutionContext);
      const r3 = await roosyncMachines({ status: 'all' }, mockExecutionContext);

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      expect(r3.success).toBe(true);
    });

    test('should return execution time metrics', async () => {
      const result = await roosyncMachines(
        { status: 'offline' },
        mockExecutionContext
      );

      expect(result.metrics).toBeDefined();
      expect(result.metrics.executionTime).toBeGreaterThanOrEqual(0);
    });
  });
});
