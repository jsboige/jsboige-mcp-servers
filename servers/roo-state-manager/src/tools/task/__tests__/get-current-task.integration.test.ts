/**
 * Tests d'intégration pour get_current_task
 *
 * NOTE LIMITATION: Cet outil utilise scanDiskForNewTasks() et RooStorageDetector
 * pour scanner le système de fichiers réel. Ces tests vérifient que l'outil ne plante pas
 * et gère correctement les cas d'erreur, mais les tests complets nécessitent un stockage
 * Roo réel avec des tâches.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte RooStorageDetector)
 *
 * @module task/get-current-task.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';
import { StateManagerError } from '../../../types/errors.js';

describe('get_current_task (integration)', () => {
  beforeAll(async () => {
    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle empty workspace gracefully', async () => {
      const { getCurrentTaskTool } = await import('../get-current-task.tool.js');
      const conversationCache = new Map();

      // L'outil doit lancer une erreur quand aucune tâche n'existe
      await expect(getCurrentTaskTool.handler({
        workspace: 'd:\\roo-extensions'
      }, conversationCache)).rejects.toThrow(StateManagerError);
    });

    test('should provide meaningful error message', async () => {
      const { getCurrentTaskTool } = await import('../get-current-task.tool.js');
      const conversationCache = new Map();

      try {
        await getCurrentTaskTool.handler({
          workspace: 'd:\\roo-extensions'
        }, conversationCache);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(StateManagerError);
        expect((error as StateManagerError).message).toContain('Aucune tâche trouvée');
      }
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('tool structure', () => {
    test('should export tool definition with proper structure', async () => {
      const { getCurrentTaskTool } = await import('../get-current-task.tool.js');

      // Vérifier que l'outil exporté a la bonne structure
      expect(getCurrentTaskTool).toHaveProperty('definition');
      expect(getCurrentTaskTool).toHaveProperty('handler');
      expect(typeof getCurrentTaskTool.handler).toBe('function');
    });

    test('should have correct input schema', async () => {
      const { getCurrentTaskTool } = await import('../get-current-task.tool.js');

      // Vérifier le schéma d'entrée
      expect(getCurrentTaskTool.definition.inputSchema).toHaveProperty('type', 'object');
      expect(getCurrentTaskTool.definition.inputSchema).toHaveProperty('properties');
    });
  });

  // ============================================================
  // Tests de cache (minimal)
  // ============================================================

  describe('cache handling', () => {
    test('should accept conversationCache parameter', async () => {
      const { getCurrentTaskTool } = await import('../get-current-task.tool.js');
      const conversationCache = new Map();

      // Le handler doit accepter le cache comme deuxième paramètre
      expect(typeof getCurrentTaskTool.handler).toBe('function');

      // Test que le handler peut être appelé (erreur attendue si pas de tâches)
      await expect(getCurrentTaskTool.handler({
        workspace: 'd:\\roo-extensions'
      }, conversationCache)).rejects.toThrow(StateManagerError);
    });
  });

  // ============================================================
  // NOTE: Tests complets de récupération de tâches
  // ============================================================
  /*
   * Les tests suivants nécessitent un stockage Roo réel:
   *
   * - Détection de tâches sur le disque
   * - Filtrage par workspace
   * - Tri par date de modification
   * - Récupération des métadonnées complètes
   * - Retour des informations de tâche quand trouvée
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un stockage Roo réel dans os.homedir()
   * 2. Ou une refactorisation de l'outil pour accepter un path explicite
   *
   * Pour les tests unitaires de la logique de tri/filtrage pure,
   * créer un fichier get-current-task.unit.test.ts séparé.
   */
});
