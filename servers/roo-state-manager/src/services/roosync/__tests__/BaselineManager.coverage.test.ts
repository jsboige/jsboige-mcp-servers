/**
 * Coverage complement for BaselineManager.ts (#833 Sprint C3).
 *
 * The base suite (BaselineManager.test.ts) exercises the rollback API against a
 * real, empty `/tmp` path, so it only ever reaches the "no rollback directory"
 * fail-fast paths plus the RollbackRestoreResult interface shape. This file mocks
 * `fs` (promises + existsSync + constants) to drive the cold branches the base
 * suite never touches:
 *   - the machine-registry subsystem (validate/add/load/save, #1409 identity conflict)
 *   - getStatus invalid/not-found/success contracts
 *   - the non-nominative service guards + a real migration transform
 *   - createRollbackPoint success + failure wrapping
 *   - restoreFromRollbackPoint deep paths (restore, integrity rollback, no-match)
 *   - list/validate rollback with populated backups + calculateChecksum
 *
 * Every assertion cites the BaselineManager.ts line(s) it locks in.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted fs mock — BaselineManager imports `{ promises as fs, existsSync, constants }`.
const mockFs = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  copyFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  access: vi.fn(),
  unlink: vi.fn(),
  rm: vi.fn(),
}));
const mockExistsSync = vi.hoisted(() => vi.fn());

vi.mock('fs', () => ({
  promises: mockFs,
  existsSync: mockExistsSync,
  constants: { R_OK: 4 },
}));

import { BaselineManager } from '../BaselineManager.js';
import { RooSyncServiceError } from '../../../types/errors.js';

/**
 * Build a BaselineManager over the fs mock and wait for the fire-and-forget
 * registry load (constructor, BaselineManager.ts:89) to settle so tests are
 * deterministic. `nonNominativeService` is passed through verbatim (including
 * an explicit `undefined`) to exercise the service-guard branches.
 */
async function makeManager(overrides: {
  config?: any;
  baselineService?: any;
  configComparator?: any;
  nonNominativeService?: any;
} = {}): Promise<BaselineManager> {
  const config = { machineId: 'test-machine', sharedPath: '/shared', ...(overrides.config ?? {}) };
  const baselineService = overrides.baselineService ?? { loadBaseline: vi.fn() };
  const configComparator = overrides.configComparator ?? { listDiffs: vi.fn() };
  const nonNominativeService = 'nonNominativeService' in overrides
    ? overrides.nonNominativeService
    : { getActiveBaseline: vi.fn(), createBaseline: vi.fn(), saveState: vi.fn(), generateMachineHash: vi.fn(), compareMachines: vi.fn() };
  const mgr = new BaselineManager(config, baselineService, configComparator, nonNominativeService);
  await mgr.waitForRegistry();
  return mgr;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: nothing on disk; registry load is a no-op (existsSync false).
  mockExistsSync.mockReturnValue(false);
  mockFs.readFile.mockResolvedValue('{}');
  mockFs.writeFile.mockResolvedValue(undefined);
  mockFs.mkdir.mockResolvedValue(undefined);
  mockFs.copyFile.mockResolvedValue(undefined);
  mockFs.readdir.mockResolvedValue([]);
  mockFs.stat.mockResolvedValue({ size: 1 } as any);
  mockFs.access.mockResolvedValue(undefined);
  mockFs.unlink.mockResolvedValue(undefined);
  mockFs.rm.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('BaselineManager — machine registry (identity #1409)', () => {
  it('registers a brand-new machine (lowercased) and persists the registry', async () => {
    const mgr = await makeManager();
    const res = await (mgr as any).addMachineToRegistry('MyMachine', 'dashboard');

    // New-machine branch (BaselineManager.ts:210-220): valid, non-conflict, key lowercased (L193).
    expect(res.isValid).toBe(true);
    expect(res.conflictDetected).toBe(false);
    expect(mgr.getKnownMachineIds()).toContain('mymachine');
    // saveMachineRegistry persists to registryPath (BaselineManager.ts:137-141).
    expect(mockFs.writeFile).toHaveBeenCalled();
  });

  it('treats a same-source re-add as a normal update, not a conflict', async () => {
    const mgr = await makeManager();
    await (mgr as any).addMachineToRegistry('m1', 'dashboard');
    const res = await (mgr as any).addMachineToRegistry('m1', 'dashboard');

    // Same-source short-circuit (BaselineManager.ts:164-169) then update-existing (L205-209).
    expect(res.isValid).toBe(true);
    expect(res.conflictDetected).toBe(false);
    expect(mgr.getKnownMachineIds().filter((id) => id === 'm1')).toHaveLength(1);
  });

  it('refuses a machineId already owned by a different source (identity conflict)', async () => {
    const mgr = await makeManager();
    await (mgr as any).addMachineToRegistry('shared-id', 'baseline');
    const res = await (mgr as any).addMachineToRegistry('shared-id', 'dashboard');

    // Conflict branch (BaselineManager.ts:171-182) → refusal early-return (L196-200).
    expect(res.isValid).toBe(false);
    expect(res.conflictDetected).toBe(true);
    expect(res.conflictingMachineId).toBe('shared-id');
    expect(res.conflictSource).toBe('baseline');
    expect(res.warningMessage).toContain('CONFLIT');
    // The original owner is preserved (machine not overwritten).
    expect((mgr as any).getMachineFromRegistry('shared-id').source).toBe('baseline');
  });

  it('loads an existing registry file and normalizes keys to lowercase', async () => {
    mockExistsSync.mockReturnValue(true);
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({
        machines: {
          'PO-2026': { machineId: 'PO-2026', firstSeen: 't', lastSeen: 't', source: 'config', status: 'online' },
        },
      }),
    );
    const mgr = await makeManager();

    // Reconstruction normalizes keys to lowercase (BaselineManager.ts:112-116).
    expect(mgr.getKnownMachineIds()).toContain('po-2026');
  });

  it('falls back to an empty registry when the registry file is corrupt', async () => {
    mockExistsSync.mockReturnValue(true);
    mockFs.readFile.mockResolvedValue('{ not valid json');
    const mgr = await makeManager();

    // JSON.parse throws → catch resets to an empty Map (BaselineManager.ts:120-124).
    expect(mgr.getKnownMachineIds()).toEqual([]);
  });
});

