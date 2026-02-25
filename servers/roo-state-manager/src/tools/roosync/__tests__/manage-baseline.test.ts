/**
 * Tests fonctionnels pour roosync_manage_baseline
 *
 * Couvre les chemins d'exécution réels :
 * - action: 'version' (créer un tag Git)
 * - action: 'restore' (depuis tag ou fichier backup)
 * - Cas d'erreur : version invalide, pas de baseline, source inconnue
 *
 * @module roosync/manage-baseline.test
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-manage-baseline');

// Mock execSync pour isoler les opérations Git
vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string, options?: any): any => {
    // Version action: tag n'existe pas encore (comportement normal)
    if (cmd.includes('git rev-parse --verify refs/tags/')) {
      throw new Error('Tag not found');
    }
    // Restore action: vérifier si commit existe (renvoie '' = existe)
    if (cmd.includes('^{commit}')) {
      return '';
    }
    // git show pour récupérer le contenu d'un tag
    if (cmd.includes('git show')) {
      return JSON.stringify({
        machineId: 'restored-machine',
        version: '0.9.0',
        lastUpdated: '2026-01-01T00:00:00.000Z',
        config: {
          roo: { modes: [], mcpSettings: {}, userSettings: {} },
          hardware: { cpu: 'Old CPU', ram: '8GB', disks: [] },
          software: { powershell: '5.1', node: '18.0', python: '3.10' },
          system: { os: 'Windows 10', architecture: 'x64' }
        }
      });
    }
    // git tag -l pour lister les tags
    if (cmd.includes('git tag -l')) {
      return 'baseline-v1.0.0\nbaseline-v1.1.0\n';
    }
    // Toutes les autres commandes (git add, git commit, git tag -a, git push)
    return '';
  })
}));

// Mock RooSyncService
vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: vi.fn(() => ({
    getConfig: () => ({
      machineId: 'test-machine',
      sharedPath: testSharedStatePath
    })
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

// Mock BaselineService - lit depuis le répertoire de test
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
    async updateBaseline() {
      return true;
    }
  }
}));

// Import après les mocks
import { roosync_manage_baseline } from '../manage-baseline.js';

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

describe('roosync_manage_baseline - action: version', () => {
  beforeEach(() => {
    const dirs = [
      testSharedStatePath,
      join(testSharedStatePath, '.rollback')
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    writeFileSync(
      join(testSharedStatePath, 'sync-config.ref.json'),
      JSON.stringify(defaultBaseline, null, 2)
    );
  });

  afterEach(() => {
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  test('should throw for invalid version format', async () => {
    await expect(
      roosync_manage_baseline({ action: 'version', version: 'invalid' })
    ).rejects.toThrow('Format de version invalide');
  });

  test('should throw when version is missing', async () => {
    await expect(
      roosync_manage_baseline({ action: 'version' })
    ).rejects.toThrow('Format de version invalide');
  });

  test('should throw when no baseline exists', async () => {
    rmSync(join(testSharedStatePath, 'sync-config.ref.json'), { force: true });

    await expect(
      roosync_manage_baseline({ action: 'version', version: '2.0.0' })
    ).rejects.toThrow('Aucune baseline trouvée');
  });

  test('should version baseline successfully', async () => {
    const result = await roosync_manage_baseline({
      action: 'version',
      version: '2.0.0',
      pushTags: false,
      createChangelog: false
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe('version');
    expect(result.version).toBe('2.0.0');
    expect(result.tag).toBe('baseline-v2.0.0');
  });

  test('should accept semantic version with prerelease', async () => {
    const result = await roosync_manage_baseline({
      action: 'version',
      version: '2.0.0-beta1',
      pushTags: false,
      createChangelog: false
    });

    expect(result.success).toBe(true);
    expect(result.tag).toBe('baseline-v2.0.0-beta1');
  });

  test('should create changelog when createChangelog is not false', async () => {
    const result = await roosync_manage_baseline({
      action: 'version',
      version: '3.0.0',
      pushTags: false,
      message: 'Test version'
    });

    expect(result.success).toBe(true);
    // Changelog file should be created
    const changelogPath = join(testSharedStatePath, 'CHANGELOG-baseline.md');
    expect(existsSync(changelogPath)).toBe(true);
    const content = readFileSync(changelogPath, 'utf-8');
    expect(content).toContain('3.0.0');
  });

  test('should use custom message for tag', async () => {
    const result = await roosync_manage_baseline({
      action: 'version',
      version: '4.0.0',
      message: 'Custom tag message',
      pushTags: false,
      createChangelog: false
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('4.0.0');
  });
});

describe('roosync_manage_baseline - action: restore', () => {
  beforeEach(() => {
    const dirs = [
      testSharedStatePath,
      join(testSharedStatePath, '.rollback')
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    writeFileSync(
      join(testSharedStatePath, 'sync-config.ref.json'),
      JSON.stringify(defaultBaseline, null, 2)
    );
  });

  afterEach(() => {
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  test('should throw when source is missing', async () => {
    await expect(
      roosync_manage_baseline({ action: 'restore' })
    ).rejects.toThrow('Source de restauration');
  });

  test('should throw for unrecognized source format', async () => {
    await expect(
      roosync_manage_baseline({ action: 'restore', source: 'not-a-valid-source' })
    ).rejects.toThrow('Source de restauration non reconnue');
  });

  test('should restore from Git tag successfully', async () => {
    const result = await roosync_manage_baseline({
      action: 'restore',
      source: 'baseline-v0.9.0',
      createBackup: false
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe('restore');
    expect(result.version).toBe('0.9.0');
  });

  test('should restore from backup file successfully', async () => {
    const backupPath = join(
      testSharedStatePath,
      '.rollback',
      'sync-config.ref.backup.2026-01-01T00-00-00.json'
    );
    const backupData = {
      machineId: 'backup-machine',
      version: '0.5.0',
      lastUpdated: '2026-01-01T00:00:00.000Z',
      config: {
        roo: { modes: [], mcpSettings: {}, userSettings: {} },
        hardware: { cpu: 'Backup CPU', ram: '8GB', disks: [] },
        software: { powershell: '5.1', node: '16.0', python: '3.9' },
        system: { os: 'Windows 10', architecture: 'x64' }
      }
    };
    writeFileSync(backupPath, JSON.stringify(backupData, null, 2));

    const result = await roosync_manage_baseline({
      action: 'restore',
      source: backupPath,
      createBackup: false
    });

    expect(result.success).toBe(true);
    expect(result.version).toBe('0.5.0');
  });

  test('should create backup before restore when createBackup is true', async () => {
    const backupPath = join(
      testSharedStatePath,
      '.rollback',
      'sync-config.ref.backup.2026-01-01T00-00-00.json'
    );
    const backupData = {
      machineId: 'backup-machine',
      version: '0.5.0',
      lastUpdated: '2026-01-01T00:00:00.000Z',
      config: { roo: {}, hardware: {}, software: {}, system: {} }
    };
    writeFileSync(backupPath, JSON.stringify(backupData, null, 2));

    const result = await roosync_manage_baseline({
      action: 'restore',
      source: backupPath,
      createBackup: true
    });

    expect(result.success).toBe(true);
    expect(result.backupCreated).toBe(true);
    expect(result.backupPath).toBeDefined();
  });

  test('should throw when backup file does not exist', async () => {
    const nonExistentBackup = join(
      testSharedStatePath,
      '.rollback',
      'sync-config.ref.backup.nonexistent.json'
    );

    await expect(
      roosync_manage_baseline({
        action: 'restore',
        source: nonExistentBackup,
        createBackup: false
      })
    ).rejects.toThrow();
  });
});
