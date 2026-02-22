/**
 * Tests unitaires pour SummaryReportingStrategy
 *
 * Couvre :
 * - Propriétés : detailLevel, description, isTocOnlyMode (= true)
 * - formatMessageContent : shouldRender = false (mode TOC-only)
 * - generateTableOfContents : UserMessage, ToolResult, Assistant
 * - generateReport : structure de base (stats, TOC, instruction initiale)
 * - Structure du résultat : shouldRender=false, cssClass, anchor, metadata
 *
 * @module services/reporting/strategies/__tests__/SummaryReportingStrategy.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { SummaryReportingStrategy } from '../SummaryReportingStrategy.js';
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
    makeContent({ type: 'User', subType: 'UserMessage', content: 'Initial task instruction', index: 0 }),
    makeContent({ type: 'User', subType: 'UserMessage', content: 'Second user message', index: 1 }),
    makeContent({ type: 'Assistant', subType: 'Completion', content: 'Assistant response', index: 2 }),
    makeContent({ type: 'Assistant', subType: 'ToolResult', content: '[bash] Result: cmd output', index: 3 }),
  ];
}

// ─────────────────── setup ───────────────────

let strategy: SummaryReportingStrategy;

beforeEach(() => {
  strategy = new SummaryReportingStrategy();
});

// ─────────────────── tests ───────────────────

describe('SummaryReportingStrategy', () => {

  // ============================================================
  // Propriétés de base
  // ============================================================

  describe('properties', () => {
    test('detailLevel = "Summary"', () => {
      expect(strategy.detailLevel).toBe('Summary');
    });

    test('description est définie', () => {
      expect(typeof strategy.description).toBe('string');
      expect(strategy.description.length).toBeGreaterThan(0);
    });

    test('isTocOnlyMode() = true (TOC-only mode)', () => {
      expect(strategy.isTocOnlyMode()).toBe(true);
    });
  });

  // ============================================================
  // formatMessageContent - shouldRender = false (TOC-only)
  // ============================================================

  describe('formatMessageContent - mode TOC-only', () => {
    test('shouldRender = false pour UserMessage', () => {
      const content = makeContent({ subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.shouldRender).toBe(false);
    });

    test('shouldRender = false pour ToolResult', () => {
      const content = makeContent({ type: 'Assistant', subType: 'ToolResult', content: '[bash] Result: output' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.shouldRender).toBe(false);
    });

    test('shouldRender = false pour Assistant', () => {
      const content = makeContent({ type: 'Assistant', subType: 'Completion', content: 'Response' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.shouldRender).toBe(false);
    });

    test('content est vide (pas de rendu individuel)', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'Should not appear' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toBe('');
    });

    test('metadata.shouldDisplay = false', () => {
      const content = makeContent({ subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.metadata?.shouldDisplay).toBe(false);
    });

    test('processingNotes contient "Summary"', () => {
      const content = makeContent({ subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      const notes = result.processingNotes ?? [];
      expect(notes.some(n => n.includes('Summary'))).toBe(true);
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

    test('contient "SOMMAIRE" ou "matières"', () => {
      const result = strategy.generateTableOfContents(makeContents(), classicOptions);
      expect(result.toLowerCase()).toMatch(/sommaire|mati/);
    });

    test('contient "Instruction de tâche initiale"', () => {
      const result = strategy.generateTableOfContents(makeContents(), classicOptions);
      expect(result).toContain('Instruction de tâche initiale');
    });

    test('contient une mention pour les messages utilisateur', () => {
      const result = strategy.generateTableOfContents(makeContents(), classicOptions);
      expect(result.toUpperCase()).toContain('UTILISATEUR');
    });

    test('contient une mention pour les messages assistant', () => {
      const result = strategy.generateTableOfContents(makeContents(), classicOptions);
      expect(result.toUpperCase()).toContain('ASSISTANT');
    });

    test('contient une mention pour les résultats d\'outils', () => {
      const result = strategy.generateTableOfContents(makeContents(), classicOptions);
      expect(result.toUpperCase()).toContain('OUTIL');
    });

    test('avec sourceFilePath : inclut le chemin dans les liens', () => {
      const result = strategy.generateTableOfContents(makeContents(), classicOptions, '/path/to/trace.json');
      expect(result).toContain('/path/to/trace.json');
    });

    test('retourne du contenu même si contents est vide', () => {
      const result = strategy.generateTableOfContents([], classicOptions);
      expect(typeof result).toBe('string');
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

    test('contient le nombre de messages', () => {
      const contents = makeContents();
      const result = strategy.generateReport(contents, classicOptions);
      expect(result).toContain(String(contents.length));
    });

    test('contient "INSTRUCTION DE TACHE INITIALE"', () => {
      const result = strategy.generateReport(makeContents(), classicOptions);
      expect(result.toUpperCase()).toContain('INSTRUCTION');
    });

    test('contient le contenu du premier message utilisateur', () => {
      const result = strategy.generateReport(makeContents(), classicOptions);
      expect(result).toContain('Initial task instruction');
    });

    test('avec sourceFilePath : inclut le nom du fichier', () => {
      const result = strategy.generateReport(makeContents(), classicOptions, '/path/trace.json');
      expect(result).toContain('trace.json');
    });

    test('retourne un rapport minimal si contents est vide', () => {
      const result = strategy.generateReport([], classicOptions);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // Structure du résultat de formatMessageContent
  // ============================================================

  describe('structure du résultat', () => {
    test('résultat toujours un objet avec content string', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 0, classicOptions);
      expect(typeof result.content).toBe('string');
    });

    test('anchor est défini', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.anchor).toBeDefined();
    });

    test('metadata est défini', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(typeof result.metadata).toBe('object');
    });

    test('processingNotes est un tableau', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(Array.isArray(result.processingNotes)).toBe(true);
    });
  });
});
