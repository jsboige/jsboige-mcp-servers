/**
 * Tests unitaires pour DiffDetector
 *
 * Couvre :
 * - Construction de l'instance
 * - compareBaselineWithMachine : configs identiques, null/undefined, erreurs
 * - Comparaison Roo config (paths, modes, mcpSettings, userSettings)
 * - Comparaison Hardware (CPU cores/threads/model, RAM, disks, GPU)
 * - Comparaison Software (PowerShell, Node.js, Python, legacy inventory)
 * - Comparaison System (OS, architecture, hostname)
 * - compareInventories : structure ComparisonReport, summary, bySeverity/byCategory
 * - compareNestedObjects : missing keys, extra keys, deeply nested diffs
 * - determineSeverity : seuils CPU 30%, RAM 20%, catgories system/config/hardware/software
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DiffDetector } from '../DiffDetector.js';
import type { BaselineConfig, MachineInventory, BaselineDifference } from '../../types/baseline.js';
import type { ComparisonReport } from '../DiffDetector.js';

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}));

// ---- Test Data Factories ----

function createBaselineConfig(overrides?: Partial<BaselineConfig>): BaselineConfig {
  return {
    machineId: 'baseline-machine',
    version: '1.0',
    lastUpdated: '2026-01-01T00:00:00Z',
    config: {
      roo: {
        paths: {
          rooConfig: 'C:/Users/test/.roo',
          mcpSettings: 'C:/Users/test/.roo/mcp-settings.json'
        },
        modes: ['architect', 'code', 'ask'],
        mcpSettings: {
          'server-a': { command: 'node', args: ['server.js'] }
        },
        userSettings: {
          theme: 'dark',
          language: 'en'
        }
      },
      hardware: {
        cpu: {
          model: 'Intel Core i7-12700',
          cores: 12,
          threads: 20
        },
        memory: {
          total: 34359738368 // 32 GB
        },
        disks: [
          { name: 'C:', size: '500GB' },
          { name: 'D:', size: '1TB' }
        ],
        gpu: 'NVIDIA RTX 3080'
      },
      software: {
        powershell: '7.4.0',
        node: '20.11.0',
        python: '3.12.0'
      },
      system: {
        os: 'Windows 11 Pro',
        architecture: 'x64'
      }
    },
    ...overrides
  };
}

function createMachineInventory(overrides?: Partial<MachineInventory>): MachineInventory {
  return {
    machineId: 'target-machine',
    timestamp: '2026-01-02T00:00:00Z',
    config: {
      roo: {
        modes: ['architect', 'code', 'ask'],
        mcpSettings: {
          'server-a': { command: 'node', args: ['server.js'] }
        },
        userSettings: {
          theme: 'dark',
          language: 'en'
        }
      },
      hardware: {
        cpu: {
          model: 'Intel Core i7-12700',
          cores: 12,
          threads: 20
        },
        memory: {
          total: 34359738368
        },
        disks: [
          { name: 'C:', size: '500GB' },
          { name: 'D:', size: '1TB' }
        ],
        gpu: 'NVIDIA RTX 3080'
      },
      software: {
        powershell: '7.4.0',
        node: '20.11.0',
        python: '3.12.0'
      },
      system: {
        os: 'Windows 11 Pro',
        architecture: 'x64'
      }
    },
    metadata: {
      collectionDuration: 1500,
      source: 'local',
      collectorVersion: '2.1.0'
    },
    ...overrides
  };
}

/**
 * Creates a machine inventory with roo.paths matching the baseline.
 * The baseline has paths in config.roo.paths but MachineInventory type
 * does not define paths inside config.roo. We cast to add them.
 */
function createMachineInventoryWithPaths(overrides?: Partial<MachineInventory>): MachineInventory {
  const inv = createMachineInventory(overrides);
  (inv.config.roo as any).paths = {
    rooConfig: 'C:/Users/test/.roo',
    mcpSettings: 'C:/Users/test/.roo/mcp-settings.json'
  };
  return inv;
}

// ---- Tests ----

