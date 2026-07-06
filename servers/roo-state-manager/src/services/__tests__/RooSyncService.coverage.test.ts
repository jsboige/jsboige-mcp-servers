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
