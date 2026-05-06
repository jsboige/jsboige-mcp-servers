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
const mockGetUnknownMachines = vi.fn();
const mockGetIdleMachines = vi.fn();
const mockGetHeartbeatData = vi.fn();

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
        expect(inventoryTool.version).toBe('4.0.0');
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

    describe('type=machines (fused from roosync_machines)', () => {
        it('returns offline machines when status=offline', async () => {
            mockGetUnknownMachines.mockReturnValue(['web1', 'po-2024']);
            const result = await inventoryTool.execute({ type: 'machines', status: 'offline' }, {});
            expect(result.success).toBe(true);
            expect(result.data.unknownMachines).toEqual(['web1', 'po-2024']);
            expect(result.data.unknownCount).toBe(2);
        });

        it('returns warning machines when status=warning', async () => {
            mockGetIdleMachines.mockReturnValue(['po-2023']);
            const result = await inventoryTool.execute({ type: 'machines', status: 'warning' }, {});
            expect(result.success).toBe(true);
            expect(result.data.idleMachines).toEqual(['po-2023']);
            expect(result.data.idleCount).toBe(1);
        });

        it('returns both offline and warning when status=all (default)', async () => {
            mockGetUnknownMachines.mockReturnValue(['web1']);
            mockGetIdleMachines.mockReturnValue(['po-2023']);
            const result = await inventoryTool.execute({ type: 'machines' }, {});
            expect(result.data.unknownMachines).toEqual(['web1']);
            expect(result.data.idleMachines).toEqual(['po-2023']);
        });

        it('returns detailed data when includeDetails=true', async () => {
            mockGetUnknownMachines.mockReturnValue(['web1']);
            mockGetHeartbeatData.mockImplementation((mid: string) => {
                if (mid === 'web1') return {
                    machineId: 'web1',
                    lastHeartbeat: '2026-05-03T20:00:00.000Z',
                    status: 'unknown',
                    metadata: { firstSeen: '2026-01-01', lastUpdated: '2026-05-03' },
                };
                return null;
            });
            const result = await inventoryTool.execute({ type: 'machines', status: 'offline', includeDetails: true }, {});
            expect(result.data.unknownMachines).toHaveLength(1);
            expect(result.data.unknownMachines[0].machineId).toBe('web1');
            expect(result.data.unknownMachines[0].status).toBe('unknown');
            expect(result.data.unknownCount).toBe(1);
        });

        it('skips machines without heartbeat data in detailed offline mode', async () => {
            mockGetUnknownMachines.mockReturnValue(['web1']);
            mockGetHeartbeatData.mockReturnValue(null);
            const result = await inventoryTool.execute({ type: 'machines', status: 'offline', includeDetails: true }, {});
            expect(result.data.unknownMachines).toHaveLength(0);
        });

        it('returns detailed warning machines', async () => {
            mockGetIdleMachines.mockReturnValue(['po-2023']);
            mockGetHeartbeatData.mockImplementation((mid: string) => ({
                machineId: mid,
                lastHeartbeat: '2026-05-04T00:00:00.000Z',
                status: 'idle',
                metadata: { firstSeen: '2026-01-01', lastUpdated: '2026-05-04' },
            }));
            const result = await inventoryTool.execute({ type: 'machines', status: 'warning', includeDetails: true }, {});
            expect(result.data.idleMachines).toHaveLength(1);
            expect(result.data.idleMachines[0].machineId).toBe('po-2023');
        });

        it('skips null heartbeat data in detailed mode', async () => {
            mockGetUnknownMachines.mockReturnValue(['unknown']);
            mockGetHeartbeatData.mockReturnValue(null);
            const result = await inventoryTool.execute({ type: 'machines', status: 'offline', includeDetails: true }, {});
            expect(result.data.unknownMachines).toHaveLength(0);
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
