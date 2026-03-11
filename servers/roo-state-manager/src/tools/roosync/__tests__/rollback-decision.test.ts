/**
 * Tests pour rollback-decision.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
// Fix #636 timeout: Use static import instead of dynamic imports
import { RollbackDecisionArgsSchema, RollbackDecisionResultSchema, roosyncRollbackDecision } from '../rollback-decision.js';

const { mockGetConfig, mockGetDecision, mockRestoreFromRollbackPoint, mockClearCache } = vi.hoisted(() => ({
	mockGetConfig: vi.fn(),
	mockGetDecision: vi.fn(),
	mockRestoreFromRollbackPoint: vi.fn(),
	mockClearCache: vi.fn()
}));

const { mockReadFileSync, mockWriteFileSync, mockExistsSync } = vi.hoisted(() => ({
	mockReadFileSync: vi.fn(),
	mockWriteFileSync: vi.fn(),
	mockExistsSync: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: vi.fn(() => ({
		getConfig: mockGetConfig,
		getDecision: mockGetDecision,
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

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return { ...actual, default: actual, readFileSync: mockReadFileSync, writeFileSync: mockWriteFileSync, existsSync: mockExistsSync };
});

describe('rollback-decision', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConfig.mockReturnValue({ machineId: 'ai-01', sharedPath: '/shared' });
		mockExistsSync.mockReturnValue(true);
	});

	describe('RollbackDecisionArgsSchema', () => {
		test('requires both decisionId and reason', () => {
			expect(() => RollbackDecisionArgsSchema.parse({})).toThrow();
			expect(() => RollbackDecisionArgsSchema.parse({ decisionId: 'dec-1' })).toThrow();
			expect(() => RollbackDecisionArgsSchema.parse({ reason: 'test' })).toThrow();
		});

		test('accepts valid args', () => {
			const result = RollbackDecisionArgsSchema.parse({
				decisionId: 'dec-1',
				reason: 'Regression detected'
			});
			expect(result.decisionId).toBe('dec-1');
			expect(result.reason).toBe('Regression detected');
		});
	});

	describe('RollbackDecisionResultSchema', () => {
		test('validates complete result', () => {
			const result = RollbackDecisionResultSchema.parse({
				decisionId: 'dec-1',
				previousStatus: 'applied',
				newStatus: 'rolled_back',
				rolledBackAt: '2026-01-01T00:00:00Z',
				rolledBackBy: 'ai-01',
				reason: 'Regression',
				restoredFiles: ['mcp.json', 'settings.json'],
				executionLog: ['Step 1', 'Step 2']
			});
			expect(result.newStatus).toBe('rolled_back');
			expect(result.restoredFiles).toHaveLength(2);
		});

		test('rejects invalid newStatus', () => {
			expect(() => RollbackDecisionResultSchema.parse({
				decisionId: 'dec-1',
				previousStatus: 'applied',
				newStatus: 'pending',
				rolledBackAt: '2026-01-01',
				rolledBackBy: 'ai-01',
				reason: 'test',
				restoredFiles: [],
				executionLog: []
			})).toThrow();
		});
	});

	describe('roosyncRollbackDecision', () => {
		test('throws when decision not found', async () => {
			mockGetDecision.mockResolvedValue(null);
				await expect(roosyncRollbackDecision({
				decisionId: 'nope', reason: 'test'
			})).rejects.toThrow('introuvable');
		});

		test('throws when decision not applied', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-1', status: 'pending' });
				await expect(roosyncRollbackDecision({
				decisionId: 'dec-1', reason: 'test'
			})).rejects.toThrow('pas encore appliquée');
		});

		test('throws when decision approved but not applied', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-1', status: 'approved' });
				await expect(roosyncRollbackDecision({
				decisionId: 'dec-1', reason: 'test'
			})).rejects.toThrow('pas encore appliquée');
		});

		test('rolls back applied decision', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-2', status: 'applied' });
			mockRestoreFromRollbackPoint.mockResolvedValue({
				success: true,
				restoredFiles: ['mcp.json'],
				logs: ['Restored mcp.json']
			});
			mockReadFileSync.mockReturnValue(
				'<!-- DECISION_BLOCK_START -->\n**ID:** `dec-2`\n**Statut:** applied\n<!-- DECISION_BLOCK_END -->'
			);

				const result = await roosyncRollbackDecision({
				decisionId: 'dec-2', reason: 'Regression detected'
			});

			expect(result.newStatus).toBe('rolled_back');
			expect(result.previousStatus).toBe('applied');
			expect(result.rolledBackBy).toBe('ai-01');
			expect(result.reason).toBe('Regression detected');
			expect(result.restoredFiles).toEqual(['mcp.json']);
			expect(mockWriteFileSync).toHaveBeenCalled();
		});

		test('writes rollback metadata to roadmap', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-3', status: 'applied' });
			mockRestoreFromRollbackPoint.mockResolvedValue({
				success: true, restoredFiles: ['config.json'], logs: []
			});
			mockReadFileSync.mockReturnValue(
				'<!-- DECISION_BLOCK_START -->\n**ID:** `dec-3`\n**Statut:** applied\n<!-- DECISION_BLOCK_END -->'
			);

				await roosyncRollbackDecision({ decisionId: 'dec-3', reason: 'Bad config' });

			const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
			expect(writtenContent).toContain('rolled_back');
			expect(writtenContent).toContain('Bad config');
			expect(writtenContent).toContain('ai-01');
		});

		test('throws when restore fails', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-4', status: 'applied' });
			mockRestoreFromRollbackPoint.mockResolvedValue({
				success: false, error: 'Backup not found', restoredFiles: [], logs: []
			});

				await expect(roosyncRollbackDecision({
				decisionId: 'dec-4', reason: 'test'
			})).rejects.toThrow('Backup not found');
		});

		test('throws when roadmap file missing', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-5', status: 'applied' });
			mockRestoreFromRollbackPoint.mockResolvedValue({
				success: true, restoredFiles: [], logs: []
			});
			mockExistsSync.mockReturnValue(false);

				await expect(roosyncRollbackDecision({
				decisionId: 'dec-5', reason: 'test'
			})).rejects.toThrow('introuvable');
		});

		test('throws when block not found in roadmap', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-6', status: 'applied' });
			mockRestoreFromRollbackPoint.mockResolvedValue({
				success: true, restoredFiles: [], logs: []
			});
			mockReadFileSync.mockReturnValue('# Empty roadmap');

				await expect(roosyncRollbackDecision({
				decisionId: 'dec-6', reason: 'test'
			})).rejects.toThrow('introuvable dans sync-roadmap');
		});

		test('clears cache after rollback', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-7', status: 'applied' });
			mockRestoreFromRollbackPoint.mockResolvedValue({
				success: true, restoredFiles: [], logs: []
			});
			mockReadFileSync.mockReturnValue(
				'<!-- DECISION_BLOCK_START -->\n**ID:** `dec-7`\n**Statut:** applied\n<!-- DECISION_BLOCK_END -->'
			);

				await roosyncRollbackDecision({ decisionId: 'dec-7', reason: 'test' });

			expect(mockClearCache).toHaveBeenCalled();
		});

		test('includes execution log entries', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-8', status: 'applied' });
			mockRestoreFromRollbackPoint.mockResolvedValue({
				success: true, restoredFiles: ['a.json', 'b.json'], logs: ['Log entry 1']
			});
			mockReadFileSync.mockReturnValue(
				'<!-- DECISION_BLOCK_START -->\n**ID:** `dec-8`\n**Statut:** applied\n<!-- DECISION_BLOCK_END -->'
			);

				const result = await roosyncRollbackDecision({ decisionId: 'dec-8', reason: 'test' });

			expect(result.executionLog.length).toBeGreaterThan(0);
			expect(result.executionLog.some(l => l.includes('ROLLBACK_DECISION'))).toBe(true);
		});
	});
});
