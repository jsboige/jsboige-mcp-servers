/**
 * BaselineManager — Gap coverage tests
 *
 * Targets untested methods and edge cases:
 * - Machine registry (load, save, validate uniqueness, add, getKnownIds)
 * - listRollbackPoints
 * - cleanupOldRollbacks
 * - validateRollbackPoint
 * - mapMachineToNonNominativeBaseline
 * - compareMachinesNonNominative
 * - getNonNominativeState / getNonNominativeMachineMappings
 * - Edge cases in loadDashboard, getStatus, createRollbackPoint
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaselineManager } from '../../../../src/services/roosync/BaselineManager.js';
import { promises as fs, existsSync, readFileSync } from 'fs';

vi.mock('fs', () => ({
  constants: { R_OK: 4, W_OK: 2, F_OK: 0 },
  promises: {
    access: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    copyFile: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn(),
    rm: vi.fn(),
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('../../../../src/services/BaselineService.js');
vi.mock('../../../../src/services/roosync/ConfigComparator.js');

// Suppress console.warn/error during tests
const originalWarn = console.warn;
const originalError = console.error;
const originalLog = console.log;

beforeEach(() => {
  console.warn = vi.fn();
  console.error = vi.fn();
  console.log = vi.fn();
});
afterEach(() => {
  console.warn = originalWarn;
  console.error = originalError;
  console.log = originalLog;
});

function createManager(overrides: { nonNominative?: any; sharedPath?: string } = {}) {
  const config = {
    machineId: 'test-machine',
    sharedPath: overrides.sharedPath || '/tmp/shared',
  } as any;
  const baselineService = { loadBaseline: vi.fn() };
  const configComparator = { listDiffs: vi.fn() };
  return new BaselineManager(
    config,
    baselineService,
    configComparator,
    overrides.nonNominative
  );
}

// ─── Machine Registry ───────────────────────────────────────────────

describe('BaselineManager — Machine Registry', () => {
  it('loads empty registry when file does not exist', () => {
    (existsSync as any).mockReturnValue(false);
    const mgr = createManager();
    expect(mgr.getKnownMachineIds()).toEqual([]);
  });

  it('loads existing registry from disk', () => {
    (existsSync as any).mockReturnValue(true);
    (readFileSync as any).mockReturnValue(JSON.stringify({
      machines: {
        'machine-a': { machineId: 'machine-a', firstSeen: '2026-01-01', lastSeen: '2026-01-02', source: 'dashboard', status: 'online' },
        'machine-b': { machineId: 'machine-b', firstSeen: '2026-01-01', lastSeen: '2026-01-03', source: 'config', status: 'offline' },
      },
    }));

    const mgr = createManager();
    const ids = mgr.getKnownMachineIds();
    expect(ids).toContain('machine-a');
    expect(ids).toContain('machine-b');
    expect(ids).toHaveLength(2);
  });

  it('handles corrupted registry gracefully (empty result)', () => {
    (existsSync as any).mockReturnValue(true);
    (readFileSync as any).mockReturnValue('invalid json {{{');

    const mgr = createManager();
    expect(mgr.getKnownMachineIds()).toEqual([]);
  });

  it('normalizes keys to lowercase when loading', () => {
    (existsSync as any).mockReturnValue(true);
    (readFileSync as any).mockReturnValue(JSON.stringify({
      machines: {
        'MY-MACHINE': { machineId: 'MY-MACHINE', firstSeen: '2026-01-01', lastSeen: '2026-01-01', source: 'dashboard', status: 'online' },
      },
    }));

    const mgr = createManager();
    const ids = mgr.getKnownMachineIds();
    expect(ids).toContain('my-machine');
  });

  it('saves registry after adding a machine', async () => {
    (existsSync as any).mockReturnValue(false);
    (fs.writeFile as any).mockResolvedValue(undefined);

    const mgr = createManager();

    // Trigger add via loadDashboard with machine not in dashboard
    (existsSync as any).mockImplementation((p: string) => {
      if (p.includes('.machine-registry')) return false;
      if (p.includes('sync-dashboard.json')) return true;
      return false;
    });
    (readFileSync as any).mockImplementation((p: string) => {
      if (p.includes('sync-dashboard.json')) {
        return JSON.stringify({ machines: {} });
      }
      return '{}';
    });
    (fs.writeFile as any).mockResolvedValue(undefined);

    // loadDashboard will add test-machine to registry
    const cacheCallback = vi.fn().mockImplementation((_key: string, fn: () => Promise<any>) => fn());
    await mgr.loadDashboard(cacheCallback);

    // writeFile should have been called for registry save
    expect(fs.writeFile).toHaveBeenCalled();
    const writeCalls = (fs.writeFile as any).mock.calls;
    const registryCall = writeCalls.find((c: any[]) => c[0]?.includes('.machine-registry'));
    expect(registryCall).toBeDefined();
    const savedData = JSON.parse(registryCall[1]);
    expect(savedData.machines).toBeDefined();
    expect(savedData.lastUpdated).toBeDefined();
  });

  it('validates uniqueness: same source is OK (update)', async () => {
    (existsSync as any).mockImplementation((p: string) => {
      if (p.includes('.machine-registry')) return true;
      return false;
    });
    (readFileSync as any).mockImplementation((p: string) => {
      if (p.includes('.machine-registry')) {
        return JSON.stringify({
          machines: {
            'test-machine': { machineId: 'test-machine', firstSeen: '2026-01-01', lastSeen: '2026-01-01', source: 'dashboard', status: 'online' },
          },
        });
      }
      return '{}';
    });
    (fs.writeFile as any).mockResolvedValue(undefined);

    const mgr = createManager();

    // Load dashboard triggers addMachineToRegistry with same source = dashboard
    (readFileSync as any).mockImplementation((p: string) => {
      if (p.includes('.machine-registry')) {
        return JSON.stringify({
          machines: {
            'test-machine': { machineId: 'test-machine', firstSeen: '2026-01-01', lastSeen: '2026-01-01', source: 'dashboard', status: 'online' },
          },
        });
      }
      if (p.includes('sync-dashboard.json')) {
        return JSON.stringify({ machines: { 'test-machine': { lastSync: '2026-01-01', status: 'synced', diffsCount: 0, pendingDecisions: 0 } } });
      }
      return '{}';
    });
    (existsSync as any).mockReturnValue(true);

    const cacheCallback = vi.fn().mockImplementation((_key: string, fn: () => Promise<any>) => fn());
    const dashboard = await mgr.loadDashboard(cacheCallback);

    // Machine already exists in dashboard, should not overwrite
    expect(dashboard.machines['test-machine']).toBeDefined();
  });

  it('detects conflict when same machineId from different source', async () => {
    (existsSync as any).mockImplementation((p: string) => {
      if (p.includes('.machine-registry')) return true;
      if (p.includes('sync-dashboard.json')) return true;
      return false;
    });
    (readFileSync as any).mockImplementation((p: string) => {
      if (p.includes('.machine-registry')) {
        return JSON.stringify({
          machines: {
            'test-machine': { machineId: 'test-machine', firstSeen: '2026-01-01', lastSeen: '2026-01-01', source: 'config', status: 'online' },
          },
        });
      }
      if (p.includes('sync-dashboard.json')) {
        return JSON.stringify({ machines: {} });
      }
      return '{}';
    });
    (fs.writeFile as any).mockResolvedValue(undefined);

    const mgr = createManager();

    const cacheCallback = vi.fn().mockImplementation((_key: string, fn: () => Promise<any>) => fn());
    const dashboard = await mgr.loadDashboard(cacheCallback);

    // Conflict detected — test-machine registered from 'config' but being added from 'dashboard'
    // Should NOT add the machine
    expect(dashboard.machines['test-machine']).toBeUndefined();
  });
});

// ─── listRollbackPoints ─────────────────────────────────────────────

describe('BaselineManager — listRollbackPoints', () => {
  it('returns empty array when rollback dir does not exist', async () => {
    (existsSync as any).mockReturnValue(false);
    const mgr = createManager();
    const points = await mgr.listRollbackPoints();
    expect(points).toEqual([]);
  });

  it('lists rollback points from metadata', async () => {
    (existsSync as any).mockImplementation((p: string) => {
      if (p.includes('.rollback')) return true;
      if (p.includes('metadata.json')) return true;
      return false;
    });
    (fs.readdir as any).mockResolvedValue(['decision-1_2026-01-01T10-00-00', 'decision-2_2026-01-02T12-00-00']);
    (fs.readFile as any).mockImplementation((p: string) => {
      if (p.includes('decision-1')) {
        return Promise.resolve(JSON.stringify({ decisionId: 'decision-1', timestamp: '2026-01-01T10:00:00', machine: 'm1', files: ['f1'] }));
      }
      return Promise.resolve(JSON.stringify({ decisionId: 'decision-2', timestamp: '2026-01-02T12:00:00', machine: 'm2', files: ['f2'] }));
    });

    const mgr = createManager();
    const points = await mgr.listRollbackPoints();
    expect(points).toHaveLength(2);
    expect(points[0].decisionId).toBe('decision-2'); // Most recent first
    expect(points[1].decisionId).toBe('decision-1');
  });

  it('skips entries without metadata.json', async () => {
    (existsSync as any).mockImplementation((p: string) => {
      if (p.includes('.rollback') && !p.includes('metadata')) return true;
      return false;
    });
    (fs.readdir as any).mockResolvedValue(['decision-1_2026-01-01T10-00-00']);

    const mgr = createManager();
    const points = await mgr.listRollbackPoints();
    expect(points).toEqual([]);
  });

  it('handles readdir error gracefully', async () => {
    (existsSync as any).mockReturnValue(true);
    (fs.readdir as any).mockRejectedValue(new Error('Permission denied'));

    const mgr = createManager();
    const points = await mgr.listRollbackPoints();
    expect(points).toEqual([]);
  });
});

// ─── cleanupOldRollbacks ────────────────────────────────────────────

describe('BaselineManager — cleanupOldRollbacks', () => {
  it('returns error when rollback dir does not exist', async () => {
    (existsSync as any).mockReturnValue(false);
    const mgr = createManager();
    const result = await mgr.cleanupOldRollbacks();
    expect(result.errors).toContain('Rollback directory not found');
    expect(result.deleted).toEqual([]);
  });

  it('keeps most recent per decision and deletes older ones', async () => {
    (existsSync as any).mockReturnValue(true);
    (fs.rm as any).mockResolvedValue(undefined);
    (fs.readdir as any).mockResolvedValue([
      'decision-1_2026-01-01T10-00-00',
      'decision-1_2026-01-02T12-00-00',
      'decision-1_2026-01-03T14-00-00',
    ]);

    const mgr = createManager();
    const result = await mgr.cleanupOldRollbacks({ keepPerDecision: 1 });

    expect(result.kept).toHaveLength(1);
    expect(result.deleted).toHaveLength(2);
  });

  it('dry run does not delete files', async () => {
    (existsSync as any).mockReturnValue(true);
    (fs.rm as any).mockResolvedValue(undefined);
    (fs.readdir as any).mockResolvedValue([
      'decision-1_2026-01-01T10-00-00',
      'decision-1_2026-01-02T12-00-00',
    ]);

    const mgr = createManager();
    const result = await mgr.cleanupOldRollbacks({ keepPerDecision: 1, dryRun: true });

    expect(result.deleted).toHaveLength(1);
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it('handles rm error gracefully', async () => {
    (existsSync as any).mockReturnValue(true);
    (fs.rm as any).mockRejectedValue(new Error('Disk error'));
    (fs.readdir as any).mockResolvedValue([
      'decision-1_2026-01-01T10-00-00',
      'decision-1_2026-01-02T12-00-00',
    ]);

    const mgr = createManager();
    const result = await mgr.cleanupOldRollbacks({ keepPerDecision: 1 });

    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ─── validateRollbackPoint ──────────────────────────────────────────

describe('BaselineManager — validateRollbackPoint', () => {
  it('returns invalid when rollback dir does not exist', async () => {
    (existsSync as any).mockReturnValue(false);
    const mgr = createManager();
    const result = await mgr.validateRollbackPoint('decision-1');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Rollback directory not found');
  });

  it('returns invalid when no matching rollback found', async () => {
    (existsSync as any).mockReturnValue(true);
    (fs.readdir as any).mockResolvedValue(['other-decision_2026-01-01']);
    const mgr = createManager();
    const result = await mgr.validateRollbackPoint('decision-1');
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain('No rollback found');
  });

  it('validates rollback with valid files', async () => {
    (existsSync as any).mockImplementation((p: string) => true);
    (fs.readdir as any).mockImplementation((p: string) => {
      if (p.includes('.rollback')) return Promise.resolve(['decision-1_2026-01-01T10-00-00']);
      return Promise.resolve([]);
    });
    (fs.readFile as any).mockImplementation((p: string) => {
      if (p.includes('metadata.json')) {
        return Promise.resolve(JSON.stringify({
          decisionId: 'decision-1',
          timestamp: '2026-01-01',
          machine: 'm1',
          files: ['sync-config.ref.json', 'sync-roadmap.md'],
        }));
      }
      return Promise.resolve(Buffer.from('test content'));
    });
    (fs.stat as any).mockResolvedValue({ size: 100 });

    const mgr = createManager();
    const result = await mgr.validateRollbackPoint('decision-1');
    expect(result.isValid).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(result.checksum).toBeDefined();
  });

  it('detects empty files as invalid', async () => {
    (existsSync as any).mockImplementation((p: string) => true);
    (fs.readdir as any).mockImplementation((p: string) => {
      if (p.includes('.rollback')) return Promise.resolve(['decision-1_2026-01-01T10-00-00']);
      return Promise.resolve([]);
    });
    (fs.readFile as any).mockImplementation((p: string) => {
      if (p.includes('metadata.json')) {
        return Promise.resolve(JSON.stringify({
          decisionId: 'decision-1',
          timestamp: '2026-01-01',
          machine: 'm1',
          files: ['empty-file.txt'],
        }));
      }
      return Promise.resolve(Buffer.from(''));
    });
    (fs.stat as any).mockResolvedValue({ size: 0 });

    const mgr = createManager();
    const result = await mgr.validateRollbackPoint('decision-1');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Empty file: empty-file.txt');
  });

  it('detects missing files in rollback', async () => {
    (existsSync as any).mockImplementation((p: string) => {
      if (p.includes('metadata.json')) return true;
      // The rollback directory and backup subdirectory exist
      if (p.endsWith('.rollback')) return true;
      if (p.includes('.rollback') && p.includes('decision-1') && !p.includes('missing-file')) return true;
      // The actual backup file does NOT exist
      return false;
    });
    (fs.readdir as any).mockImplementation((p: string) => {
      if (p.endsWith('.rollback')) return Promise.resolve(['decision-1_2026-01-01T10-00-00']);
      return Promise.resolve([]);
    });
    (fs.readFile as any).mockImplementation((p: string) => {
      if (p.includes('metadata.json')) {
        return Promise.resolve(JSON.stringify({
          decisionId: 'decision-1',
          timestamp: '2026-01-01',
          machine: 'm1',
          files: ['missing-file.txt'],
        }));
      }
      return Promise.resolve(Buffer.from(''));
    });

    const mgr = createManager();
    const result = await mgr.validateRollbackPoint('decision-1');
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('File not found'))).toBe(true);
  });
});

// ─── createRollbackPoint edge cases ─────────────────────────────────

describe('BaselineManager — createRollbackPoint edge cases', () => {
  it('skips backup for files that do not exist', async () => {
    (existsSync as any).mockImplementation((p: string) => {
      if (p.includes('sync-config.ref.json')) return false;
      if (p.includes('sync-roadmap.md')) return true;
      return false;
    });
    (fs.mkdir as any).mockResolvedValue(undefined);
    (fs.copyFile as any).mockResolvedValue(undefined);
    (fs.writeFile as any).mockResolvedValue(undefined);

    const mgr = createManager();
    await mgr.createRollbackPoint('decision-x');

    // copyFile should be called only for the existing file
    expect(fs.copyFile).toHaveBeenCalledTimes(1);
  });

  it('throws RooSyncServiceError on mkdir failure', async () => {
    (existsSync as any).mockReturnValue(false);
    (fs.mkdir as any).mockRejectedValue(new Error('Disk full'));

    const mgr = createManager();
    await expect(mgr.createRollbackPoint('decision-x')).rejects.toThrow('Échec création rollback point');
  });
});

// ─── loadDashboard edge cases ───────────────────────────────────────

describe('BaselineManager — loadDashboard edge cases', () => {
  it('returns fresh dashboard when existing file is corrupted JSON', async () => {
    (existsSync as any).mockImplementation((p: string) => {
      if (p.includes('.machine-registry')) return false;
      if (p.includes('sync-dashboard.json')) return true;
      return false;
    });
    (readFileSync as any).mockImplementation((p: string) => {
      if (p.includes('sync-dashboard.json')) return '{ broken json';
      return '{}';
    });

    const mgr = createManager();

    // Mock baseline and comparator for calculateDashboardFromBaseline fallback
    (mgr as any).baselineService.loadBaseline.mockResolvedValue({ machineId: 'test-machine' });
    (mgr as any).configComparator.listDiffs.mockResolvedValue({ totalDiffs: 0 });

    const cacheCallback = vi.fn().mockImplementation((_key: string, fn: () => Promise<any>) => fn());
    const dashboard = await mgr.loadDashboard(cacheCallback);

    expect(dashboard).toBeDefined();
    expect(dashboard.machines).toBeDefined();
  });

  it('adds machines property to dashboard when missing', async () => {
    (existsSync as any).mockImplementation((p: string) => {
      if (p.includes('.machine-registry')) return false;
      if (p.includes('sync-dashboard.json')) return true;
      return false;
    });
    (readFileSync as any).mockImplementation((p: string) => {
      if (p.includes('sync-dashboard.json')) return JSON.stringify({ version: '2.1.0' });
      return '{}';
    });
    (fs.writeFile as any).mockResolvedValue(undefined);

    const mgr = createManager();
    const cacheCallback = vi.fn().mockImplementation((_key: string, fn: () => Promise<any>) => fn());
    const dashboard = await mgr.loadDashboard(cacheCallback);

    expect(dashboard.machines).toBeDefined();
    expect(dashboard.machines['test-machine']).toBeDefined();
  });
});

// ─── getStatus edge cases ───────────────────────────────────────────

describe('BaselineManager — getStatus edge cases', () => {
  it('throws on null dashboard', async () => {
    const mgr = createManager();
    await expect(mgr.getStatus(vi.fn().mockResolvedValue(null))).rejects.toThrow('Dashboard invalide');
  });

  it('throws on dashboard without machines property', async () => {
    const mgr = createManager();
    await expect(mgr.getStatus(vi.fn().mockResolvedValue({ version: '2.1.0' }))).rejects.toThrow('Dashboard invalide');
  });
});

// ─── Non-nominative baseline additional methods ─────────────────────

describe('BaselineManager — Non-nominative additional methods', () => {
  let mgr: BaselineManager;
  let mockNN: any;

  beforeEach(() => {
    mockNN = {
      createBaseline: vi.fn(),
      getActiveBaseline: vi.fn(),
      saveState: vi.fn(),
      compareMachines: vi.fn(),
      generateMachineHash: vi.fn(),
      getState: vi.fn(),
    };
    mgr = createManager({ nonNominative: mockNN });
  });

  describe('mapMachineToNonNominativeBaseline', () => {
    it('maps a machine to the active baseline', async () => {
      mockNN.getActiveBaseline.mockResolvedValue({
        baselineId: 'bl-1',
        profiles: [{ profileId: 'p1' }, { profileId: 'p2' }],
      });
      mockNN.generateMachineHash.mockReturnValue('hash-abc');

      const result = await mgr.mapMachineToNonNominativeBaseline('machine-x');
      expect(result.machineId).toBe('machine-x');
      expect(result.machineHash).toBe('hash-abc');
      expect(result.baselineId).toBe('bl-1');
      expect(result.profileIds).toEqual(['p1', 'p2']);
    });

    it('throws when no active baseline', async () => {
      mockNN.getActiveBaseline.mockResolvedValue(null);
      await expect(mgr.mapMachineToNonNominativeBaseline('machine-x')).rejects.toThrow('Aucune baseline non-nominative active');
    });

    it('throws when non-nominative service unavailable', async () => {
      const mgrNoNN = createManager();
      await expect(mgrNoNN.mapMachineToNonNominativeBaseline('machine-x')).rejects.toThrow('NonNominativeBaselineService non disponible');
    });
  });

  describe('compareMachinesNonNominative', () => {
    it('delegates to nonNominativeService.compareMachines', async () => {
      mockNN.compareMachines.mockResolvedValue({ matches: true, diffs: [] });
      const result = await mgr.compareMachinesNonNominative(['m1', 'm2']);
      expect(mockNN.compareMachines).toHaveBeenCalledWith(['m1', 'm2']);
      expect(result.matches).toBe(true);
    });

    it('throws when non-nominative service unavailable', async () => {
      const mgrNoNN = createManager();
      await expect(mgrNoNN.compareMachinesNonNominative(['m1'])).rejects.toThrow('NonNominativeBaselineService non disponible');
    });
  });

  describe('getNonNominativeState', () => {
    it('returns state from service', () => {
      mockNN.getState.mockReturnValue({ available: true, mappings: [{ id: 1 }] });
      const state = mgr.getNonNominativeState();
      expect(state.available).toBe(true);
    });

    it('returns error object when service unavailable', () => {
      const mgrNoNN = createManager();
      const state = mgrNoNN.getNonNominativeState();
      expect(state.available).toBe(false);
      expect(state.error).toBeDefined();
    });
  });

  describe('getNonNominativeMachineMappings', () => {
    it('returns mappings from state', () => {
      mockNN.getState.mockReturnValue({ mappings: [{ machineId: 'm1' }, { machineId: 'm2' }] });
      const mappings = mgr.getNonNominativeMachineMappings();
      expect(mappings).toHaveLength(2);
    });

    it('returns empty array when service unavailable', () => {
      const mgrNoNN = createManager();
      expect(mgrNoNN.getNonNominativeMachineMappings()).toEqual([]);
    });

    it('returns empty array when state has no mappings', () => {
      mockNN.getState.mockReturnValue({});
      expect(mgr.getNonNominativeMachineMappings()).toEqual([]);
    });
  });
});

// ─── restoreFromRollbackPoint additional edge cases ─────────────────

describe('BaselineManager — restoreFromRollbackPoint additional cases', () => {
  it('handles unreadable source file (access denied)', async () => {
    (existsSync as any).mockReturnValue(true);
    (fs.readdir as any).mockResolvedValue(['decision-1_2026-01-01T10-00-00']);
    (fs.readFile as any).mockResolvedValue(JSON.stringify({ files: ['file1'] }));
    // File exists but access check fails
    (fs.access as any).mockRejectedValue(new Error('EACCES'));
    (fs.stat as any).mockResolvedValue({ size: 100 });

    const mgr = createManager();
    const result = await mgr.restoreFromRollbackPoint('decision-1', vi.fn());

    expect(result.success).toBe(false);
  });

  it('handles rollback directory not existing', async () => {
    (existsSync as any).mockReturnValue(false);
    const mgr = createManager();
    const result = await mgr.restoreFromRollbackPoint('decision-1', vi.fn());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No rollback directory found');
  });

  it('handles clearCacheCallback throwing', async () => {
    (existsSync as any).mockReturnValue(true);
    (fs.readdir as any).mockResolvedValue(['decision-1_2026-01-01T10-00-00']);
    (fs.readFile as any).mockResolvedValue(JSON.stringify({ files: ['file1'] }));
    (fs.copyFile as any).mockResolvedValue(undefined);
    (fs.access as any).mockResolvedValue(undefined);
    (fs.stat as any).mockResolvedValue({ size: 100 });
    (fs.unlink as any).mockResolvedValue(undefined);

    const badCallback = vi.fn().mockImplementation(() => { throw new Error('Cache explosion'); });

    const mgr = createManager();
    const result = await mgr.restoreFromRollbackPoint('decision-1', badCallback);

    // Should still succeed — cache error is logged but non-fatal
    expect(result.success).toBe(true);
    expect(result.logs.some((l: string) => l.includes('Erreur invalidation cache'))).toBe(true);
  });

  it('handles metadata read failure gracefully', async () => {
    (existsSync as any).mockReturnValue(true);
    (fs.readdir as any).mockResolvedValue(['decision-1_2026-01-01T10-00-00']);
    (fs.readFile as any).mockImplementation((p: string) => {
      if (p.includes('metadata.json')) return Promise.resolve('not valid json');
      return Promise.resolve(JSON.stringify({ files: ['file1'] }));
    });
    (fs.copyFile as any).mockResolvedValue(undefined);
    (fs.access as any).mockResolvedValue(undefined);
    (fs.stat as any).mockResolvedValue({ size: 100 });
    (fs.unlink as any).mockResolvedValue(undefined);

    const mgr = createManager();
    const result = await mgr.restoreFromRollbackPoint('decision-1', vi.fn());

    // Should use default files and still attempt restore
    expect(result.logs.some((l: string) => l.includes('Erreur lecture metadata'))).toBe(true);
  });

  it('handles critical error in outer try-catch', async () => {
    (existsSync as any).mockImplementation(() => { throw new Error('Unexpected'); });

    const mgr = createManager();
    const result = await mgr.restoreFromRollbackPoint('decision-1', vi.fn());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unexpected');
  });
});
