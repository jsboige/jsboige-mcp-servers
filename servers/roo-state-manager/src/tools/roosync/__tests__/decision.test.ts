/**
 * Tests pour decision.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { RooSyncDecisionArgsSchema, RooSyncDecisionResultSchema } from '../decision.js';

// Mock dependencies
const { mockLoadDecisionDetails, mockValidateDecisionStatus, mockUpdateRoadmapStatus, mockFormatDecisionResult } = vi.hoisted(() => ({
	mockLoadDecisionDetails: vi.fn(),
	mockValidateDecisionStatus: vi.fn(),
	mockUpdateRoadmapStatus: vi.fn(),
	mockFormatDecisionResult: vi.fn()
}));

vi.mock('../utils/decision-helpers.js', () => ({
	loadDecisionDetails: mockLoadDecisionDetails,
	validateDecisionStatus: mockValidateDecisionStatus,
	updateRoadmapStatus: mockUpdateRoadmapStatus,
	formatDecisionResult: mockFormatDecisionResult
}));

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: vi.fn(() => ({
		getConfig: () => ({ machineId: 'test-machine', sharedPath: '/shared' })
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

describe('decision', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ============================================================
	// Schema validation
	// ============================================================

	describe('RooSyncDecisionArgsSchema', () => {
		test('accepts approve action', () => {
			const result = RooSyncDecisionArgsSchema.parse({
				action: 'approve',
				decisionId: 'DEC-001'
			});
			expect(result.action).toBe('approve');
			expect(result.decisionId).toBe('DEC-001');
		});

		test('accepts approve with comment', () => {
			const result = RooSyncDecisionArgsSchema.parse({
				action: 'approve',
				decisionId: 'DEC-001',
				comment: 'LGTM'
			});
			expect(result.comment).toBe('LGTM');
		});

		test('accepts reject with reason', () => {
			const result = RooSyncDecisionArgsSchema.parse({
				action: 'reject',
				decisionId: 'DEC-001',
				reason: 'Conflicts detected'
			});
			expect(result.reason).toBe('Conflicts detected');
		});

		test('rejects reject without reason', () => {
			expect(() => RooSyncDecisionArgsSchema.parse({
				action: 'reject',
				decisionId: 'DEC-001'
			})).toThrow();
		});

		test('accepts apply with dryRun and force', () => {
			const result = RooSyncDecisionArgsSchema.parse({
				action: 'apply',
				decisionId: 'DEC-001',
				dryRun: true,
				force: false
			});
			expect(result.dryRun).toBe(true);
			expect(result.force).toBe(false);
		});

		test('accepts rollback with reason', () => {
			const result = RooSyncDecisionArgsSchema.parse({
				action: 'rollback',
				decisionId: 'DEC-001',
				reason: 'Bug introduced'
			});
			expect(result.reason).toBe('Bug introduced');
		});

		test('rejects rollback without reason', () => {
			expect(() => RooSyncDecisionArgsSchema.parse({
				action: 'rollback',
				decisionId: 'DEC-001'
			})).toThrow();
		});

		test('rejects invalid action', () => {
			expect(() => RooSyncDecisionArgsSchema.parse({
				action: 'invalid',
				decisionId: 'DEC-001'
			})).toThrow();
		});

		test('rejects missing decisionId', () => {
			expect(() => RooSyncDecisionArgsSchema.parse({
				action: 'approve'
			})).toThrow();
		});

		test('accepts all valid actions', () => {
			for (const action of ['approve', 'reject', 'apply', 'rollback']) {
				const args: any = { action, decisionId: 'D1' };
				if (action === 'reject' || action === 'rollback') {
					args.reason = 'test';
				}
				expect(() => RooSyncDecisionArgsSchema.parse(args)).not.toThrow();
			}
		});
	});

	describe('RooSyncDecisionResultSchema', () => {
		test('validates a complete result', () => {
			const result = RooSyncDecisionResultSchema.parse({
				success: true,
				decisionId: 'DEC-001',
				action: 'approve',
				previousStatus: 'pending',
				newStatus: 'approved',
				timestamp: '2026-01-01T00:00:00Z',
				machineId: 'test-machine',
				nextSteps: ['Apply the decision']
			});
			expect(result.decisionId).toBe('DEC-001');
		});

		test('accepts apply result with changes and logs', () => {
			const result = RooSyncDecisionResultSchema.parse({
				success: true,
				decisionId: 'DEC-001',
				action: 'apply',
				previousStatus: 'approved',
				newStatus: 'applied',
				timestamp: '2026-01-01T00:00:00Z',
				machineId: 'test-machine',
				executionLog: ['Step 1', 'Step 2'],
				changes: {
					filesModified: ['file1.json'],
					filesCreated: [],
					filesDeleted: []
				},
				rollbackAvailable: true,
				nextSteps: []
			});
			expect(result.changes?.filesModified).toEqual(['file1.json']);
			expect(result.rollbackAvailable).toBe(true);
		});

		test('accepts rollback result with restored files', () => {
			const result = RooSyncDecisionResultSchema.parse({
				success: true,
				decisionId: 'DEC-001',
				action: 'rollback',
				previousStatus: 'applied',
				newStatus: 'rolled_back',
				timestamp: '2026-01-01T00:00:00Z',
				machineId: 'test-machine',
				restoredFiles: ['config.json'],
				nextSteps: ['Review changes']
			});
			expect(result.restoredFiles).toEqual(['config.json']);
		});

		test('rejects missing required fields', () => {
			expect(() => RooSyncDecisionResultSchema.parse({
				decisionId: 'DEC-001'
			})).toThrow();
		});
	});

	// ============================================================
	// roosyncDecision function
	// ============================================================

	describe('roosyncDecision', () => {
		test('throws when decision not found', async () => {
			mockLoadDecisionDetails.mockResolvedValue(null);

			const { roosyncDecision } = await import('../decision.js');
			await expect(
				roosyncDecision({ action: 'approve', decisionId: 'DEC-999' })
			).rejects.toThrow('introuvable');
		});

		test('throws on invalid state transition', async () => {
			mockLoadDecisionDetails.mockResolvedValue({ status: 'applied' });
			mockValidateDecisionStatus.mockReturnValue(false);

			const { roosyncDecision } = await import('../decision.js');
			await expect(
				roosyncDecision({ action: 'approve', decisionId: 'DEC-001' })
			).rejects.toThrow('non permise');
		});
	});
});
