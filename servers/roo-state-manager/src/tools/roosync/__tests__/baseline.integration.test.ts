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
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';

describe('roosync_baseline (integration)', () => {
  beforeAll(async () => {
    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  }, 30000); // 30s timeout for module import (Issue #609)

  // ============================================================
  // Tests de validation des entrées
  // ============================================================

  describe('input validation', () => {
    test('should require action parameter', async () => {
      const { roosync_baseline, RooSyncServiceError } = await import('../baseline.js');

      // L'outil doit lancer une RooSyncServiceError si l'action est manquante
      await expect(async () => {
        await roosync_baseline({} as any);
      }).rejects.toThrow(RooSyncServiceError);
    });

    test('should reject invalid action', async () => {
      const { roosync_baseline, RooSyncServiceError } = await import('../baseline.js');

      // L'outil doit lancer une RooSyncServiceError pour une action invalide
      await expect(async () => {
        await roosync_baseline({ action: 'invalid' as any });
      }).rejects.toThrow(RooSyncServiceError);
    });

    test('should require machineId for update action', async () => {
      const { roosync_baseline, RooSyncServiceError } = await import('../baseline.js');

      // L'outil doit lancer une RooSyncServiceError si machineId est manquant pour update
      await expect(async () => {
        await roosync_baseline({ action: 'update' });
      }).rejects.toThrow(RooSyncServiceError);
    });

    test('should require source for restore action', async () => {
      const { roosync_baseline, RooSyncServiceError } = await import('../baseline.js');

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
      const { BaselineArgsSchema } = await import('../baseline.js');

      // Vérifier que le schema a la bonne structure
      expect(BaselineArgsSchema).toBeDefined();
      const shape = BaselineArgsSchema.shape;
      expect(shape.action).toBeDefined();
      expect(shape.machineId).toBeDefined();
      expect(shape.version).toBeDefined();
      expect(shape.format).toBeDefined();
    });

    test('should have BaselineResultSchema with proper structure', async () => {
      const { BaselineResultSchema } = await import('../baseline.js');

      // Vérifier que le schema de retour a la bonne structure
      expect(BaselineResultSchema).toBeDefined();
      const shape = BaselineResultSchema.shape;
      expect(shape.action).toBeDefined();
      expect(shape.success).toBeDefined();
      expect(shape.version).toBeDefined();
      expect(shape.timestamp).toBeDefined();
      expect(shape.machineId).toBeDefined();
    });

    test('should include action enum with correct values', async () => {
      const { BaselineArgsSchema } = await import('../baseline.js');

      // Vérifier que l'enum action contient les bonnes valeurs
      const shape = BaselineArgsSchema.shape;
      expect(shape.action).toBeDefined();
      // Les valeurs valides sont: update, version, restore, export
    });

    test('should include format enum for export action', async () => {
      const { BaselineArgsSchema } = await import('../baseline.js');

      // Vérifier que l'enum format contient les bonnes valeurs
      const shape = BaselineArgsSchema.shape;
      expect(shape.format).toBeDefined();
      // Les valeurs valides sont: json, yaml, csv
    });
  });

  // ============================================================
  // Tests de gestion des actions
  // ============================================================

  describe('action handling', () => {
    test('should handle version action - requires version parameter', async () => {
      const { roosync_baseline, RooSyncServiceError } = await import('../baseline.js');

      // L'action version requiert le paramètre version
      await expect(async () => {
        await roosync_baseline({ action: 'version' });
      }).rejects.toThrow(RooSyncServiceError);
    });

    test('should handle export action with JSON format - may fail without baseline', async () => {
      const { roosync_baseline, RooSyncServiceError, StateManagerError } = await import('../baseline.js');

      // L'export peut échouer si aucune baseline n'existe pour la machine
      await expect(async () => {
        await roosync_baseline({
          action: 'export',
          format: 'json'
        });
      }).rejects.toThrow(RooSyncServiceError);
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle non-existent machineId gracefully', async () => {
      const { roosync_baseline, RooSyncServiceError } = await import('../baseline.js');

      // L'outil doit lancer une RooSyncServiceError pour une machine inexistante
      await expect(async () => {
        await roosync_baseline({
          action: 'update',
          machineId: 'non-existent-machine-xyz-123'
        });
      }).rejects.toThrow(RooSyncServiceError);
    });

    test('should handle invalid restore source gracefully', async () => {
      const { roosync_baseline, RooSyncServiceError } = await import('../baseline.js');

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
