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

// Fix #634: Integration tests need REAL RooSyncService, not the mock from jest.setup.js
// Unmock the service so we get the real singleton with actual filesystem operations
vi.unmock('../../../services/RooSyncService.js');
// Also unmock InventoryCollector - the jest.setup.js mock has wrong method names (collect vs collectInventory)
vi.unmock('../../../services/InventoryCollector.js');
// Also unmock BaselineService - jest.setup.js mock is missing loadBaseline method
vi.unmock('../../../services/BaselineService.js');
// Also unmock ConfigService - BaselineService depends on it and jest.setup.js mock is incomplete
vi.unmock('../../../services/ConfigService.js');

// Import après les mocks
import { roosyncDecision } from '../decision.js';
import { RooSyncService } from '../../../services/RooSyncService.js';

describe('roosync_decision (integration)', () => {
  // Fix #634: Save original env var to restore after tests
  const originalSharedPath = process.env.ROOSYNC_SHARED_PATH;
  const originalMachineId = process.env.ROOSYNC_MACHINE_ID;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    // Fix #634: Override env var BEFORE singleton recreation
    // loadRooSyncConfig() requires NODE_ENV='test' to use test mode (roosync-config.ts lines 54-98)
    process.env.NODE_ENV = 'test';
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';

    // Reset singleton so it gets recreated with the test path
    RooSyncService.resetInstance();

    // Setup : créer répertoire temporaire pour tests isolés
    const dirs = [
      testSharedStatePath,
      join(testSharedStatePath, 'decisions'),
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

    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
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
        description: 'Test description',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
        changes: [{ file: 'test.txt', action: 'create' as const }]
      };
      writeFileSync(decisionPath, JSON.stringify(testDecision, null, 2));

      const result = await roosyncDecision({
        action: 'approve',
        decisionId
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.action).toBe('approve');
      expect(result.decisionId).toBe(decisionId);
    });

    test('should approve decision with comment', async () => {
      const decisionId = 'test-decision-002';
      const decisionPath = join(testSharedStatePath, 'decisions', 'pending', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test decision with comment',
        description: 'Test description',
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
      expect(result.success).toBe(true);
      expect(result.action).toBe('approve');
    });

    test('should move decision from pending to approved', async () => {
      const decisionId = 'test-decision-003';
      const pendingPath = join(testSharedStatePath, 'decisions', 'pending', `${decisionId}.json`);
      const approvedPath = join(testSharedStatePath, 'decisions', 'approved', `${decisionId}.json`);

      const testDecision = {
        id: decisionId,
        title: 'Test decision move',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
        changes: []
      };
      writeFileSync(pendingPath, JSON.stringify(testDecision, null, 2));

      await roosyncDecision({
        action: 'approve',
        decisionId
      });

      // Vérifier que le fichier a été déplacé
      expect(existsSync(pendingPath)).toBe(false);
      expect(existsSync(approvedPath)).toBe(true);

      const updatedContent = readFileSync(approvedPath, 'utf-8');
      const updatedDecision = JSON.parse(updatedContent);
      expect(updatedDecision.status).toBe('approved');
    });
  });

  // ============================================================
  // Tests pour action: 'reject'
  // ============================================================

  describe('action: reject', () => {
    test('should require reason parameter for reject', async () => {
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

      // reason est requis pour reject
      await expect(roosyncDecision({
        action: 'reject',
        decisionId
        // reason manquant
      })).rejects.toThrow();
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
      expect(result.success).toBe(true);
      expect(result.action).toBe('reject');
    });

    test('should move decision from pending to rejected', async () => {
      const decisionId = 'test-decision-006';
      const pendingPath = join(testSharedStatePath, 'decisions', 'pending', `${decisionId}.json`);
      const rejectedPath = join(testSharedStatePath, 'decisions', 'rejected', `${decisionId}.json`);

      const testDecision = {
        id: decisionId,
        title: 'Test decision reject move',
        description: 'Test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
        changes: []
      };
      writeFileSync(pendingPath, JSON.stringify(testDecision, null, 2));

      await roosyncDecision({
        action: 'reject',
        decisionId,
        reason: 'Incomplete implementation'
      });

      // Vérifier que le fichier a été déplacé
      expect(existsSync(pendingPath)).toBe(false);
      expect(existsSync(rejectedPath)).toBe(true);

      const updatedContent = readFileSync(rejectedPath, 'utf-8');
      const updatedDecision = JSON.parse(updatedContent);
      expect(updatedDecision.status).toBe('rejected');
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
      expect(result.success).toBe(true);
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
      expect(result.success).toBe(true);
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
      expect(result.success).toBe(true);
    });

    test('should move decision from approved to applied', async () => {
      const decisionId = 'test-decision-010';
      const approvedPath = join(testSharedStatePath, 'decisions', 'approved', `${decisionId}.json`);
      const appliedPath = join(testSharedStatePath, 'decisions', 'applied', `${decisionId}.json`);

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
      writeFileSync(approvedPath, JSON.stringify(testDecision, null, 2));

      await roosyncDecision({
        action: 'apply',
        decisionId
      });

      // Vérifier que le fichier a été déplacé
      expect(existsSync(approvedPath)).toBe(false);
      expect(existsSync(appliedPath)).toBe(true);

      const updatedContent = readFileSync(appliedPath, 'utf-8');
      const updatedDecision = JSON.parse(updatedContent);
      expect(updatedDecision.status).toBe('applied');
    });
  });

  // ============================================================
  // Tests pour action: 'rollback'
  // ============================================================

  describe('action: rollback', () => {
    test('should require reason parameter for rollback', async () => {
      const decisionId = 'test-decision-011';
      const decisionPath = join(testSharedStatePath, 'decisions', 'applied', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test decision',
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

      // reason est requis pour rollback
      await expect(roosyncDecision({
        action: 'rollback',
        decisionId
        // reason manquant
      })).rejects.toThrow();
    });

    test('should rollback applied decision with reason', async () => {
      const decisionId = 'test-decision-012';
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
      expect(result.success).toBe(true);
      expect(result.action).toBe('rollback');
    });

    test('should move decision from applied to rolled_back', async () => {
      const decisionId = 'test-decision-013';
      const appliedPath = join(testSharedStatePath, 'decisions', 'applied', `${decisionId}.json`);
      const rolledBackPath = join(testSharedStatePath, 'decisions', 'rolled_back', `${decisionId}.json`);

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
      writeFileSync(appliedPath, JSON.stringify(testDecision, null, 2));

      await roosyncDecision({
        action: 'rollback',
        decisionId,
        reason: 'Breaking change detected'
      });

      // Vérifier que le fichier a été déplacé
      expect(existsSync(appliedPath)).toBe(false);
      expect(existsSync(rolledBackPath)).toBe(true);

      const updatedContent = readFileSync(rolledBackPath, 'utf-8');
      const updatedDecision = JSON.parse(updatedContent);
      expect(updatedDecision.status).toBe('rolled_back');
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle missing decision gracefully', async () => {
      const result = await roosyncDecision({
        action: 'approve',
        decisionId: 'non-existent-decision'
      });

      // L'outil doit gérer l'erreur gracieusement
      expect(result).toBeDefined();
    });

    test('should handle invalid status transition gracefully', async () => {
      const decisionId = 'test-decision-014';
      // Créer une décision déjà approuvée
      const decisionPath = join(testSharedStatePath, 'decisions', 'approved', `${decisionId}.json`);
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
      const result = await roosyncDecision({
        action: 'reject',
        decisionId,
        reason: 'Test invalid transition'
      });

      // L'outil doit gérer l'erreur gracieusement
      expect(result).toBeDefined();
    });

    test('should handle corrupted decision file gracefully', async () => {
      const decisionId = 'test-decision-corrupted';
      const decisionPath = join(testSharedStatePath, 'decisions', 'pending', `${decisionId}.json`);
      // Écrire un JSON invalide
      writeFileSync(decisionPath, '{ invalid json }');

      const result = await roosyncDecision({
        action: 'approve',
        decisionId
      });

      // L'outil doit gérer l'erreur gracieusement
      expect(result).toBeDefined();
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration scenarios', () => {
    test('should handle complete workflow: approve → apply → rollback', async () => {
      const decisionId = 'test-decision-workflow';

      // Step 1: Créer une décision en attente
      const pendingPath = join(testSharedStatePath, 'decisions', 'pending', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test workflow decision',
        description: 'Complete workflow test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
        changes: []
      };
      writeFileSync(pendingPath, JSON.stringify(testDecision, null, 2));

      // Step 2: Approuver
      const approveResult = await roosyncDecision({
        action: 'approve',
        decisionId,
        comment: 'Approved for testing'
      });
      expect(approveResult.success).toBe(true);

      // Step 3: Appliquer
      const applyResult = await roosyncDecision({
        action: 'apply',
        decisionId
      });
      expect(applyResult.success).toBe(true);

      // Step 4: Rollback
      const rollbackResult = await roosyncDecision({
        action: 'rollback',
        decisionId,
        reason: 'Testing rollback'
      });
      expect(rollbackResult.success).toBe(true);
    });

    test('should persist decision state across operations', async () => {
      const decisionId = 'test-decision-persist';

      // Créer et approuver
      const pendingPath = join(testSharedStatePath, 'decisions', 'pending', `${decisionId}.json`);
      const testDecision = {
        id: decisionId,
        title: 'Test persistence',
        description: 'State persistence test',
        proposedBy: 'test-machine',
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
        changes: []
      };
      writeFileSync(pendingPath, JSON.stringify(testDecision, null, 2));

      await roosyncDecision({
        action: 'approve',
        decisionId
      });

      // Vérifier que le statut a été mis à jour
      const approvedPath = join(testSharedStatePath, 'decisions', 'approved', `${decisionId}.json`);
      expect(existsSync(approvedPath)).toBe(true);

      const content = readFileSync(approvedPath, 'utf-8');
      const decision = JSON.parse(content);
      expect(decision.status).toBe('approved');
      expect(decision.approvedBy).toBe('test-machine');
      expect(decision.approvedAt).toBeDefined();
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
      expect(result.success).toBe(true);
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

      expect(result).toHaveProperty('success');
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

      expect(result).toHaveProperty('success');
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

      expect(result).toHaveProperty('success');
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

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('action');
      expect(result.action).toBe('rollback');
    });
  });

  // ============================================================
  // Tests de validation des paramètres
  // ============================================================

  describe('parameter validation', () => {
    test('should require action parameter', async () => {
      // @ts-expect-error - Testing missing required parameter
      const result = await roosyncDecision({
        // action manquant
        decisionId: 'test-decision'
      });

      // L'outil doit gérer le paramètre manquant
      expect(result).toBeDefined();
    });

    test('should support all valid actions', async () => {
      const actions: Array<'approve' | 'reject' | 'apply' | 'rollback'> = ['approve', 'reject', 'apply', 'rollback'];

      for (const action of actions) {
        const decisionId = `test-decision-validation-${action}`;
        const statusDir = action === 'approve' || action === 'reject' ? 'pending' :
                          action === 'apply' ? 'approved' : 'applied';
        const decisionPath = join(testSharedStatePath, 'decisions', statusDir, `${decisionId}.json`);

        const testDecision = {
          id: decisionId,
          title: `Test ${action}`,
          description: 'Test',
          proposedBy: 'test-machine',
          createdAt: new Date().toISOString(),
          status: statusDir as 'pending' | 'approved' | 'applied',
          changes: [],
          ...(statusDir === 'approved' || statusDir === 'applied' ? {
            approvedBy: 'test-machine',
            approvedAt: new Date().toISOString()
          } : {}),
          ...(statusDir === 'applied' ? {
            appliedBy: 'test-machine',
            appliedAt: new Date().toISOString()
          } : {})
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
    test('should handle missing pending directory gracefully', async () => {
      // Supprimer le répertoire pending
      rmSync(join(testSharedStatePath, 'decisions', 'pending'), { recursive: true, force: true });

      const result = await roosyncDecision({
        action: 'approve',
        decisionId: 'test-decision-missing-dir'
      });

      // Should still work with graceful error handling
      expect(result).toBeDefined();
    });

    test('should handle missing decisions directory gracefully', async () => {
      // Supprimer le répertoire decisions
      rmSync(join(testSharedStatePath, 'decisions'), { recursive: true, force: true });

      const result = await roosyncDecision({
        action: 'approve',
        decisionId: 'test-decision-missing-decisions'
      });

      // Should still work with graceful error handling
      expect(result).toBeDefined();
    });
  });
});
