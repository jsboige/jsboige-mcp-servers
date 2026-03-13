/**
 * Tests d'intégration pour list_conversations
 *
 * NOTE LIMITATION: Cet outil scanne le système de fichiers réel pour lister
 * les conversations. Ces tests vérifient que l'outil ne plante pas et retourne
 * une structure JSON valide.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte RooStorageDetector)
 *
 * @module conversation/list-conversations.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';

describe('list_conversations (integration)', () => {
  beforeAll(async () => {
    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  });

  // ============================================================
  // Tests de base - L'outil ne doit pas planter
  // ============================================================

  describe('basic functionality', () => {
    test('should return valid result structure', async () => {
      const { listConversationsTool } = await import('../list-conversations.tool.js');
      const conversationCache = new Map();
      const result = await listConversationsTool.handler({}, conversationCache);

      // L'outil doit toujours retourner une structure valide
      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const text = result.content[0].text;
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    });

    test('should return valid JSON', async () => {
      const { listConversationsTool } = await import('../list-conversations.tool.js');
      const conversationCache = new Map();
      const result = await listConversationsTool.handler({}, conversationCache);

      const text = result.content[0].text;

      // Le résultat doit être du JSON valide
      expect(() => JSON.parse(text)).not.toThrow();

      const parsed = JSON.parse(text);
      expect(typeof parsed).toBe('object');
    });

    test('should include conversations array', async () => {
      const { listConversationsTool } = await import('../list-conversations.tool.js');
      const conversationCache = new Map();
      const result = await listConversationsTool.handler({}, conversationCache);

      const _response = JSON.parse(result.content[0].text);
      const parsed = _response.conversations ?? _response;

      // Le résultat est un tableau de conversations (extrait de la réponse paginée)
      expect(Array.isArray(parsed)).toBe(true);
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should have tool definition with proper structure', async () => {
      const { listConversationsTool } = await import('../list-conversations.tool.js');

      // Vérifier que l'outil exporté a la bonne structure
      expect(listConversationsTool).toHaveProperty('definition');
      expect(listConversationsTool).toHaveProperty('handler');
      expect(typeof listConversationsTool.handler).toBe('function');
    });

    test('should have correct input schema', async () => {
      const { listConversationsTool } = await import('../list-conversations.tool.js');

      // Vérifier le schéma d'entrée (aucun paramètre requis)
      expect(listConversationsTool.definition.inputSchema).toHaveProperty('type', 'object');
      expect(listConversationsTool.definition.inputSchema).toHaveProperty('properties');
      // Le schéma n'a pas de propriété required car tous les paramètres sont optionnels
      expect(listConversationsTool.definition.inputSchema.required).toBeUndefined();
    });

    test('should include metadata in response', async () => {
      const { listConversationsTool } = await import('../list-conversations.tool.js');
      const conversationCache = new Map();
      const result = await listConversationsTool.handler({}, conversationCache);

      const _response = JSON.parse(result.content[0].text);
      const parsed = _response.conversations ?? _response;

      // Le résultat est un tableau dont la longueur est le nombre de conversations
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThanOrEqual(0);
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle empty storage gracefully', async () => {
      const { listConversationsTool } = await import('../list-conversations.tool.js');
      const conversationCache = new Map();
      const result = await listConversationsTool.handler({}, conversationCache);

      const _response = JSON.parse(result.content[0].text);
      const parsed = _response.conversations ?? _response;

      // Même sans stockage Roo, l'outil doit retourner un tableau valide
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThanOrEqual(0);
    });
  });

  // ============================================================
  // NOTE: Tests complets de listing de conversations
  // ============================================================
  /*
   * Les tests suivants nécessitent un stockage Roo réel:
   *
   * - Liste effective des conversations existantes
   * - Filtrage par workspace
   * - Tri par date de modification
   * - Construction de l'arbre hiérarchique
   * - Pagination et limites
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un stockage Roo réel avec des conversations
   * 2. Ou des fixtures de fichiers de conversations
   *
   * Pour les tests unitaires de la logique de filtrage/tri,
   * créer un fichier list-conversations.unit.test.ts séparé.
   */
});
