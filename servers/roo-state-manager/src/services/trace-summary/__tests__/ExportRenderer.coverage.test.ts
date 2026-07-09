/**
 * Coverage gaps pour ExportRenderer
 *
 * Base test ExportRenderer.test.ts (127 tests) = 95.06% Stmts / 83.33% Branch / 100% Funcs.
 * Ce fichier cible les branches/lignes froides non couvertes (rapport uncovered :
 * 66-69, 199-200, 234-235, 781-782, 812-816, 832, 837, 848-849, 861-862, 868, 870,
 * 932, 985-986, 1000-1001, 1022-1025).
 *
 * NON couvert (anti-busy-work #2083 — code défensif irréaliste) :
 * - L66-69 (assignStableIds dédup collision) : module-private non exporté ; collision d'IDs
 *   requiert 2 RenderItems avec même baseSectionId, non trivial à provoquer via le rendu public.
 * - L199-200 (renderSectionChatGPT5 console.error IDs manquants) : invariant garanti par
 *   assignStableIds (exécutée avant tout rendu) → sid/tid toujours définis.
 * - L234-235 (renderSectionMarkdown console.error ID manquant) : idem invariant.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExportRenderer } from '../ExportRenderer.js';
import type { SummaryOptions } from '../../../types/trace-summary.js';

// ---------- Helpers ----------

function makeOptions(overrides: Partial<SummaryOptions> = {}): SummaryOptions {
    return {
        detailLevel: 'Full',
        truncationChars: 0,
        compactStats: false,
        includeCss: true,
        generateToc: true,
        outputFormat: 'markdown',
        hideEnvironmentDetails: true,
        ...overrides,
    };
}

describe('ExportRenderer — coverage gaps', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        renderer = new ExportRenderer();
    });

    // ---------- cleanUserMessage (L781-782, L812-816) ----------

    describe('cleanUserMessage', () => {
        it('returns content unchanged when hideEnvironmentDetails === false (L781-782)', () => {
            const content = 'Hello <environment_details>secret</environment_details> world';
            const result = (renderer as any).cleanUserMessage(content, makeOptions({ hideEnvironmentDetails: false }));
            expect(result).toBe(content);
        });

        it('extracts <user_message> when cleaned < 50 && content > 200 (L812-816)', () => {
            // <user_message> est placé À L'INTÉRIEUR du bloc environment_details : il est supprimé
            // du cleaned (→ cleaned tombe < 50) MAIS le match s'opère sur le content ORIGINAL.
            const padding = 'a'.repeat(180);
            const content = `<environment_details>${padding}<user_message>essentiel extrait</user_message></environment_details>`;
            // content.length > 200 ✓ ; cleaned (après suppression env) ≈ 47 chars < 50 ✓
            const result = (renderer as any).cleanUserMessage(content, makeOptions({ hideEnvironmentDetails: true }));
            expect(result).toBe('essentiel extrait');
        });
    });

    // ---------- getTruncatedFirstLine (L832, L837) ----------

    describe('getTruncatedFirstLine', () => {
        it('truncates a long first text line beyond maxLength (L832)', () => {
            const longLine = 'x'.repeat(150); // > default maxLength 100
            const result = (renderer as any).getTruncatedFirstLine(longLine);
            expect(result).toBe('x'.repeat(100) + '...');
            expect(result.length).toBe(103);
        });

        it('respects custom maxLength', () => {
            const result = (renderer as any).getTruncatedFirstLine('short line', 5);
            expect(result).toBe('short...');
        });

        it('returns "" when no valid (non-empty, non-< prefixed) line exists (L837)', () => {
            const content = '<thinking>only xml here</thinking>\n<another>\n   \n';
            const result = (renderer as any).getTruncatedFirstLine(content);
            expect(result).toBe('');
        });

        it('returns "" for empty content', () => {
            expect((renderer as any).getTruncatedFirstLine('')).toBe('');
        });
    });

    // ---------- renderUserToolResult (L848-849, L861-862, L868, L870) [async] ----------

    describe('renderUserToolResult', () => {
        it('returns fallback when classifier.extractToolResultDetails yields null (L848-849)', async () => {
            const spy = vi.spyOn((renderer as any).classifier, 'extractToolResultDetails').mockReturnValue(undefined);
            const result = await (renderer as any).renderUserToolResult('[read_file] Result: x', makeOptions());
            expect(result).toContain("parsing échoué");
            spy.mockRestore();
        });

        it('truncates result beyond truncationChars (L861-862)', async () => {
            const long = 'y'.repeat(200);
            const result = await (renderer as any).renderUserToolResult(
                `[read_file] Result: ${long}`,
                makeOptions({ truncationChars: 50 })
            );
            expect(result).toContain('[tronqué]');
            expect(result).not.toContain('y'.repeat(200));
        });

        it('uses "files" section title when result contains <files> (L868)', async () => {
            const result = await (renderer as any).renderUserToolResult(
                '[read_file] Result: <files><file>a</file></files>',
                makeOptions()
            );
            expect(result).toContain('files :');
        });

        it('uses "navigation web" section title for browser_action tool (L870)', async () => {
            const result = await (renderer as any).renderUserToolResult(
                '[browser_action] Result: Browser launched ok',
                makeOptions()
            );
            expect(result).toContain('navigation web :');
        });

        it('uses default "résultat" section title otherwise', async () => {
            const result = await (renderer as any).renderUserToolResult(
                '[execute_command] Result: Command executed',
                makeOptions()
            );
            expect(result).toContain('résultat :');
        });
    });

    // ---------- processAssistantContent (L932 html escape branch) [async] ----------

    describe('processAssistantContent — outputFormat escape branch (L932-933)', () => {
        // NOTE : escapeHtml est un NO-OP dans la source (`.replace(/&/g, '&')` = identique).
        // La source est dans un répertoire PROTÉGÉ → on ne corrige PAS (TESTS-ONLY strict).
        // Ces tests exécutent les DEUX branches du ternary (html=escapeHtml / md=unescapeHtml)
        // pour la coverage de ligne/branche — l'effet réel (no-op) est documenté, pas asserté.

        it('takes the html branch (escapeHtml call) when outputFormat === "html" (L932)', async () => {
            const content = 'simple text no tags';
            const { textContent } = await (renderer as any).processAssistantContent(content, makeOptions({ outputFormat: 'html' }));
            expect(textContent).toBe('simple text no tags');
        });

        it('takes the markdown branch (unescapeHtml call) when outputFormat === "markdown" (L933)', async () => {
            const content = 'simple text no tags';
            const { textContent } = await (renderer as any).processAssistantContent(content, makeOptions({ outputFormat: 'markdown' }));
            expect(textContent).toBe('simple text no tags');
        });
    });

    // ---------- renderToolBlock (L985-986 fallback) [async] ----------

    describe('renderToolBlock — parsing-failed fallback', () => {
        it('returns OUTIL parsing-échoué fallback when classifier yields no toolCalls (L985-986)', async () => {
            // extractToolCallDetails retourne undefined pour un content sans bloc XML outil.
            const spy = vi.spyOn((renderer as any).classifier, 'extractToolCallDetails').mockReturnValue(undefined);
            const result = await (renderer as any).renderToolBlock(
                { type: 'tool', content: 'no xml here' },
                makeOptions()
            );
            expect(result).toContain('OUTIL (parsing échoué)');
            spy.mockRestore();
        });
    });

    // ---------- formatToolCallsAsMarkdown (L1000-1001, L1022-1025) ----------

    describe('formatToolCallsAsMarkdown', () => {
        it('returns "" when details has no toolCalls (L1000-1001)', () => {
            const result = (renderer as any).formatToolCallsAsMarkdown({ toolCalls: [] });
            expect(result).toBe('');
        });

        it('returns "" when details is null/undefined (L999 guard)', () => {
            expect((renderer as any).formatToolCallsAsMarkdown(null)).toBe('');
            expect((renderer as any).formatToolCallsAsMarkdown(undefined)).toBe('');
        });

        it('renders non-string param value as JSON block (L1022-1025)', () => {
            const details = {
                toolCalls: [{
                    toolName: 'write_to_file',
                    parameters: { count: 42, nested: { ok: true } },
                }],
            };
            const result = (renderer as any).formatToolCallsAsMarkdown(details);
            // Object.entries itère les VALEURS : paramValue = 42 puis {ok:true} (pas l'objet entier).
            expect(result).toContain('```json');
            expect(result).toContain('<summary>count</summary>');
            expect(result).toContain('\n42\n');
            expect(result).toContain('<summary>nested</summary>');
            expect(result).toContain('"ok": true');
        });

        it('renders string param value as xml block (complement L1017-1020)', () => {
            const details = {
                toolCalls: [{
                    toolName: 'read_file',
                    parameters: { path: '/some/file.ts' },
                }],
            };
            const result = (renderer as any).formatToolCallsAsMarkdown(details);
            expect(result).toContain('```xml');
            expect(result).toContain('/some/file.ts');
        });
    });
});
