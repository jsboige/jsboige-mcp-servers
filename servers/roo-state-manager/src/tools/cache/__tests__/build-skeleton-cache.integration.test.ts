/**
 * Tests d'intégration pour build_skeleton_cache
 *
 * NOTE LIMITATION: Cet outil scanne le système de fichiers réel pour reconstruire
 * le cache de squelettes. Ces tests vérifient que l'outil ne plante pas et
 * retourne une structure valide.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte RooStorageDetector)
 *
 * @module cache/build-skeleton-cache.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';

describe('build_skeleton_cache (integration)', () => {
  beforeAll(async () => {
    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  });

  // ============================================================
  // Tests de format de définition (structure)
  // ============================================================

  describe('tool definition', () => {
    test('should have tool definition with proper structure', async () => {
      const { buildSkeletonCacheDefinition } = await import('../build-skeleton-cache.tool.js');

      // buildSkeletonCacheDefinition IS the definition (has name, description, inputSchema)
      expect(buildSkeletonCacheDefinition).toHaveProperty('name', 'build_skeleton_cache');
      expect(buildSkeletonCacheDefinition).toHaveProperty('description');
      expect(buildSkeletonCacheDefinition).toHaveProperty('inputSchema');
    });

    test('should have correct input schema (optional parameters)', async () => {
      const { buildSkeletonCacheDefinition } = await import('../build-skeleton-cache.tool.js');

      // Vérifier le schéma d'entrée directement sur l'objet définition
      expect(buildSkeletonCacheDefinition.inputSchema).toHaveProperty('type', 'object');
      expect(buildSkeletonCacheDefinition.inputSchema).toHaveProperty('properties');
      expect(buildSkeletonCacheDefinition.inputSchema.required).toEqual([]);

      // Vérifier les paramètres optionnels
      expect(buildSkeletonCacheDefinition.inputSchema.properties).toHaveProperty('force_rebuild');
      expect(buildSkeletonCacheDefinition.inputSchema.properties).toHaveProperty('workspace_filter');
      expect(buildSkeletonCacheDefinition.inputSchema.properties).toHaveProperty('task_ids');
    });

    test('should export handler function separately', async () => {
      const { handleBuildSkeletonCache } = await import('../build-skeleton-cache.tool.js');

      // Le handler est exporté séparément
      expect(typeof handleBuildSkeletonCache).toBe('function');
    });
  });

  // ============================================================
  // Tests de base - L'outil ne doit pas planter
  // ============================================================

  describe('basic functionality', () => {
    test('should return valid result structure', async () => {
      const { handleBuildSkeletonCache } = await import('../build-skeleton-cache.tool.js');
      const conversationCache = new Map();

      const result = await handleBuildSkeletonCache({}, conversationCache);

      // L'outil doit toujours retourner une structure valide
      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const text = result.content[0].text;
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    });

    test('should return valid markdown report', async () => {
      const { handleBuildSkeletonCache } = await import('../build-skeleton-cache.tool.js');
      const conversationCache = new Map();

      const result = await handleBuildSkeletonCache({}, conversationCache);

      const text = result.content[0].text;

      // Le résultat doit être du texte valide (peut être un message d'absence de stockage)
      expect(text).toBeTruthy();
      expect(text.length).toBeGreaterThan(0);
    });

    test('should support optional parameters', async () => {
      const { handleBuildSkeletonCache } = await import('../build-skeleton-cache.tool.js');
      const conversationCache = new Map();

      // Test avec force_rebuild
      const resultWithForce = await handleBuildSkeletonCache({
        force_rebuild: true
      }, conversationCache);
      expect(resultWithForce.content[0].text).toBeTruthy();

      // Test avec workspace_filter
      const resultWithFilter = await handleBuildSkeletonCache({
        workspace_filter: 'test-workspace'
      }, conversationCache);
      expect(resultWithFilter.content[0].text).toBeTruthy();

      // Test avec task_ids
      const resultWithIds = await handleBuildSkeletonCache({
        task_ids: ['task-1', 'task-2']
      }, conversationCache);
      expect(resultWithIds.content[0].text).toBeTruthy();
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle empty storage gracefully', async () => {
      const { handleBuildSkeletonCache } = await import('../build-skeleton-cache.tool.js');
      const conversationCache = new Map();

      const result = await handleBuildSkeletonCache({}, conversationCache);

      const text = result.content[0].text;

      // Même sans stockage Roo, l'outil doit retourner un rapport valide
      expect(text).toBeTruthy();
      expect(text.length).toBeGreaterThan(0);
    });

    test('should handle invalid task_ids gracefully', async () => {
      const { handleBuildSkeletonCache } = await import('../build-skeleton-cache.tool.js');
      const conversationCache = new Map();

      const result = await handleBuildSkeletonCache({
        task_ids: ['non-existent-task-1', 'non-existent-task-2']
      }, conversationCache);

      const text = result.content[0].text;

      // L'outil doit gérer les IDs invalides gracieusement
      expect(text).toBeTruthy();
    });
  });

  // ============================================================
  // NOTE: Tests complets de reconstruction de cache
  // ============================================================
  /*
   * Les tests suivants nécessitent un stockage Roo réel:
   *
   * - Scan effectif des tâches sur le disque
   * - Reconstruction complète du cache de squelettes
   * - Gestion des erreurs de lecture/écriture
   * - Retry automatique avec backoff exponentiel
   * - Filtrage par workspace
   * - Construction sélective par task_ids
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un stockage Roo réel avec des tâches
   * 2. Ou des fixtures de fichiers de tâches
   *
   * Pour les tests unitaires de la logique de reconstruction,
   * créer un fichier build-skeleton-cache.unit.test.ts séparé.
   */
});
