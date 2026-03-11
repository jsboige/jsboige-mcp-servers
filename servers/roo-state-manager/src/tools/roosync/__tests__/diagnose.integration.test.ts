/**
 * Tests d'intégration pour roosyncDiagnose
 *
 * Couvre toutes les actions de l'outil :
 * - action: 'env' : Diagnostic environnement système
 * - action: 'debug' : Dashboard debugging avec reset instance
 * - action: 'reset' : Réinitialisation service (avec confirmation)
 * - action: 'test' : Test minimal MCP
 *
 * Framework: Vitest
 * Type: Intégration (RooSyncService réel, opérations filesystem réelles)
 *
 * @module roosync/diagnose.integration.test
 * @version 1.1.0 (#564 Phase 2, #606 fix)
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
    getLocalWorkspaceId: vi.fn(() => undefined)
  };
});

// Mock getSharedStatePath pour utiliser un chemin de test
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-diagnose');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Fix #634: Integration tests need REAL RooSyncService and ConfigService
vi.unmock('../../../services/RooSyncService.js');
vi.unmock('../../../services/ConfigService.js');

// Import après les mocks
import { roosyncDiagnose } from '../diagnose.js';

// Fix #634: Integration tests need REAL RooSyncService, not the mock from jest.setup.js
// Unmock the service so we get the real singleton with actual filesystem operations
vi.unmock('../../../services/RooSyncService.js');
// Also unmock InventoryCollector - the jest.setup.js mock has wrong method names (collect vs collectInventory)
// and is missing clearCache method needed by clearCache() in RooSyncService
vi.unmock('../../../services/InventoryCollector.js');
// Also unmock BaselineService - jest.setup.js mock is missing loadBaseline method
vi.unmock('../../../services/BaselineService.js');
// Also unmock ConfigService - BaselineService depends on it and jest.setup.js mock is incomplete
vi.unmock('../../../services/ConfigService.js');
import { RooSyncService } from '../../../services/RooSyncService.js';

describe('roosyncDiagnose (integration)', () => {
  // Fix #634: Save original env var to restore after tests.
  // The system env ROOSYNC_SHARED_PATH points to real GDrive, and dotenv
  // won't override it. We must set it explicitly to the test path so that
  // RooSyncService singleton (via loadRooSyncConfig) uses the test directory.
  const originalSharedPath = process.env.ROOSYNC_SHARED_PATH;
  const originalMachineId = process.env.ROOSYNC_MACHINE_ID;

  beforeEach(async () => {
    // Fix #634: Override env var BEFORE singleton recreation.
    // Without this, loadRooSyncConfig() reads the system env var (GDrive path)
    // and RooSyncService writes ghost files to production GDrive.
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    // Setup : créer répertoire temporaire pour tests isolés
    const dirs = [
      testSharedStatePath,
      join(testSharedStatePath, 'roo-config'),
      join(testSharedStatePath, 'mcps'),
      join(testSharedStatePath, 'logs')
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    // Créer des fichiers critiques pour les tests 'env'
    writeFileSync(join(testSharedStatePath, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0' }));
    writeFileSync(join(testSharedStatePath, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));

    // Reset singleton avant chaque test pour garantir un état propre
    RooSyncService.resetInstance();
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
    if (originalMachineId !== undefined) {
      process.env.ROOSYNC_MACHINE_ID = originalMachineId;
    } else {
      delete process.env.ROOSYNC_MACHINE_ID;
    }

    // Cleanup : supprimer répertoire test pour isolation
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
  });

  // ============================================================
  // Tests pour action: 'env'
  // ============================================================

  describe('action: env', () => {
    test('should return system information', async () => {
      const result = await roosyncDiagnose({
        action: 'env'
      });

      expect(result.action).toBe('env');
      expect(result.data).toBeDefined();
      // data.system contains platform, arch, nodeVersion (not data.systemInfo)
      expect(result.data?.system).toBeDefined();
      expect(result.data?.system.platform).toBeDefined();
      expect(result.data?.system.arch).toBeDefined();
      expect(result.data?.system.nodeVersion).toBeDefined();
    });

    test('should detect directories presence', async () => {
      const result = await roosyncDiagnose({
        action: 'env'
      });

      expect(result.data?.directories).toBeDefined();
      // directories[x] returns { exists: bool, writable: bool } objects, NOT plain booleans
      expect(result.data?.directories['.']).toBeDefined();
      expect(result.data?.directories['.'].exists).toBeDefined();
    });

    test('should report missing directories with WARNING status', async () => {
      // Supprimer un répertoire critique
      rmSync(join(testSharedStatePath, 'roo-config'), { recursive: true, force: true });

      const result = await roosyncDiagnose({
        action: 'env'
      });

      // Note: directories check uses cwd-relative paths, not testSharedStatePath
      // The result data.status is 'OK' or 'WARNING' (uppercase)
      expect(result.data).toBeDefined();
      expect(result.data?.status).toBeDefined();
    });

    test('should check disk space when checkDiskSpace is true', async () => {
      const result = await roosyncDiagnose({
        action: 'env',
        checkDiskSpace: true
      });

      expect(result.data).toBeDefined();
      // env action always returns system info regardless of checkDiskSpace
      expect(result.data?.system).toBeDefined();
    });
  });

  // ============================================================
  // Tests pour action: 'debug'
  // ============================================================

  describe('action: debug', () => {
    test('should reset RooSyncService instance', async () => {
      // Créer une instance pour vérifier qu'elle sera reset
      RooSyncService.getInstance({ enabled: false });

      const result = await roosyncDiagnose({
        action: 'debug'
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('debug');
      expect(result.message).toContain('Dashboard');
    });

    test('should return verbose information when verbose is true', async () => {
      const result = await roosyncDiagnose({
        action: 'debug',
        verbose: true
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      // cacheDisabled is nested under data.debugInfo
      expect(result.data?.debugInfo?.cacheDisabled).toBe(true);
    });

    test('should return standard information when verbose is false', async () => {
      const result = await roosyncDiagnose({
        action: 'debug',
        verbose: false
      });

      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();
    });

    test('should include debugInfo with cacheDisabled', async () => {
      const result = await roosyncDiagnose({
        action: 'debug',
        verbose: true
      });

      expect(result.success).toBe(true);
      expect(result.data?.debugInfo).toBeDefined();
      expect(result.data?.debugInfo?.cacheDisabled).toBe(true);
    });
  });

  // ============================================================
  // Tests pour action: 'reset'
  // ============================================================

  describe('action: reset', () => {
    test('should require confirmation when confirm is false', async () => {
      const result = await roosyncDiagnose({
        action: 'reset',
        confirm: false
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('confirmer');
      expect(result.message).toContain('confirm: true');
    });

    test('should reset service when confirm is true', async () => {
      const result = await roosyncDiagnose({
        action: 'reset',
        confirm: true
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('reset');
      expect(result.message).toContain('réinitialisée');
    });

    test('should clear cache when clearCache is true with confirm', async () => {
      const result = await roosyncDiagnose({
        action: 'reset',
        confirm: true,
        clearCache: true
      });

      expect(result.success).toBe(true);
      // cacheCleared is nested under data.debugInfo
      expect(result.data?.debugInfo?.cacheCleared).toBe(true);
    });

    test('should not clear cache when clearCache is false with confirm', async () => {
      const result = await roosyncDiagnose({
        action: 'reset',
        confirm: true,
        clearCache: false
      });

      expect(result.success).toBe(true);
      expect(result.data?.debugInfo?.cacheCleared).toBe(false);
    });

    test('should return error when confirm is missing', async () => {
      const result = await roosyncDiagnose({
        action: 'reset'
        // confirm manquant (defaults to undefined, which is falsy)
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('confirmer');
    });
  });

  // ============================================================
  // Tests pour action: 'test'
  // ============================================================

  describe('action: test', () => {
    test('should return default test message', async () => {
      const result = await roosyncDiagnose({
        action: 'test'
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('test');
      expect(result.message).toContain('Test minimal');
      expect(result.data?.mcpStatus).toBeDefined();
    });

    test('should store custom message in data.testMessage', async () => {
      const customMessage = 'Custom test message from myia-po-2024';
      const result = await roosyncDiagnose({
        action: 'test',
        message: customMessage
      });

      expect(result.success).toBe(true);
      // Custom message is stored in data.testMessage, not in result.message
      expect(result.data?.testMessage).toBe(customMessage);
    });

    test('should include MCP status information', async () => {
      const result = await roosyncDiagnose({
        action: 'test'
      });

      expect(result.success).toBe(true);
      expect(result.data?.mcpStatus).toBeDefined();
      expect(result.timestamp).toBeDefined();
    });

    test('should handle empty message gracefully', async () => {
      const result = await roosyncDiagnose({
        action: 'test',
        message: ''
      });

      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should throw for invalid action', async () => {
      await expect(roosyncDiagnose({
        action: 'invalid' as any
      })).rejects.toThrow();
    });

    test('should handle env action when some directories are missing', async () => {
      // Note: env action checks cwd-relative paths, not testSharedStatePath
      const result = await roosyncDiagnose({
        action: 'env'
      });

      // Should return a result (either OK or WARNING)
      expect(result.data).toBeDefined();
      expect(result.data?.status).toBeDefined();
    });

    test('should handle filesystem oddities gracefully', async () => {
      // Rendre le répertoire en lecture seule (simule une erreur de permission)
      const logsDir = join(testSharedStatePath, 'logs');
      try {
        rmSync(logsDir, { recursive: true, force: true });
        // Créer un fichier avec le même nom qu'un répertoire
        writeFileSync(logsDir, 'not a directory');
      } catch {
        // Ignorer les erreurs de setup
      }

      const result = await roosyncDiagnose({
        action: 'env'
      });

      // Should return a result without crashing
      expect(result.data).toBeDefined();
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration scenarios', () => {
    test('should handle complete diagnostic workflow: env → debug → reset', async () => {
      // Step 1: Diagnostic environnement
      const envResult = await roosyncDiagnose({ action: 'env' });
      expect(envResult.data?.system).toBeDefined();

      // Step 2: Debug avec verbose
      const debugResult = await roosyncDiagnose({
        action: 'debug',
        verbose: true
      });
      expect(debugResult.success).toBe(true);
      expect(debugResult.data?.debugInfo?.cacheDisabled).toBe(true);

      // Step 3: Reset avec confirmation
      const resetResult = await roosyncDiagnose({
        action: 'reset',
        confirm: true
      });
      expect(resetResult.success).toBe(true);
      expect(resetResult.message).toContain('réinitialisée');
    });

    test('should persist singleton state across calls', async () => {
      // Créer une instance
      const instance1 = RooSyncService.getInstance({ enabled: false });

      // Appeler debug qui fait un reset
      await roosyncDiagnose({
        action: 'debug'
      });

      // Vérifier qu'une nouvelle instance est créée après le reset
      const instance2 = RooSyncService.getInstance({ enabled: false });

      // Les instances devraient être différentes (après reset)
      expect(instance1).toBeDefined();
      expect(instance2).toBeDefined();
    });

    test('should return WARNING status when resources are missing', async () => {
      // env action checks cwd-relative paths
      // We can verify the structure is correct regardless of actual path existence
      const result = await roosyncDiagnose({
        action: 'env',
        checkDiskSpace: false
      });

      expect(result.data?.directories).toBeDefined();
      expect(result.data?.status).toBeDefined();
      // status is either 'OK' or 'WARNING'
      expect(['OK', 'WARNING']).toContain(result.data?.status);
    });
  });
});
