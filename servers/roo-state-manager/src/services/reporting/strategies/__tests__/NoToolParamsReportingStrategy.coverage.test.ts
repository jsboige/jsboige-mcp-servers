/**
 * Coverage complement for NoToolParamsReportingStrategy (#833 Sprint C3).
 *
 * ADD-ONLY companion to NoToolParamsReportingStrategy.test.ts. NoToolParams is the
 * #881 rename-twin of NoTools (identical logic), but its existing suite leaves a
 * different set of branches uncovered (76.31%B / 80.95%L). Every assertion cites a
 * line of ../NoToolParamsReportingStrategy.ts:
 *
 *  - L46-65   : Phase-4 advanced-formatter early-return path
 *               (formatWithAdvancedFormatterIfEnabled returns non-null when
 *                options.enhancementFlags.enableAdvancedCSS === true, base L253-254)
 *  - L88-91   : else fall-through for content that is neither UserMessage,
 *               ToolResult, nor Assistant
 *  - L135-140 : formatToolResult "context before result" branch
 *  - L153-160 : formatToolResult "unrecognised format" else branch
 *               (content with no `[tool] Result:` marker → raw dump)
 *  - L233-240 : detectResultType — each recognised marker + default
 *
 * The sole residual uncovered line (L188, the `: 'outil'` defensive ternary side)
 * is unreachable behind the tool-extraction regex, same as NoTools L184.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { NoToolParamsReportingStrategy } from '../NoToolParamsReportingStrategy.js';
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

let strategy: NoToolParamsReportingStrategy;

beforeEach(() => {
  strategy = new NoToolParamsReportingStrategy();
});

// ─────────────────── tests ───────────────────

describe('NoToolParamsReportingStrategy — coverage complement', () => {

  // ============================================================
  // L46-65 : advanced formatter (Phase 4) early-return path
  // ============================================================

  describe('advanced formatter path (enableAdvancedCSS)', () => {
    test('UserMessage + enableAdvancedCSS → early return with Phase 4 note (L46-65,63)', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'Advanced user text' });
      const result = strategy.formatMessageContent(content, 2, advancedOptions);
      const notes = result.processingNotes ?? [];
      expect(notes.some(n => n.includes('Phase 4 CSS avancé activé'))).toBe(true);   // L63
    });

    test('advanced branch sets shouldRender=true and hasToolDetails=false (L50,L56)', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'X' });
      const result = strategy.formatMessageContent(content, 0, advancedOptions);
      expect(result.shouldRender).toBe(true);                       // L50
      expect(result.metadata?.hasToolDetails).toBe(false);          // L56
    });

    test('classic options do NOT take the advanced branch (L46 false side)', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'classic path' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      const notes = result.processingNotes ?? [];
      expect(notes.some(n => n.includes('Phase 4'))).toBe(false);
    });
  });

  // ============================================================
  // L88-91 : else fall-through (neither UserMessage/ToolResult/Assistant)
  // ============================================================

  describe('else fall-through for other content types', () => {
    test('type=User subType=ContextCondensation → raw content pushed (L89-90)', () => {
      const content = makeContent({
        type: 'User',
        subType: 'ContextCondensation',
        content: 'RAW_PASSTHROUGH_MARKER',
      });
      const result = strategy.formatMessageContent(content, 3, classicOptions);
      expect(result.content).toContain('RAW_PASSTHROUGH_MARKER');   // L90
      expect(result.content).toContain('Table des matières');        // L95 backlink
    });
  });

  // ============================================================
  // L135-140 : formatToolResult context-before-result branch
  // ============================================================

  describe('formatToolResult — context before result', () => {
    test('text preceding [tool] Result: is kept as Contexte (L134-139)', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: 'Preceding context line\n[read_file] Result: visible body',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('**Contexte :**');            // L137
      expect(result.content).toContain('Preceding context line');    // L136-138
      // NoToolParams KEEPS the result visible — L146/L149
      expect(result.content).toContain('Cliquez pour afficher');     // L146
      expect(result.content).toContain('visible body');              // L149
    });

    test('no preceding context → no Contexte block (L135 false side)', () => {
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
  // L153-160 : formatToolResult "unrecognised format" else branch
  // ============================================================

  describe('formatToolResult — unrecognised format (no [tool] Result: marker)', () => {
    test('content without Result: marker → raw dump, no <summary> (L153-160)', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: 'Raw tool output with no result marker at all',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Raw tool output with no result marker'); // L158 raw
      expect(result.content).toContain("**Résultat d'outil**");                   // L155 (no colon)
      expect(result.content).not.toContain('Cliquez pour afficher');              // else path: no <details> summary
    });
  });

  // ============================================================
  // L233-240 : detectResultType — one case per recognised marker
  // ============================================================

  describe('detectResultType via ToolResult summary (L233-240)', () => {
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
      test(`${label} (L233-240)`, () => {
        const content = makeContent({
          type: 'Assistant',
          subType: 'ToolResult',
          content: `[some_tool] Result: ${body}`,
        });
        const result = strategy.formatMessageContent(content, 1, classicOptions);
        // resultType is interpolated into the visible <summary> at L146
        expect(result.content).toContain(expected);
      });
    }
  });
});
