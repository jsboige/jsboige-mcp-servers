/**
 * Tests unitaires pour NoToolsReportingStrategy
 *
 * Couvre :
 * - Propriétés : detailLevel, description, isTocOnlyMode
 * - formatMessageContent : UserMessage
 * - formatMessageContent : ToolResult avec format [Tool] Result: (résultats NON masqués)
 * - formatMessageContent : ToolResult sans format reconnu
 * - formatMessageContent : Assistant message (texte simple)
 * - formatMessageContent : Assistant avec blocs <thinking>
 * - formatMessageContent : Assistant avec XML outils (paramètres masqués, résultats complets)
 * - Structure du résultat : shouldRender, cssClass, anchor, metadata, processingNotes
 *
 * @module services/reporting/strategies/__tests__/NoToolsReportingStrategy.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { NoToolsReportingStrategy } from '../NoToolsReportingStrategy.js';
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

let strategy: NoToolsReportingStrategy;

beforeEach(() => {
  strategy = new NoToolsReportingStrategy();
});

// ─────────────────── tests ───────────────────

describe('NoToolsReportingStrategy', () => {

  // ============================================================
  // Propriétés de base
  // ============================================================

  describe('properties', () => {
    test('detailLevel = "NoTools"', () => {
      expect(strategy.detailLevel).toBe('NoTools');
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
  // formatMessageContent - UserMessage
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
      const content = makeContent({ subType: 'UserMessage', content: 'User request here' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('User request here');
    });

    test('processingNotes contient "NoTools"', () => {
      const content = makeContent({ subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      const notes = result.processingNotes ?? [];
      expect(notes.some(n => n.includes('NoTools'))).toBe(true);
    });
  });

  // ============================================================
  // formatMessageContent - ToolResult avec format reconnu (résultats NON masqués)
  // ============================================================

  describe('formatMessageContent - ToolResult avec format reconnu', () => {
    test('shouldRender = true', () => {
      const content = makeContent({ type: 'Assistant', subType: 'ToolResult', content: '[bash] Result: output' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.shouldRender).toBe(true);
    });

    test('cssClass = "tool-result"', () => {
      const content = makeContent({ type: 'Assistant', subType: 'ToolResult', content: '[bash] Result: output' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.cssClass).toBe('tool-result');
    });

    test('contient le nom de l\'outil', () => {
      const content = makeContent({ type: 'Assistant', subType: 'ToolResult', content: '[read_file] Result: file contents' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('read_file');
    });

    test('résultat est dans un bloc <details> (non masqué)', () => {
      const content = makeContent({ type: 'Assistant', subType: 'ToolResult', content: '[grep] Result: matches found' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('<details>');
    });

    test('résultat contient le contenu réel (pas masqué)', () => {
      const content = makeContent({ type: 'Assistant', subType: 'ToolResult', content: '[cmd] Result: actual output here' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('actual output here');
    });
  });

  // ============================================================
  // formatMessageContent - ToolResult sans format reconnu
  // ============================================================

  describe('formatMessageContent - ToolResult sans format reconnu', () => {
    test('shouldRender = true', () => {
      const content = makeContent({ type: 'Assistant', subType: 'ToolResult', content: 'Raw tool output' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.shouldRender).toBe(true);
    });

    test('content contient le résultat brut', () => {
      const content = makeContent({ type: 'Assistant', subType: 'ToolResult', content: 'Raw tool output' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Raw tool output');
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

    test('shouldRender = true', () => {
      const content = makeContent({ type: 'Assistant', subType: 'Completion', content: 'Answer' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.shouldRender).toBe(true);
    });

    test('content contient le texte assistant', () => {
      const content = makeContent({ type: 'Assistant', subType: 'Completion', content: 'Here is my answer' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Here is my answer');
    });
  });

  // ============================================================
  // formatMessageContent - Assistant avec <thinking>
  // ============================================================

  describe('formatMessageContent - Assistant avec <thinking>', () => {
    test('affiche "DETAILS TECHNIQUE" pour les blocs thinking', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: '<thinking>My thoughts here</thinking>\nResponse',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('DETAILS TECHNIQUE');
    });

    test('la réponse principale est préservée', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: '<thinking>Internal</thinking>\nFinal answer',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Final answer');
    });
  });

  // ============================================================
  // formatMessageContent - Assistant avec XML outil (paramètres masqués)
  // ============================================================

  describe('formatMessageContent - Assistant avec XML outil', () => {
    test('paramètres masqués en mode NoTools', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: 'I will use <read_file><path>file.txt</path></read_file> to read',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content.toLowerCase()).toContain('masqué');
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

    test('contient "mode NoTools" dans le texte masqué', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: 'Text <write_to_file><path>f.ts</path></write_to_file> done',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('NoTools');
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

    test('metadata est défini', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(typeof result.metadata).toBe('object');
    });
  });
});
