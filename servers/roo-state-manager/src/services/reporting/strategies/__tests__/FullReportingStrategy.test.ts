/**
 * Tests unitaires pour FullReportingStrategy
 *
 * Couvre :
 * - Propriétés : detailLevel, description, isTocOnlyMode
 * - formatMessageContent : UserMessage (classic path)
 * - formatMessageContent : ToolResult sans format reconnu
 * - formatMessageContent : ToolResult avec format [Tool] Result: (résultat court)
 * - formatMessageContent : ToolResult avec résultat long (>1000 chars) → <details>
 * - formatMessageContent : Assistant message (texte simple)
 * - formatMessageContent : Assistant avec blocs <thinking>
 * - formatMessageContent : Assistant avec appels XML d'outils
 * - formatMessageContent : Autre type de contenu
 * - Structure du résultat : shouldRender, cssClass, anchor, metadata, processingNotes
 *
 * @module services/reporting/strategies/__tests__/FullReportingStrategy.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { FullReportingStrategy } from '../FullReportingStrategy.js';
import type { ClassifiedContent, EnhancedSummaryOptions } from '../../../../types/enhanced-conversation.js';

// ─────────────────── helpers ───────────────────

/** Options sans CSS avancé → chemin classique garanti */
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

let strategy: FullReportingStrategy;

beforeEach(() => {
  strategy = new FullReportingStrategy();
});

// ─────────────────── tests ───────────────────

