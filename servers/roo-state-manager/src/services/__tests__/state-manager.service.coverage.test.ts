/**
 * #833 Sprint C3 — StateManager branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `state-manager.service.test.ts` (15 tests) covers the getters (instance types),
 * the zeroed initial metrics, and shared-reference mutability. It leaves these branches
 * cold, all pinned here against source lines of `state-manager.service.ts`:
 *
 * - `fleetRoster` initial value (L122): `rooSyncCfg?.fleetRoster ?? null`. Two arms —
 *   config present with a roster array, config absent/null → null. The base never asserts
 *   `state.fleetRoster` at all.
 * - `machineId` 3-way resolution (L123): `rooSyncCfg?.machineId ?? (process.env.ROOSYNC_MACHINE_ID || 'local').toLowerCase()`.
 *   Three arms — config-driven, env-driven, default 'local' — plus the `.toLowerCase()`
 *   normalization. The base never asserts `state.machineId`.
 * - `skeletonRefreshInterval: null` + `lastSkeletonRefreshAt: 0` (L116-117): Worker A
 *   initial values. The base tests Worker B (qdrant) intervals but never Worker A.
 * - `isIndexLeader: false` (L121): #2352 leader-election initial value — never asserted.
 * - **Getter identity** (L129-155): the five service getters each return the SAME instance
 *   as `getState().X` (not just the same type). The base asserts `instanceof` but never
 *   identity (`===`), so a future refactor that constructs a fresh service per getter call
 *   would pass the base but break the singleton contract.
 *
 * Strategy: mock `../config/roosync-config.js` (`tryLoadRooSyncConfig`) to control the
 * config-driven arms, and manipulate `ROOSYNC_MACHINE_ID` for the env-driven arm. The
 * mock is reset per test so config/env don't leak across assertions.
 *
 * No production code touched (#1936 anti-churn).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// ─────────────────── mock: roosync-config (controls fleetRoster + machineId arms) ───────────────────

const { mockTryLoadRooSyncConfig } = vi.hoisted(() => ({
    mockTryLoadRooSyncConfig: vi.fn(),
}));

vi.mock('../../config/roosync-config.js', () => ({
    tryLoadRooSyncConfig: (...args: any[]) => mockTryLoadRooSyncConfig(...args),
}));

import { StateManager } from '../state-manager.service.js';

describe('StateManager — branch coverage (#833 C3, source-grounded)', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        vi.clearAllMocks();
        // Default: no config loaded → exercises the env/default arms.
        mockTryLoadRooSyncConfig.mockReturnValue(null);
        delete process.env.ROOSYNC_MACHINE_ID;
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    // ============================================================
    // machineId — 3-way resolution + lowercasing (L123)
    // ============================================================
    describe('machineId resolution (L123)', () => {
        test('config-driven arm: rooSyncCfg.machineId wins (L123 first operand)', () => {
            mockTryLoadRooSyncConfig.mockReturnValue({
                machineId: 'config-machine',
                fleetRoster: null,
            });
            // Env set but should NOT win — config takes precedence.
            process.env.ROOSYNC_MACHINE_ID = 'env-machine';

            const manager = new StateManager();
            expect(manager.getState().machineId).toBe('config-machine');
        });

        test('config machineId passes through verbatim — lowercasing is tryLoadRooSyncConfig job, not the service (L123 first operand, NO toLowerCase on this arm)', () => {
            // L123: rooSyncCfg?.machineId ?? (...).toLowerCase()
            // The config-driven arm is rooSyncCfg.machineId AS-IS — no .toLowerCase().
            // The real lowercasing/validation happens at config-load time (roosync-config.ts),
            // NOT in this service. Pinning this so a future "lowercase always" change is caught.
            mockTryLoadRooSyncConfig.mockReturnValue({
                machineId: 'MyIA-PO-2026',
                fleetRoster: null,
            });
            const manager = new StateManager();
            expect(manager.getState().machineId).toBe('MyIA-PO-2026');
        });

        test('env fallback arm: ROOSYNC_MACHINE_ID used when config is null (L123 ?? env)', () => {
            mockTryLoadRooSyncConfig.mockReturnValue(null); // no config
            process.env.ROOSYNC_MACHINE_ID = 'ENV-Host-1';

            const manager = new StateManager();
            // L123: (process.env.ROOSYNC_MACHINE_ID || 'local').toLowerCase()
            expect(manager.getState().machineId).toBe('env-host-1');
        });

        test(`default arm: "local" when neither config nor env (L123 || 'local')`, () => {
            mockTryLoadRooSyncConfig.mockReturnValue(null);
            // ROOSYNC_MACHINE_ID deleted in beforeEach.
            const manager = new StateManager();
            expect(manager.getState().machineId).toBe('local');
        });

        test('env value is lowercased even when config absent (L123 .toLowerCase on env arm)', () => {
            mockTryLoadRooSyncConfig.mockReturnValue(null);
            process.env.ROOSYNC_MACHINE_ID = 'UPPER-CASE';
            const manager = new StateManager();
            expect(manager.getState().machineId).toBe('upper-case');
        });
    });

    // ============================================================
    // fleetRoster — config vs null (L122)
    // ============================================================
    describe('fleetRoster resolution (L122)', () => {
        test('config-driven arm: rooSyncCfg.fleetRoster flows through (L122 first operand)', () => {
            const roster = ['myia-ai-01', 'myia-po-2026', 'myia-web1'];
            mockTryLoadRooSyncConfig.mockReturnValue({
                machineId: 'myia-po-2026',
                fleetRoster: roster,
            });
            const manager = new StateManager();
            expect(manager.getState().fleetRoster).toBe(roster);
            expect(manager.getState().fleetRoster).toHaveLength(3);
        });

        test('null arm: config absent → fleetRoster is null (L122 ?? null)', () => {
            mockTryLoadRooSyncConfig.mockReturnValue(null);
            const manager = new StateManager();
            expect(manager.getState().fleetRoster).toBeNull();
        });

        test('null arm: config present but fleetRoster null → null (L122 ?? null)', () => {
            mockTryLoadRooSyncConfig.mockReturnValue({
                machineId: 'm',
                fleetRoster: null,
            });
            const manager = new StateManager();
            expect(manager.getState().fleetRoster).toBeNull();
        });
    });

    // ============================================================
    // Worker A + leader-election initial values (L116-117, L121)
    // ============================================================
    describe('untested initial-state fields (L116-117, L121)', () => {
        test('skeletonRefreshInterval starts null (L116, Worker A)', () => {
            const manager = new StateManager();
            expect(manager.getState().skeletonRefreshInterval).toBeNull();
        });

        test('lastSkeletonRefreshAt starts at 0 (L117)', () => {
            const manager = new StateManager();
            expect(manager.getState().lastSkeletonRefreshAt).toBe(0);
        });

        test('isIndexLeader starts false (L121, #2352 leader-election)', () => {
            const manager = new StateManager();
            expect(manager.getState().isIndexLeader).toBe(false);
        });
    });

    // ============================================================
    // Getter identity — singleton contract (L129-155)
    // ============================================================
    describe('getter identity === getState().X (singleton contract)', () => {
        test('getTraceSummaryService returns the same instance as getState().traceSummaryService (L137-139)', () => {
            const manager = new StateManager();
            expect(manager.getTraceSummaryService()).toBe(manager.getState().traceSummaryService);
        });

        test('getIndexingDecisionService returns the same instance as getState().indexingDecisionService (L141-143)', () => {
            const manager = new StateManager();
            expect(manager.getIndexingDecisionService()).toBe(manager.getState().indexingDecisionService);
        });

        test('getXmlExporterService returns the same instance as getState().xmlExporterService (L145-147)', () => {
            const manager = new StateManager();
            expect(manager.getXmlExporterService()).toBe(manager.getState().xmlExporterService);
        });

        test('getExportConfigManager returns the same instance as getState().exportConfigManager (L149-151)', () => {
            const manager = new StateManager();
            expect(manager.getExportConfigManager()).toBe(manager.getState().exportConfigManager);
        });

        test('getSynthesisOrchestratorService returns the same instance as getState().synthesisOrchestratorService (L153-155)', () => {
            const manager = new StateManager();
            expect(manager.getSynthesisOrchestratorService()).toBe(manager.getState().synthesisOrchestratorService);
        });

        test('getState returns the same object reference on repeat calls (L129-131)', () => {
            const manager = new StateManager();
            expect(manager.getState()).toBe(manager.getState());
        });
    });

    // ============================================================
    // Cross-field coherence: fleetRoster + machineId from the same config call (L122-123)
    // ============================================================
    describe('config coherence (L122-123)', () => {
        test('a single config object populates both fleetRoster and machineId', () => {
            mockTryLoadRooSyncConfig.mockReturnValue({
                machineId: 'Coherent-Machine',
                fleetRoster: ['a', 'b'],
            });
            const manager = new StateManager();
            const state = manager.getState();
            // Both fields sourced from the SAME rooSyncCfg object (L122 + L123).
            // Config-driven machineId is verbatim (no lowercasing on the config arm).
            expect(state.machineId).toBe('Coherent-Machine');
            expect(state.fleetRoster).toEqual(['a', 'b']);
        });
    });
});
