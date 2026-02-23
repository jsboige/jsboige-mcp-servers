/**
 * Tests for get-offline-machines.ts
 * Issue #492 - Coverage for roosync offline machines tool
 *
 * @module tools/roosync/__tests__/get-offline-machines
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockGetOfflineMachines, mockGetHeartbeatData } = vi.hoisted(() => ({
	mockGetOfflineMachines: vi.fn(),
	mockGetHeartbeatData: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: vi.fn(() => ({
		getHeartbeatService: () => ({
			getOfflineMachines: mockGetOfflineMachines,
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

import { roosyncGetOfflineMachines, GetOfflineMachinesArgsSchema, getOfflineMachinesToolMetadata } from '../get-offline-machines.js';
import { HeartbeatServiceError } from '../../../services/roosync/HeartbeatService.js';

const makeHeartbeatData = (id: string, hasOfflineSince = true) => ({
	machineId: id,
	lastHeartbeat: '2026-02-23T08:00:00Z',
	offlineSince: hasOfflineSince ? '2026-02-23T09:00:00Z' : undefined,
	missedHeartbeats: 5,
	metadata: {
		firstSeen: '2026-01-01T00:00:00Z',
		lastUpdated: '2026-02-23T08:00:00Z',
		version: '3.0.0'
	}
});

describe('roosyncGetOfflineMachines', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('schema validates empty args', () => {
		const result = GetOfflineMachinesArgsSchema.safeParse({});
		expect(result.success).toBe(true);
	});

	test('schema validates includeDetails', () => {
		const result = GetOfflineMachinesArgsSchema.safeParse({ includeDetails: true });
		expect(result.success).toBe(true);
		expect(result.data!.includeDetails).toBe(true);
	});

	test('metadata has correct tool name', () => {
		expect(getOfflineMachinesToolMetadata.name).toBe('roosync_get_offline_machines');
		expect(getOfflineMachinesToolMetadata.inputSchema.type).toBe('object');
	});

	test('returns machine IDs when includeDetails not set', async () => {
		mockGetOfflineMachines.mockReturnValue(['po-2023', 'web1']);

		const result = await roosyncGetOfflineMachines({});

		expect(result.success).toBe(true);
		expect(result.count).toBe(2);
		expect(result.machines).toEqual(['po-2023', 'web1']);
		expect(result.checkedAt).toBeTruthy();
	});

	test('returns empty list when no machines offline', async () => {
		mockGetOfflineMachines.mockReturnValue([]);

		const result = await roosyncGetOfflineMachines({});

		expect(result.count).toBe(0);
		expect(result.machines).toEqual([]);
	});

	test('returns detailed machines when includeDetails=true', async () => {
		mockGetOfflineMachines.mockReturnValue(['po-2023']);
		mockGetHeartbeatData.mockReturnValue(makeHeartbeatData('po-2023'));

		const result = await roosyncGetOfflineMachines({ includeDetails: true });

		expect(result.count).toBe(1);
		const machines = result.machines as any[];
		expect(machines[0].machineId).toBe('po-2023');
		expect(machines[0].offlineSince).toBe('2026-02-23T09:00:00Z');
		expect(machines[0].missedHeartbeats).toBe(5);
	});

	test('filters out machines without offlineSince in detailed mode', async () => {
		mockGetOfflineMachines.mockReturnValue(['po-2023', 'web1']);
		mockGetHeartbeatData.mockImplementation((id: string) => {
			if (id === 'po-2023') return makeHeartbeatData('po-2023', true);
			return makeHeartbeatData('web1', false); // no offlineSince
		});

		const result = await roosyncGetOfflineMachines({ includeDetails: true });

		expect(result.count).toBe(1); // only po-2023 has offlineSince
	});

	test('handles null heartbeatData in detailed mode', async () => {
		mockGetOfflineMachines.mockReturnValue(['ghost']);
		mockGetHeartbeatData.mockReturnValue(null);

		const result = await roosyncGetOfflineMachines({ includeDetails: true });

		expect(result.count).toBe(0);
		expect(result.machines).toEqual([]);
	});

	test('re-throws HeartbeatServiceError directly', async () => {
		const hbError = new HeartbeatServiceError('Not initialized', 'NOT_INITIALIZED');
		mockGetOfflineMachines.mockImplementation(() => { throw hbError; });

		await expect(roosyncGetOfflineMachines({})).rejects.toThrow('Not initialized');
	});

	test('wraps generic errors with HEARTBEAT_GET_OFFLINE_FAILED code', async () => {
		mockGetOfflineMachines.mockImplementation(() => { throw new Error('Disk error'); });

		try {
			await roosyncGetOfflineMachines({});
			expect.unreachable('Should have thrown');
		} catch (error: any) {
			expect(error.code).toBe('HEARTBEAT_GET_OFFLINE_FAILED');
			expect(error.message).toContain('Disk error');
		}
	});
});
