/**
 * Tests for heartbeat helper tools: check-heartbeats, register-heartbeat, machines
 *
 * Covers: check results, register new/existing, machines with details
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { roosyncCheckHeartbeats, checkHeartbeatsToolMetadata } from '../../../../src/tools/roosync/check-heartbeats.js';
import { roosyncRegisterHeartbeat, registerHeartbeatToolMetadata } from '../../../../src/tools/roosync/register-heartbeat.js';
import { roosyncMachines, machinesTool, machinesToolMetadata } from '../../../../src/tools/roosync/machines.js';

const {
    mockGetRooSyncService,
    mockCheckHeartbeats,
    mockRegisterHeartbeat,
    mockGetHeartbeatData,
    mockGetOfflineMachines,
    mockGetWarningMachines,
} = vi.hoisted(() => ({
    mockGetRooSyncService: vi.fn(),
    mockCheckHeartbeats: vi.fn(),
    mockRegisterHeartbeat: vi.fn(),
    mockGetHeartbeatData: vi.fn(),
    mockGetOfflineMachines: vi.fn(),
    mockGetWarningMachines: vi.fn(),
}));

vi.mock('../../../../src/services/lazy-roosync.js', () => ({
    getRooSyncService: mockGetRooSyncService,
}));

vi.mock('../../../../src/services/roosync/HeartbeatService.js', () => ({
    HeartbeatServiceError: class extends Error {
        code: string;
        constructor(msg: string, code: string) {
            super(msg);
            this.code = code;
            this.name = 'HeartbeatServiceError';
        }
    },
}));

function setupHeartbeatService() {
    const service = {
        checkHeartbeats: mockCheckHeartbeats,
        registerHeartbeat: mockRegisterHeartbeat,
        getHeartbeatData: mockGetHeartbeatData,
        getOfflineMachines: mockGetOfflineMachines,
        getWarningMachines: mockGetWarningMachines,
    };
    mockGetRooSyncService.mockResolvedValue({
        getHeartbeatService: () => service,
    });
    return service;
}

describe('check-heartbeats tool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupHeartbeatService();
    });

    it('returns check results with changes', async () => {
        mockCheckHeartbeats.mockResolvedValue({
            success: true,
            newlyOfflineMachines: ['web1'],
            newlyOnlineMachines: ['po-2023'],
            warningMachines: ['po-2024'],
            checkedAt: '2026-05-04T00:00:00.000Z',
        });
        const result = await roosyncCheckHeartbeats({});
        expect(result.success).toBe(true);
        expect(result.newlyOfflineMachines).toEqual(['web1']);
        expect(result.newlyOnlineMachines).toEqual(['po-2023']);
        expect(result.summary.totalChanges).toBe(3);
        expect(result.summary.offlineCount).toBe(1);
    });

    it('returns empty when no changes', async () => {
        mockCheckHeartbeats.mockResolvedValue({
            success: true,
            newlyOfflineMachines: [],
            newlyOnlineMachines: [],
            warningMachines: [],
            checkedAt: '2026-05-04T00:00:00.000Z',
        });
        const result = await roosyncCheckHeartbeats({});
        expect(result.summary.totalChanges).toBe(0);
    });

    it('wraps non-HeartbeatServiceError', async () => {
        mockCheckHeartbeats.mockRejectedValue(new Error('Network failure'));
        await expect(roosyncCheckHeartbeats({}))
            .rejects.toThrow('Network failure');
    });

    it('re-throws HeartbeatServiceError as-is', async () => {
        const { HeartbeatServiceError } = await import('../../../../src/services/roosync/HeartbeatService.js');
        mockCheckHeartbeats.mockRejectedValue(new HeartbeatServiceError('Service down', 'SERVICE_DOWN'));
        await expect(roosyncCheckHeartbeats({}))
            .rejects.toThrow('Service down');
    });

    it('has correct metadata', () => {
        expect(checkHeartbeatsToolMetadata.name).toBe('roosync_check_heartbeats');
    });
});

describe('register-heartbeat tool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupHeartbeatService();
    });

    it('registers heartbeat for new machine', async () => {
        mockGetHeartbeatData
            .mockReturnValueOnce(null) // first call: doesn't exist
            .mockReturnValueOnce({     // second call: after registration
                machineId: 'po-2025',
                lastHeartbeat: '2026-05-04T01:00:00.000Z',
                status: 'online',
            });
        mockRegisterHeartbeat.mockResolvedValue(undefined);

        const result = await roosyncRegisterHeartbeat({ machineId: 'po-2025' });
        expect(result.success).toBe(true);
        expect(result.isNewMachine).toBe(true);
        expect(result.machineId).toBe('po-2025');
        expect(result.status).toBe('online');
    });

    it('registers heartbeat for existing machine', async () => {
        mockGetHeartbeatData
            .mockReturnValueOnce({ machineId: 'po-2025', status: 'online', lastHeartbeat: '2026-05-04T00:00:00.000Z' })
            .mockReturnValueOnce({ machineId: 'po-2025', status: 'online', lastHeartbeat: '2026-05-04T01:00:00.000Z' });
        mockRegisterHeartbeat.mockResolvedValue(undefined);

        const result = await roosyncRegisterHeartbeat({ machineId: 'po-2025' });
        expect(result.isNewMachine).toBe(false);
    });

    it('passes metadata to registerHeartbeat', async () => {
        mockGetHeartbeatData
            .mockReturnValueOnce(null)
            .mockReturnValueOnce({ machineId: 'po-2025', status: 'online', lastHeartbeat: '2026-05-04T01:00:00.000Z' });
        mockRegisterHeartbeat.mockResolvedValue(undefined);

        await roosyncRegisterHeartbeat({ machineId: 'po-2025', metadata: { lastActivity: 'test' } });
        expect(mockRegisterHeartbeat).toHaveBeenCalledWith('po-2025', { lastActivity: 'test' });
    });

    it('throws when data retrieval fails after registration', async () => {
        mockGetHeartbeatData
            .mockReturnValueOnce(null)
            .mockReturnValueOnce(null); // still null after register
        mockRegisterHeartbeat.mockResolvedValue(undefined);

        await expect(roosyncRegisterHeartbeat({ machineId: 'po-2025' }))
            .rejects.toThrow('Impossible de récupérer');
    });

    it('wraps unexpected errors', async () => {
        mockGetHeartbeatData.mockImplementation(() => { throw new Error('Unexpected'); });
        await expect(roosyncRegisterHeartbeat({ machineId: 'po-2025' }))
            .rejects.toThrow('Unexpected');
    });

    it('has correct metadata', () => {
        expect(registerHeartbeatToolMetadata.name).toBe('roosync_register_heartbeat');
        expect(registerHeartbeatToolMetadata.inputSchema.required).toContain('machineId');
    });
});

describe('machines tool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupHeartbeatService();
    });

    it('has correct tool metadata', () => {
        expect(machinesTool.name).toBe('roosync_machines');
        expect(machinesTool.version).toBe('3.0.0');
    });

    it('returns offline machines', async () => {
        mockGetOfflineMachines.mockReturnValue(['web1', 'po-2024']);
        const result = await roosyncMachines({ status: 'offline' });
        expect(result.success).toBe(true);
        expect(result.data.offlineMachines).toEqual(['web1', 'po-2024']);
        expect(result.data.offlineCount).toBe(2);
    });

    it('returns warning machines', async () => {
        mockGetWarningMachines.mockReturnValue(['po-2023']);
        const result = await roosyncMachines({ status: 'warning' });
        expect(result.success).toBe(true);
        expect(result.data.warningMachines).toEqual(['po-2023']);
        expect(result.data.warningCount).toBe(1);
    });

    it('returns both with status=all', async () => {
        mockGetOfflineMachines.mockReturnValue(['web1']);
        mockGetWarningMachines.mockReturnValue(['po-2023']);
        const result = await roosyncMachines({ status: 'all' });
        expect(result.data.offlineMachines).toEqual(['web1']);
        expect(result.data.warningMachines).toEqual(['po-2023']);
    });

    it('returns detailed offline machines', async () => {
        mockGetOfflineMachines.mockReturnValue(['web1']);
        mockGetHeartbeatData.mockReturnValue({
            machineId: 'web1',
            lastHeartbeat: '2026-05-03T20:00:00.000Z',
            offlineSince: '2026-05-03T22:00:00.000Z',
            missedHeartbeats: 5,
            metadata: { firstSeen: '2026-01-01', lastUpdated: '2026-05-03', version: '1.0' },
        });
        const result = await roosyncMachines({ status: 'offline', includeDetails: true });
        expect(result.data.offlineMachines).toHaveLength(1);
        expect(result.data.offlineMachines[0].machineId).toBe('web1');
        expect(result.data.offlineMachines[0].offlineSince).toBe('2026-05-03T22:00:00.000Z');
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
        const result = await roosyncMachines({ status: 'offline', includeDetails: true });
        expect(result.data.offlineMachines).toHaveLength(0);
    });

    it('returns detailed warning machines', async () => {
        mockGetWarningMachines.mockReturnValue(['po-2023']);
        mockGetHeartbeatData.mockReturnValue({
            machineId: 'po-2023',
            lastHeartbeat: '2026-05-04T00:00:00.000Z',
            missedHeartbeats: 2,
            metadata: { firstSeen: '2026-01-01', lastUpdated: '2026-05-04', version: '1.0' },
        });
        const result = await roosyncMachines({ status: 'warning', includeDetails: true });
        expect(result.data.warningMachines).toHaveLength(1);
        expect(result.data.warningMachines[0].machineId).toBe('po-2023');
    });

    it('skips null heartbeat data in detailed warning mode', async () => {
        mockGetWarningMachines.mockReturnValue(['unknown']);
        mockGetHeartbeatData.mockReturnValue(null);
        const result = await roosyncMachines({ status: 'warning', includeDetails: true });
        expect(result.data.warningMachines).toHaveLength(0);
    });

    it('includes execution time in metrics', async () => {
        mockGetOfflineMachines.mockReturnValue([]);
        const result = await roosyncMachines({ status: 'offline' });
        expect(result.metrics?.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('returns error on exception', async () => {
        mockGetOfflineMachines.mockImplementation(() => { throw new Error('Service down'); });
        const result = await roosyncMachines({ status: 'offline' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('MACHINES_COLLECTION_FAILED');
    });

    it('has correct standalone metadata', () => {
        expect(machinesToolMetadata.name).toBe('roosync_machines');
        expect(machinesToolMetadata.inputSchema.required).toContain('status');
    });
});
