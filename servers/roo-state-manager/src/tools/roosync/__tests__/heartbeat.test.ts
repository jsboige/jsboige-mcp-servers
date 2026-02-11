/**
 * Tests pour roosync_heartbeat (CONS-#443 Groupe 1)
 *
 * Consolidation de heartbeat_status + heartbeat_service
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { roosyncHeartbeat, HeartbeatArgs } from '../heartbeat.js';
import { HeartbeatServiceError } from '../../../services/roosync/HeartbeatService.js';

// Mock des handlers délégués
vi.mock('../heartbeat-status.js', () => ({
  roosyncHeartbeatStatus: vi.fn()
}));

vi.mock('../heartbeat-service.js', () => ({
  roosyncHeartbeatService: vi.fn()
}));

// Import des mocks
import { roosyncHeartbeatStatus } from '../heartbeat-status.js';
import { roosyncHeartbeatService } from '../heartbeat-service.js';

describe('roosyncHeartbeat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================
  // Tests pour action: 'status'
  // ============================================================

  describe('action: status', () => {
    test('should delegate to heartbeat-status with default parameters', async () => {
      const mockStatusResult = {
        success: true,
        onlineMachines: ['myia-ai-01', 'myia-po-2024'],
        offlineMachines: [],
        warningMachines: [],
        statistics: {
          totalMachines: 2,
          onlineCount: 2,
          offlineCount: 0,
          warningCount: 0,
          lastHeartbeatCheck: '2026-02-11T08:00:00Z'
        },
        retrievedAt: '2026-02-11T08:00:00Z'
      };

      vi.mocked(roosyncHeartbeatStatus).mockResolvedValue(mockStatusResult);

      const args: HeartbeatArgs = {
        action: 'status'
      };

      const result = await roosyncHeartbeat(args);

      expect(result.success).toBe(true);
      expect(result.action).toBe('status');
      expect(result.message).toContain('État du heartbeat récupéré');
      expect(result.data).toEqual(mockStatusResult);
      expect(roosyncHeartbeatStatus).toHaveBeenCalledWith({
        filter: undefined,
        includeHeartbeats: undefined,
        forceCheck: undefined,
        includeChanges: undefined
      });
    });

    test('should delegate to heartbeat-status with filter=online', async () => {
      const mockStatusResult = {
        success: true,
        onlineMachines: ['myia-ai-01', 'myia-po-2024'],
        offlineMachines: [],
        warningMachines: [],
        statistics: {
          totalMachines: 2,
          onlineCount: 2,
          offlineCount: 0,
          warningCount: 0,
          lastHeartbeatCheck: '2026-02-11T08:00:00Z'
        },
        retrievedAt: '2026-02-11T08:00:00Z'
      };

      vi.mocked(roosyncHeartbeatStatus).mockResolvedValue(mockStatusResult);

      const args: HeartbeatArgs = {
        action: 'status',
        filter: 'online',
        includeHeartbeats: true
      };

      const result = await roosyncHeartbeat(args);

      expect(result.success).toBe(true);
      expect(roosyncHeartbeatStatus).toHaveBeenCalledWith({
        filter: 'online',
        includeHeartbeats: true,
        forceCheck: undefined,
        includeChanges: undefined
      });
    });

    test('should delegate to heartbeat-status with forceCheck=true', async () => {
      const mockStatusResult = {
        success: true,
        onlineMachines: ['myia-ai-01'],
        offlineMachines: ['myia-po-2024'],
        warningMachines: [],
        statistics: {
          totalMachines: 2,
          onlineCount: 1,
          offlineCount: 1,
          warningCount: 0,
          lastHeartbeatCheck: '2026-02-11T08:00:00Z'
        },
        changes: {
          newlyOfflineMachines: ['myia-po-2024'],
          newlyOnlineMachines: [],
          newWarnings: [],
          totalChanges: 1
        },
        retrievedAt: '2026-02-11T08:00:00Z'
      };

      vi.mocked(roosyncHeartbeatStatus).mockResolvedValue(mockStatusResult);

      const args: HeartbeatArgs = {
        action: 'status',
        forceCheck: true,
        includeChanges: true
      };

      const result = await roosyncHeartbeat(args);

      expect(result.success).toBe(true);
      expect(result.data.changes).toBeDefined();
      expect(roosyncHeartbeatStatus).toHaveBeenCalledWith({
        filter: undefined,
        includeHeartbeats: undefined,
        forceCheck: true,
        includeChanges: true
      });
    });
  });

  // ============================================================
  // Tests pour action: 'register'
  // ============================================================

  describe('action: register', () => {
    test('should delegate to heartbeat-service with machineId', async () => {
      const mockServiceResult = {
        success: true,
        message: 'Heartbeat enregistré pour myia-po-2024',
        result: {
          action: 'register' as const,
          machineId: 'myia-po-2024',
          timestamp: '2026-02-11T08:00:00Z',
          status: 'online' as const,
          isNewMachine: false
        }
      };

      vi.mocked(roosyncHeartbeatService).mockResolvedValue(mockServiceResult);

      const args: HeartbeatArgs = {
        action: 'register',
        machineId: 'myia-po-2024'
      };

      const result = await roosyncHeartbeat(args);

      expect(result.success).toBe(true);
      expect(result.action).toBe('register');
      expect(result.message).toBe('Heartbeat enregistré pour myia-po-2024');
      expect(result.data).toEqual(mockServiceResult.result);
      expect(roosyncHeartbeatService).toHaveBeenCalledWith({
        action: 'register',
        machineId: 'myia-po-2024',
        metadata: undefined,
        enableAutoSync: undefined,
        heartbeatInterval: undefined,
        offlineTimeout: undefined,
        saveState: undefined
      });
    });

    test('should delegate to heartbeat-service with metadata', async () => {
      const mockServiceResult = {
        success: true,
        message: 'Heartbeat enregistré pour myia-po-2024',
        result: {
          action: 'register' as const,
          machineId: 'myia-po-2024',
          timestamp: '2026-02-11T08:00:00Z',
          status: 'online' as const,
          isNewMachine: true
        }
      };

      vi.mocked(roosyncHeartbeatService).mockResolvedValue(mockServiceResult);

      const metadata = { version: '1.0.0', environment: 'test' };

      const args: HeartbeatArgs = {
        action: 'register',
        machineId: 'myia-po-2024',
        metadata
      };

      const result = await roosyncHeartbeat(args);

      expect(result.success).toBe(true);
      expect(result.data.isNewMachine).toBe(true);
      expect(roosyncHeartbeatService).toHaveBeenCalledWith({
        action: 'register',
        machineId: 'myia-po-2024',
        metadata,
        enableAutoSync: undefined,
        heartbeatInterval: undefined,
        offlineTimeout: undefined,
        saveState: undefined
      });
    });
  });

  // ============================================================
  // Tests pour action: 'start'
  // ============================================================

  describe('action: start', () => {
    test('should delegate to heartbeat-service with default config', async () => {
      const mockServiceResult = {
        success: true,
        message: 'Service de heartbeat démarré pour myia-po-2024',
        result: {
          action: 'start' as const,
          machineId: 'myia-po-2024',
          startedAt: '2026-02-11T08:00:00Z',
          config: {
            heartbeatInterval: 30000,
            offlineTimeout: 120000,
            autoSyncEnabled: true
          }
        }
      };

      vi.mocked(roosyncHeartbeatService).mockResolvedValue(mockServiceResult);

      const args: HeartbeatArgs = {
        action: 'start',
        machineId: 'myia-po-2024'
      };

      const result = await roosyncHeartbeat(args);

      expect(result.success).toBe(true);
      expect(result.action).toBe('start');
      expect(result.message).toContain('Service de heartbeat démarré');
      expect(result.data.config.heartbeatInterval).toBe(30000);
      expect(roosyncHeartbeatService).toHaveBeenCalledWith({
        action: 'start',
        machineId: 'myia-po-2024',
        metadata: undefined,
        enableAutoSync: undefined,
        heartbeatInterval: undefined,
        offlineTimeout: undefined,
        saveState: undefined
      });
    });

    test('should delegate to heartbeat-service with custom config', async () => {
      const mockServiceResult = {
        success: true,
        message: 'Service de heartbeat démarré pour myia-po-2024',
        result: {
          action: 'start' as const,
          machineId: 'myia-po-2024',
          startedAt: '2026-02-11T08:00:00Z',
          config: {
            heartbeatInterval: 60000,
            offlineTimeout: 180000,
            autoSyncEnabled: false
          }
        }
      };

      vi.mocked(roosyncHeartbeatService).mockResolvedValue(mockServiceResult);

      const args: HeartbeatArgs = {
        action: 'start',
        machineId: 'myia-po-2024',
        enableAutoSync: false,
        heartbeatInterval: 60000,
        offlineTimeout: 180000
      };

      const result = await roosyncHeartbeat(args);

      expect(result.success).toBe(true);
      expect(result.data.config.heartbeatInterval).toBe(60000);
      expect(result.data.config.offlineTimeout).toBe(180000);
      expect(result.data.config.autoSyncEnabled).toBe(false);
      expect(roosyncHeartbeatService).toHaveBeenCalledWith({
        action: 'start',
        machineId: 'myia-po-2024',
        metadata: undefined,
        enableAutoSync: false,
        heartbeatInterval: 60000,
        offlineTimeout: 180000,
        saveState: undefined
      });
    });
  });

  // ============================================================
  // Tests pour action: 'stop'
  // ============================================================

  describe('action: stop', () => {
    test('should delegate to heartbeat-service with saveState=true', async () => {
      const mockServiceResult = {
        success: true,
        message: 'Service de heartbeat arrêté avec succès',
        result: {
          action: 'stop' as const,
          stoppedAt: '2026-02-11T08:00:00Z',
          stateSaved: true
        }
      };

      vi.mocked(roosyncHeartbeatService).mockResolvedValue(mockServiceResult);

      const args: HeartbeatArgs = {
        action: 'stop',
        saveState: true
      };

      const result = await roosyncHeartbeat(args);

      expect(result.success).toBe(true);
      expect(result.action).toBe('stop');
      expect(result.message).toContain('arrêté avec succès');
      expect(result.data.stateSaved).toBe(true);
      expect(roosyncHeartbeatService).toHaveBeenCalledWith({
        action: 'stop',
        machineId: undefined,
        metadata: undefined,
        enableAutoSync: undefined,
        heartbeatInterval: undefined,
        offlineTimeout: undefined,
        saveState: true
      });
    });

    test('should delegate to heartbeat-service with saveState=false', async () => {
      const mockServiceResult = {
        success: true,
        message: 'Service de heartbeat arrêté avec succès',
        result: {
          action: 'stop' as const,
          stoppedAt: '2026-02-11T08:00:00Z',
          stateSaved: false
        }
      };

      vi.mocked(roosyncHeartbeatService).mockResolvedValue(mockServiceResult);

      const args: HeartbeatArgs = {
        action: 'stop',
        saveState: false
      };

      const result = await roosyncHeartbeat(args);

      expect(result.success).toBe(true);
      expect(result.data.stateSaved).toBe(false);
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should throw error for unknown action', async () => {
      const args: any = {
        action: 'unknown'
      };

      await expect(roosyncHeartbeat(args)).rejects.toThrow('Action non reconnue');
    });

    test('should propagate HeartbeatServiceError from heartbeat-status', async () => {
      const error = new HeartbeatServiceError('Test error', 'TEST_ERROR');
      vi.mocked(roosyncHeartbeatStatus).mockRejectedValue(error);

      const args: HeartbeatArgs = {
        action: 'status'
      };

      await expect(roosyncHeartbeat(args)).rejects.toThrow(HeartbeatServiceError);
      await expect(roosyncHeartbeat(args)).rejects.toThrow('Test error');
    });

    test('should propagate HeartbeatServiceError from heartbeat-service', async () => {
      const error = new HeartbeatServiceError('Register failed', 'REGISTER_ERROR');
      vi.mocked(roosyncHeartbeatService).mockRejectedValue(error);

      const args: HeartbeatArgs = {
        action: 'register',
        machineId: 'test'
      };

      await expect(roosyncHeartbeat(args)).rejects.toThrow(HeartbeatServiceError);
      await expect(roosyncHeartbeat(args)).rejects.toThrow('Register failed');
    });

    test('should wrap non-HeartbeatServiceError errors', async () => {
      const error = new Error('Internal error');
      vi.mocked(roosyncHeartbeatStatus).mockRejectedValue(error);

      const args: HeartbeatArgs = {
        action: 'status'
      };

      await expect(roosyncHeartbeat(args)).rejects.toThrow(HeartbeatServiceError);
      await expect(roosyncHeartbeat(args)).rejects.toThrow(/Internal error/);
    });
  });

  // ============================================================
  // Tests de format de sortie
  // ============================================================

  describe('output format', () => {
    test('should include timestamp in all results', async () => {
      const mockStatusResult = {
        success: true,
        onlineMachines: [],
        offlineMachines: [],
        warningMachines: [],
        statistics: {
          totalMachines: 0,
          onlineCount: 0,
          offlineCount: 0,
          warningCount: 0,
          lastHeartbeatCheck: '2026-02-11T08:00:00Z'
        },
        retrievedAt: '2026-02-11T08:00:00Z'
      };

      vi.mocked(roosyncHeartbeatStatus).mockResolvedValue(mockStatusResult);

      const args: HeartbeatArgs = {
        action: 'status'
      };

      const result = await roosyncHeartbeat(args);

      expect(result.timestamp).toBeDefined();
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    test('should include action in all results', async () => {
      const mockServiceResult = {
        success: true,
        message: 'Test',
        result: {
          action: 'stop' as const,
          stoppedAt: '2026-02-11T08:00:00Z',
          stateSaved: true
        }
      };

      vi.mocked(roosyncHeartbeatService).mockResolvedValue(mockServiceResult);

      const args: HeartbeatArgs = {
        action: 'stop'
      };

      const result = await roosyncHeartbeat(args);

      expect(result.action).toBe('stop');
    });
  });

  // ============================================================
  // Tests d'intégration (vérification de la délégation)
  // ============================================================

  describe('delegation verification', () => {
    test('should call heartbeat-status for status action', async () => {
      const mockResult = {
        success: true,
        onlineMachines: [],
        offlineMachines: [],
        warningMachines: [],
        statistics: {
          totalMachines: 0,
          onlineCount: 0,
          offlineCount: 0,
          warningCount: 0,
          lastHeartbeatCheck: '2026-02-11T08:00:00Z'
        },
        retrievedAt: '2026-02-11T08:00:00Z'
      };

      vi.mocked(roosyncHeartbeatStatus).mockResolvedValue(mockResult);

      await roosyncHeartbeat({ action: 'status' });

      expect(roosyncHeartbeatStatus).toHaveBeenCalled();
      expect(roosyncHeartbeatService).not.toHaveBeenCalled();
    });

    test('should call heartbeat-service for register action', async () => {
      const mockResult = {
        success: true,
        message: 'Test',
        result: {
          action: 'register' as const,
          machineId: 'test',
          timestamp: '2026-02-11T08:00:00Z',
          status: 'online' as const,
          isNewMachine: true
        }
      };

      vi.mocked(roosyncHeartbeatService).mockResolvedValue(mockResult);

      await roosyncHeartbeat({ action: 'register', machineId: 'test' });

      expect(roosyncHeartbeatService).toHaveBeenCalled();
      expect(roosyncHeartbeatStatus).not.toHaveBeenCalled();
    });

    test('should call heartbeat-service for start action', async () => {
      const mockResult = {
        success: true,
        message: 'Test',
        result: {
          action: 'start' as const,
          machineId: 'test',
          startedAt: '2026-02-11T08:00:00Z',
          config: {
            heartbeatInterval: 30000,
            offlineTimeout: 120000,
            autoSyncEnabled: true
          }
        }
      };

      vi.mocked(roosyncHeartbeatService).mockResolvedValue(mockResult);

      await roosyncHeartbeat({ action: 'start', machineId: 'test' });

      expect(roosyncHeartbeatService).toHaveBeenCalled();
      expect(roosyncHeartbeatStatus).not.toHaveBeenCalled();
    });

    test('should call heartbeat-service for stop action', async () => {
      const mockResult = {
        success: true,
        message: 'Test',
        result: {
          action: 'stop' as const,
          stoppedAt: '2026-02-11T08:00:00Z',
          stateSaved: true
        }
      };

      vi.mocked(roosyncHeartbeatService).mockResolvedValue(mockResult);

      await roosyncHeartbeat({ action: 'stop' });

      expect(roosyncHeartbeatService).toHaveBeenCalled();
      expect(roosyncHeartbeatStatus).not.toHaveBeenCalled();
    });
  });
});
