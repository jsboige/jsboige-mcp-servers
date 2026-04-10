/**
 * Tests d'intégration pour get_raw_conversation
 *
 * NOTE LIMITATION: RooStorageDetector utilise os.homedir() pour chercher
 * le stockage Roo, ce qui ne peut pas être mocké facilement dans les tests.
 * Ces tests vérifient que l'outil ne plante pas et gère correctement les erreurs.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte os.homedir())
 *
 * @module conversation/get-raw.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';

describe('get_raw_conversation (integration)', () => {
  beforeAll(async () => {
    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    // Valid UUID that does not exist — tests the "not found" path
    const NONEXISTENT_UUID = '00000000-0000-4000-a000-000000000000';

    test('should handle non-existent task gracefully', async () => {
      const { getRawConversationTool } = await import('../get-raw.tool.js');

      // L'outil doit lancer une erreur quand la tâche n'existe pas
      await expect(getRawConversationTool.handler({
        taskId: NONEXISTENT_UUID
      })).rejects.toThrow();
    });

    test('should require taskId parameter', async () => {
      const { getRawConversationTool } = await import('../get-raw.tool.js');

      // @ts-expect-error - Testing missing required parameter
      await expect(getRawConversationTool.handler({})).rejects.toThrow();
    });

    test('should provide meaningful error message for missing task', async () => {
      const { getRawConversationTool } = await import('../get-raw.tool.js');

      try {
        await getRawConversationTool.handler({
          taskId: NONEXISTENT_UUID
        });
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeDefined();
        const errorMessage = (error as Error).message;
        expect(errorMessage).toContain('not found');
        expect(errorMessage).toContain(NONEXISTENT_UUID);
      }
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('tool structure', () => {
    test('should export tool definition with proper structure', async () => {
      const { getRawConversationTool } = await import('../get-raw.tool.js');

      // Vérifier que l'outil exporté a la bonne structure
      expect(getRawConversationTool).toHaveProperty('definition');
      expect(getRawConversationTool).toHaveProperty('handler');
      expect(typeof getRawConversationTool.handler).toBe('function');
    });

    test('should have correct input schema', async () => {
      const { getRawConversationTool } = await import('../get-raw.tool.js');

      // Vérifier le schéma d'entrée
      expect(getRawConversationTool.definition.inputSchema).toHaveProperty('type', 'object');
      expect(getRawConversationTool.definition.inputSchema).toHaveProperty('properties');
      expect(getRawConversationTool.definition.inputSchema.required).toEqual(['taskId']);
    });

    test('should have taskId as required parameter', async () => {
      const { getRawConversationTool } = await import('../get-raw.tool.js');

      const taskIdProp = getRawConversationTool.definition.inputSchema.properties.taskId;
      expect(taskIdProp).toHaveProperty('type', 'string');
      expect(taskIdProp).toHaveProperty('description');
    });
  });

  // ============================================================
  // NOTE: Tests complets de récupération de conversations
  // ============================================================
  /*
   * Les tests suivants nécessitent un stockage Roo réel:
   *
   * - Lecture effective de api_conversation_history.json
   * - Lecture effective de ui_messages.json
   * - Parsing JSON avec gestion du BOM UTF-8
   * - Récupération des métadonnées de tâche
   * - Retour des données brutes complètes
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un stockage Roo réel dans os.homedir()
   * 2. Ou une refactorisation de l'outil pour accepter un path explicite
   *
   * Pour les tests unitaires de la logique de parsing JSON et BOM,
   * créer un fichier get-raw.unit.test.ts séparé.
   */
});