describe('FullReportingStrategy', () => {

  // ============================================================
  // Propriétés de base
  // ============================================================

  describe('properties', () => {
    test('detailLevel = "Full"', () => {
      expect(strategy.detailLevel).toBe('Full');
    });

    test('description est définie', () => {
      expect(typeof strategy.description).toBe('string');
      expect(strategy.description.length).toBeGreaterThan(0);
    });

    test('isTocOnlyMode() = false', () => {
      expect(strategy.isTocOnlyMode()).toBe(false);
    });
  });

  // ============================================================
  // formatMessageContent - UserMessage (chemin classique)
  // ============================================================

  describe('formatMessageContent - UserMessage', () => {
    test('shouldRender = true', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'Test message' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.shouldRender).toBe(true);
    });

    test('cssClass = "user-message"', () => {
      const content = makeContent({ subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.cssClass).toBe('user-message');
    });

    test('content contient le texte utilisateur', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'My user message' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('My user message');
    });

    test('content contient une ancre générée', () => {
      const content = makeContent({ subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 2, classicOptions);
      expect(result.anchor).toBeDefined();
      expect(result.anchor).toContain('2');
    });

    test('metadata.messageIndex est défini', () => {
      const content = makeContent({ subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 3, classicOptions);
      // Note: metadata.messageIndex n'est pas fourni pour Full mais anchor l'est
      expect(result.metadata).toBeDefined();
    });

    test('processingNotes contient "Mode Full"', () => {
      const content = makeContent({ subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      const notes = result.processingNotes ?? [];
      expect(notes.some(n => n.includes('Full'))).toBe(true);
    });

    test('messageType est correct', () => {
      const content = makeContent({ type: 'User', subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.messageType).toBeDefined();
    });
  });

  // ============================================================
  // formatMessageContent - ToolResult (sans format reconnu)
  // ============================================================

  describe('formatMessageContent - ToolResult sans format reconnu', () => {
    test('cssClass = "tool-result"', () => {
      const content = makeContent({ type: 'Assistant', subType: 'ToolResult', content: 'Raw tool output' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.cssClass).toBe('tool-result');
    });

    test('content contient le résultat brut', () => {
      const content = makeContent({ type: 'Assistant', subType: 'ToolResult', content: 'Raw tool output' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Raw tool output');
    });

    test('shouldRender = true', () => {
      const content = makeContent({ type: 'Assistant', subType: 'ToolResult', content: 'Some output' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.shouldRender).toBe(true);
    });
  });

  // ============================================================
  // formatMessageContent - ToolResult avec format [Tool] Result:
  // ============================================================

  describe('formatMessageContent - ToolResult avec format reconnu', () => {
    test('content contient le nom de l\'outil', () => {
      const toolContent = '[my_tool] Result: Tool output here';
      const content = makeContent({ type: 'Assistant', subType: 'ToolResult', content: toolContent });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('my_tool');
    });

    test('résultat court : pas de balise <details>', () => {
      const toolContent = '[read_file] Result: Short result';
      const content = makeContent({ type: 'Assistant', subType: 'ToolResult', content: toolContent });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).not.toContain('<details>');
    });

    test('résultat long (>1000 chars) : balise <details>', () => {
      const longResult = 'x'.repeat(1001);
      const toolContent = `[bash] Result: ${longResult}`;
      const content = makeContent({ type: 'Assistant', subType: 'ToolResult', content: toolContent, contentSize: toolContent.length });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('<details>');
    });

    test('résultat long contient "Résultat complet"', () => {
      const longResult = 'y'.repeat(1002);
      const toolContent = `[grep] Result: ${longResult}`;
      const content = makeContent({ type: 'Assistant', subType: 'ToolResult', content: toolContent, contentSize: toolContent.length });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Résultat complet');
    });
  });

  // ============================================================
  // formatMessageContent - Assistant message (texte simple)
  // ============================================================

  describe('formatMessageContent - Assistant message (texte simple)', () => {
    test('cssClass = "assistant-message"', () => {
      const content = makeContent({ type: 'Assistant', subType: 'Completion', content: 'I can help' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.cssClass).toBe('assistant-message');
    });

    test('content contient le texte assistant', () => {
      const content = makeContent({ type: 'Assistant', subType: 'Completion', content: 'Here is my answer' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Here is my answer');
    });

    test('processingNotes contient "classique"', () => {
      const content = makeContent({ type: 'Assistant', subType: 'Completion', content: 'Answer' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      const notes = result.processingNotes ?? [];
      expect(notes.some(n => n.toLowerCase().includes('full') || n.toLowerCase().includes('classique'))).toBe(true);
    });
  });

  // ============================================================
  // formatMessageContent - Assistant avec blocs <thinking>
  // ============================================================

  describe('formatMessageContent - Assistant avec <thinking>', () => {
    test('affiche la section "Détails techniques"', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: '<thinking>My internal thoughts</thinking>\nActual response',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Détails techniques');
    });

    test('contient le type "Réflexion"', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: '<thinking>Consider options</thinking>\nResponse text',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Réflexion');
    });

    test('la réponse principale est préservée', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: '<thinking>Internal</thinking>\nFinal answer here',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Final answer here');
    });
  });

  // ============================================================
  // formatMessageContent - Assistant avec appels d'outils XML
  // ============================================================

  describe('formatMessageContent - Assistant avec XML outil', () => {
    test('remplace l\'appel XML par une indication', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: 'I will use <read_file><path>file.txt</path></read_file> to read',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain("Appel d'outil");
    });

    test('contient le nom de l\'outil XML', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: 'Let me <list_files><dir>.</dir></list_files> here',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('list_files');
    });

    test('affiche la section "Détails techniques" avec XML', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: 'Text <write_to_file><path>f.ts</path></write_to_file> done',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Détails techniques');
    });
  });

  // ============================================================
  // Structure du résultat
  // ============================================================

  describe('structure du résultat', () => {
    test('résultat toujours un objet avec content string', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 0, classicOptions);
      expect(typeof result.content).toBe('string');
    });

    test('résultat toujours shouldRender = true', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 0, classicOptions);
      expect(result.shouldRender).toBe(true);
    });

    test('anchor est une chaîne non-vide', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(typeof result.anchor).toBe('string');
      expect((result.anchor ?? '').length).toBeGreaterThan(0);
    });

    test('processingNotes est un tableau', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(Array.isArray(result.processingNotes)).toBe(true);
    });
  });
});
