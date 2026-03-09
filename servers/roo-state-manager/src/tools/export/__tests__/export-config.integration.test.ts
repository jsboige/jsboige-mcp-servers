/**
 * Tests d'intégration pour export_config
 *
 * NOTE LIMITATION: Cet outil requiert un ExportConfigManager et des callbacks.
 * Ces tests vérifient que l'outil ne plante pas et retourne une structure valide.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte service ExportConfigManager)
 *
 * @module export/export-config.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { ExportConfigManager } from '../../../services/ExportConfigManager.js';

describe('export_config (integration)', () => {
  let exportConfigManager: ExportConfigManager;

  beforeAll(async () => {
    // Initialiser le ExportConfigManager pour les tests
    exportConfigManager = new ExportConfigManager();
  });

  // ============================================================
  // Tests de validation des entrées
  // ============================================================

  describe('input validation', () => {
    test('should require action parameter', async () => {
      const { handleExportConfig } = await import('../export-config.js');

      // L'outil doit retourner une erreur si l'action est manquante
      const result = await handleExportConfig({} as any, exportConfigManager);

      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('action');
    });

    test('should reject invalid action', async () => {
      const { handleExportConfig } = await import('../export-config.js');

      // L'outil doit retourner une erreur pour une action invalide
      const result = await handleExportConfig({ action: 'invalid' as any }, exportConfigManager);

      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('invalide');
    });

    test('should require config parameter for set action', async () => {
      const { handleExportConfig } = await import('../export-config.js');

      // L'outil doit retourner une erreur si config est manquant pour set
      const result = await handleExportConfig({ action: 'set' }, exportConfigManager);

      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('manquante');
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should have tool definition with proper structure', async () => {
      const { exportConfigTool } = await import('../export-config.js');

      // Vérifier que l'outil exporté a la bonne structure
      expect(exportConfigTool).toHaveProperty('name', 'export_config');
      expect(exportConfigTool).toHaveProperty('description');
      expect(exportConfigTool).toHaveProperty('inputSchema');
    });

    test('should have correct input schema', async () => {
      const { exportConfigTool } = await import('../export-config.js');

      // Vérifier le schéma d'entrée
      expect(exportConfigTool.inputSchema).toHaveProperty('type', 'object');
      expect(exportConfigTool.inputSchema).toHaveProperty('properties');
      expect(exportConfigTool.inputSchema.required).toEqual(['action']);
    });

    test('should include action property in schema', async () => {
      const { exportConfigTool } = await import('../export-config.js');

      // Vérifier que la propriété action est définie
      expect(exportConfigTool.inputSchema.properties).toHaveProperty('action');
      expect(exportConfigTool.inputSchema.properties.action.type).toBe('string');
      expect(exportConfigTool.inputSchema.properties.action.enum).toEqual(['get', 'set', 'reset']);
    });

    test('should include config property in schema', async () => {
      const { exportConfigTool } = await import('../export-config.js');

      // Vérifier que la propriété config est définie
      expect(exportConfigTool.inputSchema.properties).toHaveProperty('config');
      expect(exportConfigTool.inputSchema.properties.config.type).toBe('object');
    });

    test('description should mention CONS-10', async () => {
      const { exportConfigTool } = await import('../export-config.js');

      // Vérifier que la description mentionne la consolidation
      expect(exportConfigTool.description).toContain('CONS-10');
    });
  });

  // ============================================================
  // Tests de gestion des actions
  // ============================================================

  describe('action handling', () => {
    test('should handle get action', async () => {
      const { handleExportConfig } = await import('../export-config.js');

      const result = await handleExportConfig({ action: 'get' }, exportConfigManager);

      expect(result).toBeDefined();
      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');

      // Vérifier que le retour est du JSON valide
      const jsonText = result.content[0].text;
      expect(() => JSON.parse(jsonText)).not.toThrow();

      const parsed = JSON.parse(jsonText);
      expect(typeof parsed).toBe('object');
    });

    test('should handle set action - may fail without Roo storage', async () => {
      const { handleExportConfig } = await import('../export-config.js');

      const result = await handleExportConfig(
        { action: 'set', config: { prettyPrint: false } },
        exportConfigManager
      );

      expect(result).toBeDefined();
      // Le set peut échouer si aucun stockage Roo n'est détecté
      if (result.isError) {
        // C'est acceptable dans un environnement de test sans stockage Roo
        expect(result.content[0].text).toMatch(/NO_STORAGE_DETECTED|stockage|Erreur/);
      } else {
        expect(result.content[0].text).toContain('succès');
      }
    });

    test('should handle reset action - may fail without Roo storage', async () => {
      const { handleExportConfig } = await import('../export-config.js');

      const result = await handleExportConfig({ action: 'reset' }, exportConfigManager);

      expect(result).toBeDefined();
      // Le reset peut échouer si aucun stockage Roo n'est détecté
      if (result.isError) {
        // C'est acceptable dans un environnement de test sans stockage Roo
        expect(result.content[0].text).toMatch(/NO_STORAGE_DETECTED|stockage|Erreur/);
      } else {
        expect(result.content[0].text).toContain('défaut');
      }
    });
  });

  // ============================================================
  // NOTE: Tests complets d'export_config
  // ============================================================
  /*
   * Les tests suivants nécessitent un ExportConfigManager complet:
   *
   * - Validation des paramètres de configuration
   * - Persistance des modifications
   * - Validation des valeurs par défaut
   * - Gestion des erreurs de persistance
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un ExportConfigManager avec persistance réelle
   * 2. Un système de fichiers pour stocker la config
   * 3. Ou des mocks complets des services externes
   *
   * Pour les tests unitaires de la logique de configuration,
   * le fichier export-config.test.ts existe déjà.
   */
});
