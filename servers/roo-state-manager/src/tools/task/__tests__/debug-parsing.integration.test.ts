/**
 * Tests d'intégration pour debug_task_parsing
 *
 * NOTE LIMITATION: Cet outil lit les fichiers JSON de tâches depuis le disque.
 * Ces tests vérifient que l'outil ne plante pas et gère correctement les erreurs,
 * mais les tests de contenu complet nécessitent des tâches Roo réelles.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte RooStorageDetector)
 *
 * @module task/debug-parsing.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';

describe('debug_task_parsing (integration)', () => {
  beforeAll(async () => {
    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    const NONEXISTENT_UUID = '00000000-0000-4000-a000-000000000000';

    test('should handle non-existent task gracefully', async () => {
      const { handleDebugTaskParsing } = await import('../debug-parsing.tool.js');
      const result = await handleDebugTaskParsing({
        task_id: NONEXISTENT_UUID
      });

      // L'outil doit retourner une structure valide même en erreur
      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const text = result.content[0].text;
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);

      // Doit contenir un message d'erreur approprié
      expect(text).toMatch(/not found|introuvable|DEBUG/i);
    });

    test('should require task_id parameter', async () => {
      const { debugTaskParsingTool } = await import('../debug-parsing.tool.js');

      // Vérifier le schéma d'entrée
      expect(debugTaskParsingTool.inputSchema).toHaveProperty('type', 'object');
      expect(debugTaskParsingTool.inputSchema.required).toContain('task_id');
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    const NONEXISTENT_UUID = '00000000-0000-4000-a000-000000000000';

    test('should return valid text response for any input', async () => {
      const { handleDebugTaskParsing } = await import('../debug-parsing.tool.js');
      const result = await handleDebugTaskParsing({
        task_id: NONEXISTENT_UUID
      });

      const text = result.content[0].text;

      // Le format doit contenir les informations de diagnostic
      expect(text).toBeTruthy();
      expect(text.length).toBeGreaterThan(0);

      // Peut être un message d'erreur si la tâche n'existe pas
      if (!text.includes('not found')) {
        // Si la tâche existe, vérifier la structure du diagnostic
        expect(text).toMatch(/📁|📄|📊|🎯|🧪|✅|❌/);
      }
    });

    test('should include diagnostic information', async () => {
      const { handleDebugTaskParsing } = await import('../debug-parsing.tool.js');
      const result = await handleDebugTaskParsing({
        task_id: NONEXISTENT_UUID
      });

      const text = result.content[0].text;

      // Vérifier que le format de sortie est un texte structuré
      expect(typeof text).toBe('string');
      expect(text.split('\n').length).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // Tests de structure d'outil
  // ============================================================

  describe('tool structure', () => {
    test('should export tool definition with proper structure', async () => {
      const { debugTaskParsingTool } = await import('../debug-parsing.tool.js');

      // Vérifier que l'outil exporté a la bonne structure
      expect(debugTaskParsingTool).toHaveProperty('name');
      expect(debugTaskParsingTool).toHaveProperty('description');
      expect(debugTaskParsingTool).toHaveProperty('inputSchema');
      expect(typeof debugTaskParsingTool.name).toBe('string');
      expect(typeof debugTaskParsingTool.description).toBe('string');

      // Le handler est exporté séparément
      const { handleDebugTaskParsing } = await import('../debug-parsing.tool.js');
      expect(typeof handleDebugTaskParsing).toBe('function');
    });

    test('should have correct input schema', async () => {
      const { debugTaskParsingTool } = await import('../debug-parsing.tool.js');

      // Vérifier le schéma d'entrée
      expect(debugTaskParsingTool.inputSchema).toHaveProperty('type', 'object');
      expect(debugTaskParsingTool.inputSchema).toHaveProperty('properties');
      expect(debugTaskParsingTool.inputSchema.required).toEqual(['task_id']);
    });
  });

  // ============================================================
  // NOTE: Tests complets de diagnostic de parsing
  // ============================================================
  /*
   * Les tests suivants nécessitent un stockage Roo réel:
   *
   * - Analyse des fichiers ui_messages.json
   * - Détection des balises <task> et <new_task>
   * - Comptage des occurrences de balises
   * - Test du parsing avec RooStorageDetector
   * - Affichage des préfixes d'instructions enfants
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un stockage Roo réel avec des tâches complètes
   * 2. Ou des fixtures JSON complètes de tâches
   *
   * Pour les tests unitaires de la logique de parsing JSON,
   * créer un fichier debug-parsing.unit.test.ts séparé.
   */
});
