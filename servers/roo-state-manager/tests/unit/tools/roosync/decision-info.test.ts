/**
 * Tests for roosync_decision_info tool
 *
 * Covers: decision lookup, history building per status,
 * includeHistory/includeLogs toggles, rollback info, error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { roosyncDecisionInfo, roosyncDecisionInfoToolMetadata } from '../../../../src/tools/roosync/decision-info.js';

const {
    mockGetRooSyncService,
    mockParseRoadmapMarkdown,
    mockFindDecisionById,
} = vi.hoisted(() => ({
    mockGetRooSyncService: vi.fn(),
    mockParseRoadmapMarkdown: vi.fn(),
    mockFindDecisionById: vi.fn(),
}));

vi.mock('../../../../src/services/lazy-roosync.js', () => ({
    getRooSyncService: mockGetRooSyncService,
    RooSyncServiceError: class extends Error {
        code: string;
        constructor(msg: string, code: string) {
            super(msg);
            this.code = code;
            this.name = 'RooSyncServiceError';
        }
    },
}));

vi.mock('../../../../src/utils/roosync-parsers.js', () => ({
    parseRoadmapMarkdown: mockParseRoadmapMarkdown,
    findDecisionById: mockFindDecisionById,
}));

function setupService() {
    mockGetRooSyncService.mockResolvedValue({
        getConfig: () => ({ sharedPath: '/tmp/shared', machineId: 'myia-po-2025' }),
    });
    mockParseRoadmapMarkdown.mockReturnValue([]);
}

describe('roosync_decision_info', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupService();
    });

    it('returns decision details for approved decision', async () => {
        mockFindDecisionById.mockReturnValue({
            id: 'DEC-001', title: 'Config update', status: 'approved',
            type: 'config', path: '/etc/config.json',
            sourceMachine: 'myia-ai-01', targetMachines: ['myia-po-2025'],
            createdAt: '2026-05-04T00:00:00.000Z', createdBy: 'ai-01',
            approvedAt: '2026-05-04T01:00:00.000Z', approvedBy: 'po-2025',
            approvalComment: 'Looks good',
            details: 'Update config',
        });
        const result = await roosyncDecisionInfo({ decisionId: 'DEC-001' });
        expect(result.decision.id).toBe('DEC-001');
        expect(result.decision.status).toBe('approved');
        expect(result.history?.approved?.by).toBe('po-2025');
        expect(result.history?.approved?.comment).toBe('Looks good');
    });

    it('returns rejected decision with reason', async () => {
        mockFindDecisionById.mockReturnValue({
            id: 'DEC-002', title: 'Bad change', status: 'rejected',
            type: 'config', sourceMachine: 'myia-ai-01', targetMachines: [],
            createdAt: '2026-05-04T00:00:00.000Z',
            rejectedAt: '2026-05-04T01:00:00.000Z', rejectedBy: 'po-2025',
            rejectionReason: 'Breaking change',
        });
        const result = await roosyncDecisionInfo({ decisionId: 'DEC-002' });
        expect(result.history?.rejected?.reason).toBe('Breaking change');
    });

    it('returns applied decision with changes', async () => {
        mockFindDecisionById.mockReturnValue({
            id: 'DEC-003', title: 'Deploy', status: 'applied',
            type: 'config', sourceMachine: 'myia-ai-01', targetMachines: [],
            createdAt: '2026-05-04T00:00:00.000Z',
            appliedAt: '2026-05-04T02:00:00.000Z', appliedBy: 'po-2025',
            filesModified: ['a.json', 'b.json'], filesCreated: [], filesDeleted: [],
            backupPath: '/tmp/backup',
        });
        const result = await roosyncDecisionInfo({ decisionId: 'DEC-003' });
        expect(result.history?.applied?.changes.filesModified).toEqual(['a.json', 'b.json']);
        expect(result.rollbackPoint?.available).toBe(true);
    });

    it('returns rolled_back decision', async () => {
        mockFindDecisionById.mockReturnValue({
            id: 'DEC-004', title: 'Rollback', status: 'rolled_back',
            type: 'config', sourceMachine: 'myia-ai-01', targetMachines: [],
            createdAt: '2026-05-04T00:00:00.000Z',
            rolledBackAt: '2026-05-04T03:00:00.000Z', rolledBackBy: 'po-2025',
            rollbackReason: 'Regression detected',
        });
        const result = await roosyncDecisionInfo({ decisionId: 'DEC-004' });
        expect(result.history?.rolledBack?.reason).toBe('Regression detected');
    });

    it('omits history when includeHistory=false', async () => {
        mockFindDecisionById.mockReturnValue({
            id: 'DEC-005', title: 'Test', status: 'approved',
            type: 'config', sourceMachine: 'ai-01', targetMachines: [],
            createdAt: '2026-05-04T00:00:00.000Z', approvedAt: '2026-05-04T01:00:00.000Z',
        });
        const result = await roosyncDecisionInfo({ decisionId: 'DEC-005', includeHistory: false });
        expect(result.history).toBeUndefined();
    });

    it('includes execution logs when present and includeLogs=true', async () => {
        mockFindDecisionById.mockReturnValue({
            id: 'DEC-006', title: 'Logs', status: 'applied',
            type: 'config', sourceMachine: 'ai-01', targetMachines: [],
            createdAt: '2026-05-04T00:00:00.000Z',
            executionLogs: ['Step 1: OK', 'Step 2: OK'],
        });
        const result = await roosyncDecisionInfo({ decisionId: 'DEC-006' });
        expect(result.executionLogs).toEqual(['Step 1: OK', 'Step 2: OK']);
    });

    it('omits execution logs when includeLogs=false', async () => {
        mockFindDecisionById.mockReturnValue({
            id: 'DEC-007', title: 'Logs', status: 'pending',
            type: 'config', sourceMachine: 'ai-01', targetMachines: [],
            createdAt: '2026-05-04T00:00:00.000Z',
            executionLogs: ['Step 1: OK'],
        });
        const result = await roosyncDecisionInfo({ decisionId: 'DEC-007', includeLogs: false });
        expect(result.executionLogs).toBeUndefined();
    });

    it('throws when decision not found', async () => {
        mockFindDecisionById.mockReturnValue(null);
        await expect(roosyncDecisionInfo({ decisionId: 'MISSING' }))
            .rejects.toThrow('introuvable');
    });

    it('uses defaults for missing fields', async () => {
        mockFindDecisionById.mockReturnValue({
            id: 'DEC-008', title: 'Minimal', status: 'pending',
        });
        const result = await roosyncDecisionInfo({ decisionId: 'DEC-008' });
        expect(result.decision.type).toBe('config');
        expect(result.decision.sourceMachine).toBe('myia-po-2025');
        expect(result.decision.targetMachines).toEqual([]);
    });

    it('has correct metadata', () => {
        expect(roosyncDecisionInfoToolMetadata.name).toBe('roosync_decision_info');
    });
});
