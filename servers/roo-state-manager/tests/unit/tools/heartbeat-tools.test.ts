/**
 * Tests unitaires pour les outils MCP Heartbeat
 *
 * @module tests/unit/tools/heartbeat-tools
 * @version 3.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { roosyncRegisterHeartbeat } from '../../../src/tools/roosync/register-heartbeat.js';
import { roosyncGetOfflineMachines } from '../../../src/tools/roosync/get-offline-machines.js';
import { roosyncGetWarningMachines } from '../../../src/tools/roosync/get-warning-machines.js';
import { roosyncGetHeartbeatState } from '../../../src/tools/roosync/get-heartbeat-state.js';
import { roosyncStartHeartbeatService } from '../../../src/tools/roosync/start-heartbeat-service.js';
import { roosyncStopHeartbeatService } from '../../../src/tools/roosync/stop-heartbeat-service.js';
import { roosyncCheckHeartbeats } from '../../../src/tools/roosync/check-heartbeats.js';
import { roosyncSyncOnOffline } from '../../../src/tools/roosync/sync-on-offline.js';
import { roosyncSyncOnOnline } from '../../../src/tools/roosync/sync-on-online.js';
import { getRooSyncService } from '../../../src/services/RooSyncService.js';

// Mock du RooSyncService
vi.mock('../../../src/services/RooSyncService.js', () => ({
  getRooSyncService: vi.fn()
}));

describe('Outils MCP Heartbeat', () => {
  const mockHeartbeatService = {
    registerHeartbeat: vi.fn(),
    getHeartbeatData: vi.fn(),
    getOfflineMachines: vi.fn(),
    getWarningMachines: vi.fn(),
    getState: vi.fn(),
    startHeartbeatService: vi.fn(),
    stopHeartbeatService: vi.fn(),
    checkHeartbeats: vi.fn(),
    updateConfig: vi.fn()
  };

  const mockRooSyncService = {
    getHeartbeatService: vi.fn(() => mockHeartbeatService)
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRooSyncService).mockReturnValue(mockRooSyncService as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('roosync_register_heartbeat', () => {
    it('devrait enregistrer un heartbeat pour une nouvelle machine', async () => {
      mockHeartbeatService.getHeartbeatData.mockReturnValue(undefined);
      mockHeartbeatService.registerHeartbeat.mockResolvedValue(undefined);
      mockHeartbeatService.getHeartbeatData.mockReturnValue({
        machineId: 'test-machine',
        lastHeartbeat: new Date().toISOString(),
        status: 'online' as const,
        missedHeartbeats: 0,
        metadata: {
          firstSeen: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          version: '3.0.0'
        }
      });

      const result = await roosyncRegisterHeartbeat({
        machineId: 'test-machine',
        metadata: { version: '1.0.0' }
      });

      expect(result.success).toBe(true);
      expect(result.machineId).toBe('test-machine');
      expect(result.isNewMachine).toBe(true);
      expect(result.status).toBe('online');
      expect(mockHeartbeatService.registerHeartbeat).toHaveBeenCalledWith(
        'test-machine',
        { version: '1.0.0' }
      );
    });

    it('devrait mettre à jour un heartbeat existant', async () => {
      mockHeartbeatService.getHeartbeatData.mockReturnValue({
        machineId: 'test-machine',
        lastHeartbeat: new Date(Date.now() - 60000).toISOString(),
        status: 'online' as const,
        missedHeartbeats: 0,
        metadata: {
          firstSeen: new Date(Date.now() - 120000).toISOString(),
          lastUpdated: new Date(Date.now() - 60000).toISOString(),
          version: '3.0.0'
        }
      });
      mockHeartbeatService.registerHeartbeat.mockResolvedValue(undefined);
      mockHeartbeatService.getHeartbeatData.mockReturnValue({
        machineId: 'test-machine',
        lastHeartbeat: new Date().toISOString(),
        status: 'online' as const,
        missedHeartbeats: 0,
        metadata: {
          firstSeen: new Date(Date.now() - 120000).toISOString(),
          lastUpdated: new Date().toISOString(),
          version: '3.0.0'
        }
      });

      const result = await roosyncRegisterHeartbeat({
        machineId: 'test-machine'
      });

      expect(result.success).toBe(true);
      expect(result.isNewMachine).toBe(false);
    });
  });

  describe('roosync_get_offline_machines', () => {
    it('devrait retourner la liste des machines offline sans détails', async () => {
      mockHeartbeatService.getOfflineMachines.mockReturnValue(['machine-1', 'machine-2']);

      const result = await roosyncGetOfflineMachines({ includeDetails: false });

      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect(result.machines).toEqual(['machine-1', 'machine-2']);
      expect(result.checkedAt).toBeDefined();
    });

    it('devrait retourner les détails des machines offline', async () => {
      const offlineData = {
        machineId: 'machine-1',
        lastHeartbeat: new Date(Date.now() - 300000).toISOString(),
        status: 'offline' as const,
        missedHeartbeats: 5,
        offlineSince: new Date(Date.now() - 180000).toISOString(),
        metadata: {
          firstSeen: new Date(Date.now() - 600000).toISOString(),
          lastUpdated: new Date(Date.now() - 300000).toISOString(),
          version: '3.0.0'
        }
      };

      mockHeartbeatService.getOfflineMachines.mockReturnValue(['machine-1']);
      mockHeartbeatService.getHeartbeatData.mockReturnValue(offlineData);

      const result = await roosyncGetOfflineMachines({ includeDetails: true });

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(Array.isArray(result.machines)).toBe(true);
      expect(result.machines).toHaveLength(1);
    });
  });

  describe('roosync_get_warning_machines', () => {
    it('devrait retourner la liste des machines en avertissement sans détails', async () => {
      mockHeartbeatService.getWarningMachines.mockReturnValue(['machine-3']);

      const result = await roosyncGetWarningMachines({ includeDetails: false });

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(result.machines).toEqual(['machine-3']);
    });

    it('devrait retourner les détails des machines en avertissement', async () => {
      const warningData = {
        machineId: 'machine-3',
        lastHeartbeat: new Date(Date.now() - 90000).toISOString(),
        status: 'warning' as const,
        missedHeartbeats: 3,
        metadata: {
          firstSeen: new Date(Date.now() - 300000).toISOString(),
          lastUpdated: new Date(Date.now() - 90000).toISOString(),
          version: '3.0.0'
        }
      };

      mockHeartbeatService.getWarningMachines.mockReturnValue(['machine-3']);
      mockHeartbeatService.getHeartbeatData.mockReturnValue(warningData);

      const result = await roosyncGetWarningMachines({ includeDetails: true });

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(Array.isArray(result.machines)).toBe(true);
    });
  });

  describe('roosync_get_heartbeat_state', () => {
    it('devrait retourner l\'état complet du service', async () => {
      const mockState = {
        heartbeats: new Map([
          ['machine-1', {
            machineId: 'machine-1',
            lastHeartbeat: new Date().toISOString(),
            status: 'online' as const,
            missedHeartbeats: 0,
            metadata: {
              firstSeen: new Date().toISOString(),
              lastUpdated: new Date().toISOString(),
              version: '3.0.0'
            }
          }]
        ]),
        onlineMachines: ['machine-1'],
        offlineMachines: [],
        warningMachines: [],
        statistics: {
          totalMachines: 1,
          onlineCount: 1,
          offlineCount: 0,
          warningCount: 0,
          lastHeartbeatCheck: new Date().toISOString()
        }
      };

      mockHeartbeatService.getState.mockReturnValue(mockState);

      const result = await roosyncGetHeartbeatState({ includeHeartbeats: true });

      expect(result.success).toBe(true);
      expect(result.onlineMachines).toEqual(['machine-1']);
      expect(result.offlineMachines).toEqual([]);
      expect(result.warningMachines).toEqual([]);
      expect(result.statistics.totalMachines).toBe(1);
      expect(result.statistics.onlineCount).toBe(1);
      expect(result.heartbeats).toBeDefined();
    });

    it('devrait retourner l\'état sans les données de heartbeat', async () => {
      const mockState = {
        heartbeats: new Map(),
        onlineMachines: [],
        offlineMachines: [],
        warningMachines: [],
        statistics: {
          totalMachines: 0,
          onlineCount: 0,
          offlineCount: 0,
          warningCount: 0,
          lastHeartbeatCheck: new Date().toISOString()
        }
      };

      mockHeartbeatService.getState.mockReturnValue(mockState);

      const result = await roosyncGetHeartbeatState({ includeHeartbeats: false });

      expect(result.success).toBe(true);
      expect(result.heartbeats).toBeUndefined();
    });
  });

  describe('roosync_start_heartbeat_service', () => {
    it('devrait démarrer le service de heartbeat', async () => {
      mockHeartbeatService.startHeartbeatService.mockResolvedValue(undefined);

      const result = await roosyncStartHeartbeatService({
        machineId: 'test-machine',
        enableAutoSync: true,
        heartbeatInterval: 30000,
        offlineTimeout: 120000
      });

      expect(result.success).toBe(true);
      expect(result.machineId).toBe('test-machine');
      expect(result.config.autoSyncEnabled).toBe(true);
      expect(result.config.heartbeatInterval).toBe(30000);
      expect(result.config.offlineTimeout).toBe(120000);
      expect(mockHeartbeatService.startHeartbeatService).toHaveBeenCalled();
    });

    it('devrait mettre à jour la configuration si fournie', async () => {
      mockHeartbeatService.updateConfig.mockResolvedValue(undefined);
      mockHeartbeatService.startHeartbeatService.mockResolvedValue(undefined);

      await roosyncStartHeartbeatService({
        machineId: 'test-machine',
        heartbeatInterval: 60000,
        offlineTimeout: 240000
      });

      expect(mockHeartbeatService.updateConfig).toHaveBeenCalledWith({
        heartbeatInterval: 60000,
        offlineTimeout: 240000,
        autoSyncEnabled: true
      });
    });
  });

  describe('roosync_stop_heartbeat_service', () => {
    it('devrait arrêter le service de heartbeat', async () => {
      mockHeartbeatService.stopHeartbeatService.mockResolvedValue(undefined);

      const result = await roosyncStopHeartbeatService({ saveState: true });

      expect(result.success).toBe(true);
      expect(result.stateSaved).toBe(true);
      expect(result.message).toContain('arrêté');
      expect(mockHeartbeatService.stopHeartbeatService).toHaveBeenCalled();
    });
  });

  describe('roosync_check_heartbeats', () => {
    it('devrait vérifier les heartbeats et retourner les changements', async () => {
      const mockCheckResult = {
        success: true,
        newlyOfflineMachines: ['machine-2'],
        newlyOnlineMachines: ['machine-1'],
        warningMachines: ['machine-3'],
        checkedAt: new Date().toISOString()
      };

      mockHeartbeatService.checkHeartbeats.mockResolvedValue(mockCheckResult);

      const result = await roosyncCheckHeartbeats({ forceCheck: true });

      expect(result.success).toBe(true);
      expect(result.newlyOfflineMachines).toEqual(['machine-2']);
      expect(result.newlyOnlineMachines).toEqual(['machine-1']);
      expect(result.warningMachines).toEqual(['machine-3']);
      expect(result.summary.totalChanges).toBe(3);
      expect(result.summary.offlineCount).toBe(1);
      expect(result.summary.onlineCount).toBe(1);
      expect(result.summary.warningCount).toBe(1);
    });

    it('devrait retourner un résumé vide sans changements', async () => {
      const mockCheckResult = {
        success: true,
        newlyOfflineMachines: [],
        newlyOnlineMachines: [],
        warningMachines: [],
        checkedAt: new Date().toISOString()
      };

      mockHeartbeatService.checkHeartbeats.mockResolvedValue(mockCheckResult);

      const result = await roosyncCheckHeartbeats({});

      expect(result.summary.totalChanges).toBe(0);
      expect(result.summary.offlineCount).toBe(0);
      expect(result.summary.onlineCount).toBe(0);
      expect(result.summary.warningCount).toBe(0);
    });
  });

  describe('roosync_sync_on_offline', () => {
    it('devrait synchroniser lors de la détection offline', async () => {
      const offlineData = {
        machineId: 'offline-machine',
        lastHeartbeat: new Date(Date.now() - 300000).toISOString(),
        status: 'offline' as const,
        missedHeartbeats: 5,
        offlineSince: new Date(Date.now() - 180000).toISOString(),
        metadata: {
          firstSeen: new Date(Date.now() - 600000).toISOString(),
          lastUpdated: new Date(Date.now() - 300000).toISOString(),
          version: '3.0.0'
        }
      };

      mockHeartbeatService.getHeartbeatData.mockReturnValue(offlineData);

      const result = await roosyncSyncOnOffline({
        machineId: 'offline-machine',
        createBackup: true,
        dryRun: false
      });

      expect(result.success).toBe(true);
      expect(result.machineId).toBe('offline-machine');
      expect(result.backupCreated).toBe(true);
      expect(result.message).toContain('offline');
    });

    it('devrait rejeter si la machine n\'est pas offline', async () => {
      const onlineData = {
        machineId: 'online-machine',
        lastHeartbeat: new Date().toISOString(),
        status: 'online' as const,
        missedHeartbeats: 0,
        metadata: {
          firstSeen: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          version: '3.0.0'
        }
      };

      mockHeartbeatService.getHeartbeatData.mockReturnValue(onlineData);

      await expect(
        roosyncSyncOnOffline({ machineId: 'online-machine' })
      ).rejects.toThrow('n\'est pas offline');
    });

    it('devrait fonctionner en mode simulation', async () => {
      const offlineData = {
        machineId: 'offline-machine',
        lastHeartbeat: new Date(Date.now() - 300000).toISOString(),
        status: 'offline' as const,
        missedHeartbeats: 5,
        offlineSince: new Date(Date.now() - 180000).toISOString(),
        metadata: {
          firstSeen: new Date(Date.now() - 600000).toISOString(),
          lastUpdated: new Date(Date.now() - 300000).toISOString(),
          version: '3.0.0'
        }
      };

      mockHeartbeatService.getHeartbeatData.mockReturnValue(offlineData);

      const result = await roosyncSyncOnOffline({
        machineId: 'offline-machine',
        dryRun: true
      });

      expect(result.success).toBe(true);
      expect(result.backupCreated).toBe(false);
      expect(result.message).toContain('Mode simulation');
    });
  });

  describe('roosync_sync_on_online', () => {
    it('devrait synchroniser lors du retour online', async () => {
      const onlineData = {
        machineId: 'online-machine',
        lastHeartbeat: new Date().toISOString(),
        status: 'online' as const,
        missedHeartbeats: 0,
        offlineSince: new Date(Date.now() - 180000).toISOString(),
        metadata: {
          firstSeen: new Date(Date.now() - 600000).toISOString(),
          lastUpdated: new Date().toISOString(),
          version: '3.0.0'
        }
      };

      mockHeartbeatService.getHeartbeatData.mockReturnValue(onlineData);

      const result = await roosyncSyncOnOnline({
        machineId: 'online-machine',
        createBackup: true,
        dryRun: false
      });

      expect(result.success).toBe(true);
      expect(result.machineId).toBe('online-machine');
      expect(result.backupCreated).toBe(true);
      expect(result.changes.offlineDuration).toBeDefined();
      expect(result.changes.offlineDuration).toBeGreaterThan(0);
      expect(result.message).toContain('online');
    });

    it('devrait rejeter si la machine n\'est pas online', async () => {
      const offlineData = {
        machineId: 'offline-machine',
        lastHeartbeat: new Date(Date.now() - 300000).toISOString(),
        status: 'offline' as const,
        missedHeartbeats: 5,
        offlineSince: new Date(Date.now() - 180000).toISOString(),
        metadata: {
          firstSeen: new Date(Date.now() - 600000).toISOString(),
          lastUpdated: new Date(Date.now() - 300000).toISOString(),
          version: '3.0.0'
        }
      };

      mockHeartbeatService.getHeartbeatData.mockReturnValue(offlineData);

      await expect(
        roosyncSyncOnOnline({ machineId: 'offline-machine' })
      ).rejects.toThrow('n\'est pas online');
    });

    it('devrait fonctionner en mode simulation', async () => {
      const onlineData = {
        machineId: 'online-machine',
        lastHeartbeat: new Date().toISOString(),
        status: 'online' as const,
        missedHeartbeats: 0,
        metadata: {
          firstSeen: new Date(Date.now() - 600000).toISOString(),
          lastUpdated: new Date().toISOString(),
          version: '3.0.0'
        }
      };

      mockHeartbeatService.getHeartbeatData.mockReturnValue(onlineData);

      const result = await roosyncSyncOnOnline({
        machineId: 'online-machine',
        dryRun: true
      });

      expect(result.success).toBe(true);
      expect(result.backupCreated).toBe(false);
      expect(result.message).toContain('Mode simulation');
    });
  });
});
