/**
 * Tests pour get-status.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
// Fix #636 timeout: Use static import instead of dynamic imports
import { GetStatusArgsSchema, GetStatusResultSchema, roosyncGetStatus } from '../get-status.js';

const { mockGetConfig, mockLoadDashboard, mockListDiffs } = vi.hoisted(() => ({
	mockGetConfig: vi.fn(),
	mockLoadDashboard: vi.fn(),
	mockListDiffs: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: vi.fn(() => ({
		getConfig: mockGetConfig,
		loadDashboard: mockLoadDashboard,
		listDiffs: mockListDiffs
	})),
	RooSyncServiceError: class extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message); this.name = 'RooSyncServiceError'; this.code = code;
		}
	},
	RooSyncService: { resetInstance: vi.fn() }
}));

describe('get-status', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConfig.mockReturnValue({ machineId: 'ai-01', sharedPath: '/shared' });
	});

	describe('GetStatusArgsSchema', () => {
		test('accepts empty input', () => {
			const result = GetStatusArgsSchema.parse({});
			expect(result).toBeDefined();
		});

		test('accepts machineFilter', () => {
			const result = GetStatusArgsSchema.parse({ machineFilter: 'po-2023' });
			expect(result.machineFilter).toBe('po-2023');
		});

		test('accepts resetCache and includeDetails', () => {
			const result = GetStatusArgsSchema.parse({ resetCache: true, includeDetails: true });
			expect(result.resetCache).toBe(true);
			expect(result.includeDetails).toBe(true);
		});
	});

	describe('GetStatusResultSchema', () => {
		test('validates complete result', () => {
			const result = GetStatusResultSchema.parse({
				status: 'synced',
				lastSync: '2026-01-01T00:00:00Z',
				machines: [{
					id: 'ai-01', status: 'online', lastSync: '2026-01-01T00:00:00Z',
					pendingDecisions: 0, diffsCount: 0
				}],
				summary: { totalMachines: 1, onlineMachines: 1, totalDiffs: 0, totalPendingDecisions: 0 }
			});
			expect(result.status).toBe('synced');
		});

		test('validates result with diffs', () => {
			const result = GetStatusResultSchema.parse({
				status: 'diverged',
				lastSync: '2026-01-01T00:00:00Z',
				machines: [],
				diffs: [{
					type: 'modified', path: 'mcp.json', machineId: 'po-2023'
				}]
			});
			expect(result.diffs).toHaveLength(1);
		});

		test('rejects invalid status', () => {
			expect(() => GetStatusResultSchema.parse({
				status: 'invalid', lastSync: '2026-01-01', machines: []
			})).toThrow();
		});
	});

	describe('roosyncGetStatus', () => {
		test('returns dashboard status', async () => {
			mockLoadDashboard.mockResolvedValue({
				overallStatus: 'synced',
				lastUpdate: '2026-01-01T00:00:00Z',
				machines: {
					'ai-01': { status: 'online', lastSync: '2026-01-01', pendingDecisions: 0, diffsCount: 0 },
					'po-2023': { status: 'online', lastSync: '2026-01-01', pendingDecisions: 1, diffsCount: 2 }
				}
			});

				const result = await roosyncGetStatus({});

			expect(result.status).toBe('synced');
			expect(result.machines).toHaveLength(2);
		});

		test('filters by machine', async () => {
			mockLoadDashboard.mockResolvedValue({
				overallStatus: 'synced',
				lastUpdate: '2026-01-01T00:00:00Z',
				machines: {
					'ai-01': { status: 'online', lastSync: '2026-01-01', pendingDecisions: 0, diffsCount: 0 },
					'po-2023': { status: 'offline', lastSync: '2026-01-01', pendingDecisions: 1, diffsCount: 3 }
				}
			});

				const result = await roosyncGetStatus({ machineFilter: 'po-2023' });

			expect(result.machines).toHaveLength(1);
			expect(result.machines[0].id).toBe('po-2023');
		});

		test('throws when machine not found', async () => {
			mockLoadDashboard.mockResolvedValue({
				overallStatus: 'synced',
				lastUpdate: '2026-01-01T00:00:00Z',
				machines: { 'ai-01': { status: 'online', lastSync: '2026-01-01', pendingDecisions: 0, diffsCount: 0 } }
			});

				await expect(roosyncGetStatus({ machineFilter: 'nonexistent' })).rejects.toThrow('non trouvée');
		});

		test('includes diffs when includeDetails is true', async () => {
			mockLoadDashboard.mockResolvedValue({
				overallStatus: 'diverged',
				lastUpdate: '2026-01-01T00:00:00Z',
				machines: {
					'ai-01': { status: 'online', lastSync: '2026-01-01', pendingDecisions: 0, diffsCount: 1 }
				}
			});
			mockListDiffs.mockResolvedValue({
				diffs: [{
					type: 'modified', path: 'mcp.json',
					machines: ['po-2023'], description: 'MCP config changed'
				}]
			});

				const result = await roosyncGetStatus({ includeDetails: true });

			expect(result.diffs).toBeDefined();
			expect(result.diffs!.length).toBe(1);
		});

		test('uses precalculated summary when available', async () => {
			mockLoadDashboard.mockResolvedValue({
				overallStatus: 'synced',
				lastUpdate: '2026-01-01T00:00:00Z',
				machines: { 'ai-01': { status: 'online', lastSync: '2026-01-01', pendingDecisions: 0, diffsCount: 0 } },
				summary: { totalMachines: 6, onlineMachines: 4, totalDiffs: 5, totalPendingDecisions: 2 }
			});

				const result = await roosyncGetStatus({});

			expect(result.summary?.totalMachines).toBe(6);
			expect(result.summary?.onlineMachines).toBe(4);
		});
	});
});
