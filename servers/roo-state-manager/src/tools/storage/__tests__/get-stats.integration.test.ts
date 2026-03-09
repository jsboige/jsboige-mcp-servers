/**
 * Tests d'intégration pour get_storage_stats
 *
 * NOTE LIMITATION: RooStorageDetector utilise os.homedir() pour chercher
 * le stockage Roo, ce qui ne peut pas être mocké facilement dans les tests.
 * Ces tests vérifient que l'outil ne plante pas et retourne une structure valide.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte os.homedir())
 *
 * @module storage/get-stats.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';

describe('get_storage_stats (integration)', () => {
  beforeAll(async () => {
    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  });

  // ============================================================
  // Tests de base - L'outil ne doit pas planter
  // ============================================================

  describe('basic functionality', () => {
    test('should return valid result structure', async () => {
      const { getStorageStatsTool } = await import('../get-stats.tool.js');
      const result = await getStorageStatsTool.handler({});

      // L'outil doit toujours retourner une structure valide
      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const text = result.content[0].text;
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    });

    test('should return valid JSON', async () => {
      const { getStorageStatsTool } = await import('../get-stats.tool.js');
      const result = await getStorageStatsTool.handler({});

      const text = result.content[0].text;

      // Le résultat doit être du JSON valide
      expect(() => JSON.parse(text)).not.toThrow();

      const parsed = JSON.parse(text);
      expect(typeof parsed).toBe('object');
    });

    test('should include workspace breakdown', async () => {
      const { getStorageStatsTool } = await import('../get-stats.tool.js');
      const result = await getStorageStatsTool.handler({});

      const parsed = JSON.parse(result.content[0].text);

      // Le résultat doit contenir un breakdown par workspace
      expect(parsed).toHaveProperty('workspaceBreakdown');
      expect(typeof parsed.workspaceBreakdown).toBe('object');

      // Doit inclure le total de workspaces
      expect(parsed).toHaveProperty('totalWorkspaces');
      expect(typeof parsed.totalWorkspaces).toBe('number');
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should have tool definition with proper structure', async () => {
      const { getStorageStatsTool } = await import('../get-stats.tool.js');

      // Vérifier que l'outil exporté a la bonne structure
      expect(getStorageStatsTool).toHaveProperty('definition');
      expect(getStorageStatsTool).toHaveProperty('handler');
      expect(typeof getStorageStatsTool.handler).toBe('function');
    });

    test('should have correct input schema (no parameters)', async () => {
      const { getStorageStatsTool } = await import('../get-stats.tool.js');

      // Vérifier le schéma d'entrée
      expect(getStorageStatsTool.definition.inputSchema).toHaveProperty('type', 'object');
      expect(getStorageStatsTool.definition.inputSchema).toHaveProperty('properties');
      expect(getStorageStatsTool.definition.inputSchema.required).toEqual([]);
    });

    test('should include base statistics', async () => {
      const { getStorageStatsTool } = await import('../get-stats.tool.js');
      const result = await getStorageStatsTool.handler({});

      const parsed = JSON.parse(result.content[0].text);

      // Les statistiques de base doivent être présentes
      expect(parsed).toHaveProperty('totalConversations');
      expect(parsed).toHaveProperty('totalSize');

      // Les valeurs doivent être des nombres
      expect(typeof parsed.totalConversations).toBe('number');
      expect(typeof parsed.totalSize).toBe('number');
    });
  });

  // ============================================================
  // NOTE: Tests complets de statistiques
  // ============================================================
  /*
   * Les tests suivants nécessitent un stockage Roo réel:
   *
   * - Calcul précis du nombre de conversations
   * - Calcul de la taille totale des fichiers
   * - Breakdown détaillé par workspace
   * - Détection des workspaces vides ou manquants
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un stockage Roo réel dans os.homedir()
   * 2. Ou une refactorisation de l'outil pour accepter un path explicite
   *
   * Pour les tests unitaires de la logique de calcul de stats,
   * créer un fichier get-stats.unit.test.ts séparé.
   */
});
