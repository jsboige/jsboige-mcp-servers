import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChangeApplier } from '../../../../src/services/baseline/ChangeApplier.js';
import { SyncDecision, BaselineServiceErrorCode } from '../../../../src/types/baseline.js';

describe('ChangeApplier', () => {
  let applier: ChangeApplier;

  beforeEach(() => {
    applier = new ChangeApplier();
  });

  describe('applyDecision', () => {
    it('should throw error if decision is not approved', async () => {
      const decision: SyncDecision = {
        id: 'd1',
        machineId: 'm1',
        differenceId: 'diff1',
        category: 'config',
        description: 'desc',
        baselineValue: 'a',
        targetValue: 'b',
        action: 'sync_to_baseline',
        severity: 'CRITICAL',
        status: 'pending',
        createdAt: '2023-01-01T00:00:00Z'
      };

      try {
        await applier.applyDecision(decision);
      } catch (error: any) {
        expect(error.code).toBe(BaselineServiceErrorCode.DECISION_INVALID_STATUS);
      }
    });

    it('should apply config changes successfully', async () => {
      const decision: SyncDecision = {
        id: 'd1',
        machineId: 'm1',
        differenceId: 'roo.modes',
        category: 'config',
        description: 'desc',
        baselineValue: 'a',
        targetValue: 'b',
        action: 'sync_to_baseline',
        severity: 'CRITICAL',
        status: 'approved',
        createdAt: '2023-01-01T00:00:00Z'
      };

      const result = await applier.applyDecision(decision);

      expect(result.success).toBe(true);
      expect(result.decisionId).toBe('d1');
    });

    it('should apply software changes successfully', async () => {
      const decision: SyncDecision = {
        id: 'd2',
        machineId: 'm1',
        differenceId: 'software.node',
        category: 'software',
        description: 'desc',
        baselineValue: '18',
        targetValue: '20',
        action: 'sync_to_baseline',
        severity: 'WARNING',
        status: 'approved',
        createdAt: '2023-01-01T00:00:00Z'
      };

      const result = await applier.applyDecision(decision);

      expect(result.success).toBe(true);
    });

    it('should handle system changes (read-only)', async () => {
      const decision: SyncDecision = {
        id: 'd3',
        machineId: 'm1',
        differenceId: 'system.os',
        category: 'system',
        description: 'desc',
        baselineValue: 'win',
        targetValue: 'linux',
        action: 'sync_to_baseline',
        severity: 'INFO',
        status: 'approved',
        createdAt: '2023-01-01T00:00:00Z'
      };

      const result = await applier.applyDecision(decision);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Échec lors de l\'application des changements');
    });

    it('should handle hardware changes (manual)', async () => {
      const decision: SyncDecision = {
        id: 'd4',
        machineId: 'm1',
        differenceId: 'hardware.cpu',
        category: 'hardware',
        description: 'desc',
        baselineValue: '4',
        targetValue: '8',
        action: 'keep_target',
        severity: 'IMPORTANT',
        status: 'approved',
        createdAt: '2023-01-01T00:00:00Z'
      };

      const result = await applier.applyDecision(decision);

      expect(result.success).toBe(false);
    });
  });
});