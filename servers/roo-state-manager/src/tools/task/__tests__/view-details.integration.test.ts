/**
 * Tests d'intégration pour view_task_details
 *
 * NOTE LIMITATION: Cet outil lit les fichiers JSON de tâches depuis le disque.
 * Ces tests vérifient que l'outil ne plante pas et gère correctement les erreurs,
 * mais les tests de contenu complet nécessitent des tâches Roo réelles.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte RooStorageDetector)
 *
 * @module task/view-details.integration.test
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
      const { viewTaskDetailsTool } = await import('../../conversation/view-details.tool.js');
      const result = await viewTaskDetailsTool.handler({
        task_id: 'non-existent-task-id-12345'
      });

      // L'outil doit retourner une structure valide même en erreur
      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);

      const text = result.content[0].text;
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);

      // Doit contenir un message d'erreur approprié
      expect(text).toMatch(/introuvable|not found|erreur|error/i);
    });

    test('should require task_id parameter', async () => {
      const { viewTaskDetailsTool } = await import('../../conversation/view-details.tool.js');

      // @ts-expect-error - Testing missing required parameter
      const result = await viewTaskDetailsTool.handler({});

      // L'outil doit gérer le paramètre manquant
      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should return valid text response for any input', async () => {
      const { viewTaskDetailsTool } = await import('../../conversation/view-details.tool.js');
      const result = await viewTaskDetailsTool.handler({
        task_id: 'test-task-id'
      });

      const text = result.content[0].text;

      // Le format doit contenir soit les détails techniques, soit un message d'erreur
      expect(text).toBeTruthy();
      expect(text.length).toBeGreaterThan(0);

      // Peut être un message d'erreur si la tâche n'existe pas
      if (!text.includes('❌ Erreur')) {
        expect(text).toContain('## Détails Techniques');
      }
    });

    test('should support truncate parameter', async () => {
      const { viewTaskDetailsTool } = await import('../../conversation/view-details.tool.js');

      // Test avec truncate
      const resultWithTruncate = await viewTaskDetailsTool.handler({
        task_id: 'test-task-id',
        truncate: 100
      });
      expect(resultWithTruncate.content[0].text).toBeTruthy();

      // Test sans truncate
      const resultWithoutTruncate = await viewTaskDetailsTool.handler({
        task_id: 'test-task-id'
      });
      expect(resultWithoutTruncate.content[0].text).toBeTruthy();
    });

    test('should support action_index parameter', async () => {
      const { viewTaskDetailsTool } = await import('../../conversation/view-details.tool.js');

      const result = await viewTaskDetailsTool.handler({
        task_id: 'test-task-id',
        action_index: 0
      });

      expect(result.content[0].text).toBeTruthy();
    });
  });

  // ============================================================
  // NOTE: Tests complets de visualisation
  // ============================================================
  /*
   * Les tests suivants nécessitent un stockage Roo réel:
   *
   * - Lecture de api_conversation_history.json
   * - Parsing des métadonnées d'actions
   * - Affichage des paramètres et résultats d'outils
   * - Troncature du contenu pour les grandes conversations
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un stockage Roo réel avec des tâches complètes
   * 2. Ou des fixtures JSON complètes de tâches
   *
   * Pour les tests unitaires de la logique de parsing JSON,
   * créer un fichier view-details.unit.test.ts séparé.
   */
});
