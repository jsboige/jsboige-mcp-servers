/**
 * Tests for sync-on-offline and sync-on-online tools
 *
 * Both are deprecated wrappers. Covers: status validation,
 * dryRun mode, backup creation, offline duration, error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    roosyncSyncOnOffline,
    syncOnOfflineToolMetadata,
} from '../../../../src/tools/roosync/sync-on-offline.js';
import {
    roosyncSyncOnOnline,
    syncOnOnlineToolMetadata,
} from '../../../../src/tools/roosync/sync-on-online.js';

const {
    mockGetRooSyncService,
    mockGetHeartbeatData,
} = vi.hoisted(() => ({
    mockGetRooSyncService: vi.fn(),
    mockGetHeartbeatData: vi.fn(),
}));

vi.mock('../../../../src/services/lazy-roosync.js', () => ({
    getRooSyncService: mockGetRooSyncService,
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
        }),
    });
}

describe('sync-on-offline', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupService();
    });

    it('syncs offline machine with backup', async () => {
        mockGetHeartbeatData.mockReturnValue({ status: 'offline' });
        const result = await roosyncSyncOnOffline({
            machineId: 'myia-po-2025',
        });
        expect(result.success).toBe(true);
        expect(result.machineId).toBe('myia-po-2025');
        expect(result.backupCreated).toBe(true);
        expect(result.backupPath).toContain('offline-sync');
        expect(result.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('skips backup when createBackup=false', async () => {
        mockGetHeartbeatData.mockReturnValue({ status: 'offline' });
        const result = await roosyncSyncOnOffline({
            machineId: 'myia-po-2025',
            createBackup: false,
        });
        expect(result.backupCreated).toBe(false);
        expect(result.backupPath).toBeUndefined();
    });

    it('returns dry-run result without changes', async () => {
        mockGetHeartbeatData.mockReturnValue({ status: 'offline' });
        const result = await roosyncSyncOnOffline({
            machineId: 'myia-po-2025',
            dryRun: true,
        });
        expect(result.success).toBe(true);
        expect(result.message).toContain('simulation');
        expect(result.changes.filesSynced).toBe(0);
    });

    it('throws when machine is not offline', async () => {
        mockGetHeartbeatData.mockReturnValue({ status: 'online' });
        await expect(roosyncSyncOnOffline({ machineId: 'myia-po-2025' }))
            .rejects.toThrow('pas offline');
    });

    it('throws when machine heartbeat data missing', async () => {
        mockGetHeartbeatData.mockReturnValue(null);
        await expect(roosyncSyncOnOffline({ machineId: 'unknown' }))
            .rejects.toThrow('pas offline');
    });

    it('wraps unexpected errors', async () => {
        mockGetHeartbeatData.mockImplementation(() => { throw new Error('DB error'); });
        await expect(roosyncSyncOnOffline({ machineId: 'test' }))
            .rejects.toThrow('DB error');
    });

    it('has correct metadata', () => {
        expect(syncOnOfflineToolMetadata.name).toBe('roosync_sync_on_offline');
        expect(syncOnOfflineToolMetadata.inputSchema.required).toContain('machineId');
    });
});

describe('sync-on-online', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupService();
    });

    it('syncs online machine with backup', async () => {
        mockGetHeartbeatData.mockReturnValue({ status: 'online' });
        const result = await roosyncSyncOnOnline({
            machineId: 'myia-po-2025',
        });
        expect(result.success).toBe(true);
        expect(result.backupCreated).toBe(true);
        expect(result.backupPath).toContain('online-sync');
    });

    it('calculates offline duration when available', async () => {
        mockGetHeartbeatData.mockReturnValue({
            status: 'online',
            offlineSince: new Date(Date.now() - 3600000).toISOString(),
        });
        const result = await roosyncSyncOnOnline({ machineId: 'myia-po-2025' });
        expect(result.changes.offlineDuration).toBeGreaterThan(3500000);
    });

    it('returns dry-run result', async () => {
        mockGetHeartbeatData.mockReturnValue({ status: 'online' });
        const result = await roosyncSyncOnOnline({
            machineId: 'myia-po-2025',
            dryRun: true,
        });
        expect(result.message).toContain('simulation');
    });

    it('throws when machine is not online', async () => {
        mockGetHeartbeatData.mockReturnValue({ status: 'offline' });
        await expect(roosyncSyncOnOnline({ machineId: 'myia-po-2025' }))
            .rejects.toThrow('pas online');
    });

    it('throws when heartbeat data missing', async () => {
        mockGetHeartbeatData.mockReturnValue(null);
        await expect(roosyncSyncOnOnline({ machineId: 'unknown' }))
            .rejects.toThrow('pas online');
    });

    it('wraps unexpected errors', async () => {
        mockGetHeartbeatData.mockImplementation(() => { throw new Error('IO error'); });
        await expect(roosyncSyncOnOnline({ machineId: 'test' }))
            .rejects.toThrow('IO error');
    });

    it('has correct metadata', () => {
        expect(syncOnOnlineToolMetadata.name).toBe('roosync_sync_on_online');
        expect(syncOnOnlineToolMetadata.inputSchema.required).toContain('machineId');
    });
});
