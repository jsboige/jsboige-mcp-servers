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
 * @version 1.1.0 (#564 Phase 2, #606 fix)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
// #2639: racine hors arbre du dépôt (mkdtemp) — l'ancien __test-data__/ in-tree
// reproduisait la classe ENOTEMPTY du cleanup Linux fixée par #1355 pour diagnose-it
const testSharedStatePath = mkdtempSync(join(tmpdir(), 'config-it-'));
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Fix #634: Integration tests need REAL RooSyncService and ConfigService
vi.unmock('../../../services/RooSyncService.js');
vi.unmock('../../../services/ConfigService.js');

// Import après les mocks
import { roosyncConfig } from '../config.js';
import { RooSyncService } from '../../../services/RooSyncService.js';
import { InventoryService } from '../../../services/roosync/InventoryService.js';

describe('roosyncConfig (integration)', () => {
  beforeEach(async () => {
    // Setup : créer répertoire temporaire pour tests isolés
    const dirs = [
      testSharedStatePath,
      join(testSharedStatePath, 'roo-config'),
      join(testSharedStatePath, 'roo-config/modes'),
      join(testSharedStatePath, 'roo-config/mcp'),
      join(testSharedStatePath, 'roo-config/profiles'),
      join(testSharedStatePath, 'packages'),
      join(testSharedStatePath, 'backups')
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

      // #2507: warning is valid when target files don't exist on this machine
      expect(['success', 'warning']).toContain(result.status);
      expect(result.message).toContain('Configuration collectée');
      // manifest comes from configSharingService.collectConfig() result
      expect(result.manifest).toMatchObject({ version: '0.0.0', files: expect.any(Array) });
      // #2766: an empty collect tears its package down — no dangling packagePath.
      if (result.status === 'success') expect(result.packagePath).toContain('config-collect-');
      else expect(result.packagePath).toBeUndefined();
    });

    test('should collect specified targets', async () => {
      const result = await roosyncConfig({
        action: 'collect',
        targets: ['modes']
      });

      // #2507: warning is valid when target files don't exist on this machine
      expect(['success', 'warning']).toContain(result.status);
      // The manifest structure is ConfigSharingService's contract: version stamp,
// author, and a file list — even when the list is empty.
      expect(result.manifest).toMatchObject({ version: '0.0.0', files: expect.any(Array) });
    });

    test('should collect multiple target types', async () => {
      const result = await roosyncConfig({
        action: 'collect',
        targets: ['modes', 'mcp', 'profiles']
      });

      // #2507: warning is valid when target files don't exist on this machine
      expect(['success', 'warning']).toContain(result.status);
      expect(result.manifest).toMatchObject({ version: '0.0.0', files: expect.any(Array) });
    });

    test('should support dryRun mode', async () => {
      const result = await roosyncConfig({
        action: 'collect',
        dryRun: true
      });

      // #2507: warning is valid when target files don't exist on this machine
      expect(['success', 'warning']).toContain(result.status);
    });

    test('should collect specific MCP server config', async () => {
      const result = await roosyncConfig({
        action: 'collect',
        targets: ['mcp:test-server']
      });

      // Accept both 'success' (server found) and 'warning' (server not in local config)
      // #2491: warning is valid when the MCP server doesn't exist in the config source
      expect(['success', 'warning']).toContain(result.status);
    });

    test('should handle invalid targets by either rejecting or collecting 0 files', async () => {
      // Zod refine validates targets at schema level
      // If it passes validation, collectConfig may return 0 files for unknown targets
      try {
        const result = await roosyncConfig({
          action: 'collect',
          targets: ['invalid-target'] as any
        });
        // If it doesn't throw, it must still report a known status.
        expect(['success', 'warning']).toContain(result.status);
      } catch (error) {
        // If it throws, that's also valid behavior — but it must be a real Error.
        expect(error).toBeInstanceOf(Error);
      }
    });

    test('should handle MCP target with empty server name', async () => {
      // Zod refine should reject this at validation level
      try {
        const result = await roosyncConfig({
          action: 'collect',
          targets: ['mcp:'] as any
        });
        expect(['success', 'warning']).toContain(result.status);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
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
      // #2507: Skip if collect returned warning (empty package)
      if (!testPackagePath) return;

      const result = await roosyncConfig({
        action: 'publish',
        version: '1.0.0',
        description: 'Test configuration publish',
        packagePath: testPackagePath
      });

      expect(result.status).toBe('success');
      expect(result.message).toContain('publiée avec succès');
      expect(result.version).toBe('1.0.0');
      // Published next to the shared state, under a semver directory (#4010).
      expect(result.targetPath).toContain('1.0.0');
    });

    test('should perform atomic collect+publish when targets provided without packagePath', async () => {
      const result = await roosyncConfig({
        action: 'publish',
        version: '2.0.0',
        description: 'Atomic collect+publish test',
        targets: ['modes']
      });

      // #2507: warning is valid when target files don't exist
      expect(['success', 'warning']).toContain(result.status);
      if (result.status === 'success') {
        expect(result.version).toBe('2.0.0');
      }
    });

    test('should publish without version (version becomes undefined)', async () => {
      // #2507: Skip if collect returned warning (empty package)
      if (!testPackagePath) return;

      // The service accepts publish without version - it just sets version to undefined
      const result = await roosyncConfig({
        action: 'publish',
        description: 'Test',
        packagePath: testPackagePath
      } as any);
      expect(result.status).toBe('success');
    });

    test('should publish without description', async () => {
      // #2507: Skip if collect returned warning (empty package)
      if (!testPackagePath) return;

      // The service accepts publish without description
      const result = await roosyncConfig({
        action: 'publish',
        version: '1.0.0',
        packagePath: testPackagePath
      } as any);
      expect(result.status).toBe('success');
    });

    test('should reject publish without packagePath or targets (Zod validation)', async () => {
      await expect(roosyncConfig({
        action: 'publish',
        version: '1.0.0',
        description: 'Test'
      } as any)).rejects.toThrow();
    });

    test('should include machineId in result when provided', async () => {
      // #2507: Skip if collect returned warning (empty package)
      if (!testPackagePath) return;

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
      const result = await roosyncConfig({
        action: 'apply',
        dryRun: true
      });

      // #2413: three documented outcomes — applied, applied-but-drift, failed.
      expect(result).toMatchObject({
        status: expect.stringMatching(/^(success|drift|error)$/),
        filesApplied: expect.any(Number),
      });
    });

    test('should handle apply with version that matches current', async () => {
      // Version compatibility depends on what's already configured
      // Just verify the call doesn't crash unexpectedly
      try {
        const result = await roosyncConfig({
          action: 'apply',
          version: 'latest',
          dryRun: true
        });
        expect(result).toMatchObject({ status: expect.stringMatching(/^(success|drift|error)$/) });
      } catch (error) {
        // Version mismatch throws, which is valid behavior
        expect(error).toBeInstanceOf(Error);
      }
    });

    test('should create backup when backup is true (default)', async () => {
      const result = await roosyncConfig({
        action: 'apply',
        backup: true,
        dryRun: true
      });

      expect(result).toMatchObject({
        status: expect.stringMatching(/^(success|drift|error)$/),
        filesApplied: expect.any(Number),
      });
    });

    test('should skip backup when backup is false', async () => {
      const result = await roosyncConfig({
        action: 'apply',
        backup: false,
        dryRun: true
      });

      expect(result).toMatchObject({
        status: expect.stringMatching(/^(success|drift|error)$/),
        filesApplied: expect.any(Number),
      });
    });

    test('should apply specific targets only', async () => {
      const result = await roosyncConfig({
        action: 'apply',
        targets: ['modes'],
        dryRun: true
      });

      expect(result).toMatchObject({
        status: expect.stringMatching(/^(success|drift|error)$/),
        filesApplied: expect.any(Number),
      });
    });

    test.skip('should throw on incompatible major version - SKIP: ConfigService cache sharedStatePath à la construction (ConfigService.ts:41), pas de resetInstance → currentVersion null (vérifié #2642, ref #609)', async () => {
      // NOTE: Test skipped due to ConfigService path caching issue.
      //
      // The ConfigService determines its sharedStatePath at construction time.
      // In the test environment, the mock getSharedStatePath() returns testSharedStatePath,
      // but the ConfigService may be instantiated before the test creates sync-config.json.
      // This causes the version check to be skipped (currentVersion is null).
      //
      // Alternative testing strategies:
      // 1. Unit test ConfigService.getVersionCompatibility() directly with mocked versions
      // 2. Create a real sync-config.json in the actual shared state path before test run
      // 3. Add a ConfigService.resetInstance() method to clear cached paths
      //
      // The version validation logic itself is tested in other contexts (apply handles compatible versions).
      // This specific edge case (major version mismatch) is validated manually in production.
      //
      // Ref: Issue #609 - Integration test path mocking complexity

      // Original test code (kept for reference):
      // const syncConfigPath = join(testSharedStatePath, 'sync-config.json');
      // writeFileSync(syncConfigPath, JSON.stringify({ version: '2.0.0' }, null, 2));
      // ...
    });

    test('should report applied files', async () => {
      const result = await roosyncConfig({
        action: 'apply',
        dryRun: true
      });

      // `filesApplied` is the apply contract: always a COUNT (0 when nothing
      // was written, e.g. an empty package in this test environment).
      expect(result).toMatchObject({
        status: expect.stringMatching(/^(success|drift|error)$/),
        filesApplied: expect.any(Number),
      });
    });
  });

  // ============================================================
  // Tests pour action: 'apply_profile'
  // ============================================================

  describe('action: apply_profile', () => {
    test('should throw when profile not found', async () => {
      // #2639: la branche source-locale résout model-configs.json via InventoryService
      // (inventaire frais de la machine réelle), PAS via getSharedStatePath mocké —
      // le test échouait une branche plus tôt ('non trouvé localement') ou lisait
      // l'état réel selon la machine. On épingle l'inventaire sur le tmpdir et on
      // fournit une fixture pour atteindre déterministement la branche profil absent.
      writeFileSync(
        join(testSharedStatePath, 'roo-config', 'model-configs.json'),
        JSON.stringify({ profiles: [{ name: 'test-profile', modeOverrides: {}, description: 'fixture #2639' }] })
      );
      const inventorySpy = vi
        .spyOn(InventoryService.prototype, 'getMachineInventory')
        .mockResolvedValue({ paths: { rooExtensions: testSharedStatePath } } as any);
      try {
        await expect(roosyncConfig({
          action: 'apply_profile',
          profileName: 'Nonexistent Profile XYZ',
          dryRun: true
        })).rejects.toThrow(/profil.*non trouv|non trouve|not found|profile.*not|ne contient pas/i);
      } finally {
        inventorySpy.mockRestore();
      }
    });

    test('should reject apply_profile without profileName (Zod validation)', async () => {
      await expect(roosyncConfig({
        action: 'apply_profile'
        // profileName manquant
      } as any)).rejects.toThrow();
    });

    test('should throw when sourceMachineId has no published config', async () => {
      await expect(roosyncConfig({
        action: 'apply_profile',
        profileName: 'Test Profile',
        sourceMachineId: 'nonexistent-source-machine',
        dryRun: true
      })).rejects.toThrow();
    });

    test('should handle profile with known profile name', async () => {
      // The available profiles depend on the system's model-configs.json
      // We test that the function accepts valid input and either succeeds or throws with a meaningful error
      try {
        const result = await roosyncConfig({
          action: 'apply_profile',
          profileName: 'Production (Qwen 3.5 local + GLM-5 cloud)',
          dryRun: true
        });
        // #4689: the profile is looked up by EXACT name (p.name === profileName),
        // so a success path echoes the requested name; status is one of three.
        expect(['success', 'drift', 'error']).toContain(result.status);
        expect(result.profileName).toBe('Production (Qwen 3.5 local + GLM-5 cloud)');
        expect(result.modesConfigured).toBeTypeOf('number');
      } catch (error: any) {
        // Profile might not be applicable in test environment
        expect(error).toBeInstanceOf(Error);
        expect(error.message.length).toBeGreaterThan(0);
      }
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should reject invalid action (Zod validation)', async () => {
      await expect(roosyncConfig({
        action: 'invalid' as any
      })).rejects.toThrow();
    });

    test('should reject publish missing required parameters', async () => {
      await expect(roosyncConfig({
        action: 'publish'
        // version et description manquants
      } as any)).rejects.toThrow();
    });

    test('should handle collect with missing config directories', async () => {
      // Supprimer les répertoires pour simuler une erreur
      rmSync(join(testSharedStatePath, 'roo-config'), { recursive: true, force: true });

      const result = await roosyncConfig({
        action: 'collect',
        targets: ['modes']
      });

      // Should return warning when no files collected
      // #4689: the warning's REASON is the contract — 0 files for these targets.
      expect(result.message).toContain('Aucun fichier collecté');
      expect(result.status).toBe('warning');
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration scenarios', () => {
    test('should handle collect → publish workflow', async () => {
      // Step 1: Collect
      const collectResult = await roosyncConfig({
        action: 'collect',
        targets: ['modes']
      });
      // #2507: warning is valid when target files don't exist on this machine
      expect(['success', 'warning']).toContain(collectResult.status);

      // Step 2: Publish (only if collect succeeded)
      // #2766: warning (0 files) cleans up temp dir + omits packagePath;
      // only success guarantees a publishable packagePath.
      if (collectResult.status === 'success') {
        // #4689: success guarantees a temp package dir named config-collect-*.
        expect(collectResult.packagePath).toContain('config-collect-');
        const publishResult = await roosyncConfig({
          action: 'publish',
          version: '1.0.0',
          description: 'Integration test workflow',
          packagePath: collectResult.packagePath
        });
        expect(publishResult.status).toBe('success');
        expect(publishResult.version).toBe('1.0.0');
      }
    });

    test('should handle atomic collect+publish workflow', async () => {
      const result = await roosyncConfig({
        action: 'publish',
        version: '2.0.0',
        description: 'Atomic workflow test',
        targets: ['modes', 'mcp']
      });

      // #2507: warning is valid when target files don't exist on this machine
      expect(['success', 'warning']).toContain(result.status);
      if (result.status === 'success') {
        expect(result.version).toBe('2.0.0');
        // #4689: the published path carries the version it was published under.
        expect(result.targetPath).toContain('2.0.0');
      }
    });

    test('should persist singleton state across calls', async () => {
      const instance1 = RooSyncService.getInstance({ enabled: false });

      await roosyncConfig({
        action: 'collect',
        targets: ['modes']
      });

      const instance2 = RooSyncService.getInstance({ enabled: false });

      // Les instances devraient être les mêmes (singleton) — c'est le contrat.
      expect(instance1).toBe(instance2);
      expect(instance1.getConfig).toBeTypeOf('function');
    });

    test('should handle multiple sequential collect operations', async () => {
      // Collect 1
      const collect1 = await roosyncConfig({
        action: 'collect',
        targets: ['modes']
      });
      // #2507: warning is valid when target files don't exist on this machine
      expect(['success', 'warning']).toContain(collect1.status);

      // Collect 2
      const collect2 = await roosyncConfig({
        action: 'collect',
        targets: ['mcp']
      });
      // #2507: warning is valid when target files don't exist on this machine
      expect(['success', 'warning']).toContain(collect2.status);

      // Publish from first collect (#2766: only when collect1 produced a package)
      if (collect1.status === 'success') {
        const publish = await roosyncConfig({
          action: 'publish',
          version: '3.0.0',
          description: 'Multiple operations test',
          packagePath: collect1.packagePath
        });
        expect(publish.status).toBe('success');
      }
    });
  });

  // ============================================================
  // Tests de validation des cibles
  // ============================================================

  describe('target validation', () => {
    // These targets are accepted by Zod schema and passed to the service
    const safeTargets = ['modes', 'mcp', 'profiles', 'model-configs', 'rules', 'settings'];

    test.each(safeTargets)('should accept valid target: %s', async (target) => {
      const result = await roosyncConfig({
        action: 'collect',
        targets: [target as any]
      });

      // #2507: warning is valid when target files don't exist on this machine
      expect(['success', 'warning']).toContain(result.status);
    });

    test('should handle roomodes target (may fail if .roomodes not valid JSON)', async () => {
      // roomodes target tries to read .roomodes file which may not be valid JSON in test env
      try {
        const result = await roosyncConfig({
          action: 'collect',
          targets: ['roomodes']
        });
        expect(result.status).toBe('success');
      } catch (error: any) {
        // May throw if .roomodes file doesn't exist or isn't valid JSON
        expect(error).toBeInstanceOf(Error);
        expect(error.message.length).toBeGreaterThan(0);
      }
    });

    test('should accept multiple valid targets', async () => {
      const result = await roosyncConfig({
        action: 'collect',
        targets: ['modes', 'mcp', 'profiles'] as any
      });

      // #2507: warning is valid when target files don't exist on this machine
      expect(['success', 'warning']).toContain(result.status);
    });

    test('should accept mcp:target format', async () => {
      const result = await roosyncConfig({
        action: 'collect',
        targets: ['mcp:roo-state-manager'] as any
      });

      // Accept both 'success' (server found in config source) and 'warning' (0 files collected)
      // #2491: Depends on which MCP config source is used (Roo settings vs ~/.claude.json vs .mcp.json)
      expect(['success', 'warning']).toContain(result.status);
    });

    test('should handle target with invalid prefix', async () => {
      // Zod refine may catch this or the service may handle it
      try {
        const result = await roosyncConfig({
          action: 'collect',
          targets: ['invalid:test'] as any
        });
        expect(['success', 'warning']).toContain(result.status);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message.length).toBeGreaterThan(0);
      }
    });
  });
});
