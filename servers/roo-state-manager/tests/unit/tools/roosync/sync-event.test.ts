/**
 * Tests for roosync_sync_event tool
 *
 * Covers: action=online, action=offline, dryRun, createBackup,
 * error handling (wrong status, missing machine)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { roosyncSyncEvent } from '../../../../src/tools/roosync/sync-event.js';

const {
    mockGetHeartbeatService,
    mockGetHeartbeatData,
} = vi.hoisted(() => ({
    mockGetHeartbeatService: vi.fn(),
    mockGetHeartbeatData: vi.fn(),
}));

vi.mock('../../../../src/services/lazy-roosync.js', () => ({
    getRooSyncService: vi.fn(() =>
        Promise.resolve({
            getHeartbeatService: mockGetHeartbeatService,
        })
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

describe('roosync_sync_event', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetHeartbeatService.mockReturnValue({
            getHeartbeatData: mockGetHeartbeatData,
        });
    });

    describe('action=online', () => {
        it('succeeds when machine is online', async () => {
            mockGetHeartbeatData.mockReturnValue({
                machineId: 'po-2023',
                status: 'online',
                offlineSince: '2026-05-03T20:00:00.000Z',
                lastHeartbeat: '2026-05-04T00:00:00.000Z',
            });
            const result = await roosyncSyncEvent({ action: 'online', machineId: 'po-2023' });
            expect(result.success).toBe(true);
            expect(result.action).toBe('online');
            expect(result.machineId).toBe('po-2023');
            expect(result.message).toContain('online');
        });

        it('calculates offlineDuration from offlineSince', async () => {
            mockGetHeartbeatData.mockReturnValue({
                machineId: 'po-2023',
                status: 'online',
                offlineSince: '2026-05-03T20:00:00.000Z',
            });
            const result = await roosyncSyncEvent({ action: 'online', machineId: 'po-2023' });
            expect(result.changes.offlineDuration).toBeGreaterThan(0);
        });

        it('throws when machine is not online', async () => {
            mockGetHeartbeatData.mockReturnValue({
                machineId: 'po-2023',
                status: 'offline',
            });
            await expect(roosyncSyncEvent({ action: 'online', machineId: 'po-2023' }))
                .rejects.toThrow('pas online');
        });

        it('throws when machine not found', async () => {
            mockGetHeartbeatData.mockReturnValue(null);
            await expect(roosyncSyncEvent({ action: 'online', machineId: 'unknown' }))
                .rejects.toThrow('pas online');
        });

        it('omits offlineDuration when offlineSince missing', async () => {
            mockGetHeartbeatData.mockReturnValue({
                machineId: 'po-2023',
                status: 'online',
                offlineSince: undefined,
            });
            const result = await roosyncSyncEvent({ action: 'online', machineId: 'po-2023' });
            expect(result.changes.offlineDuration).toBeUndefined();
        });
    });

    describe('action=offline', () => {
        it('succeeds when machine is offline', async () => {
            mockGetHeartbeatData.mockReturnValue({
                machineId: 'web1',
                status: 'offline',
            });
            const result = await roosyncSyncEvent({ action: 'offline', machineId: 'web1' });
            expect(result.success).toBe(true);
            expect(result.action).toBe('offline');
            expect(result.message).toContain('offline');
        });

        it('throws when machine is not offline', async () => {
            mockGetHeartbeatData.mockReturnValue({
                machineId: 'web1',
                status: 'online',
            });
            await expect(roosyncSyncEvent({ action: 'offline', machineId: 'web1' }))
                .rejects.toThrow('pas offline');
        });
    });

    describe('dryRun mode', () => {
        it('returns simulation result without backup', async () => {
            mockGetHeartbeatData.mockReturnValue({
                machineId: 'po-2023',
                status: 'online',
                offlineSince: '2026-05-03T20:00:00.000Z',
            });
            const result = await roosyncSyncEvent({
                action: 'online',
                machineId: 'po-2023',
                dryRun: true,
            });
            expect(result.success).toBe(true);
            expect(result.backupCreated).toBe(false);
            expect(result.changes.filesSynced).toBe(0);
            expect(result.message).toContain('simulation');
        });
    });

    describe('createBackup option', () => {
        it('creates backup by default', async () => {
            mockGetHeartbeatData.mockReturnValue({
                machineId: 'po-2023',
                status: 'online',
            });
            const result = await roosyncSyncEvent({ action: 'online', machineId: 'po-2023' });
            expect(result.backupCreated).toBe(true);
            expect(result.backupPath).toBeDefined();
        });

        it('skips backup when createBackup=false', async () => {
            mockGetHeartbeatData.mockReturnValue({
                machineId: 'po-2023',
                status: 'online',
            });
            const result = await roosyncSyncEvent({
                action: 'online',
                machineId: 'po-2023',
                createBackup: false,
            });
            expect(result.backupCreated).toBe(false);
            expect(result.backupPath).toBeUndefined();
        });

        it('includes machineId in backup path', async () => {
            mockGetHeartbeatData.mockReturnValue({
                machineId: 'po-2023',
                status: 'online',
            });
            const result = await roosyncSyncEvent({ action: 'online', machineId: 'po-2023' });
            expect(result.backupPath).toContain('po-2023');
        });
    });

    describe('error handling', () => {
        it('re-throws HeartbeatServiceError as-is', async () => {
            mockGetHeartbeatData.mockReturnValue({
                machineId: 'po-2023',
                status: 'offline',
            });
            try {
                await roosyncSyncEvent({ action: 'online', machineId: 'po-2023' });
                expect.fail('should have thrown');
            } catch (err: any) {
                expect(err.name).toBe('HeartbeatServiceError');
                expect(err.code).toBe('MACHINE_NOT_ONLINE');
            }
        });

        it('wraps unexpected errors in HeartbeatServiceError', async () => {
            mockGetHeartbeatService.mockReturnValue({
                getHeartbeatData: () => { throw new Error('Unexpected DB error'); },
            });
            try {
                await roosyncSyncEvent({ action: 'online', machineId: 'po-2023' });
                expect.fail('should have thrown');
            } catch (err: any) {
                expect(err.name).toBe('HeartbeatServiceError');
                expect(err.message).toContain('Unexpected DB error');
            }
        });
    });

    describe('metadata', () => {
        it('has correct tool metadata', async () => {
            const { syncEventToolMetadata } = await import('../../../../src/tools/roosync/sync-event.js');
            expect(syncEventToolMetadata.name).toBe('roosync_sync_event');
            expect(syncEventToolMetadata.inputSchema.required).toContain('action');
            expect(syncEventToolMetadata.inputSchema.required).toContain('machineId');
        });
    });
});
