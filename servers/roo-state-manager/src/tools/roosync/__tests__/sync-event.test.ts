/**
 * Tests unitaires pour roosync_sync_event
 *
 * CONS-#443 Groupe 2 : Consolidation de sync_on_offline + sync_on_online
 * Couvre toutes les actions de l'outil consolidé :
 * - action: 'offline' : Synchronisation lors du passage offline
 * - action: 'online' : Synchronisation lors du retour online
 *
 * Framework: Vitest
 * Coverage cible: >80%
 *
 * @module roosync/sync-event.test
 * @version 1.0.0 (CONS-#443 Groupe 2)
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { roosyncSyncEvent, type SyncEventArgs } from '../sync-event.js';
import { HeartbeatServiceError } from '../../../services/roosync/HeartbeatService.js';

// Mock getRooSyncService pour contrôler le HeartbeatService
const mockGetHeartbeatData = vi.fn();
vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: () => ({
    getHeartbeatService: () => ({
      getHeartbeatData: mockGetHeartbeatData
    })
  })
}));

describe('roosyncSyncEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================
  // Tests pour action: 'offline'
  // ============================================================

  describe('action: offline', () => {
    test('should sync offline successfully with default options', async () => {
      // Setup: machine offline
      mockGetHeartbeatData.mockReturnValue({
        status: 'offline',
        machineId: 'test-machine-1'
      });

      const args: SyncEventArgs = {
        action: 'offline',
        machineId: 'test-machine-1'
      };

      const result = await roosyncSyncEvent(args);

      expect(result.success).toBe(true);
      expect(result.action).toBe('offline');
      expect(result.machineId).toBe('test-machine-1');
      expect(result.backupCreated).toBe(true); // défaut: true
      expect(result.backupPath).toContain('offline-sync-test-machine-1');
      expect(result.message).toContain('Synchronisation offline effectuée');
      expect(result.changes).toBeDefined();
      expect(result.changes.offlineDuration).toBeUndefined(); // offline n'a pas de durée
    });

    test('should sync offline in dry-run mode', async () => {
      mockGetHeartbeatData.mockReturnValue({
        status: 'offline',
        machineId: 'test-machine-2'
      });

      const args: SyncEventArgs = {
        action: 'offline',
        machineId: 'test-machine-2',
        dryRun: true
      };

      const result = await roosyncSyncEvent(args);

      expect(result.success).toBe(true);
      expect(result.backupCreated).toBe(false); // dryRun ne crée pas de backup
      expect(result.backupPath).toBeUndefined();
      expect(result.message).toContain('Mode simulation');
      expect(result.changes.filesSynced).toBe(0);
    });

    test('should sync offline without backup when createBackup=false', async () => {
      mockGetHeartbeatData.mockReturnValue({
        status: 'offline',
        machineId: 'test-machine-3'
      });

      const args: SyncEventArgs = {
        action: 'offline',
        machineId: 'test-machine-3',
        createBackup: false
      };

      const result = await roosyncSyncEvent(args);

      expect(result.success).toBe(true);
      expect(result.backupCreated).toBe(false);
      expect(result.backupPath).toBeUndefined();
    });

    test('should throw error when machine is not offline', async () => {
      mockGetHeartbeatData.mockReturnValue({
        status: 'online', // machine online au lieu d'offline
        machineId: 'test-machine-4'
      });

      const args: SyncEventArgs = {
        action: 'offline',
        machineId: 'test-machine-4'
      };

      await expect(roosyncSyncEvent(args)).rejects.toThrow(HeartbeatServiceError);
      await expect(roosyncSyncEvent(args)).rejects.toThrow('n\'est pas offline');
    });

    test('should throw error when machine data is not found', async () => {
      mockGetHeartbeatData.mockReturnValue(null); // machine inconnue

      const args: SyncEventArgs = {
        action: 'offline',
        machineId: 'unknown-machine'
      };

      await expect(roosyncSyncEvent(args)).rejects.toThrow(HeartbeatServiceError);
    });
  });

  // ============================================================
  // Tests pour action: 'online'
  // ============================================================

  describe('action: online', () => {
    test('should sync online successfully with default options', async () => {
      // Setup: machine online avec durée offline
      mockGetHeartbeatData.mockReturnValue({
        status: 'online',
        machineId: 'test-machine-5',
        offlineSince: new Date(Date.now() - 3600000).toISOString() // 1h ago
      });

      const args: SyncEventArgs = {
        action: 'online',
        machineId: 'test-machine-5'
      };

      const result = await roosyncSyncEvent(args);

      expect(result.success).toBe(true);
      expect(result.action).toBe('online');
      expect(result.machineId).toBe('test-machine-5');
      expect(result.backupCreated).toBe(true); // défaut: true
      expect(result.backupPath).toContain('online-sync-test-machine-5');
      expect(result.message).toContain('Synchronisation online effectuée');
      expect(result.changes.offlineDuration).toBeGreaterThan(0); // durée calculée
      expect(result.changes.offlineDuration).toBeLessThanOrEqual(3600000 + 1000); // ~1h + marge
    });

    test('should sync online in dry-run mode', async () => {
      mockGetHeartbeatData.mockReturnValue({
        status: 'online',
        machineId: 'test-machine-6'
      });

      const args: SyncEventArgs = {
        action: 'online',
        machineId: 'test-machine-6',
        dryRun: true
      };

      const result = await roosyncSyncEvent(args);

      expect(result.success).toBe(true);
      expect(result.backupCreated).toBe(false);
      expect(result.message).toContain('Mode simulation');
    });

    test('should sync online without backup when createBackup=false', async () => {
      mockGetHeartbeatData.mockReturnValue({
        status: 'online',
        machineId: 'test-machine-7'
      });

      const args: SyncEventArgs = {
        action: 'online',
        machineId: 'test-machine-7',
        createBackup: false
      };

      const result = await roosyncSyncEvent(args);

      expect(result.success).toBe(true);
      expect(result.backupCreated).toBe(false);
      expect(result.backupPath).toBeUndefined();
    });

    test('should sync online with syncFromBaseline=false', async () => {
      mockGetHeartbeatData.mockReturnValue({
        status: 'online',
        machineId: 'test-machine-8'
      });

      const args: SyncEventArgs = {
        action: 'online',
        machineId: 'test-machine-8',
        syncFromBaseline: false
      };

      const result = await roosyncSyncEvent(args);

      expect(result.success).toBe(true);
      // syncFromBaseline affecte la logique interne, pas le résultat visible
    });

    test('should sync online without offlineDuration when offlineSince is missing', async () => {
      mockGetHeartbeatData.mockReturnValue({
        status: 'online',
        machineId: 'test-machine-9'
        // pas de offlineSince
      });

      const args: SyncEventArgs = {
        action: 'online',
        machineId: 'test-machine-9'
      };

      const result = await roosyncSyncEvent(args);

      expect(result.success).toBe(true);
      expect(result.changes.offlineDuration).toBeUndefined();
    });

    test('should throw error when machine is not online', async () => {
      mockGetHeartbeatData.mockReturnValue({
        status: 'offline', // machine offline au lieu d'online
        machineId: 'test-machine-10'
      });

      const args: SyncEventArgs = {
        action: 'online',
        machineId: 'test-machine-10'
      };

      await expect(roosyncSyncEvent(args)).rejects.toThrow(HeartbeatServiceError);
      await expect(roosyncSyncEvent(args)).rejects.toThrow('n\'est pas online');
    });

    test('should throw error when machine data is not found', async () => {
      mockGetHeartbeatData.mockReturnValue(null);

      const args: SyncEventArgs = {
        action: 'online',
        machineId: 'unknown-machine-2'
      };

      await expect(roosyncSyncEvent(args)).rejects.toThrow(HeartbeatServiceError);
    });
  });

  // ============================================================
  // Tests pour gestion des erreurs
  // ============================================================

  describe('error handling', () => {
    test('should wrap non-HeartbeatServiceError errors', async () => {
      // Force une erreur interne
      mockGetHeartbeatData.mockImplementation(() => {
        throw new Error('Internal service error');
      });

      const args: SyncEventArgs = {
        action: 'online',
        machineId: 'error-machine'
      };

      await expect(roosyncSyncEvent(args)).rejects.toThrow(HeartbeatServiceError);
      await expect(roosyncSyncEvent(args)).rejects.toThrow('Erreur lors de la synchronisation online');
    });

    test('should preserve HeartbeatServiceError when thrown by service', async () => {
      const originalError = new HeartbeatServiceError('Service unavailable', 'SERVICE_ERROR');
      mockGetHeartbeatData.mockImplementation(() => {
        throw originalError;
      });

      const args: SyncEventArgs = {
        action: 'offline',
        machineId: 'error-machine-2'
      };

      await expect(roosyncSyncEvent(args)).rejects.toThrow(originalError);
    });
  });

  // ============================================================
  // Tests pour résultats et format de sortie
  // ============================================================

  describe('output format', () => {
    test('should return complete result structure for offline', async () => {
      mockGetHeartbeatData.mockReturnValue({
        status: 'offline',
        machineId: 'format-test-1'
      });

      const result = await roosyncSyncEvent({
        action: 'offline',
        machineId: 'format-test-1'
      });

      // Vérifier toutes les propriétés requises
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('action');
      expect(result).toHaveProperty('machineId');
      expect(result).toHaveProperty('syncedAt');
      expect(result).toHaveProperty('backupCreated');
      expect(result).toHaveProperty('changes');
      expect(result).toHaveProperty('message');

      // Vérifier le sous-objet changes
      expect(result.changes).toHaveProperty('filesSynced');
      expect(result.changes).toHaveProperty('conflictsResolved');
      expect(result.changes).toHaveProperty('decisionsCreated');

      // Vérifier le format ISO 8601 du timestamp
      expect(result.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test('should return complete result structure for online', async () => {
      mockGetHeartbeatData.mockReturnValue({
        status: 'online',
        machineId: 'format-test-2',
        offlineSince: new Date(Date.now() - 1000).toISOString()
      });

      const result = await roosyncSyncEvent({
        action: 'online',
        machineId: 'format-test-2'
      });

      // Propriétés communes
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('action');
      expect(result).toHaveProperty('machineId');

      // Propriété spécifique online
      expect(result.changes).toHaveProperty('offlineDuration');
      expect(typeof result.changes.offlineDuration).toBe('number');
    });
  });
});
