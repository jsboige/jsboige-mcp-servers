/**
 * Tests pour apply-decision.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
// Fix #636 timeout: Use static import instead of dynamic imports
import { ApplyDecisionArgsSchema, ApplyDecisionResultSchema, roosyncApplyDecision } from '../apply-decision.js';

const { mockGetConfig, mockGetDecision, mockExecuteDecision, mockCreateRollbackPoint, mockRestoreFromRollbackPoint, mockClearCache } = vi.hoisted(() => ({
	mockGetConfig: vi.fn(),
	mockGetDecision: vi.fn(),
	mockExecuteDecision: vi.fn(),
	mockCreateRollbackPoint: vi.fn(),
	mockRestoreFromRollbackPoint: vi.fn(),
	mockClearCache: vi.fn()
}));

const { mockReadFileSync, mockWriteFileSync } = vi.hoisted(() => ({
	mockReadFileSync: vi.fn(),
	mockWriteFileSync: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: vi.fn(() => ({
		getConfig: mockGetConfig,
		getDecision: mockGetDecision,
		executeDecision: mockExecuteDecision,
		createRollbackPoint: mockCreateRollbackPoint,
		restoreFromRollbackPoint: mockRestoreFromRollbackPoint,
		clearCache: mockClearCache
	})),
	RooSyncServiceError: class extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message); this.name = 'RooSyncServiceError'; this.code = code;
		}
	}
}));

vi.mock('../../../types/errors.js', () => ({
	BaselineServiceError: class extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message); this.name = 'BaselineServiceError'; this.code = code;
		}
	},
	BaselineServiceErrorCode: { APPLICATION_FAILED: 'APPLICATION_FAILED' },
	// #1110: lazy-roosync.ts re-exports RooSyncServiceError from types/errors.js
	// Must be included here or instanceof checks fail with "not an object"
	RooSyncServiceError: class extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(`[RooSync Service] ${message}`); this.name = 'RooSyncServiceError'; this.code = code;
		}
	}
}));

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return { ...actual, default: actual, readFileSync: mockReadFileSync, writeFileSync: mockWriteFileSync };
});

describe('apply-decision', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConfig.mockReturnValue({ machineId: 'ai-01', sharedPath: '/shared' });
	});

	describe('ApplyDecisionArgsSchema', () => {
		test('requires decisionId', () => {
			expect(() => ApplyDecisionArgsSchema.parse({})).toThrow();
		});

		test('accepts decisionId only', () => {
			const result = ApplyDecisionArgsSchema.parse({ decisionId: 'dec-1' });
			expect(result.decisionId).toBe('dec-1');
			expect(result.dryRun).toBeUndefined();
			expect(result.force).toBeUndefined();
		});

		test('accepts optional dryRun and force', () => {
			const result = ApplyDecisionArgsSchema.parse({
				decisionId: 'dec-1', dryRun: true, force: true
			});
			expect(result.dryRun).toBe(true);
			expect(result.force).toBe(true);
		});
	});

	describe('ApplyDecisionResultSchema', () => {
		test('validates complete applied result', () => {
			const result = ApplyDecisionResultSchema.parse({
				decisionId: 'dec-1',
				previousStatus: 'approved',
				newStatus: 'applied',
				appliedAt: '2026-01-01T00:00:00Z',
				appliedBy: 'ai-01',
				executionLog: ['Step 1'],
				changes: { filesModified: ['a.json'], filesCreated: [], filesDeleted: [] },
				rollbackAvailable: true
			});
			expect(result.newStatus).toBe('applied');
			expect(result.rollbackAvailable).toBe(true);
		});

		test('validates failed result with error', () => {
			const result = ApplyDecisionResultSchema.parse({
				decisionId: 'dec-1',
				previousStatus: 'approved',
				newStatus: 'failed',
				appliedAt: '2026-01-01T00:00:00Z',
				appliedBy: 'ai-01',
				executionLog: ['Error occurred'],
				changes: { filesModified: [], filesCreated: [], filesDeleted: [] },
				rollbackAvailable: false,
				error: 'Permission denied'
			});
			expect(result.newStatus).toBe('failed');
			expect(result.error).toBe('Permission denied');
		});

		test('rejects invalid newStatus', () => {
			expect(() => ApplyDecisionResultSchema.parse({
				decisionId: 'dec-1', previousStatus: 'approved', newStatus: 'pending',
				appliedAt: '2026-01-01', appliedBy: 'ai-01', executionLog: [],
				changes: { filesModified: [], filesCreated: [], filesDeleted: [] },
				rollbackAvailable: false
			})).toThrow();
		});
	});

	describe('roosyncApplyDecision', () => {
		test('throws when decision not found', async () => {
			mockGetDecision.mockResolvedValue(null);
			await expect(roosyncApplyDecision({ decisionId: 'nope' })).rejects.toThrow('introuvable');
		});

		test('throws when decision not approved', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-1', status: 'pending' });
			await expect(roosyncApplyDecision({ decisionId: 'dec-1' })).rejects.toThrow('pas encore approuvée');
		});

		test('applies approved decision', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-2', status: 'approved' });
			mockCreateRollbackPoint.mockResolvedValue(undefined);
			mockExecuteDecision.mockResolvedValue({
				success: true,
				logs: ['Applied successfully'],
				changes: { filesModified: ['mcp.json'], filesCreated: [], filesDeleted: [] }
			});
			mockReadFileSync.mockReturnValue(
				'<!-- DECISION_BLOCK_START -->\n**ID:** `dec-2`\n**Statut:** approved\n<!-- DECISION_BLOCK_END -->'
			);

			const result = await roosyncApplyDecision({ decisionId: 'dec-2' });

			expect(result.newStatus).toBe('applied');
			expect(result.appliedBy).toBe('ai-01');
			expect(result.rollbackAvailable).toBe(true);
			expect(result.changes.filesModified).toContain('mcp.json');
			expect(mockCreateRollbackPoint).toHaveBeenCalledWith('dec-2');
			expect(mockWriteFileSync).toHaveBeenCalled();
		});

		test('handles dry run mode', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-3', status: 'approved' });
			mockExecuteDecision.mockResolvedValue({
				success: true,
				logs: ['[DRY RUN] Would modify mcp.json'],
				changes: { filesModified: ['mcp.json'], filesCreated: [], filesDeleted: [] }
			});

			const result = await roosyncApplyDecision({ decisionId: 'dec-3', dryRun: true });

			expect(result.rollbackAvailable).toBe(false);
			expect(mockCreateRollbackPoint).not.toHaveBeenCalled();
			expect(mockWriteFileSync).not.toHaveBeenCalled();
		});

		test('auto-rollback on execution failure', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-4', status: 'approved' });
			mockCreateRollbackPoint.mockResolvedValue(undefined);
			mockExecuteDecision.mockResolvedValue({
				success: false,
				error: 'Conflict detected',
				logs: ['Failed'],
				changes: { filesModified: [], filesCreated: [], filesDeleted: [] }
			});
			mockRestoreFromRollbackPoint.mockResolvedValue({ success: true, logs: ['Rolled back'] });
			mockReadFileSync.mockReturnValue(
				'<!-- DECISION_BLOCK_START -->\n**ID:** `dec-4`\n**Statut:** approved\n<!-- DECISION_BLOCK_END -->'
			);

			const result = await roosyncApplyDecision({ decisionId: 'dec-4' });

			expect(result.newStatus).toBe('failed');
			expect(result.error).toBeDefined();
			expect(mockRestoreFromRollbackPoint).toHaveBeenCalledWith('dec-4');
		});

		test('passes force flag to execution', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-5', status: 'approved' });
			mockCreateRollbackPoint.mockResolvedValue(undefined);
			mockExecuteDecision.mockResolvedValue({
				success: true, logs: [], changes: { filesModified: [], filesCreated: [], filesDeleted: [] }
			});
			mockReadFileSync.mockReturnValue(
				'<!-- DECISION_BLOCK_START -->\n**ID:** `dec-5`\n**Statut:** approved\n<!-- DECISION_BLOCK_END -->'
			);

			await roosyncApplyDecision({ decisionId: 'dec-5', force: true });

			expect(mockExecuteDecision).toHaveBeenCalledWith('dec-5', { dryRun: false, force: true });
		});

		test('writes application metadata to roadmap', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-6', status: 'approved' });
			mockCreateRollbackPoint.mockResolvedValue(undefined);
			mockExecuteDecision.mockResolvedValue({
				success: true, logs: [], changes: { filesModified: [], filesCreated: [], filesDeleted: [] }
			});
			mockReadFileSync.mockReturnValue(
				'<!-- DECISION_BLOCK_START -->\n**ID:** `dec-6`\n**Statut:** approved\n<!-- DECISION_BLOCK_END -->'
			);

			await roosyncApplyDecision({ decisionId: 'dec-6' });

			const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
			expect(writtenContent).toContain('applied');
			expect(writtenContent).toContain('ai-01');
			expect(writtenContent).toContain('Rollback disponible');
		});
	});
});