describe('BaselineManager.getStatus', () => {
  it('throws INVALID_DASHBOARD when the loader yields no machines map', async () => {
    const mgr = await makeManager();
    // Guard at BaselineManager.ts:448-453.
    await expect(mgr.getStatus(async () => ({} as any))).rejects.toMatchObject({ code: 'INVALID_DASHBOARD' });
  });

  it('throws MACHINE_NOT_FOUND when the dashboard omits the current machine', async () => {
    const mgr = await makeManager({ config: { machineId: 'absent', sharedPath: '/shared' } });
    const dashboard = {
      overallStatus: 'synced',
      machines: { other: { lastSync: 't', status: 'synced', diffsCount: 0, pendingDecisions: 0 } },
    };
    // Guard at BaselineManager.ts:457-462.
    await expect(mgr.getStatus(async () => dashboard as any)).rejects.toMatchObject({ code: 'MACHINE_NOT_FOUND' });
  });

  it('returns the current machine status fields from the dashboard', async () => {
    const mgr = await makeManager({ config: { machineId: 'test-machine', sharedPath: '/shared' } });
    const dashboard = {
      overallStatus: 'diverged',
      machines: { 'test-machine': { lastSync: '2026-01-01', status: 'diverged', diffsCount: 3, pendingDecisions: 2 } },
    };
    const res = await mgr.getStatus(async () => dashboard as any);

    // Success mapping (BaselineManager.ts:464-470).
    expect(res).toEqual({
      machineId: 'test-machine',
      overallStatus: 'diverged',
      lastSync: '2026-01-01',
      pendingDecisions: 2,
      diffsCount: 3,
    });
  });
});

