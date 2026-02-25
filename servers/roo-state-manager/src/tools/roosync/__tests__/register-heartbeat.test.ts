/**
 * Tests pour register-heartbeat.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { RegisterHeartbeatArgsSchema, RegisterHeartbeatResultSchema } from '../register-heartbeat.js';

const { mockGetHeartbeatService } = vi.hoisted(() => ({
	mockGetHeartbeatService: vi.fn()
}));

const { mockRegisterHeartbeat, mockGetHeartbeatData } = vi.hoisted(() => ({
	mockRegisterHeartbeat: vi.fn(),
	mockGetHeartbeatData: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: vi.fn(() => ({
		getHeartbeatService: mockGetHeartbeatService
	}))
}));

vi.mock('../../../services/roosync/HeartbeatService.js', () => ({
	HeartbeatServiceError: class extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message); this.name = 'HeartbeatServiceError'; this.code = code;
		}
	}
}));

describe('register-heartbeat', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetHeartbeatService.mockReturnValue({
			registerHeartbeat: mockRegisterHeartbeat,
			getHeartbeatData: mockGetHeartbeatData
		});
	});

	describe('RegisterHeartbeatArgsSchema', () => {
		test('requires machineId', () => {
			expect(() => RegisterHeartbeatArgsSchema.parse({})).toThrow();
		});

		test('accepts machineId only', () => {
			const result = RegisterHeartbeatArgsSchema.parse({ machineId: 'ai-01' });
			expect(result.machineId).toBe('ai-01');
			expect(result.metadata).toBeUndefined();
		});

		test('accepts optional metadata', () => {
			const result = RegisterHeartbeatArgsSchema.parse({
				machineId: 'po-2023',
				metadata: { version: '2.3.0', role: 'executor' }
			});
			expect(result.metadata).toEqual({ version: '2.3.0', role: 'executor' });
		});
	});

	describe('RegisterHeartbeatResultSchema', () => {
		test('validates complete result', () => {
			const result = RegisterHeartbeatResultSchema.parse({
				success: true,
				machineId: 'ai-01',
				timestamp: '2026-01-01T00:00:00Z',
				status: 'online',
				isNewMachine: false
			});
			expect(result.success).toBe(true);
			expect(result.status).toBe('online');
		});

		test('validates new machine result', () => {
			const result = RegisterHeartbeatResultSchema.parse({
				success: true,
				machineId: 'new-machine',
				timestamp: '2026-01-01T00:00:00Z',
				status: 'online',
				isNewMachine: true
			});
			expect(result.isNewMachine).toBe(true);
		});

		test('validates all status values', () => {
			for (const status of ['online', 'offline', 'warning']) {
				const result = RegisterHeartbeatResultSchema.parse({
					success: true, machineId: 'test', timestamp: '2026-01-01T00:00:00Z',
					status, isNewMachine: false
				});
				expect(result.status).toBe(status);
			}
		});

		test('rejects invalid status', () => {
			expect(() => RegisterHeartbeatResultSchema.parse({
				success: true, machineId: 'test', timestamp: '2026-01-01',
				status: 'unknown', isNewMachine: false
			})).toThrow();
		});
	});

	describe('roosyncRegisterHeartbeat', () => {
		test('registers heartbeat for existing machine', async () => {
			mockGetHeartbeatData
				.mockReturnValueOnce({ lastHeartbeat: '2026-01-01T00:00:00Z', status: 'offline' })
				.mockReturnValueOnce({ lastHeartbeat: '2026-01-02T00:00:00Z', status: 'online' });
			mockRegisterHeartbeat.mockResolvedValue(undefined);

			const { roosyncRegisterHeartbeat } = await import('../register-heartbeat.js');
			const result = await roosyncRegisterHeartbeat({ machineId: 'ai-01' });

			expect(result.success).toBe(true);
			expect(result.machineId).toBe('ai-01');
			expect(result.isNewMachine).toBe(false);
			expect(result.status).toBe('online');
			expect(mockRegisterHeartbeat).toHaveBeenCalledWith('ai-01', undefined);
		});

		test('registers heartbeat for new machine', async () => {
			mockGetHeartbeatData
				.mockReturnValueOnce(null)
				.mockReturnValueOnce({ lastHeartbeat: '2026-01-01T00:00:00Z', status: 'online' });
			mockRegisterHeartbeat.mockResolvedValue(undefined);

			const { roosyncRegisterHeartbeat } = await import('../register-heartbeat.js');
			const result = await roosyncRegisterHeartbeat({ machineId: 'new-host' });

			expect(result.isNewMachine).toBe(true);
		});

		test('passes metadata to heartbeat service', async () => {
			mockGetHeartbeatData
				.mockReturnValueOnce(null)
				.mockReturnValueOnce({ lastHeartbeat: '2026-01-01T00:00:00Z', status: 'online' });
			mockRegisterHeartbeat.mockResolvedValue(undefined);

			const { roosyncRegisterHeartbeat } = await import('../register-heartbeat.js');
			await roosyncRegisterHeartbeat({
				machineId: 'po-2023',
				metadata: { version: '2.3.0' }
			});

			expect(mockRegisterHeartbeat).toHaveBeenCalledWith('po-2023', { version: '2.3.0' });
		});

		test('throws when retrieval fails after register', async () => {
			mockGetHeartbeatData.mockReturnValue(null);
			mockRegisterHeartbeat.mockResolvedValue(undefined);

			const { roosyncRegisterHeartbeat } = await import('../register-heartbeat.js');
			await expect(roosyncRegisterHeartbeat({ machineId: 'broken' }))
				.rejects.toThrow('Impossible de récupérer');
		});

		test('throws on registration error', async () => {
			mockGetHeartbeatData.mockReturnValueOnce(null);
			mockRegisterHeartbeat.mockRejectedValue(new Error('Write failed'));

			const { roosyncRegisterHeartbeat } = await import('../register-heartbeat.js');
			await expect(roosyncRegisterHeartbeat({ machineId: 'fail' }))
				.rejects.toThrow('Write failed');
		});
	});
});
