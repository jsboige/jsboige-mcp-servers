/**
 * Tests pour heartbeat-activity.ts
 * Fix #501: Utilise le hostname OS réel au lieu de config.machineId
 *
 * @module tools/roosync/__tests__/heartbeat-activity
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted for mock variables used in vi.mock factories (ESM hoisting)
const { mockHostname, mockRegisterHeartbeat, mockRecordSchedulerRun, mockGetHeartbeatService, mockGetRooSyncService } = vi.hoisted(() => ({
	mockHostname: vi.fn().mockReturnValue('myia-po-2023'),
	mockRegisterHeartbeat: vi.fn().mockResolvedValue(undefined),
	// #833 C3: mock for recordSchedulerRunAsync (heartbeat-activity.ts L96)
	mockRecordSchedulerRun: vi.fn(),
	mockGetHeartbeatService: vi.fn(),
	mockGetRooSyncService: vi.fn()
}));

// Wire up mock chain
mockGetHeartbeatService.mockReturnValue({ registerHeartbeat: mockRegisterHeartbeat, recordSchedulerRun: mockRecordSchedulerRun });
mockGetRooSyncService.mockReturnValue({ getHeartbeatService: mockGetHeartbeatService });

// Mock os
vi.mock('os', () => {
	const m = { hostname: mockHostname, EOL: '\n', type: () => 'Windows_NT', release: () => '10.0', platform: () => 'win32' };
	return { ...m, default: m };
});

// Mock RooSyncService
vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: mockGetRooSyncService
}));

// Mock logger
vi.mock('../../../utils/logger.js', () => ({
	createLogger: () => ({
		debug: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn()
	})
}));

// Mock message-helpers
vi.mock('../../../utils/message-helpers.js', () => ({
	getLocalMachineId: vi.fn().mockReturnValue('myia-po-2023')
}));

// NOW import the module under test
import { recordRooSyncActivity, recordRooSyncActivityAsync, recordSchedulerRunAsync } from '../heartbeat-activity.js';

describe('heartbeat-activity', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockHostname.mockReturnValue('myia-po-2023');
		mockRegisterHeartbeat.mockResolvedValue(undefined);
		mockGetHeartbeatService.mockReturnValue({ registerHeartbeat: mockRegisterHeartbeat, recordSchedulerRun: mockRecordSchedulerRun });
		mockGetRooSyncService.mockReturnValue({ getHeartbeatService: mockGetHeartbeatService });
	});

	// ============================================================
	// Fix #501: Uses real hostname, not config machineId
	// ============================================================

	describe('recordRooSyncActivity', () => {
		test('should use OS hostname as machine ID (fix #501)', async () => {
			await recordRooSyncActivity('send');

			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);
			const [machineId] = mockRegisterHeartbeat.mock.calls[0];
			expect(machineId).toBe('myia-po-2023');
		});

		test('should use real hostname even when env says myia-ai-01', async () => {
			mockHostname.mockReturnValue('myia-po-2023');

			await recordRooSyncActivity('read');

			const [machineId] = mockRegisterHeartbeat.mock.calls[0];
			expect(machineId).toBe('myia-po-2023');
		});

		test('should normalize hostname to lowercase with safe chars', async () => {
			mockHostname.mockReturnValue('MyIA-Web1');

			await recordRooSyncActivity('manage');

			const [machineId] = mockRegisterHeartbeat.mock.calls[0];
			expect(machineId).toBe('myia-web1');
		});

		test('should pass activityType and metadata to heartbeat service', async () => {
			await recordRooSyncActivity('send', { action: 'reply', threadId: 'abc' });

			expect(mockRegisterHeartbeat).toHaveBeenCalledWith(
				'myia-po-2023',
				expect.objectContaining({
					activityType: 'send',
					action: 'reply',
					threadId: 'abc',
					recordedAt: expect.any(String)
				})
			);
		});

		test('should include recordedAt timestamp in ISO format', async () => {
			const before = new Date().toISOString();
			await recordRooSyncActivity('read');
			const after = new Date().toISOString();

			const [, metadata] = mockRegisterHeartbeat.mock.calls[0];
			expect(metadata.recordedAt).toBeDefined();
			expect(metadata.recordedAt >= before).toBe(true);
			expect(metadata.recordedAt <= after).toBe(true);
		});

		test('should call getHeartbeatService() directly (bypass config machineId)', async () => {
			await recordRooSyncActivity('send');

			expect(mockGetHeartbeatService).toHaveBeenCalledTimes(1);
			expect(mockRegisterHeartbeat).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(Object)
			);
		});

		test('should not throw if heartbeat service fails (fire-and-forget)', async () => {
			mockRegisterHeartbeat.mockRejectedValue(new Error('GDrive path not found'));

			await expect(recordRooSyncActivity('send')).resolves.not.toThrow();
		});

		test('should not throw if getRooSyncService fails', async () => {
			mockGetRooSyncService.mockImplementation(() => {
				throw new Error('Service not initialized');
			});

			await expect(recordRooSyncActivity('send')).resolves.not.toThrow();
		});
	});

	// ============================================================
	// Async fire-and-forget version
	// ============================================================

	describe('recordRooSyncActivityAsync', () => {
		test('should call without throwing', () => {
			expect(() => recordRooSyncActivityAsync('send')).not.toThrow();
		});

		test('should not throw on error', () => {
			mockRegisterHeartbeat.mockRejectedValue(new Error('fail'));
			expect(() => recordRooSyncActivityAsync('manage')).not.toThrow();
		});

		test('should pass metadata through', async () => {
			recordRooSyncActivityAsync('read', { mode: 'inbox' });

			await new Promise(resolve => setTimeout(resolve, 10));

			expect(mockRegisterHeartbeat).toHaveBeenCalledWith(
				'myia-po-2023',
				expect.objectContaining({
					activityType: 'read',
					mode: 'inbox'
				})
			);
		});
	});

	// ============================================================
	// Different hostname scenarios
	// ============================================================

	describe('hostname normalization', () => {
		test('should handle uppercase hostnames', async () => {
			mockHostname.mockReturnValue('MYIA-AI-01');
			await recordRooSyncActivity('send');
			expect(mockRegisterHeartbeat.mock.calls[0][0]).toBe('myia-ai-01');
		});

		test('should handle hostnames with special characters', async () => {
			mockHostname.mockReturnValue('my.machine_01');
			await recordRooSyncActivity('send');
			expect(mockRegisterHeartbeat.mock.calls[0][0]).toBe('my-machine-01');
		});

		test('should handle simple hostnames', async () => {
			mockHostname.mockReturnValue('localhost');
			await recordRooSyncActivity('send');
			expect(mockRegisterHeartbeat.mock.calls[0][0]).toBe('localhost');
		});
	});

	// ============================================================
	// #833 C3 (po-2024): recordSchedulerRunAsync (#1442)
	// Source: heartbeat-activity.ts L87-105 — fire-and-forget IIFE that calls
	// heartbeatService.recordSchedulerRun(machineId, {success, durationMs, error}).
	// Was entirely untested (not imported, no recordSchedulerRun mock).
	// ============================================================

	describe('recordSchedulerRunAsync (#1442)', () => {
		test('should call heartbeatService.recordSchedulerRun with machineId + success', async () => {
			// Source L92-100: the IIFE awaits getRooSyncService, gets heartbeatService,
			// calls recordSchedulerRun(machineId, {success, durationMs, error}).
			recordSchedulerRunAsync('myia-po-2024', true);

			// Fire-and-forget IIFE needs a microtask/tick to resolve
			await new Promise(resolve => setTimeout(resolve, 10));

			expect(mockRecordSchedulerRun).toHaveBeenCalledTimes(1);
			expect(mockRecordSchedulerRun).toHaveBeenCalledWith('myia-po-2024', expect.objectContaining({
				success: true
			}));
		});

		test('should forward failure result with error message', async () => {
			// Source L96-100: error option mapped from options.error (L99).
			recordSchedulerRunAsync('myia-web1', false, { error: 'scheduler crashed', durationMs: 5000 });

			await new Promise(resolve => setTimeout(resolve, 10));

			expect(mockRecordSchedulerRun).toHaveBeenCalledWith('myia-web1', expect.objectContaining({
				success: false,
				error: 'scheduler crashed',
				durationMs: 5000
			}));
		});

		test('should default durationMs + error to undefined when options omitted', async () => {
			// Source L98-99: options?.durationMs / options?.error → undefined when no options.
			recordSchedulerRunAsync('myia-po-2023', true);

			await new Promise(resolve => setTimeout(resolve, 10));

			const [, metrics] = mockRecordSchedulerRun.mock.calls[0];
			expect(metrics).toEqual({ success: true, durationMs: undefined, error: undefined });
		});

		test('should not throw when getRooSyncService rejects (fire-and-forget catch)', async () => {
			// Source L92-104: the inner try/catch swallows the error → logger.debug.
			// The sync wrapper must NOT throw even when the async IIFE fails.
			mockGetRooSyncService.mockRejectedValue(new Error('RooSync not initialized'));

			expect(() => recordSchedulerRunAsync('myia-po-2024', true)).not.toThrow();

			// Let the rejected IIFE settle — the catch must swallow it (no unhandled rejection)
			await new Promise(resolve => setTimeout(resolve, 10));
		});

		test('should not throw when recordSchedulerRun throws synchronously', async () => {
			// Source L101-103: recordSchedulerRun throwing is caught by the inner catch.
			mockRecordSchedulerRun.mockImplementation(() => {
				throw new Error('HeartbeatService GDrive write failed');
			});

			expect(() => recordSchedulerRunAsync('myia-po-2024', false, { error: 'x' })).not.toThrow();

			await new Promise(resolve => setTimeout(resolve, 10));
		});
	});
});
