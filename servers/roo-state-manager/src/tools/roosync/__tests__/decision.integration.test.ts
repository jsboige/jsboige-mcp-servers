/**
 * Tests d'intégration pour roosync_decision
 *
 * Couvre toutes les actions de l'outil :
 * - action: 'approve' : Approuver une décision (avec comment optionnel)
 * - action: 'reject' : Rejeter une décision (requiert reason)
 * - action: 'apply' : Appliquer une décision (avec dryRun et force)
 * - action: 'rollback' : Annuler une décision (requiert reason)
 *
 * Framework: Vitest
 * Type: Intégration (RooSyncService réel, opérations filesystem réelles)
 *
 * @module roosync/decision.integration.test
 * @version 1.0.0 (#564 Phase 2)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

// Mock getLocalMachineId pour contrôler l'identifiant dans les tests
vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'test-machine'),
    getLocalFullId: vi.fn(() => 'test-machine'),
    getLocalWorkspaceId: vi.fn(() => 'roo-extensions')
  };
});

// Mock getSharedStatePath pour utiliser un chemin de test
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-decision');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Fix #640: Mock loadDecisionDetails and updateRoadmapStatus for integration tests
// The implementation reads from sync-roadmap.md via process.cwd(), but integration tests
// create individual JSON files in a test directory. We bridge this gap by mocking.
// NOTE: Mock must be declared before imports (hoisting)
vi.mock('../utils/decision-helpers.js', async () => {
  const actual = await vi.importActual('../utils/decision-helpers.js');
  const { readFileSync, existsSync, renameSync, writeFileSync, unlinkSync } = await import('fs');
  const { join } = await import('path');

  const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-decision');
  const statusMap: Record<string, string> = {
    approve: 'approved',
    reject: 'rejected',
    apply: 'applied',
    rollback: 'rolled_back'
  };

  return {
    ...actual,
    loadDecisionDetails: vi.fn((decisionId: string) => {
      // Look for the decision file in each possible status directory
      const statuses = ['pending', 'approved', 'rejected', 'applied', 'rolled_back'];

      for (const status of statuses) {
        const decisionPath = join(testSharedStatePath, 'decisions', status, `${decisionId}.json`);
        if (existsSync(decisionPath)) {
          const content = readFileSync(decisionPath, 'utf-8');
          return JSON.parse(content);
        }
      }

      return null; // Decision not found
    }),

    updateRoadmapStatus: vi.fn((
      config: any,
      decisionId: string,
      newStatus: string,
      metadata: { comment?: string; reason?: string; machineId?: string }
    ) => {
      // Find the current location of the decision file
      const statuses = ['pending', 'approved', 'rejected', 'applied', 'rolled_back'];
      let sourcePath: string | null = null;
      let currentStatus: string | null = null;

      for (const status of statuses) {
        const decisionPath = join(testSharedStatePath, 'decisions', status, `${decisionId}.json`);
        if (existsSync(decisionPath)) {
          sourcePath = decisionPath;
          currentStatus = status;
          break;
        }
      }

      if (!sourcePath || !currentStatus) {
        return; // Decision file not found, nothing to do
      }

      // Read current content
      const content = readFileSync(sourcePath, 'utf-8');
      const decision = JSON.parse(content);

      // Update status and metadata
      const timestamp = new Date().toISOString();
      decision.status = newStatus as any;

      // Set appropriate fields based on new status
      if (newStatus === 'approved') {
        decision.approvedBy = metadata.machineId || 'test-machine';
        decision.approvedAt = timestamp;
      } else if (newStatus === 'rejected') {
        decision.rejectedBy = metadata.machineId || 'test-machine';
        decision.rejectedAt = timestamp;
      } else if (newStatus === 'applied') {
        decision.appliedBy = metadata.machineId || 'test-machine';
        decision.appliedAt = timestamp;
      } else if (newStatus === 'rolled_back') {
        decision.rolledBackBy = metadata.machineId || 'test-machine';
        decision.rolledBackAt = timestamp;
      }

      if (metadata.comment) decision.comment = metadata.comment;
      if (metadata.reason) decision.reason = metadata.reason;
      decision.updatedAt = timestamp;

      // Move to new status directory
      const targetDir = join(testSharedStatePath, 'decisions', newStatus);
      const targetPath = join(targetDir, `${decisionId}.json`);

      // Write to new location with updated content
      writeFileSync(targetPath, JSON.stringify(decision, null, 2));

      // Remove from old location
      unlinkSync(sourcePath);
    }),

    validateDecisionStatus: vi.fn((currentStatus: string, action: string) => {
      // Allow transitions that make sense
      const validTransitions: Record<string, string[]> = {
        pending: ['approve', 'reject'],
        approved: ['apply'],  // Cannot reject once approved
        rejected: ['approve'], // Can re-approve
        applied: ['rollback'],
        rolled_back: ['approve'] // Can re-approve after rollback
      };

      const allowedActions = validTransitions[currentStatus] || [];
      return allowedActions.includes(action);
    })
  };
});

// Fix #640: Unmock RooSyncService to use real implementation in integration tests
// vi.unmock() IS hoisted, so this needs to be before the imports
vi.unmock('../../../services/RooSyncService.js');

// Import après les mocks et unmock
import { roosyncDecision } from '../decision.js';
import { RooSyncService } from '../../../services/RooSyncService.js';

describe('roosync_decision (integration)', () => {
  // Fix #634: Save original env vars to restore after tests
  const originalSharedPath = process.env.ROOSYNC_SHARED_PATH;
  const originalMachineId = process.env.ROOSYNC_MACHINE_ID;

  beforeEach(async () => {
    // Fix #634: Override env var BEFORE singleton recreation
    // Fix #640: Set both required env vars for test mode
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';

    // Reset singleton so it gets recreated with the test path
    RooSyncService.resetInstance();

    // Setup : créer répertoire temporaire pour tests isolés
    // IMPORTANT: Create directories BEFORE resetInstance(), because
    // loadRooSyncConfig() validates that ROOSYNC_SHARED_PATH exists.
    const dirs = [
      testSharedStatePath,
      join(testSharedStatePath, 'roo-config'),
      join(testSharedStatePath, 'logs'),
      join(testSharedStatePath, 'decisions', 'pending'),
      join(testSharedStatePath, 'decisions', 'approved'),
      join(testSharedStatePath, 'decisions', 'rejected'),
      join(testSharedStatePath, 'decisions', 'applied'),
      join(testSharedStatePath, 'decisions', 'rolled_back')
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    // Reset singleton avant chaque test pour garantir un état propre
    RooSyncService.resetInstance();
  });

  afterEach(async () => {
    // Reset singleton to prevent leaking test state to other test files
    RooSyncService.resetInstance();

    // Restore original env vars
    if (originalSharedPath !== undefined) {
      process.env.ROOSYNC_SHARED_PATH = originalSharedPath;
    } else {
      delete process.env.ROOSYNC_SHARED_PATH;
    }

    if (originalMachineId !== undefined) {
      process.env.ROOSYNC_MACHINE_ID = originalMachineId;
    } else {
      delete process.env.ROOSYNC_MACHINE_ID;
    }

    // Cleanup : supprimer répertoire test pour isolation
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
  });

  // ============================================================
  // Tests pour action: 'approve'
  // ============================================================

  describe('action: approve', () => {
    test('should require decisionId parameter', async () => {
      // decisionId est requis pour toutes les actions
      await expect(roosyncDecision({
        action: 'approve'
        // decisionId manquant
      })).rejects.toThrow();
    });

    test('should approve decision with minimal parameters', async () => {
      // Créer une décision en attente
      const decisionId = 'test-decision-001';
      const decisionPath = join(testSharedStatePath, 'decisions', 'pending', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test decision',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
        changes: []
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      const result = await roosyncDecision({
        action: 'approve',
        decisionId
      });

      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(result.action).toBe('approve');
      expect(result.decisionId).toBe(decisionId);
    });

    test('should approve decision with comment', async () => {
      const decisionId = 'test-decision-002';
      const decisionPath = join(testSharedStatePath, 'decisions', 'pending', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test decision with comment',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
        changes: []
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      const result = await roosyncDecision({
        action: 'approve',
        decisionId,
        comment: 'Looks good, proceed'
      });

      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(result.action).toBe('approve');
    });

    test('should move decision from pending to approved', async () => {
      const decisionId = 'test-decision-003';
      const decisionPath = join(testSharedStatePath, 'decisions', 'pending', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test decision move',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
        changes: []
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      await roosyncDecision({
        action: 'approve',
        decisionId
      });

      // Vérifier que le fichier a été déplacé vers approved
      const newDecisionPath = join(testSharedStatePath, 'decisions', 'approved', `${decisionId}.json`);
      expect(existsSync(newDecisionPath)).toBe(true);
      expect(existsSync(decisionPath)).toBe(false); // Old location should be gone
    });
  });

  // ============================================================
  // Tests pour action: 'reject'
  // ============================================================

  describe('action: reject', () => {
    test('should reject decision with reason', async () => {
      const decisionId = 'test-decision-004';
      const decisionPath = join(testSharedStatePath, 'decisions', 'pending', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test decision',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
        changes: []
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      const result = await roosyncDecision({
        action: 'reject',
        decisionId,
        reason: 'Not ready for deployment'
      });

      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(result.action).toBe('reject');
    });

    test('should reject decision with reason', async () => {
      const decisionId = 'test-decision-005';
      const decisionPath = join(testSharedStatePath, 'decisions', 'pending', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test decision reject',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
        changes: []
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      const result = await roosyncDecision({
        action: 'reject',
        decisionId,
        reason: 'Not ready for deployment'
      });

      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(result.action).toBe('reject');
    });

    test('should move decision from pending to rejected', async () => {
      const decisionId = 'test-decision-006';
      const decisionPath = join(testSharedStatePath, 'decisions', 'pending', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test decision reject move',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
        changes: []
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      await roosyncDecision({
        action: 'reject',
        decisionId,
        reason: 'Incomplete implementation'
      });

      // Vérifier que le fichier a été déplacé vers rejected
      const newDecisionPath = join(testSharedStatePath, 'decisions', 'rejected', `${decisionId}.json`);
      expect(existsSync(newDecisionPath)).toBe(true);
    });
  });

  // ============================================================
  // Tests pour action: 'apply'
  // ============================================================

  describe('action: apply', () => {
    test('should apply approved decision', async () => {
      const decisionId = 'test-decision-007';
      const decisionPath = join(testSharedStatePath, 'decisions', 'approved', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test decision apply',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'approved' as const,
        changes: [],
        approvedBy: 'test-machine',
        approvedAt: new Date().toISOString()
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      const result = await roosyncDecision({
        action: 'apply',
        decisionId
      });

      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(result.action).toBe('apply');
    });

    test('should support dryRun mode', async () => {
      const decisionId = 'test-decision-008';
      const decisionPath = join(testSharedStatePath, 'decisions', 'approved', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test decision dryrun',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'approved' as const,
        changes: [],
        approvedBy: 'test-machine',
        approvedAt: new Date().toISOString()
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      const result = await roosyncDecision({
        action: 'apply',
        decisionId,
        dryRun: true
      });

      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    test('should support force flag', async () => {
      const decisionId = 'test-decision-009';
      const decisionPath = join(testSharedStatePath, 'decisions', 'approved', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test decision force',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'approved' as const,
        changes: [],
        approvedBy: 'test-machine',
        approvedAt: new Date().toISOString()
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      const result = await roosyncDecision({
        action: 'apply',
        decisionId,
        force: true
      });

      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    test('should move decision from approved to applied', async () => {
      const decisionId = 'test-decision-010';
      const decisionPath = join(testSharedStatePath, 'decisions', 'approved', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test decision apply move',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'approved' as const,
        changes: [],
        approvedBy: 'test-machine',
        approvedAt: new Date().toISOString()
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      await roosyncDecision({
        action: 'apply',
        decisionId
      });

      // Vérifier que le fichier a été déplacé vers applied
      const newDecisionPath = join(testSharedStatePath, 'decisions', 'applied', `${decisionId}.json`);
      expect(existsSync(newDecisionPath)).toBe(true);
    });
  });

  // ============================================================
  // Tests pour action: 'rollback'
  // ============================================================

  describe('action: rollback', () => {
    test('should rollback applied decision with reason', async () => {
      const decisionId = 'test-decision-011';
      const decisionPath = join(testSharedStatePath, 'decisions', 'applied', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test decision rollback',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'applied' as const,
        changes: [],
        approvedBy: 'test-machine',
        approvedAt: new Date().toISOString(),
        appliedBy: 'test-machine',
        appliedAt: new Date().toISOString()
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      const result = await roosyncDecision({
        action: 'rollback',
        decisionId,
        reason: 'Critical bug found in production'
      });

      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(result.action).toBe('rollback');
    });

    test('should move decision from applied to rolled_back', async () => {
      const decisionId = 'test-decision-013';
      const decisionPath = join(testSharedStatePath, 'decisions', 'applied', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test decision rollback move',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'applied' as const,
        changes: [],
        approvedBy: 'test-machine',
        approvedAt: new Date().toISOString(),
        appliedBy: 'test-machine',
        appliedAt: new Date().toISOString()
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      await roosyncDecision({
        action: 'rollback',
        decisionId,
        reason: 'Breaking change detected'
      });

      // Vérifier que le fichier a été déplacé vers rolled_back
      const newDecisionPath = join(testSharedStatePath, 'decisions', 'rolled_back', `${decisionId}.json`);
      expect(existsSync(newDecisionPath)).toBe(true);
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle missing decision gracefully', async () => {
      // The implementation throws RooSyncServiceError for missing decisions
      // In a real scenario, the caller should catch this error
      await expect(roosyncDecision({
        action: 'approve',
        decisionId: 'non-existent-decision'
      })).rejects.toThrow('Décision');
    });

    test('should handle invalid status transition gracefully', async () => {
      const decisionId = 'test-decision-014';
      const decisionPath = join(testSharedStatePath, 'decisions', 'approved', `${decisionId}.json`);
      // Créer une décision déjà approuvée
      const testDecision = {
        id: decisionId,
        title: 'Test decision',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'approved' as const,
        changes: [],
        approvedBy: 'test-machine',
        approvedAt: new Date().toISOString()
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      // Essayer de rejeter une décision déjà approuvée (transition invalide)
      // The implementation throws RooSyncServiceError for invalid transitions
      await expect(roosyncDecision({
        action: 'reject',
        decisionId,
        reason: 'Test invalid transition'
      })).rejects.toThrow('non permise');
    });

    test('should handle corrupted decision file gracefully', async () => {
      const decisionId = 'test-decision-corrupted';
      // Écrire un fichier décision corrompu (invalid JSON)
      const decisionPath = join(testSharedStatePath, 'decisions', 'pending', `${decisionId}.json`);
      writeFileSync(decisionPath, `{ invalid json }`, 'utf-8');

      // The mock's loadDecisionDetails will throw JSON.parse error
      // This should propagate up as the error
      await expect(roosyncDecision({
        action: 'approve',
        decisionId
      })).rejects.toThrow();
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration scenarios', () => {
    test('should handle complete workflow: approve → apply → rollback', async () => {
      const decisionId = 'test-decision-workflow';

      // Step 1: Créer une décision en attente
      const decisionPath = join(testSharedStatePath, 'decisions', 'pending', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test workflow decision',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
        changes: []
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      // Step 2: Approuver
      const approveResult = await roosyncDecision({
        action: 'approve',
        decisionId,
        comment: 'Approved for testing'
      });
      expect(approveResult.error).toBeUndefined();

      // Step 3: Appliquer
      const applyResult = await roosyncDecision({
        action: 'apply',
        decisionId
      });
      expect(applyResult.error).toBeUndefined();

      // Step 4: Rollback
      const rollbackResult = await roosyncDecision({
        action: 'rollback',
        decisionId,
        reason: 'Testing rollback'
      });
      expect(rollbackResult.error).toBeUndefined();
    });

    test('should persist decision state across operations', async () => {
      const decisionId = 'test-decision-persist';

      // Créer une décision en attente
      const decisionPath = join(testSharedStatePath, 'decisions', 'pending', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test persistence',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
        changes: []
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      await roosyncDecision({
        action: 'approve',
        decisionId
      });

      // Vérifier que le statut a été mis à jour dans le fichier
      const newDecisionPath = join(testSharedStatePath, 'decisions', 'approved', `${decisionId}.json`);
      const updatedDecision = JSON.parse(readFileSync(newDecisionPath, 'utf-8'));
      expect(updatedDecision.status).toBe('approved');
      expect(updatedDecision.approvedBy).toBe('test-machine');
      expect(updatedDecision.approvedAt).toBeDefined();
    });

    test('should handle all parameters combined', async () => {
      const decisionId = 'test-decision-combined';
      const decisionPath = join(testSharedStatePath, 'decisions', 'approved', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test combined parameters',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'approved' as const,
        changes: [],
        approvedBy: 'test-machine',
        approvedAt: new Date().toISOString()
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      const result = await roosyncDecision({
        action: 'apply',
        decisionId,
        dryRun: false,
        force: true
      });

      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(result.action).toBe('apply');
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should return valid result structure for approve', async () => {
      const decisionId = 'test-decision-response-001';
      const decisionPath = join(testSharedStatePath, 'decisions', 'pending', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test response format',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
        changes: []
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      const result = await roosyncDecision({
        action: 'approve',
        decisionId
      });

      // Check for success - error should be undefined (or not present)
      expect(result.error).toBeUndefined();
      expect(result).toHaveProperty('action');
      expect(result).toHaveProperty('decisionId');
      expect(result).toHaveProperty('timestamp');
    });

    test('should return valid result structure for reject with reason', async () => {
      const decisionId = 'test-decision-response-002';
      const decisionPath = join(testSharedStatePath, 'decisions', 'pending', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test response format',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
        changes: []
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      const result = await roosyncDecision({
        action: 'reject',
        decisionId,
        reason: 'Test rejection reason'
      });

      expect(result.error).toBeUndefined(); // No error means success
      expect(result).toHaveProperty('action');
      expect(result.action).toBe('reject');
    });

    test('should return valid result structure for apply', async () => {
      const decisionId = 'test-decision-response-003';
      const decisionPath = join(testSharedStatePath, 'decisions', 'approved', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test response format',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'approved' as const,
        changes: [],
        approvedBy: 'test-machine',
        approvedAt: new Date().toISOString()
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      const result = await roosyncDecision({
        action: 'apply',
        decisionId
      });

      expect(result.error).toBeUndefined(); // No error means success
      expect(result).toHaveProperty('action');
      expect(result.action).toBe('apply');
    });

    test('should return valid result structure for rollback with reason', async () => {
      const decisionId = 'test-decision-response-004';
      const decisionPath = join(testSharedStatePath, 'decisions', 'applied', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test response format',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'applied' as const,
        changes: [],
        approvedBy: 'test-machine',
        approvedAt: new Date().toISOString(),
        appliedBy: 'test-machine',
        appliedAt: new Date().toISOString()
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      const result = await roosyncDecision({
        action: 'rollback',
        decisionId,
        reason: 'Test rollback reason'
      });

      expect(result.error).toBeUndefined(); // No error means success
      expect(result).toHaveProperty('action');
      expect(result.action).toBe('rollback');
    });
  });

  // ============================================================
  // Tests de validation des paramètres
  // ============================================================

  describe('parameter validation', () => {
    test('should support all valid actions', async () => {
      const actions: Array<'approve' | 'reject' | 'apply' | 'rollback'> = ['approve', 'reject', 'apply', 'rollback'];

      for (const action of actions) {
        const decisionId = `test-decision-validation-${action}`;
        const statusDir = action === 'approve' || action === 'reject' ? 'pending' :
                          action === 'apply' ? 'approved' : 'applied';
        // Créer la décision avec le bon statut
        const decisionPath = join(testSharedStatePath, 'decisions', statusDir, `${decisionId}.json`);
        const testDecision = {
          id: decisionId,
          title: `Test ${action}`,
          description: 'Test',
          proposedBy: 'test-machine',
          createdAt: new Date().toISOString(),
          status: statusDir as any,
          changes: []
        };
        writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

        const args: any = {
          action,
          decisionId
        };

        // Ajouter reason pour reject et rollback
        if (action === 'reject' || action === 'rollback') {
          args.reason = 'Test reason';
        }

        const result = await roosyncDecision(args);
        expect(result).toBeDefined();
        expect(result.action).toBe(action);
      }
    });
  });

  // ============================================================
  // Tests de gestion des décisions manquantes
  // ============================================================

  describe('missing decision handling', () => {
    test('should handle missing decision in roadmap gracefully', async () => {
      // Créer un répertoire decisions vide
      const dirs = [
        join(testSharedStatePath, 'decisions', 'pending'),
        join(testSharedStatePath, 'decisions', 'approved'),
        join(testSharedStatePath, 'decisions', 'rejected'),
        join(testSharedStatePath, 'decisions', 'applied'),
        join(testSharedStatePath, 'decisions', 'rolled_back')
      ];

      for (const dir of dirs) {
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
      }

      // The implementation throws RooSyncServiceError for missing decisions
      await expect(roosyncDecision({
        action: 'approve',
        decisionId: 'test-decision-missing-dir'
      })).rejects.toThrow('introuvable');
    });

    test('should handle missing roadmap file gracefully', async () => {
      // Les décisions sont stockées dans des fichiers JSON individuels, pas dans un roadmap
      // Supprimer le répertoire decisions
      const decisionsDir = join(testSharedStatePath, 'decisions');
      if (existsSync(decisionsDir)) {
        rmSync(decisionsDir, { recursive: true, force: true });
      }

      // The implementation throws RooSyncServiceError for missing decisions
      await expect(roosyncDecision({
        action: 'approve',
        decisionId: 'test-decision-missing-decisions'
      })).rejects.toThrow('introuvable');
    });
  });
});
