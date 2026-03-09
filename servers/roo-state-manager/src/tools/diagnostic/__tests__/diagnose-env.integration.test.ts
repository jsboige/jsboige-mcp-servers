/**
 * Tests d'intégration pour diagnose_env
 *
 * NOTE LIMITATION: Cet outil accède au système de fichiers réel pour vérifier
 * les répertoires critiques. Ces tests vérifient que l'outil ne plante pas
 * et gère correctement les erreurs.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte système de fichiers)
 *
 * @module diagnostic/diagnose-env.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';

describe('diagnose_env (integration)', () => {
  beforeAll(async () => {
    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  });

  // ============================================================
  // Tests de base - L'outil ne doit pas planter
  // ============================================================

  describe('basic functionality', () => {
    test('should return valid result structure', async () => {
      const { diagnoseEnv } = await import('../diagnose_env.js');

      const result = await diagnoseEnv();

      // L'outil doit toujours retourner une structure valide
      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const text = result.content[0].text;
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    });

    test('should return valid JSON report', async () => {
      const { diagnoseEnv } = await import('../diagnose_env.js');

      const result = await diagnoseEnv();

      const text = result.content[0].text;

      // Le résultat doit être du JSON valide
      expect(() => JSON.parse(text)).not.toThrow();

      const parsed = JSON.parse(text);
      expect(typeof parsed).toBe('object');
    });

    test('should include timestamp in report', async () => {
      const { diagnoseEnv } = await import('../diagnose_env.js');

      const result = await diagnoseEnv();

      const parsed = JSON.parse(result.content[0].text);

      // Le rapport doit contenir un timestamp
      expect(parsed).toHaveProperty('timestamp');
      expect(typeof parsed.timestamp).toBe('string');
      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('should include system info', async () => {
      const { diagnoseEnv } = await import('../diagnose_env.js');

      const result = await diagnoseEnv();

      const parsed = JSON.parse(result.content[0].text);

      // Le rapport doit contenir les infos système
      expect(parsed).toHaveProperty('system');
      expect(parsed.system).toHaveProperty('platform');
      expect(parsed.system).toHaveProperty('arch');
      expect(parsed.system).toHaveProperty('nodeVersion');
      expect(parsed.system).toHaveProperty('hostname');
    });

    test('should include memory info', async () => {
      const { diagnoseEnv } = await import('../diagnose_env.js');

      const result = await diagnoseEnv();

      const parsed = JSON.parse(result.content[0].text);

      // Le rapport doit contenir les infos mémoire
      expect(parsed.system).toHaveProperty('totalMemory');
      expect(parsed.system).toHaveProperty('freeMemory');
      expect(parsed.system).toHaveProperty('uptime');
      expect(typeof parsed.system.totalMemory).toBe('number');
      expect(typeof parsed.system.freeMemory).toBe('number');
    });

    test('should include status field', async () => {
      const { diagnoseEnv } = await import('../diagnose_env.js');

      const result = await diagnoseEnv();

      const parsed = JSON.parse(result.content[0].text);

      // Le rapport doit contenir un statut
      expect(parsed).toHaveProperty('status');
      expect(['OK', 'WARNING']).toContain(parsed.status);
    });
  });

  // ============================================================
  // Tests de vérification des répertoires
  // ============================================================

  describe('directory checks', () => {
    test('should include directories status', async () => {
      const { diagnoseEnv } = await import('../diagnose_env.js');

      const result = await diagnoseEnv();

      const parsed = JSON.parse(result.content[0].text);

      // Le rapport doit contenir le statut des répertoires
      expect(parsed).toHaveProperty('directories');
      expect(typeof parsed.directories).toBe('object');

      // Vérifier que les répertoires critiques sont testés
      const criticalDirs = ['.', '.shared-state', 'roo-config', 'mcps', 'logs'];
      for (const dir of criticalDirs) {
        expect(parsed.directories).toHaveProperty(dir);
        expect(typeof parsed.directories[dir]).toBe('object');
      }
    });

    test('should report directory accessibility correctly', async () => {
      const { diagnoseEnv } = await import('../diagnose_env.js');

      const result = await diagnoseEnv();

      const parsed = JSON.parse(result.content[0].text);

      // Au minimum le répertoire courant doit être accessible
      expect(parsed.directories['.']).toBeDefined();
      expect(parsed.directories['.'].hasOwnProperty('exists') || parsed.directories['.'].hasOwnProperty('writable')).toBe(true);
    });
  });

  // ============================================================
  // Tests de vérification des variables d'environnement
  // ============================================================

  describe('environment variables', () => {
    test('should include environment variables check', async () => {
      const { diagnoseEnv } = await import('../diagnose_env.js');

      const result = await diagnoseEnv();

      const parsed = JSON.parse(result.content[0].text);

      // Le rapport doit contenir les variables d'environnement
      expect(parsed).toHaveProperty('envVars');
      expect(typeof parsed.envVars).toBe('object');
    });

    test('should check PATH variable', async () => {
      const { diagnoseEnv } = await import('../diagnose_env.js');

      const result = await diagnoseEnv();

      const parsed = JSON.parse(result.content[0].text);

      // PATH doit être vérifié
      expect(parsed.envVars).toHaveProperty('hasPath');
      expect(typeof parsed.envVars.hasPath).toBe('boolean');
    });

    test('should include current working directory', async () => {
      const { diagnoseEnv } = await import('../diagnose_env.js');

      const result = await diagnoseEnv();

      const parsed = JSON.parse(result.content[0].text);

      // CWD doit être inclus
      expect(parsed.envVars).toHaveProperty('cwd');
      expect(typeof parsed.envVars.cwd).toBe('string');
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should have tool definition with proper structure', async () => {
      const { diagnose_env } = await import('../diagnose_env.js');

      // Vérifier que l'outil exporté a la bonne structure
      expect(diagnose_env).toHaveProperty('name', 'diagnose_env');
      expect(diagnose_env).toHaveProperty('description');
      expect(diagnose_env).toHaveProperty('inputSchema');
    });

    test('should have correct input schema', async () => {
      const { diagnose_env } = await import('../diagnose_env.js');

      // Vérifier le schéma d'entrée
      expect(diagnose_env.inputSchema).toHaveProperty('type', 'object');
      expect(diagnose_env.inputSchema).toHaveProperty('properties');
    });

    test('should include checkDiskSpace property in schema', async () => {
      const { diagnose_env } = await import('../diagnose_env.js');

      // Vérifier que la propriété checkDiskSpace est définie
      expect(diagnose_env.inputSchema.properties).toHaveProperty('checkDiskSpace');
      expect(diagnose_env.inputSchema.properties.checkDiskSpace.type).toBe('boolean');
    });
  });

  // ============================================================
  // NOTE: Tests complets de diagnostic environnement
  // ============================================================
  /*
   * Les tests suivants nécessitent un environnement de test contrôlé:
   *
   * - Vérification de l'espace disque (checkDiskSpace)
   * - Simulation de répertoires manquants
   * - Simulation de fichiers manquants
   * - Test sur différentes plateformes
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un environnement de test isolé
   * 2. Des mocks du système de fichiers (pour les tests négatifs)
   * 3. Un système de cleanup après les tests
   *
   * Pour les tests unitaires de la logique de validation,
   * le fichier diagnose_env.test.ts existe déjà.
   */
});
