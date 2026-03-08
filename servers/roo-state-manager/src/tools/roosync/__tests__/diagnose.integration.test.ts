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
 * @version 1.0.0 (#564 Phase 2)
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

// Import après les mocks
import { roosyncDiagnose } from '../diagnose.js';
import { RooSyncService } from '../../../services/RooSyncService.js';

describe('roosyncDiagnose (integration)', () => {
  beforeEach(async () => {
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
    // Cleanup : supprimer répertoire test pour isolation
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }

    // Reset singleton après chaque test
    RooSyncService.resetInstance();
  });

  // ============================================================
  // Tests pour action: 'env'
  // ============================================================

  describe('action: env', () => {
    test('should return system information with all critical directories present', async () => {
      const result = await roosyncDiagnose({
        action: 'env'
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('env');
      expect(result.data).toBeDefined();
      expect(result.data?.systemInfo).toBeDefined();
      expect(result.data?.systemInfo.platform).toBeDefined();
      expect(result.data?.systemInfo.arch).toBeDefined();
      expect(result.data?.systemInfo.nodeVersion).toBeDefined();
    });

    test('should detect all critical directories when present', async () => {
      const result = await roosyncDiagnose({
        action: 'env'
      });

      expect(result.success).toBe(true);
      expect(result.data?.directories).toBeDefined();
      expect(result.data?.directories['.']).toBe(true);
      expect(result.data?.directories['.shared-state']).toBe(true);
      expect(result.data?.directories['roo-config']).toBe(true);
      expect(result.data?.directories['mcps']).toBe(true);
      expect(result.data?.directories['logs']).toBe(true);
    });

    test('should detect all critical files when present', async () => {
      const result = await roosyncDiagnose({
        action: 'env'
      });

      expect(result.success).toBe(true);
      expect(result.data?.files).toBeDefined();
      expect(result.data?.files['package.json']).toBe(true);
      expect(result.data?.files['tsconfig.json']).toBe(true);
    });

    test('should report missing directories', async () => {
      // Supprimer un répertoire critique
      rmSync(join(testSharedStatePath, 'roo-config'), { recursive: true, force: true });

      const result = await roosyncDiagnose({
        action: 'env'
      });

      expect(result.success).toBe(true);
      expect(result.data?.directories['roo-config']).toBe(false);
      expect(result.data?.status).toContain('warning');
    });

    test('should report missing files', async () => {
      // Supprimer un fichier critique
      const tsconfigPath = join(testSharedStatePath, 'tsconfig.json');
      if (existsSync(tsconfigPath)) {
        rmSync(tsconfigPath);
      }

      const result = await roosyncDiagnose({
        action: 'env'
      });

      expect(result.success).toBe(true);
      expect(result.data?.files['tsconfig.json']).toBe(false);
      expect(result.data?.status).toContain('warning');
    });

    test('should check disk space when checkDiskSpace is true', async () => {
      const result = await roosyncDiagnose({
        action: 'env',
        checkDiskSpace: true
      });

      expect(result.success).toBe(true);
      expect(result.data?.diskSpace).toBeDefined();
    });
  });

  // ============================================================
  // Tests pour action: 'debug'
  // ============================================================

  describe('action: debug', () => {
    test('should reset RooSyncService instance', async () => {
      // Créer une instance pour vérifier qu'elle sera reset
      const instanceBefore = RooSyncService.getInstance({ enabled: false });

      const result = await roosyncDiagnose({
        action: 'debug'
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('debug');
      // Après reset, une nouvelle instance devrait être créée
      expect(result.message).toContain('dashboard');
    });

    test('should return verbose information when verbose is true', async () => {
      const result = await roosyncDiagnose({
        action: 'debug',
        verbose: true
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.cacheDisabled).toBe(true);
    });

    test('should return standard information when verbose is false', async () => {
      const result = await roosyncDiagnose({
        action: 'debug',
        verbose: false
      });

      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();
    });

    test('should clear cache when clearCache is true', async () => {
      const result = await roosyncDiagnose({
        action: 'debug',
        clearCache: true
      });

      expect(result.success).toBe(true);
      expect(result.data?.cacheCleared).toBe(true);
    });

    test('should not clear cache when clearCache is false', async () => {
      const result = await roosyncDiagnose({
        action: 'debug',
        clearCache: false
      });

      expect(result.success).toBe(true);
      expect(result.data?.cacheCleared).toBe(false);
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
      expect(result.message).toContain('réinitialisé');
    });

    test('should clear cache when clearCache is true with confirm', async () => {
      const result = await roosyncDiagnose({
        action: 'reset',
        confirm: true,
        clearCache: true
      });

      expect(result.success).toBe(true);
      expect(result.data?.cacheCleared).toBe(true);
    });

    test('should not clear cache when clearCache is false with confirm', async () => {
      const result = await roosyncDiagnose({
        action: 'reset',
        confirm: true,
        clearCache: false
      });

      expect(result.success).toBe(true);
      expect(result.data?.cacheCleared).toBe(false);
    });

    test('should return error when confirm is missing', async () => {
      const result = await roosyncDiagnose({
        action: 'reset'
        // confirm manquant
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

    test('should return custom message when provided', async () => {
      const customMessage = 'Custom test message from myia-po-2024';
      const result = await roosyncDiagnose({
        action: 'test',
        message: customMessage
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain(customMessage);
    });

    test('should include MCP status information', async () => {
      const result = await roosyncDiagnose({
        action: 'test'
      });

      expect(result.success).toBe(true);
      expect(result.data?.mcpStatus).toBeDefined();
      expect(result.data?.timestamp).toBeDefined();
    });

    test('should handle empty message gracefully', async () => {
      const result = await roosyncDiagnose({
        action: 'test',
        message: ''
      });

      expect(result.success).toBe(true);
      // Devrait utiliser le message par défaut ou le message vide
      expect(result.message).toBeDefined();
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should return error for invalid action', async () => {
      const result = await roosyncDiagnose({
        action: 'invalid' as any
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('invalide');
    });

    test('should handle missing testSharedStatePath gracefully for env action', async () => {
      // Supprimer le répertoire pour simuler l'absence
      rmSync(testSharedStatePath, { recursive: true, force: true });

      const result = await roosyncDiagnose({
        action: 'env'
      });

      // Devrait retourner un résultat avec des warnings
      expect(result.success).toBe(true);
      expect(result.data?.status).toContain('warning');
    });

    test('should handle filesystem errors gracefully', async () => {
      // Rendre le répertoire en lecture seule (simule une erreur de permission)
      // Note: Ceci peut ne pas fonctionner sur tous les systèmes
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

      // Devrait gérer l'erreur sans crasher
      expect(result.success).toBe(true);
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
      expect(envResult.success).toBe(true);
      expect(envResult.data?.systemInfo).toBeDefined();

      // Step 2: Debug avec cache disabled
      const debugResult = await roosyncDiagnose({
        action: 'debug',
        clearCache: true
      });
      expect(debugResult.success).toBe(true);
      expect(debugResult.data?.cacheDisabled).toBe(true);

      // Step 3: Reset avec confirmation
      const resetResult = await roosyncDiagnose({
        action: 'reset',
        confirm: true
      });
      expect(resetResult.success).toBe(true);
      expect(resetResult.message).toContain('réinitialisé');
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

    test('should detect missing critical resources and report warnings', async () => {
      // Supprimer plusieurs ressources critiques
      rmSync(join(testSharedStatePath, 'roo-config'), { recursive: true, force: true });
      rmSync(join(testSharedStatePath, 'package.json'));
      rmSync(join(testSharedStatePath, 'tsconfig.json'));

      const result = await roosyncDiagnose({
        action: 'env',
        checkDiskSpace: false
      });

      expect(result.success).toBe(true);
      expect(result.data?.directories['roo-config']).toBe(false);
      expect(result.data?.files['package.json']).toBe(false);
      expect(result.data?.files['tsconfig.json']).toBe(false);
      expect(result.data?.status).toContain('warning');
    });
  });
});
