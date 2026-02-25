/**
 * Tests for get-warning-machines.ts
 * Issue #492 - Coverage for roosync warning machines tool
 *
 * @module tools/roosync/__tests__/get-warning-machines
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockGetWarningMachines, mockGetHeartbeatData } = vi.hoisted(() => ({
	mockGetWarningMachines: vi.fn(),
	mockGetHeartbeatData: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: vi.fn(() => ({
		getHeartbeatService: () => ({
			getWarningMachines: mockGetWarningMachines,
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

import { roosyncGetWarningMachines, GetWarningMachinesArgsSchema, getWarningMachinesToolMetadata } from '../get-warning-machines.js';
import { HeartbeatServiceError } from '../../../services/roosync/HeartbeatService.js';

const makeHeartbeatData = (id: string) => ({
	machineId: id,
	lastHeartbeat: '2026-02-23T09:50:00Z',
	missedHeartbeats: 2,
	metadata: {
		firstSeen: '2026-01-01T00:00:00Z',
		lastUpdated: '2026-02-23T09:50:00Z',
		version: '3.0.0'
	}
});

describe('roosyncGetWarningMachines', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('schema validates empty args', () => {
		const result = GetWarningMachinesArgsSchema.safeParse({});
		expect(result.success).toBe(true);
	});

	test('schema validates includeDetails', () => {
		const result = GetWarningMachinesArgsSchema.safeParse({ includeDetails: true });
		expect(result.success).toBe(true);
		expect(result.data!.includeDetails).toBe(true);
	});

	test('metadata has correct tool name', () => {
		expect(getWarningMachinesToolMetadata.name).toBe('roosync_get_warning_machines');
		expect(getWarningMachinesToolMetadata.inputSchema.type).toBe('object');
	});

	test('returns machine IDs when includeDetails not set', async () => {
		mockGetWarningMachines.mockReturnValue(['web1', 'po-2025']);

		const result = await roosyncGetWarningMachines({});

		expect(result.success).toBe(true);
		expect(result.count).toBe(2);
		expect(result.machines).toEqual(['web1', 'po-2025']);
		expect(result.checkedAt).toBeTruthy();
	});

	test('returns empty list when no machines in warning', async () => {
		mockGetWarningMachines.mockReturnValue([]);

		const result = await roosyncGetWarningMachines({});

		expect(result.count).toBe(0);
		expect(result.machines).toEqual([]);
	});

	test('returns detailed machines when includeDetails=true', async () => {
		mockGetWarningMachines.mockReturnValue(['web1']);
		mockGetHeartbeatData.mockReturnValue(makeHeartbeatData('web1'));

		const result = await roosyncGetWarningMachines({ includeDetails: true });

		expect(result.count).toBe(1);
		const machines = result.machines as any[];
		expect(machines[0].machineId).toBe('web1');
		expect(machines[0].missedHeartbeats).toBe(2);
		expect(machines[0].metadata.version).toBe('3.0.0');
	});

	test('handles null heartbeatData in detailed mode', async () => {
		mockGetWarningMachines.mockReturnValue(['ghost']);
		mockGetHeartbeatData.mockReturnValue(null);

		const result = await roosyncGetWarningMachines({ includeDetails: true });

		expect(result.count).toBe(0);
		expect(result.machines).toEqual([]);
	});

	test('handles multiple machines with details', async () => {
		mockGetWarningMachines.mockReturnValue(['web1', 'po-2025']);
		mockGetHeartbeatData.mockImplementation((id: string) => makeHeartbeatData(id));

		const result = await roosyncGetWarningMachines({ includeDetails: true });

		expect(result.count).toBe(2);
		const machines = result.machines as any[];
		expect(machines[0].machineId).toBe('web1');
		expect(machines[1].machineId).toBe('po-2025');
	});

	test('re-throws HeartbeatServiceError directly', async () => {
		const hbError = new HeartbeatServiceError('Not initialized', 'NOT_INITIALIZED');
		mockGetWarningMachines.mockImplementation(() => { throw hbError; });

		await expect(roosyncGetWarningMachines({})).rejects.toThrow('Not initialized');
	});

	test('wraps generic errors with HEARTBEAT_GET_WARNING_FAILED code', async () => {
		mockGetWarningMachines.mockImplementation(() => { throw new Error('IO error'); });

		try {
			await roosyncGetWarningMachines({});
			expect.unreachable('Should have thrown');
		} catch (error: any) {
			expect(error.code).toBe('HEARTBEAT_GET_WARNING_FAILED');
			expect(error.message).toContain('IO error');
		}
	});
});
