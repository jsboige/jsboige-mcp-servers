/**
 * Tests d'intégration pour minimal_test_tool
 *
 * NOTE: Cet outil est un outil de test minimal qui ne dépend d'aucune ressource externe.
 * Les tests peuvent être complets car l'outil est autonome.
 *
 * Framework: Vitest
 * Type: Intégration (outil autonome)
 *
 * @module test/minimal-test.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect } from 'vitest';

describe('minimal_test_tool (integration)', () => {
  // ============================================================
  // Tests de base - L'outil ne doit pas planter
  // ============================================================

  describe('basic functionality', () => {
    test('should return valid result structure', async () => {
      const { minimal_test_tool } = await import('../minimal-test.tool.js');
      const result = await minimal_test_tool.handler({
        message: 'Test message'
      });

      // L'outil doit toujours retourner une structure valide
      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const text = result.content[0].text;
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    });

    test('should return valid markdown report', async () => {
      const { minimal_test_tool } = await import('../minimal-test.tool.js');
      const result = await minimal_test_tool.handler({
        message: 'Test message'
      });

      const text = result.content[0].text;

      // Le résultat doit être du markdown valide
      expect(text).toMatch(/# Test Minimal MCP/);
      expect(text).toMatch(/\*\*Message:\*\*/);
      expect(text).toMatch(/\*\*Timestamp:\*\*/);
      expect(text).toMatch(/\*\*Status:\*\* Succès/);
    });

    test('should include custom message in response', async () => {
      const { minimal_test_tool } = await import('../minimal-test.tool.js');
      const customMessage = 'My custom test message';
      const result = await minimal_test_tool.handler({
        message: customMessage
      });

      const text = result.content[0].text;

      // Le message personnalisé doit être inclus
      expect(text).toContain(customMessage);
    });

    test('should include timestamp in response', async () => {
      const { minimal_test_tool } = await import('../minimal-test.tool.js');
      const beforeCall = new Date().toISOString();
      const result = await minimal_test_tool.handler({
        message: 'Test'
      });
      const afterCall = new Date().toISOString();

      const text = result.content[0].text;

      // Un timestamp doit être présent
      expect(text).toMatch(/\*\*Timestamp:\*\* \d{4}-\d{2}-\d{2}T/);
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should have tool definition with proper structure', async () => {
      const { minimal_test_tool } = await import('../minimal-test.tool.js');

      // Vérifier que l'outil exporté a la bonne structure
      expect(minimal_test_tool).toHaveProperty('definition');
      expect(minimal_test_tool).toHaveProperty('handler');
      expect(typeof minimal_test_tool.handler).toBe('function');
    });

    test('should have correct input schema', async () => {
      const { minimal_test_tool } = await import('../minimal-test.tool.js');

      // Vérifier le schéma d'entrée
      expect(minimal_test_tool.definition.inputSchema).toHaveProperty('type', 'object');
      expect(minimal_test_tool.definition.inputSchema).toHaveProperty('properties');
      expect(minimal_test_tool.definition.inputSchema.required).toEqual(['message']);
    });

    test('should require message parameter', async () => {
      const { minimal_test_tool } = await import('../minimal-test.tool.js');

      // Le paramètre message est requis
      expect(minimal_test_tool.definition.inputSchema.required).toContain('message');
      expect(minimal_test_tool.definition.inputSchema.properties.message).toHaveProperty('type', 'string');
    });
  });

  // ============================================================
  // Tests de gestion des entrées
  // ============================================================

  describe('input handling', () => {
    test('should handle empty message', async () => {
      const { minimal_test_tool } = await import('../minimal-test.tool.js');
      const result = await minimal_test_tool.handler({
        message: ''
      });

      // Même avec un message vide, l'outil doit fonctionner
      expect(result.content[0].text).toBeTruthy();
    });

    test('should handle special characters in message', async () => {
      const { minimal_test_tool } = await import('../minimal-test.tool.js');
      const specialMessage = 'Test with émojis 🎉 and spëcial çhars';
      const result = await minimal_test_tool.handler({
        message: specialMessage
      });

      const text = result.content[0].text;

      // Les caractères spéciaux doivent être préservés
      expect(text).toContain(specialMessage);
    });

    test('should handle long messages', async () => {
      const { minimal_test_tool } = await import('../minimal-test.tool.js');
      const longMessage = 'A'.repeat(1000);
      const result = await minimal_test_tool.handler({
        message: longMessage
      });

      const text = result.content[0].text;

      // Les messages longs doivent être gérés
      expect(text).toContain(longMessage);
    });
  });
});
