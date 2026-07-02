/**
 * Coverage complement for NoResultsReportingStrategy (#833 Sprint C3).
 *
 * ADD-ONLY companion to NoResultsReportingStrategy.test.ts. Targets the branches
 * left uncovered by the existing suite (75.77%L / 59.45%B), all source-grounded —
 * every assertion cites a line of ../NoResultsReportingStrategy.ts:
 *
 *  - L44-63  : Phase-4 advanced-formatter early-return path
 *              (formatWithAdvancedFormatterIfEnabled returns non-null when
 *               options.enhancementFlags.enableAdvancedCSS === true, base L253-254)
 *  - L86-89  : else fall-through for content that is neither UserMessage,
 *              ToolResult, nor Assistant
 *  - L133-138: formatToolResult "context before result" branch
 *  - L311-319: detectResultType — each recognised marker + default
 *
 * NOTE (finding, not covered here): the intended per-element rendering in
 * formatXmlToolBlock (L262-273) / getAllXmlElements (L292-306) is UNREACHABLE with
 * @xmldom/xmldom@0.8.11 — parsed Elements expose only `.childNodes`, never
 * `.children`, so `node.children.length` (L295) throws on every real XML block and
 * the code silently falls back to the "[Format simple]" branch (L277-283, already
 * covered by the base suite). Covering L262-305 would require a source fix, which is
 * out of scope for this tests-only PR. Reported separately for arbitration.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { NoResultsReportingStrategy } from '../NoResultsReportingStrategy.js';
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

let strategy: NoResultsReportingStrategy;

beforeEach(() => {
  strategy = new NoResultsReportingStrategy();
});

// ─────────────────── tests ───────────────────

describe('NoResultsReportingStrategy — coverage complement', () => {

  // ============================================================
  // L44-63 : advanced formatter (Phase 4) early-return path
  // ============================================================

  describe('advanced formatter path (enableAdvancedCSS)', () => {
    test('UserMessage + enableAdvancedCSS → early return with Phase 4 note (L44-63,61)', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'Advanced user text' });
      const result = strategy.formatMessageContent(content, 2, advancedOptions);
      // processingNotes second entry is pushed only on the advanced branch (L61)
      const notes = result.processingNotes ?? [];
      expect(notes.some(n => n.includes('Phase 4 CSS avancé activé'))).toBe(true);
    });

    test('advanced branch sets shouldRender=true and hasToolDetails=false (L48,L54)', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'X' });
      const result = strategy.formatMessageContent(content, 0, advancedOptions);
      expect(result.shouldRender).toBe(true);                       // L48
      expect(result.metadata?.hasToolDetails).toBe(false);          // L54
    });

    test('advanced branch exposes anchor + messageType in metadata (L56-59)', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'Y' });
      const result = strategy.formatMessageContent(content, 5, advancedOptions);
      expect(typeof result.anchor).toBe('string');                  // L59 (top-level anchor)
      expect((result.anchor ?? '').length).toBeGreaterThan(0);
      expect(typeof result.metadata?.messageType).toBe('string');   // L59 (metadata.messageType)
    });

    test('classic options do NOT take the advanced branch (L44 false side)', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'classic path' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      const notes = result.processingNotes ?? [];
      // classic branch pushes only the single NoResults note (no Phase 4 note)
      expect(notes.some(n => n.includes('Phase 4'))).toBe(false);
    });
  });

  // ============================================================
  // L86-89 : else fall-through (neither UserMessage/ToolResult/Assistant)
  // ============================================================

  describe('else fall-through for other content types', () => {
    test('type=User subType=ContextCondensation → raw content pushed (L87-88)', () => {
      const content = makeContent({
        type: 'User',
        subType: 'ContextCondensation',
        content: 'RAW_PASSTHROUGH_MARKER',
      });
      const result = strategy.formatMessageContent(content, 3, classicOptions);
      // L88: formattedContent.push(content.content) — the raw content is emitted verbatim
      expect(result.content).toContain('RAW_PASSTHROUGH_MARKER');
    });

    test('else branch still wraps in a NoResults div + TOC backlink (L91-93)', () => {
      const content = makeContent({
        type: 'User',
        subType: 'NewInstructions',
        content: 'some instructions',
      });
      const result = strategy.formatMessageContent(content, 4, classicOptions);
      expect(result.content).toContain('some instructions');       // L88
      expect(result.content).toContain('Table des matières');       // L93 backlink
    });
  });

  // ============================================================
  // L133-138 : formatToolResult context-before-result branch
  // ============================================================

  describe('formatToolResult — context before result', () => {
    test('text preceding [tool] Result: is kept as Contexte (L132-137)', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: 'Preceding context line\n[read_file] Result: hidden body',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('**Contexte :**');           // L135
      expect(result.content).toContain('Preceding context line');   // L134-136 (cleaned before)
      // result body itself remains masked in NoResults mode (L144)
      expect(result.content.toLowerCase()).toContain('masqué');
    });

    test('no preceding context → no Contexte block (L133 false side)', () => {
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
  // L311-319 : detectResultType — one case per recognised marker
  // ============================================================

  describe('detectResultType via masked ToolResult summary (L311-319)', () => {
    const cases: Array<[string, string, string]> = [
      // [label, result body containing the marker, expected type word in summary]
      ['<files> → fichiers',                 '<files><file>a.ts</file></files>',            'fichiers'],
      ['<file_write_result> → écriture',     '<file_write_result><path>a</path></file_write_result>', 'écriture fichier'],
      ['Command executed → exécution',       'Command executed with exit code 0',           'exécution commande'],
      ['Browser+action → navigation web',    'Browser session opened, action click done',   'navigation web'],
      ['<environment_details> → environnement','<environment_details>cwd=/tmp</environment_details>', 'détails environnement'],
      ['error regex → erreur',               'operation failed unexpectedly',               'erreur'],
      ['Todo list updated → todo',           'Todo list updated successfully',              'mise à jour todo'],
      ['unrecognised → résultat (default)',  'plain textual output with no marker',         'résultat'],
    ];

    for (const [label, body, expected] of cases) {
      test(`${label} (L312-319)`, () => {
        const content = makeContent({
          type: 'Assistant',
          subType: 'ToolResult',
          content: `[some_tool] Result: ${body}`,
        });
        const result = strategy.formatMessageContent(content, 1, classicOptions);
        // resultType is interpolated into the masked <summary> at L144
        expect(result.content).toContain(expected);
        expect(result.content.toLowerCase()).toContain('masqué');
      });
    }
  });
});
