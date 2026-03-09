/**
 * Tests d'intégration pour export_data
 *
 * NOTE LIMITATION: Cet outil requiert un cache de conversations avec des données réelles,
 * un service XmlExporter, et des callbacks pour rafraîchir le cache. Ces tests vérifient
 * que l'outil ne plante pas et retourne une structure valide.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte cache + services)
 *
 * @module export/export-data.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';

describe('export_data (integration)', () => {
  beforeAll(async () => {
    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  });

  // ============================================================
  // Tests de validation des entrées
  // ============================================================

  describe('input validation', () => {
    test('should require target parameter', async () => {
      const { handleExportData } = await import('../export-data.js');
      const conversationCache = new Map();

      // L'outil doit retourner une erreur si target est manquant
      const result = await handleExportData(
        { format: 'xml' } as any,
        conversationCache,
        {} as any,
        async () => { },
        async () => null
      );

      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('target');
    });

    test('should require format parameter', async () => {
      const { handleExportData } = await import('../export-data.js');
      const conversationCache = new Map();

      // L'outil doit retourner une erreur si format est manquant
      const result = await handleExportData(
        { target: 'task' } as any,
        conversationCache,
        {} as any,
        async () => { },
        async () => null
      );

      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('format');
    });

    test('should reject invalid target/format combination', async () => {
      const { handleExportData } = await import('../export-data.js');
      const conversationCache = new Map();

      // task + json n'est pas supporté (seulement xml)
      const result = await handleExportData(
        { target: 'task' as any, format: 'json' as any },
        conversationCache,
        {} as any,
        async () => { },
        async () => null
      );

      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('non supportée');
    });

    test('should require taskId for task target', async () => {
      const { handleExportData } = await import('../export-data.js');
      const conversationCache = new Map();

      // L'outil doit retourner une erreur si taskId est manquant pour target=task
      const result = await handleExportData(
        { target: 'task' as any, format: 'xml' as any },
        conversationCache,
        {} as any,
        async () => { },
        async () => null
      );

      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('taskId');
    });

    test('should require conversationId for conversation+xml', async () => {
      const { handleExportData } = await import('../export-data.js');
      const conversationCache = new Map();

      // L'outil doit retourner une erreur si conversationId est manquant pour conversation+xml
      const result = await handleExportData(
        { target: 'conversation' as any, format: 'xml' as any },
        conversationCache,
        {} as any,
        async () => { },
        async () => null
      );

      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('conversationId');
    });

    test('should require taskId for conversation+json', async () => {
      const { handleExportData } = await import('../export-data.js');
      const conversationCache = new Map();

      // L'outil doit retourner une erreur si taskId est manquant pour conversation+json
      const result = await handleExportData(
        { target: 'conversation' as any, format: 'json' as any },
        conversationCache,
        {} as any,
        async () => { },
        async () => null
      );

      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('taskId');
    });

    test('should require projectPath for project target', async () => {
      const { handleExportData } = await import('../export-data.js');
      const conversationCache = new Map();

      // L'outil doit retourner une erreur si projectPath est manquant pour target=project
      const result = await handleExportData(
        { target: 'project' as any, format: 'xml' as any },
        conversationCache,
        {} as any,
        async () => { },
        async () => null
      );

      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('projectPath');
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should have tool definition with proper structure', async () => {
      const { exportDataTool } = await import('../export-data.js');

      // Vérifier que l'outil exporté a la bonne structure
      expect(exportDataTool).toHaveProperty('name', 'export_data');
      expect(exportDataTool).toHaveProperty('description');
      expect(exportDataTool).toHaveProperty('inputSchema');
    });

    test('should have correct input schema', async () => {
      const { exportDataTool } = await import('../export-data.js');

      // Vérifier le schéma d'entrée
      expect(exportDataTool.inputSchema).toHaveProperty('type', 'object');
      expect(exportDataTool.inputSchema).toHaveProperty('properties');
      expect(exportDataTool.inputSchema.required).toEqual(['target', 'format']);
    });

    test('should include target property in schema', async () => {
      const { exportDataTool } = await import('../export-data.js');

      // Vérifier que la propriété target est définie
      expect(exportDataTool.inputSchema.properties).toHaveProperty('target');
      expect(exportDataTool.inputSchema.properties.target.type).toBe('string');
      expect(exportDataTool.inputSchema.properties.target.enum).toEqual(['task', 'conversation', 'project']);
    });

    test('should include format property in schema', async () => {
      const { exportDataTool } = await import('../export-data.js');

      // Vérifier que la propriété format est définie
      expect(exportDataTool.inputSchema.properties).toHaveProperty('format');
      expect(exportDataTool.inputSchema.properties.format.type).toBe('string');
      expect(exportDataTool.inputSchema.properties.format.enum).toEqual(['xml', 'json', 'csv']);
    });

    test('should include taskId property in schema', async () => {
      const { exportDataTool } = await import('../export-data.js');

      // Vérifier que la propriété taskId est définie
      expect(exportDataTool.inputSchema.properties).toHaveProperty('taskId');
      expect(exportDataTool.inputSchema.properties.taskId.type).toBe('string');
    });

    test('should include conversationId property in schema', async () => {
      const { exportDataTool } = await import('../export-data.js');

      // Vérifier que la propriété conversationId est définie
      expect(exportDataTool.inputSchema.properties).toHaveProperty('conversationId');
      expect(exportDataTool.inputSchema.properties.conversationId.type).toBe('string');
    });

    test('should include projectPath property in schema', async () => {
      const { exportDataTool } = await import('../export-data.js');

      // Vérifier que la propriété projectPath est définie
      expect(exportDataTool.inputSchema.properties).toHaveProperty('projectPath');
      expect(exportDataTool.inputSchema.properties.projectPath.type).toBe('string');
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle non-existent task gracefully', async () => {
      const { handleExportData } = await import('../export-data.js');
      const conversationCache = new Map();

      // L'outil doit retourner une erreur pour une tâche inexistante
      const result = await handleExportData(
        { target: 'task' as any, format: 'xml' as any, taskId: 'non-existent-task-id-12345' },
        conversationCache,
        {} as any,
        async () => { },
        async () => null
      );

      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('non trouvée');
    });

    test('should handle non-existent conversation gracefully', async () => {
      const { handleExportData } = await import('../export-data.js');
      const conversationCache = new Map();

      // Pour conversation+json, utilise getConversationSkeleton qui retourne null
      const result = await handleExportData(
        { target: 'conversation' as any, format: 'json' as any, taskId: 'non-existent-task-id-12345' },
        conversationCache,
        {} as any,
        async () => { },
        async () => null
      );

      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('introuvable');
    });
  });

  // ============================================================
  // NOTE: Tests complets d'export
  // ============================================================
  /*
   * Les tests suivants nécessitent un cache de conversations avec des données réelles:
   *
   * - Export effectif d'une tâche au format XML
   * - Export d'une conversation complète en XML/JSON/CSV
   * - Export d'un projet entier filtré par date
   * - Sauvegarde des exports dans des fichiers
   * - Validation de la taille des exports (>100MB pour tests de performance)
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un cache peuplé avec des conversations de test
   * 2. Un système de fichiers temporaire pour les exports
   * 3. Des fixtures de conversations avec données variées
   *
   * Pour les tests unitaires de la logique d'export XML/JSON/CSV,
   * créer un fichier export-data.unit.test.ts séparé.
   */
});
