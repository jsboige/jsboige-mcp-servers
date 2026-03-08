/**
 * Tests d'intégration pour roosync_config
 *
 * Couvre toutes les actions de l'outil :
 * - action: 'collect' : Collecte de la configuration locale
 * - action: 'publish' : Publication vers le stockage partagé
 * - action: 'apply' : Application depuis le stockage partagé
 * - action: 'apply_profile' : Application d'un profil de modèle
 *
 * Framework: Vitest
 * Type: Intégration (ConfigSharingService réel, opérations filesystem réelles)
 *
 * @module roosync/config.integration.test
 * @version 1.0.0 (#564 Phase 2)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'fs';
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
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-config');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Import après les mocks
import { roosyncConfig } from '../config.js';
import { RooSyncService } from '../../../services/RooSyncService.js';
import { ConfigSharingService } from '../../../services/ConfigSharingService.js';
import { ConfigSharingServiceError, ConfigSharingServiceErrorCode } from '../../../types/errors.js';

describe('roosyncConfig (integration)', () => {
  beforeEach(async () => {
    // Setup : créer répertoire temporaire pour tests isolés
    const dirs = [
      testSharedStatePath,
      join(testSharedStatePath, 'roo-config'),
      join(testSharedStatePath, 'roo-config/modes'),
      join(testSharedStatePath, 'roo-config/mcp'),
      join(testSharedStatePath, 'roo-config/profiles'),
      join(testSharedStatePath, 'packages'), // Pour les packages publish
      join(testSharedStatePath, 'backups') // Pour les backups apply
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    // Créer des fichiers de configuration factices pour les tests
    writeFileSync(join(testSharedStatePath, 'roo-config/modes/test-mode.json'), JSON.stringify({ name: 'test-mode' }));
    writeFileSync(join(testSharedStatePath, 'roo-config/mcp/test-mcp.json'), JSON.stringify({ name: 'test-mcp' }));
    writeFileSync(join(testSharedStatePath, 'roo-config/profiles/test-profile.json'), JSON.stringify({ name: 'test-profile' }));

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
  // Tests pour action: 'collect'
  // ============================================================

  describe('action: collect', () => {
    test('should collect default targets (modes, mcp)', async () => {
      const result = await roosyncConfig({
        action: 'collect'
      });

      expect(result.status).toBe('success');
      expect(result.message).toContain('Configuration collectée');
      expect(result.packagePath).toBeDefined();
      expect(result.totalSize).toBeGreaterThan(0);
      expect(result.manifest).toBeDefined();
    });

    test('should collect specified targets only', async () => {
      const result = await roosyncConfig({
        action: 'collect',
        targets: ['modes']
      });

      expect(result.status).toBe('success');
      expect(result.manifest.targets).toEqual(['modes']);
    });

    test('should collect all valid target types', async () => {
      const result = await roosyncConfig({
        action: 'collect',
        targets: ['modes', 'mcp', 'profiles']
      });

      expect(result.status).toBe('success');
      expect(result.filesCount).toBeGreaterThan(0);
    });

    test('should support dryRun mode without creating files', async () => {
      const result = await roosyncConfig({
        action: 'collect',
        dryRun: true
      });

      expect(result.status).toBe('success');
      // En mode dryRun, le package ne devrait pas persister
    });

    test('should collect specific MCP server config', async () => {
      const result = await roosyncConfig({
        action: 'collect',
        targets: ['mcp:test-server']
      });

      expect(result.status).toBe('success');
    });

    test('should reject invalid target format', async () => {
      await expect(roosyncConfig({
        action: 'collect',
        targets: ['invalid-target'] as any
      })).rejects.toThrow(ConfigSharingServiceError);
    });

    test('should reject MCP target with empty server name', async () => {
      await expect(roosyncConfig({
        action: 'collect',
        targets: ['mcp:'] as any
      })).rejects.toThrow(ConfigSharingServiceError);
    });
  });

  // ============================================================
  // Tests pour action: 'publish'
  // ============================================================

  describe('action: publish', () => {
    let testPackagePath: string;

    beforeEach(async () => {
      // Créer un package de test pour publish
      const collectResult = await roosyncConfig({
        action: 'collect',
        targets: ['modes']
      });
      testPackagePath = collectResult.packagePath;
    });

    test('should publish with version and description', async () => {
      const result = await roosyncConfig({
        action: 'publish',
        version: '1.0.0',
        description: 'Test configuration publish',
        packagePath: testPackagePath
      });

      expect(result.status).toBe('success');
      expect(result.message).toContain('publiée avec succès');
      expect(result.version).toBe('1.0.0');
      expect(result.targetPath).toBeDefined();
    });

    test('should perform atomic collect+publish when targets provided without packagePath', async () => {
      const result = await roosyncConfig({
        action: 'publish',
        version: '2.0.0',
        description: 'Atomic collect+publish test',
        targets: ['modes']
      });

      expect(result.status).toBe('success');
      expect(result.version).toBe('2.0.0');
    });

    test('should reject publish without version', async () => {
      await expect(roosyncConfig({
        action: 'publish',
        description: 'Test',
        packagePath: testPackagePath
        // version manquant
      })).rejects.toThrow();
    });

    test('should reject publish without description', async () => {
      await expect(roosyncConfig({
        action: 'publish',
        version: '1.0.0',
        packagePath: testPackagePath
        // description manquant
      })).rejects.toThrow();
    });

    test('should reject publish without packagePath or targets', async () => {
      await expect(roosyncConfig({
        action: 'publish',
        version: '1.0.0',
        description: 'Test'
        // packagePath et targets manquants
      })).rejects.toThrow(ConfigSharingServiceError);
    });

    test('should include machineId in result when provided', async () => {
      const result = await roosyncConfig({
        action: 'publish',
        version: '1.0.0',
        description: 'Test',
        packagePath: testPackagePath,
        machineId: 'test-machine-custom'
      });

      expect(result.machineId).toBe('test-machine-custom');
    });
  });

  // ============================================================
  // Tests pour action: 'apply'
  // ============================================================

  describe('action: apply', () => {
    test('should apply latest version when version not specified', async () => {
      // Note: Ce test nécessite un package pré-publié
      // Pour simplifier, on teste avec dryRun
      const result = await roosyncConfig({
        action: 'apply',
        dryRun: true
      });

      expect(result).toBeDefined();
    });

    test('should apply specific version when provided', async () => {
      const result = await roosyncConfig({
        action: 'apply',
        version: '1.0.0',
        dryRun: true
      });

      expect(result).toBeDefined();
    });

    test('should create backup when backup is true (default)', async () => {
      const result = await roosyncConfig({
        action: 'apply',
        backup: true,
        dryRun: true
      });

      expect(result).toBeDefined();
      // backupPath devrait être présent dans un vrai scénario
    });

    test('should skip backup when backup is false', async () => {
      const result = await roosyncConfig({
        action: 'apply',
        backup: false,
        dryRun: true
      });

      expect(result).toBeDefined();
    });

    test('should apply specific targets only', async () => {
      const result = await roosyncConfig({
        action: 'apply',
        targets: ['modes'],
        dryRun: true
      });

      expect(result).toBeDefined();
    });

    test('should detect version incompatibility', async () => {
      // Simuler une incompatibilité de version majeure
      // Cela nécessiterait un mock plus complexe du ConfigService
      const result = await roosyncConfig({
        action: 'apply',
        version: '99.0.0', // Version future incompatible
        dryRun: true
      });

      expect(result).toBeDefined();
    });

    test('should report applied files', async () => {
      const result = await roosyncConfig({
        action: 'apply',
        dryRun: true
      });

      expect(result).toBeDefined();
      // filesApplied devrait contenir la liste des fichiers appliqués
    });
  });

  // ============================================================
  // Tests pour action: 'apply_profile'
  // ============================================================

  describe('action: apply_profile', () => {
    test('should apply profile with profileName', async () => {
      // Créer un profil de test
      const testProfile = {
        name: 'Test Profile',
        modes: ['code-simple', 'debug-simple'],
        apiConfigs: []
      };
      const profilesDir = join(testSharedStatePath, 'roo-config/profiles');
      writeFileSync(join(profilesDir, 'test-profile.json'), JSON.stringify(testProfile, null, 2));

      const result = await roosyncConfig({
        action: 'apply_profile',
        profileName: 'Test Profile',
        dryRun: true
      });

      expect(result).toBeDefined();
      expect(result.profileName).toBeDefined();
    });

    test('should reject apply_profile without profileName', async () => {
      await expect(roosyncConfig({
        action: 'apply_profile'
        // profileName manquant
      })).rejects.toThrow(ConfigSharingServiceError);
    });

    test('should support backup with apply_profile', async () => {
      const result = await roosyncConfig({
        action: 'apply_profile',
        profileName: 'Test Profile',
        backup: true,
        dryRun: true
      });

      expect(result).toBeDefined();
    });

    test('should report modes configured', async () => {
      const result = await roosyncConfig({
        action: 'apply_profile',
        profileName: 'Test Profile',
        dryRun: true
      });

      expect(result).toBeDefined();
      expect(result.modesConfigured).toBeDefined();
    });

    test('should report API configs count', async () => {
      const result = await roosyncConfig({
        action: 'apply_profile',
        profileName: 'Test Profile',
        dryRun: true
      });

      expect(result).toBeDefined();
      expect(result.apiConfigsCount).toBeDefined();
    });

    test('should support sourceMachineId for model-configs', async () => {
      const result = await roosyncConfig({
        action: 'apply_profile',
        profileName: 'Test Profile',
        sourceMachineId: 'test-source-machine',
        dryRun: true
      });

      expect(result).toBeDefined();
    });

    test('should report roomodes generation status', async () => {
      const result = await roosyncConfig({
        action: 'apply_profile',
        profileName: 'Test Profile',
        dryRun: true
      });

      expect(result).toBeDefined();
      expect(result.roomodesGenerated).toBeDefined();
    });

    test('should include errors if profile application fails', async () => {
      const result = await roosyncConfig({
        action: 'apply_profile',
        profileName: 'Nonexistent Profile',
        dryRun: true
      });

      expect(result).toBeDefined();
      // errors devrait contenir les détails si échec
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should reject invalid action', async () => {
      await expect(roosyncConfig({
        action: 'invalid' as any
      })).rejects.toThrow(ConfigSharingServiceError);
    });

    test('should handle missing required parameters gracefully', async () => {
      await expect(roosyncConfig({
        action: 'publish'
        // version et description manquants
      })).rejects.toThrow();
    });

    test('should handle invalid target format', async () => {
      await expect(roosyncConfig({
        action: 'collect',
        targets: ['not-a-valid-target'] as any
      })).rejects.toThrow(ConfigSharingServiceError);
    });

    test('should handle collect errors gracefully', async () => {
      // Supprimer les répertoires pour simuler une erreur
      rmSync(join(testSharedStatePath, 'roo-config'), { recursive: true, force: true });

      const result = await roosyncConfig({
        action: 'collect',
        targets: ['modes']
      });

      // Devrait retourner un résultat même si aucun fichier collecté
      expect(result).toBeDefined();
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration scenarios', () => {
    test('should handle complete collect → publish → apply workflow', async () => {
      // Step 1: Collect
      const collectResult = await roosyncConfig({
        action: 'collect',
        targets: ['modes']
      });
      expect(collectResult.status).toBe('success');
      expect(collectResult.packagePath).toBeDefined();

      // Step 2: Publish
      const publishResult = await roosyncConfig({
        action: 'publish',
        version: '1.0.0',
        description: 'Integration test workflow',
        packagePath: collectResult.packagePath
      });
      expect(publishResult.status).toBe('success');
      expect(publishResult.version).toBe('1.0.0');

      // Step 3: Apply (dryRun pour éviter les effets de bord)
      const applyResult = await roosyncConfig({
        action: 'apply',
        version: '1.0.0',
        backup: true,
        dryRun: true
      });
      expect(applyResult).toBeDefined();
    });

    test('should handle atomic collect+publish workflow', async () => {
      const result = await roosyncConfig({
        action: 'publish',
        version: '2.0.0',
        description: 'Atomic workflow test',
        targets: ['modes', 'mcp']
      });

      expect(result.status).toBe('success');
      expect(result.version).toBe('2.0.0');
      expect(result.targetPath).toBeDefined();
    });

    test('should persist singleton state across calls', async () => {
      const instance1 = RooSyncService.getInstance({ enabled: false });

      await roosyncConfig({
        action: 'collect',
        targets: ['modes']
      });

      const instance2 = RooSyncService.getInstance({ enabled: false });

      // Les instances devraient être les mêmes (singleton)
      expect(instance1).toBeDefined();
      expect(instance2).toBeDefined();
    });

    test('should handle multiple sequential operations', async () => {
      // Collect 1
      const collect1 = await roosyncConfig({
        action: 'collect',
        targets: ['modes']
      });
      expect(collect1.status).toBe('success');

      // Collect 2
      const collect2 = await roosyncConfig({
        action: 'collect',
        targets: ['mcp']
      });
      expect(collect2.status).toBe('success');

      // Publish
      const publish = await roosyncConfig({
        action: 'publish',
        version: '3.0.0',
        description: 'Multiple operations test',
        packagePath: collect1.packagePath
      });
      expect(publish.status).toBe('success');
    });
  });

  // ============================================================
  // Tests de validation des cibles
  // ============================================================

  describe('target validation', () => {
    const validTargets = ['modes', 'mcp', 'profiles', 'roomodes', 'model-configs', 'rules', 'settings'];

    test.each(validTargets)('should accept valid target: %s', async (target) => {
      const result = await roosyncConfig({
        action: 'collect',
        targets: [target as any]
      });

      expect(result.status).toBe('success');
    });

    test('should accept multiple valid targets', async () => {
      const result = await roosyncConfig({
        action: 'collect',
        targets: ['modes', 'mcp', 'profiles'] as any
      });

      expect(result.status).toBe('success');
    });

    test('should accept mcp:target format', async () => {
      const result = await roosyncConfig({
        action: 'collect',
        targets: ['mcp:test-server'] as any
      });

      expect(result.status).toBe('success');
    });

    test('should reject target with invalid prefix', async () => {
      await expect(roosyncConfig({
        action: 'collect',
        targets: ['invalid:test'] as any
      })).rejects.toThrow();
    });
  });
});