describe('BaselineManager — non-nominative service guards', () => {
  it('migrateToNonNominative throws SERVICE_NOT_AVAILABLE without a service', async () => {
    const mgr = await makeManager({ nonNominativeService: undefined });
    // Guard at BaselineManager.ts:480-485.
    await expect(mgr.migrateToNonNominative()).rejects.toMatchObject({ code: 'SERVICE_NOT_AVAILABLE' });
  });

  it('migrateToNonNominative throws BASELINE_NOT_FOUND when no current baseline exists', async () => {
    const baselineService = { loadBaseline: vi.fn().mockResolvedValue(null) };
    const nonNominativeService = { createBaseline: vi.fn(), saveState: vi.fn() };
    const mgr = await makeManager({ baselineService, nonNominativeService });
    // Guard at BaselineManager.ts:490-495.
    await expect(mgr.migrateToNonNominative()).rejects.toMatchObject({ code: 'BASELINE_NOT_FOUND' });
  });

  it('migrateToNonNominative transforms every config section into profiles', async () => {
    const currentBaseline = {
      machineId: 'src-machine',
      config: {
        roo: { modes: ['a'], mcpSettings: { x: 1 } },
        hardware: { cpu: { cores: 8 }, memory: { total: 16 }, disks: [] },
        software: { powershell: '7.4', node: '20', python: '3.11' },
        system: { os: 'Windows', architecture: 'x64' },
      },
    };
    const nonNominativeService = {
      createBaseline: vi.fn().mockResolvedValue({ baselineId: 'new-bl-1' }),
      saveState: vi.fn().mockResolvedValue(undefined),
    };
    const baselineService = { loadBaseline: vi.fn().mockResolvedValue(currentBaseline) };
    const mgr = await makeManager({ baselineService, nonNominativeService });

    const res = await mgr.migrateToNonNominative();

    // roo(1) + hardware(3) + software(3) + system(2) = 9 profiles (BaselineManager.ts:557-586).
    expect(res.success).toBe(true);
    expect(res.oldBaseline).toBe('src-machine');
    expect(res.newBaseline).toBe('new-bl-1');
    expect(res.profilesCount).toBe(9);
    const profiles = nonNominativeService.createBaseline.mock.calls[0][2];
    expect(profiles).toHaveLength(9);
    expect(profiles.map((p: any) => p.category)).toEqual(
      expect.arrayContaining(['roo-core', 'hardware-cpu', 'software-powershell', 'system-os']),
    );
    // New baseline is persisted as active state (BaselineManager.ts:508).
    expect(nonNominativeService.saveState).toHaveBeenCalled();
  });

  it('migrateToNonNominative yields zero profiles when config sections are absent', async () => {
    const baselineService = { loadBaseline: vi.fn().mockResolvedValue({ machineId: 'bare', config: {} }) };
    const nonNominativeService = {
      createBaseline: vi.fn().mockResolvedValue({ baselineId: 'bl' }),
      saveState: vi.fn().mockResolvedValue(undefined),
    };
    const mgr = await makeManager({ baselineService, nonNominativeService });

    const res = await mgr.migrateToNonNominative();

    // All four guards falsy → every group skipped (BaselineManager.ts:590).
    expect(res.profilesCount).toBe(0);
  });

  it('compareWithNonNominativeBaseline throws SERVICE_NOT_AVAILABLE without a service', async () => {
    const mgr = await makeManager({ nonNominativeService: undefined });
    // Guard at BaselineManager.ts:525-530.
    await expect(mgr.compareWithNonNominativeBaseline('m')).rejects.toMatchObject({ code: 'SERVICE_NOT_AVAILABLE' });
  });

  it('compareWithNonNominativeBaseline throws BASELINE_NOT_FOUND without an active baseline', async () => {
    const nonNominativeService = { getActiveBaseline: vi.fn().mockResolvedValue(null), compareMachines: vi.fn(), generateMachineHash: vi.fn() };
    const mgr = await makeManager({ nonNominativeService });
    // Guard at BaselineManager.ts:533-538.
    await expect(mgr.compareWithNonNominativeBaseline('m')).rejects.toMatchObject({ code: 'BASELINE_NOT_FOUND' });
  });

  it('compareWithNonNominativeBaseline hashes the machine and delegates to compareMachines', async () => {
    const nonNominativeService = {
      getActiveBaseline: vi.fn().mockResolvedValue({ baselineId: 'bl' }),
      generateMachineHash: vi.fn().mockReturnValue('hash-x'),
      compareMachines: vi.fn().mockResolvedValue({ diffs: [] }),
    };
    const mgr = await makeManager({ nonNominativeService });

    const res = await mgr.compareWithNonNominativeBaseline('machine-y');

    // Hash then single-element compare (BaselineManager.ts:541-543).
    expect(nonNominativeService.generateMachineHash).toHaveBeenCalledWith('machine-y');
    expect(nonNominativeService.compareMachines).toHaveBeenCalledWith(['hash-x']);
    expect(res).toEqual({ diffs: [] });
  });

  it('mapMachineToNonNominativeBaseline maps a machine to the active baseline profiles', async () => {
    const nonNominativeService = {
      getActiveBaseline: vi.fn().mockResolvedValue({ baselineId: 'bl-9', profiles: [{ profileId: 'p1' }, { profileId: 'p2' }] }),
      generateMachineHash: vi.fn().mockReturnValue('mh'),
    };
    const mgr = await makeManager({ nonNominativeService });

    const res = await mgr.mapMachineToNonNominativeBaseline('m-z');

    // Success mapping (BaselineManager.ts:891-899).
    expect(res.machineId).toBe('m-z');
    expect(res.machineHash).toBe('mh');
    expect(res.baselineId).toBe('bl-9');
    expect(res.profileIds).toEqual(['p1', 'p2']);
  });

  it('mapMachineToNonNominativeBaseline defaults baselineId/profileIds when absent', async () => {
    const nonNominativeService = {
      getActiveBaseline: vi.fn().mockResolvedValue({}),
      generateMachineHash: vi.fn().mockReturnValue('mh'),
    };
    const mgr = await makeManager({ nonNominativeService });

    const res = await mgr.mapMachineToNonNominativeBaseline('m');

    // Fallbacks 'unknown' / [] (BaselineManager.ts:896-897).
    expect(res.baselineId).toBe('unknown');
    expect(res.profileIds).toEqual([]);
  });
});

