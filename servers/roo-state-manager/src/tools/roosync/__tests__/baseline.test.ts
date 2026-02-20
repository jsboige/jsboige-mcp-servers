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

// Mock execSync pour les opérations Git
vi.mock('child_process', () => ({
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

// Mock BaselineService
vi.mock('../../../services/BaselineService.js', () => ({
  BaselineService: class MockBaselineService {
    async loadBaseline() {
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
      return true;
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
});
