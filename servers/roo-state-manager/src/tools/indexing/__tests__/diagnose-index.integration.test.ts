/**
 * Tests d'intégration pour diagnose_index (diagnostic de l'index sémantique Qdrant)
 *
 * NOTE LIMITATION: Cet outil vérifie la connectivité Qdrant et OpenAI.
 * Ces tests vérifient que l'outil ne plante pas et retourne une structure valide.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte services externes)
 *
 * @module indexing/diagnose-index.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect } from 'vitest';

describe('diagnose_index (integration)', () => {
  // ============================================================
  // Tests de base - L'outil ne doit pas planter
  // ============================================================

  describe('basic functionality', () => {
    test('should return valid result structure', async () => {
      const { handleDiagnoseSemanticIndex } = await import('../diagnose-index.tool.js');
      const conversationCache = new Map();
      const result = await handleDiagnoseSemanticIndex(conversationCache);

      // L'outil doit toujours retourner une structure valide
      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const text = result.content[0].text;
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    });

    test('should return valid JSON report', async () => {
      const { handleDiagnoseSemanticIndex } = await import('../diagnose-index.tool.js');
      const conversationCache = new Map();
      const result = await handleDiagnoseSemanticIndex(conversationCache);

      const text = result.content[0].text;

      // Le résultat doit être du JSON valide
      expect(() => JSON.parse(text)).not.toThrow();

      const parsed = JSON.parse(text);
      expect(typeof parsed).toBe('object');
    });

    test('should include timestamp in report', async () => {
      const { handleDiagnoseSemanticIndex } = await import('../diagnose-index.tool.js');
      const conversationCache = new Map();
      const result = await handleDiagnoseSemanticIndex(conversationCache);

      const parsed = JSON.parse(result.content[0].text);

      // Le rapport doit contenir un timestamp
      expect(parsed).toHaveProperty('timestamp');
      expect(typeof parsed.timestamp).toBe('string');
      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('should include status field', async () => {
      const { handleDiagnoseSemanticIndex } = await import('../diagnose-index.tool.js');
      const conversationCache = new Map();
      const result = await handleDiagnoseSemanticIndex(conversationCache);

      const parsed = JSON.parse(result.content[0].text);

      // Le rapport doit contenir un statut
      expect(parsed).toHaveProperty('status');
      expect(typeof parsed.status).toBe('string');
      expect([
        'unknown', 'healthy', 'degraded', 'missing_collection', 'empty_collection',
        'collection_error', 'connection_failed'
      ]).toContain(parsed.status);
    });

    test('should include details object', async () => {
      const { handleDiagnoseSemanticIndex } = await import('../diagnose-index.tool.js');
      const conversationCache = new Map();
      const result = await handleDiagnoseSemanticIndex(conversationCache);

      const parsed = JSON.parse(result.content[0].text);

      // Le rapport doit contenir des détails
      expect(parsed).toHaveProperty('details');
      expect(typeof parsed.details).toBe('object');
    });

    test('should include errors array', async () => {
      const { handleDiagnoseSemanticIndex } = await import('../diagnose-index.tool.js');
      const conversationCache = new Map();
      const result = await handleDiagnoseSemanticIndex(conversationCache);

      const parsed = JSON.parse(result.content[0].text);

      // Le rapport doit contenir un tableau d'erreurs
      expect(parsed).toHaveProperty('errors');
      expect(Array.isArray(parsed.errors)).toBe(true);
    });

    test('should include recommendations array', async () => {
      const { handleDiagnoseSemanticIndex } = await import('../diagnose-index.tool.js');
      const conversationCache = new Map();
      const result = await handleDiagnoseSemanticIndex(conversationCache);

      const parsed = JSON.parse(result.content[0].text);

      // Le rapport doit contenir un tableau de recommandations
      expect(parsed).toHaveProperty('recommendations');
      expect(Array.isArray(parsed.recommendations)).toBe(true);
    });
  });

  // ============================================================
  // Tests de gestion des services externes
  // ============================================================

  describe('external services handling', () => {
    test('should detect Qdrant connection status', async () => {
      const { handleDiagnoseSemanticIndex } = await import('../diagnose-index.tool.js');
      const conversationCache = new Map();
      const result = await handleDiagnoseSemanticIndex(conversationCache);

      const parsed = JSON.parse(result.content[0].text);

      // Le rapport doit inclure le statut de connexion Qdrant
      expect(parsed.details).toHaveProperty('qdrant_connection');
      expect(['success', 'failed']).toContain(parsed.details.qdrant_connection);
    });

    test('should detect environment variables', async () => {
      const { handleDiagnoseSemanticIndex } = await import('../diagnose-index.tool.js');
      const conversationCache = new Map();
      const result = await handleDiagnoseSemanticIndex(conversationCache);

      const parsed = JSON.parse(result.content[0].text);

      // Le rapport doit inclure l'état des variables d'environnement
      expect(parsed.details).toHaveProperty('environment_variables');
      expect(typeof parsed.details.environment_variables).toBe('object');
    });
  });

  // ============================================================
  // #3257 — coherence status / errors[] / recommendations[].
  // Incident po-2025 (2026-08-24): status:healthy coexisted with a non-empty
  // errors[] (deep diagnostics aborted) and an EMPTY recommendations[]. The
  // invariants below hold regardless of whether the live services are up or
  // down — they pin the INTERNAL consistency of the report, which is exactly
  // what the incident broke.
  // ============================================================

  describe('#3257 — report coherence invariants', () => {
    test('healthy verdict implies zero errors (no false green)', async () => {
      const { handleDiagnoseSemanticIndex } = await import('../diagnose-index.tool.js');
      const conversationCache = new Map();
      const result = await handleDiagnoseSemanticIndex(conversationCache);

      const parsed = JSON.parse(result.content[0].text);

      if (parsed.status === 'healthy') {
        expect(parsed.errors).toHaveLength(0);
        expect(parsed.recommendations).toHaveLength(0);
      }
    });

    test('non-empty errors[] implies a non-healthy verdict', async () => {
      const { handleDiagnoseSemanticIndex } = await import('../diagnose-index.tool.js');
      const conversationCache = new Map();
      const result = await handleDiagnoseSemanticIndex(conversationCache);

      const parsed = JSON.parse(result.content[0].text);

      if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        expect(parsed.status).not.toBe('healthy');
      }
    });

    test('exposes infrastructure_status separately (qdrant / embeddings / deep_diagnostics)', async () => {
      const { handleDiagnoseSemanticIndex } = await import('../diagnose-index.tool.js');
      const conversationCache = new Map();
      const result = await handleDiagnoseSemanticIndex(conversationCache);

      const parsed = JSON.parse(result.content[0].text);

      expect(parsed).toHaveProperty('infrastructure_status');
      expect(parsed.infrastructure_status).toHaveProperty('qdrant');
      expect(parsed.infrastructure_status).toHaveProperty('embeddings');
      expect(parsed.infrastructure_status).toHaveProperty('deep_diagnostics');
      expect(['healthy', 'failed', 'unknown']).toContain(parsed.infrastructure_status.qdrant);
      expect(['healthy', 'failed', 'unknown']).toContain(parsed.infrastructure_status.embeddings);
      expect(['skipped', 'completed', 'failed']).toContain(parsed.infrastructure_status.deep_diagnostics);
    });

    test('exposes a warnings[] array distinct from errors[]', async () => {
      const { handleDiagnoseSemanticIndex } = await import('../diagnose-index.tool.js');
      const conversationCache = new Map();
      const result = await handleDiagnoseSemanticIndex(conversationCache);

      const parsed = JSON.parse(result.content[0].text);

      expect(Array.isArray(parsed.warnings)).toBe(true);
    });
  });

  // ============================================================
  // NOTE: Tests complets de diagnostic Qdrant
  // ============================================================
  /*
   * Les tests suivants nécessitent une configuration Qdrant réelle:
   *
   * - Vérification de l'existence de la collection
   * - Comptage des vecteurs indexés
   * - Test de connectivité OpenAI
   * - Validation de la distance et dimension des vecteurs
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un service Qdrant réel en cours d'exécution
   * 2. Des variables d'environnement valides (.env)
   * 3. Ou des mocks des services Qdrant/OpenAI
   *
   * Pour les tests unitaires de la logique de diagnostic,
   * créer un fichier diagnose-index.unit.test.ts séparé.
   */
});
