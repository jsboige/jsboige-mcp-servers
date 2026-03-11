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
// and is missing clearCache method needed by clearCache() in RooSyncService
vi.unmock('../../../services/InventoryCollector.js');
// Also unmock BaselineService - jest.setup.js mock is missing loadBaseline method
vi.unmock('../../../services/BaselineService.js');
// Also unmock ConfigService - BaselineService depends on it and jest.setup.js mock is incomplete
vi.unmock('../../../services/ConfigService.js');

// Import après les mocks
import { roosyncDecision } from '../decision.js';
import { RooSyncService } from '../../../services/RooSyncService.js';

describe('roosync_decision (integration)', () => {
  // Fix #634: Save original env vars to restore after tests
  const originalSharedPath = process.env.ROOSYNC_SHARED_PATH;
  const originalMachineId = process.env.ROOSYNC_MACHINE_ID;

  // Helper function to create a decision block in sync-roadmap.md format
  function createDecisionBlock(
    id: string,
    title: string,
    status: 'pending' | 'approved' | 'rejected' | 'applied' | 'rolled_back',
    type: string = 'config'
  ): string {
    const now = new Date().toISOString();
    return `<!-- DECISION_BLOCK_START -->
**ID:** \`${id}\`
**Titre:** ${title}
**Statut:** ${status}
**Type:** ${type}
**Machine Source:** test-machine
**Machines Cibles:** test-machine
**Créé:** ${now}
<!-- DECISION_BLOCK_END -->`;
  }

  // Helper to write sync-roadmap.md with decisions
  function writeRoadmap(decisionBlocks: string[]): void {
    const header = `# RooSync Roadmap - Test
version: 2.0.0
machines: []
lastSync: null
decisions: []
`;
    const content = header + decisionBlocks.join('\n\n');
    writeFileSync(join(testSharedStatePath, 'sync-roadmap.md'), content, 'utf-8');
  }

  beforeEach(async () => {
    // Fix #634: Override env var BEFORE singleton recreation.
    // Without this, loadRooSyncConfig() reads the system env var (GDrive path)
    // and RooSyncService writes ghost files to production GDrive.
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';

    // Setup : créer répertoire temporaire pour tests isolés
    // IMPORTANT: Create directories BEFORE resetInstance(), because
    // loadRooSyncConfig() validates that ROOSYNC_SHARED_PATH exists.
    const dirs = [
      testSharedStatePath,
      join(testSharedStatePath, 'roo-config'),
      join(testSharedStatePath, 'logs')
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
      writeRoadmap([createDecisionBlock(decisionId, 'Test decision', 'pending')]);

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
      writeRoadmap([createDecisionBlock(decisionId, 'Test decision with comment', 'pending')]);

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
      writeRoadmap([createDecisionBlock(decisionId, 'Test decision move', 'pending')]);

      await roosyncDecision({
        action: 'approve',
        decisionId
      });

      // Vérifier que le statut a été mis à jour dans le roadmap
      const roadmapPath = join(testSharedStatePath, 'sync-roadmap.md');
      const roadmapContent = readFileSync(roadmapPath, 'utf-8');
      expect(roadmapContent).toContain('**Statut:** approved');
    });
  });

  // ============================================================
  // Tests pour action: 'reject'
  // ============================================================

  describe('action: reject', () => {
    test('should require reason parameter for reject', async () => {
      const decisionId = 'test-decision-004';
      writeRoadmap([createDecisionBlock(decisionId, 'Test decision', 'pending')]);

      // reason est requis pour reject
      await expect(roosyncDecision({
        action: 'reject',
        decisionId
        // reason manquant
      })).rejects.toThrow();
    });

    test('should reject decision with reason', async () => {
      const decisionId = 'test-decision-005';
      writeRoadmap([createDecisionBlock(decisionId, 'Test decision reject', 'pending')]);

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
      writeRoadmap([createDecisionBlock(decisionId, 'Test decision reject move', 'pending')]);

      await roosyncDecision({
        action: 'reject',
        decisionId,
        reason: 'Incomplete implementation'
      });

      // Vérifier que le statut a été mis à jour dans le roadmap
      const roadmapPath = join(testSharedStatePath, 'sync-roadmap.md');
      const roadmapContent = readFileSync(roadmapPath, 'utf-8');
      expect(roadmapContent).toContain('**Statut:** rejected');
    });
  });

  // ============================================================
  // Tests pour action: 'apply'
  // ============================================================

  describe('action: apply', () => {
    test('should apply approved decision', async () => {
      const decisionId = 'test-decision-007';
      writeRoadmap([createDecisionBlock(decisionId, 'Test decision apply', 'approved')]);

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
      writeRoadmap([createDecisionBlock(decisionId, 'Test decision dryrun', 'approved')]);

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
      writeRoadmap([createDecisionBlock(decisionId, 'Test decision force', 'approved')]);

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
      writeRoadmap([createDecisionBlock(decisionId, 'Test decision apply move', 'approved')]);

      await roosyncDecision({
        action: 'apply',
        decisionId
      });

      // Vérifier que le statut a été mis à jour dans le roadmap
      const roadmapPath = join(testSharedStatePath, 'sync-roadmap.md');
      const roadmapContent = readFileSync(roadmapPath, 'utf-8');
      expect(roadmapContent).toContain('**Statut:** applied');
    });
  });

  // ============================================================
  // Tests pour action: 'rollback'
  // ============================================================

  describe('action: rollback', () => {
    test('should require reason parameter for rollback', async () => {
      const decisionId = 'test-decision-011';
      writeRoadmap([createDecisionBlock(decisionId, 'Test decision', 'applied')]);

      // reason est requis pour rollback
      await expect(roosyncDecision({
        action: 'rollback',
        decisionId
        // reason manquant
      })).rejects.toThrow();
    });

    test('should rollback applied decision with reason', async () => {
      const decisionId = 'test-decision-012';
      writeRoadmap([createDecisionBlock(decisionId, 'Test decision rollback', 'applied')]);

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
      writeRoadmap([createDecisionBlock(decisionId, 'Test decision rollback move', 'applied')]);

      await roosyncDecision({
        action: 'rollback',
        decisionId,
        reason: 'Breaking change detected'
      });

      // Vérifier que le statut a été mis à jour dans le roadmap
      const roadmapPath = join(testSharedStatePath, 'sync-roadmap.md');
      const roadmapContent = readFileSync(roadmapPath, 'utf-8');
      expect(roadmapContent).toContain('**Statut:** rolled_back');
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
      writeRoadmap([createDecisionBlock(decisionId, 'Test decision', 'approved')]);

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
      // Écrire un fichier roadmap avec un bloc corrompu (malformed markdown)
      const roadmapPath = join(testSharedStatePath, 'sync-roadmap.md');
      writeFileSync(roadmapPath, `# RooSync Roadmap - Test
version: 2.0.0
<!-- DECISION_BLOCK_START -->
**ID:** \`${decisionId}\`
INVALID BLOCK FORMAT
<!-- DECISION_BLOCK_END -->`, 'utf-8');

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
      writeRoadmap([createDecisionBlock(decisionId, 'Test workflow decision', 'pending')]);

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

      // Créer une décision en attente
      writeRoadmap([createDecisionBlock(decisionId, 'Test persistence', 'pending')]);

      await roosyncDecision({
        action: 'approve',
        decisionId
      });

      // Vérifier que le statut a été mis à jour dans le roadmap
      const roadmapPath = join(testSharedStatePath, 'sync-roadmap.md');
      const roadmapContent = readFileSync(roadmapPath, 'utf-8');
      expect(roadmapContent).toContain('**Statut:** approved');
      expect(roadmapContent).toContain('**Approuvé par:** test-machine');
      expect(roadmapContent).toContain('**Approuvé le:**');
    });

    test('should handle all parameters combined', async () => {
      const decisionId = 'test-decision-combined';
      writeRoadmap([createDecisionBlock(decisionId, 'Test combined parameters', 'approved')]);

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
      writeRoadmap([createDecisionBlock(decisionId, 'Test response format', 'pending')]);

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
      writeRoadmap([createDecisionBlock(decisionId, 'Test response format', 'pending')]);

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
      writeRoadmap([createDecisionBlock(decisionId, 'Test response format', 'approved')]);

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
      writeRoadmap([createDecisionBlock(decisionId, 'Test response format', 'applied')]);

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
      await expect(roosyncDecision({
        // action manquant
        decisionId: 'test-decision'
      })).rejects.toThrow();
    });

    test('should support all valid actions', async () => {
      const actions: Array<'approve' | 'reject' | 'apply' | 'rollback'> = ['approve', 'reject', 'apply', 'rollback'];

      for (const action of actions) {
        const decisionId = `test-decision-validation-${action}`;
        const statusDir = action === 'approve' || action === 'reject' ? 'pending' :
                          action === 'apply' ? 'approved' : 'applied';
        // Créer la décision avec le bon statut
        writeRoadmap([createDecisionBlock(decisionId, `Test ${action}`, statusDir)]);

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
      // Créer un roadmap sans décisions
      writeRoadmap([]);

      const result = await roosyncDecision({
        action: 'approve',
        decisionId: 'test-decision-missing'
      });

      // Should still work with graceful error handling
      expect(result).toBeDefined();
    });

    test('should handle missing roadmap file gracefully', async () => {
      // Supprimer le fichier roadmap
      const roadmapPath = join(testSharedStatePath, 'sync-roadmap.md');
      if (existsSync(roadmapPath)) {
        rmSync(roadmapPath);
      }

      const result = await roosyncDecision({
        action: 'approve',
        decisionId: 'test-decision-missing-roadmap'
      });

      // Should still work with graceful error handling
      expect(result).toBeDefined();
    });
  });
});
