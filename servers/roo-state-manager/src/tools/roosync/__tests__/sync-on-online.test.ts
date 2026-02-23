/**
 * Tests for sync-on-online.ts
 * Issue #492 - Coverage for roosync sync-on-online tool
 *
 * @module tools/roosync/__tests__/sync-on-online
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

import { roosyncSyncOnOnline, SyncOnOnlineArgsSchema, syncOnOnlineToolMetadata } from '../sync-on-online.js';
import { HeartbeatServiceError } from '../../../services/roosync/HeartbeatService.js';

describe('roosyncSyncOnOnline', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('schema requires machineId', () => {
		expect(SyncOnOnlineArgsSchema.safeParse({}).success).toBe(false);
	});

	test('schema validates all optional fields', () => {
		const result = SyncOnOnlineArgsSchema.safeParse({
			machineId: 'ai-01',
			createBackup: false,
			dryRun: true,
			syncFromBaseline: false
		});
		expect(result.success).toBe(true);
	});

	test('metadata has correct tool name', () => {
		expect(syncOnOnlineToolMetadata.name).toBe('roosync_sync_on_online');
		expect(syncOnOnlineToolMetadata.inputSchema.required).toEqual(['machineId']);
	});

	test('throws when machine is not online', async () => {
		mockGetHeartbeatData.mockReturnValue({ status: 'offline' });

		await expect(roosyncSyncOnOnline({ machineId: 'po-2023' }))
			.rejects.toThrow('n\'est pas online');
	});

	test('throws when machine data is null', async () => {
		mockGetHeartbeatData.mockReturnValue(null);

		await expect(roosyncSyncOnOnline({ machineId: 'ghost' }))
			.rejects.toThrow('n\'est pas online');
	});

	test('returns dry run result', async () => {
		mockGetHeartbeatData.mockReturnValue({ status: 'online' });

		const result = await roosyncSyncOnOnline({ machineId: 'ai-01', dryRun: true });

		expect(result.success).toBe(true);
		expect(result.backupCreated).toBe(false);
		expect(result.message).toContain('simulation');
	});

	test('computes offlineDuration from offlineSince', async () => {
		const fiveMinAgo = new Date(Date.now() - 300000).toISOString();
		mockGetHeartbeatData.mockReturnValue({ status: 'online', offlineSince: fiveMinAgo });

		const result = await roosyncSyncOnOnline({ machineId: 'ai-01', dryRun: true });

		expect(result.changes.offlineDuration).toBeGreaterThan(0);
		expect(result.changes.offlineDuration).toBeLessThan(600000); // < 10min
	});

	test('offlineDuration is undefined when no offlineSince', async () => {
		mockGetHeartbeatData.mockReturnValue({ status: 'online' });

		const result = await roosyncSyncOnOnline({ machineId: 'ai-01', dryRun: true });

		expect(result.changes.offlineDuration).toBeUndefined();
	});

	test('returns success with backup by default', async () => {
		mockGetHeartbeatData.mockReturnValue({ status: 'online' });

		const result = await roosyncSyncOnOnline({ machineId: 'po-2023' });

		expect(result.success).toBe(true);
		expect(result.backupCreated).toBe(true);
		expect(result.backupPath).toContain('po-2023');
	});

	test('returns success without backup when createBackup=false', async () => {
		mockGetHeartbeatData.mockReturnValue({ status: 'online' });

		const result = await roosyncSyncOnOnline({ machineId: 'ai-01', createBackup: false });

		expect(result.backupCreated).toBe(false);
		expect(result.backupPath).toBeUndefined();
	});

	test('re-throws HeartbeatServiceError directly', async () => {
		const hbError = new HeartbeatServiceError('Not ready', 'NOT_READY');
		mockGetHeartbeatData.mockImplementation(() => { throw hbError; });

		await expect(roosyncSyncOnOnline({ machineId: 'ai-01' }))
			.rejects.toThrow('Not ready');
	});

	test('wraps generic errors with SYNC_ONLINE_FAILED code', async () => {
		mockGetHeartbeatData.mockImplementation(() => { throw new Error('Disk full'); });

		try {
			await roosyncSyncOnOnline({ machineId: 'ai-01' });
			expect.unreachable('Should have thrown');
		} catch (error: any) {
			expect(error.code).toBe('SYNC_ONLINE_FAILED');
			expect(error.message).toContain('Disk full');
		}
	});
});
