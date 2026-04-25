import { describe, it, expect, beforeEach } from 'vitest';
import { ExportRenderer, escapeHtml, unescapeHtml, sanitizeSectionHtml } from '../../../../src/services/trace-summary/ExportRenderer.js';
import { ConversationSkeleton } from '../../../../src/types/conversation.js';
import { SummaryOptions, SummaryStatistics } from '../../../../src/types/trace-summary.js';

describe('ExportRenderer', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        renderer = new ExportRenderer();
    });

    describe('escapeHtml', () => {
        it('should return input unchanged for plain text', () => {
            expect(escapeHtml('hello world')).toBe('hello world');
        });

        it('should return input unchanged for text with special chars', () => {
            const input = '<div class="x">A & B</div>';
            expect(escapeHtml(input)).toBe(input);
        });

        it('should handle empty string', () => {
            expect(escapeHtml('')).toBe('');
        });
    });

    describe('unescapeHtml', () => {
        it('should return input unchanged for plain text', () => {
            expect(unescapeHtml('plain text')).toBe('plain text');
        });

        it('should return input unchanged for HTML entities', () => {
            expect(unescapeHtml('&lt;div&gt;')).toBe('&lt;div&gt;');
        });

        it('should handle empty string', () => {
            expect(unescapeHtml('')).toBe('');
        });

        it('should be inverse of escapeHtml (identity round-trip)', () => {
            const original = '<div class="test">A & B</div>';
            expect(unescapeHtml(escapeHtml(original))).toBe(original);
        });
    });

    describe('sanitizeSectionHtml', () => {
        it('should balance unclosed code fences', () => {
            const result = sanitizeSectionHtml('```\ncode here');
            const fenceCount = (result.match(/^```/gm) || []).length;
            expect(fenceCount % 2).toBe(0);
        });

        it('should balance unclosed details tags', () => {
            const result = sanitizeSectionHtml('<details>\ncontent\n');
            expect(result.match(/<\/details>/g)).not.toBeNull();
        });

        it('should normalize excessive whitespace', () => {
            const result = sanitizeSectionHtml('line1\n\n\n\n\nline2');
            expect(result).not.toContain('\n\n\n');
        });

        it('should deduplicate identical first/second lines', () => {
            const result = sanitizeSectionHtml('Title\nTitle\nContent');
            const lines = result.split('\n');
            expect(lines.length).toBeLessThan(3);
        });

        it('should not deduplicate different first/second lines', () => {
            const input = 'Title\nDifferent\nContent';
            const result = sanitizeSectionHtml(input);
            expect(result).toContain('Different');
        });

        it('should handle empty input', () => {
            const result = sanitizeSectionHtml('');
            expect(result).toBeDefined();
        });

        it('should de-indent details tags', () => {
            const result = sanitizeSectionHtml('    <details>\n    </details>');
            expect(result).not.toMatch(/^\s+<details>/m);
        });

        it('should leave balanced fences untouched', () => {
            const input = '```\ncode\n```';
            const result = sanitizeSectionHtml(input);
            expect(result).toContain('```');
        });
    });

    describe('generateHeader', () => {
        it('should generate header with correct information', () => {
            const conversation: ConversationSkeleton = {
                taskId: 'test-task',
                metadata: {
                    totalSize: 1024,
                    createdAt: 0,
                    lastActivity: 0
                } as any,
                sequence: []
            };
            const options: SummaryOptions = {} as any;

            const header = renderer.generateHeader(conversation, options);
            expect(header).toContain('# RESUME DE TRACE D\'ORCHESTRATION ROO');
            expect(header).toContain('**Taille source :** 1 KB');
        });

        it('should include generation date', () => {
            const conversation: ConversationSkeleton = {
                taskId: 'test-task',
                metadata: {
                    totalSize: 2048,
                    createdAt: 0,
                    lastActivity: 0
                } as any,
                sequence: []
            };
            const header = renderer.generateHeader(conversation, {} as any);
            expect(header).toContain('**Date de generation :**');
        });

        it('should format large sizes correctly', () => {
            const conversation: ConversationSkeleton = {
                taskId: 'test-task',
                metadata: {
                    totalSize: 1024 * 1024,
                    createdAt: 0,
                    lastActivity: 0
                } as any,
                sequence: []
            };
            const header = renderer.generateHeader(conversation, {} as any);
            expect(header).toContain('**Taille source :** 1024 KB');
        });
    });

    describe('generateMetadata', () => {
        it('should include total content size', () => {
            const conversation: ConversationSkeleton = {
                taskId: 'test-task',
                metadata: { totalSize: 0, createdAt: 0, lastActivity: 0 } as any,
                sequence: []
            };
            const statistics: SummaryStatistics = {
                totalContentSize: 2048,
                totalSections: 10,
                userMessages: 5,
                assistantMessages: 3,
                toolResults: 2,
                userPercentage: 50,
                assistantPercentage: 30,
                toolResultsPercentage: 20,
                userContentSize: 1024,
                assistantContentSize: 512,
                toolResultsSize: 512
            } as any;

            const meta = renderer.generateMetadata(conversation, statistics);
            expect(meta).toContain('**Taille totale du contenu :**');
            expect(meta).toContain('**Nombre total d\'échanges :** 10');
        });

        it('should include creation and last activity dates', () => {
            const conversation: ConversationSkeleton = {
                taskId: 'test-task',
                metadata: {
                    totalSize: 0,
                    createdAt: new Date('2026-01-01').getTime(),
                    lastActivity: new Date('2026-04-25').getTime()
                } as any,
                sequence: []
            };
            const statistics = {
                totalContentSize: 0, totalSections: 0,
                userMessages: 0, assistantMessages: 0, toolResults: 0,
                userPercentage: 0, assistantPercentage: 0, toolResultsPercentage: 0,
                userContentSize: 0, assistantContentSize: 0, toolResultsSize: 0
            } as SummaryStatistics;

            const meta = renderer.generateMetadata(conversation, statistics);
            expect(meta).toContain('**Créé le :**');
            expect(meta).toContain('**Dernière activité :**');
        });
    });

    describe('generateEmbeddedCss', () => {
        it('should return CSS wrapped in style tag', () => {
            const css = renderer.generateEmbeddedCss();
            expect(css).toMatch(/^<style/);
            expect(css).toContain('</style>');
        });

        it('should include TOC CSS variables', () => {
            const css = renderer.generateEmbeddedCss();
            expect(css).toContain('--toc-user');
            expect(css).toContain('--toc-assistant');
            expect(css).toContain('--toc-tool');
        });

        it('should include message type classes', () => {
            const css = renderer.generateEmbeddedCss();
            expect(css).toContain('.user-message');
            expect(css).toContain('.assistant-message');
            expect(css).toContain('.tool-message');
            expect(css).toContain('.error-message');
        });
    });

    describe('generateStatistics', () => {
        const baseStats: SummaryStatistics = {
            totalContentSize: 10240,
            totalSections: 20,
            userMessages: 8,
            assistantMessages: 7,
            toolResults: 5,
            userPercentage: 40,
            assistantPercentage: 35,
            toolResultsPercentage: 25,
            userContentSize: 4096,
            assistantContentSize: 3584,
            toolResultsSize: 2560
        } as any;

        it('should generate compact statistics', () => {
            const result = renderer.generateStatistics(baseStats, true);
            expect(result).toContain('## STATISTIQUES');
            expect(result).toContain('Messages User');
            expect(result).toContain('Reponses Assistant');
            expect(result).toContain('Resultats d\'outils');
            expect(result).toContain('| 8 |');
            expect(result).toContain('40.0%');
        });

        it('should generate detailed statistics', () => {
            const result = renderer.generateStatistics(baseStats, false);
            expect(result).toContain('## STATISTIQUES DETAILLEES');
            expect(result).toContain('Taille');
            expect(result).toContain('4 KB');
        });

        it('should show 100% for total in compact mode', () => {
            const result = renderer.generateStatistics(baseStats, true);
            expect(result).toContain('| 20 |');
            expect(result).toContain('100%');
        });
    });

    describe('generateFooter', () => {
        it('should contain footer marker', () => {
            const footer = renderer.generateFooter({} as any);
            expect(footer).toContain('---');
            expect(footer).toContain('Roo State Manager');
        });
    });

    describe('ensureSingleCss', () => {
        it('should prepend CSS when no style block exists', () => {
            const html = '<p>content</p>';
            const result = renderer.ensureSingleCss(html);
            expect(result).toContain('<style id="trace-summary-styles">');
            expect(result).toContain('<p>content</p>');
        });

        it('should keep single CSS block unchanged', () => {
            const css = renderer.generateEmbeddedCss();
            const html = css + '\n\n<p>content</p>';
            const result = renderer.ensureSingleCss(html);
            expect(result).toBe(html);
        });

        it('should deduplicate multiple CSS blocks', () => {
            const css = renderer.generateEmbeddedCss();
            const html = css + '\n\n<p>a</p>\n\n' + css + '\n\n<p>b</p>';
            const result = renderer.ensureSingleCss(html);
            const styleCount = (result.match(/<style id="trace-summary-styles">/g) || []).length;
            expect(styleCount).toBe(1);
            expect(result).toContain('<p>a</p>');
            expect(result).toContain('<p>b</p>');
        });
    });
});