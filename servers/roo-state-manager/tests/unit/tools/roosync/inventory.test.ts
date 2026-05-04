/**
 * Tests for roosync_inventory tool
 *
 * Covers: type=machine, type=heartbeat, type=all, type=machines (fused),
 * includeDetails, status filters, error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inventoryTool } from '../../../../src/tools/roosync/inventory.js';

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
const mockGetOfflineMachines = vi.fn();
const mockGetWarningMachines = vi.fn();
const mockGetHeartbeatData = vi.fn();

const mockHeartbeatService = {
    getState: vi.fn(() => ({
        onlineMachines: ['ai-01'],
        offlineMachines: ['web1'],
        warningMachines: ['po-2023'],
        statistics: {
            totalMachines: 3,
            onlineCount: 1,
            offlineCount: 1,
            warningCount: 1,
            lastHeartbeatCheck: '2026-05-04T00:00:00.000Z',
        },
        heartbeats: new Map([
            ['ai-01', { machineId: 'ai-01', lastHeartbeat: '2026-05-04T00:00:00.000Z', status: 'online' }],
        ]),
    })),
    getOfflineMachines: mockGetOfflineMachines,
    getWarningMachines: mockGetWarningMachines,
    getHeartbeatData: mockGetHeartbeatData,
};

vi.mock('../../../../src/services/lazy-roosync.js', () => ({
    getRooSyncService: vi.fn(() =>
        Promise.resolve({
            getHeartbeatService: () => mockHeartbeatService,
        })
    ),
}));

describe('roosync_inventory tool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetMachineInventory.mockResolvedValue({ machines: [{ id: 'ai-01', status: 'online' }] });
    });

    it('has correct tool metadata', () => {
        expect(inventoryTool.name).toBe('roosync_inventory');
        expect(inventoryTool.version).toBe('3.0.0');
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
            expect(result.data.heartbeatState.offlineMachines).toContain('web1');
            expect(result.data.heartbeatState.warningMachines).toContain('po-2023');
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

    describe('type=machines (fused from roosync_machines)', () => {
        it('returns offline machines when status=offline', async () => {
            mockGetOfflineMachines.mockReturnValue(['web1', 'po-2024']);
            const result = await inventoryTool.execute({ type: 'machines', status: 'offline' }, {});
            expect(result.success).toBe(true);
            expect(result.data.offlineMachines).toEqual(['web1', 'po-2024']);
            expect(result.data.offlineCount).toBe(2);
        });

        it('returns warning machines when status=warning', async () => {
            mockGetWarningMachines.mockReturnValue(['po-2023']);
            const result = await inventoryTool.execute({ type: 'machines', status: 'warning' }, {});
            expect(result.success).toBe(true);
            expect(result.data.warningMachines).toEqual(['po-2023']);
            expect(result.data.warningCount).toBe(1);
        });

        it('returns both offline and warning when status=all (default)', async () => {
            mockGetOfflineMachines.mockReturnValue(['web1']);
            mockGetWarningMachines.mockReturnValue(['po-2023']);
            const result = await inventoryTool.execute({ type: 'machines' }, {});
            expect(result.data.offlineMachines).toEqual(['web1']);
            expect(result.data.warningMachines).toEqual(['po-2023']);
        });

        it('returns detailed data when includeDetails=true', async () => {
            mockGetOfflineMachines.mockReturnValue(['web1']);
            mockGetHeartbeatData.mockImplementation((mid: string) => {
                if (mid === 'web1') return {
                    machineId: 'web1',
                    lastHeartbeat: '2026-05-03T20:00:00.000Z',
                    offlineSince: '2026-05-03T22:00:00.000Z',
                    missedHeartbeats: 5,
                    metadata: { firstSeen: '2026-01-01', lastUpdated: '2026-05-03', version: '1.0' },
                };
                return null;
            });
            const result = await inventoryTool.execute({ type: 'machines', status: 'offline', includeDetails: true }, {});
            expect(result.data.offlineMachines).toHaveLength(1);
            expect(result.data.offlineMachines[0].machineId).toBe('web1');
            expect(result.data.offlineMachines[0].offlineSince).toBeDefined();
            expect(result.data.offlineCount).toBe(1);
        });

        it('skips machines without offlineSince in detailed offline mode', async () => {
            mockGetOfflineMachines.mockReturnValue(['web1']);
            mockGetHeartbeatData.mockReturnValue({
                machineId: 'web1',
                lastHeartbeat: '2026-05-04T00:00:00.000Z',
                offlineSince: undefined,
                missedHeartbeats: 0,
                metadata: {},
            });
            const result = await inventoryTool.execute({ type: 'machines', status: 'offline', includeDetails: true }, {});
            expect(result.data.offlineMachines).toHaveLength(0);
        });

        it('returns detailed warning machines', async () => {
            mockGetWarningMachines.mockReturnValue(['po-2023']);
            mockGetHeartbeatData.mockImplementation((mid: string) => ({
                machineId: mid,
                lastHeartbeat: '2026-05-04T00:00:00.000Z',
                missedHeartbeats: 2,
                metadata: { firstSeen: '2026-01-01', lastUpdated: '2026-05-04', version: '1.0' },
            }));
            const result = await inventoryTool.execute({ type: 'machines', status: 'warning', includeDetails: true }, {});
            expect(result.data.warningMachines).toHaveLength(1);
            expect(result.data.warningMachines[0].machineId).toBe('po-2023');
        });

        it('skips null heartbeat data in detailed mode', async () => {
            mockGetOfflineMachines.mockReturnValue(['unknown']);
            mockGetHeartbeatData.mockReturnValue(null);
            const result = await inventoryTool.execute({ type: 'machines', status: 'offline', includeDetails: true }, {});
            expect(result.data.offlineMachines).toHaveLength(0);
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
