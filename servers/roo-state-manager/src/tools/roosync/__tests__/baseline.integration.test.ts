/**
 * Tests d'intégration pour roosync_baseline
 *
 * NOTE LIMITATION: Cet outil accède à RooSync (GDrive) et au système de fichiers.
 * Ces tests vérifient que l'outil ne plante pas et retourne une structure valide.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte RooSync + Git)
 *
 * @module tools/roosync/baseline.integration.test
 * @version 1.0.0 (#564 Phase 3)
 * @bugfix #636 - Use temp directory instead of real RooSync to prevent file pollution
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

// Fix #634: Integration tests need REAL RooSyncService and ConfigService
// Unmock before importing to get real implementation with getBaselineServiceConfig()
vi.unmock('../../../services/RooSyncService.js');
vi.unmock('../../../services/ConfigService.js');

// Fix #636 timeout: Use static imports instead of dynamic imports
import {
  roosync_baseline,
  RooSyncServiceError,
  BaselineArgsSchema,
  BaselineResultSchema
} from '../baseline.js';

describe('roosync_baseline (integration)', () => {
  let tempRooSyncDir: string;
  let originalRooSyncPath: string | undefined;
  let tempSharedStateDir: string;
  let originalSharedStatePath: string | undefined;

  beforeAll(async () => {
    // #636: Create temp directory to avoid polluting real RooSync
    tempRooSyncDir = await mkdtemp(join(process.env.TEMP || '/tmp', 'roosync-test-'));
    originalRooSyncPath = process.env.ROOSYNC_SHARED_PATH;
    process.env.ROOSYNC_SHARED_PATH = tempRooSyncDir;

    // Create SHARED_STATE_PATH temp directory (BaselineService prioritizes this)
    tempSharedStateDir = await mkdtemp(join(process.env.TEMP || '/tmp', 'shared-state-test-'));
    originalSharedStatePath = process.env.SHARED_STATE_PATH;
    process.env.SHARED_STATE_PATH = tempSharedStateDir;

    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  }, 30000); // 30s timeout for module import (Issue #609)

  afterAll(async () => {
    // Restore original ROOSYNC_SHARED_PATH
    if (originalRooSyncPath) {
      process.env.ROOSYNC_SHARED_PATH = originalRooSyncPath;
    } else {
      delete process.env.ROOSYNC_SHARED_PATH;
    }

    // Restore original SHARED_STATE_PATH
    if (originalSharedStatePath) {
      process.env.SHARED_STATE_PATH = originalSharedStatePath;
    } else {
      delete process.env.SHARED_STATE_PATH;
    }

    // Clean up RooSync temp directory
    if (tempRooSyncDir && existsSync(tempRooSyncDir)) {
      try {
        await rm(tempRooSyncDir, { recursive: true, force: true });
      } catch (cleanupError) {
        // Log but don't fail test if cleanup fails
        console.warn(`[TEST WARNING] Could not clean up temp directory: ${tempRooSyncDir}`, cleanupError);
      }
    }

    // Clean up SHARED_STATE_PATH temp directory
    if (tempSharedStateDir && existsSync(tempSharedStateDir)) {
      try {
        await rm(tempSharedStateDir, { recursive: true, force: true });
      } catch (cleanupError) {
        // Log but don't fail test if cleanup fails
        console.warn(`[TEST WARNING] Could not clean up temp directory: ${tempSharedStateDir}`, cleanupError);
      }
    }
  });

  // ============================================================
  // Tests de validation des entrées
  // ============================================================

  describe('input validation', () => {
    test('should require action parameter', async () => {
      // L'outil doit lancer une RooSyncServiceError si l'action est manquante
      await expect(async () => {
        await roosync_baseline({} as any);
      }).rejects.toThrow(RooSyncServiceError);
    });

    test('should reject invalid action', async () => {
      // L'outil doit lancer une RooSyncServiceError pour une action invalide
      await expect(async () => {
        await roosync_baseline({ action: 'invalid' as any });
      }).rejects.toThrow(RooSyncServiceError);
    });

    test('should require machineId for update action', async () => {
      // L'outil doit lancer une RooSyncServiceError si machineId est manquant pour update
      await expect(async () => {
        await roosync_baseline({ action: 'update' });
      }).rejects.toThrow(RooSyncServiceError);
    });

    test('should require source for restore action', async () => {
      // L'outil doit lancer une RooSyncServiceError si source est manquant pour restore
      await expect(async () => {
        await roosync_baseline({ action: 'restore' });
      }).rejects.toThrow(RooSyncServiceError);
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should have BaselineArgsSchema with proper structure', async () => {
      // Vérifier que le schema a la bonne structure : action requise,
      // paramètres d'entrée optionnels (baseline.ts l.57-118)
      const shape = BaselineArgsSchema.shape;
      expect(shape.action.isOptional()).toBe(false);
      expect(shape.machineId.isOptional()).toBe(true);
      expect(shape.version.isOptional()).toBe(true);
      expect(shape.format.isOptional()).toBe(true);
    });

    test('should have BaselineResultSchema with proper structure', async () => {
      // Champs requis du contrat de retour (baseline.ts l.125-131)
      const shape = BaselineResultSchema.shape;
      expect(shape.action.isOptional()).toBe(false);
      expect(shape.success.isOptional()).toBe(false);
      expect(shape.version.isOptional()).toBe(false);
      expect(shape.message.isOptional()).toBe(false);
      expect(shape.timestamp.isOptional()).toBe(false);
      expect(shape.machineId.isOptional()).toBe(false);
    });

    test('should include action enum with correct values', async () => {
      // Enum action réel du handler (baseline.ts l.58) — le commentaire
      // historique « update, version, restore, export » était périmé :
      // list_versions et current_version existent aussi.
      const shape = BaselineArgsSchema.shape;
      expect(shape.action.options).toEqual([
        'update', 'version', 'restore', 'export', 'list_versions', 'current_version'
      ]);
    });

    test('should include format enum for export action', async () => {
      // Enum format réel du handler (baseline.ts l.108) — champ optionnel :
      // z.enum().optional() enveloppe le ZodEnum, les options vivent sous .unwrap()
      const shape = BaselineArgsSchema.shape;
      expect(shape.format.isOptional()).toBe(true);
      expect(shape.format.unwrap().options).toEqual(['json', 'yaml', 'csv']);
    });
  });

  // ============================================================
  // Tests de gestion des actions
  // ============================================================

  describe('action handling', () => {
    test('should handle version action - requires version parameter', async () => {
      // L'action version requiert le paramètre version
      await expect(async () => {
        await roosync_baseline({ action: 'version' });
      }).rejects.toThrow(RooSyncServiceError);
    });

    test('should handle export action with JSON format - creates default baseline if needed', async () => {
      // L'export crée une baseline par défaut si aucune n'existe
      // Note: BaselineService.loadBaseline() crée automatiquement une baseline par défaut
      const result = await roosync_baseline({
        action: 'export',
        format: 'json'
      });

      // Contrat de retour de l'export (BaselineResultSchema l.148-153)
      expect(result.success).toBe(true);
      expect(result.action).toBe('export');
      expect(result.format).toBe('json');
      expect(result.version).toEqual(expect.any(String));
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(result.machineId).toEqual(expect.any(String));
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle non-existent machineId gracefully', async () => {
      // L'outil doit lancer une RooSyncServiceError pour une machine inexistante
      await expect(async () => {
        await roosync_baseline({
          action: 'update',
          machineId: 'non-existent-machine-xyz-123'
        });
      }).rejects.toThrow(RooSyncServiceError);
    });

    test('should handle invalid restore source gracefully', async () => {
      // L'outil doit lancer une RooSyncServiceError pour une source invalide
      await expect(async () => {
        await roosync_baseline({
          action: 'restore',
          source: '/nonexistent/path/backup.tar.gz'
        });
      }).rejects.toThrow(RooSyncServiceError);
    });
  });

  // ============================================================
  // NOTE: Tests complets de roosync_baseline
  // ============================================================
  /*
   * Les tests suivants nécessitent un environnement RooSync complet:
   *
   * - Update effectif d'une baseline avec machineId valide
   * - Création de tag Git et push vers le dépôt
   * - Restore depuis une sauvegarde ou un tag existant
   * - Export dans différents formats (JSON, YAML, CSV)
   * - Vérification de la persistance sur GDrive
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un environnement RooSync avec GDrive configuré
   * 2. Un dépôt Git avec accès en écriture
   * 3. Des baselines existantes à restaurer
   * 4. Un mécanisme pour nettoyer les tags/backups créés pendant les tests
   *
   * Pour les tests unitaires de la logique de baseline,
   * les fichiers baseline.test.ts et BaselineService.test.ts existent déjà.
   */
});
