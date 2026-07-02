/**
 * Coverage complement for CompactReportingStrategy (#833 Sprint C3).
 *
 * ADD-ONLY companion to CompactReportingStrategy.test.ts. The Compact mode
 * summarises tools (icon + type + size) rather than masking them, so it has an
 * error-preview path and two truncation ternaries the base suite left unexercised
 * (85.27%L / 79.59%B). Every assertion cites a line of ../CompactReportingStrategy.ts:
 *
 *  - L44-63   : Phase-4 advanced-formatter early-return path
 *  - L86-89   : else fall-through (non User/Tool/Assistant content)
 *  - L137-140 : formatToolResultSummary error-preview branch, BOTH sides of the
 *               `result.length > 200 ? '...' : ''` ternary (L140)
 *  - L142-146 : formatToolResultSummary "unrecognised format" else branch
 *  - L205-209 : formatAssistantMessageCompact thinking-preview, BOTH sides of the
 *               `content.length > 300 ? '...' : ''` ternary (L209)
 *  - L222-229 : detectResultType — each recognised marker + default
 *
 * The sole residual uncovered line (L175, the `: 'outil'` defensive ternary side)
 * is unreachable behind the tool-extraction regex.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { CompactReportingStrategy } from '../CompactReportingStrategy.js';
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

let strategy: CompactReportingStrategy;

beforeEach(() => {
  strategy = new CompactReportingStrategy();
});

// ─────────────────── tests ───────────────────

describe('CompactReportingStrategy — coverage complement', () => {

  // ============================================================
  // L44-63 : advanced formatter (Phase 4) early-return path
  // ============================================================

  describe('advanced formatter path (enableAdvancedCSS)', () => {
    test('UserMessage + enableAdvancedCSS → early return with Phase 4 note (L44-63,61)', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'Advanced user text' });
      const result = strategy.formatMessageContent(content, 2, advancedOptions);
      const notes = result.processingNotes ?? [];
      expect(notes.some(n => n.includes('Phase 4 CSS avancé activé'))).toBe(true);   // L61
      expect(notes.some(n => n.includes('Mode Compact'))).toBe(true);                // L61 first note
    });

    test('advanced branch sets shouldRender=true and hasToolDetails=false (L48,L54)', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'X' });
      const result = strategy.formatMessageContent(content, 0, advancedOptions);
      expect(result.shouldRender).toBe(true);                       // L48
      expect(result.metadata?.hasToolDetails).toBe(false);          // L54
    });

    test('classic options do NOT take the advanced branch (L44 false side)', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'classic' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      const notes = result.processingNotes ?? [];
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
      expect(result.content).toContain('RAW_PASSTHROUGH_MARKER');   // L88
      expect(result.content).toContain('Table des matières');        // L93 backlink
    });
  });

  // ============================================================
  // L137-140 : formatToolResultSummary error-preview (both ternary sides)
  // ============================================================

  describe('formatToolResultSummary — error preview', () => {
    test('short error result (<200) → preview without ellipsis (L137-140 false side)', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[bash] Result: error occurred here',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('❌');                        // L132 statusIcon
      expect(result.content).toContain('⚠️ **Erreur:**');            // L140
      expect(result.content).toContain('error occurred here');       // preview, full
      expect(result.content).not.toContain('...');                   // L140 false side (<=200)
    });

    test('long error result (>200) → preview truncated with ellipsis (L140 true side)', () => {
      const longErr = 'error: ' + 'x'.repeat(260);
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: `[bash] Result: ${longErr}`,
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('⚠️ **Erreur:**');            // L140
      expect(result.content).toContain('...');                       // L140 true side (>200)
    });

    test('success result → ✅ icon, no error preview (L131-132 success side)', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[read_file] Result: all good here',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('✅');                        // L132
      expect(result.content).not.toContain('⚠️ **Erreur:**');
    });
  });

  // ============================================================
  // L142-146 : formatToolResultSummary "unrecognised format" else branch
  // ============================================================

  describe('formatToolResultSummary — unrecognised format', () => {
    test('content without Result: marker → size-only summary (L142-146)', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: 'Raw tool output with no result marker',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain("📦 Résultat d'outil");       // L145
      expect(result.content).not.toContain('Outil :');               // matched branch not taken
    });
  });

  // ============================================================
  // L205-209 : formatAssistantMessageCompact thinking-preview (both ternary sides)
  // ============================================================

  describe('formatAssistantMessageCompact — thinking preview', () => {
    test('short thinking (<300) → preview without ellipsis (L209 false side)', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: '<thinking>brief thought</thinking>',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('💭 Réflexions (1)');          // L203
      expect(result.content).toContain('brief thought');             // L209 preview
      expect(result.content).not.toContain('...');                   // L209 false side
    });

    test('long thinking (>300) → preview truncated with ellipsis (L209 true side)', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: `<thinking>${'z'.repeat(360)}</thinking>`,
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('💭 Réflexions (1)');          // L203
      expect(result.content).toContain('...');                       // L209 true side
    });

    test('assistant with tool calls → compact tool list (L192-196)', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: 'Doing work\n<read_file><path>a.ts</path></read_file>',
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('🔧 Outils appelés (1)');      // L193
      expect(result.content).toContain('read_file');                 // L195
    });
  });

  // ============================================================
  // L222-229 : detectResultType — one case per recognised marker
  // ============================================================

  describe('detectResultType via ToolResult summary (L222-229)', () => {
    const cases: Array<[string, string, string]> = [
      ['<files> → Liste fichiers',             '<files><file>a.ts</file></files>',                       'Liste fichiers'],
      ['<file_write_result> → Écriture',       '<file_write_result><path>a</path></file_write_result>',  'Écriture fichier'],
      ['Command executed → Exécution',         'Command executed with exit code 0',                      'Exécution commande'],
      ['Browser+action → Navigation web',      'Browser session opened, action click done',              'Navigation web'],
      ['<environment_details> → Détails env',  '<environment_details>cwd=/tmp</environment_details>',    'Détails environnement'],
      ['Todo list updated → todo',             'Todo list updated successfully',                         'Mise à jour todo'],
      ['unrecognised → Résultat (default)',    'plain textual output with no marker',                    'Résultat'],
    ];

    for (const [label, body, expected] of cases) {
      test(`${label} (L222-229)`, () => {
        const content = makeContent({
          type: 'Assistant',
          subType: 'ToolResult',
          content: `[some_tool] Result: ${body}`,
        });
        const result = strategy.formatMessageContent(content, 1, classicOptions);
        // resultType is interpolated into the compact summary at L134
        expect(result.content).toContain(expected);
      });
    }
  });
});
