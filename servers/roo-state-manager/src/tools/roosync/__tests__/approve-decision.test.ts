/**
 * Tests pour approve-decision.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ApproveDecisionArgsSchema, ApproveDecisionResultSchema } from '../approve-decision.js';

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

describe('approve-decision', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConfig.mockReturnValue({ machineId: 'ai-01', sharedPath: '/shared' });
	});

	describe('ApproveDecisionArgsSchema', () => {
		test('requires decisionId', () => {
			expect(() => ApproveDecisionArgsSchema.parse({})).toThrow();
		});

		test('accepts decisionId only', () => {
			const result = ApproveDecisionArgsSchema.parse({ decisionId: 'dec-1' });
			expect(result.decisionId).toBe('dec-1');
		});

		test('accepts optional comment', () => {
			const result = ApproveDecisionArgsSchema.parse({ decisionId: 'dec-1', comment: 'LGTM' });
			expect(result.comment).toBe('LGTM');
		});
	});

	describe('ApproveDecisionResultSchema', () => {
		test('validates complete result', () => {
			const result = ApproveDecisionResultSchema.parse({
				decisionId: 'dec-1',
				previousStatus: 'pending',
				newStatus: 'approved',
				approvedAt: '2026-01-01T00:00:00Z',
				approvedBy: 'ai-01',
				nextSteps: ['Apply changes']
			});
			expect(result.newStatus).toBe('approved');
		});
	});

	describe('roosyncApproveDecision', () => {
		test('throws when decision not found', async () => {
			mockGetDecision.mockResolvedValue(null);
			const { roosyncApproveDecision } = await import('../approve-decision.js');
			await expect(roosyncApproveDecision({ decisionId: 'nope' })).rejects.toThrow('introuvable');
		});

		test('throws when decision already processed', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-1', status: 'approved' });
			const { roosyncApproveDecision } = await import('../approve-decision.js');
			await expect(roosyncApproveDecision({ decisionId: 'dec-1' })).rejects.toThrow('déjà traitée');
		});

		test('approves pending decision', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-2', status: 'pending' });
			mockReadFileSync.mockReturnValue(
				'<!-- DECISION_BLOCK_START -->\n**ID:** `dec-2`\n**Statut:** pending\n<!-- DECISION_BLOCK_END -->'
			);

			const { roosyncApproveDecision } = await import('../approve-decision.js');
			const result = await roosyncApproveDecision({ decisionId: 'dec-2', comment: 'Good to go' });

			expect(result.newStatus).toBe('approved');
			expect(result.previousStatus).toBe('pending');
			expect(result.approvedBy).toBe('ai-01');
			expect(result.comment).toBe('Good to go');
			expect(mockWriteFileSync).toHaveBeenCalled();
		});

		test('throws when block not found in roadmap', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-3', status: 'pending' });
			mockReadFileSync.mockReturnValue('# Empty roadmap\nNo decisions here');

			const { roosyncApproveDecision } = await import('../approve-decision.js');
			await expect(roosyncApproveDecision({ decisionId: 'dec-3' })).rejects.toThrow('introuvable dans sync-roadmap');
		});

		test('includes next steps in result', async () => {
			mockGetDecision.mockResolvedValue({ id: 'dec-4', status: 'pending' });
			mockReadFileSync.mockReturnValue(
				'<!-- DECISION_BLOCK_START -->\n**ID:** `dec-4`\n**Statut:** pending\n<!-- DECISION_BLOCK_END -->'
			);

			const { roosyncApproveDecision } = await import('../approve-decision.js');
			const result = await roosyncApproveDecision({ decisionId: 'dec-4' });

			expect(result.nextSteps.length).toBeGreaterThan(0);
		});
	});
});
