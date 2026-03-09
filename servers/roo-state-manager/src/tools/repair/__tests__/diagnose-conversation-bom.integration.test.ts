/**
 * Tests d'intégration pour diagnose_conversation_bom
 *
 * NOTE LIMITATION: Cet outil scanne le système de fichiers réel pour détecter
 * les fichiers avec BOM UTF-8. Ces tests vérifient que l'outil ne plante pas
 * et retourne une structure valide.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte RooStorageDetector)
 *
 * @module repair/diagnose-conversation-bom.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';

describe('diagnose_conversation_bom (integration)', () => {
  beforeAll(async () => {
    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  });

  // ============================================================
  // Tests de base - L'outil ne doit pas planter
  // ============================================================

  describe('basic functionality', () => {
    test('should return valid result structure', async () => {
      const { diagnoseConversationBomTool } = await import('../diagnose-conversation-bom.tool.js');
      const result = await diagnoseConversationBomTool.handler({});

      // L'outil doit toujours retourner une structure valide
      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const text = result.content[0].text;
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    });

    test('should return valid markdown report', async () => {
      const { diagnoseConversationBomTool } = await import('../diagnose-conversation-bom.tool.js');
      const result = await diagnoseConversationBomTool.handler({});

      const text = result.content[0].text;

      // Le résultat doit être du texte valide (peut être un message d'absence de stockage)
      expect(text).toBeTruthy();
      expect(text.length).toBeGreaterThan(0);

      // Si le stockage Roo est détecté, vérifier la structure markdown
      if (!text.includes('Aucun emplacement de stockage Roo trouvé')) {
        expect(text).toMatch(/# Diagnostic BOM/);
        expect(text).toMatch(/\*\*Fichiers analysés:\*\*/);
        expect(text).toMatch(/\*\*Fichiers corrompus/);
      }
    });

    test('should include statistics in report', async () => {
      const { diagnoseConversationBomTool } = await import('../diagnose-conversation-bom.tool.js');
      const result = await diagnoseConversationBomTool.handler({});

      const text = result.content[0].text;

      // Vérifier que le texte contient des statistiques ou un message d'absence
      expect(text).toBeTruthy();

      if (!text.includes('Aucun emplacement de stockage Roo trouvé')) {
        // Le rapport doit contenir des statistiques
        expect(text).toMatch(/\*\*Fichiers analysés:\*\* \d+/);
        expect(text).toMatch(/\*\*Fichiers corrompus \(BOM\):\*\* \d+/);
      }
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should have tool definition with proper structure', async () => {
      const { diagnoseConversationBomTool } = await import('../diagnose-conversation-bom.tool.js');

      // Vérifier que l'outil exporté a la bonne structure
      expect(diagnoseConversationBomTool).toHaveProperty('definition');
      expect(diagnoseConversationBomTool).toHaveProperty('handler');
      expect(typeof diagnoseConversationBomTool.handler).toBe('function');
    });

    test('should have correct input schema (optional parameters)', async () => {
      const { diagnoseConversationBomTool } = await import('../diagnose-conversation-bom.tool.js');

      // Vérifier le schéma d'entrée
      expect(diagnoseConversationBomTool.definition.inputSchema).toHaveProperty('type', 'object');
      expect(diagnoseConversationBomTool.definition.inputSchema).toHaveProperty('properties');
      expect(diagnoseConversationBomTool.definition.inputSchema.required).toEqual([]);

      // Vérifier le paramètre fix_found
      expect(diagnoseConversationBomTool.definition.inputSchema.properties).toHaveProperty('fix_found');
    });

    test('should support fix_found parameter', async () => {
      const { diagnoseConversationBomTool } = await import('../diagnose-conversation-bom.tool.js');

      // Test avec fix_found=false (default)
      const resultWithoutFix = await diagnoseConversationBomTool.handler({
        fix_found: false
      });
      expect(resultWithoutFix.content[0].text).toBeTruthy();

      // Test avec fix_found=true (diagnostic mode)
      const resultWithFix = await diagnoseConversationBomTool.handler({
        fix_found: true
      });
      expect(resultWithFix.content[0].text).toBeTruthy();
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle empty storage gracefully', async () => {
      const { diagnoseConversationBomTool } = await import('../diagnose-conversation-bom.tool.js');
      const result = await diagnoseConversationBomTool.handler({});

      const text = result.content[0].text;

      // Même sans stockage Roo, l'outil doit retourner un rapport valide
      expect(text).toBeTruthy();
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // NOTE: Tests complets de détection BOM
  // ============================================================
  /*
   * Les tests suivants nécessitent un stockage Roo réel:
   *
   * - Détection effective des fichiers avec BOM UTF-8
   * - Comptage des fichiers corrompus
   * - Réparation automatique avec fix_found=true
   * - Validation du contenu après réparation
   * - Liste des fichiers corrompus (limitée à 20)
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un stockage Roo réel avec des fichiers JSON
   * 2. Ou des fixtures de fichiers avec BOM
   *
   * Pour les tests unitaires de la logique de détection BOM,
   * créer un fichier diagnose-conversation-bom.unit.test.ts séparé.
   */
});