describe('BaselineManager.createRollbackPoint', () => {
  it('backs up existing critical files and writes metadata', async () => {
    mockExistsSync.mockReturnValue(true); // source files exist → copyFile taken
    const mgr = await makeManager();

    await mgr.createRollbackPoint('dec-ok');

    // Both critical files copied (BaselineManager.ts:620-632).
    expect(mockFs.copyFile).toHaveBeenCalledTimes(2);
    // Metadata written with the decisionId (BaselineManager.ts:642-646).
    const metaCall = mockFs.writeFile.mock.calls.find((c) => String(c[0]).endsWith('metadata.json'));
    expect(metaCall).toBeDefined();
    expect(JSON.parse(metaCall![1] as string).decisionId).toBe('dec-ok');
  });

  it('wraps a filesystem failure in ROLLBACK_CREATION_FAILED', async () => {
    mockFs.mkdir.mockRejectedValue(new Error('EACCES'));
    const mgr = await makeManager();

    // catch → RooSyncServiceError (BaselineManager.ts:647-652).
    await expect(mgr.createRollbackPoint('dec-err')).rejects.toBeInstanceOf(RooSyncServiceError);
    await expect(mgr.createRollbackPoint('dec-err')).rejects.toMatchObject({ code: 'ROLLBACK_CREATION_FAILED' });
  });
});

describe('BaselineManager.restoreFromRollbackPoint — deep paths', () => {
  it('restores files from the most recent backup and reports success', async () => {
    mockExistsSync.mockReturnValue(true);
    mockFs.readdir.mockResolvedValue([
      'dec-1_2026-01-01T00-00-00-000Z',
      'dec-1_2025-12-01T00-00-00-000Z',
    ]);
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({ timestamp: '2026-01-01', machine: 'test-machine', files: ['sync-config.ref.json'] }),
    );
    mockFs.stat.mockResolvedValue({ size: 128 } as any);
    const clearCache = vi.fn();
    const mgr = await makeManager();

    const res = await mgr.restoreFromRollbackPoint('dec-1', clearCache);

    // Success once ≥1 file restored (BaselineManager.ts:835), cache invalidated (L824).
    expect(res.success).toBe(true);
    expect(res.restoredFiles).toContain('sync-config.ref.json');
    expect(clearCache).toHaveBeenCalled();
    // reverse-sorted selection keeps the 2026 backup (BaselineManager.ts:694-714).
    expect(res.logs.some((l) => l.includes('2026-01-01T00-00-00'))).toBe(true);
  });

  it('rolls back a restored file when its post-restore integrity check fails', async () => {
    mockExistsSync.mockReturnValue(true);
    mockFs.readdir.mockResolvedValue(['dec-2_2026-01-01T00-00-00-000Z']);
    mockFs.readFile.mockResolvedValue(JSON.stringify({ timestamp: 't', machine: 'm', files: ['sync-roadmap.md'] }));
    // Pre-restore access OK, but post-restore stat throws → integrity failure.
    mockFs.stat.mockRejectedValue(new Error('stat failed'));
    const mgr = await makeManager();

    const res = await mgr.restoreFromRollbackPoint('dec-2', vi.fn());

    // Integrity-fail path pulls the file back out + restores the backup (BaselineManager.ts:786-799).
    expect(res.restoredFiles).not.toContain('sync-roadmap.md');
    expect(res.success).toBe(false);
    expect(res.logs.some((l) => l.includes('Erreur vérification intégrité'))).toBe(true);
  });

  it('reports failure when no backup matches the decision', async () => {
    mockExistsSync.mockReturnValue(true); // rollback dir exists...
    mockFs.readdir.mockResolvedValue(['other-decision_2026-01-01T00-00-00-000Z']); // ...but nothing matches
    const mgr = await makeManager();

    const res = await mgr.restoreFromRollbackPoint('dec-x', vi.fn());

    // No-match branch (BaselineManager.ts:699-708).
    expect(res.success).toBe(false);
    expect(res.error).toContain('No rollback found for decision dec-x');
  });
});

