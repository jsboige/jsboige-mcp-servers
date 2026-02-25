/**
 * Tests unitaires pour UserOnlyReportingStrategy
 *
 * Couvre :
 * - Propriétés : detailLevel, description, isTocOnlyMode
 * - formatMessageContent : UserMessage → shouldRender = true
 * - formatMessageContent : non-UserMessage (Assistant, ToolResult) → shouldRender = false
 * - formatMessageContent : UserMessage avec truncation
 * - generateTableOfContents : liste des messages utilisateur
 * - generateReport : structure de base (stats, TOC, messages)
 * - Structure du résultat : cssClass, anchor, metadata, processingNotes
 *
 * @module services/reporting/strategies/__tests__/UserOnlyReportingStrategy.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { UserOnlyReportingStrategy } from '../UserOnlyReportingStrategy.js';
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

function makeContents(): ClassifiedContent[] {
  return [
    makeContent({ type: 'User', subType: 'UserMessage', content: 'First user message', index: 0 }),
    makeContent({ type: 'Assistant', subType: 'Completion', content: 'Assistant response', index: 1 }),
    makeContent({ type: 'User', subType: 'UserMessage', content: 'Second user message', index: 2 }),
    makeContent({ type: 'Assistant', subType: 'ToolResult', content: '[bash] Result: output', index: 3 }),
  ];
}

// ─────────────────── setup ───────────────────

let strategy: UserOnlyReportingStrategy;

beforeEach(() => {
  strategy = new UserOnlyReportingStrategy();
});

// ─────────────────── tests ───────────────────

describe('UserOnlyReportingStrategy', () => {

  // ============================================================
  // Propriétés de base
  // ============================================================

  describe('properties', () => {
    test('detailLevel = "UserOnly"', () => {
      expect(strategy.detailLevel).toBe('UserOnly');
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
  // formatMessageContent - UserMessage → shouldRender = true
  // ============================================================

  describe('formatMessageContent - UserMessage', () => {
    test('shouldRender = true pour UserMessage', () => {
      const content = makeContent({ type: 'User', subType: 'UserMessage', content: 'My message' });
      const result = strategy.formatMessageContent(content, 0, classicOptions);
      expect(result.shouldRender).toBe(true);
    });

    test('cssClass = "user-message"', () => {
      const content = makeContent({ type: 'User', subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 0, classicOptions);
      expect(result.cssClass).toBe('user-message');
    });

    test('content contient le texte utilisateur', () => {
      const content = makeContent({ type: 'User', subType: 'UserMessage', content: 'Important user text' });
      const result = strategy.formatMessageContent(content, 0, classicOptions);
      expect(result.content).toContain('Important user text');
    });

    test('content contient un titre de message', () => {
      const content = makeContent({ type: 'User', subType: 'UserMessage', content: 'Message text' });
      const result = strategy.formatMessageContent(content, 2, classicOptions);
      expect(result.content).toContain('3'); // index 2 → message #3
    });

    test('anchor est défini et non-vide', () => {
      const content = makeContent({ type: 'User', subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.anchor).toBeDefined();
      expect((result.anchor ?? '').length).toBeGreaterThan(0);
    });

    test('metadata.shouldDisplay = true', () => {
      const content = makeContent({ type: 'User', subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 0, classicOptions);
      expect(result.metadata?.shouldDisplay).toBe(true);
    });
  });

  // ============================================================
  // formatMessageContent - non-UserMessage → shouldRender = false
  // ============================================================

  describe('formatMessageContent - non-UserMessage (filtré)', () => {
    test('shouldRender = false pour Assistant Completion', () => {
      const content = makeContent({ type: 'Assistant', subType: 'Completion', content: 'Response' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.shouldRender).toBe(false);
    });

    test('shouldRender = false pour ToolResult', () => {
      const content = makeContent({ type: 'Assistant', subType: 'ToolResult', content: '[bash] Result: output' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.shouldRender).toBe(false);
    });

    test('content est vide pour non-UserMessage', () => {
      const content = makeContent({ type: 'Assistant', subType: 'Completion', content: 'Should be hidden' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toBe('');
    });

    test('cssClass = "hidden-message" pour non-UserMessage', () => {
      const content = makeContent({ type: 'Assistant', subType: 'Completion', content: 'Hidden' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.cssClass).toBe('hidden-message');
    });

    test('metadata.shouldDisplay = false pour non-UserMessage', () => {
      const content = makeContent({ type: 'Assistant', subType: 'Completion', content: 'Hidden' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.metadata?.shouldDisplay).toBe(false);
    });
  });

  // ============================================================
  // formatMessageContent - UserMessage avec truncation
  // ============================================================

  describe('formatMessageContent - UserMessage avec truncation', () => {
    test('tronque si truncationChars défini et dépassé', () => {
      const longText = 'a'.repeat(500);
      const content = makeContent({ type: 'User', subType: 'UserMessage', content: longText });
      const options: EnhancedSummaryOptions = { truncationChars: 100 };
      const result = strategy.formatMessageContent(content, 0, options);
      expect(result.content).toContain('TRONQUÉ');
    });

    test('ne tronque pas si truncationChars non défini', () => {
      const longText = 'b'.repeat(500);
      const content = makeContent({ type: 'User', subType: 'UserMessage', content: longText });
      const result = strategy.formatMessageContent(content, 0, classicOptions);
      expect(result.content).not.toContain('TRONQUÉ');
    });

    test('ne tronque pas si truncationChars = 0', () => {
      const longText = 'c'.repeat(500);
      const content = makeContent({ type: 'User', subType: 'UserMessage', content: longText });
      const options: EnhancedSummaryOptions = { truncationChars: 0 };
      const result = strategy.formatMessageContent(content, 0, options);
      expect(result.content).not.toContain('TRONQUÉ');
    });

    test('ne tronque pas si contenu sous la limite', () => {
      const content = makeContent({ type: 'User', subType: 'UserMessage', content: 'Short text' });
      const options: EnhancedSummaryOptions = { truncationChars: 1000 };
      const result = strategy.formatMessageContent(content, 0, options);
      expect(result.content).not.toContain('TRONQUÉ');
    });
  });

  // ============================================================
  // generateTableOfContents
  // ============================================================

  describe('generateTableOfContents', () => {
    test('retourne une chaîne non-vide', () => {
      const result = strategy.generateTableOfContents(makeContents(), classicOptions);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    test('contient "Table des Matières"', () => {
      const result = strategy.generateTableOfContents(makeContents(), classicOptions);
      expect(result.toLowerCase()).toContain('table');
    });

    test('contient les messages utilisateur (pas les assistant)', () => {
      const result = strategy.generateTableOfContents(makeContents(), classicOptions);
      expect(result).toContain('First user message');
      expect(result).toContain('Second user message');
    });

    test('ne contient pas les messages assistant', () => {
      const result = strategy.generateTableOfContents(makeContents(), classicOptions);
      expect(result).not.toContain('Assistant response');
    });

    test('retourne un message si aucun message utilisateur', () => {
      const contents = [
        makeContent({ type: 'Assistant', subType: 'Completion', content: 'Response' }),
      ];
      const result = strategy.generateTableOfContents(contents, classicOptions);
      expect(typeof result).toBe('string');
      expect(result).toContain('Aucun');
    });
  });

  // ============================================================
  // generateReport
  // ============================================================

  describe('generateReport', () => {
    test('retourne une chaîne non-vide', () => {
      const result = strategy.generateReport(makeContents(), classicOptions);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    test('contient un titre de rapport', () => {
      const result = strategy.generateReport(makeContents(), classicOptions);
      expect(result).toMatch(/^#\s/m);
    });

    test('contient les statistiques', () => {
      const result = strategy.generateReport(makeContents(), classicOptions);
      expect(result).toContain('Statistiques');
    });

    test('contient le contenu des messages utilisateur', () => {
      const result = strategy.generateReport(makeContents(), classicOptions);
      expect(result).toContain('First user message');
      expect(result).toContain('Second user message');
    });

    test('ne contient pas les messages assistant', () => {
      const result = strategy.generateReport(makeContents(), classicOptions);
      expect(result).not.toContain('Assistant response');
    });

    test('retourne un rapport vide si pas de messages utilisateur', () => {
      const contents = [
        makeContent({ type: 'Assistant', subType: 'Completion', content: 'Response' }),
      ];
      const result = strategy.generateReport(contents, classicOptions);
      expect(typeof result).toBe('string');
      expect(result.toLowerCase()).toContain('aucun');
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

    test('metadata est défini', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 0, classicOptions);
      expect(typeof result.metadata).toBe('object');
    });
  });
});
