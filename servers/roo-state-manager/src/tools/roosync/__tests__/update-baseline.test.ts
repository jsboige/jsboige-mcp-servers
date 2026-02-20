/**
 * Tests fonctionnels pour roosyncUpdateBaseline
 *
 * Couvre les chemins d'exécution réels :
 * - Mode standard : collecte inventaire + mise à jour baseline
 * - Mode profil : création baseline non-nominative
 * - Backup creation
 * - Dashboard/roadmap updates
 * - Cas d'erreur
 *
 * @module roosync/update-baseline.test
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-update-baseline');

// Mock RooSyncService
vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: vi.fn(() => ({
    getConfig: () => ({
      machineId: 'test-machine',
      sharedPath: testSharedStatePath
    }),
    createNonNominativeBaseline: vi.fn(async (name: string, reason: string, config: any) => ({
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

// Mock InventoryCollector
vi.mock('../../../services/InventoryCollector.js', () => ({
  InventoryCollector: class MockInventoryCollector {
    async collectInventory(machineId: string, _force?: boolean) {
      return {
        machineId,
        config: {
          roo: { modes: ['code-simple'], mcpSettings: {}, userSettings: {} },
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

// Mock BaselineService - lit/écrit depuis le répertoire de test
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

// Import après les mocks
import { roosyncUpdateBaseline } from '../update-baseline.js';

const defaultBaseline = {
  machineId: 'old-machine',
  version: '0.9.0',
  lastUpdated: new Date().toISOString(),
  config: {
    roo: { modes: [], mcpSettings: {}, userSettings: {} },
    hardware: { cpu: 'Old CPU', ram: '8GB', disks: [] },
    software: { powershell: '5.1', node: '18.0', python: '3.10' },
    system: { os: 'Windows 10', architecture: 'x64' }
  }
};

describe('roosyncUpdateBaseline - Standard Mode', () => {
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

  test('should update baseline in standard mode', async () => {
    const result = await roosyncUpdateBaseline({
      machineId: 'new-machine',
      mode: 'standard'
    });

    expect(result.success).toBe(true);
    expect(result.newBaseline.machineId).toBe('new-machine');
  });

  test('should return previous baseline info', async () => {
    const result = await roosyncUpdateBaseline({
      machineId: 'new-machine',
      mode: 'standard'
    });

    expect(result.previousBaseline).toBeDefined();
    expect(result.previousBaseline?.machineId).toBe('old-machine');
    expect(result.previousBaseline?.version).toBe('0.9.0');
  });

  test('should use provided version', async () => {
    const result = await roosyncUpdateBaseline({
      machineId: 'new-machine',
      version: '5.0.0'
    });

    expect(result.success).toBe(true);
    expect(result.newBaseline.version).toBe('5.0.0');
  });

  test('should auto-generate version when not provided', async () => {
    const result = await roosyncUpdateBaseline({
      machineId: 'new-machine'
    });

    // Format attendu: YYYY.MM.DD-HHMM
    expect(result.newBaseline.version).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d{4}$/);
  });

  test('should create backup by default', async () => {
    const result = await roosyncUpdateBaseline({
      machineId: 'new-machine'
    });

    expect(result.backupCreated).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);
  });

  test('should not create backup when createBackup is false', async () => {
    const result = await roosyncUpdateBaseline({
      machineId: 'new-machine',
      createBackup: false
    });

    expect(result.backupCreated).toBe(false);
    expect(result.backupPath).toBeUndefined();
  });

  test('should include updateReason in message', async () => {
    const result = await roosyncUpdateBaseline({
      machineId: 'new-machine',
      updateReason: 'Scheduled maintenance update'
    });

    expect(result.message).toContain('Scheduled maintenance update');
  });

  test('should work without existing baseline (first time)', async () => {
    rmSync(join(testSharedStatePath, 'sync-config.ref.json'), { force: true });

    const result = await roosyncUpdateBaseline({
      machineId: 'first-machine',
      createBackup: false
    });

    expect(result.success).toBe(true);
    expect(result.previousBaseline).toBeUndefined();
    expect(result.backupCreated).toBe(false);
  });
});

describe('roosyncUpdateBaseline - Profile Mode', () => {
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

  test('should create profile baseline', async () => {
    const result = await roosyncUpdateBaseline({
      machineId: 'dev-profile',
      mode: 'profile',
      updateReason: 'Creating dev profile'
    });

    expect(result.success).toBe(true);
    expect(result.newBaseline.machineId).toContain('profile:');
  });

  test('should mark profile as non-nominative', async () => {
    const result = await roosyncUpdateBaseline({
      machineId: 'prod-profile',
      mode: 'profile'
    });

    expect(result.success).toBe(true);
    // Profile id should contain the profile name
    expect(result.newBaseline.machineId).toContain('prod-profile');
  });
});

describe('roosyncUpdateBaseline - Dashboard & Roadmap Updates', () => {
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

  test('should update dashboard when it exists', async () => {
    const dashboard = {
      baselineMachine: 'old-machine',
      baselineVersion: '0.9.0',
      lastBaselineUpdate: '2026-01-01T00:00:00.000Z',
      lastUpdate: '2026-01-01T00:00:00.000Z',
      machines: {
        'old-machine': { isBaseline: true },
        'new-machine': { isBaseline: false }
      }
    };
    writeFileSync(
      join(testSharedStatePath, 'sync-dashboard.json'),
      JSON.stringify(dashboard, null, 2)
    );

    const result = await roosyncUpdateBaseline({
      machineId: 'new-machine',
      createBackup: false
    });

    expect(result.success).toBe(true);
    const updatedDashboard = JSON.parse(
      readFileSync(join(testSharedStatePath, 'sync-dashboard.json'), 'utf-8')
    );
    expect(updatedDashboard.baselineMachine).toBe('new-machine');
    expect(updatedDashboard.machines['new-machine'].isBaseline).toBe(true);
    expect(updatedDashboard.machines['old-machine'].isBaseline).toBe(false);
  });

  test('should update roadmap when it exists', async () => {
    const roadmapContent = '# Sync Roadmap\n\nExisting content.\n\n';
    writeFileSync(
      join(testSharedStatePath, 'sync-roadmap.md'),
      roadmapContent
    );

    const result = await roosyncUpdateBaseline({
      machineId: 'new-machine',
      createBackup: false,
      updateReason: 'Test roadmap update'
    });

    expect(result.success).toBe(true);
    const updatedRoadmap = readFileSync(
      join(testSharedStatePath, 'sync-roadmap.md'),
      'utf-8'
    );
    expect(updatedRoadmap).toContain('Mise à Jour Baseline');
    expect(updatedRoadmap).toContain('new-machine');
  });

  test('should succeed even when dashboard does not exist', async () => {
    const result = await roosyncUpdateBaseline({
      machineId: 'new-machine',
      createBackup: false
    });

    expect(result.success).toBe(true);
  });
});
