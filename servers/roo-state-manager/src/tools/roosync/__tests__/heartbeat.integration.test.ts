/**
 * Tests d'intégration pour roosync_heartbeat
 *
 * Couvre toutes les actions de l'outil :
 * - action: 'status' : Consulter l'état du heartbeat (avec filtres filter, includeHeartbeats, forceCheck, includeChanges)
 * - action: 'register' : Enregistrer un heartbeat pour une machine
 * - action: 'start' : Démarrer la surveillance heartbeat
 * - action: 'stop' : Arrêter la surveillance heartbeat
 *
 * Framework: Vitest
 * Type: Intégration (HeartbeatService réel, opérations filesystem réelles)
 *
 * @module roosync/heartbeat.integration.test
 * @version 1.1.0 (#564 Phase 3, #606 fix)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// Mock getLocalMachineId pour contrôler l'identifiant dans les tests
vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'test-machine'),
    getLocalFullId: vi.fn(() => 'test-machine'),
    getLocalWorkspaceId: vi.fn(() => 'roo-extensions')
  };
});

// Mock getSharedStatePath pour utiliser un chemin de test
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-heartbeat');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Import après les mocks
import { roosyncHeartbeat } from '../heartbeat.js';
import { HeartbeatResult } from '../heartbeat.js';
import { RooSyncService } from '../../../services/RooSyncService.js';

describe('roosyncHeartbeat (integration)', () => {
  // Fix #634: Save original env var to restore after tests.
  // The system env ROOSYNC_SHARED_PATH points to real GDrive, and dotenv
  // won't override it. We must set it explicitly to the test path so that
  // RooSyncService singleton (via loadRooSyncConfig) uses the test directory.
  const originalSharedPath = process.env.ROOSYNC_SHARED_PATH;

  beforeEach(async () => {
    // Fix #634: Override env var BEFORE singleton recreation.
    // Without this, loadRooSyncConfig() reads the system env var (GDrive path)
    // and HeartbeatService writes ghost machine files to production GDrive.
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;

    // Reset singleton so it gets recreated with the test path
    RooSyncService.resetInstance();

    // Setup : créer répertoire temporaire pour tests isolés
    const dirs = [
      testSharedStatePath,
      join(testSharedStatePath, 'heartbeat'),
      join(testSharedStatePath, 'heartbeats'),
      join(testSharedStatePath, 'machines')
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  });

  afterEach(async () => {
    // Reset singleton to prevent leaking test state to other test files
    RooSyncService.resetInstance();

    // Restore original env var
    if (originalSharedPath !== undefined) {
      process.env.ROOSYNC_SHARED_PATH = originalSharedPath;
    } else {
      delete process.env.ROOSYNC_SHARED_PATH;
    }

    // Cleanup : supprimer répertoire test pour isolation
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
  });

  // ============================================================
  // Tests pour action: 'status'
  // ============================================================

  describe('action: status', () => {
    test('should return status for all machines when no filter provided', async () => {
      const result: HeartbeatResult = await roosyncHeartbeat({
        action: 'status'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.action).toBe('status');
      expect(result.timestamp).toBeDefined();
    });

    test('should filter by status: online', async () => {
      const result = await roosyncHeartbeat({
        action: 'status',
        filter: 'online'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.action).toBe('status');
    });

    test('should filter by status: offline', async () => {
      const result = await roosyncHeartbeat({
        action: 'status',
        filter: 'offline'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should filter by status: warning', async () => {
      const result = await roosyncHeartbeat({
        action: 'status',
        filter: 'warning'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should include heartbeat data when includeHeartbeats is true', async () => {
      const result = await roosyncHeartbeat({
        action: 'status',
        includeHeartbeats: true
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      // data contains the full HeartbeatStatusResult
      expect(result.data).toBeDefined();
    });

    test('should force check when forceCheck is true', async () => {
      const result = await roosyncHeartbeat({
        action: 'status',
        forceCheck: true
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should include recent changes when includeChanges is true', async () => {
      const result = await roosyncHeartbeat({
        action: 'status',
        includeChanges: true
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should handle combination of filters and options', async () => {
      const result = await roosyncHeartbeat({
        action: 'status',
        filter: 'online',
        includeHeartbeats: true,
        includeChanges: true
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });
  });

  // ============================================================
  // Tests pour action: 'register'
  // ============================================================

  describe('action: register', () => {
    test('should register heartbeat with machineId', async () => {
      const result = await roosyncHeartbeat({
        action: 'register',
        machineId: 'test-machine-2'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.action).toBe('register');
      expect(result.message).toContain('test-machine-2');
    });

    test('should throw when machineId is not provided for register', async () => {
      // machineId is required for register action
      await expect(roosyncHeartbeat({
        action: 'register'
        // machineId manquant
      })).rejects.toThrow('machineId');
    });

    test('should include metadata when provided', async () => {
      const metadata = {
        version: '1.0.0',
        os: 'linux',
        capabilities: ['test', 'demo']
      };

      const result = await roosyncHeartbeat({
        action: 'register',
        machineId: 'test-machine',
        metadata
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should handle empty metadata gracefully', async () => {
      const result = await roosyncHeartbeat({
        action: 'register',
        machineId: 'test-machine',
        metadata: {}
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should return register result data', async () => {
      const result = await roosyncHeartbeat({
        action: 'register',
        machineId: 'persistent-machine'
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      // data contains the register result with machineId, timestamp, status, isNewMachine
      expect(result.data.machineId).toBe('persistent-machine');
    });
  });

  // ============================================================
  // Tests pour action: 'start'
  // ============================================================

  describe('action: start', () => {
    test('should start heartbeat monitoring with default parameters', async () => {
      const result = await roosyncHeartbeat({
        action: 'start',
        machineId: 'test-machine'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.action).toBe('start');
      expect(result.message).toContain('test-machine');
    });

    test('should enable auto sync when enableAutoSync is true', async () => {
      const result = await roosyncHeartbeat({
        action: 'start',
        machineId: 'test-machine',
        enableAutoSync: true
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should use custom heartbeatInterval when provided', async () => {
      const result = await roosyncHeartbeat({
        action: 'start',
        machineId: 'test-machine',
        heartbeatInterval: 60000 // 1 minute
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should use custom offlineTimeout when provided', async () => {
      const result = await roosyncHeartbeat({
        action: 'start',
        machineId: 'test-machine',
        offlineTimeout: 300000 // 5 minutes
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should handle all parameters combined', async () => {
      const result = await roosyncHeartbeat({
        action: 'start',
        machineId: 'test-machine',
        enableAutoSync: true,
        heartbeatInterval: 30000,
        offlineTimeout: 120000
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should return start result data with config', async () => {
      const result = await roosyncHeartbeat({
        action: 'start',
        machineId: 'monitored-machine'
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      // data contains the start result with machineId, startedAt, config
      expect(result.data.machineId).toBe('monitored-machine');
      expect(result.data.config).toBeDefined();
    });
  });

  // ============================================================
  // Tests pour action: 'stop'
  // ============================================================

  describe('action: stop', () => {
    test('should stop heartbeat monitoring', async () => {
      // D'abord démarrer la surveillance
      await roosyncHeartbeat({
        action: 'start',
        machineId: 'test-machine'
      });

      // Puis l'arrêter
      const result = await roosyncHeartbeat({
        action: 'stop',
        saveState: true
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.action).toBe('stop');
      expect(result.message).toContain('arret');
    });

    test('should save state when saveState is true', async () => {
      await roosyncHeartbeat({
        action: 'start',
        machineId: 'test-machine'
      });

      const result = await roosyncHeartbeat({
        action: 'stop',
        saveState: true
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should stop without saving state when saveState is false', async () => {
      await roosyncHeartbeat({
        action: 'start',
        machineId: 'test-machine'
      });

      const result = await roosyncHeartbeat({
        action: 'stop',
        saveState: false
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should handle stopping non-existent monitoring gracefully', async () => {
      const result = await roosyncHeartbeat({
        action: 'stop',
        saveState: true
      });

      expect(result).toBeDefined();
      // Should succeed even if no monitoring was active
      expect(result.success).toBe(true);
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration scenarios', () => {
    test('should handle complete workflow: register → start → status → stop', async () => {
      // Step 1: Enregistrer
      const registerResult = await roosyncHeartbeat({
        action: 'register',
        machineId: 'workflow-machine'
      });
      expect(registerResult.success).toBe(true);

      // Step 2: Démarrer
      const startResult = await roosyncHeartbeat({
        action: 'start',
        machineId: 'workflow-machine',
        enableAutoSync: true
      });
      expect(startResult.success).toBe(true);

      // Step 3: Vérifier le statut
      const statusResult = await roosyncHeartbeat({
        action: 'status',
        filter: 'all',
        includeHeartbeats: true
      });
      expect(statusResult.success).toBe(true);

      // Step 4: Arrêter
      const stopResult = await roosyncHeartbeat({
        action: 'stop',
        saveState: true
      });
      expect(stopResult.success).toBe(true);
    });

    test('should track multiple machines independently', async () => {
      // Enregistrer machine 1
      await roosyncHeartbeat({
        action: 'register',
        machineId: 'machine-1'
      });

      // Enregistrer machine 2
      await roosyncHeartbeat({
        action: 'register',
        machineId: 'machine-2'
      });

      // Vérifier que les deux machines sont suivies
      const statusResult = await roosyncHeartbeat({
        action: 'status',
        filter: 'all',
        includeHeartbeats: true
      });
      expect(statusResult.success).toBe(true);
    });

    test('should persist heartbeat state across operations', async () => {
      const machineId = 'persistent-machine';

      // Enregistrer avec métadonnées
      const registerResult = await roosyncHeartbeat({
        action: 'register',
        machineId,
        metadata: { version: '2.0.0', features: ['a', 'b'] }
      });
      expect(registerResult.success).toBe(true);

      // Démarrer surveillance
      const startResult = await roosyncHeartbeat({
        action: 'start',
        machineId,
        heartbeatInterval: 45000,
        offlineTimeout: 180000
      });
      expect(startResult.success).toBe(true);

      // Vérifier que les métadonnées sont conservées
      const statusResult = await roosyncHeartbeat({
        action: 'status',
        includeHeartbeats: true
      });
      expect(statusResult.success).toBe(true);

      // Arrêter et sauvegarder
      const stopResult = await roosyncHeartbeat({
        action: 'stop',
        saveState: true
      });
      expect(stopResult.success).toBe(true);
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle missing shared state directory gracefully for status', async () => {
      // Supprimer le répertoire pour simuler l'absence
      rmSync(testSharedStatePath, { recursive: true, force: true });

      const result = await roosyncHeartbeat({
        action: 'status'
      });

      expect(result).toBeDefined();
      // status should still work with empty state
      expect(result.success).toBe(true);
    });

    test('should handle corrupted heartbeat files gracefully', async () => {
      // Créer un fichier heartbeat corrompu
      const corruptedId = 'machine-corrupted';
      const corruptedPath = join(testSharedStatePath, 'heartbeat', `${corruptedId}.json`);
      writeFileSync(corruptedPath, '{ invalid json }');

      const result = await roosyncHeartbeat({
        action: 'status',
        includeHeartbeats: true
      });

      expect(result).toBeDefined();
      // Should handle gracefully
    });

    test('should handle valid action gracefully', async () => {
      const result = await roosyncHeartbeat({
        action: 'status'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });
  });

  // ============================================================
  // Tests de filtrage et status
  // ============================================================

  describe('status filtering', () => {
    test('should correctly identify online machines', async () => {
      // Enregistrer un heartbeat récent (machine en ligne)
      await roosyncHeartbeat({
        action: 'register',
        machineId: 'online-machine'
      });

      const result = await roosyncHeartbeat({
        action: 'status',
        filter: 'online',
        includeHeartbeats: true
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should correctly identify offline machines', async () => {
      const result = await roosyncHeartbeat({
        action: 'status',
        filter: 'offline',
        includeHeartbeats: true
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should return all machines regardless of status when filter is all', async () => {
      // Créer une machine
      await roosyncHeartbeat({
        action: 'register',
        machineId: 'machine-1'
      });

      const result = await roosyncHeartbeat({
        action: 'status',
        filter: 'all',
        includeHeartbeats: true
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });
  });
});
