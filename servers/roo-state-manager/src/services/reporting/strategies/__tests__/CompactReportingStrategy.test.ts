/**
 * Tests unitaires pour CompactReportingStrategy
 *
 * Couvre :
 * - Propriétés : detailLevel, description, isTocOnlyMode (= false)
 * - formatMessageContent : UserMessage, ToolResult, Assistant
 * - formatToolResultSummary : résumé des résultats d'outils
 * - formatAssistantMessageCompact : messages assistant avec outils résumés
 * - detectResultType : détection du type de résultat
 * - formatContentSize : formatage lisible des tailles
 *
 * @module services/reporting/strategies/__tests__/CompactReportingStrategy.test
 * @version 1.0.0
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { CompactReportingStrategy } from '../CompactReportingStrategy.js';
import type { ClassifiedContent, EnhancedSummaryOptions } from '../../../../types/enhanced-conversation.js';

// ─────────────────── helpers ───────────────────

const classicOptions: EnhancedSummaryOptions = {};

function makeContent(overrides: Partial<ClassifiedContent> = {}): ClassifiedContent {
  return {
    type: 'User',
    subType: 'UserMessage',
    content: 'Hello world',
    index: 0,
    contentSize: 11,
    isRelevant: true,
    confidenceScore: 1,
    ...overrides,
  };
}

// ─────────────────── setup ───────────────────

let strategy: CompactReportingStrategy;

beforeEach(() => {
  strategy = new CompactReportingStrategy();
});

// ─────────────────── tests ───────────────────

describe('CompactReportingStrategy', () => {

  // ============================================================
  // Propriétés de base
  // ============================================================

  describe('properties', () => {
    test('detailLevel = "Compact"', () => {
      expect(strategy.detailLevel).toBe('Compact');
    });

    test('description est définie', () => {
      expect(typeof strategy.description).toBe('string');
      expect(strategy.description.length).toBeGreaterThan(0);
      expect(strategy.description).toContain('résumés');
    });

    test('isTocOnlyMode() = false (pas TOC-only)', () => {
      expect(strategy.isTocOnlyMode()).toBe(false);
    });
  });

  // ============================================================
  // formatMessageContent - UserMessage
  // ============================================================

  describe('formatMessageContent - UserMessage', () => {
    test('shouldRender = true pour UserMessage', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'User input' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.shouldRender).toBe(true);
    });

    test('contient le contenu utilisateur nettoyé', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'Clean user message' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Clean user message');
    });

    test('metadata.shouldDisplay = true', () => {
      const content = makeContent({ subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.metadata?.shouldDisplay).toBe(true);
    });

    test('cssClass est défini', () => {
      const content = makeContent({ subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.cssClass).toBeDefined();
      expect(typeof result.cssClass).toBe('string');
    });
  });

  // ============================================================
  // formatMessageContent - ToolResult (résumé)
  // ============================================================

  describe('formatMessageContent - ToolResult', () => {
    test('shouldRender = true pour ToolResult', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[bash] Result: command output'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.shouldRender).toBe(true);
    });

    test('contient un résumé compact (pas le contenu complet)', () => {
      const longOutput = 'x'.repeat(1000);
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: `[bash] Result: ${longOutput}`
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      // Le contenu ne devrait pas contenir les 1000 caractères complets
      expect(result.content.length).toBeLessThan(longOutput.length);
    });

    test('affiche le nom de l\'outil et la taille', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[my_tool] Result: some output'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('my_tool');
    });

    test('affiche un succès pour les résultats sans erreur', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[bash] Result: success'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('');
    });

    test('affiche une erreur pour les résultats échoués', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[bash] Result: ERROR: command failed'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('');
    });

    test('metadata.hasToolDetails = false (mode compact)', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[bash] Result: output'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.metadata?.hasToolDetails).toBe(false);
    });
  });

  // ============================================================
  // formatMessageContent - Assistant (avec outils résumés)
  // ============================================================

  describe('formatMessageContent - Assistant message', () => {
    test('shouldRender = true pour Assistant', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: 'Assistant response'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.shouldRender).toBe(true);
    });

    test('contient le contenu texte principal', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: 'Main assistant text response'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Main assistant text response');
    });

    test('résume les appels d\'outils XML', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: 'Text before <Bash><command>ls</command></Bash> text after'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Bash');
      expect(result.content).toContain('Outils appelés');
    });

    test('préserve les blocs <thinking> dans details', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: 'Response <thinking>Reflection content here</thinking> end'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('<details>');
      expect(result.content).toContain('Réflexions');
    });

    test('compte le nombre d\'outils appelés', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: '<Bash><command>ls</command></Bash><Read><path>file.txt</path></Read>'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('2');
    });
  });

  // ============================================================
  // Structure du résultat
  // ============================================================

  describe('structure du résultat', () => {
    test('anchor est défini', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.anchor).toBeDefined();
      expect(typeof result.anchor).toBe('string');
    });

    test('messageType est défini', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.messageType).toBeDefined();
    });

    test('metadata contient messageIndex', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 5, classicOptions);
      expect(result.metadata?.messageIndex).toBe(5);
    });

    test('metadata contient contentLength', () => {
      const content = makeContent({ content: 'test content' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.metadata?.contentLength).toBe(12);
    });

    test('processingNotes mentionne "Compact"', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      const notes = result.processingNotes ?? [];
      expect(notes.some(n => n.includes('Compact'))).toBe(true);
    });

    test('processingNotes mentionne "outils résumés"', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      const notes = result.processingNotes ?? [];
      expect(notes.some(n => n.includes('résumés'))).toBe(true);
    });
  });

  // ============================================================
  // Formatage des tailles (formatContentSize) - ToolResults seulement
  // ============================================================

  describe('formatage des tailles dans ToolResults', () => {
    test('taille en octets (< 1KB)', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[tool] Result: ' + 'x'.repeat(512)
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('512 B');
    });

    test('taille en KB', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[tool] Result: ' + 'x'.repeat(2048)
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('2 KB');
    });

    test('taille en MB', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[tool] Result: ' + 'x'.repeat(2 * 1024 * 1024)
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('2 MB');
    });
  });

  // ============================================================
  // Détection du type de résultat (detectResultType)
  // ============================================================

  describe('détection du type de résultat', () => {
    test('détection "Liste fichiers"', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[browser] Result: <files>file1.txt</files>'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Liste fichiers');
    });

    test('détection "Écriture fichier"', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[write] Result: <file_write_result>success</file_write_result>'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Écriture fichier');
    });

    test('détection "Exécution commande"', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[bash] Result: Command executed successfully'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Exécution commande');
    });

    test('détection "Erreur"', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[bash] Result: ERROR: failed'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Erreur');
    });
  });

  // ============================================================
  // Lien retour table des matières
  // ============================================================

  describe('navigation', () => {
    test('contient un lien vers la table des matières', () => {
      const content = makeContent({ subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('table-des-matieres');
    });

    test('contient "^ Table des matières"', () => {
      const content = makeContent({ subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Table des matières');
    });
  });
});
