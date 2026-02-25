/**
 * Tests d'exécution pour roosync_decision
 *
 * Couvre les chemins d'exécution de la fonction roosyncDecision
 * pour améliorer la couverture de tests (38.15% -> objectif 80%+)
 *
 * @module roosync/decision-execution.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock des helpers
const mockUpdateRoadmapStatus = vi.fn();
const mockValidateDecisionStatus = vi.fn();
const mockFormatDecisionResult = vi.fn();
const mockLoadDecisionDetails = vi.fn();

vi.mock('../../../../src/tools/roosync/utils/decision-helpers.js', () => ({
  updateRoadmapStatus: mockUpdateRoadmapStatus,
  validateDecisionStatus: mockValidateDecisionStatus,
  formatDecisionResult: mockFormatDecisionResult,
  loadDecisionDetails: mockLoadDecisionDetails
}));

// Mock du service RooSync
vi.mock('../../../../src/services/RooSyncService.js', () => ({
  getRooSyncService: () => ({
    getConfig: () => ({
      machineId: 'test-machine-01'
    })
  }),
  RooSyncServiceError: class RooSyncServiceError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
      this.name = 'RooSyncServiceError';
    }
  }
}));

describe('roosync_decision - Execution - Action Approve', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('devrait approuver une décision avec succès', async () => {
    mockLoadDecisionDetails.mockResolvedValueOnce({
      decisionId: 'DEC-001',
      status: 'pending'
    });

    mockValidateDecisionStatus.mockReturnValue(true);

    mockFormatDecisionResult.mockReturnValue({
      decisionId: 'DEC-001',
      action: 'approve',
      previousStatus: 'pending',
      newStatus: 'approved',
      timestamp: new Date().toISOString(),
      machineId: 'test-machine-01',
      comment: 'LGTM',
      nextSteps: []
    });

    const { roosyncDecision } = await import('../../../../src/tools/roosync/decision.js');

    const result = await roosyncDecision({
      action: 'approve',
      decisionId: 'DEC-001',
      comment: 'LGTM'
    });

    expect(result.action).toBe('approve');
    expect(result.newStatus).toBe('approved');
    expect(mockUpdateRoadmapStatus).toHaveBeenCalled();
  });

  it('devrait approuver sans commentaire', async () => {
    mockLoadDecisionDetails.mockResolvedValueOnce({
      decisionId: 'DEC-002',
      status: 'pending'
    });

    mockValidateDecisionStatus.mockReturnValue(true);

    mockFormatDecisionResult.mockReturnValue({
      decisionId: 'DEC-002',
      action: 'approve',
      previousStatus: 'pending',
      newStatus: 'approved',
      timestamp: new Date().toISOString(),
      machineId: 'test-machine-01',
      nextSteps: []
    });

    const { roosyncDecision } = await import('../../../../src/tools/roosync/decision.js');

    const result = await roosyncDecision({
      action: 'approve',
      decisionId: 'DEC-002'
    });

    expect(result.action).toBe('approve');
  });
});

describe('roosync_decision - Execution - Action Reject', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('devrait rejeter une décision avec raison', async () => {
    mockLoadDecisionDetails.mockResolvedValueOnce({
      decisionId: 'DEC-003',
      status: 'pending'
    });

    mockValidateDecisionStatus.mockReturnValue(true);

    mockFormatDecisionResult.mockReturnValue({
      decisionId: 'DEC-003',
      action: 'reject',
      previousStatus: 'pending',
      newStatus: 'rejected',
      timestamp: new Date().toISOString(),
      machineId: 'test-machine-01',
      reason: 'Conflits détectés',
      nextSteps: []
    });

    const { roosyncDecision } = await import('../../../../src/tools/roosync/decision.js');

    const result = await roosyncDecision({
      action: 'reject',
      decisionId: 'DEC-003',
      reason: 'Conflits détectés'
    });

    expect(result.action).toBe('reject');
    expect(result.newStatus).toBe('rejected');
    expect(mockUpdateRoadmapStatus).toHaveBeenCalledWith(
      expect.anything(),
      'DEC-003',
      'rejected',
      expect.objectContaining({ reason: 'Conflits détectés' })
    );
  });
});

describe('roosync_decision - Execution - Action Apply', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('devrait appliquer une décision en mode dry-run', async () => {
    mockLoadDecisionDetails.mockResolvedValueOnce({
      decisionId: 'DEC-004',
      status: 'approved'
    });

    mockValidateDecisionStatus.mockReturnValue(true);

    mockFormatDecisionResult.mockReturnValue({
      decisionId: 'DEC-004',
      action: 'apply',
      previousStatus: 'approved',
      newStatus: 'approved', // dry-run ne change pas le statut
      timestamp: new Date().toISOString(),
      machineId: 'test-machine-01',
      executionLog: [
        '[DRY-RUN] Simulation d\'application de la décision DEC-004',
        '[DRY-RUN] Aucune modification effectuée'
      ],
      nextSteps: ['Exécutez à nouveau sans dryRun pour appliquer réellement']
    });

    const { roosyncDecision } = await import('../../../../src/tools/roosync/decision.js');

    const result = await roosyncDecision({
      action: 'apply',
      decisionId: 'DEC-004',
      dryRun: true
    });

    expect(result.executionLog).toBeDefined();
    expect(result.executionLog?.[0]).toContain('DRY-RUN');
    // En dry-run, on retourne avant d'appeler updateRoadmapStatus
    expect(mockUpdateRoadmapStatus).not.toHaveBeenCalled();
  });

  it('devrait appliquer une décision avec succès', async () => {
    mockLoadDecisionDetails.mockResolvedValueOnce({
      decisionId: 'DEC-005',
      status: 'approved'
    });

    mockValidateDecisionStatus.mockReturnValue(true);

    mockFormatDecisionResult.mockReturnValue({
      decisionId: 'DEC-005',
      action: 'apply',
      previousStatus: 'approved',
      newStatus: 'applied',
      timestamp: new Date().toISOString(),
      machineId: 'test-machine-01',
      executionLog: ['[INFO] Backup créé avant application', '[INFO] Décision DEC-005 appliquée'],
      changes: { filesModified: [], filesCreated: [], filesDeleted: [] },
      rollbackAvailable: true,
      nextSteps: []
    });

    const { roosyncDecision } = await import('../../../../src/tools/roosync/decision.js');

    const result = await roosyncDecision({
      action: 'apply',
      decisionId: 'DEC-005',
      dryRun: false
    });

    expect(result.action).toBe('apply');
    expect(result.newStatus).toBe('applied');
    expect(result.rollbackAvailable).toBe(true);
    expect(mockUpdateRoadmapStatus).toHaveBeenCalled();
  });
});

describe('roosync_decision - Execution - Action Rollback', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('devrait rollback une décision avec succès', async () => {
    mockLoadDecisionDetails.mockResolvedValueOnce({
      decisionId: 'DEC-006',
      status: 'applied'
    });

    mockValidateDecisionStatus.mockReturnValue(true);

    mockFormatDecisionResult.mockReturnValue({
      decisionId: 'DEC-006',
      action: 'rollback',
      previousStatus: 'applied',
      newStatus: 'rolled_back',
      timestamp: new Date().toISOString(),
      machineId: 'test-machine-01',
      reason: 'Bug introduit',
      restoredFiles: [],
      nextSteps: []
    });

    const { roosyncDecision } = await import('../../../../src/tools/roosync/decision.js');

    const result = await roosyncDecision({
      action: 'rollback',
      decisionId: 'DEC-006',
      reason: 'Bug introduit'
    });

    expect(result.action).toBe('rollback');
    expect(result.newStatus).toBe('rolled_back');
    expect(mockUpdateRoadmapStatus).toHaveBeenCalled();
  });
});

describe('roosync_decision - Execution - Error Handling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('devrait lever une erreur si la décision n\'existe pas', async () => {
    mockLoadDecisionDetails.mockResolvedValueOnce(null);

    const { roosyncDecision } = await import('../../../../src/tools/roosync/decision.js');

    await expect(roosyncDecision({
      action: 'approve',
      decisionId: 'NON-EXISTENT'
    })).rejects.toThrow('introuvable');
  });

  it('devrait lever une erreur si la transition de statut est invalide', async () => {
    mockLoadDecisionDetails.mockResolvedValueOnce({
      decisionId: 'DEC-007',
      status: 'rejected' // Impossible d'approuver une décision déjà rejetée
    });

    mockValidateDecisionStatus.mockReturnValue(false);

    const { roosyncDecision } = await import('../../../../src/tools/roosync/decision.js');

    await expect(roosyncDecision({
      action: 'approve',
      decisionId: 'DEC-007'
    })).rejects.toThrow('non permise');
  });
});

describe('roosync_decision - Metadata', () => {
  it('devrait avoir les métadonnées correctes', async () => {
    const { roosyncDecisionToolMetadata } = await import('../../../../src/tools/roosync/decision.js');

    expect(roosyncDecisionToolMetadata.name).toBe('roosync_decision');
    expect(roosyncDecisionToolMetadata.description).toContain('approve');
    expect(roosyncDecisionToolMetadata.description).toContain('reject');
    expect(roosyncDecisionToolMetadata.inputSchema).toBeDefined();
  });
});
