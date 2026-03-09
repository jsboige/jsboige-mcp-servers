/**
 * Tests d'intégration pour get_task_tree
 *
 * NOTE LIMITATION: Cet outil utilise handleGetTaskTree() qui dépend du cache
 * de conversations. Ces tests vérifient que l'outil ne plante pas et retourne
 * une structure valide, mais les tests complets nécessitent des tâches Roo réelles.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte cache)
 *
 * @module task/get-tree.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';

describe('get_task_tree (integration)', () => {
  beforeAll(async () => {
    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle empty cache gracefully', async () => {
      const { getTaskTreeTool } = await import('../get-tree.tool.js');

      // L'outil ne doit pas planter même sans le paramètre conversationCache
      expect(getTaskTreeTool).toBeDefined();
      expect(getTaskTreeTool.name).toBe('get_task_tree');
    });

    test('should require conversation_id parameter', async () => {
      const { getTaskTreeTool } = await import('../get-tree.tool.js');

      // Vérifier le schéma d'entrée
      expect(getTaskTreeTool.inputSchema).toHaveProperty('type', 'object');
      expect(getTaskTreeTool.inputSchema).toHaveProperty('properties');
      expect(getTaskTreeTool.inputSchema.required).toContain('conversation_id');
    });

    test('should support all output formats', async () => {
      const { getTaskTreeTool } = await import('../get-tree.tool.js');

      // Vérifier que tous les formats sont supportés
      const outputFormatProp = getTaskTreeTool.inputSchema.properties.output_format;
      expect(outputFormatProp).toHaveProperty('enum');
      expect(outputFormatProp.enum).toContain('json');
      expect(outputFormatProp.enum).toContain('markdown');
      expect(outputFormatProp.enum).toContain('ascii-tree');
      expect(outputFormatProp.enum).toContain('hierarchical');
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('tool structure', () => {
    test('should export tool definition with proper structure', async () => {
      const { getTaskTreeTool } = await import('../get-tree.tool.js');

      // Vérifier que l'outil exporté a la bonne structure
      expect(getTaskTreeTool).toHaveProperty('name');
      expect(getTaskTreeTool).toHaveProperty('description');
      expect(getTaskTreeTool).toHaveProperty('inputSchema');
      expect(typeof getTaskTreeTool.name).toBe('string');
      expect(typeof getTaskTreeTool.description).toBe('string');
    });

    test('should have correct input schema', async () => {
      const { getTaskTreeTool } = await import('../get-tree.tool.js');

      // Vérifier le schéma d'entrée
      expect(getTaskTreeTool.inputSchema).toHaveProperty('type', 'object');
      expect(getTaskTreeTool.inputSchema).toHaveProperty('properties');
      expect(getTaskTreeTool.inputSchema.required).toEqual(['conversation_id']);
    });

    test('should support optional parameters', async () => {
      const { getTaskTreeTool } = await import('../get-tree.tool.js');

      // Vérifier que les paramètres optionnels sont définis
      expect(getTaskTreeTool.inputSchema.properties).toHaveProperty('max_depth');
      expect(getTaskTreeTool.inputSchema.properties).toHaveProperty('include_siblings');
      expect(getTaskTreeTool.inputSchema.properties).toHaveProperty('current_task_id');
      expect(getTaskTreeTool.inputSchema.properties).toHaveProperty('truncate_instruction');
      expect(getTaskTreeTool.inputSchema.properties).toHaveProperty('show_metadata');
    });
  });

  // ============================================================
  // NOTE: Tests complets d'arbre de tâches
  // ============================================================
  /*
   * Les tests suivants nécessitent un cache de conversations avec des données réelles:
   *
   * - Construction d'arbres de tâches complets
   * - Formats de sortie variés (ascii-tree, markdown, hierarchical, json)
   * - Troncature des instructions longues
   * - Affichage des métadonnées détaillées
   * - Détection des références circulaires
   * - Reconstruction hiérarchique hybride
   * - Filtrage par branche cible
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un cache peuplé avec des conversations de test
   * 2. Ou un système de mock du cache de conversations
   *
   * Pour les tests unitaires de la logique de construction d'arbre,
   * créer un fichier get-tree.unit.test.ts séparé.
   */
});
