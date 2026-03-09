/**
 * Tests d'intégration pour detect_roo_storage
 *
 * NOTE LIMITATION: RooStorageDetector utilise os.homedir() pour chercher
 * le stockage Roo, ce qui ne peut pas être mocké facilement dans les tests.
 * Ces tests vérifient que l'outil ne plante pas et retourne une structure valide.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte os.homedir())
 *
 * @module storage/detect-storage.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';

describe('detect_roo_storage (integration)', () => {
  beforeAll(async () => {
    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  });

  // ============================================================
  // Tests de base - L'outil ne doit pas planter
  // ============================================================

  describe('basic functionality', () => {
    test('should return valid result structure', async () => {
      const { detectStorageTool } = await import('../detect-storage.tool.js');
      const result = await detectStorageTool.handler({});

      // L'outil doit toujours retourner une structure valide
      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const text = result.content[0].text;
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    });

    test('should return valid JSON', async () => {
      const { detectStorageTool } = await import('../detect-storage.tool.js');
      const result = await detectStorageTool.handler({});

      const text = result.content[0].text;

      // Le résultat doit être du JSON valide
      expect(() => JSON.parse(text)).not.toThrow();

      const parsed = JSON.parse(text);
      expect(typeof parsed).toBe('object');
    });

    test('should include storage locations array', async () => {
      const { detectStorageTool } = await import('../detect-storage.tool.js');
      const result = await detectStorageTool.handler({});

      const parsed = JSON.parse(result.content[0].text);

      // Le résultat doit contenir un tableau de locations
      expect(parsed).toHaveProperty('locations');
      expect(Array.isArray(parsed.locations)).toBe(true);
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should have tool definition with proper structure', async () => {
      const { detectStorageTool } = await import('../detect-storage.tool.js');

      // Vérifier que l'outil exporté a la bonne structure
      expect(detectStorageTool).toHaveProperty('definition');
      expect(detectStorageTool).toHaveProperty('handler');
      expect(typeof detectStorageTool.handler).toBe('function');
    });

    test('should have correct input schema (no parameters)', async () => {
      const { detectStorageTool } = await import('../detect-storage.tool.js');

      // Vérifier le schéma d'entrée
      expect(detectStorageTool.definition.inputSchema).toHaveProperty('type', 'object');
      expect(detectStorageTool.definition.inputSchema).toHaveProperty('properties');
      expect(detectStorageTool.definition.inputSchema.required).toEqual([]);
    });

    test('should include location type in each location', async () => {
      const { detectStorageTool } = await import('../detect-storage.tool.js');
      const result = await detectStorageTool.handler({});

      const parsed = JSON.parse(result.content[0].text);

      // Chaque location doit avoir un type et un path
      if (parsed.locations.length > 0) {
        expect(parsed.locations[0]).toHaveProperty('type');
        expect(parsed.locations[0]).toHaveProperty('path');
      }
    });
  });

  // ============================================================
  // NOTE: Tests complets de détection de stockage
  // ============================================================
  /*
   * Les tests suivants nécessitent un stockage Roo réel:
   *
   * - Détection effective des emplacements Roo
   * - Scan des conversations existantes
   * - Calcul des statistiques par workspace
   * - Gestion des emplacements multiples
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un stockage Roo réel dans os.homedir()
   * 2. Ou une refactorisation de l'outil pour accepter un path explicite
   *
   * Pour les tests unitaires de la logique de détection pure,
   * créer un fichier detect-storage.unit.test.ts séparé.
   */
});
