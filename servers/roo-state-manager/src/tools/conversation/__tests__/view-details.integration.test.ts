/**
 * Tests d'intégration pour view_task_details
 *
 * NOTE LIMITATION: Cet outil utilise le cache de conversations. Ces tests
 * vérifient que l'outil ne plante pas et gère correctement les erreurs.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte cache)
 *
 * @module conversation/view-details.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';

describe('view_task_details (integration)', () => {
  beforeAll(async () => {
    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle non-existent task gracefully', async () => {
      const { viewTaskDetailsTool } = await import('../view-details.tool.js');
      const conversationCache = new Map();

      // L'outil retourne un message d'erreur au lieu de lancer une exception
      const result = await viewTaskDetailsTool.handler({
        task_id: 'non-existent-task-id-12345'
      }, conversationCache);

      expect(result).toBeDefined();
      expect(result.content[0].text).toContain('Aucune tâche trouvée');
    });

    test('should require taskId parameter', async () => {
      const { viewTaskDetailsTool } = await import('../view-details.tool.js');

      // Vérifier le schéma d'entrée
      expect(viewTaskDetailsTool.definition.inputSchema).toHaveProperty('type', 'object');
      expect(viewTaskDetailsTool.definition.inputSchema).toHaveProperty('properties');
      expect(viewTaskDetailsTool.definition.inputSchema.required).toContain('task_id');
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should export tool definition with proper structure', async () => {
      const { viewTaskDetailsTool } = await import('../view-details.tool.js');

      // Vérifier que l'outil exporté a la bonne structure
      expect(viewTaskDetailsTool).toHaveProperty('definition');
      expect(viewTaskDetailsTool).toHaveProperty('handler');
      expect(typeof viewTaskDetailsTool.handler).toBe('function');
    });

    test('should have correct input schema', async () => {
      const { viewTaskDetailsTool } = await import('../view-details.tool.js');

      // Vérifier le schéma d'entrée
      expect(viewTaskDetailsTool.definition.inputSchema).toHaveProperty('type', 'object');
      expect(viewTaskDetailsTool.definition.inputSchema).toHaveProperty('properties');
      expect(viewTaskDetailsTool.definition.inputSchema.required).toEqual(['task_id']);
    });

    test('should accept action_index parameter', async () => {
      const { viewTaskDetailsTool } = await import('../view-details.tool.js');

      // Vérifier que action_index est un paramètre optionnel
      expect(viewTaskDetailsTool.definition.inputSchema.properties).toHaveProperty('action_index');
      expect(viewTaskDetailsTool.definition.inputSchema.properties.action_index.type).toBe('number');
    });

    test('should accept truncate parameter', async () => {
      const { viewTaskDetailsTool } = await import('../view-details.tool.js');

      // Vérifier que truncate est un paramètre optionnel
      expect(viewTaskDetailsTool.definition.inputSchema.properties).toHaveProperty('truncate');
      expect(viewTaskDetailsTool.definition.inputSchema.properties.truncate.type).toBe('number');
      expect(viewTaskDetailsTool.definition.inputSchema.properties.truncate.default).toBe(0);
    });
  });

  // ============================================================
  // Tests de cache (minimal)
  // ============================================================

  describe('cache handling', () => {
    test('should accept conversationCache parameter', async () => {
      const { viewTaskDetailsTool } = await import('../view-details.tool.js');
      const conversationCache = new Map();

      // Le handler doit accepter le cache comme deuxième paramètre
      expect(typeof viewTaskDetailsTool.handler).toBe('function');

      // Test que le handler peut être appelé (retourne un message d'erreur si pas de tâche)
      const result = await viewTaskDetailsTool.handler({
        task_id: 'test-task-id'
      }, conversationCache);

      expect(result).toBeDefined();
      expect(result.content[0].text).toContain('Aucune tâche trouvée');
    });
  });

  // ============================================================
  // NOTE: Tests complets d'affichage des détails
  // ============================================================
  /*
   * Les tests suivants nécessitent un cache de conversations avec des données réelles:
   *
   * - Affichage des métadonnées complètes d'une tâche
   * - Formatage des détails d'une action spécifique
   * - Troncation des contenus longs
   * - Gestion des différents types d'actions
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un cache peuplé avec des conversations de test
   * 2. Ou un système de mock du cache de conversations
   *
   * Pour les tests unitaires de la logique de formatage,
   * créer un fichier view-details.unit.test.ts séparé.
   */
});