describe('DiffDetector', () => {
  let detector: DiffDetector;

  beforeEach(() => {
    detector = new DiffDetector();
  });

  // === Construction ===

  describe('constructor', () => {
    it('should create an instance without errors', () => {
      const d = new DiffDetector();
      expect(d).toBeInstanceOf(DiffDetector);
    });
  });

  // === compareBaselineWithMachine - basic ===

  describe('compareBaselineWithMachine - basic', () => {
    it('should return no differences for identical configs', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      expect(diffs).toEqual([]);
    });

    it('should throw when baseline is null', async () => {
      const machine = createMachineInventory();
      await expect(
        detector.compareBaselineWithMachine(null as any, machine)
      ).rejects.toThrow();
    });

    it('should throw when baseline.config is null', async () => {
      const machine = createMachineInventory();
      const baseline = { machineId: 'x', version: '1', lastUpdated: '', config: null } as any;
      await expect(
        detector.compareBaselineWithMachine(baseline, machine)
      ).rejects.toThrow();
    });

    it('should throw when machine.config is null', async () => {
      const baseline = createBaselineConfig();
      const machine = { machineId: 'x', config: null } as any;
      await expect(
        detector.compareBaselineWithMachine(baseline, machine)
      ).rejects.toThrow();
    });
  });

  // === Roo Config Comparison ===

  describe('compareRooConfig', () => {
    it('should detect different rooConfig path as CRITICAL', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      (machine.config.roo as any).paths.rooConfig = 'D:/other/.roo';

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const pathDiff = diffs.find(d => d.path === 'paths.rooConfig');

      expect(pathDiff).toBeDefined();
      expect(pathDiff!.severity).toBe('CRITICAL');
      expect(pathDiff!.category).toBe('config');
      expect(pathDiff!.baselineValue).toBe('C:/Users/test/.roo');
      expect(pathDiff!.actualValue).toBe('D:/other/.roo');
    });

    it('should detect different mcpSettings path as CRITICAL', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      (machine.config.roo as any).paths.mcpSettings = 'D:/other/mcp.json';

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const pathDiff = diffs.find(d => d.path === 'paths.mcpSettings');

      expect(pathDiff).toBeDefined();
      expect(pathDiff!.severity).toBe('CRITICAL');
      expect(pathDiff!.category).toBe('config');
    });

    it('should detect different mode count as IMPORTANT', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      machine.config.roo.modes = ['architect', 'code'];

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const modeDiffs = diffs.filter(d => d.path === 'roo.modes');

      // There should be at least one diff for mode count
      const countDiff = modeDiffs.find(d => d.description.includes('Nombre de modes'));
      expect(countDiff).toBeDefined();
      expect(countDiff!.severity).toBe('IMPORTANT');
      expect(countDiff!.baselineValue).toBe('3 modes');
      expect(countDiff!.actualValue).toBe('2 modes');
    });

    it('should detect different modes content as IMPORTANT', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      machine.config.roo.modes = ['architect', 'debug', 'ask'];

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const contentDiff = diffs.find(
        d => d.path === 'roo.modes' && d.description.includes('Diff')
      );

      expect(contentDiff).toBeDefined();
      expect(contentDiff!.severity).toBe('IMPORTANT');
      expect(contentDiff!.baselineValue).toEqual(['architect', 'code', 'ask']);
      expect(contentDiff!.actualValue).toEqual(['architect', 'debug', 'ask']);
    });

    it('should detect nested mcpSettings differences', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      machine.config.roo.mcpSettings = {
        'server-a': { command: 'python', args: ['server.py'] }
      };

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const mcpDiffs = diffs.filter(d => d.path.startsWith('roo.mcpSettings'));

      expect(mcpDiffs.length).toBeGreaterThan(0);
      // Nested object comparison produces diffs at the leaf level
      const commandDiff = mcpDiffs.find(d => d.path.includes('command'));
      expect(commandDiff).toBeDefined();
      expect(commandDiff!.baselineValue).toBe('node');
      expect(commandDiff!.actualValue).toBe('python');
    });

    it('should detect nested userSettings differences', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      machine.config.roo.userSettings = {
        theme: 'light',
        language: 'en'
      };

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const userDiffs = diffs.filter(d => d.path.startsWith('roo.userSettings'));

      expect(userDiffs.length).toBe(1);
      const themeDiff = userDiffs.find(d => d.path.includes('theme'));
      expect(themeDiff).toBeDefined();
      expect(themeDiff!.baselineValue).toBe('dark');
      expect(themeDiff!.actualValue).toBe('light');
    });

    it('should return no diffs when both roo configs are null', async () => {
      const baseline = createBaselineConfig();
      baseline.config.roo = null as any;
      const machine = createMachineInventory();
      machine.config.roo = null as any;

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      // No roo diffs since both are null (graceful handling)
      const rooDiffs = diffs.filter(d =>
        d.path.startsWith('paths.') || d.path.startsWith('roo.')
      );
      expect(rooDiffs).toHaveLength(0);
    });

    it('should return no roo diffs when baseline roo is undefined', async () => {
      const baseline = createBaselineConfig();
      baseline.config.roo = undefined as any;
      const machine = createMachineInventory();

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const rooDiffs = diffs.filter(d =>
        d.path.startsWith('paths.') || d.path.startsWith('roo.')
      );
      expect(rooDiffs).toHaveLength(0);
    });
  });

  // === Hardware Config Comparison ===

  describe('compareHardwareConfig', () => {
    it('should detect small CPU core difference (<=30%) as WARNING', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      // 12 cores vs 10 cores -> diff = 2, percent = 2/12 = 16.7% <= 30% -> WARNING
      machine.config.hardware.cpu.cores = 10;

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const coreDiff = diffs.find(d => d.path === 'hardware.cpu.cores');

      expect(coreDiff).toBeDefined();
      expect(coreDiff!.severity).toBe('WARNING');
      expect(coreDiff!.category).toBe('hardware');
      expect(coreDiff!.baselineValue).toBe(12);
      expect(coreDiff!.actualValue).toBe(10);
    });

    it('should detect large CPU core difference (>30%) as IMPORTANT', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      // 12 cores vs 4 cores -> diff = 8, percent = 8/12 = 66.7% > 30% -> IMPORTANT
      machine.config.hardware.cpu.cores = 4;

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const coreDiff = diffs.find(d => d.path === 'hardware.cpu.cores');

      expect(coreDiff).toBeDefined();
      expect(coreDiff!.severity).toBe('IMPORTANT');
    });

    it('should detect different thread count', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      machine.config.hardware.cpu.threads = 16;

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const threadDiff = diffs.find(d => d.path === 'hardware.cpu.threads');

      expect(threadDiff).toBeDefined();
      expect(threadDiff!.category).toBe('hardware');
      expect(threadDiff!.baselineValue).toBe(20);
      expect(threadDiff!.actualValue).toBe(16);
    });

    it('should detect different CPU model as INFO', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      machine.config.hardware.cpu.model = 'AMD Ryzen 9 7950X';

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const modelDiff = diffs.find(d => d.path === 'hardware.cpu.model');

      expect(modelDiff).toBeDefined();
      expect(modelDiff!.severity).toBe('INFO');
      expect(modelDiff!.baselineValue).toBe('Intel Core i7-12700');
      expect(modelDiff!.actualValue).toBe('AMD Ryzen 9 7950X');
    });

    it('should detect small RAM difference (<=20%) as WARNING', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      // 32GB vs 28GB -> diff = 4GB, percent = 4/32 = 12.5% <= 20% -> WARNING
      const gb28 = 28 * 1024 ** 3;
      machine.config.hardware.memory.total = gb28;

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const ramDiff = diffs.find(d => d.path === 'hardware.memory.total');

      expect(ramDiff).toBeDefined();
      expect(ramDiff!.severity).toBe('WARNING');
      expect(ramDiff!.category).toBe('hardware');
    });

    it('should detect large RAM difference (>20%) as IMPORTANT', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      // 32GB vs 16GB -> diff = 16GB, percent = 16/32 = 50% > 20% -> IMPORTANT
      const gb16 = 16 * 1024 ** 3;
      machine.config.hardware.memory.total = gb16;

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const ramDiff = diffs.find(d => d.path === 'hardware.memory.total');

      expect(ramDiff).toBeDefined();
      expect(ramDiff!.severity).toBe('IMPORTANT');
      expect(ramDiff!.description).toContain('RAM');
    });

    it('should detect different disk count as WARNING', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      machine.config.hardware.disks = [{ name: 'C:', size: '500GB' }];

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const diskDiff = diffs.find(d => d.path === 'hardware.disks.length');

      expect(diskDiff).toBeDefined();
      expect(diskDiff!.severity).toBe('WARNING');
      expect(diskDiff!.baselineValue).toBe(2);
      expect(diskDiff!.actualValue).toBe(1);
    });

    it('should detect different GPU as INFO', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      machine.config.hardware.gpu = 'AMD Radeon RX 7900';

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const gpuDiff = diffs.find(d => d.path === 'hardware.gpu');

      expect(gpuDiff).toBeDefined();
      expect(gpuDiff!.severity).toBe('INFO');
      expect(gpuDiff!.baselineValue).toBe('NVIDIA RTX 3080');
      expect(gpuDiff!.actualValue).toBe('AMD Radeon RX 7900');
    });

    it('should detect GPU present on machine but absent on baseline', async () => {
      const baseline = createBaselineConfig();
      delete baseline.config.hardware.gpu;
      const machine = createMachineInventoryWithPaths();
      machine.config.hardware.gpu = 'NVIDIA RTX 4090';

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const gpuDiff = diffs.find(d => d.path === 'hardware.gpu');

      expect(gpuDiff).toBeDefined();
      expect(gpuDiff!.description).toContain('absent sur baseline');
    });
  });

  // === Software Config Comparison ===

  describe('compareSoftwareConfig', () => {
    it('should detect different PowerShell version as WARNING', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      machine.config.software.powershell = '5.1.0';

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const pwshDiff = diffs.find(d => d.path === 'software.powershell');

      expect(pwshDiff).toBeDefined();
      expect(pwshDiff!.severity).toBe('WARNING');
      expect(pwshDiff!.baselineValue).toBe('7.4.0');
      expect(pwshDiff!.actualValue).toBe('5.1.0');
    });

    it('should detect different Node.js version as INFO', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      machine.config.software.node = '18.19.0';

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const nodeDiff = diffs.find(d => d.path === 'software.node');

      expect(nodeDiff).toBeDefined();
      expect(nodeDiff!.severity).toBe('INFO');
      expect(nodeDiff!.description).toContain('Node.js');
      expect(nodeDiff!.baselineValue).toBe('20.11.0');
      expect(nodeDiff!.actualValue).toBe('18.19.0');
    });

    it('should detect Node.js absent on target machine as INFO', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      (machine.config.software as any).node = null;

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const nodeDiff = diffs.find(d => d.path === 'software.node');

      expect(nodeDiff).toBeDefined();
      expect(nodeDiff!.severity).toBe('INFO');
      expect(nodeDiff!.description).toContain('absent sur machine cible');
    });

    it('should detect Node.js absent on baseline as INFO', async () => {
      const baseline = createBaselineConfig();
      (baseline.config.software as any).node = null;
      const machine = createMachineInventoryWithPaths();

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const nodeDiff = diffs.find(d => d.path === 'software.node');

      expect(nodeDiff).toBeDefined();
      expect(nodeDiff!.severity).toBe('INFO');
      expect(nodeDiff!.description).toContain('absent sur baseline');
    });

    it('should detect different Python version as INFO', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      machine.config.software.python = '3.11.5';

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const pyDiff = diffs.find(d => d.path === 'software.python');

      expect(pyDiff).toBeDefined();
      expect(pyDiff!.severity).toBe('INFO');
      expect(pyDiff!.baselineValue).toBe('3.12.0');
      expect(pyDiff!.actualValue).toBe('3.11.5');
    });

    it('should detect Python absent on target machine as INFO', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      (machine.config.software as any).python = null;

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const pyDiff = diffs.find(d => d.path === 'software.python');

      expect(pyDiff).toBeDefined();
      expect(pyDiff!.severity).toBe('INFO');
      expect(pyDiff!.description).toContain('Python absent sur machine cible');
    });
  });

  // === System Config Comparison ===

  describe('compareSystemConfig', () => {
    it('should detect different OS as CRITICAL', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      machine.config.system.os = 'Ubuntu 22.04';

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const osDiff = diffs.find(d => d.path === 'system.os');

      expect(osDiff).toBeDefined();
      expect(osDiff!.severity).toBe('CRITICAL');
      expect(osDiff!.category).toBe('system');
      expect(osDiff!.baselineValue).toBe('Windows 11 Pro');
      expect(osDiff!.actualValue).toBe('Ubuntu 22.04');
    });

    it('should detect different architecture as CRITICAL', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      machine.config.system.architecture = 'arm64';

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const archDiff = diffs.find(d => d.path === 'system.architecture');

      expect(archDiff).toBeDefined();
      expect(archDiff!.severity).toBe('CRITICAL');
      expect(archDiff!.category).toBe('system');
      expect(archDiff!.baselineValue).toBe('x64');
      expect(archDiff!.actualValue).toBe('arm64');
    });

    it('should detect different hostname as INFO', async () => {
      const baseline = createBaselineConfig();
      (baseline.config.system as any).hostname = 'host-baseline';
      const machine = createMachineInventoryWithPaths();
      (machine.config.system as any).hostname = 'host-target';

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const hostDiff = diffs.find(d => d.path === 'system.hostname');

      expect(hostDiff).toBeDefined();
      expect(hostDiff!.severity).toBe('INFO');
      expect(hostDiff!.baselineValue).toBe('host-baseline');
      expect(hostDiff!.actualValue).toBe('host-target');
    });
  });

  // === compareInventories ===

  describe('compareInventories', () => {
    it('should produce a ComparisonReport with correct structure', async () => {
      const source = createMachineInventory({ machineId: 'machine-A' });
      const target = createMachineInventory({ machineId: 'machine-B' });
      // Make one diff to verify structure
      target.config.system.os = 'Linux';

      const report: ComparisonReport = await detector.compareInventories(source, target);

      expect(report).toHaveProperty('reportId');
      expect(report.reportId).toMatch(/^comp-/);
      expect(report.sourceMachine).toBe('machine-A');
      expect(report.targetMachine).toBe('machine-B');
      expect(report).toHaveProperty('differences');
      expect(Array.isArray(report.differences)).toBe(true);
      expect(report).toHaveProperty('summary');
      expect(report).toHaveProperty('metadata');
      expect(report.metadata).toHaveProperty('comparisonTimestamp');
      expect(report.metadata).toHaveProperty('executionTime');
      expect(report.metadata.version).toBe('1.0');
    });

    it('should have summary.total matching differences length', async () => {
      const source = createMachineInventory({ machineId: 'source' });
      const target = createMachineInventory({ machineId: 'target' });
      target.config.system.os = 'Linux';
      target.config.software.node = '18.0.0';

      const report = await detector.compareInventories(source, target);

      expect(report.summary.total).toBe(report.differences.length);
    });

    it('should have correct bySeverity counts', async () => {
      const source = createMachineInventory({ machineId: 'source' });
      const target = createMachineInventory({ machineId: 'target' });
      // CRITICAL: different OS
      target.config.system.os = 'Linux';
      // INFO: different CPU model
      target.config.hardware.cpu.model = 'AMD Ryzen';

      const report = await detector.compareInventories(source, target);

      // Manually count expected severities from differences
      const expectedCritical = report.differences.filter(d => d.severity === 'CRITICAL').length;
      const expectedImportant = report.differences.filter(d => d.severity === 'IMPORTANT').length;
      const expectedWarning = report.differences.filter(d => d.severity === 'WARNING').length;
      const expectedInfo = report.differences.filter(d => d.severity === 'INFO').length;

      expect(report.summary.bySeverity.CRITICAL).toBe(expectedCritical);
      expect(report.summary.bySeverity.IMPORTANT).toBe(expectedImportant);
      expect(report.summary.bySeverity.WARNING).toBe(expectedWarning);
      expect(report.summary.bySeverity.INFO).toBe(expectedInfo);
      expect(expectedCritical + expectedImportant + expectedWarning + expectedInfo).toBe(report.summary.total);
    });

    it('should have correct byCategory counts', async () => {
      const source = createMachineInventory({ machineId: 'source' });
      const target = createMachineInventory({ machineId: 'target' });
      target.config.system.os = 'Linux';
      target.config.hardware.cpu.model = 'AMD Ryzen';
      target.config.software.powershell = '5.1';

      const report = await detector.compareInventories(source, target);

      const expectedRooConfig = report.differences.filter(d => d.category === 'roo_config').length;
      const expectedHardware = report.differences.filter(d => d.category === 'hardware').length;
      const expectedSoftware = report.differences.filter(d => d.category === 'software').length;
      const expectedSystem = report.differences.filter(d => d.category === 'system').length;

      expect(report.summary.byCategory.roo_config).toBe(expectedRooConfig);
      expect(report.summary.byCategory.hardware).toBe(expectedHardware);
      expect(report.summary.byCategory.software).toBe(expectedSoftware);
      expect(report.summary.byCategory.system).toBe(expectedSystem);
    });

    it('should map baseline categories to RooSync categories', async () => {
      const source = createMachineInventory({ machineId: 'src' });
      const target = createMachineInventory({ machineId: 'tgt' });
      target.config.system.os = 'Linux';
      target.config.hardware.cpu.model = 'Other';
      target.config.software.node = '14.0.0';

      const report = await detector.compareInventories(source, target);

      // Each difference should have a valid DiffCategory
      const validCategories = ['roo_config', 'hardware', 'software', 'system'];
      for (const diff of report.differences) {
        expect(validCategories).toContain(diff.category);
      }
    });

    it('should return empty differences for identical inventories', async () => {
      const source = createMachineInventory({ machineId: 'A' });
      const target = createMachineInventory({ machineId: 'B' });

      const report = await detector.compareInventories(source, target);

      expect(report.differences).toHaveLength(0);
      expect(report.summary.total).toBe(0);
      expect(report.summary.bySeverity.CRITICAL).toBe(0);
      expect(report.summary.bySeverity.IMPORTANT).toBe(0);
      expect(report.summary.bySeverity.WARNING).toBe(0);
      expect(report.summary.bySeverity.INFO).toBe(0);
    });

    it('should include source and target machine IDs in each difference', async () => {
      const source = createMachineInventory({ machineId: 'src-machine' });
      const target = createMachineInventory({ machineId: 'tgt-machine' });
      target.config.system.os = 'macOS';

      const report = await detector.compareInventories(source, target);

      for (const diff of report.differences) {
        expect(diff.source.machineId).toBe('src-machine');
        expect(diff.target.machineId).toBe('tgt-machine');
      }
    });
  });

  // === Nested Objects Comparison ===

  describe('compareNestedObjects (via mcpSettings/userSettings)', () => {
    it('should detect missing key in machine config', async () => {
      const baseline = createBaselineConfig();
      baseline.config.roo.mcpSettings = {
        'server-a': { command: 'node' },
        'server-b': { command: 'python' }
      };
      const machine = createMachineInventoryWithPaths();
      machine.config.roo.mcpSettings = {
        'server-a': { command: 'node' }
        // server-b missing
      };

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const missingDiff = diffs.find(d => d.path.includes('server-b'));

      expect(missingDiff).toBeDefined();
      // Top-level compareNestedObjects treats missing key as "Valeur differente"
      // with severity IMPORTANT (since one side is object, other is undefined)
      expect(missingDiff!.severity).toBe('IMPORTANT');
      expect(missingDiff!.baselineValue).toEqual({ command: 'python' });
      expect(missingDiff!.actualValue).toBeUndefined();
    });

    it('should detect extra key in machine config', async () => {
      const baseline = createBaselineConfig();
      baseline.config.roo.mcpSettings = {
        'server-a': { command: 'node' }
      };
      const machine = createMachineInventoryWithPaths();
      machine.config.roo.mcpSettings = {
        'server-a': { command: 'node' },
        'server-extra': { command: 'ruby' }
      };

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const extraDiff = diffs.find(d => d.path.includes('server-extra'));

      expect(extraDiff).toBeDefined();
      // Top-level compareNestedObjects treats extra key as "Valeur differente"
      // with severity IMPORTANT (one side undefined, other is object)
      expect(extraDiff!.severity).toBe('IMPORTANT');
      expect(extraDiff!.baselineValue).toBeUndefined();
      expect(extraDiff!.actualValue).toEqual({ command: 'ruby' });
    });

    it('should detect deeply nested value differences as IMPORTANT', async () => {
      const baseline = createBaselineConfig();
      baseline.config.roo.mcpSettings = {
        'server-a': {
          config: {
            nested: {
              deep: { value: 'original' }
            }
          }
        }
      };
      const machine = createMachineInventoryWithPaths();
      machine.config.roo.mcpSettings = {
        'server-a': {
          config: {
            nested: {
              deep: { value: 'changed' }
            }
          }
        }
      };

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const deepDiff = diffs.find(d =>
        d.path.includes('deep') && d.path.includes('value')
      );

      expect(deepDiff).toBeDefined();
      expect(deepDiff!.severity).toBe('IMPORTANT');
      expect(deepDiff!.baselineValue).toBe('original');
      expect(deepDiff!.actualValue).toBe('changed');
    });

    it('should detect recursively missing nested key as WARNING', async () => {
      const baseline = createBaselineConfig();
      baseline.config.roo.mcpSettings = {
        'server-a': { command: 'node', timeout: 30 }
      };
      const machine = createMachineInventoryWithPaths();
      machine.config.roo.mcpSettings = {
        'server-a': { command: 'node' }
        // timeout is missing inside server-a
      };

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const missingDiff = diffs.find(d =>
        d.path.includes('timeout') && d.description.includes('manquante')
      );

      expect(missingDiff).toBeDefined();
      expect(missingDiff!.severity).toBe('WARNING');
      expect(missingDiff!.baselineValue).toBe(30);
      expect(missingDiff!.actualValue).toBeUndefined();
    });

    it('should detect recursively extra nested key as INFO', async () => {
      const baseline = createBaselineConfig();
      baseline.config.roo.mcpSettings = {
        'server-a': { command: 'node' }
      };
      const machine = createMachineInventoryWithPaths();
      machine.config.roo.mcpSettings = {
        'server-a': { command: 'node', extraProp: 'value' }
      };

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const extraDiff = diffs.find(d =>
        d.path.includes('extraProp') && d.description.includes('suppl')
      );

      expect(extraDiff).toBeDefined();
      expect(extraDiff!.severity).toBe('INFO');
      expect(extraDiff!.baselineValue).toBeUndefined();
      expect(extraDiff!.actualValue).toBe('value');
    });

    it('should handle empty objects on both sides without diffs', async () => {
      const baseline = createBaselineConfig();
      baseline.config.roo.mcpSettings = {};
      baseline.config.roo.userSettings = {};
      const machine = createMachineInventoryWithPaths();
      machine.config.roo.mcpSettings = {};
      machine.config.roo.userSettings = {};

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const configDiffs = diffs.filter(d =>
        d.path.startsWith('roo.mcpSettings') || d.path.startsWith('roo.userSettings')
      );

      expect(configDiffs).toHaveLength(0);
    });
  });

  // === determineSeverity (tested indirectly via hardware comparisons) ===

  describe('determineSeverity (via hardware thresholds)', () => {
    it('should return WARNING for CPU cores diff exactly at 30%', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      // 10 cores vs 7 cores -> diff=3, pct = 3/10 = 30% -> not > 30 -> WARNING
      baseline.config.hardware.cpu.cores = 10;
      machine.config.hardware.cpu.cores = 7;

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const coreDiff = diffs.find(d => d.path === 'hardware.cpu.cores');

      expect(coreDiff).toBeDefined();
      expect(coreDiff!.severity).toBe('WARNING');
    });

    it('should return IMPORTANT for CPU cores diff just over 30%', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      // 10 cores vs 6 cores -> diff=4, pct = 4/10 = 40% > 30% -> IMPORTANT
      baseline.config.hardware.cpu.cores = 10;
      machine.config.hardware.cpu.cores = 6;

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const coreDiff = diffs.find(d => d.path === 'hardware.cpu.cores');

      expect(coreDiff).toBeDefined();
      expect(coreDiff!.severity).toBe('IMPORTANT');
    });

    it('should return WARNING for RAM diff exactly at 20%', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      // baseline 100 units, machine 80 units -> diff=20, pct = 20/100 = 20% -> not > 20 -> WARNING
      baseline.config.hardware.memory.total = 100;
      machine.config.hardware.memory.total = 80;

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const ramDiff = diffs.find(d => d.path === 'hardware.memory.total');

      expect(ramDiff).toBeDefined();
      expect(ramDiff!.severity).toBe('WARNING');
    });

    it('should return IMPORTANT for RAM diff just over 20%', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();
      // baseline 100 units, machine 79 units -> diff=21, pct = 21/100 = 21% > 20% -> IMPORTANT
      baseline.config.hardware.memory.total = 100;
      machine.config.hardware.memory.total = 79;

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const ramDiff = diffs.find(d => d.path === 'hardware.memory.total');

      expect(ramDiff).toBeDefined();
      expect(ramDiff!.severity).toBe('IMPORTANT');
    });
  });

  // === Edge cases ===

  describe('edge cases', () => {
    it('should handle missing hardware section gracefully', async () => {
      const baseline = createBaselineConfig();
      baseline.config.hardware = undefined as any;
      const machine = createMachineInventoryWithPaths();
      machine.config.hardware = undefined as any;

      // Should not throw, hardware diffs will just work with safeGet defaults
      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      // With both undefined, safeGet returns default values (0, '', [])
      // which are equal, so no hardware diffs expected
      const hardwareDiffs = diffs.filter(d => d.category === 'hardware');
      expect(hardwareDiffs).toHaveLength(0);
    });

    it('should handle missing software section gracefully', async () => {
      const baseline = createBaselineConfig();
      baseline.config.software = undefined as any;
      const machine = createMachineInventoryWithPaths();
      machine.config.software = undefined as any;

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const softwareDiffs = diffs.filter(d => d.category === 'software');
      expect(softwareDiffs).toHaveLength(0);
    });

    it('should handle missing system section gracefully', async () => {
      const baseline = createBaselineConfig();
      baseline.config.system = undefined as any;
      const machine = createMachineInventoryWithPaths();
      machine.config.system = undefined as any;

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      const systemDiffs = diffs.filter(d => d.category === 'system');
      expect(systemDiffs).toHaveLength(0);
    });

    it('should detect multiple differences across all categories', async () => {
      const baseline = createBaselineConfig();
      const machine = createMachineInventoryWithPaths();

      // Roo: different modes
      machine.config.roo.modes = ['architect'];
      // Hardware: different cores
      machine.config.hardware.cpu.cores = 4;
      // Software: different node
      machine.config.software.node = '18.0.0';
      // System: different OS
      machine.config.system.os = 'Linux';

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);

      // Should have diffs in all categories
      const categories = new Set(diffs.map(d => d.category));
      expect(categories.has('config')).toBe(true);
      expect(categories.has('hardware')).toBe(true);
      expect(categories.has('software')).toBe(true);
      expect(categories.has('system')).toBe(true);
      expect(diffs.length).toBeGreaterThanOrEqual(4);
    });

    it('should handle paths not present on either side without crashing', async () => {
      const baseline = createBaselineConfig();
      // Remove paths from baseline roo
      delete (baseline.config.roo as any).paths;
      const machine = createMachineInventory();
      // Machine roo also has no paths

      const diffs = await detector.compareBaselineWithMachine(baseline, machine);
      // Both sides have undefined paths -> no diff for paths
      const pathDiffs = diffs.filter(d => d.path.startsWith('paths.'));
      expect(pathDiffs).toHaveLength(0);
    });
  });
});
