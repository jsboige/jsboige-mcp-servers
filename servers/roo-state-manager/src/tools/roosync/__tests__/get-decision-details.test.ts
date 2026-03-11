/**
 * Tests pour get-decision-details.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
// Fix #636 timeout: Use static import instead of dynamic imports
import {
	GetDecisionDetailsArgsSchema,
	GetDecisionDetailsResultSchema,
	roosyncGetDecisionDetails
} from '../get-decision-details.js';

// Mock dependencies
const { mockGetConfig, mockGetDecision } = vi.hoisted(() => ({
	mockGetConfig: vi.fn(),
	mockGetDecision: vi.fn()
}));

const { mockReadFileSync } = vi.hoisted(() => ({
	mockReadFileSync: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: vi.fn(() => ({
		getConfig: mockGetConfig,
		getDecision: mockGetDecision
	})),
	RooSyncServiceError: class extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message);
			this.name = 'RooSyncServiceError';
			this.code = code;
		}
	}
}));

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return {
		...actual,
		default: actual,
		readFileSync: mockReadFileSync
	};
});

describe('get-decision-details', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConfig.mockReturnValue({
			machineId: 'test-machine',
			sharedPath: '/shared/path'
		});
	});

	// ============================================================
	// Schema validation
	// ============================================================

	describe('GetDecisionDetailsArgsSchema', () => {
		test('requires decisionId', () => {
			expect(() => GetDecisionDetailsArgsSchema.parse({})).toThrow();
		});

		test('accepts decisionId only', () => {
			const result = GetDecisionDetailsArgsSchema.parse({ decisionId: 'dec-123' });
			expect(result.decisionId).toBe('dec-123');
		});

		test('accepts includeHistory boolean', () => {
			const result = GetDecisionDetailsArgsSchema.parse({
				decisionId: 'dec-1',
				includeHistory: false
			});
			expect(result.includeHistory).toBe(false);
		});

		test('accepts includeLogs boolean', () => {
			const result = GetDecisionDetailsArgsSchema.parse({
				decisionId: 'dec-1',
				includeLogs: false
			});
			expect(result.includeLogs).toBe(false);
		});

		test('rejects non-string decisionId', () => {
			expect(() => GetDecisionDetailsArgsSchema.parse({ decisionId: 123 })).toThrow();
		});

		test('rejects non-boolean includeHistory', () => {
			expect(() => GetDecisionDetailsArgsSchema.parse({
				decisionId: 'dec-1',
				includeHistory: 'yes'
			})).toThrow();
		});
	});

	describe('GetDecisionDetailsResultSchema', () => {
		test('validates a complete decision result', () => {
			const result = GetDecisionDetailsResultSchema.parse({
				decision: {
					id: 'dec-123',
					title: 'Test Decision',
					status: 'pending',
					type: 'config_sync',
					sourceMachine: 'machine-a',
					targetMachines: ['machine-b'],
					created: '2026-01-01T00:00:00Z'
				}
			});
			expect(result.decision.id).toBe('dec-123');
		});

		test('validates result with history', () => {
			const result = GetDecisionDetailsResultSchema.parse({
				decision: {
					id: 'dec-456',
					title: 'Approved Decision',
					status: 'approved',
					type: 'mcp_update',
					sourceMachine: 'ai-01',
					targetMachines: ['po-2023', 'po-2024'],
					created: '2026-01-01T00:00:00Z'
				},
				history: {
					created: { at: '2026-01-01', by: 'ai-01' },
					approved: { at: '2026-01-02', by: 'admin', comment: 'Looks good' }
				}
			});
			expect(result.history?.approved?.comment).toBe('Looks good');
		});

		test('validates result with rollback point', () => {
			const result = GetDecisionDetailsResultSchema.parse({
				decision: {
					id: 'dec-789',
					title: 'Applied Decision',
					status: 'applied',
					type: 'config_sync',
					sourceMachine: 'ai-01',
					targetMachines: ['po-2025'],
					created: '2026-01-01T00:00:00Z'
				},
				rollbackPoint: {
					available: true,
					createdAt: '2026-01-03',
					filesBackup: ['config-backup.json']
				}
			});
			expect(result.rollbackPoint?.available).toBe(true);
		});

		test('validates result with execution logs', () => {
			const result = GetDecisionDetailsResultSchema.parse({
				decision: {
					id: 'dec-abc',
					title: 'Test',
					status: 'applied',
					type: 'mcp_update',
					sourceMachine: 'ai-01',
					targetMachines: ['po-2023'],
					created: '2026-01-01T00:00:00Z'
				},
				executionLogs: ['[INFO] Applied successfully', '[INFO] 3 files modified']
			});
			expect(result.executionLogs).toHaveLength(2);
		});

		test('rejects missing decision field', () => {
			expect(() => GetDecisionDetailsResultSchema.parse({})).toThrow();
		});
	});

	// ============================================================
	// roosyncGetDecisionDetails function
	// ============================================================

	describe('roosyncGetDecisionDetails', () => {
		test('throws when decision not found', async () => {
			mockGetDecision.mockResolvedValue(null);

				await expect(roosyncGetDecisionDetails({
				decisionId: 'nonexistent'
			})).rejects.toThrow('introuvable');
		});

		test('returns decision details without history when disabled', async () => {
			mockGetDecision.mockResolvedValue({
				id: 'dec-1',
				title: 'Test',
				status: 'pending',
				type: 'config_sync',
				path: '/path/to/config',
				sourceMachine: 'ai-01',
				targetMachines: ['po-2023'],
				createdAt: '2026-01-01',
				details: 'Some diff'
			});

				const result = await roosyncGetDecisionDetails({
				decisionId: 'dec-1',
				includeHistory: false,
				includeLogs: false
			});

			expect(result.decision.id).toBe('dec-1');
			expect(result.decision.sourceMachine).toBe('ai-01');
			expect(result.history).toBeUndefined();
		});

		test('parses history from roadmap when includeHistory is true', async () => {
			mockGetDecision.mockResolvedValue({
				id: 'dec-hist',
				title: 'Historic Decision',
				status: 'approved',
				type: 'mcp_update',
				sourceMachine: 'ai-01',
				targetMachines: ['po-2023'],
				createdAt: '2026-01-01',
				details: null
			});

			mockReadFileSync.mockReturnValue(
				'<!-- DECISION_BLOCK_START -->\n' +
				'**ID:** `dec-hist`\n' +
				'**Créé:** 2026-01-01\n' +
				'**Machine Source:** ai-01\n' +
				'**Approuvé le:** 2026-01-02\n' +
				'**Approuvé par:** admin\n' +
				'**Commentaire:** LGTM\n' +
				'<!-- DECISION_BLOCK_END -->'
			);

				const result = await roosyncGetDecisionDetails({
				decisionId: 'dec-hist'
			});

			expect(result.history?.created.at).toBe('2026-01-01');
			expect(result.history?.approved?.by).toBe('admin');
			expect(result.history?.approved?.comment).toBe('LGTM');
		});

		test('adds execution logs for applied decisions', async () => {
			mockGetDecision.mockResolvedValue({
				id: 'dec-applied',
				title: 'Applied',
				status: 'applied',
				type: 'config_sync',
				path: '/config.json',
				sourceMachine: 'ai-01',
				targetMachines: ['po-2023'],
				createdAt: '2026-01-01',
				details: null
			});

			mockReadFileSync.mockReturnValue('');

				const result = await roosyncGetDecisionDetails({
				decisionId: 'dec-applied'
			});

			expect(result.executionLogs).toBeDefined();
			expect(result.executionLogs!.length).toBeGreaterThan(0);
			expect(result.rollbackPoint?.available).toBe(true);
		});

		test('rollback not available for pending decisions', async () => {
			mockGetDecision.mockResolvedValue({
				id: 'dec-pending',
				title: 'Pending',
				status: 'pending',
				type: 'config_sync',
				sourceMachine: 'ai-01',
				targetMachines: ['po-2023'],
				createdAt: '2026-01-01',
				details: null
			});

			mockReadFileSync.mockReturnValue('');

				const result = await roosyncGetDecisionDetails({
				decisionId: 'dec-pending'
			});

			expect(result.rollbackPoint?.available).toBe(false);
		});
	});
});
