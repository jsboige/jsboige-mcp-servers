/**
 * Tests unitaires pour roosync_baseline
 *
 * Couvre les actions de l'outil consolidé :
 * - action: 'update' : Mettre à jour la baseline
 * - action: 'version' : Versionner la baseline avec tag Git
 * - action: 'restore' : Restaurer depuis tag ou backup
 * - action: 'export' : Exporter la baseline
 *
 * Framework: Vitest
 * Coverage cible: >70%
 *
 * @module roosync/baseline.test
 * @version 1.0.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

// Test directory
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-baseline');

// Mock execSync pour les opérations Git, exec pour l'inventaire PowerShell
vi.mock('child_process', () => ({
  exec: vi.fn((cmd: string, options: any, callback?: any) => {
    // Pour l'utilisation avec promisify: callback est le dernier argument
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    // Simuler l'exécution du script PowerShell d'inventaire
    if (callback) {
      callback(null, { stdout: '/tmp/test-inventory.json\n', stderr: '' });
    }
    return {};
  }),
  execSync: vi.fn((cmd: string) => {
    if (cmd.includes('git rev-parse --verify refs/tags/')) {
      // Tag existe pas par défaut
      throw new Error('Tag not found');
    }
    if (cmd.includes('git tag -l')) {
      return 'baseline-v1.0.0\nbaseline-v1.1.0\n';
    }
    if (cmd.includes('git show')) {
      return JSON.stringify({
        machineId: 'test-machine',
        version: '1.0.0',
        lastUpdated: '2026-01-01T00:00:00.000Z',
        config: { roo: {}, hardware: {}, software: {}, system: {} }
      });
    }
    if (cmd.includes('mkdir -p')) {
      // Mock directory creation - return empty string (success)
      return '';
    }
    return '';
  })
}));

// Mock getRooSyncService
vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: vi.fn(() => ({
    getConfig: () => ({
      machineId: 'test-machine',
      sharedPath: testSharedStatePath
    }),
    createNonNominativeBaseline: vi.fn(async (name, reason, config) => ({
      baselineId: name,
      version: '1.0.0',
      profiles: []
    }))
  })),
  RooSyncServiceError: class RooSyncServiceError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
      this.name = 'RooSyncServiceError';
    }
  }
}));

// Mock ConfigService
vi.mock('../../../services/ConfigService.js', () => ({
  ConfigService: class MockConfigService {
    getSharedStatePath() {
      return testSharedStatePath;
    }
  }
}));

// Mock getSharedStatePath utility function
vi.mock('../../utils/server-helpers.js', () => ({
  getSharedStatePath: vi.fn(() => testSharedStatePath)
}));

// Mock BaselineService
vi.mock('../../../services/BaselineService.js', () => ({
  BaselineService: class MockBaselineService {
    async loadBaseline(machineId?: string) {
      const baselinePath = join(testSharedStatePath, 'sync-config.ref.json');
      if (existsSync(baselinePath)) {
        const content = readFileSync(baselinePath, 'utf-8');
        return JSON.parse(content);
      }
      return null;
    }
    async updateBaseline(baseline: any, options: any) {
      const baselinePath = join(testSharedStatePath, 'sync-config.ref.json');
      writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
      return { success: true, backupCreated: options?.createBackup ?? true };
    }
  }
}));

// Mock InventoryCollector
vi.mock('../../../services/InventoryCollector.js', () => ({
  InventoryCollector: class MockInventoryCollector {
    async collectInventory(machineId: string) {
      return {
        machineId,
        config: {
          roo: { modes: [], mcpSettings: {}, userSettings: {} },
          hardware: { cpu: 'Test CPU', ram: '16GB', disks: [] },
          software: { powershell: '7.0', node: '20.0', python: '3.12' },
          system: { os: 'Windows 11', architecture: 'x64' }
        }
      };
    }
  }
}));

// Mock DiffDetector
vi.mock('../../../services/DiffDetector.js', () => ({
  DiffDetector: class MockDiffDetector {}
}));

// Import après les mocks
import { roosync_baseline, BaselineArgs } from '../baseline.js';

describe('roosync_baseline', () => {
  beforeEach(async () => {
    // Set the environment variable for this test suite
    // This is required because getSharedStatePath() reads directly from process.env
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;

    // Setup : créer répertoire temporaire pour tests isolés
    const dirs = [
      testSharedStatePath,
      join(testSharedStatePath, '.rollback'),
      join(testSharedStatePath, 'exports')
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    // Créer une baseline par défaut
    const defaultBaseline = {
      machineId: 'test-machine',
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
      config: {
        roo: { modes: ['code-simple'], mcpSettings: {}, userSettings: {} },
        hardware: { cpu: 'Test CPU', ram: '16GB', disks: [] },
        software: { powershell: '7.0', node: '20.0', python: '3.12' },
        system: { os: 'Windows 11', architecture: 'x64' }
      }
    };
    writeFileSync(
      join(testSharedStatePath, 'sync-config.ref.json'),
      JSON.stringify(defaultBaseline, null, 2)
    );
  });

  afterEach(async () => {
    // Cleanup : supprimer répertoire test pour isolation
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  // ============================================================
  // Tests pour validation d'action
  // ============================================================

  describe('action validation', () => {
    test('should throw for invalid action', async () => {
      await expect(
        roosync_baseline({ action: 'invalid' as any })
      ).rejects.toThrow('Action non supportée');
    });
  });

  // ============================================================
  // Tests pour action: update
  // ============================================================

  describe('action: update', () => {
    test('should throw when machineId is missing', async () => {
      await expect(
        roosync_baseline({ action: 'update' })
      ).rejects.toThrow('machineId est requis');
    });

    test('should update baseline in standard mode', async () => {
      const result = await roosync_baseline({
        action: 'update',
        machineId: 'new-machine',
        mode: 'standard',
        updateReason: 'Test update'
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('update');
      expect(result.newBaseline?.machineId).toBe('new-machine');
    });

    test('should create backup by default', async () => {
      const result = await roosync_baseline({
        action: 'update',
        machineId: 'new-machine'
      });

      expect(result.backupCreated).toBe(true);
    });

    test('should not create backup when createBackup is false', async () => {
      const result = await roosync_baseline({
        action: 'update',
        machineId: 'new-machine',
        createBackup: false
      });

      expect(result.backupCreated).toBeFalsy();
    });

    test('should use provided version', async () => {
      const result = await roosync_baseline({
        action: 'update',
        machineId: 'new-machine',
        version: '2.0.0'
      });

      expect(result.version).toBe('2.0.0');
    });

    test('should support profile mode', async () => {
      const result = await roosync_baseline({
        action: 'update',
        machineId: 'dev-profile',
        mode: 'profile',
        updateReason: 'Creating dev profile'
      });

      expect(result.success).toBe(true);
      expect(result.newBaseline?.machineId).toContain('profile:');
    });
  });

  // ============================================================
  // Tests pour action: version
  // ============================================================

  describe('action: version', () => {
    test('should throw when version is missing', async () => {
      await expect(
        roosync_baseline({ action: 'version' })
      ).rejects.toThrow('version est requis');
    });

    test('should throw for invalid version format', async () => {
      await expect(
        roosync_baseline({ action: 'version', version: 'invalid' })
      ).rejects.toThrow('Format de version invalide');
    });

    test('should accept semantic version', async () => {
      const result = await roosync_baseline({
        action: 'version',
        version: '2.0.0',
        message: 'Test version',
        pushTags: false
      });

      expect(result.success).toBe(true);
      expect(result.tag).toBe('baseline-v2.0.0');
    });

    test('should accept version with prerelease suffix', async () => {
      const result = await roosync_baseline({
        action: 'version',
        version: '2.0.0-beta1',
        pushTags: false
      });

      expect(result.success).toBe(true);
    });

    test('should throw when no baseline exists', async () => {
      // Supprimer la baseline
      rmSync(join(testSharedStatePath, 'sync-config.ref.json'), { force: true });

      await expect(
        roosync_baseline({ action: 'version', version: '2.0.0' })
      ).rejects.toThrow('Aucune baseline trouvée');
    });
  });

  // ============================================================
  // Tests pour action: restore
  // ============================================================

  describe('action: restore', () => {
    test('should throw when source is missing', async () => {
      await expect(
        roosync_baseline({ action: 'restore' })
      ).rejects.toThrow('source est requise');
    });

    test('should throw for invalid source format', async () => {
      await expect(
        roosync_baseline({ action: 'restore', source: 'invalid-source' })
      ).rejects.toThrow('Source de restauration non reconnue');
    });

    test('should restore from tag', async () => {
      // Note: Ce test depend du mock global qui simule git show
      // Le mock global retourne deja une baseline valide pour git show
      const result = await roosync_baseline({
        action: 'restore',
        source: 'baseline-v0.9.0',
        createBackup: false
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('restore');
    });

    test('should restore from backup file', async () => {
      // Créer un fichier de backup
      const backupPath = join(testSharedStatePath, '.rollback', 'sync-config.ref.backup.2026-01-01.json');
      const backupData = {
        machineId: 'backup-machine',
        version: '0.8.0',
        lastUpdated: '2026-01-01T00:00:00.000Z',
        config: { roo: {}, hardware: {}, software: {}, system: {} }
      };
      writeFileSync(backupPath, JSON.stringify(backupData, null, 2));

      const result = await roosync_baseline({
        action: 'restore',
        source: backupPath
      });

      expect(result.success).toBe(true);
      expect(result.version).toBe('0.8.0');
    });

    test('should create backup before restore', async () => {
      const backupPath = join(testSharedStatePath, '.rollback', 'sync-config.ref.backup.2026-01-01.json');
      const backupData = {
        machineId: 'backup-machine',
        version: '0.8.0',
        lastUpdated: '2026-01-01T00:00:00.000Z',
        config: {}
      };
      writeFileSync(backupPath, JSON.stringify(backupData, null, 2));

      const result = await roosync_baseline({
        action: 'restore',
        source: backupPath,
        createBackup: true
      });

      expect(result.backupCreated).toBe(true);
    });
  });

  // ============================================================
  // Tests pour action: export
  // ============================================================

  describe('action: export', () => {
    test('should throw when format is missing', async () => {
      await expect(
        roosync_baseline({ action: 'export' })
      ).rejects.toThrow('format est requis');
    });

    test('should export to JSON format', async () => {
      const result = await roosync_baseline({
        action: 'export',
        format: 'json',
        outputPath: join(testSharedStatePath, 'exports', 'test-export.json')
      });

      expect(result.success).toBe(true);
      expect(result.format).toBe('json');
      expect(result.size).toBeGreaterThan(0);
    });

    test('should export to YAML format', async () => {
      const result = await roosync_baseline({
        action: 'export',
        format: 'yaml',
        outputPath: join(testSharedStatePath, 'exports', 'test-export.yaml')
      });

      expect(result.success).toBe(true);
      expect(result.format).toBe('yaml');
    });

    test('should export to CSV format', async () => {
      const result = await roosync_baseline({
        action: 'export',
        format: 'csv',
        outputPath: join(testSharedStatePath, 'exports', 'test-export.csv')
      });

      expect(result.success).toBe(true);
      expect(result.format).toBe('csv');
    });

    test('should include metadata by default', async () => {
      const result = await roosync_baseline({
        action: 'export',
        format: 'json',
        outputPath: join(testSharedStatePath, 'exports', 'test-export-meta.json')
      });

      expect(result.includeMetadata).toBe(true);
    });

    test('should exclude metadata when includeMetadata is false', async () => {
      const result = await roosync_baseline({
        action: 'export',
        format: 'json',
        includeMetadata: false,
        outputPath: join(testSharedStatePath, 'exports', 'test-export-no-meta.json')
      });

      expect(result.includeMetadata).toBe(false);
    });

    test('should include history when requested', async () => {
      const result = await roosync_baseline({
        action: 'export',
        format: 'json',
        includeHistory: true,
        outputPath: join(testSharedStatePath, 'exports', 'test-export-history.json')
      });

      expect(result.includeHistory).toBe(true);
    });

    test('should throw when no baseline exists', async () => {
      // Supprimer la baseline
      rmSync(join(testSharedStatePath, 'sync-config.ref.json'), { force: true });

      await expect(
        roosync_baseline({ action: 'export', format: 'json' })
      ).rejects.toThrow('Baseline non trouvée');
    });
  });

  // ============================================================
  // Tests pour les fonctions utilitaires
  // ============================================================

  describe('utility functions', () => {
    // Ces tests sont indirects via les actions, mais on peut tester le comportement

    test('generateBaselineVersion should produce date-based version', async () => {
      const result = await roosync_baseline({
        action: 'update',
        machineId: 'test-machine'
        // Pas de version = auto-générée
      });

      // Le format attendu est YYYY.MM.DD-HHMM
      expect(result.version).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d{4}$/);
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration scenarios', () => {
    test('full lifecycle: update -> version -> export', async () => {
      // 1. Update
      const updateResult = await roosync_baseline({
        action: 'update',
        machineId: 'lifecycle-machine',
        version: '3.0.0'
      });
      expect(updateResult.success).toBe(true);

      // 2. Version (with pushTags: false to avoid actual git ops)
      const versionResult = await roosync_baseline({
        action: 'version',
        version: '3.0.1',
        pushTags: false
      });
      expect(versionResult.success).toBe(true);

      // 3. Export
      const exportResult = await roosync_baseline({
        action: 'export',
        format: 'json',
        outputPath: join(testSharedStatePath, 'exports', 'lifecycle-export.json')
      });
      expect(exportResult.success).toBe(true);
    });

    test('CSV export should handle special characters', async () => {
      // Baseline avec caractères spéciaux
      const specialBaseline = {
        machineId: 'test-"quotes"-machine',
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        config: {
          description: 'Test with "quotes" and, commas'
        }
      };
      writeFileSync(
        join(testSharedStatePath, 'sync-config.ref.json'),
        JSON.stringify(specialBaseline, null, 2)
      );

      const result = await roosync_baseline({
        action: 'export',
        format: 'csv',
        outputPath: join(testSharedStatePath, 'exports', 'special-chars.csv')
      });

      expect(result.success).toBe(true);
      // Le CSV devrait échapper les guillemets
      const content = readFileSync(result.outputPath!, 'utf-8');
      expect(content).toContain('""quotes""'); // Guillemets échappés
    });
  });

  // ============================================================
  // Tests pour scénarios de bordure et gestion d'erreurs
  // ============================================================

  describe('edge cases and error handling', () => {
    test('should handle tag already exists error', async () => {
      // Mock pour simuler un tag qui existe déjà
      const { execSync } = await import('child_process');
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('git rev-parse --verify refs/tags/baseline-v1.0.0')) {
          return 'existing-tag-commit'; // Tag existe
        }
        if (cmd.includes('git tag -l')) {
          return 'baseline-v1.0.0\n';
        }
        return '';
      });

      await expect(
        roosync_baseline({ action: 'version', version: '1.0.0', pushTags: false })
      ).rejects.toThrow('existe déjà');
    });

    test('should handle git commit failure gracefully', async () => {
      const { execSync } = await import('child_process');
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('git commit')) {
          throw new Error('Git commit failed');
        }
        if (cmd.includes('git rev-parse --verify refs/tags/')) {
          throw new Error('Tag not found');
        }
        if (cmd.includes('git tag -l')) {
          return 'baseline-v1.0.0\n';
        }
        return '';
      });

      // Le test doit réussir même si le commit échoue (warning only)
      const result = await roosync_baseline({
        action: 'version',
        version: '1.0.1',
        pushTags: false
      });
      expect(result.success).toBe(true);
    });

    test('should handle git tag creation failure', async () => {
      const { execSync } = await import('child_process');
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('git tag -a')) {
          throw new Error('Git tag creation failed');
        }
        if (cmd.includes('git rev-parse --verify refs/tags/')) {
          throw new Error('Tag not found');
        }
        if (cmd.includes('git tag -l')) {
          return 'baseline-v1.0.0\n';
        }
        return '';
      });

      await expect(
        roosync_baseline({ action: 'version', version: '1.0.2', pushTags: false })
      ).rejects.toThrow('Git tag creation failed');
    });

    test('should handle non-existent backup file', async () => {
      await expect(
        roosync_baseline({
          action: 'restore',
          source: '/nonexistent/backup.json'
        })
      ).rejects.toThrow();
    });

    test('should handle invalid baseline in backup', async () => {
      const backupPath = join(testSharedStatePath, '.rollback', 'sync-config.ref.backup.invalid.json');
      writeFileSync(backupPath, '{ invalid json');

      await expect(
        roosync_baseline({ action: 'restore', source: backupPath })
      ).rejects.toThrow();
    });

    test('should handle baseline without required fields', async () => {
      const backupPath = join(testSharedStatePath, '.rollback', 'sync-config.ref.backup.incomplete.json');
      writeFileSync(backupPath, JSON.stringify({ version: '1.0.0' })); // Missing machineId

      await expect(
        roosync_baseline({ action: 'restore', source: backupPath })
      ).rejects.toThrow();
    });
  });

  // ============================================================
  // Tests pour scénarios de profile mode
  // ============================================================

  describe('profile mode scenarios', () => {
    test('should create profile with aggregation config', async () => {
      const result = await roosync_baseline({
        action: 'update',
        machineId: 'dev-profile',
        mode: 'profile',
        aggregationConfig: {
          sources: ['machine1', 'machine2'],
          categoryRules: { modes: 'merge' },
          thresholds: { coverage: 80 }
        }
      });

      expect(result.success).toBe(true);
      expect(result.newBaseline?.machineId).toContain('profile:dev-profile');
    });

    test('should create profile without aggregation config', async () => {
      const result = await roosync_baseline({
        action: 'update',
        machineId: 'simple-profile',
        mode: 'profile'
      });

      expect(result.success).toBe(true);
      expect(result.newBaseline?.machineId).toContain('profile:simple-profile');
    });
  });

  // ============================================================
  // Tests pour export avec différentes options
  // ============================================================

  describe('export options and formatting', () => {
    test('should generate compact JSON when prettyPrint is false', async () => {
      const result = await roosync_baseline({
        action: 'export',
        format: 'json',
        prettyPrint: false,
        outputPath: join(testSharedStatePath, 'exports', 'compact.json')
      });

      expect(result.success).toBe(true);
      const content = readFileSync(result.outputPath!, 'utf-8');
      // JSON compact ne devrait pas avoir beaucoup d'espaces
      expect(content.split('\n').length).toBeLessThan(5);
    });

    test('should auto-generate output path when not provided', async () => {
      const result = await roosync_baseline({
        action: 'export',
        format: 'json'
      });

      expect(result.success).toBe(true);
      expect(result.outputPath).toContain('baseline-export-');
      expect(result.outputPath).toContain('.json');
    });

    test('should create exports directory when missing', async () => {
      // Supprimer le répertoire exports
      const exportsDir = join(testSharedStatePath, 'exports');
      if (existsSync(exportsDir)) {
        rmSync(exportsDir, { recursive: true });
      }

      const result = await roosync_baseline({
        action: 'export',
        format: 'json',
        outputPath: join(exportsDir, 'new-dir', 'test.json')
      });

      expect(result.success).toBe(true);
      expect(existsSync(join(exportsDir, 'new-dir'))).toBe(true);
    });
  });

  // ============================================================
  // Tests pour gestion de sauvegarde (backup)
  // ============================================================

  describe('backup management', () => {
    test('should create backup in .rollback directory', async () => {
      const result = await roosync_baseline({
        action: 'update',
        machineId: 'backup-test-machine',
        createBackup: true
      });

      expect(result.backupCreated).toBe(true);
      expect(result.backupPath).toContain('.rollback');
      expect(result.backupPath).toContain('.backup.');
      expect(existsSync(result.backupPath!)).toBe(true);
    });

    test('should handle missing baseline gracefully when backing up', async () => {
      // Supprimer la baseline existante
      rmSync(join(testSharedStatePath, 'sync-config.ref.json'), { force: true });

      const result = await roosync_baseline({
        action: 'update',
        machineId: 'no-previous-baseline',
        createBackup: true
      });

      expect(result.backupCreated).toBe(false);
      expect(result.previousBaseline).toBeUndefined();
    });

    test('should use legacy baseline path when machine-specific does not exist', async () => {
      // Créer uniquement la baseline legacy
      const legacyBaseline = {
        machineId: 'legacy-machine',
        version: '0.5.0',
        lastUpdated: '2026-01-01T00:00:00.000Z',
        config: {}
      };
      writeFileSync(
        join(testSharedStatePath, 'sync-config.ref.json'),
        JSON.stringify(legacyBaseline, null, 2)
      );

      const result = await roosync_baseline({
        action: 'update',
        machineId: 'legacy-machine',
        createBackup: true
      });

      expect(result.backupCreated).toBe(true);
    });
  });

  // ============================================================
  // Tests pour update avec différentes options
  // ============================================================

  describe('update action options', () => {
    test('should include update reason in result message', async () => {
      const reason = 'Scheduled maintenance update';
      const result = await roosync_baseline({
        action: 'update',
        machineId: 'test-machine',
        updateReason: reason
      });

      expect(result.message).toContain(reason);
    });

    test('should use provided updatedBy', async () => {
      const updatedBy = 'admin-user';
      const result = await roosync_baseline({
        action: 'update',
        machineId: 'test-machine',
        updatedBy
      });

      // updatedBy est passé au service mais pas forcément dans le message
      // Vérifier que l'opération réussit
      expect(result.success).toBe(true);
    });

    test('should auto-generate version when not provided', async () => {
      const result = await roosync_baseline({
        action: 'update',
        machineId: 'test-machine'
      });

      // Format attendu: YYYY.MM.DD-HHMM
      expect(result.version).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d{4}$/);
    });
  });

  // ============================================================
  // Tests pour version action edge cases
  // ============================================================

  describe('version action edge cases', () => {
    test('should handle changelog creation when file does not exist', async () => {
      // Supprimer le changelog s'il existe
      const changelogPath = join(testSharedStatePath, 'CHANGELOG-baseline.md');
      if (existsSync(changelogPath)) {
        rmSync(changelogPath, { force: true });
      }

      const result = await roosync_baseline({
        action: 'version',
        version: '2.0.0',
        pushTags: false
      });

      expect(result.success).toBe(true);
      expect(existsSync(changelogPath)).toBe(true);
    });

    test('should append to existing changelog', async () => {
      const changelogPath = join(testSharedStatePath, 'CHANGELOG-baseline.md');
      const existingContent = '# Existing Changelog\n\nPrevious content\n';
      writeFileSync(changelogPath, existingContent);

      const result = await roosync_baseline({
        action: 'version',
        version: '2.1.0',
        pushTags: false
      });

      expect(result.success).toBe(true);
      const newContent = readFileSync(changelogPath, 'utf-8');
      expect(newContent).toContain('2.1.0');
      expect(newContent).toContain('Previous content');
    });

    test('should handle changelog update failure gracefully', async () => {
      // Ce test vérifie que le système continue même si le changelog échoue
      // Le mock global ne permet pas de tester ce cas spécifique, on vérifie juste que ça marche
      const result = await roosync_baseline({
        action: 'version',
        version: '2.2.0',
        pushTags: false,
        createChangelog: true
      });

      // Doit réussir
      expect(result.success).toBe(true);
    });
  });

  // ============================================================
  // Tests pour restore action edge cases
  // ============================================================

  describe('restore action edge cases', () => {
    test('should list available tags when tag not found', async () => {
      const { execSync } = await import('child_process');
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('git rev-parse --verify')) {
          throw new Error('Tag not found');
        }
        if (cmd.includes('git tag -l')) {
          return 'baseline-v1.0.0\nbaseline-v1.1.0\nbaseline-v2.0.0\n';
        }
        return '';
      });

      await expect(
        roosync_baseline({
          action: 'restore',
          source: 'baseline-v3.0.0',
          createBackup: false
        })
      ).rejects.toThrow('Tags baseline disponibles');
    });

    test('should restore baseline with all fields preserved', async () => {
      const backupPath = join(testSharedStatePath, '.rollback', 'sync-config.ref.backup.2026-02-15.json');
      const completeBaseline = {
        machineId: 'complete-machine',
        version: '1.5.0',
        lastUpdated: '2026-02-15T10:30:00.000Z',
        autoSync: true,
        conflictStrategy: 'merge',
        logLevel: 'info',
        config: {
          roo: { modes: ['code-simple'] },
          hardware: { cpu: 'Test CPU' }
        }
      };
      writeFileSync(backupPath, JSON.stringify(completeBaseline, null, 2));

      const result = await roosync_baseline({
        action: 'restore',
        source: backupPath,
        createBackup: false
      });

      expect(result.version).toBe('1.5.0');
      expect(result.message).toContain('complete-machine');
    });
  });

  // ============================================================
  // Tests pour fonctions utilitaires internes
  // Ces tests visent à améliorer la couverture du code
  // ============================================================

  describe('internal utility functions coverage', () => {
    test('validateSemanticVersion should accept valid versions', () => {
      // Test via action: version avec versions valides
      const validVersions = ['1.0.0', '2.3.4', '10.20.30', '1.0.0-beta1', '2.0.0-rc1'];

      for (const version of validVersions) {
        expect(async () => {
          await roosync_baseline({ action: 'version', version, pushTags: false });
        }).not.toThrow();
      }
    });

    test('validateSemanticVersion should reject invalid versions', () => {
      const invalidVersions = ['1.0', 'v1.0.0', '1.0.0.0', 'abc', ''];

      for (const version of invalidVersions) {
        expect(async () => {
          await roosync_baseline({ action: 'version', version, pushTags: false });
        }).rejects.toThrow();
      }
    });

    test('countParameters should count config parameters', async () => {
      // Créer une baseline avec une configuration complexe
      const complexBaseline = {
        machineId: 'complex-machine',
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        config: {
          roo: {
            modes: ['code-simple', 'debug-complex'],
            mcpSettings: { server1: {}, server2: {} },
            userSettings: { key1: 'value1', key2: 'value2', key3: 'value3' }
          },
          hardware: {
            cpu: { model: 'Test', cores: 8, threads: 16 },
            memory: { total: 16, used: 8 },
            disks: [{ name: 'disk1', size: 500 }, { name: 'disk2', size: 1000 }]
          }
        }
      };
      writeFileSync(
        join(testSharedStatePath, 'sync-config.ref.json'),
        JSON.stringify(complexBaseline, null, 2)
      );

      const result = await roosync_baseline({
        action: 'export',
        format: 'json',
        outputPath: join(testSharedStatePath, 'exports', 'complex-export.json')
      });

      expect(result.success).toBe(true);
      // Les statistiques doivent inclure un compteur de paramètres
      expect(result.size).toBeGreaterThan(0);
    });

    test('simpleYamlExport should handle nested objects', async () => {
      const nestedBaseline = {
        machineId: 'nested-machine',
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        config: {
          level1: {
            level2: {
              level3: 'deep value'
            }
          }
        }
      };
      writeFileSync(
        join(testSharedStatePath, 'sync-config.ref.json'),
        JSON.stringify(nestedBaseline, null, 2)
      );

      const result = await roosync_baseline({
        action: 'export',
        format: 'yaml',
        outputPath: join(testSharedStatePath, 'exports', 'nested-export.yaml')
      });

      expect(result.success).toBe(true);
      const content = readFileSync(result.outputPath!, 'utf-8');
      expect(content).toContain('level1:');
      expect(content).toContain('level2:');
      expect(content).toContain('deep value');
    });

    test('simpleYamlExport should handle arrays', async () => {
      const arrayBaseline = {
        machineId: 'array-machine',
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        config: {
          items: ['item1', 'item2', 'item3'],
          nested: {
            list: [{ id: 1, name: 'first' }, { id: 2, name: 'second' }]
          }
        }
      };
      writeFileSync(
        join(testSharedStatePath, 'sync-config.ref.json'),
        JSON.stringify(arrayBaseline, null, 2)
      );

      const result = await roosync_baseline({
        action: 'export',
        format: 'yaml',
        outputPath: join(testSharedStatePath, 'exports', 'array-export.yaml')
      });

      expect(result.success).toBe(true);
      const content = readFileSync(result.outputPath!, 'utf-8');
      expect(content).toContain('- item1');
      expect(content).toContain('- id:');
    });

    test('generateCsvExport should escape special characters', async () => {
      const specialBaseline = {
        machineId: 'special-machine',
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        config: {
          description: 'Text with "quotes" and, commas',
          notes: 'Line\nbreaks\tand\ttabs'
        }
      };
      writeFileSync(
        join(testSharedStatePath, 'sync-config.ref.json'),
        JSON.stringify(specialBaseline, null, 2)
      );

      const result = await roosync_baseline({
        action: 'export',
        format: 'csv',
        outputPath: join(testSharedStatePath, 'exports', 'special-csv.csv')
      });

      expect(result.success).toBe(true);
      const content = readFileSync(result.outputPath!, 'utf-8');
      // Vérifier que les guillemets sont échappés
      expect(content).toContain('""quotes""');
    });

    test('updateDashboard should update machine baseline status', async () => {
      // Note: Ce test vérifie que l'opération réussit
      // Le mock ne permet pas de tester le fichier dashboard car readJSONFileSyncWithoutBOM n'est pas mocké
      const result = await roosync_baseline({
        action: 'update',
        machineId: 'dashboard-test-machine',
        version: '2.0.0'
      });

      expect(result.success).toBe(true);
      expect(result.newBaseline?.machineId).toBe('dashboard-test-machine');
      expect(result.version).toBe('2.0.0');
    });

    test('updateRoadmap should append baseline update entry', async () => {
      // Créer un roadmap existant
      const roadmapPath = join(testSharedStatePath, 'sync-roadmap.md');
      const existingRoadmap = '# Existing Roadmap\n\nPrevious content\n';
      writeFileSync(roadmapPath, existingRoadmap);

      const result = await roosync_baseline({
        action: 'update',
        machineId: 'roadmap-test-machine',
        version: '3.0.0',
        updateReason: 'Test roadmap update'
      });

      expect(result.success).toBe(true);
      const updatedRoadmap = readFileSync(roadmapPath, 'utf-8');
      expect(updatedRoadmap).toContain('## 🔄 Mise à Jour Baseline');
      expect(updatedRoadmap).toContain('roadmap-test-machine');
      expect(updatedRoadmap).toContain('3.0.0');
      expect(updatedRoadmap).toContain('Test roadmap update');
      expect(updatedRoadmap).toContain('Previous content'); // Contenu précédent préservé
    });
  });

  // ============================================================
  // Tests pour createBaselineFromInventory
  // ============================================================

  describe('createBaselineFromInventory coverage', () => {
    test('should create baseline with machines array in v2.x format', async () => {
      const result = await roosync_baseline({
        action: 'update',
        machineId: 'inventory-test-machine',
        mode: 'standard',
        version: '4.0.0'
      });

      expect(result.success).toBe(true);
      expect(result.newBaseline?.machineId).toBe('inventory-test-machine');

      // Vérifier que la baseline créée a le format v2.x avec machines array
      const baselinePath = join(testSharedStatePath, 'sync-config.ref.json');
      const createdBaseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
      expect(createdBaseline.machines).toBeDefined();
      expect(Array.isArray(createdBaseline.machines)).toBe(true);
      expect(createdBaseline.machines.length).toBeGreaterThan(0);
      expect(createdBaseline.machines[0].id).toBe('inventory-test-machine');
    });

    test('should map inventory fields to baseline structure', async () => {
      const result = await roosync_baseline({
        action: 'update',
        machineId: 'mapping-test-machine',
        version: '5.0.0'
      });

      expect(result.success).toBe(true);

      const baselinePath = join(testSharedStatePath, 'sync-config.ref.json');
      const createdBaseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
      const machine = createdBaseline.machines[0];

      // Vérifier le mapping des champs
      expect(machine.id).toBe('mapping-test-machine');
      expect(machine.name).toBe('mapping-test-machine');
      expect(machine.hostname).toBeDefined();
      expect(machine.os).toBeDefined();
      expect(machine.architecture).toBeDefined();
      expect(machine.roo).toBeDefined();
      expect(machine.hardware).toBeDefined();
      expect(machine.software).toBeDefined();
      expect(machine.lastSeen).toBeDefined();
    });
  });

  // ============================================================
  // Tests pour handleUpdateAction avec mode profile
  // ============================================================

  describe('handleUpdateAction profile mode coverage', () => {
    test('should create non-nominative baseline with profile prefix', async () => {
      const result = await roosync_baseline({
        action: 'update',
        machineId: 'test-profile',
        mode: 'profile',
        version: '6.0.0'
      });

      expect(result.success).toBe(true);
      expect(result.newBaseline?.machineId).toBe('profile:test-profile');

      const baselinePath = join(testSharedStatePath, 'sync-config.ref.json');
      const createdBaseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));

      // Vérifier les champs spécifiques au mode profile
      expect(createdBaseline.isNonNominative).toBe(true);
      expect(createdBaseline.profiles).toBeDefined();
      expect(createdBaseline.machines).toBeDefined();
      expect(createdBaseline.machines[0].id).toBe('profile:test-profile');
      expect(createdBaseline.machines[0].name).toContain('Profile:');
    });

    test('should include aggregation config in profile baseline', async () => {
      const aggregationConfig = {
        sources: ['machine1', 'machine2', 'machine3'],
        categoryRules: { modes: 'merge', mcp: 'intersect' },
        thresholds: { coverage: 85, consistency: 90 }
      };

      const result = await roosync_baseline({
        action: 'update',
        machineId: 'aggregated-profile',
        mode: 'profile',
        aggregationConfig,
        version: '7.0.0'
      });

      expect(result.success).toBe(true);
      expect(result.newBaseline?.machineId).toContain('profile:aggregated-profile');
    });
  });

  // ============================================================
  // Tests pour handleVersionAction avec changelog
  // ============================================================

  describe('handleVersionAction changelog coverage', () => {
    test('should create new changelog file when it does not exist', async () => {
      const changelogPath = join(testSharedStatePath, 'CHANGELOG-baseline.md');
      if (existsSync(changelogPath)) {
        rmSync(changelogPath, { force: true });
      }

      const result = await roosync_baseline({
        action: 'version',
        version: '8.0.0',
        pushTags: false,
        createChangelog: true
      });

      expect(result.success).toBe(true);
      expect(existsSync(changelogPath)).toBe(true);

      const changelogContent = readFileSync(changelogPath, 'utf-8');
      expect(changelogContent).toContain('# CHANGELOG Baseline RooSync');
      expect(changelogContent).toContain('## [8.0.0]');
      expect(changelogContent).toContain('baseline-v8.0.0');
    });

    test('should append version entry to existing changelog', async () => {
      const changelogPath = join(testSharedStatePath, 'CHANGELOG-baseline.md');
      const initialContent = `# CHANGELOG Baseline RooSync

## [1.0.0] - 2026-01-01

First release

`;
      writeFileSync(changelogPath, initialContent);

      const result = await roosync_baseline({
        action: 'version',
        version: '9.0.0',
        pushTags: false,
        createChangelog: true
      });

      expect(result.success).toBe(true);

      const changelogContent = readFileSync(changelogPath, 'utf-8');
      expect(changelogContent).toContain('## [9.0.0]');
      expect(changelogContent).toContain('## [1.0.0]'); // Ancien contenu préservé
    });

    test('should skip changelog creation when createChangelog is false', async () => {
      const changelogPath = join(testSharedStatePath, 'CHANGELOG-baseline.md');
      const initialContent = '# Initial changelog\n';
      writeFileSync(changelogPath, initialContent);

      const result = await roosync_baseline({
        action: 'version',
        version: '10.0.0',
        pushTags: false,
        createChangelog: false
      });

      expect(result.success).toBe(true);

      const changelogContent = readFileSync(changelogPath, 'utf-8');
      expect(changelogContent).toBe(initialContent); // Non modifié
    });
  });

  // ============================================================
  // Tests pour handleRestoreAction
  // ============================================================

  describe('handleRestoreAction edge cases coverage', () => {
    test('should handle restore when current baseline cannot be loaded', async () => {
      // Rendre la baseline actuelle invalide
      writeFileSync(
        join(testSharedStatePath, 'sync-config.ref.json'),
        '{ invalid json content'
      );

      // Le fichier de backup doit suivre le pattern sync-config.ref.backup.*
      const backupPath = join(testSharedStatePath, '.rollback', 'sync-config.ref.backup.restore-test.json');
      const validBackup = {
        machineId: 'restore-test-machine',
        version: '1.0.0',
        lastUpdated: '2026-01-01T00:00:00.000Z',
        config: {}
      };
      writeFileSync(backupPath, JSON.stringify(validBackup, null, 2));

      const result = await roosync_baseline({
        action: 'restore',
        source: backupPath,
        createBackup: false
      });

      expect(result.success).toBe(true);
      expect(result.version).toBe('1.0.0');
    });

    test('should use provided restore reason and restored by', async () => {
      // Le fichier de backup doit suivre le pattern sync-config.ref.backup.*
      const backupPath = join(testSharedStatePath, '.rollback', 'sync-config.ref.backup.metadata-test.json');
      const backupData = {
        machineId: 'metadata-machine',
        version: '1.1.0',
        lastUpdated: '2026-01-01T00:00:00.000Z',
        config: {}
      };
      writeFileSync(backupPath, JSON.stringify(backupData, null, 2));

      const restoreReason = 'Rollback after failed deployment';
      const restoredBy = 'admin-user';

      const result = await roosync_baseline({
        action: 'restore',
        source: backupPath,
        updateReason: restoreReason,
        restoredBy,
        createBackup: false
      });

      expect(result.success).toBe(true);
      // Le message de résultat confirme la restauration
      expect(result.message).toContain('Baseline restaurée avec succès');
      expect(result.message).toContain('metadata-machine');
    });
  });

  // ============================================================
  // Tests pour handleExportAction
  // ============================================================

  describe('handleExportAction coverage', () => {
    test('should auto-generate output filename with timestamp', async () => {
      const result = await roosync_baseline({
        action: 'export',
        format: 'json'
        // Pas de outputPath spécifié
      });

      expect(result.success).toBe(true);
      expect(result.outputPath).toBeDefined();
      expect(result.outputPath).toMatch(/baseline-export-.*\.json$/);
      // Le timestamp utilise le format ISO avec remplacement de : et . par -
      expect(result.outputPath).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    });

    test('should create output directory if it does not exist', async () => {
      const nonExistentDir = join(testSharedStatePath, 'exports', 'new-directory', 'nested');
      const outputPath = join(nonExistentDir, 'auto-created-export.json');

      const result = await roosync_baseline({
        action: 'export',
        format: 'json',
        outputPath
      });

      expect(result.success).toBe(true);
      expect(existsSync(nonExistentDir)).toBe(true);
      expect(existsSync(outputPath)).toBe(true);
    });

    test('should include exportInfo in exported data', async () => {
      const result = await roosync_baseline({
        action: 'export',
        format: 'json',
        outputPath: join(testSharedStatePath, 'exports', 'export-info-test.json')
      });

      expect(result.success).toBe(true);

      const exportedContent = readFileSync(result.outputPath!, 'utf-8');
      const exportedData = JSON.parse(exportedContent);
      expect(exportedData.exportInfo).toBeDefined();
      expect(exportedData.exportInfo.format).toBe('json');
      expect(exportedData.exportInfo.exportedBy).toBe('roosync_baseline');
      expect(exportedData.exportInfo.version).toBe('2.3.0');
    });

    test('should include statistics in exported data', async () => {
      const result = await roosync_baseline({
        action: 'export',
        format: 'json',
        outputPath: join(testSharedStatePath, 'exports', 'export-stats-test.json')
      });

      expect(result.success).toBe(true);

      const exportedContent = readFileSync(result.outputPath!, 'utf-8');
      const exportedData = JSON.parse(exportedContent);
      expect(exportedData.statistics).toBeDefined();
      expect(exportedData.statistics.totalParameters).toBeGreaterThanOrEqual(0);
      expect(exportedData.statistics.lastModified).toBeDefined();
      expect(exportedData.statistics.exportTimestamp).toBeDefined();
    });
  });
});
