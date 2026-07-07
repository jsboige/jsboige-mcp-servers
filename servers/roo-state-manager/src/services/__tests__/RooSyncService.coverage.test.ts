/**
 * Coverage tests for RooSyncService façade delegation methods.
 *
 * Issue #833 — Epic Coverage C3 src/services (dispatch ai-01 c.6 → po-2024).
 * TIER A+B of the firsthand c.6 brief: tractable getters + 1-line delegation
 * wrappers + 3 try/catch delegations. (TIER C — compareConfig / non-nominative
 * baseline / presence callbacks — is Item 2, a separate cycle: heavy mocking.)
 *
 * Gap-data: RooSyncService.ts sat at 51.36%S / 89.7%B / 43.54%F (35/62 functions
 * uncovered). Root cause mirrors task-indexer: this is a façade delegating to
 * ~12 services; the existing RooSyncService.test.ts covers singleton/cache/
 * getConfigService but not the delegation surface.
 *
 * Approach: instantiate the REAL service via getInstance() (same setup as the
 * existing test — unmocks + mocked loadRooSyncConfig → /mock/roosync), then spy
 * on each delegated service's method via the (private at TS, plain at runtime)
 * instance fields and assert the pass-through wiring + return values.
 *
 * @module services/__tests__/RooSyncService.coverage
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// Mirror the existing RooSyncService.test.ts unmocks so the REAL class + its
// real delegated services are constructed (the jest.setup.js stubs are bypassed).
vi.unmock('../RooSyncService.js');
vi.unmock('../ConfigService.js');
vi.unmock('../PowerShellExecutor.js');
vi.unmock('../InventoryCollector.js');
vi.unmock('../DiffDetector.js');
vi.unmock('../BaselineService.js');
vi.unmock('../InventoryCollectorWrapper.js');
vi.unmock('../ConfigSharingService.js');

import { RooSyncService } from '../RooSyncService.js';

// Mock the config factory so the constructor uses a fake shared path (no GDrive / no disk).
const mockLoadConfig = vi.fn();
const mockValidateMachineId = vi.fn();
const mockRegisterMachineId = vi.fn();

vi.mock('../config/roosync-config.js', () => ({
    loadRooSyncConfig: (...args: any[]) => mockLoadConfig(...args),
    validateMachineIdUniqueness: (...args: any[]) => mockValidateMachineId(...args),
    registerMachineId: (...args: any[]) => mockRegisterMachineId(...args),
}));

beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockResolvedValue({
        rooSyncPath: '/mock/roosync',
        machineId: 'test-machine',
        storagePaths: [],
    });
    mockValidateMachineId.mockResolvedValue({ conflictDetected: false });
    mockRegisterMachineId.mockResolvedValue(true);
});

/**
 * Build a FRESH instance for each test (reset the singleton) so spies on the
 * delegated services never leak across tests. Mirrors the existing test's reset idiom.
 */
async function freshService(): Promise<RooSyncService> {
    (RooSyncService as any).instance = null;
    (RooSyncService as any)._initError = null;
    (RooSyncService as any)._lastInitAttempt = 0;
    return await RooSyncService.getInstance();
}

// ─────────────────── TIER A — instance getters ───────────────────

describe('RooSyncService TIER A — instance getters (coverage #833 C3)', () => {
    test('getPresenceManager returns the PresenceManager instance (L255)', async () => {
        const service = await freshService();
        expect(service.getPresenceManager()).toBeDefined();
    });

    test('getIdentityManager returns the IdentityManager instance (L262)', async () => {
        const service = await freshService();
        expect(service.getIdentityManager()).toBeDefined();
    });

    test('getInventoryCollector returns the InventoryCollector instance (L438)', async () => {
        const service = await freshService();
        expect(service.getInventoryCollector()).toBeDefined();
    });

    test('getConfigSharingService returns the ConfigSharingService instance (L445)', async () => {
        const service = await freshService();
        expect(service.getConfigSharingService()).toBeDefined();
    });

    test('getNonNominativeBaselineService returns the service instance (L793)', async () => {
        const service = await freshService();
        expect(service.getNonNominativeBaselineService()).toBeDefined();
    });
});

