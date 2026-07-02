/**
 * Coverage complement for NoToolsReportingStrategy (#833 Sprint C3).
 *
 * ADD-ONLY companion to NoToolsReportingStrategy.test.ts. Targets the branches
 * left uncovered by the existing suite (84.52%L / 62.50%B), all source-grounded —
 * every assertion cites a line of ../NoToolsReportingStrategy.ts:
 *
 *  - L42-61  : Phase-4 advanced-formatter early-return path
 *              (formatWithAdvancedFormatterIfEnabled returns non-null when
 *               options.enhancementFlags.enableAdvancedCSS === true, base L253-254)
 *  - L84-87  : else fall-through for content that is neither UserMessage,
 *              ToolResult, nor Assistant
 *  - L131-136: formatToolResult "context before result" branch
 *  - L228-236: detectResultType — each recognised marker + default
 *
 * Unlike NoResultsReportingStrategy, NoTools has no getAllXmlElements/.children
 * path, so there is no unreachable region here (only the L184 `: 'outil'` defensive
 * ternary side, which the extraction regex makes unreachable, remains uncovered).
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { NoToolsReportingStrategy } from '../NoToolsReportingStrategy.js';
import type { ClassifiedContent, EnhancedSummaryOptions } from '../../../../types/enhanced-conversation.js';

// ─────────────────── helpers ───────────────────

const classicOptions: EnhancedSummaryOptions = {};
const advancedOptions: EnhancedSummaryOptions = {
  enhancementFlags: { enableAdvancedCSS: true },
};

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

let strategy: NoToolsReportingStrategy;

beforeEach(() => {
  strategy = new NoToolsReportingStrategy();
});

// ─────────────────── tests ───────────────────

describe('NoToolsReportingStrategy — coverage complement', () => {

  // ============================================================
  // L42-61 : advanced formatter (Phase 4) early-return path
  // ============================================================

  describe('advanced formatter path (enableAdvancedCSS)', () => {
    test('UserMessage + enableAdvancedCSS → early return with Phase 4 note (L42-61,59)', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'Advanced user text' });
      const result = strategy.formatMessageContent(content, 2, advancedOptions);
      const notes = result.processingNotes ?? [];
      expect(notes.some(n => n.includes('Phase 4 CSS avancé activé'))).toBe(true);   // L59
    });

    test('advanced branch sets shouldRender=true and hasToolDetails=false (L46,L52)', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'X' });
      const result = strategy.formatMessageContent(content, 0, advancedOptions);
      expect(result.shouldRender).toBe(true);                       // L46
      expect(result.metadata?.hasToolDetails).toBe(false);          // L52
    });

    test('advanced branch note mentions NoTools mode (L59 first note)', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'Y' });
      const result = strategy.formatMessageContent(content, 5, advancedOptions);
      const notes = result.processingNotes ?? [];
      expect(notes.some(n => n.includes('NoTools'))).toBe(true);    // L59 first entry
    });

    test('classic options do NOT take the advanced branch (L42 false side)', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'classic path' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      const notes = result.processingNotes ?? [];
      expect(notes.some(n => n.includes('Phase 4'))).toBe(false);
    });
  });

  // ============================================================
  // L84-87 : else fall-through (neither UserMessage/ToolResult/Assistant)
  // ============================================================

  describe('else fall-through for other content types', () => {
    test('type=User subType=ContextCondensation → raw content pushed (L85-86)', () => {
      const content = makeContent({
        type: 'User',
        subType: 'ContextCondensation',
        content: 'RAW_PASSTHROUGH_MARKER',
      });
      const result = strategy.formatMessageContent(content, 3, classicOptions);
      expect(result.content).toContain('RAW_PASSTHROUGH_MARKER');   // L86
    });

    test('else branch still wraps in a div + TOC backlink (L89-91)', () => {
      const content = makeContent({
        type: 'User',
        subType: 'NewInstructions',
        content: 'some instructions',
      });
      const result = strategy.formatMessageContent(content, 4, classicOptions);
      expect(result.content).toContain('some instructions');        // L86
      expect(result.content).toContain('Table des matières');        // L91 backlink
    });
  });

  // ============================================================
  // L131-136 : formatToolResult context-before-result branch
  // ============================================================

  describe('formatToolResult — context before result', () => {
    test('text preceding [tool] Result: is kept as Contexte (L130-135)', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: 'Preceding context line\n[read_file] Result: visible body',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('**Contexte :**');            // L133
      expect(result.content).toContain('Preceding context line');    // L132-134 (cleaned before)
      // NoTools KEEPS the result visible (unlike NoResults) — L142/L145
      expect(result.content).toContain('Cliquez pour afficher');     // L142
      expect(result.content).toContain('visible body');              // L145 result shown
    });

    test('no preceding context → no Contexte block (L131 false side)', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[bash] Result: only body',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).not.toContain('**Contexte :**');
    });
  });

  // ============================================================
  // L228-236 : detectResultType — one case per recognised marker
  // ============================================================

  describe('detectResultType via ToolResult summary (L228-236)', () => {
    const cases: Array<[string, string, string]> = [
      ['<files> → fichiers',                  '<files><file>a.ts</file></files>',                       'fichiers'],
      ['<file_write_result> → écriture',      '<file_write_result><path>a</path></file_write_result>',  'écriture fichier'],
      ['Command executed → exécution',        'Command executed with exit code 0',                      'exécution commande'],
      ['Browser+action → navigation web',     'Browser session opened, action click done',              'navigation web'],
      ['<environment_details> → environnement','<environment_details>cwd=/tmp</environment_details>',    'détails environnement'],
      ['error regex → erreur',                'operation failed unexpectedly',                          'erreur'],
      ['Todo list updated → todo',            'Todo list updated successfully',                         'mise à jour todo'],
      ['unrecognised → résultat (default)',   'plain textual output with no marker',                    'résultat'],
    ];

    for (const [label, body, expected] of cases) {
      test(`${label} (L229-236)`, () => {
        const content = makeContent({
          type: 'Assistant',
          subType: 'ToolResult',
          content: `[some_tool] Result: ${body}`,
        });
        const result = strategy.formatMessageContent(content, 1, classicOptions);
        // resultType is interpolated into the visible <summary> at L142
        expect(result.content).toContain(expected);
      });
    }
  });
});
