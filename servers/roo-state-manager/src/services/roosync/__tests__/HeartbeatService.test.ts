/**
 * Tests unitaires pour HeartbeatService - Système de heartbeat multi-agent
 *
 * Tests pour les fonctionnalités de heartbeat:
 * - Enregistrement de heartbeat
 * - Vérification de statut de machine
 * - Nettoyage des heartbeats obsolètes
 * - Statistiques
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HeartbeatService, HeartbeatServiceError } from '../HeartbeatService.js';

describe('HeartbeatService - Système de Heartbeat', () => {
  let heartbeatService: HeartbeatService;
  let mockConfig: any;
  let mockLockManager: any;

  beforeEach(() => {
    mockConfig = {
      machineId: 'test-machine-01',
      sharedPath: '/tmp/test-heartbeat',
      autoSync: false,
      conflictStrategy: 'manual',
      logLevel: 'info'
    };

    // Mock FileLockManager
    mockLockManager = {
      updateJsonWithLock: vi.fn().mockImplementation(async (filePath: string, updateFn: Function) => {
        const existingData = { heartbeats: {}, lastUpdated: new Date().toISOString(), version: '1.0.0' };
        const updatedData = updateFn(existingData);
        return { success: true, data: updatedData };
      }),
      withLock: vi.fn().mockImplementation(async (filePath: string, fn: Function) => {
        await fn();
        return { success: true };
      })
    };

    heartbeatService = new HeartbeatService(mockConfig, mockLockManager);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('registerHeartbeat', () => {
    it('devrait enregistrer un heartbeat avec succès', async () => {
      const machineId = 'test-machine-01';
      const timestamp = Date.now();

      await heartbeatService.registerHeartbeat(machineId, timestamp);

      expect(mockLockManager.updateJsonWithLock).toHaveBeenCalled();
    });

    it('devrait incrémenter le compteur de heartbeats', async () => {
      const machineId = 'test-machine-01';
      const timestamp = Date.now();

      // Premier heartbeat
      await heartbeatService.registerHeartbeat(machineId, timestamp);

      // Deuxième heartbeat
      await heartbeatService.registerHeartbeat(machineId, timestamp + 1000);

      expect(mockLockManager.updateJsonWithLock).toHaveBeenCalledTimes(2);
    });

    it('devrait rejeter un machineId invalide', async () => {
      await expect(
        heartbeatService.registerHeartbeat('', Date.now())
      ).rejects.toThrow(HeartbeatServiceError);
    });

    it('devrait inclure les métadonnées optionnelles', async () => {
      const machineId = 'test-machine-01';
      const metadata = {
        version: '1.0.0',
        mode: 'code',
        source: 'test'
      };

      await heartbeatService.registerHeartbeat(machineId, Date.now(), { metadata });

      expect(mockLockManager.updateJsonWithLock).toHaveBeenCalled();
    });
  });

  describe('isMachineAlive', () => {
    it('devrait retourner true pour une machine récemment active', async () => {
      const machineId = 'test-machine-01';
      const now = Date.now();

      // Enregistrer un heartbeat récent
      await heartbeatService.registerHeartbeat(machineId, now);

      const isAlive = await heartbeatService.isMachineAlive(machineId);

      expect(isAlive).toBe(true);
    });

    it('devrait retourner false pour une machine inactive', async () => {
      const machineId = 'test-machine-01';
      const oldTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes

      // Enregistrer un heartbeat vieux
      await heartbeatService.registerHeartbeat(machineId, oldTimestamp);

      const isAlive = await heartbeatService.isMachineAlive(machineId);

      expect(isAlive).toBe(false);
    });

    it('devrait utiliser le timeout personnalisé', async () => {
      const machineId = 'test-machine-01';
      const now = Date.now();
      const customTimeout = 2 * 60 * 1000; // 2 minutes

      // Enregistrer un heartbeat il y a 3 minutes
      await heartbeatService.registerHeartbeat(machineId, now - 3 * 60 * 1000);

      const isAlive = await heartbeatService.isMachineAlive(machineId, customTimeout);

      expect(isAlive).toBe(false);
    });

    it('devrait retourner false pour une machine inconnue', async () => {
      const isAlive = await heartbeatService.isMachineAlive('unknown-machine');

      expect(isAlive).toBe(false);
    });
  });

  describe('getAliveMachines', () => {
    it('devrait retourner la liste des machines en ligne', async () => {
      const now = Date.now();

      // Enregistrer plusieurs heartbeats
      await heartbeatService.registerHeartbeat('machine-01', now);
      await heartbeatService.registerHeartbeat('machine-02', now);
      await heartbeatService.registerHeartbeat('machine-03', now - 10 * 60 * 1000); // Inactive

      const aliveMachines = await heartbeatService.getAliveMachines();

      expect(aliveMachines).toContain('machine-01');
      expect(aliveMachines).toContain('machine-02');
      expect(aliveMachines).not.toContain('machine-03');
    });

    it('devrait retourner un tableau vide si aucune machine active', async () => {
      const aliveMachines = await heartbeatService.getAliveMachines();

      expect(aliveMachines).toEqual([]);
    });
  });

  describe('cleanupStaleMachines', () => {
    it('devrait marquer les machines obsolètes comme offline', async () => {
      const now = Date.now();

      // Enregistrer des heartbeats
      await heartbeatService.registerHeartbeat('machine-01', now);
      await heartbeatService.registerHeartbeat('machine-02', now - 10 * 60 * 1000); // Obsolète

      const result = await heartbeatService.cleanupStaleMachines();

      expect(result.cleaned).toBeGreaterThan(0);
      expect(result.remaining).toBeGreaterThan(0);
    });

    it('devrait utiliser le timeout personnalisé', async () => {
      const now = Date.now();
      const customTimeout = 2 * 60 * 1000; // 2 minutes

      // Enregistrer un heartbeat il y a 3 minutes
      await heartbeatService.registerHeartbeat('machine-01', now - 3 * 60 * 1000);

      const result = await heartbeatService.cleanupStaleMachines(customTimeout);

      expect(result.cleaned).toBeGreaterThan(0);
    });
  });

  describe('getHeartbeatData', () => {
    it('devrait retourner les données de heartbeat pour une machine', async () => {
      const machineId = 'test-machine-01';
      const timestamp = Date.now();

      await heartbeatService.registerHeartbeat(machineId, timestamp);

      const data = await heartbeatService.getHeartbeatData(machineId);

      expect(data).not.toBeNull();
      expect(data?.machineId).toBe(machineId);
      expect(data?.lastHeartbeat).toBe(timestamp);
    });

    it('devrait retourner null pour une machine inconnue', async () => {
      const data = await heartbeatService.getHeartbeatData('unknown-machine');

      expect(data).toBeNull();
    });
  });

  describe('getAllHeartbeats', () => {
    it('devrait retourner toutes les données de heartbeat', async () => {
      const now = Date.now();

      await heartbeatService.registerHeartbeat('machine-01', now);
      await heartbeatService.registerHeartbeat('machine-02', now);

      const allHeartbeats = await heartbeatService.getAllHeartbeats();

      expect(allHeartbeats).toHaveLength(2);
    });
  });

  describe('getHeartbeatStats', () => {
    it('devrait retourner les statistiques des heartbeats', async () => {
      const now = Date.now();

      await heartbeatService.registerHeartbeat('machine-01', now);
      await heartbeatService.registerHeartbeat('machine-02', now - 10 * 60 * 1000);

      const stats = await heartbeatService.getHeartbeatStats();

      expect(stats.total).toBe(2);
      expect(stats.online).toBe(1);
      expect(stats.offline).toBe(1);
      expect(stats.unknown).toBe(0);
    });

    it('devrait retourner des statistiques vides si aucun heartbeat', async () => {
      const stats = await heartbeatService.getHeartbeatStats();

      expect(stats.total).toBe(0);
      expect(stats.online).toBe(0);
      expect(stats.offline).toBe(0);
      expect(stats.unknown).toBe(0);
    });
  });
});