// ─────────────────── TIER A — static getters ───────────────────

describe('RooSyncService TIER A — static getters (coverage #833 C3)', () => {
    test('isDegraded is false after a successful init (L410)', async () => {
        await freshService();
        expect(RooSyncService.isDegraded()).toBe(false);
    });

    test('isDegraded is true when instance is null and an init error is recorded (L410)', () => {
        (RooSyncService as any).instance = null;
        (RooSyncService as any)._initError = new Error('GDrive unmounted');
        expect(RooSyncService.isDegraded()).toBe(true);
    });

    test('getInitError returns null after a successful init (L417)', async () => {
        await freshService();
        expect(RooSyncService.getInitError()).toBeNull();
    });

    test('getInitError returns the recorded init error when set (L417)', () => {
        const err = new Error('shared path unavailable');
        (RooSyncService as any).instance = null;
        (RooSyncService as any)._initError = err;
        expect(RooSyncService.getInitError()).toBe(err);
    });
});

// ─────────────────── TIER A — delegation wrappers (spy the delegated service) ───────────────────

describe('RooSyncService TIER A — delegation wrappers (coverage #833 C3)', () => {
    test('loadPendingDecisions forwards to syncDecisionManager (L598)', async () => {
        const service = await freshService();
        const fake = [{ id: 'd1' } as any];
        const spy = vi.spyOn((service as any).syncDecisionManager, 'loadPendingDecisions').mockResolvedValue(fake);

        const result = await service.loadPendingDecisions();

        expect(result).toBe(fake);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    test('listDiffs forwards (filter, forceRefresh) to configComparator (L683)', async () => {
        const service = await freshService();
        const fake = { totalDiffs: 0, diffs: [] };
        const spy = vi.spyOn((service as any).configComparator, 'listDiffs').mockResolvedValue(fake as any);

        const result = await service.listDiffs('config', true);

        expect(result).toBe(fake);
        expect(spy).toHaveBeenCalledWith('config', true);
    });

    test('createRollbackPoint forwards decisionId to baselineManager (L715)', async () => {
        const service = await freshService();
        const spy = vi.spyOn((service as any).baselineManager, 'createRollbackPoint').mockResolvedValue(undefined);

        await service.createRollbackPoint('dec-1');

        expect(spy).toHaveBeenCalledWith('dec-1');
    });

    test('restoreFromRollbackPoint forwards to baselineManager with clearCache callback (L722)', async () => {
        const service = await freshService();
        const fake = { restored: true } as any;
        const spy = vi.spyOn((service as any).baselineManager, 'restoreFromRollbackPoint').mockResolvedValue(fake);

        const result = await service.restoreFromRollbackPoint('dec-1');

        expect(result).toBe(fake);
        expect(spy).toHaveBeenCalledWith('dec-1', expect.any(Function));
    });

    test('listRollbackPoints forwards to baselineManager (L729)', async () => {
        const service = await freshService();
        const fake = [{ decisionId: 'dec-1', timestamp: 't', machine: 'm', files: [] }];
        const spy = vi.spyOn((service as any).baselineManager, 'listRollbackPoints').mockResolvedValue(fake as any);

        const result = await service.listRollbackPoints();

        expect(result).toBe(fake);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    test('cleanupOldRollbacks forwards options to baselineManager (L741)', async () => {
        const service = await freshService();
        const fake = { deleted: ['x'], kept: [], errors: [] };
        const spy = vi.spyOn((service as any).baselineManager, 'cleanupOldRollbacks').mockResolvedValue(fake as any);

        const opts = { olderThanDays: 30, keepPerDecision: 2, dryRun: true };
        const result = await service.cleanupOldRollbacks(opts);

        expect(result).toBe(fake);
        expect(spy).toHaveBeenCalledWith(opts);
    });

    test('validateRollbackPoint forwards decisionId to baselineManager (L756)', async () => {
        const service = await freshService();
        const fake = { isValid: true, files: [], errors: [] };
        const spy = vi.spyOn((service as any).baselineManager, 'validateRollbackPoint').mockResolvedValue(fake as any);

        const result = await service.validateRollbackPoint('dec-1');

        expect(result).toBe(fake);
        expect(spy).toHaveBeenCalledWith('dec-1');
    });

    test('getInventory forwards (machineId, forceRefresh) to inventoryCollector (L768)', async () => {
        const service = await freshService();
        const fake = { machineId: 'm1' } as any;
        const spy = vi.spyOn((service as any).inventoryCollector, 'collectInventory').mockResolvedValue(fake);

        const result = await service.getInventory('m1', true);

        expect(result).toBe(fake);
        expect(spy).toHaveBeenCalledWith('m1', true);
    });

    test('compareRealConfigurations forwards to configComparator (L775)', async () => {
        const service = await freshService();
        const fake = { diffs: [] } as any;
        const spy = vi.spyOn((service as any).configComparator, 'compareRealConfigurations').mockResolvedValue(fake);

        const result = await service.compareRealConfigurations('src', 'tgt', true);

        expect(result).toBe(fake);
        expect(spy).toHaveBeenCalledWith('src', 'tgt', true);
    });

    test('generateDecisionsFromReport forwards report to syncDecisionManager (L786)', async () => {
        const service = await freshService();
        const spy = vi.spyOn((service as any).syncDecisionManager, 'generateDecisionsFromReport').mockResolvedValue(5);

        const result = await service.generateDecisionsFromReport({ items: [] });

        expect(result).toBe(5);
        expect(spy).toHaveBeenCalledWith({ items: [] });
    });

    test('getKnownMachineIds forwards to baselineManager (L944)', async () => {
        const service = await freshService();
        const spy = vi.spyOn((service as any).baselineManager, 'getKnownMachineIds').mockReturnValue(['m1', 'm2']);

        const result = service.getKnownMachineIds();

        expect(result).toEqual(['m1', 'm2']);
        expect(spy).toHaveBeenCalledTimes(1);
    });
});

// ─────────────────── TIER A — non-nominative baseline getters ───────────────────

describe('RooSyncService TIER A — non-nominative baseline getters (coverage #833 C3)', () => {
    test('getNonNominativeState forwards to nonNominativeBaselineService.getState (L915)', async () => {
        const service = await freshService();
        const fake = { machineMappings: [] };
        const spy = vi.spyOn((service as any).nonNominativeBaselineService, 'getState').mockReturnValue(fake);

        expect(service.getNonNominativeState()).toBe(fake);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    test('getActiveNonNominativeBaseline forwards to getActiveBaseline (L922)', async () => {
        const service = await freshService();
        const fake = { name: 'baseline-1' };
        const spy = vi.spyOn((service as any).nonNominativeBaselineService, 'getActiveBaseline').mockReturnValue(fake);

        expect(service.getActiveNonNominativeBaseline()).toBe(fake);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    test('getNonNominativeMachineMappings returns machineMappings when present (L929)', async () => {
        const service = await freshService();
        const mappings = [{ machineHash: 'h1' }];
        vi.spyOn((service as any).nonNominativeBaselineService, 'getState').mockReturnValue({ machineMappings: mappings });

        expect(service.getNonNominativeMachineMappings()).toEqual(mappings);
    });

    test('getNonNominativeMachineMappings returns [] when getState is null (L929 fallback)', async () => {
        const service = await freshService();
        vi.spyOn((service as any).nonNominativeBaselineService, 'getState').mockReturnValue(null as any);

        expect(service.getNonNominativeMachineMappings()).toEqual([]);
    });
});

// ─────────────────── TIER B — try/catch delegations ───────────────────

describe('RooSyncService TIER B — try/catch delegations (coverage #833 C3)', () => {
    test('validateAllIdentities returns the identityManager validation result (L269)', async () => {
        const service = await freshService();
        const fake = { isValid: true, conflicts: [], recommendations: ['ok'] };
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const spy = vi.spyOn((service as any).identityManager, 'validateIdentities').mockResolvedValue(fake as any);

        const result = await service.validateAllIdentities();

        expect(result).toBe(fake);
        expect(spy).toHaveBeenCalledTimes(1);
        errSpy.mockRestore();
        logSpy.mockRestore();
    });

    test('validateAllIdentities returns a degraded result when the manager throws (L294-301)', async () => {
        const service = await freshService();
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn((service as any).identityManager, 'validateIdentities').mockRejectedValue(new Error('boom'));

        const result = await service.validateAllIdentities();

        expect(result.isValid).toBe(false);
        expect(result.conflicts).toEqual([]);
        expect(result.recommendations).toHaveLength(1);
        errSpy.mockRestore();
    });

    test('cleanupIdentities forwards options and returns the identityManager result (L307)', async () => {
        const service = await freshService();
        const fake = { removed: ['orphan-1'], resolved: [], errors: [] };
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const spy = vi.spyOn((service as any).identityManager, 'cleanupIdentities').mockResolvedValue(fake as any);

        const opts = { removeOrphaned: true, dryRun: true };
        const result = await service.cleanupIdentities(opts);

        expect(result).toBe(fake);
        expect(spy).toHaveBeenCalledWith(opts);
        logSpy.mockRestore();
    });

    test('cleanupIdentities returns a degraded result when the manager throws (L334-341)', async () => {
        const service = await freshService();
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn((service as any).identityManager, 'cleanupIdentities').mockRejectedValue(new Error('boom'));

        const result = await service.cleanupIdentities({ removeOrphaned: true });

        expect(result.removed).toEqual([]);
        expect(result.errors).toHaveLength(1);
        errSpy.mockRestore();
    });

    test('executeDecision forwards and clears cache on success (L701-710)', async () => {
        const service = await freshService();
        const fake = { success: true } as any;
        const spy = vi.spyOn((service as any).syncDecisionManager, 'executeDecision').mockResolvedValue(fake);
        const cacheSpy = vi.spyOn(service, 'clearCache').mockImplementation(() => {});

        const result = await service.executeDecision('dec-1', { dryRun: true });

        expect(result).toBe(fake);
        expect(spy).toHaveBeenCalledWith('dec-1', { dryRun: true });
        expect(cacheSpy).toHaveBeenCalledTimes(1);
        cacheSpy.mockRestore();
    });

    test('executeDecision does NOT clear cache when result.success is false (L701-710)', async () => {
        const service = await freshService();
        vi.spyOn((service as any).syncDecisionManager, 'executeDecision').mockResolvedValue({ success: false } as any);
        const cacheSpy = vi.spyOn(service, 'clearCache').mockImplementation(() => {});

        await service.executeDecision('dec-1');

        expect(cacheSpy).not.toHaveBeenCalled();
        cacheSpy.mockRestore();
    });
});

// ─────────────────── TIER C — compareConfig (heavy branching) ───────────────────

describe('RooSyncService TIER C — compareConfig branches (coverage #833 C3)', () => {
    test('falls back to configComparator when no active baseline (L635/L675)', async () => {
        const service = await freshService();
        const fake = { localMachine: 'test-machine', targetMachine: 'm2', differences: [] };
        vi.spyOn((service as any).nonNominativeBaselineService, 'getActiveBaseline').mockReturnValue(null);
        const spy = vi.spyOn((service as any).configComparator, 'compareConfig').mockResolvedValue(fake as any);

        const result = await service.compareConfig();

        expect(result).toBe(fake);
        expect(spy).toHaveBeenCalledWith(expect.any(Function), undefined);
    });

    test('profile mode + existing mapping → differences from deviations (L637-670)', async () => {
        const service = await freshService();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const nn = (service as any).nonNominativeBaselineService;
        vi.spyOn(nn, 'getActiveBaseline').mockReturnValue({ name: 'b1' });
        vi.spyOn(nn, 'generateMachineHash').mockReturnValue('hash-x');
        vi.spyOn(nn, 'getMachineMappings').mockReturnValue([
            { machineHash: 'hash-x', deviations: [
                { category: 'mcp', actualValue: 'a', expectedValue: 'e', severity: 'WARN' },
            ] },
        ]);

        const result = await service.compareConfig();

        expect(result.localMachine).toBe((service as any).config.machineId);
        expect(result.targetMachine).toBe('Baseline (Profils)');
        expect(result.differences).toEqual([
            { field: 'mcp', localValue: 'a', targetValue: 'e', description: 'Déviation détectée pour mcp (Sévérité: WARN)' },
        ]);
        logSpy.mockRestore();
    });

    test('profile mode + no mapping + inventory collected → maps then returns differences (L645-670)', async () => {
        const service = await freshService();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const nn = (service as any).nonNominativeBaselineService;
        vi.spyOn(nn, 'getActiveBaseline').mockReturnValue({ name: 'b1' });
        vi.spyOn(nn, 'generateMachineHash').mockReturnValue('hash-y');
        vi.spyOn(nn, 'getMachineMappings').mockReturnValue([]);
        vi.spyOn((service as any).inventoryCollector, 'collectInventory').mockResolvedValue({ machineId: 'test-machine' } as any);
        const mapSpy = vi.spyOn(nn, 'mapMachineToBaseline').mockResolvedValue({
            machineHash: 'hash-y', deviations: [{ category: 'hw', actualValue: 1, expectedValue: 2, severity: 'INFO' }],
        } as any);

        const result = await service.compareConfig();

        expect(mapSpy).toHaveBeenCalledWith((service as any).config.machineId, expect.anything());
        expect(result.differences).toHaveLength(1);
        expect(result.differences[0].field).toBe('hw');
        logSpy.mockRestore();
    });

    test('profile mode + no mapping + inventory null → falls through to legacy fallback (L648-675)', async () => {
        const service = await freshService();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const nn = (service as any).nonNominativeBaselineService;
        vi.spyOn(nn, 'getActiveBaseline').mockReturnValue({ name: 'b1' });
        vi.spyOn(nn, 'generateMachineHash').mockReturnValue('hash-z');
        vi.spyOn(nn, 'getMachineMappings').mockReturnValue([]);
        vi.spyOn((service as any).inventoryCollector, 'collectInventory').mockResolvedValue(null);
        const fallbackSpy = vi.spyOn((service as any).configComparator, 'compareConfig').mockResolvedValue({ differences: [] } as any);

        const result = await service.compareConfig();

        expect(fallbackSpy).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ differences: [] });
        logSpy.mockRestore();
    });
});

// ─────────────────── TIER C — non-nominative baseline delegations ───────────────────

describe('RooSyncService TIER C — non-nominative baseline delegations (coverage #833 C3)', () => {
    test('createNonNominativeBaseline delegates + refreshes state (L800-809)', async () => {
        const service = await freshService();
        const fake = { id: 'b1' };
        const nn = (service as any).nonNominativeBaselineService;
        const createSpy = vi.spyOn(nn, 'createBaseline').mockResolvedValue(fake);
        const stateSpy = vi.spyOn(nn, 'getState').mockReturnValue({});

        const result = await service.createNonNominativeBaseline('name', 'desc', { aggreg: true });

        expect(createSpy).toHaveBeenCalledWith('name', 'desc', { aggreg: true });
        expect(stateSpy).toHaveBeenCalledTimes(1);
        expect(result).toBe(fake);
    });

    test('mapMachineToNonNominativeBaseline delegates to baselineManager + refreshes state (L814-819)', async () => {
        const service = await freshService();
        const fake = { machineHash: 'h' };
        const mapSpy = vi.spyOn((service as any).baselineManager, 'mapMachineToNonNominativeBaseline').mockResolvedValue(fake);
        const stateSpy = vi.spyOn((service as any).nonNominativeBaselineService, 'getState').mockReturnValue({});

        const result = await service.mapMachineToNonNominativeBaseline('m1');

        expect(mapSpy).toHaveBeenCalledWith('m1');
        expect(stateSpy).toHaveBeenCalledTimes(1);
        expect(result).toBe(fake);
    });

    test('compareMachinesNonNominative delegates machineIds to nonNominativeBaselineService (L898-900)', async () => {
        const service = await freshService();
        const fake = { report: true };
        const spy = vi.spyOn((service as any).nonNominativeBaselineService, 'compareMachines').mockResolvedValue(fake);

        const result = await service.compareMachinesNonNominative(['m1', 'm2']);

        expect(spy).toHaveBeenCalledWith(['m1', 'm2']);
        expect(result).toBe(fake);
    });

    test('migrateToNonNominative delegates to baselineManager + refreshes state (L905-910)', async () => {
        const service = await freshService();
        const fake = { migrated: true };
        const migSpy = vi.spyOn((service as any).baselineManager, 'migrateToNonNominative').mockResolvedValue(fake);
        const stateSpy = vi.spyOn((service as any).nonNominativeBaselineService, 'getState').mockReturnValue({});

        const result = await service.migrateToNonNominative({ dry: true });

        expect(migSpy).toHaveBeenCalledWith({ dry: true });
        expect(stateSpy).toHaveBeenCalledTimes(1);
        expect(result).toBe(fake);
    });
});

// ─────────────────── TIER C — updateBaseline (profile/legacy modes) ───────────────────

describe('RooSyncService TIER C — updateBaseline profile/legacy (coverage #833 C3)', () => {
    test('profile mode throws INVENTORY_FAILED when inventory is null (L836-843)', async () => {
        const service = await freshService();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn((service as any).inventoryCollector, 'collectInventory').mockResolvedValue(null);

        await expect(service.updateBaseline('m1', { mode: 'profile' })).rejects.toMatchObject({ code: 'INVENTORY_FAILED' });
        logSpy.mockRestore();
    });

    test('profile mode creates baseline and returns true when inventory collected (L836-860)', async () => {
        const service = await freshService();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn((service as any).inventoryCollector, 'collectInventory').mockResolvedValue({ machineId: 'm1' } as any);
        const createSpy = vi.spyOn((service as any).nonNominativeBaselineService, 'createBaseline').mockResolvedValue({});

        const result = await service.updateBaseline('m1', { mode: 'profile', version: '2.0', updateReason: 'r' });

        expect(createSpy).toHaveBeenCalledWith('Baseline 2.0', 'r', []);
        expect(result).toBe(true);
        logSpy.mockRestore();
    });

    test('legacy mode throws INVENTORY_FAILED when inventory is null (L861-869)', async () => {
        const service = await freshService();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn((service as any).inventoryCollector, 'collectInventory').mockResolvedValue(null);

        await expect(service.updateBaseline('m1', { mode: 'legacy' })).rejects.toMatchObject({ code: 'INVENTORY_FAILED' });
        logSpy.mockRestore();
    });

    test('legacy mode builds baseline and delegates to baselineService.updateBaseline (L861-892)', async () => {
        const service = await freshService();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn((service as any).inventoryCollector, 'collectInventory').mockResolvedValue({
            roo: { x: 1 }, hardware: { cpu: 8 }, software: { node: '20' }, system: { os: 'win' },
        } as any);
        const updSpy = vi.spyOn((service as any).baselineService, 'updateBaseline').mockResolvedValue(true);

        const result = await service.updateBaseline('m1', {
            mode: 'legacy', version: '1.0.0', createBackup: true, updateReason: 'r', updatedBy: 'u',
        });

        expect(result).toBe(true);
        expect(updSpy).toHaveBeenCalledTimes(1);
        const [newBaseline, opts] = updSpy.mock.calls[0];
        expect(newBaseline.machineId).toBe('m1');
        expect(newBaseline.version).toBe('1.0.0');
        expect(newBaseline.config).toEqual({ roo: { x: 1 }, hardware: { cpu: 8 }, software: { node: '20' }, system: { os: 'win' } });
        expect(opts).toEqual({ createBackup: true, updateReason: 'r', updatedBy: 'u' });
        logSpy.mockRestore();
    });
});

// ─────────────────── TIER C — heartbeat service + sync callbacks ───────────────────

describe('RooSyncService TIER C — heartbeat + sync callbacks (coverage #833 C3)', () => {
    test('startHeartbeatService forwards machineId + callbacks to heartbeatService (L983-1018)', async () => {
        const service = await freshService();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const spy = vi.spyOn((service as any).heartbeatService, 'startHeartbeatService').mockResolvedValue(undefined);

        await service.startHeartbeatService();

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toBe((service as any).config.machineId);
        expect(typeof spy.mock.calls[0][1]).toBe('function'); // unknownCallback
        expect(typeof spy.mock.calls[0][2]).toBe('function'); // onlineCallback
        logSpy.mockRestore();
    });

    test('unknownCallback invokes user cb + syncOnMachineOffline active path (L990-1000/L1039-1054)', async () => {
        const service = await freshService();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const startSpy = vi.spyOn((service as any).heartbeatService, 'startHeartbeatService').mockResolvedValue(undefined);
        const onUnknown = vi.fn();
        const nn = (service as any).nonNominativeBaselineService;
        vi.spyOn(nn, 'getActiveBaseline').mockReturnValue({ name: 'b1' }); // active path
        vi.spyOn((service as any).inventoryCollector, 'collectInventory').mockResolvedValue({ machineId: 'test-machine' } as any);
        const createSpy = vi.spyOn(nn, 'createBaseline').mockResolvedValue({});
        const cacheSpy = vi.spyOn(service, 'clearCache').mockImplementation(() => {});

        await service.startHeartbeatService(onUnknown);
        const unknownCallback = startSpy.mock.calls[0][1];
        await unknownCallback('m-offline');

        expect(onUnknown).toHaveBeenCalledWith('m-offline');
        expect(createSpy).toHaveBeenCalledTimes(1); // active path re-aggregated baseline
        expect(cacheSpy).toHaveBeenCalledTimes(1);
        logSpy.mockRestore();
    });

    test('onlineCallback invokes user cb + syncOnMachineOnline legacy path (L1002-1012/L1099-1106)', async () => {
        const service = await freshService();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const startSpy = vi.spyOn((service as any).heartbeatService, 'startHeartbeatService').mockResolvedValue(undefined);
        const onOnline = vi.fn();
        vi.spyOn((service as any).nonNominativeBaselineService, 'getActiveBaseline').mockReturnValue(null); // legacy path
        const updSpy = vi.spyOn(service, 'updateBaseline').mockResolvedValue(true); // short-circuit recursion
        const cacheSpy = vi.spyOn(service, 'clearCache').mockImplementation(() => {});

        await service.startHeartbeatService(undefined, onOnline);
        const onlineCallback = startSpy.mock.calls[0][2];
        await onlineCallback('m-online');

        expect(onOnline).toHaveBeenCalledWith('m-online');
        expect(updSpy).toHaveBeenCalledWith((service as any).config.machineId, { mode: 'legacy', updateReason: 'Machine redevenue online: m-online' });
        expect(cacheSpy).toHaveBeenCalledTimes(1);
        logSpy.mockRestore();
    });

    test('syncOnMachineOffline swallows internal errors (catch path L1067-1070)', async () => {
        const service = await freshService();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const startSpy = vi.spyOn((service as any).heartbeatService, 'startHeartbeatService').mockResolvedValue(undefined);
        vi.spyOn((service as any).nonNominativeBaselineService, 'getActiveBaseline').mockImplementation(() => { throw new Error('boom'); });

        await service.startHeartbeatService();
        const unknownCallback = startSpy.mock.calls[0][1];
        await expect(unknownCallback('m-x')).resolves.toBeUndefined(); // try/catch → no rejection
        expect(errSpy).toHaveBeenCalled();
        logSpy.mockRestore();
        errSpy.mockRestore();
    });

    test('stopHeartbeatService delegates to heartbeatService (L1024-1027)', async () => {
        const service = await freshService();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const spy = vi.spyOn((service as any).heartbeatService, 'stopHeartbeatService').mockResolvedValue(undefined);

        const result = await service.stopHeartbeatService();

        expect(spy).toHaveBeenCalledTimes(1);
        expect(result).toBeUndefined();
        logSpy.mockRestore();
    });

    test('checkHeartbeats delegates to heartbeatService (L1120-1122)', async () => {
        const service = await freshService();
        const fake = { offline: [] } as any;
        const spy = vi.spyOn((service as any).heartbeatService, 'checkHeartbeats').mockResolvedValue(fake);

        const result = await service.checkHeartbeats();

        expect(spy).toHaveBeenCalledTimes(1);
        expect(result).toBe(fake);
    });

    test('unknownCallback legacy path → updateBaseline legacy (L1055-1062)', async () => {
        const service = await freshService();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const startSpy = vi.spyOn((service as any).heartbeatService, 'startHeartbeatService').mockResolvedValue(undefined);
        vi.spyOn((service as any).nonNominativeBaselineService, 'getActiveBaseline').mockReturnValue(null); // legacy path
        const updSpy = vi.spyOn(service, 'updateBaseline').mockResolvedValue(true); // short-circuit recursion
        const cacheSpy = vi.spyOn(service, 'clearCache').mockImplementation(() => {});

        await service.startHeartbeatService();
        const unknownCallback = startSpy.mock.calls[0][1];
        await unknownCallback('m-off');

        expect(updSpy).toHaveBeenCalledWith((service as any).config.machineId, { mode: 'legacy', updateReason: 'Machine offline détectée: m-off' });
        expect(cacheSpy).toHaveBeenCalledTimes(1);
        logSpy.mockRestore();
    });

    test('onlineCallback active path → re-aggregates non-nominative baseline (L1083-1098)', async () => {
        const service = await freshService();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const startSpy = vi.spyOn((service as any).heartbeatService, 'startHeartbeatService').mockResolvedValue(undefined);
        const onOnline = vi.fn();
        const nn = (service as any).nonNominativeBaselineService;
        vi.spyOn(nn, 'getActiveBaseline').mockReturnValue({ name: 'b1' }); // active path
        vi.spyOn((service as any).inventoryCollector, 'collectInventory').mockResolvedValue({ machineId: 'test-machine' } as any);
        const createSpy = vi.spyOn(nn, 'createBaseline').mockResolvedValue({});
        const cacheSpy = vi.spyOn(service, 'clearCache').mockImplementation(() => {});

        await service.startHeartbeatService(undefined, onOnline);
        const onlineCallback = startSpy.mock.calls[0][2];
        await onlineCallback('m-on');

        expect(onOnline).toHaveBeenCalledWith('m-on');
        expect(createSpy).toHaveBeenCalledTimes(1); // active path re-aggregated baseline
        expect(cacheSpy).toHaveBeenCalledTimes(1);
        logSpy.mockRestore();
    });

    test('syncOnMachineOnline swallows internal errors (catch path L1111-1114)', async () => {
        const service = await freshService();
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const startSpy = vi.spyOn((service as any).heartbeatService, 'startHeartbeatService').mockResolvedValue(undefined);
        vi.spyOn((service as any).nonNominativeBaselineService, 'getActiveBaseline').mockImplementation(() => { throw new Error('boom'); });

        await service.startHeartbeatService();
        const onlineCallback = startSpy.mock.calls[0][2];
        await expect(onlineCallback('m-x')).resolves.toBeUndefined(); // try/catch → no rejection
        expect(errSpy).toHaveBeenCalled();
        logSpy.mockRestore();
        errSpy.mockRestore();
    });

    test('registerHeartbeat derives machineId from os.hostname and forwards (L952-955)', async () => {
        const service = await freshService();
        const spy = vi.spyOn((service as any).heartbeatService, 'registerHeartbeat').mockResolvedValue(undefined);

        await service.registerHeartbeat({ meta: 1 });

        expect(spy).toHaveBeenCalledTimes(1);
        expect(typeof spy.mock.calls[0][0]).toBe('string');
        expect(spy.mock.calls[0][0].length).toBeGreaterThan(0);
        expect(spy.mock.calls[0][1]).toEqual({ meta: 1 });
    });
});
