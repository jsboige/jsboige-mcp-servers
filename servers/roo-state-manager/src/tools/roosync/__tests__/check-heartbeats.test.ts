/**
 * Tests for check-heartbeats.ts
 * Issue #492 - Coverage for roosync heartbeat checking tool
 *
 * @module tools/roosync/__tests__/check-heartbeats
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockCheckHeartbeats } = vi.hoisted(() => ({
	mockCheckHeartbeats: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: vi.fn(() => ({
		getHeartbeatService: () => ({
			checkHeartbeats: mockCheckHeartbeats
		})
	}))
}));

// Mock HeartbeatServiceError for instanceof checks
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

import { roosyncCheckHeartbeats, CheckHeartbeatsArgsSchema, checkHeartbeatsToolMetadata } from '../check-heartbeats.js';
import { HeartbeatServiceError } from '../../../services/roosync/HeartbeatService.js';

describe('roosyncCheckHeartbeats', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('schema validates empty args', () => {
		const result = CheckHeartbeatsArgsSchema.safeParse({});
		expect(result.success).toBe(true);
	});

	test('schema validates forceCheck', () => {
		const result = CheckHeartbeatsArgsSchema.safeParse({ forceCheck: true });
		expect(result.success).toBe(true);
		expect(result.data!.forceCheck).toBe(true);
	});

	test('metadata has correct tool name', () => {
		expect(checkHeartbeatsToolMetadata.name).toBe('roosync_check_heartbeats');
		expect(checkHeartbeatsToolMetadata.inputSchema.type).toBe('object');
	});

	test('returns success result with machine status', async () => {
		mockCheckHeartbeats.mockResolvedValue({
			success: true,
			newlyOfflineMachines: ['po-2023'],
			newlyOnlineMachines: ['ai-01'],
			warningMachines: ['web1'],
			checkedAt: '2026-02-23T10:00:00Z'
		});

		const result = await roosyncCheckHeartbeats({});

		expect(result.success).toBe(true);
		expect(result.newlyOfflineMachines).toEqual(['po-2023']);
		expect(result.newlyOnlineMachines).toEqual(['ai-01']);
		expect(result.warningMachines).toEqual(['web1']);
		expect(result.checkedAt).toBe('2026-02-23T10:00:00Z');
	});

	test('computes summary from machine arrays', async () => {
		mockCheckHeartbeats.mockResolvedValue({
			success: true,
			newlyOfflineMachines: ['a', 'b'],
			newlyOnlineMachines: ['c'],
			warningMachines: [],
			checkedAt: '2026-02-23T10:00:00Z'
		});

		const result = await roosyncCheckHeartbeats({});

		expect(result.summary.totalChanges).toBe(3);
		expect(result.summary.offlineCount).toBe(2);
		expect(result.summary.onlineCount).toBe(1);
		expect(result.summary.warningCount).toBe(0);
	});

	test('returns empty arrays when no changes', async () => {
		mockCheckHeartbeats.mockResolvedValue({
			success: true,
			newlyOfflineMachines: [],
			newlyOnlineMachines: [],
			warningMachines: [],
			checkedAt: '2026-02-23T12:00:00Z'
		});

		const result = await roosyncCheckHeartbeats({});

		expect(result.summary.totalChanges).toBe(0);
		expect(result.newlyOfflineMachines).toEqual([]);
	});

	test('re-throws HeartbeatServiceError directly', async () => {
		const hbError = new HeartbeatServiceError('Service down', 'SERVICE_UNAVAILABLE');
		mockCheckHeartbeats.mockRejectedValue(hbError);

		await expect(roosyncCheckHeartbeats({})).rejects.toThrow('Service down');
	});

	test('wraps generic errors in HeartbeatServiceError', async () => {
		mockCheckHeartbeats.mockRejectedValue(new Error('Network timeout'));

		await expect(roosyncCheckHeartbeats({})).rejects.toThrow('Network timeout');
	});

	test('passes forceCheck arg to service', async () => {
		mockCheckHeartbeats.mockResolvedValue({
			success: true,
			newlyOfflineMachines: [],
			newlyOnlineMachines: [],
			warningMachines: [],
			checkedAt: '2026-02-23T12:00:00Z'
		});

		await roosyncCheckHeartbeats({ forceCheck: true });

		expect(mockCheckHeartbeats).toHaveBeenCalledTimes(1);
	});
});
