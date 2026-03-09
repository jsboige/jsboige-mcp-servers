/**
 * Tests d'intégration pour debug_analyze_conversation
 *
 * NOTE LIMITATION: Cet outil utilise le cache de conversations. Ces tests vérifient
 * que l'outil ne plante pas et gère correctement les erreurs.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte cache)
 *
 * @module conversation/debug-analyze.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';

describe('debug_analyze_conversation (integration)', () => {
  beforeAll(async () => {
    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle non-existent task gracefully', async () => {
      const { debugAnalyzeTool } = await import('../debug-analyze.tool.js');
      const conversationCache = new Map();

      // L'outil doit lancer une erreur quand la tâche n'existe pas
      await expect(debugAnalyzeTool.handler({
        taskId: 'non-existent-task-id-12345'
      }, conversationCache)).rejects.toThrow();

      // Vérifier que l'erreur contient le message approprié
      try {
        await debugAnalyzeTool.handler({
          taskId: 'non-existent-task-id-12345'
        }, conversationCache);
      } catch (error: any) {
        expect(error.message).toContain('not found in cache');
      }
    });

    test('should require taskId parameter', async () => {
      const { debugAnalyzeTool } = await import('../debug-analyze.tool.js');

      // Vérifier le schéma d'entrée
      expect(debugAnalyzeTool.definition.inputSchema).toHaveProperty('type', 'object');
      expect(debugAnalyzeTool.definition.inputSchema).toHaveProperty('properties');
      expect(debugAnalyzeTool.definition.inputSchema.required).toContain('taskId');
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should export tool definition with proper structure', async () => {
      const { debugAnalyzeTool } = await import('../debug-analyze.tool.js');

      // Vérifier que l'outil exporté a la bonne structure
      expect(debugAnalyzeTool).toHaveProperty('definition');
      expect(debugAnalyzeTool).toHaveProperty('handler');
      expect(typeof debugAnalyzeTool.handler).toBe('function');
    });

    test('should have correct input schema', async () => {
      const { debugAnalyzeTool } = await import('../debug-analyze.tool.js');

      // Vérifier le schéma d'entrée
      expect(debugAnalyzeTool.definition.inputSchema).toHaveProperty('type', 'object');
      expect(debugAnalyzeTool.definition.inputSchema).toHaveProperty('properties');
      expect(debugAnalyzeTool.definition.inputSchema.required).toEqual(['taskId']);
    });

    test('should accept conversationCache parameter', async () => {
      const { debugAnalyzeTool } = await import('../debug-analyze.tool.js');
      const conversationCache = new Map();

      // Le handler doit accepter le cache comme deuxième paramètre
      expect(typeof debugAnalyzeTool.handler).toBe('function');

      // Test que le handler peut être appelé (erreur attendue si pas de tâche)
      await expect(debugAnalyzeTool.handler({
        taskId: 'test-task-id'
      }, conversationCache)).rejects.toThrow();
    });
  });

  // ============================================================
  // NOTE: Tests complets d'analyse de conversation
  // ============================================================
  /*
   * Les tests suivants nécessitent un cache de conversations avec des données réelles:
   *
   * - Analyse d'une conversation existante
   * - Retour des données JSON complètes du squelette
   * - Validation des métadonnées
   * - Vérification des champs du squelette
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un cache peuplé avec des conversations de test
   * 2. Ou un système de mock du cache de conversations
   *
   * Pour les tests unitaires de la logique d'analyse,
   * créer un fichier debug-analyze.unit.test.ts séparé.
   */
});
