/**
 * Tests pour reject-decision.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { RejectDecisionArgsSchema, RejectDecisionResultSchema } from '../reject-decision.js';

const { mockGetConfig, mockGetDecision } = vi.hoisted(() => ({
	mockGetConfig: vi.fn(),
	mockGetDecision: vi.fn()
}));

const { mockReadFileSync, mockWriteFileSync } = vi.hoisted(() => ({
	mockReadFileSync: vi.fn(),
	mockWriteFileSync: vi.fn()
}));

vi.mock('../../../services/RooSyncService.js', () => ({
	getRooSyncService: vi.fn(() => ({
		getConfig: mockGetConfig,
		getDecision: mockGetDecision
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
	return { ...actual, default: actual, readFileSync: mockReadFileSync, writeFileSync: mockWriteFileSync };
});

describe('reject-decision', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConfig.mockReturnValue({ machineId: 'ai-01', sharedPath: '/shared' });
	});

	describe('RejectDecisionArgsSchema', () => {
		test('requires both decisionId and reason', () => {
			expect(() => RejectDecisionArgsSchema.parse({})).toThrow();
			expect(() => RejectDecisionArgsSchema.parse({ decisionId: 'dec-1' })).toThrow();
		});

		test('accepts valid args', () => {
			const result = RejectDecisionArgsSchema.parse({
				decisionId: 'dec-1',
				reason: 'Incompatible config'
			});
			expect(result.decisionId).toBe('dec-1');
			expect(result.reason).toBe('Incompatible config');
		});
	});

	describe('RejectDecisionResultSchema', () => {
		test('validates complete result', () => {
			const result = RejectDecisionResultSchema.parse({
				decisionId: 'dec-1',
				previousStatus: 'pending',
				newStatus: 'rejected',
				rejectedAt: '2026-01-01T00:00:00Z',
				rejectedBy: 'ai-01',
				reason: 'Not needed',
				nextSteps: ['Consult roadmap']
			});
			expect(result.newStatus).toBe('rejected');
		});
	});

	describe('roosyncRejectDecision', () => {
		test('throws when decision not found', async () => {
			mockGetDecision.mockResolvedValue(null);
			const { roosyncRejectDecision } = await import('../reject-decision.js');
			await expect(roosyncRejectDecision({
				decisionId: 'nope', reason: 'test'
			})).rejects.toThrow('introuvable');
		});

		test('throws when decision already processed', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-1', status: 'rejected' });
			const { roosyncRejectDecision } = await import('../reject-decision.js');
			await expect(roosyncRejectDecision({
				decisionId: 'dec-1', reason: 'test'
			})).rejects.toThrow('déjà traitée');
		});

		test('rejects pending decision', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-2', status: 'pending' });
			mockReadFileSync.mockReturnValue(
				'<!-- DECISION_BLOCK_START -->\n**ID:** `dec-2`\n**Statut:** pending\n<!-- DECISION_BLOCK_END -->'
			);

			const { roosyncRejectDecision } = await import('../reject-decision.js');
			const result = await roosyncRejectDecision({
				decisionId: 'dec-2', reason: 'Config incompatible'
			});

			expect(result.newStatus).toBe('rejected');
			expect(result.reason).toBe('Config incompatible');
			expect(result.rejectedBy).toBe('ai-01');
			expect(mockWriteFileSync).toHaveBeenCalled();
		});

		test('writes rejection metadata to roadmap', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-3', status: 'pending' });
			mockReadFileSync.mockReturnValue(
				'<!-- DECISION_BLOCK_START -->\n**ID:** `dec-3`\n**Statut:** pending\n<!-- DECISION_BLOCK_END -->'
			);

			const { roosyncRejectDecision } = await import('../reject-decision.js');
			await roosyncRejectDecision({ decisionId: 'dec-3', reason: 'Bad timing' });

			const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
			expect(writtenContent).toContain('rejected');
			expect(writtenContent).toContain('Bad timing');
		});

		test('includes next steps', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-4', status: 'pending' });
			mockReadFileSync.mockReturnValue(
				'<!-- DECISION_BLOCK_START -->\n**ID:** `dec-4`\n**Statut:** pending\n<!-- DECISION_BLOCK_END -->'
			);

			const { roosyncRejectDecision } = await import('../reject-decision.js');
			const result = await roosyncRejectDecision({ decisionId: 'dec-4', reason: 'test' });
			expect(result.nextSteps.length).toBeGreaterThan(0);
		});
	});
});
