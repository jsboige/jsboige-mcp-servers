/**
 * Tests for deprecated sync tools: sync-on-offline, sync-on-online, get-heartbeat-state
 *
 * Covers: status validation, dryRun, backup, offlineDuration, includeHeartbeats
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { roosyncSyncOnOffline, syncOnOfflineToolMetadata } from '../../../../src/tools/roosync/sync-on-offline.js';
import { roosyncSyncOnOnline, syncOnOnlineToolMetadata } from '../../../../src/tools/roosync/sync-on-online.js';
import { roosyncGetHeartbeatState, getHeartbeatStateToolMetadata } from '../../../../src/tools/roosync/get-heartbeat-state.js';

const {
    mockGetRooSyncService,
    mockGetHeartbeatData,
    mockGetState,
} = vi.hoisted(() => ({
    mockGetRooSyncService: vi.fn(),
    mockGetHeartbeatData: vi.fn(),
    mockGetState: vi.fn(),
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

function setupService() {
    mockGetRooSyncService.mockResolvedValue({
        getHeartbeatService: () => ({
            getHeartbeatData: mockGetHeartbeatData,
            getState: mockGetState,
        }),
    });
}

describe('sync-on-offline tool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupService();
    });

    it('succeeds when machine is offline', async () => {
        mockGetHeartbeatData.mockReturnValue({ machineId: 'web1', status: 'offline' });
        const result = await roosyncSyncOnOffline({ machineId: 'web1' });
        expect(result.success).toBe(true);
        expect(result.machineId).toBe('web1');
        expect(result.message).toContain('offline');
        expect(result.backupCreated).toBe(true);
        expect(result.backupPath).toBeDefined();
    });

    it('throws when machine is not offline', async () => {
        mockGetHeartbeatData.mockReturnValue({ machineId: 'web1', status: 'online' });
        await expect(roosyncSyncOnOffline({ machineId: 'web1' }))
            .rejects.toThrow('pas offline');
    });

    it('throws when machine not found', async () => {
        mockGetHeartbeatData.mockReturnValue(null);
        await expect(roosyncSyncOnOffline({ machineId: 'unknown' }))
            .rejects.toThrow('pas offline');
    });

    it('dryRun returns simulation without backup', async () => {
        mockGetHeartbeatData.mockReturnValue({ machineId: 'web1', status: 'offline' });
        const result = await roosyncSyncOnOffline({ machineId: 'web1', dryRun: true });
        expect(result.success).toBe(true);
        expect(result.backupCreated).toBe(false);
        expect(result.message).toContain('simulation');
    });

    it('skips backup when createBackup=false', async () => {
        mockGetHeartbeatData.mockReturnValue({ machineId: 'web1', status: 'offline' });
        const result = await roosyncSyncOnOffline({ machineId: 'web1', createBackup: false });
        expect(result.backupCreated).toBe(false);
        expect(result.backupPath).toBeUndefined();
    });

    it('wraps unexpected errors', async () => {
        mockGetHeartbeatData.mockImplementation(() => { throw new Error('Unexpected'); });
        await expect(roosyncSyncOnOffline({ machineId: 'web1' }))
            .rejects.toThrow('Unexpected');
    });

    it('has correct metadata', () => {
        expect(syncOnOfflineToolMetadata.name).toBe('roosync_sync_on_offline');
        expect(syncOnOfflineToolMetadata.inputSchema.required).toContain('machineId');
    });
});

describe('sync-on-online tool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupService();
    });

    it('succeeds when machine is online', async () => {
        mockGetHeartbeatData.mockReturnValue({ machineId: 'po-2023', status: 'online' });
        const result = await roosyncSyncOnOnline({ machineId: 'po-2023' });
        expect(result.success).toBe(true);
        expect(result.message).toContain('online');
    });

    it('calculates offlineDuration from offlineSince', async () => {
        mockGetHeartbeatData.mockReturnValue({
            machineId: 'po-2023',
            status: 'online',
            offlineSince: '2026-05-03T20:00:00.000Z',
        });
        const result = await roosyncSyncOnOnline({ machineId: 'po-2023' });
        expect(result.changes.offlineDuration).toBeGreaterThan(0);
    });

    it('omits offlineDuration when offlineSince missing', async () => {
        mockGetHeartbeatData.mockReturnValue({ machineId: 'po-2023', status: 'online' });
        const result = await roosyncSyncOnOnline({ machineId: 'po-2023' });
        expect(result.changes.offlineDuration).toBeUndefined();
    });

    it('throws when machine is not online', async () => {
        mockGetHeartbeatData.mockReturnValue({ machineId: 'po-2023', status: 'offline' });
        await expect(roosyncSyncOnOnline({ machineId: 'po-2023' }))
            .rejects.toThrow('pas online');
    });

    it('dryRun returns simulation without backup', async () => {
        mockGetHeartbeatData.mockReturnValue({ machineId: 'po-2023', status: 'online' });
        const result = await roosyncSyncOnOnline({ machineId: 'po-2023', dryRun: true });
        expect(result.backupCreated).toBe(false);
        expect(result.message).toContain('simulation');
    });

    it('skips backup when createBackup=false', async () => {
        mockGetHeartbeatData.mockReturnValue({ machineId: 'po-2023', status: 'online' });
        const result = await roosyncSyncOnOnline({ machineId: 'po-2023', createBackup: false });
        expect(result.backupCreated).toBe(false);
    });

    it('wraps unexpected errors', async () => {
        mockGetHeartbeatData.mockImplementation(() => { throw new Error('Unexpected'); });
        await expect(roosyncSyncOnOnline({ machineId: 'po-2023' }))
            .rejects.toThrow('Unexpected');
    });

    it('has correct metadata', () => {
        expect(syncOnOnlineToolMetadata.name).toBe('roosync_sync_on_online');
        expect(syncOnOnlineToolMetadata.inputSchema.required).toContain('machineId');
    });
});

describe('get-heartbeat-state tool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupService();
    });

    it('returns full state with heartbeats by default', async () => {
        mockGetState.mockReturnValue({
            onlineMachines: ['ai-01'],
            offlineMachines: ['web1'],
            warningMachines: [],
            statistics: { totalMachines: 2, onlineCount: 1, offlineCount: 1, warningCount: 0, lastHeartbeatCheck: '2026-05-04T00:00:00.000Z' },
            heartbeats: new Map([
                ['ai-01', { machineId: 'ai-01', status: 'online', lastHeartbeat: '2026-05-04T00:00:00.000Z' }],
            ]),
        });
        const result = await roosyncGetHeartbeatState({});
        expect(result.success).toBe(true);
        expect(result.onlineMachines).toEqual(['ai-01']);
        expect(result.offlineMachines).toEqual(['web1']);
        expect(result.heartbeats).toBeDefined();
        expect(result.heartbeats!['ai-01']).toBeDefined();
    });

    it('excludes heartbeats when includeHeartbeats=false', async () => {
        mockGetState.mockReturnValue({
            onlineMachines: [],
            offlineMachines: [],
            warningMachines: [],
            statistics: { totalMachines: 0, onlineCount: 0, offlineCount: 0, warningCount: 0, lastHeartbeatCheck: '' },
            heartbeats: new Map(),
        });
        const result = await roosyncGetHeartbeatState({ includeHeartbeats: false });
        expect(result.heartbeats).toBeUndefined();
    });

    it('includes retrievedAt timestamp', async () => {
        mockGetState.mockReturnValue({
            onlineMachines: [], offlineMachines: [], warningMachines: [],
            statistics: { totalMachines: 0, onlineCount: 0, offlineCount: 0, warningCount: 0, lastHeartbeatCheck: '' },
            heartbeats: new Map(),
        });
        const result = await roosyncGetHeartbeatState({});
        expect(result.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('wraps unexpected errors', async () => {
        mockGetState.mockImplementation(() => { throw new Error('Service down'); });
        await expect(roosyncGetHeartbeatState({}))
            .rejects.toThrow('Service down');
    });

    it('has correct metadata', () => {
        expect(getHeartbeatStateToolMetadata.name).toBe('roosync_get_heartbeat_state');
    });
});
