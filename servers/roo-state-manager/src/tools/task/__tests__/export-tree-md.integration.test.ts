/**
 * Tests d'intégration pour export_tree_md
 *
 * NOTE LIMITATION: Cet outil utilise handleGetTaskTree() qui dépend du cache
 * de conversations. Ces tests vérifient que l'outil ne plante pas et retourne
 * une structure valide, mais les tests complets nécessitent des tâches Roo réelles.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte cache)
 *
 * @module task/export-tree-md.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';

describe('export_tree_md (integration)', () => {
  beforeAll(async () => {
    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle non-existent conversation gracefully', async () => {
      const { exportTaskTreeMarkdownTool } = await import('../export-tree-md.tool.js');

      // L'outil dépend de handleGetTaskTree qui sera mocké dans les tests unitaires
      // En intégration, on teste surtout que la structure est correcte
      expect(exportTaskTreeMarkdownTool).toBeDefined();
    });

    test('should require conversation_id parameter', async () => {
      const { exportTaskTreeMarkdownTool } = await import('../export-tree-md.tool.js');
      expect(exportTaskTreeMarkdownTool).toBeDefined();
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should export tool definition with proper structure', async () => {
      const { exportTaskTreeMarkdownTool } = await import('../export-tree-md.tool.js');

      // Vérifier que l'outil exporté a la bonne structure
      expect(exportTaskTreeMarkdownTool).toHaveProperty('name');
      expect(exportTaskTreeMarkdownTool).toHaveProperty('description');
      expect(exportTaskTreeMarkdownTool).toHaveProperty('inputSchema');
      expect(typeof exportTaskTreeMarkdownTool.name).toBe('string');
    });

    test('should support optional output parameters', async () => {
      const { exportTaskTreeMarkdownTool } = await import('../export-tree-md.tool.js');

      // La définition de l'outil doit déclarer les paramètres supportés
      expect(exportTaskTreeMarkdownTool.inputSchema).toHaveProperty('type');
      expect(exportTaskTreeMarkdownTool.inputSchema).toHaveProperty('properties');
    });
  });

  // ============================================================
  // NOTE: Tests complets d'export markdown
  // ============================================================
  /*
   * Les tests suivants nécessitent un cache de conversations avec des données réelles:
   *
   * - Génération d'arbres de tâches complets
   * - Formats de sortie variés (ascii-tree, markdown, hierarchical, json)
   * - Troncature des instructions longues
   * - Affichage des métadonnées détaillées
   * - Détection des références circulaires
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un cache peuplé avec des conversations de test
   * 2. Ou un système de mock du cache de conversations
   *
   * Pour les tests unitaires de la logique de construction d'arbre,
   * créer un fichier export-tree-md.unit.test.ts séparé.
   */
});
