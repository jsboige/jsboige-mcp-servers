/**
 * Tests fonctionnels pour roosync_export_baseline
 *
 * Couvre les chemins d'exécution réels de la fonction d'export :
 * - Export JSON, YAML, CSV
 * - Gestion d'absence de baseline
 * - Options includeMetadata, includeHistory, prettyPrint
 *
 * @module roosync/export-baseline.test
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-export-baseline');

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
import { roosync_export_baseline } from '../export-baseline.js';

const mockBaseline = {
  machineId: 'test-machine',
  version: '1.0.0',
  lastUpdated: '2026-01-01T00:00:00.000Z',
  config: {
    roo: { modes: ['code-simple'], mcpSettings: {}, userSettings: {} },
    hardware: { cpu: 'Test CPU', ram: '16GB', disks: [] },
    software: { powershell: '7.0', node: '20.0', python: '3.12' },
    system: { os: 'Windows 11', architecture: 'x64' }
  }
};

describe('roosync_export_baseline - Functional', () => {
  beforeEach(() => {
    const dirs = [
      testSharedStatePath,
      join(testSharedStatePath, 'exports')
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    writeFileSync(
      join(testSharedStatePath, 'sync-config.ref.json'),
      JSON.stringify(mockBaseline, null, 2)
    );
  });

  afterEach(() => {
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  test('should export to JSON format', async () => {
    const result = await roosync_export_baseline({
      format: 'json',
      outputPath: join(testSharedStatePath, 'exports', 'test.json'),
      includeMetadata: true,
      prettyPrint: true,
      includeHistory: false
    });

    expect(result.success).toBe(true);
    expect(result.format).toBe('json');
    expect(result.machineId).toBe('test-machine');
    expect(result.version).toBe('1.0.0');
    expect(result.size).toBeGreaterThan(0);
    expect(existsSync(result.outputPath)).toBe(true);
  });

  test('should export to YAML format', async () => {
    const result = await roosync_export_baseline({
      format: 'yaml',
      outputPath: join(testSharedStatePath, 'exports', 'test.yaml'),
      includeMetadata: true,
      prettyPrint: true,
      includeHistory: false
    });

    expect(result.success).toBe(true);
    expect(result.format).toBe('yaml');
    expect(result.size).toBeGreaterThan(0);
    expect(existsSync(result.outputPath)).toBe(true);
  });

  test('should export to CSV format', async () => {
    const result = await roosync_export_baseline({
      format: 'csv',
      outputPath: join(testSharedStatePath, 'exports', 'test.csv'),
      includeMetadata: true,
      prettyPrint: true,
      includeHistory: false
    });

    expect(result.success).toBe(true);
    expect(result.format).toBe('csv');
    expect(result.size).toBeGreaterThan(0);

    const content = readFileSync(result.outputPath, 'utf-8');
    expect(content).toContain('Type,Clé,Valeur,Description');
  });

  test('should throw when no baseline exists', async () => {
    rmSync(join(testSharedStatePath, 'sync-config.ref.json'), { force: true });

    await expect(
      roosync_export_baseline({
        format: 'json',
        outputPath: join(testSharedStatePath, 'exports', 'nope.json'),
        includeMetadata: true,
        prettyPrint: true,
        includeHistory: false
      })
    ).rejects.toThrow('Baseline non trouvée');
  });

  test('should include metadata by default', async () => {
    const result = await roosync_export_baseline({
      format: 'json',
      outputPath: join(testSharedStatePath, 'exports', 'meta.json'),
      includeMetadata: true,
      prettyPrint: true,
      includeHistory: false
    });

    expect(result.includeMetadata).toBe(true);
    const content = JSON.parse(readFileSync(result.outputPath, 'utf-8'));
    expect(content.metadata).toBeDefined();
    expect(content.metadata.machineId).toBe('test-machine');
  });

  test('should exclude metadata when includeMetadata is false', async () => {
    const result = await roosync_export_baseline({
      format: 'json',
      includeMetadata: false,
      outputPath: join(testSharedStatePath, 'exports', 'nometa.json'),
      prettyPrint: true,
      includeHistory: false
    });

    expect(result.includeMetadata).toBe(false);
    const content = JSON.parse(readFileSync(result.outputPath, 'utf-8'));
    expect(content.metadata).toBeUndefined();
  });

  test('should include history when includeHistory is true', async () => {
    const result = await roosync_export_baseline({
      format: 'json',
      includeHistory: true,
      outputPath: join(testSharedStatePath, 'exports', 'history.json'),
      includeMetadata: true,
      prettyPrint: true
    });

    expect(result.includeHistory).toBe(true);
    const content = JSON.parse(readFileSync(result.outputPath, 'utf-8'));
    expect(content.history).toBeDefined();
    expect(Array.isArray(content.history)).toBe(true);
  });

  test('should produce compact JSON when prettyPrint is false', async () => {
    const result = await roosync_export_baseline({
      format: 'json',
      prettyPrint: false,
      outputPath: join(testSharedStatePath, 'exports', 'compact.json'),
      includeMetadata: true,
      includeHistory: false
    });

    expect(result.success).toBe(true);
    const raw = readFileSync(result.outputPath, 'utf-8');
    // Compact JSON has no indentation
    expect(raw).not.toContain('  "');
  });

  test('should include statistics in export', async () => {
    const result = await roosync_export_baseline({
      format: 'json',
      outputPath: join(testSharedStatePath, 'exports', 'stats.json'),
      includeMetadata: true,
      prettyPrint: true,
      includeHistory: false
    });

    const content = JSON.parse(readFileSync(result.outputPath, 'utf-8'));
    expect(content.statistics).toBeDefined();
    expect(content.statistics.totalParameters).toBeGreaterThanOrEqual(0);
  });

  test('CSV export should contain metadata rows', async () => {
    const result = await roosync_export_baseline({
      format: 'csv',
      includeMetadata: true,
      outputPath: join(testSharedStatePath, 'exports', 'with-meta.csv'),
      prettyPrint: true,
      includeHistory: false
    });

    const content = readFileSync(result.outputPath, 'utf-8');
    expect(content).toContain('Metadata');
    expect(content).toContain('machineId');
  });

  test('CSV export with special characters in machineId', async () => {
    const specialBaseline = {
      ...mockBaseline,
      machineId: 'test-"quotes"-machine',
      config: { description: 'Test with "quotes" and, commas' }
    };
    writeFileSync(
      join(testSharedStatePath, 'sync-config.ref.json'),
      JSON.stringify(specialBaseline, null, 2)
    );

    const result = await roosync_export_baseline({
      format: 'csv',
      outputPath: join(testSharedStatePath, 'exports', 'special.csv'),
      includeMetadata: true,
      prettyPrint: true,
      includeHistory: false
    });

    expect(result.success).toBe(true);
    const content = readFileSync(result.outputPath, 'utf-8');
    expect(content).toContain('""');
  });

  test('should return correct machineId and version', async () => {
    const result = await roosync_export_baseline({
      format: 'json',
      outputPath: join(testSharedStatePath, 'exports', 'check.json'),
      includeMetadata: true,
      prettyPrint: true,
      includeHistory: false
    });

    expect(result.machineId).toBe('test-machine');
    expect(result.version).toBe('1.0.0');
  });
});
