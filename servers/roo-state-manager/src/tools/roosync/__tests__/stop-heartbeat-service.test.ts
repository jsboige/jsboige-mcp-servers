/**
 * Tests for stop-heartbeat-service.ts
 * Issue #492 - Coverage for roosync heartbeat stop tool
 *
 * @module tools/roosync/__tests__/stop-heartbeat-service
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockStopHeartbeatService } = vi.hoisted(() => ({
	mockStopHeartbeatService: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: vi.fn(() => ({
		getHeartbeatService: () => ({
			stopHeartbeatService: mockStopHeartbeatService
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

import { roosyncStopHeartbeatService, StopHeartbeatServiceArgsSchema, stopHeartbeatServiceToolMetadata } from '../stop-heartbeat-service.js';
import { HeartbeatServiceError } from '../../../services/roosync/HeartbeatService.js';

describe('roosyncStopHeartbeatService', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('schema validates empty args', () => {
		const result = StopHeartbeatServiceArgsSchema.safeParse({});
		expect(result.success).toBe(true);
	});

	test('schema validates saveState boolean', () => {
		const result = StopHeartbeatServiceArgsSchema.safeParse({ saveState: false });
		expect(result.success).toBe(true);
		expect(result.data!.saveState).toBe(false);
	});

	test('metadata has correct tool name', () => {
		expect(stopHeartbeatServiceToolMetadata.name).toBe('roosync_stop_heartbeat_service');
		expect(stopHeartbeatServiceToolMetadata.inputSchema.type).toBe('object');
	});

	test('returns success with saveState true by default', async () => {
		mockStopHeartbeatService.mockResolvedValue(undefined);

		const result = await roosyncStopHeartbeatService({});

		expect(result.success).toBe(true);
		expect(result.stateSaved).toBe(true);
		expect(result.stoppedAt).toBeTruthy();
		expect(result.message).toContain('succès');
	});

	test('respects saveState=false', async () => {
		mockStopHeartbeatService.mockResolvedValue(undefined);

		const result = await roosyncStopHeartbeatService({ saveState: false });

		expect(result.stateSaved).toBe(false);
	});

	test('calls stopHeartbeatService on the service', async () => {
		mockStopHeartbeatService.mockResolvedValue(undefined);

		await roosyncStopHeartbeatService({});

		expect(mockStopHeartbeatService).toHaveBeenCalledTimes(1);
	});

	test('re-throws HeartbeatServiceError directly', async () => {
		const hbError = new HeartbeatServiceError('Already stopped', 'ALREADY_STOPPED');
		mockStopHeartbeatService.mockRejectedValue(hbError);

		await expect(roosyncStopHeartbeatService({})).rejects.toThrow('Already stopped');
	});

	test('wraps generic errors with HEARTBEAT_STOP_FAILED code', async () => {
		mockStopHeartbeatService.mockRejectedValue(new Error('Connection lost'));

		try {
			await roosyncStopHeartbeatService({});
			expect.unreachable('Should have thrown');
		} catch (error: any) {
			expect(error.code).toBe('HEARTBEAT_STOP_FAILED');
			expect(error.message).toContain('Connection lost');
		}
	});
});
