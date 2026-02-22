/**
 * Tests unitaires pour MarkdownRenderer
 *
 * Couvre :
 * - formatUserMessage : contenu, timestamp optionnel
 * - formatAssistantMessage : contenu, timestamp optionnel
 * - formatToolCall : toolName, parameters, timestamp optionnel
 * - formatToolResult : string, object, JSON sérialisé
 * - formatConversationHeader : tous les champs, valeurs manquantes
 * - formatSectionSeparator : titre et couleur
 * - formatMetadataTable : clés/valeurs
 * - formatToolParametersTable : objet, null, non-objet
 *
 * @module services/markdown-formatter/__tests__/MarkdownRenderer.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect } from 'vitest';
import { MarkdownRenderer } from '../MarkdownRenderer.js';

// ─────────────────── tests ───────────────────

describe('MarkdownRenderer', () => {

  // ============================================================
  // formatUserMessage
  // ============================================================

  describe('formatUserMessage', () => {
    test('contient la classe "user-message"', () => {
      const html = MarkdownRenderer.formatUserMessage('Hello world');
      expect(html).toContain('user-message');
    });

    test('contient le contenu fourni', () => {
      const html = MarkdownRenderer.formatUserMessage('Mon message');
      expect(html).toContain('Mon message');
    });

    test('contient "Message Utilisateur" dans le badge', () => {
      const html = MarkdownRenderer.formatUserMessage('test');
      expect(html).toContain('Message Utilisateur');
    });

    test('sans timestamp : pas de balise <small>', () => {
      const html = MarkdownRenderer.formatUserMessage('test');
      expect(html).not.toContain('<small');
    });

    test('avec timestamp : contient la date dans <small>', () => {
      const html = MarkdownRenderer.formatUserMessage('test', '2026-01-01T10:00:00Z');
      expect(html).toContain('<small');
      expect(html).toContain('2026-01-01T10:00:00Z');
    });

    test('retourne une chaîne non vide', () => {
      expect(MarkdownRenderer.formatUserMessage('')).toBeTruthy();
    });
  });

  // ============================================================
  // formatAssistantMessage
  // ============================================================

  describe('formatAssistantMessage', () => {
    test('contient la classe "assistant-message"', () => {
      const html = MarkdownRenderer.formatAssistantMessage('Réponse');
      expect(html).toContain('assistant-message');
    });

    test('contient le contenu fourni', () => {
      const html = MarkdownRenderer.formatAssistantMessage('Ma réponse');
      expect(html).toContain('Ma réponse');
    });

    test('contient "Réponse Assistant"', () => {
      const html = MarkdownRenderer.formatAssistantMessage('test');
      expect(html).toContain('Réponse Assistant');
    });

    test('sans timestamp : pas de balise <small>', () => {
      const html = MarkdownRenderer.formatAssistantMessage('test');
      expect(html).not.toContain('<small');
    });

    test('avec timestamp : contient la date', () => {
      const html = MarkdownRenderer.formatAssistantMessage('test', '2026-06-15T12:00:00Z');
      expect(html).toContain('2026-06-15T12:00:00Z');
    });
  });

  // ============================================================
  // formatToolCall
  // ============================================================

  describe('formatToolCall', () => {
    test('contient la classe "tool-call"', () => {
      const html = MarkdownRenderer.formatToolCall('my_tool', {});
      expect(html).toContain('tool-call');
    });

    test('contient le nom de l\'outil', () => {
      const html = MarkdownRenderer.formatToolCall('read_file', {});
      expect(html).toContain('read_file');
    });

    test('contient "Appel d\'Outil"', () => {
      const html = MarkdownRenderer.formatToolCall('write_file', { path: '/tmp/test' });
      expect(html).toContain("Appel d'Outil");
    });

    test('avec timestamp : contient la date', () => {
      const html = MarkdownRenderer.formatToolCall('tool', {}, '2026-01-01T00:00:00Z');
      expect(html).toContain('2026-01-01T00:00:00Z');
    });

    test('sans timestamp : pas de balise <small>', () => {
      const html = MarkdownRenderer.formatToolCall('tool', {});
      expect(html).not.toContain('<small');
    });

    test('paramètres objet inclus dans le tableau', () => {
      const html = MarkdownRenderer.formatToolCall('tool', { key: 'value' });
      expect(html).toContain('key');
      expect(html).toContain('value');
    });
  });

  // ============================================================
  // formatToolResult
  // ============================================================

  describe('formatToolResult', () => {
    test('contient la classe "tool-result"', () => {
      const html = MarkdownRenderer.formatToolResult('my_tool', 'result');
      expect(html).toContain('tool-result');
    });

    test('contient "Résultat:" dans le badge', () => {
      const html = MarkdownRenderer.formatToolResult('read_file', 'content');
      expect(html).toContain('Résultat:');
      expect(html).toContain('read_file');
    });

    test('résultat string : affiché directement', () => {
      const html = MarkdownRenderer.formatToolResult('tool', 'ma chaîne');
      expect(html).toContain('ma chaîne');
    });

    test('résultat objet : sérialisé en JSON', () => {
      const html = MarkdownRenderer.formatToolResult('tool', { key: 'value' });
      expect(html).toContain('"key"');
      expect(html).toContain('"value"');
    });

    test('résultat null : sérialisé', () => {
      const html = MarkdownRenderer.formatToolResult('tool', null);
      expect(html).toContain('null');
    });

    test('avec timestamp : contient la date', () => {
      const html = MarkdownRenderer.formatToolResult('tool', 'ok', '2026-03-01T00:00:00Z');
      expect(html).toContain('2026-03-01T00:00:00Z');
    });
  });

  // ============================================================
  // formatConversationHeader
  // ============================================================

  describe('formatConversationHeader', () => {
    test('contient le taskId', () => {
      const html = MarkdownRenderer.formatConversationHeader({ taskId: 'task-abc-123' });
      expect(html).toContain('task-abc-123');
    });

    test('contient le titre si fourni', () => {
      const html = MarkdownRenderer.formatConversationHeader({ taskId: 'x', title: 'Mon titre' });
      expect(html).toContain('Mon titre');
    });

    test('titre par défaut si non fourni', () => {
      const html = MarkdownRenderer.formatConversationHeader({ taskId: 'x' });
      expect(html).toContain("RESUME DE TRACE D'ORCHESTRATION ROO");
    });

    test('contient le messageCount si fourni', () => {
      const html = MarkdownRenderer.formatConversationHeader({ taskId: 'x', messageCount: 42 });
      expect(html).toContain('42');
    });

    test('messageCount = 0 par défaut si absent', () => {
      const html = MarkdownRenderer.formatConversationHeader({ taskId: 'x' });
      expect(html).toContain('0');
    });

    test('contient totalSize si fourni', () => {
      const html = MarkdownRenderer.formatConversationHeader({ taskId: 'x', totalSize: '150 KB' });
      expect(html).toContain('150 KB');
    });

    test('contient la date formatée si createdAt fourni', () => {
      const html = MarkdownRenderer.formatConversationHeader({ taskId: 'x', createdAt: '2026-01-15T10:00:00Z' });
      expect(html).toContain('15'); // Day
    });

    test('contient "N/A" si createdAt absent', () => {
      const html = MarkdownRenderer.formatConversationHeader({ taskId: 'x' });
      expect(html).toContain('N/A');
    });
  });

  // ============================================================
  // formatSectionSeparator
  // ============================================================

  describe('formatSectionSeparator', () => {
    test('contient le titre', () => {
      const html = MarkdownRenderer.formatSectionSeparator('Mon Section', '#ff0000');
      expect(html).toContain('Mon Section');
    });

    test('contient la couleur dans le style', () => {
      const html = MarkdownRenderer.formatSectionSeparator('Test', '#00ff00');
      expect(html).toContain('#00ff00');
    });

    test('contient "section-separator-with-title"', () => {
      const html = MarkdownRenderer.formatSectionSeparator('Test', 'blue');
      expect(html).toContain('section-separator-with-title');
    });

    test('contient une balise h2', () => {
      const html = MarkdownRenderer.formatSectionSeparator('Titre', 'red');
      expect(html).toContain('<h2');
    });
  });

  // ============================================================
  // formatMetadataTable
  // ============================================================

  describe('formatMetadataTable', () => {
    test('contient les clés du record', () => {
      const html = MarkdownRenderer.formatMetadataTable({ machineId: 'test-machine', version: '1.0' });
      expect(html).toContain('machineId');
      expect(html).toContain('version');
    });

    test('contient les valeurs du record', () => {
      const html = MarkdownRenderer.formatMetadataTable({ key: 'ma-valeur' });
      expect(html).toContain('ma-valeur');
    });

    test('contient une table HTML', () => {
      const html = MarkdownRenderer.formatMetadataTable({ a: 1 });
      expect(html).toContain('<table');
      expect(html).toContain('</table>');
    });

    test('contient les en-têtes "Propriété" et "Valeur"', () => {
      const html = MarkdownRenderer.formatMetadataTable({});
      expect(html).toContain('Propriété');
      expect(html).toContain('Valeur');
    });

    test('objet vide génère un tableau sans lignes tbody', () => {
      const html = MarkdownRenderer.formatMetadataTable({});
      expect(html).toContain('<tbody>');
    });
  });

  // ============================================================
  // formatToolParametersTable
  // ============================================================

  describe('formatToolParametersTable', () => {
    test('objet avec propriétés : retourne un tableau HTML', () => {
      const html = MarkdownRenderer.formatToolParametersTable({ param1: 'val1' });
      expect(html).toContain('<table');
      expect(html).toContain('param1');
    });

    test('valeur string dans paramètre : affichée directement', () => {
      const html = MarkdownRenderer.formatToolParametersTable({ path: '/tmp/file.txt' });
      expect(html).toContain('/tmp/file.txt');
    });

    test('valeur objet dans paramètre : sérialisée en JSON', () => {
      const html = MarkdownRenderer.formatToolParametersTable({ opts: { key: 'val' } });
      expect(html).toContain('"key"');
    });

    test('params null : retourne un <pre><code> avec "null"', () => {
      const html = MarkdownRenderer.formatToolParametersTable(null);
      expect(html).toContain('<pre>');
      expect(html).toContain('null');
    });

    test('params string : retourne un <pre><code>', () => {
      const html = MarkdownRenderer.formatToolParametersTable('raw string');
      expect(html).toContain('<pre>');
      expect(html).toContain('raw string');
    });

    test('params nombre : retourne un <pre><code>', () => {
      const html = MarkdownRenderer.formatToolParametersTable(42);
      expect(html).toContain('42');
    });

    test('contient les en-têtes "Paramètre" et "Valeur"', () => {
      const html = MarkdownRenderer.formatToolParametersTable({ key: 'val' });
      expect(html).toContain('Paramètre');
      expect(html).toContain('Valeur');
    });
  });
});