describe('BaselineManager.listRollbackPoints / validateRollbackPoint — populated', () => {
  it('lists backup metadata most-recent first and skips dirs without metadata', async () => {
    // Everything exists except the metadata under the "no-meta" backup.
    mockExistsSync.mockImplementation((p: any) => !String(p).includes('d3_nometa'));
    mockFs.readdir.mockResolvedValue(['d1_older', 'd2_newer', 'd3_nometa']);
    mockFs.readFile.mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('.machine-registry.json')) return '{}';
      if (s.includes('d1_older')) return JSON.stringify({ decisionId: 'd1', timestamp: '2025-01-01T00:00:00Z', machine: 'm1', files: ['f'] });
      if (s.includes('d2_newer')) return JSON.stringify({ decisionId: 'd2', timestamp: '2026-01-01T00:00:00Z', machine: 'm2', files: ['f'] });
      return '{}';
    });
    const mgr = await makeManager();

    const res = await mgr.listRollbackPoints();

    // d3 skipped (no metadata, BaselineManager.ts:951); sorted desc by timestamp (L964-968).
    expect(res.map((r) => r.decisionId)).toEqual(['d2', 'd1']);
    expect(res[0].machine).toBe('m2');
  });

  it('validates a populated backup as valid with a computed checksum', async () => {
    mockExistsSync.mockReturnValue(true);
    mockFs.readdir.mockImplementation(async (p: any) =>
      String(p).endsWith('.rollback')
        ? ['dec-v_2026-01-01T00-00-00-000Z']
        : ['sync-config.ref.json', 'metadata.json'],
    );
    mockFs.readFile.mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('.machine-registry.json')) return '{}';
      if (s.endsWith('metadata.json')) return JSON.stringify({ files: ['sync-config.ref.json'] });
      return Buffer.from('file-content'); // calculateChecksum reads raw content
    });
    mockFs.stat.mockResolvedValue({ size: 42 } as any);
    const mgr = await makeManager();

    const res = await mgr.validateRollbackPoint('dec-v');

    // Non-empty valid file → isValid true (BaselineManager.ts:1169-1175), checksum computed (L905-920).
    expect(res.isValid).toBe(true);
    expect(res.files).toContain('sync-config.ref.json');
    expect(typeof res.checksum).toBe('string');
    expect(res.checksum).not.toBe('unknown');
    expect(res.errors).toEqual([]);
  });

  it('flags empty backup files as invalid', async () => {
    mockExistsSync.mockReturnValue(true);
    mockFs.readdir.mockImplementation(async (p: any) =>
      String(p).endsWith('.rollback') ? ['dec-e_2026-01-01T00-00-00-000Z'] : ['sync-roadmap.md'],
    );
    mockFs.readFile.mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('.machine-registry.json')) return '{}';
      if (s.endsWith('metadata.json')) return JSON.stringify({ files: ['sync-roadmap.md'] });
      return Buffer.from('x');
    });
    mockFs.stat.mockResolvedValue({ size: 0 } as any); // empty file
    const mgr = await makeManager();

    const res = await mgr.validateRollbackPoint('dec-e');

    // Empty file recorded as an error → invalid (BaselineManager.ts:1164-1167,1175).
    expect(res.isValid).toBe(false);
    expect(res.errors.some((e) => e.includes('Empty file'))).toBe(true);
  });
});
