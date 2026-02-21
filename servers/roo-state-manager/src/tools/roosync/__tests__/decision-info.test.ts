/**
 * Tests unitaires pour roosync_decision_info
 *
 * Couvre la consultation read-only des décisions :
 * - Cas de base (décision trouvée)
 * - Décision introuvable (throw)
 * - includeHistory: false
 * - includeLogs: false
 * - Historiques selon statut (approved, rejected, applied, rolled_back)
 *
 * Framework: Vitest
 * Coverage cible: >80%
 *
 * @module roosync/decision-info.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// Mock RooSyncService
vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: vi.fn(() => ({
    getConfig: vi.fn(() => ({
      sharedPath: '/mock/shared',
      machineId: 'test-machine'
    }))
  })),
  RooSyncServiceError: class RooSyncServiceError extends Error {
    constructor(message: string, public code: string) {
      super(message);
      this.name = 'RooSyncServiceError';
    }
  }
}));

// Mock roosync-parsers
const mockParseRoadmapMarkdown = vi.fn();
const mockFindDecisionById = vi.fn();

vi.mock('../../../utils/roosync-parsers.js', () => ({
  parseRoadmapMarkdown: (...args: any[]) => mockParseRoadmapMarkdown(...args),
  findDecisionById: (...args: any[]) => mockFindDecisionById(...args)
}));

// Mock path.join pour éviter les vraies lectures de fichiers
vi.mock('path', async () => {
  const actual = await vi.importActual('path');
  return actual;
});

import { roosyncDecisionInfo } from '../decision-info.js';

describe('roosyncDecisionInfo', () => {
  const baseDecision = {
    id: 'DEC-001',
    title: 'Test Decision',
    status: 'pending',
    type: 'config',
    path: '/some/path',
    sourceMachine: 'source-machine',
    targetMachines: ['target-1'],
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'creator-machine'
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockParseRoadmapMarkdown.mockReturnValue([baseDecision]);
    mockFindDecisionById.mockReturnValue(baseDecision);
  });

  // ============================================================
  // Cas de base
  // ============================================================

  describe('cas de base', () => {
    test('retourne la décision avec champs essentiels', async () => {
      const result = await roosyncDecisionInfo({ decisionId: 'DEC-001' });

      expect(result.decision.id).toBe('DEC-001');
      expect(result.decision.title).toBe('Test Decision');
      expect(result.decision.status).toBe('pending');
      expect(result.decision.type).toBe('config');
      expect(result.decision.sourceMachine).toBe('source-machine');
      expect(result.decision.targetMachines).toEqual(['target-1']);
    });

    test('retourne un historique avec created par défaut', async () => {
      const result = await roosyncDecisionInfo({ decisionId: 'DEC-001' });

      expect(result.history).toBeDefined();
      expect(result.history!.created.at).toBe('2026-01-01T00:00:00.000Z');
      expect(result.history!.created.by).toBe('creator-machine');
    });

    test('retourne le rollbackPoint', async () => {
      const result = await roosyncDecisionInfo({ decisionId: 'DEC-001' });

      expect(result.rollbackPoint).toBeDefined();
      expect(result.rollbackPoint!.available).toBe(false); // pending status
    });

    test('appelle parseRoadmapMarkdown avec le bon chemin', async () => {
      await roosyncDecisionInfo({ decisionId: 'DEC-001' });

      expect(mockParseRoadmapMarkdown).toHaveBeenCalledWith(
        expect.stringContaining('sync-roadmap.md')
      );
    });

    test('appelle findDecisionById avec le bon ID', async () => {
      await roosyncDecisionInfo({ decisionId: 'DEC-001' });

      expect(mockFindDecisionById).toHaveBeenCalledWith(
        expect.any(Array),
        'DEC-001'
      );
    });
  });

  // ============================================================
  // Décision introuvable
  // ============================================================

  describe('décision introuvable', () => {
    test('lève une erreur si la décision n\'existe pas', async () => {
      mockFindDecisionById.mockReturnValue(null);

      await expect(roosyncDecisionInfo({ decisionId: 'NONEXISTENT' }))
        .rejects.toThrow("Décision 'NONEXISTENT' introuvable");
    });

    test('lève une erreur avec code DECISION_NOT_FOUND', async () => {
      mockFindDecisionById.mockReturnValue(null);

      try {
        await roosyncDecisionInfo({ decisionId: 'NONEXISTENT' });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('DECISION_NOT_FOUND');
      }
    });
  });

  // ============================================================
  // includeHistory: false
  // ============================================================

  describe('includeHistory: false', () => {
    test('ne retourne pas l\'historique', async () => {
      const result = await roosyncDecisionInfo({
        decisionId: 'DEC-001',
        includeHistory: false
      });

      expect(result.history).toBeUndefined();
    });

    test('retourne quand même la décision', async () => {
      const result = await roosyncDecisionInfo({
        decisionId: 'DEC-001',
        includeHistory: false
      });

      expect(result.decision.id).toBe('DEC-001');
    });
  });

  // ============================================================
  // includeLogs: false
  // ============================================================

  describe('includeLogs: false', () => {
    test('ne retourne pas les logs quand absent', async () => {
      const result = await roosyncDecisionInfo({
        decisionId: 'DEC-001',
        includeLogs: false
      });

      expect(result.executionLogs).toBeUndefined();
    });

    test('retourne les logs quand présents et includeLogs=true', async () => {
      const decisionWithLogs = {
        ...baseDecision,
        executionLogs: ['log line 1', 'log line 2']
      };
      mockFindDecisionById.mockReturnValue(decisionWithLogs);

      const result = await roosyncDecisionInfo({
        decisionId: 'DEC-001',
        includeLogs: true
      });

      expect(result.executionLogs).toEqual(['log line 1', 'log line 2']);
    });

    test('ne retourne pas les logs si includeLogs=false même si présents', async () => {
      const decisionWithLogs = {
        ...baseDecision,
        executionLogs: ['log line 1']
      };
      mockFindDecisionById.mockReturnValue(decisionWithLogs);

      const result = await roosyncDecisionInfo({
        decisionId: 'DEC-001',
        includeLogs: false
      });

      expect(result.executionLogs).toBeUndefined();
    });
  });

  // ============================================================
  // Historiques selon le statut
  // ============================================================

  describe('historique : statut approved', () => {
    test('inclut approved dans l\'historique', async () => {
      const approvedDecision = {
        ...baseDecision,
        status: 'approved',
        approvedAt: '2026-01-02T00:00:00.000Z',
        approvedBy: 'approver-machine',
        approvalComment: 'LGTM'
      };
      mockFindDecisionById.mockReturnValue(approvedDecision);

      const result = await roosyncDecisionInfo({ decisionId: 'DEC-001' });

      expect(result.history!.approved).toBeDefined();
      expect(result.history!.approved!.at).toBe('2026-01-02T00:00:00.000Z');
      expect(result.history!.approved!.by).toBe('approver-machine');
      expect(result.history!.approved!.comment).toBe('LGTM');
    });

    test('rollbackPoint.available = false pour approved', async () => {
      const approvedDecision = { ...baseDecision, status: 'approved' };
      mockFindDecisionById.mockReturnValue(approvedDecision);

      const result = await roosyncDecisionInfo({ decisionId: 'DEC-001' });

      expect(result.rollbackPoint!.available).toBe(false);
    });
  });

  describe('historique : statut rejected', () => {
    test('inclut rejected dans l\'historique', async () => {
      const rejectedDecision = {
        ...baseDecision,
        status: 'rejected',
        rejectedAt: '2026-01-02T00:00:00.000Z',
        rejectedBy: 'reviewer-machine',
        rejectionReason: 'Not ready'
      };
      mockFindDecisionById.mockReturnValue(rejectedDecision);

      const result = await roosyncDecisionInfo({ decisionId: 'DEC-001' });

      expect(result.history!.rejected).toBeDefined();
      expect(result.history!.rejected!.at).toBe('2026-01-02T00:00:00.000Z');
      expect(result.history!.rejected!.by).toBe('reviewer-machine');
      expect(result.history!.rejected!.reason).toBe('Not ready');
    });

    test('raison par défaut si rejectionReason absent', async () => {
      const rejectedDecision = {
        ...baseDecision,
        status: 'rejected',
        rejectedAt: '2026-01-02T00:00:00.000Z',
        rejectedBy: 'reviewer-machine'
        // No rejectionReason
      };
      mockFindDecisionById.mockReturnValue(rejectedDecision);

      const result = await roosyncDecisionInfo({ decisionId: 'DEC-001' });

      expect(result.history!.rejected!.reason).toBe('No reason provided');
    });
  });

  describe('historique : statut applied', () => {
    test('inclut applied dans l\'historique', async () => {
      const appliedDecision = {
        ...baseDecision,
        status: 'applied',
        appliedAt: '2026-01-03T00:00:00.000Z',
        appliedBy: 'executor-machine',
        filesModified: ['file1.ts'],
        filesCreated: ['file2.ts'],
        filesDeleted: [],
        backupPath: '/backup/path',
        backupCreatedAt: '2026-01-03T00:01:00.000Z'
      };
      mockFindDecisionById.mockReturnValue(appliedDecision);

      const result = await roosyncDecisionInfo({ decisionId: 'DEC-001' });

      expect(result.history!.applied).toBeDefined();
      expect(result.history!.applied!.at).toBe('2026-01-03T00:00:00.000Z');
      expect(result.history!.applied!.by).toBe('executor-machine');
      expect(result.history!.applied!.changes.filesModified).toEqual(['file1.ts']);
      expect(result.history!.applied!.changes.filesCreated).toEqual(['file2.ts']);
      expect(result.history!.applied!.changes.filesDeleted).toEqual([]);
    });

    test('rollbackPoint.available = true si backupPath présent', async () => {
      const appliedDecision = {
        ...baseDecision,
        status: 'applied',
        appliedAt: '2026-01-03T00:00:00.000Z',
        backupPath: '/backup/path'
      };
      mockFindDecisionById.mockReturnValue(appliedDecision);

      const result = await roosyncDecisionInfo({ decisionId: 'DEC-001' });

      expect(result.rollbackPoint!.available).toBe(true);
    });
  });

  describe('historique : statut rolled_back', () => {
    test('inclut rolledBack dans l\'historique', async () => {
      const rolledBackDecision = {
        ...baseDecision,
        status: 'rolled_back',
        rolledBackAt: '2026-01-04T00:00:00.000Z',
        rolledBackBy: 'admin-machine',
        rollbackReason: 'Critical bug'
      };
      mockFindDecisionById.mockReturnValue(rolledBackDecision);

      const result = await roosyncDecisionInfo({ decisionId: 'DEC-001' });

      expect(result.history!.rolledBack).toBeDefined();
      expect(result.history!.rolledBack!.at).toBe('2026-01-04T00:00:00.000Z');
      expect(result.history!.rolledBack!.by).toBe('admin-machine');
      expect(result.history!.rolledBack!.reason).toBe('Critical bug');
    });

    test('raison par défaut si rollbackReason absent', async () => {
      const rolledBackDecision = {
        ...baseDecision,
        status: 'rolled_back',
        rolledBackAt: '2026-01-04T00:00:00.000Z',
        rolledBackBy: 'admin-machine'
        // No rollbackReason
      };
      mockFindDecisionById.mockReturnValue(rolledBackDecision);

      const result = await roosyncDecisionInfo({ decisionId: 'DEC-001' });

      expect(result.history!.rolledBack!.reason).toBe('No reason provided');
    });
  });

  // ============================================================
  // Valeurs par défaut
  // ============================================================

  describe('valeurs par défaut', () => {
    test('type par défaut = config si absent', async () => {
      const decisionWithoutType = { ...baseDecision };
      delete (decisionWithoutType as any).type;
      mockFindDecisionById.mockReturnValue(decisionWithoutType);

      const result = await roosyncDecisionInfo({ decisionId: 'DEC-001' });

      expect(result.decision.type).toBe('config');
    });

    test('sourceMachine = machineId config si absent', async () => {
      const decisionWithoutSource = { ...baseDecision };
      delete (decisionWithoutSource as any).sourceMachine;
      mockFindDecisionById.mockReturnValue(decisionWithoutSource);

      const result = await roosyncDecisionInfo({ decisionId: 'DEC-001' });

      expect(result.decision.sourceMachine).toBe('test-machine');
    });

    test('targetMachines = [] si absent', async () => {
      const decisionWithoutTargets = { ...baseDecision };
      delete (decisionWithoutTargets as any).targetMachines;
      mockFindDecisionById.mockReturnValue(decisionWithoutTargets);

      const result = await roosyncDecisionInfo({ decisionId: 'DEC-001' });

      expect(result.decision.targetMachines).toEqual([]);
    });

    test('history.created.by = sourceMachine si createdBy absent', async () => {
      const decisionWithoutCreatedBy = { ...baseDecision };
      delete (decisionWithoutCreatedBy as any).createdBy;
      mockFindDecisionById.mockReturnValue(decisionWithoutCreatedBy);

      const result = await roosyncDecisionInfo({ decisionId: 'DEC-001' });

      expect(result.history!.created.by).toBe('source-machine');
    });
  });
});
