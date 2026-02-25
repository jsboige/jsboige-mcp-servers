/**
 * Tests for get-heartbeat-state.ts
 * Issue #492 - Coverage for roosync heartbeat state tool
 *
 * @module tools/roosync/__tests__/get-heartbeat-state
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockGetState } = vi.hoisted(() => ({
	mockGetState: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: vi.fn(() => ({
		getHeartbeatService: () => ({
			getState: mockGetState
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

import { roosyncGetHeartbeatState, GetHeartbeatStateArgsSchema, getHeartbeatStateToolMetadata } from '../get-heartbeat-state.js';
import { HeartbeatServiceError } from '../../../services/roosync/HeartbeatService.js';

const makeState = (heartbeats?: Map<string, any>) => ({
	onlineMachines: ['ai-01'],
	offlineMachines: ['po-2023'],
	warningMachines: ['web1'],
	statistics: {
		totalMachines: 3,
		onlineCount: 1,
		offlineCount: 1,
		warningCount: 1,
		lastHeartbeatCheck: '2026-02-23T10:00:00Z'
	},
	heartbeats: heartbeats ?? new Map([
		['ai-01', { machineId: 'ai-01', status: 'online', lastHeartbeat: '2026-02-23T10:00:00Z' }]
	])
});

describe('roosyncGetHeartbeatState', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('schema validates empty args', () => {
		const result = GetHeartbeatStateArgsSchema.safeParse({});
		expect(result.success).toBe(true);
	});

	test('schema validates includeHeartbeats', () => {
		const result = GetHeartbeatStateArgsSchema.safeParse({ includeHeartbeats: false });
		expect(result.success).toBe(true);
		expect(result.data!.includeHeartbeats).toBe(false);
	});

	test('metadata has correct tool name', () => {
		expect(getHeartbeatStateToolMetadata.name).toBe('roosync_get_heartbeat_state');
		expect(getHeartbeatStateToolMetadata.inputSchema.type).toBe('object');
	});

	test('returns machine lists and statistics', async () => {
		mockGetState.mockReturnValue(makeState());

		const result = await roosyncGetHeartbeatState({});

		expect(result.success).toBe(true);
		expect(result.onlineMachines).toEqual(['ai-01']);
		expect(result.offlineMachines).toEqual(['po-2023']);
		expect(result.warningMachines).toEqual(['web1']);
		expect(result.statistics.totalMachines).toBe(3);
		expect(result.retrievedAt).toBeTruthy();
	});

	test('includes heartbeats by default (converted from Map)', async () => {
		mockGetState.mockReturnValue(makeState());

		const result = await roosyncGetHeartbeatState({});

		expect(result.heartbeats).toBeDefined();
		expect(result.heartbeats!['ai-01']).toBeDefined();
		expect(result.heartbeats!['ai-01'].machineId).toBe('ai-01');
	});

	test('excludes heartbeats when includeHeartbeats=false', async () => {
		mockGetState.mockReturnValue(makeState());

		const result = await roosyncGetHeartbeatState({ includeHeartbeats: false });

		expect(result.heartbeats).toBeUndefined();
	});

	test('handles empty state', async () => {
		mockGetState.mockReturnValue(makeState(new Map()));

		const result = await roosyncGetHeartbeatState({});

		expect(result.heartbeats).toEqual({});
	});

	test('re-throws HeartbeatServiceError directly', async () => {
		const hbError = new HeartbeatServiceError('Service not running', 'NOT_RUNNING');
		mockGetState.mockImplementation(() => { throw hbError; });

		await expect(roosyncGetHeartbeatState({})).rejects.toThrow('Service not running');
	});

	test('wraps generic errors with HEARTBEAT_GET_STATE_FAILED code', async () => {
		mockGetState.mockImplementation(() => { throw new Error('Unexpected'); });

		try {
			await roosyncGetHeartbeatState({});
			expect.unreachable('Should have thrown');
		} catch (error: any) {
			expect(error.code).toBe('HEARTBEAT_GET_STATE_FAILED');
			expect(error.message).toContain('Unexpected');
		}
	});
});
