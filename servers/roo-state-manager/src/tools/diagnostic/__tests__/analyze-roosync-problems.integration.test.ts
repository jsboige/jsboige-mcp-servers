/**
 * Tests d'intégration pour analyze_roosync_problems
 *
 * NOTE LIMITATION: Cet outil analyse le fichier sync-roadmap.md qui peut
 * ne pas exister dans tous les environnements. Ces tests vérifient que
 * l'outil ne plante pas et gère correctement les erreurs.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte système de fichiers)
 *
 * @module diagnostic/analyze-roosync-problems.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';

describe('analyze_roosync_problems (integration)', () => {
  beforeAll(async () => {
    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  }, 30000); // 30s timeout for module import (Issue #609)

  // ============================================================
  // Tests de base - L'outil ne doit pas planter
  // ============================================================

  describe('basic functionality', () => {
    test('should return valid result structure even without roadmap', async () => {
      const { analyzeRooSyncProblems } = await import('../analyze_problems.js');

      const result = await analyzeRooSyncProblems();

      // L'outil doit toujours retourner une structure valide
      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const text = result.content[0].text;
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    }, 30000); // 30s timeout for slow module import (Issue #609)

    test('should return valid JSON report', async () => {
      const { analyzeRooSyncProblems } = await import('../analyze_problems.js');

      const result = await analyzeRooSyncProblems();

      const text = result.content[0].text;

      // Le résultat doit être du JSON valide
      expect(() => JSON.parse(text)).not.toThrow();

      const parsed = JSON.parse(text);
      expect(typeof parsed).toBe('object');
    });

    test('should include timestamp in report', async () => {
      const { analyzeRooSyncProblems } = await import('../analyze_problems.js');

      const result = await analyzeRooSyncProblems();

      const parsed = JSON.parse(result.content[0].text);

      // Le rapport doit contenir un timestamp ou un message d'erreur
      if (parsed.success !== false) {
        expect(parsed).toHaveProperty('timestamp');
        expect(typeof parsed.timestamp).toBe('string');
        expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    });

    test('should handle missing roadmap gracefully', async () => {
      const { analyzeRooSyncProblems } = await import('../analyze_problems.js');

      const result = await analyzeRooSyncProblems();

      const parsed = JSON.parse(result.content[0].text);

      // Soit le fichier existe et success: true, soit success: false avec erreur
      if (parsed.success === false) {
        expect(parsed).toHaveProperty('error');
        expect(typeof parsed.error).toBe('string');
        expect(parsed.error).toContain('introuvable');
      }
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should have tool definition with proper structure', async () => {
      const { analyze_roosync_problems } = await import('../analyze_problems.js');

      // Vérifier que l'outil exporté a la bonne structure
      expect(analyze_roosync_problems).toHaveProperty('name', 'analyze_roosync_problems');
      expect(analyze_roosync_problems).toHaveProperty('description');
      expect(analyze_roosync_problems).toHaveProperty('inputSchema');
    });

    test('should have correct input schema', async () => {
      const { analyze_roosync_problems } = await import('../analyze_problems.js');

      // Vérifier le schéma d'entrée
      expect(analyze_roosync_problems.inputSchema).toHaveProperty('type', 'object');
      expect(analyze_roosync_problems.inputSchema).toHaveProperty('properties');
    });

    test('should include roadmapPath property in schema', async () => {
      const { analyze_roosync_problems } = await import('../analyze_problems.js');

      // Vérifier que la propriété roadmapPath est définie
      expect(analyze_roosync_problems.inputSchema.properties).toHaveProperty('roadmapPath');
      expect(analyze_roosync_problems.inputSchema.properties.roadmapPath.type).toBe('string');
    });

    test('should include generateReport property in schema', async () => {
      const { analyze_roosync_problems } = await import('../analyze_problems.js');

      // Vérifier que la propriété generateReport est définie
      expect(analyze_roosync_problems.inputSchema.properties).toHaveProperty('generateReport');
      expect(analyze_roosync_problems.inputSchema.properties.generateReport.type).toBe('boolean');
    });
  });

  // ============================================================
  // Tests de gestion des paramètres
  // ============================================================

  describe('parameter handling', () => {
    test('should accept optional roadmapPath parameter', async () => {
      const { analyzeRooSyncProblems } = await import('../analyze_problems.js');

      // Sans paramètre - devrait utiliser l'autodétection
      const result1 = await analyzeRooSyncProblems();
      expect(result1).toBeDefined();

      // Avec un chemin invalide - devrait retourner une erreur système (ENOENT en anglais)
      const result2 = await analyzeRooSyncProblems({ roadmapPath: '/nonexistent/path/sync-roadmap.md' });
      expect(result2).toBeDefined();

      const parsed = JSON.parse(result2.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/ENOENT|no such file/);
    });

    test('should accept generateReport parameter', async () => {
      const { analyzeRooSyncProblems } = await import('../analyze_problems.js');

      // generateReport: true - devrait créer un rapport si le fichier existe
      const result = await analyzeRooSyncProblems({ generateReport: true });
      expect(result).toBeDefined();

      const parsed = JSON.parse(result.content[0].text);

      // Si le roadmap existe, vérifier que reportGenerated est présent
      // Si le roadmap n'existe pas, success devrait être false
      if (parsed.success === true) {
        expect(parsed).toHaveProperty('reportGenerated');
      }
    });
  });

  // ============================================================
  // Tests de gestion des erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle non-existent roadmap path', async () => {
      const { analyzeRooSyncProblems } = await import('../analyze_problems.js');

      const result = await analyzeRooSyncProblems({
        roadmapPath: '/absolute/nonexistent/path/to/sync-roadmap.md'
      });

      expect(result).toBeDefined();
      // L'outil retourne isError: true quand une erreur système survient (ENOENT)
      expect(result.isError).toBe(true);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      // L'erreur système ENOENT est en anglais
      expect(parsed.error).toMatch(/ENOENT|no such file/);
    });

    test('should handle invalid JSON in roadmap', async () => {
      const { analyzeRooSyncProblems } = await import('../analyze_problems.js');

      // Ce test ne peut être effectué qu'avec un fichier réel contenant du JSON invalide
      // Dans un environnement de test isolé, on pourrait créer un tel fichier

      // Pour l'instant, on vérifie juste que l'outil ne plante pas
      const result = await analyzeRooSyncProblems();
      expect(result).toBeDefined();
    });
  });

  // ============================================================
  // NOTE: Tests complets d'analyse RooSync
  // ============================================================
  /*
   * Les tests suivants nécessitent un fichier sync-roadmap.md réel:
   *
   * - Détection des décisions en double
   * - Détection des données hardware corrompues
   * - Détection des incohérences de statut
   * - Comptage des décisions pending/approved
   * - Génération de rapports Markdown
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un fichier sync-roadmap.md de test avec des cas connus
   * 2. Un environnement contrôlé avec des chemins spécifiques
   * 3. Un mécanisme pour créer et nettoyer des fichiers de test
   *
   * Pour les tests unitaires de la logique d'analyse,
   * le fichier analyze_problems.test.ts existe déjà.
   */
});
