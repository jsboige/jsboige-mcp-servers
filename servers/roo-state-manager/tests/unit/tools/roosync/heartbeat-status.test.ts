/**
 * Tests for roosync_heartbeat_status tool
 *
 * Covers: filter=all/online/unknown/idle, includeHeartbeats,
 * forceCheck, includeChanges, error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { roosyncHeartbeatStatus } from '../../../../src/tools/roosync/heartbeat-status.js';

const {
    mockGetHeartbeatService,
    mockCheckHeartbeats,
    mockGetState,
} = vi.hoisted(() => ({
    mockGetHeartbeatService: vi.fn(),
    mockCheckHeartbeats: vi.fn(),
    mockGetState: vi.fn(),
}));

vi.mock('../../../../src/services/lazy-roosync.js', () => ({
    getRooSyncService: vi.fn(() =>
        Promise.resolve({ getHeartbeatService: mockGetHeartbeatService })
    ),
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

const defaultState = {
    onlineMachines: ['ai-01', 'po-2023'],
    unknownMachines: ['web1'],
    idleMachines: ['po-2024'],
    statistics: {
        totalMachines: 4,
        onlineCount: 2,
        offlineCount: 1,
        warningCount: 1,
        lastHeartbeatCheck: '2026-05-04T00:00:00.000Z',
    },
    heartbeats: new Map([
        ['ai-01', { machineId: 'ai-01', status: 'online', lastHeartbeat: '2026-05-04T00:00:00.000Z' }],
        ['po-2023', { machineId: 'po-2023', status: 'online', lastHeartbeat: '2026-05-04T00:00:00.000Z' }],
        ['web1', { machineId: 'web1', status: 'unknown', lastHeartbeat: '2026-05-03T20:00:00.000Z' }],
        ['po-2024', { machineId: 'po-2024', status: 'idle', lastHeartbeat: '2026-05-04T00:00:00.000Z' }],
    ]),
};

describe('roosync_heartbeat_status', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetHeartbeatService.mockReturnValue({
            checkHeartbeats: mockCheckHeartbeats,
            getState: mockGetState.mockReturnValue(defaultState),
        });
    });

    it('returns full status with filter=all (default)', async () => {
        const result = await roosyncHeartbeatStatus({});
        expect(result.success).toBe(true);
        expect(result.onlineMachines).toEqual(['ai-01', 'po-2023']);
        expect(result.unknownMachines).toEqual(['web1']);
        expect(result.idleMachines).toEqual(['po-2024']);
        expect(result.statistics.totalMachines).toBe(4);
    });

    it('returns only online machines with filter=online', async () => {
        const result = await roosyncHeartbeatStatus({ filter: 'online' });
        expect(result.onlineMachines).toEqual(['ai-01', 'po-2023']);
        expect(result.unknownMachines).toEqual([]);
        expect(result.idleMachines).toEqual([]);
    });

    it('returns only unknown machines with filter=unknown', async () => {
        const result = await roosyncHeartbeatStatus({ filter: 'unknown' });
        expect(result.onlineMachines).toEqual([]);
        expect(result.unknownMachines).toEqual(['web1']);
        expect(result.idleMachines).toEqual([]);
    });

    it('returns only idle machines with filter=idle', async () => {
        const result = await roosyncHeartbeatStatus({ filter: 'idle' });
        expect(result.onlineMachines).toEqual([]);
        expect(result.unknownMachines).toEqual([]);
        expect(result.idleMachines).toEqual(['po-2024']);
    });

    describe('includeHeartbeats', () => {
        it('includes all heartbeats by default', async () => {
            const result = await roosyncHeartbeatStatus({});
            expect(result.heartbeats).toBeDefined();
            expect(Object.keys(result.heartbeats!)).toHaveLength(4);
        });

        it('excludes heartbeats when false', async () => {
            const result = await roosyncHeartbeatStatus({ includeHeartbeats: false });
            expect(result.heartbeats).toBeUndefined();
        });

        it('filters heartbeats with filter=online', async () => {
            const result = await roosyncHeartbeatStatus({ filter: 'online' });
            expect(result.heartbeats).toBeDefined();
            expect(Object.keys(result.heartbeats!)).toHaveLength(2);
            expect(result.heartbeats!['ai-01']).toBeDefined();
            expect(result.heartbeats!['web1']).toBeUndefined();
        });

        it('filters heartbeats with filter=unknown', async () => {
            const result = await roosyncHeartbeatStatus({ filter: 'unknown' });
            expect(result.heartbeats).toBeDefined();
            expect(Object.keys(result.heartbeats!)).toHaveLength(1);
            expect(result.heartbeats!['web1']).toBeDefined();
        });

        it('filters heartbeats with filter=idle', async () => {
            const result = await roosyncHeartbeatStatus({ filter: 'idle' });
            expect(result.heartbeats).toBeDefined();
            expect(Object.keys(result.heartbeats!)).toHaveLength(1);
            expect(result.heartbeats!['po-2024']).toBeDefined();
        });
    });

    describe('forceCheck and includeChanges', () => {
        it('checks heartbeats with forceCheck=true', async () => {
            mockCheckHeartbeats.mockResolvedValue({
                newlyUnknownMachines: ['web1'],
                newlyOnlineMachines: ['po-2023'],
                idleMachines: ['po-2024'],
            });
            const result = await roosyncHeartbeatStatus({ forceCheck: true });
            expect(mockCheckHeartbeats).toHaveBeenCalled();
            expect(result.changes).toBeDefined();
            expect(result.changes!.newlyUnknownMachines).toEqual(['web1']);
            expect(result.changes!.totalChanges).toBe(3);
        });

        it('checks heartbeats with includeChanges=true', async () => {
            mockCheckHeartbeats.mockResolvedValue({
                newlyUnknownMachines: [],
                newlyOnlineMachines: [],
                idleMachines: [],
            });
            const result = await roosyncHeartbeatStatus({ includeChanges: true });
            expect(mockCheckHeartbeats).toHaveBeenCalled();
            expect(result.changes).toBeDefined();
            expect(result.changes!.totalChanges).toBe(0);
        });

        it('skips check when neither forceCheck nor includeChanges', async () => {
            await roosyncHeartbeatStatus({});
            expect(mockCheckHeartbeats).not.toHaveBeenCalled();
        });
    });

    it('includes retrievedAt timestamp', async () => {
        const result = await roosyncHeartbeatStatus({});
        expect(result.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    describe('error handling', () => {
        it('re-throws HeartbeatServiceError as-is', async () => {
            const { HeartbeatServiceError } = await import('../../../../src/services/roosync/HeartbeatService.js');
            mockGetHeartbeatService.mockReturnValue({
                getState: () => { throw new HeartbeatServiceError('Service down', 'SERVICE_DOWN'); },
            });
            await expect(roosyncHeartbeatStatus({}))
                .rejects.toThrow('Service down');
        });

        it('wraps unexpected errors', async () => {
            mockGetHeartbeatService.mockReturnValue({
                getState: () => { throw new Error('Unexpected crash'); },
            });
            try {
                await roosyncHeartbeatStatus({});
                expect.fail('should have thrown');
            } catch (err: any) {
                expect(err.name).toBe('HeartbeatServiceError');
                expect(err.message).toContain('Unexpected crash');
            }
        });
    });

    describe('metadata', () => {
        it('has correct tool metadata', async () => {
            const { heartbeatStatusToolMetadata } = await import('../../../../src/tools/roosync/heartbeat-status.js');
            expect(heartbeatStatusToolMetadata.name).toBe('roosync_heartbeat_status');
            expect(heartbeatStatusToolMetadata.inputSchema.properties.filter.enum).toContain('all');
        });
    });
});
