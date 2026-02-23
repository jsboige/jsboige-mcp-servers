/**
 * Tests for start-heartbeat-service.ts
 * Issue #492 - Coverage for roosync heartbeat start tool
 *
 * @module tools/roosync/__tests__/start-heartbeat-service
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockStartHeartbeatService, mockUpdateConfig } = vi.hoisted(() => ({
	mockStartHeartbeatService: vi.fn(),
	mockUpdateConfig: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: vi.fn(() => ({
		getHeartbeatService: () => ({
			startHeartbeatService: mockStartHeartbeatService,
			updateConfig: mockUpdateConfig
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

import { roosyncStartHeartbeatService, StartHeartbeatServiceArgsSchema, startHeartbeatServiceToolMetadata } from '../start-heartbeat-service.js';
import { HeartbeatServiceError } from '../../../services/roosync/HeartbeatService.js';

describe('roosyncStartHeartbeatService', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('schema requires machineId', () => {
		const result = StartHeartbeatServiceArgsSchema.safeParse({});
		expect(result.success).toBe(false);
	});

	test('schema validates machineId only', () => {
		const result = StartHeartbeatServiceArgsSchema.safeParse({ machineId: 'ai-01' });
		expect(result.success).toBe(true);
	});

	test('schema validates all optional fields', () => {
		const result = StartHeartbeatServiceArgsSchema.safeParse({
			machineId: 'ai-01',
			enableAutoSync: false,
			heartbeatInterval: 60000,
			offlineTimeout: 300000
		});
		expect(result.success).toBe(true);
	});

	test('metadata has correct tool name and required fields', () => {
		expect(startHeartbeatServiceToolMetadata.name).toBe('roosync_start_heartbeat_service');
		expect(startHeartbeatServiceToolMetadata.inputSchema.required).toEqual(['machineId']);
	});

	test('returns success with defaults', async () => {
		mockStartHeartbeatService.mockResolvedValue(undefined);

		const result = await roosyncStartHeartbeatService({ machineId: 'ai-01' });

		expect(result.success).toBe(true);
		expect(result.machineId).toBe('ai-01');
		expect(result.startedAt).toBeTruthy();
		expect(result.config.heartbeatInterval).toBe(30000);
		expect(result.config.offlineTimeout).toBe(120000);
		expect(result.config.autoSyncEnabled).toBe(true);
		expect(result.message).toContain('ai-01');
	});

	test('calls startHeartbeatService with machineId and callbacks', async () => {
		mockStartHeartbeatService.mockResolvedValue(undefined);

		await roosyncStartHeartbeatService({ machineId: 'po-2023' });

		expect(mockStartHeartbeatService).toHaveBeenCalledTimes(1);
		expect(mockStartHeartbeatService.mock.calls[0][0]).toBe('po-2023');
		// Second and third args are offline/online callbacks
		expect(typeof mockStartHeartbeatService.mock.calls[0][1]).toBe('function');
		expect(typeof mockStartHeartbeatService.mock.calls[0][2]).toBe('function');
	});

	test('updates config when heartbeatInterval provided', async () => {
		mockStartHeartbeatService.mockResolvedValue(undefined);
		mockUpdateConfig.mockResolvedValue(undefined);

		const result = await roosyncStartHeartbeatService({
			machineId: 'ai-01',
			heartbeatInterval: 60000
		});

		expect(mockUpdateConfig).toHaveBeenCalledWith({
			heartbeatInterval: 60000,
			offlineTimeout: 120000,
			autoSyncEnabled: true
		});
		expect(result.config.heartbeatInterval).toBe(60000);
	});

	test('updates config when offlineTimeout provided', async () => {
		mockStartHeartbeatService.mockResolvedValue(undefined);
		mockUpdateConfig.mockResolvedValue(undefined);

		await roosyncStartHeartbeatService({
			machineId: 'ai-01',
			offlineTimeout: 300000
		});

		expect(mockUpdateConfig).toHaveBeenCalledWith({
			heartbeatInterval: 30000,
			offlineTimeout: 300000,
			autoSyncEnabled: true
		});
	});

	test('does not update config when no interval/timeout provided', async () => {
		mockStartHeartbeatService.mockResolvedValue(undefined);

		await roosyncStartHeartbeatService({ machineId: 'ai-01' });

		expect(mockUpdateConfig).not.toHaveBeenCalled();
	});

	test('re-throws HeartbeatServiceError directly', async () => {
		const hbError = new HeartbeatServiceError('Already running', 'ALREADY_RUNNING');
		mockStartHeartbeatService.mockRejectedValue(hbError);

		await expect(roosyncStartHeartbeatService({ machineId: 'ai-01' }))
			.rejects.toThrow('Already running');
	});

	test('wraps generic errors with HEARTBEAT_START_FAILED code', async () => {
		mockStartHeartbeatService.mockRejectedValue(new Error('Permission denied'));

		try {
			await roosyncStartHeartbeatService({ machineId: 'ai-01' });
			expect.unreachable('Should have thrown');
		} catch (error: any) {
			expect(error.code).toBe('HEARTBEAT_START_FAILED');
			expect(error.message).toContain('Permission denied');
		}
	});
});
