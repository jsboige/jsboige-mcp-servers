/**
 * Tests for roosync_inventory tool
 *
 * Covers: type=machine, type=heartbeat, type=all, type=machines
 * (dashboard-derived presence, #2766), includeDetails, status filters,
 * error handling
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { inventoryTool, resetLocalInventoryCacheForTest } from '../../../../src/tools/roosync/inventory.js';

// Mock InventoryService
const mockGetMachineInventory = vi.fn();
vi.mock('../../../../src/services/roosync/InventoryService.js', () => ({
    InventoryService: {
        getInstance: () => ({
            getMachineInventory: mockGetMachineInventory,
        }),
    },
}));

// Mock lazy-roosync (getRooSyncService)
const mockGetUnknownMachines = vi.fn();
const mockGetIdleMachines = vi.fn();
const mockGetHeartbeatData = vi.fn();
const mockGetKnownMachineIds = vi.fn();

const mockHeartbeatService = {
    getState: vi.fn(() => ({
        onlineMachines: ['ai-01'],
        unknownMachines: ['web1'],
        idleMachines: ['po-2023'],
        statistics: {
            totalMachines: 3,
            onlineCount: 1,
            idleCount: 1,
            unknownCount: 1,
            lastHeartbeatCheck: '2026-05-04T00:00:00.000Z',
        },
        heartbeats: new Map([
            ['ai-01', { machineId: 'ai-01', lastHeartbeat: '2026-05-04T00:00:00.000Z', status: 'online' }],
        ]),
    })),
    getUnknownMachines: mockGetUnknownMachines,
    getIdleMachines: mockGetIdleMachines,
    getHeartbeatData: mockGetHeartbeatData,
};

vi.mock('../../../../src/services/lazy-roosync.js', () => ({
    getRooSyncService: vi.fn(() =>
        Promise.resolve({
            getHeartbeatService: () => mockHeartbeatService,
            // #2766 : type="machines" lit le registre via getKnownMachineIds()
            getKnownMachineIds: mockGetKnownMachineIds,
        })
    ),
}));

// #2766 — présence dashboard-dérivée : mocks du chemin <shared>/dashboards/
// et du parsing (même pattern que get-status.test.ts ; le parsing regex vit
// dans sa propre suite, ici on teste la CLASSIFICATION). vi.hoisted : la
// factory de vi.mock est hoistée AVANT l'init des consts du module.
const { mockSharedStatePath, mockExtractMachineActivity, mockIsRecentlyActive, mockLookupMachineActivityInArchives } = vi.hoisted(() => ({
    mockSharedStatePath: vi.fn(),
    mockExtractMachineActivity: vi.fn(),
    mockIsRecentlyActive: vi.fn(),
    mockLookupMachineActivityInArchives: vi.fn(),
}));

vi.mock('../../../../src/utils/shared-state-path.js', () => ({
    getSharedStatePath: mockSharedStatePath,
}));

vi.mock('../../../../src/utils/dashboard-activity.js', () => ({
    extractMachineActivity: mockExtractMachineActivity,
    isRecentlyActive: mockIsRecentlyActive,
    lookupMachineActivityInArchives: mockLookupMachineActivityInArchives,
}));

describe('roosync_inventory tool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // #4004: le cache TTL local est un état module-level — reset pour que
        // chaque test exerce le service (sinon les tests d'erreur sont servis
        // par le cache du test précédent).
        resetLocalInventoryCacheForTest();
        mockGetMachineInventory.mockResolvedValue({ machines: [{ id: 'ai-01', status: 'online' }] });
    });

    it('has correct tool metadata', () => {
        expect(inventoryTool.name).toBe('roosync_inventory');
        expect(inventoryTool.version).toBe('4.2.0');
    });

    describe('type=machine', () => {
        it('fetches machine inventory', async () => {
            const result = await inventoryTool.execute({ type: 'machine' }, {});
            expect(result.success).toBe(true);
            expect(result.data.machineInventory).toBeDefined();
            expect(mockGetMachineInventory).toHaveBeenCalled();
        });

        it('passes machineId when provided', async () => {
            await inventoryTool.execute({ type: 'machine', machineId: 'myia-ai-01' }, {});
            expect(mockGetMachineInventory).toHaveBeenCalledWith('myia-ai-01');
        });
    });

    describe('type=heartbeat', () => {
        it('fetches heartbeat state', async () => {
            const result = await inventoryTool.execute({ type: 'heartbeat' }, {});
            expect(result.success).toBe(true);
            expect(result.data.heartbeatState).toBeDefined();
            expect(result.data.heartbeatState.onlineMachines).toContain('ai-01');
            expect(result.data.heartbeatState.unknownMachines).toContain('web1');
            expect(result.data.heartbeatState.idleMachines).toContain('po-2023');
        });

        it('includes heartbeats by default', async () => {
            const result = await inventoryTool.execute({ type: 'heartbeat' }, {});
            expect(result.data.heartbeatState.heartbeats).toBeDefined();
        });

        it('excludes heartbeats when includeHeartbeats=false', async () => {
            const result = await inventoryTool.execute({ type: 'heartbeat', includeHeartbeats: false }, {});
            expect(result.data.heartbeatState.heartbeats).toBeUndefined();
        });

        it('does not fetch machine inventory', async () => {
            await inventoryTool.execute({ type: 'heartbeat' }, {});
            expect(mockGetMachineInventory).not.toHaveBeenCalled();
        });
    });

    describe('type=all', () => {
        it('fetches both machine inventory and heartbeat state', async () => {
            const result = await inventoryTool.execute({ type: 'all' }, {});
            expect(result.success).toBe(true);
            expect(result.data.machineInventory).toBeDefined();
            expect(result.data.heartbeatState).toBeDefined();
        });
    });

    describe('type=machines (dashboard-derived presence, #2766)', () => {
        // Avant #2766 : ce bloc mockait les getters HeartbeatService dépréciés
        // (#2318) et encodait des listes PERMANENTMENT VIDES sur un siège sain.
        // Le contrat migre sur la présence dashboard-dérivée — même source que
        // type="status" (get-status.ts, utils/dashboard-activity.ts).
        const REGISTRY = ['myia-ai-01', 'myia-po-2024', 'myia-po-2027', 'workstation-42'];
        const NOW = new Date().toISOString();
        const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        let fixtureDir: string;

        beforeAll(() => {
            // Fixture réelle : l'énumération des dashboards (.md, hors .tmp)
            // s'exécute pour de vrai — seul le parsing est mocké. Le code lit
            // <shared>/dashboards/.
            fixtureDir = mkdtempSync(join(tmpdir(), 'inv-machines-unit-'));
            mkdirSync(join(fixtureDir, 'dashboards'));
            writeFileSync(join(fixtureDir, 'dashboards', 'workspace-test.md'), '### [2026-10-06T00:00:00.000Z] myia-po-2024|roo-extensions\ncontent');
            writeFileSync(join(fixtureDir, 'dashboards', 'global.md'), '### [2026-10-06T00:00:00.000Z] myia-ai-01|global\ncontent');
            writeFileSync(join(fixtureDir, 'dashboards', 'condense.tmp'), 'transient — must be skipped');
        });

        afterAll(() => {
            rmSync(fixtureDir, { recursive: true, force: true });
        });

        beforeEach(() => {
            mockSharedStatePath.mockReturnValue(fixtureDir);
            mockGetKnownMachineIds.mockReturnValue([...REGISTRY]);
            mockLookupMachineActivityInArchives.mockReturnValue(new Map());
            mockExtractMachineActivity.mockReset();
            mockIsRecentlyActive.mockReset();
        });

        it('classifies online vs unknown from dashboard activity — a registry machine with no activity lands in unknown', async () => {
            mockExtractMachineActivity.mockReturnValue(new Map([
                ['myia-po-2024', NOW],
                ['myia-ai-01', NOW],
                // myia-po-2027 : absente des dashboards
            ]));
            mockIsRecentlyActive.mockImplementation((lastSeen: string) => lastSeen === NOW);

            const result = await inventoryTool.execute({ type: 'machines' }, {});
            expect(result.success).toBe(true);
            expect(result.data.onlineMachines).toEqual(['myia-ai-01', 'myia-po-2024']);
            expect(result.data.onlineCount).toBe(2);
            // Le cœur du fix : unknown NON vide (l'ancien code rendait [] en permanence)
            expect(result.data.unknownMachines).toEqual(['myia-po-2027']);
            expect(result.data.unknownCount).toBe(1);
            // L'entrée non-myia du registre est filtrée
            expect(JSON.stringify(result.data)).not.toContain('workstation-42');
            expect(result.data.machineLastSeen['myia-po-2027']).toBeNull();
            expect(result.data.idleMachines).toEqual([]);
            expect(result.data.idleCount).toBe(0);
            expect(result.data.crossMachineWarning).toContain('dashboard-derived');
        });

        it('stale dashboard activity (>8h) classifies as unknown with lastSeen preserved', async () => {
            mockExtractMachineActivity.mockReturnValue(new Map([['myia-po-2027', TWO_DAYS_AGO]]));
            mockIsRecentlyActive.mockReturnValue(false);

            const result = await inventoryTool.execute({ type: 'machines' }, {});
            expect(result.data.onlineMachines).toEqual([]);
            expect(result.data.unknownMachines).toContain('myia-po-2027');
            // #3160 : lastSeen conservé — c'est le tell de mirror-staleness
            expect(result.data.machineLastSeen['myia-po-2027']).toBe(TWO_DAYS_AGO);
        });

        it('#3695 — machine archived out of live files recovers lastSeen from archives', async () => {
            const archivedTs = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h : récent
            mockExtractMachineActivity.mockReturnValue(new Map([
                ['myia-po-2024', NOW]
            ]));
            mockLookupMachineActivityInArchives.mockReturnValue(new Map([['myia-po-2027', archivedTs]]));
            mockIsRecentlyActive.mockImplementation((lastSeen: string) => lastSeen === NOW || lastSeen === archivedTs);

            const result = await inventoryTool.execute({ type: 'machines' }, {});
            expect(result.data.onlineMachines).toEqual(expect.arrayContaining(['myia-po-2024', 'myia-po-2027']));
            // ai-01 est absente des fichiers courants ET des archives simulées → unknown
            expect(result.data.unknownMachines).toEqual(['myia-ai-01']);
            // Le lookup archives n'est demandé QUE pour les machines absentes des fichiers courants
            expect(mockLookupMachineActivityInArchives).toHaveBeenCalledWith(
                expect.any(String),
                ['myia-ai-01', 'myia-po-2027']
            );
        });

        it('status="unknown" gates the unknown list but onlineMachines stays returned', async () => {
            mockExtractMachineActivity.mockReturnValue(new Map([['myia-po-2024', NOW]]));
            mockIsRecentlyActive.mockReturnValue(true);

            const result = await inventoryTool.execute({ type: 'machines', status: 'unknown' }, {});
            expect(result.data.unknownMachines).toEqual(['myia-ai-01', 'myia-po-2027']);
            expect(result.data.onlineMachines).toEqual(['myia-po-2024']);
            expect(result.data.onlineCount).toBe(1);
        });

        it('includeDetails returns {machineId, lastSeen} entries instead of bare ids', async () => {
            mockExtractMachineActivity.mockReturnValue(new Map([
                ['myia-po-2024', NOW],
                ['myia-po-2027', TWO_DAYS_AGO]
            ]));
            mockIsRecentlyActive.mockImplementation((lastSeen: string) => lastSeen === NOW);

            const result = await inventoryTool.execute({ type: 'machines', includeDetails: true }, {});
            expect(result.data.onlineMachines).toEqual([{ machineId: 'myia-po-2024', lastSeen: NOW }]);
            // ai-01 : aucune activité → unknown avec lastSeen null ; po-2027 : stalée
            expect(result.data.unknownMachines).toEqual([
                { machineId: 'myia-ai-01', lastSeen: null },
                { machineId: 'myia-po-2027', lastSeen: TWO_DAYS_AGO }
            ]);
        });

        it('dashboards dir unreadable — registry reported honestly as unknown, lastSeen null', async () => {
            mockSharedStatePath.mockReturnValue(join(tmpdir(), 'inv-machines-does-not-exist-' + Date.now()));
            mockExtractMachineActivity.mockReturnValue(new Map());

            const result = await inventoryTool.execute({ type: 'machines' }, {});
            expect(result.data.onlineMachines).toEqual([]);
            expect(result.data.unknownMachines).toEqual(['myia-ai-01', 'myia-po-2024', 'myia-po-2027']);
            expect(result.data.machineLastSeen['myia-ai-01']).toBeNull();
        });

        it('.tmp dashboards are skipped by the enumeration', async () => {
            mockExtractMachineActivity.mockImplementation((contents: string[]) => {
                // Le fichier .tmp ne doit PAS figurer dans les contenus passés au parser
                expect(contents.some((c: string) => c.includes('transient'))).toBe(false);
                expect(contents.length).toBe(2);
                return new Map([['myia-po-2024', NOW]]);
            });
            mockIsRecentlyActive.mockReturnValue(true);

            const result = await inventoryTool.execute({ type: 'machines' }, {});
            expect(result.success).toBe(true);
        });
    });

    describe('error handling', () => {
        it('returns error when InventoryService throws', async () => {
            mockGetMachineInventory.mockRejectedValue(new Error('DB connection failed'));
            const result = await inventoryTool.execute({ type: 'machine' }, {});
            expect(result.success).toBe(false);
            expect(result.error?.code).toBe('INVENTORY_COLLECTION_FAILED');
            expect(result.error?.message).toContain('DB connection failed');
        });

        it('returns error when heartbeat service throws', async () => {
            mockHeartbeatService.getState.mockImplementationOnce(() => {
                throw new Error('Heartbeat unavailable');
            });
            const result = await inventoryTool.execute({ type: 'heartbeat' }, {});
            expect(result.success).toBe(false);
            expect(result.error?.message).toContain('Heartbeat unavailable');
        });
    });

    describe('metrics', () => {
        it('includes execution time in metrics', async () => {
            const result = await inventoryTool.execute({ type: 'machine' }, {});
            expect(result.metrics?.executionTime).toBeGreaterThanOrEqual(0);
        });
    });
});
