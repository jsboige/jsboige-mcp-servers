/**
 * Tests d'intégration pour roosync_search
 *
 * NOTE LIMITATION: Cet outil est un dispatcher qui requiert des callbacks
 * (ensureCacheFreshCallback, fallbackHandler, diagnoseHandler). Ces tests
 * vérifient que l'outil ne plante pas et gère correctement les erreurs.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte callbacks)
 *
 * @module search/roosync-search.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect } from 'vitest';

describe('roosync_search (integration)', () => {
  // ============================================================
  // Tests de validation des entrées
  // ============================================================

  describe('input validation', () => {
    test('should require action parameter', async () => {
      const { handleRooSyncSearch } = await import('../roosync-search.tool.js');
      const conversationCache = new Map();

      // L'outil doit retourner une erreur si l'action est manquante
      const result = await handleRooSyncSearch(
        {} as any,
        conversationCache,
        async () => true,
        async () => ({ content: [{ type: 'text', text: 'fallback' }] })
      );

      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('action');
    });

    test('should reject invalid action', async () => {
      const { handleRooSyncSearch } = await import('../roosync-search.tool.js');
      const conversationCache = new Map();

      // L'outil doit retourner une erreur pour une action invalide
      const result = await handleRooSyncSearch(
        { action: 'invalid' as any },
        conversationCache,
        async () => true,
        async () => ({ content: [{ type: 'text', text: 'fallback' }] })
      );

      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('invalide');
    });

    test('should require search_query for semantic action', async () => {
      const { handleRooSyncSearch } = await import('../roosync-search.tool.js');
      const conversationCache = new Map();

      // L'outil doit retourner une erreur si search_query est manquant pour semantic
      const result = await handleRooSyncSearch(
        { action: 'semantic' as any },
        conversationCache,
        async () => true,
        async () => ({ content: [{ type: 'text', text: 'fallback' }] })
      );

      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('search_query');
      expect(result.content[0].text).toContain('semantic');
    });

    test('should require search_query for text action', async () => {
      const { handleRooSyncSearch } = await import('../roosync-search.tool.js');
      const conversationCache = new Map();

      // L'outil doit retourner une erreur si search_query est manquant pour text
      const result = await handleRooSyncSearch(
        { action: 'text' as any },
        conversationCache,
        async () => true,
        async () => ({ content: [{ type: 'text', text: 'fallback' }] })
      );

      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('search_query');
      expect(result.content[0].text).toContain('text');
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should have tool definition with proper structure', async () => {
      const { roosyncSearchTool } = await import('../roosync-search.tool.js');

      // Vérifier que l'outil exporté a la bonne structure
      expect(roosyncSearchTool).toHaveProperty('name', 'roosync_search');
      expect(roosyncSearchTool).toHaveProperty('description');
      expect(roosyncSearchTool).toHaveProperty('inputSchema');
    });

    test('should have correct input schema', async () => {
      const { roosyncSearchTool } = await import('../roosync-search.tool.js');

      // Vérifier le schéma d'entrée
      expect(roosyncSearchTool.inputSchema).toHaveProperty('type', 'object');
      expect(roosyncSearchTool.inputSchema).toHaveProperty('properties');
      expect(roosyncSearchTool.inputSchema.required).toEqual(['action']);
    });

    test('should include action property in schema', async () => {
      const { roosyncSearchTool } = await import('../roosync-search.tool.js');

      // Vérifier que la propriété action est définie
      expect(roosyncSearchTool.inputSchema.properties).toHaveProperty('action');
      expect(roosyncSearchTool.inputSchema.properties.action.type).toBe('string');
      expect(roosyncSearchTool.inputSchema.properties.action.enum).toEqual(['semantic', 'text', 'diagnose']);
    });

    test('should include search_query property in schema', async () => {
      const { roosyncSearchTool } = await import('../roosync-search.tool.js');

      // Vérifier que la propriété search_query est définie
      expect(roosyncSearchTool.inputSchema.properties).toHaveProperty('search_query');
      expect(roosyncSearchTool.inputSchema.properties.search_query.type).toBe('string');
    });

    test('should include conversation_id property in schema', async () => {
      const { roosyncSearchTool } = await import('../roosync-search.tool.js');

      // Vérifier que la propriété conversation_id est définie
      expect(roosyncSearchTool.inputSchema.properties).toHaveProperty('conversation_id');
      expect(roosyncSearchTool.inputSchema.properties.conversation_id.type).toBe('string');
    });

    test('should include max_results property in schema', async () => {
      const { roosyncSearchTool } = await import('../roosync-search.tool.js');

      // Vérifier que la propriété max_results est définie
      expect(roosyncSearchTool.inputSchema.properties).toHaveProperty('max_results');
      expect(roosyncSearchTool.inputSchema.properties.max_results.type).toBe('number');
    });

    test('should include workspace property in schema', async () => {
      const { roosyncSearchTool } = await import('../roosync-search.tool.js');

      // Vérifier que la propriété workspace est définie
      expect(roosyncSearchTool.inputSchema.properties).toHaveProperty('workspace');
      expect(roosyncSearchTool.inputSchema.properties.workspace.type).toBe('string');
    });
  });

  // ============================================================
  // NOTE: Tests complets de recherche
  // ============================================================
  /*
   * Les tests suivants nécessitent un cache de conversations avec des données réelles:
   *
   * - Recherche sémantique effective via Qdrant
   * - Recherche textuelle dans le cache
   * - Fallback automatique en cas d'échec Qdrant
   * - Diagnostic de l'index sémantique
   * - Filtrage par workspace et conversation_id
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un cache peuplé avec des conversations de test
   * 2. Un service Qdrant fonctionnel
   * 3. Ou des mocks des callbacks et services externes
   *
   * Pour les tests unitaires de la logique de dispatch,
   * créer un fichier roosync-search.unit.test.ts séparé.
   */
});
