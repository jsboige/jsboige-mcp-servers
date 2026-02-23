/**
 * Tests for sync-on-offline.ts
 * Issue #492 - Coverage for roosync sync-on-offline tool
 *
 * @module tools/roosync/__tests__/sync-on-offline
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockGetHeartbeatData } = vi.hoisted(() => ({
	mockGetHeartbeatData: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: vi.fn(() => ({
		getHeartbeatService: () => ({
			getHeartbeatData: mockGetHeartbeatData
		})
	}))
}));

vi.mock('../../../services/roosync/HeartbeatService.js', () => {
	class HeartbeatServiceError extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message);
			this.name = 'HeartbeatServiceError';
			this.code = code;
		}
	}
	return { HeartbeatServiceError };
});

import { roosyncSyncOnOffline, SyncOnOfflineArgsSchema, syncOnOfflineToolMetadata } from '../sync-on-offline.js';
import { HeartbeatServiceError } from '../../../services/roosync/HeartbeatService.js';

describe('roosyncSyncOnOffline', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('schema requires machineId', () => {
		const result = SyncOnOfflineArgsSchema.safeParse({});
		expect(result.success).toBe(false);
	});

	test('schema validates machineId with optional fields', () => {
		const result = SyncOnOfflineArgsSchema.safeParse({
			machineId: 'po-2023',
			createBackup: false,
			dryRun: true
		});
		expect(result.success).toBe(true);
	});

	test('metadata has correct tool name', () => {
		expect(syncOnOfflineToolMetadata.name).toBe('roosync_sync_on_offline');
		expect(syncOnOfflineToolMetadata.inputSchema.required).toEqual(['machineId']);
	});

	test('throws when machine is not offline', async () => {
		mockGetHeartbeatData.mockReturnValue({ status: 'online' });

		await expect(roosyncSyncOnOffline({ machineId: 'ai-01' }))
			.rejects.toThrow('n\'est pas offline');
	});

	test('throws when machine data is null', async () => {
		mockGetHeartbeatData.mockReturnValue(null);

		await expect(roosyncSyncOnOffline({ machineId: 'ghost' }))
			.rejects.toThrow('n\'est pas offline');
	});

	test('returns dry run result without sync', async () => {
		mockGetHeartbeatData.mockReturnValue({ status: 'offline' });

		const result = await roosyncSyncOnOffline({
			machineId: 'po-2023',
			dryRun: true
		});

		expect(result.success).toBe(true);
		expect(result.machineId).toBe('po-2023');
		expect(result.backupCreated).toBe(false);
		expect(result.changes.filesSynced).toBe(0);
		expect(result.message).toContain('simulation');
	});

	test('returns success with backup when createBackup=true (default)', async () => {
		mockGetHeartbeatData.mockReturnValue({ status: 'offline' });

		const result = await roosyncSyncOnOffline({ machineId: 'po-2023' });

		expect(result.success).toBe(true);
		expect(result.backupCreated).toBe(true);
		expect(result.backupPath).toContain('po-2023');
		expect(result.syncedAt).toBeTruthy();
	});

	test('returns success without backup when createBackup=false', async () => {
		mockGetHeartbeatData.mockReturnValue({ status: 'offline' });

		const result = await roosyncSyncOnOffline({
			machineId: 'po-2023',
			createBackup: false
		});

		expect(result.backupCreated).toBe(false);
		expect(result.backupPath).toBeUndefined();
	});

	test('re-throws HeartbeatServiceError directly', async () => {
		const hbError = new HeartbeatServiceError('Service down', 'SERVICE_DOWN');
		mockGetHeartbeatData.mockImplementation(() => { throw hbError; });

		await expect(roosyncSyncOnOffline({ machineId: 'ai-01' }))
			.rejects.toThrow('Service down');
	});

	test('wraps generic errors with SYNC_OFFLINE_FAILED code', async () => {
		mockGetHeartbeatData.mockImplementation(() => { throw new Error('IO failure'); });

		try {
			await roosyncSyncOnOffline({ machineId: 'ai-01' });
			expect.unreachable('Should have thrown');
		} catch (error: any) {
			expect(error.code).toBe('SYNC_OFFLINE_FAILED');
			expect(error.message).toContain('IO failure');
		}
	});
});
