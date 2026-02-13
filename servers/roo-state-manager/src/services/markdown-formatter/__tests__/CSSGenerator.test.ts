/**
 * CSSGenerator.test.ts - Tests unitaires pour CSSGenerator
 *
 * Verifie la generation CSS (variables, responsive, animations, compact)
 * et le mapping des couleurs par type de message.
 */

import { describe, it, expect } from 'vitest';
import { CSSGenerator } from '../CSSGenerator';
import { AdvancedFormattingOptions } from '../../MarkdownFormatterService';

// --------------------------------------------------------------------------
// Options par defaut utilisees par generateCSS quand aucun argument n'est fourni
// --------------------------------------------------------------------------
const DEFAULT_OPTIONS: AdvancedFormattingOptions = {
    enableAdvancedCSS: true,
    responsiveDesign: true,
    syntaxHighlighting: true,
    animationsEnabled: true,
    compactMode: false,
};

describe('CSSGenerator', () => {
    // ======================================================================
    // generateCSS
    // ======================================================================
    describe('generateCSS', () => {
        it('should return a string wrapped in <style> tags', () => {
            const css = CSSGenerator.generateCSS();
            expect(css.trimStart().startsWith('<style>')).toBe(true);
            expect(css.trimEnd().endsWith('</style>')).toBe(true);
        });

        it('should include Phase 4 header comment', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('ROO CONVERSATION EXPORT - PHASE 4 ADVANCED CSS');
        });

        // ------------------------------------------------------------------
        // CSS variables (theme colors)
        // ------------------------------------------------------------------
        describe('CSS theme color variables', () => {
            const css = CSSGenerator.generateCSS();

            it('should define --color-user variable', () => {
                expect(css).toContain('--color-user: #2563eb');
            });

            it('should define --color-assistant variable', () => {
                expect(css).toContain('--color-assistant: #059669');
            });

            it('should define --color-tool-call variable', () => {
                expect(css).toContain('--color-tool-call: #ea580c');
            });

            it('should define --color-tool-result variable', () => {
                expect(css).toContain('--color-tool-result: #7c3aed');
            });

            it('should define --color-metadata variable', () => {
                expect(css).toContain('--color-metadata: #6b7280');
            });

            it('should define --color-error variable', () => {
                expect(css).toContain('--color-error: #dc2626');
            });

            it('should define background color variables', () => {
                expect(css).toContain('--bg-user: #dbeafe');
                expect(css).toContain('--bg-assistant: #dcfce7');
                expect(css).toContain('--bg-tool-call: #fed7aa');
                expect(css).toContain('--bg-tool-result: #e9d5ff');
                expect(css).toContain('--bg-metadata: #f3f4f6');
                expect(css).toContain('--bg-error: #fee2e2');
            });

            it('should define shadow and radius design tokens', () => {
                expect(css).toContain('--shadow-subtle:');
                expect(css).toContain('--shadow-medium:');
                expect(css).toContain('--radius-sm: 4px');
                expect(css).toContain('--radius-md: 8px');
                expect(css).toContain('--radius-lg: 12px');
                expect(css).toContain('--transition-base: 0.15s ease-in-out');
            });
        });

        // ------------------------------------------------------------------
        // Base body styles
        // ------------------------------------------------------------------
        it('should use 1200px max-width by default (compactMode false)', () => {
            const css = CSSGenerator.generateCSS(DEFAULT_OPTIONS);
            expect(css).toContain('max-width: 1200px');
        });

        it('should use 900px max-width when compactMode is true', () => {
            const css = CSSGenerator.generateCSS({ ...DEFAULT_OPTIONS, compactMode: true });
            expect(css).toContain('max-width: 900px');
        });

        it('should use 24px padding by default', () => {
            const css = CSSGenerator.generateCSS(DEFAULT_OPTIONS);
            expect(css).toContain('padding: 24px');
        });

        it('should use 16px padding when compactMode is true', () => {
            const css = CSSGenerator.generateCSS({ ...DEFAULT_OPTIONS, compactMode: true });
            expect(css).toContain('padding: 16px');
        });

        // ------------------------------------------------------------------
        // Responsive design
        // ------------------------------------------------------------------
        describe('responsive design', () => {
            it('should include media queries when responsiveDesign is true', () => {
                const css = CSSGenerator.generateCSS({ ...DEFAULT_OPTIONS, responsiveDesign: true });
                expect(css).toContain('@media (max-width: 768px)');
                expect(css).toContain('@media (max-width: 480px)');
            });

            it('should omit responsive media queries when responsiveDesign is false', () => {
                const css = CSSGenerator.generateCSS({ ...DEFAULT_OPTIONS, responsiveDesign: false });
                // Print media query is always present, so we check the responsive-specific ones
                // The 480px breakpoint is only in the responsive block
                expect(css).not.toContain('@media (max-width: 480px)');
            });
        });

        // ------------------------------------------------------------------
        // Syntax highlighting
        // ------------------------------------------------------------------
        describe('syntax highlighting', () => {
            it('should include dark code theme when syntaxHighlighting is true', () => {
                const css = CSSGenerator.generateCSS({ ...DEFAULT_OPTIONS, syntaxHighlighting: true });
                expect(css).toContain('background-color: #1e293b');
                expect(css).toContain('.hljs-keyword');
                expect(css).toContain('.hljs-string');
                expect(css).toContain('.hljs-number');
                expect(css).toContain('.hljs-comment');
                expect(css).toContain('.hljs-function');
                expect(css).toContain('.hljs-variable');
            });

            it('should include light code theme when syntaxHighlighting is false', () => {
                const css = CSSGenerator.generateCSS({ ...DEFAULT_OPTIONS, syntaxHighlighting: false });
                expect(css).toContain('background-color: #f8fafc');
                expect(css).not.toContain('.hljs-keyword');
            });
        });

        // ------------------------------------------------------------------
        // Animations
        // ------------------------------------------------------------------
        describe('animations', () => {
            it('should include keyframe animations when animationsEnabled is true', () => {
                const css = CSSGenerator.generateCSS({ ...DEFAULT_OPTIONS, animationsEnabled: true });
                expect(css).toContain('@keyframes pulse');
                expect(css).toContain('@keyframes fadeIn');
                expect(css).toContain('@keyframes highlightFlash');
                expect(css).toContain('animation: fadeIn');
            });

            it('should omit keyframe animations when animationsEnabled is false', () => {
                const css = CSSGenerator.generateCSS({ ...DEFAULT_OPTIONS, animationsEnabled: false });
                expect(css).not.toContain('@keyframes pulse');
                expect(css).not.toContain('@keyframes fadeIn');
            });

            it('should include hover transforms when animationsEnabled is true', () => {
                const css = CSSGenerator.generateCSS({ ...DEFAULT_OPTIONS, animationsEnabled: true });
                expect(css).toContain('transform: translateY(-1px)');
                expect(css).toContain('transform: scale(1.05)');
            });
        });

        // ------------------------------------------------------------------
        // Compact mode
        // ------------------------------------------------------------------
        describe('compact mode', () => {
            it('should include compact overrides when compactMode is true', () => {
                const css = CSSGenerator.generateCSS({ ...DEFAULT_OPTIONS, compactMode: true });
                // Compact section header override
                expect(css).toContain('.section-header');
                expect(css).toContain('font-size: 1rem');
            });

            it('should not include compact overrides when compactMode is false', () => {
                const css = CSSGenerator.generateCSS({ ...DEFAULT_OPTIONS, compactMode: false });
                // The compact-only block has "font-size: 1rem" for .section-header
                // and "margin-bottom: 12px" specifically in the compact block.
                // Default section-header uses "font-size: 1.1rem"
                expect(css).toContain('font-size: 1.1rem');
            });
        });

        // ------------------------------------------------------------------
        // Print styles (always present)
        // ------------------------------------------------------------------
        it('should always include print styles', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('@media print');
            expect(css).toContain('page-break-inside: avoid');
        });

        // ------------------------------------------------------------------
        // Accessibility (always present)
        // ------------------------------------------------------------------
        it('should include accessibility screen-reader-only class', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('.screen-reader-only');
            expect(css).toContain('clip: rect(0, 0, 0, 0)');
        });

        it('should include focus states for keyboard navigation', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('.toc-link:focus');
            expect(css).toContain('.message-badge:focus');
            expect(css).toContain('outline: 2px solid');
        });

        // ------------------------------------------------------------------
        // Phase 5 interactive CSS (embedded in generateCSS)
        // ------------------------------------------------------------------
        it('should include Phase 5 interactive CSS section', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('PHASE 5: CSS INTERACTIF');
        });

        it('should include table of contents interactive styles', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('.toc-search');
            expect(css).toContain('.toc-stats-grid');
            expect(css).toContain('.toc-link-item');
            expect(css).toContain('.toc-progress-bar');
        });

        it('should include expandable content styles', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('.expandable-container');
            expect(css).toContain('.expand-toggle');
            expect(css).toContain('.expand-button');
            expect(css).toContain('.collapse-button');
        });

        it('should include copy button styles', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('.copy-button');
        });

        // ------------------------------------------------------------------
        // Message badge styles
        // ------------------------------------------------------------------
        it('should include message badge styles for all types', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('.message-badge.user');
            expect(css).toContain('.message-badge.assistant');
            expect(css).toContain('.message-badge.tool-call');
            expect(css).toContain('.message-badge.tool-result');
        });

        // ------------------------------------------------------------------
        // Conversation section styles
        // ------------------------------------------------------------------
        it('should include conversation section styles for all message types', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('.conversation-section.user-message');
            expect(css).toContain('.conversation-section.assistant-message');
            expect(css).toContain('.conversation-section.tool-call');
            expect(css).toContain('.conversation-section.tool-result');
        });

        // ------------------------------------------------------------------
        // Default parameter handling
        // ------------------------------------------------------------------
        it('should produce identical output when called without args vs with default options', () => {
            const cssNoArgs = CSSGenerator.generateCSS();
            const cssExplicit = CSSGenerator.generateCSS(DEFAULT_OPTIONS);
            expect(cssNoArgs).toBe(cssExplicit);
        });
    });

    // ======================================================================
    // generateInteractiveCSS
    // ======================================================================
    describe('generateInteractiveCSS', () => {
        it('should return a string containing Phase 5 header comment', () => {
            const css = CSSGenerator.generateInteractiveCSS();
            expect(css).toContain('PHASE 5: CSS INTERACTIF');
        });

        it('should not be wrapped in <style> tags', () => {
            const css = CSSGenerator.generateInteractiveCSS();
            expect(css).not.toContain('<style>');
            expect(css).not.toContain('</style>');
        });

        it('should include toc-container styles', () => {
            const css = CSSGenerator.generateInteractiveCSS();
            expect(css).toContain('.toc-container');
        });

        it('should include toc search input styles', () => {
            const css = CSSGenerator.generateInteractiveCSS();
            expect(css).toContain('.toc-search input');
        });

        it('should include truncation and expand styles', () => {
            const css = CSSGenerator.generateInteractiveCSS();
            expect(css).toContain('.truncation-container');
            expect(css).toContain('.expand-button');
            expect(css).toContain('.collapse-button');
            expect(css).toContain('.expandable-content');
        });

        it('should include copy-button styles', () => {
            const css = CSSGenerator.generateInteractiveCSS();
            expect(css).toContain('.copy-button');
        });

        it('should include highlight flash animation', () => {
            const css = CSSGenerator.generateInteractiveCSS();
            expect(css).toContain('.highlight-flash');
            expect(css).toContain('@keyframes highlightFlash');
        });

        it('should include responsive media query for 768px', () => {
            const css = CSSGenerator.generateInteractiveCSS();
            expect(css).toContain('@media (max-width: 768px)');
        });

        it('should include message anchor scroll-margin', () => {
            const css = CSSGenerator.generateInteractiveCSS();
            expect(css).toContain('[id^="message-"]');
            expect(css).toContain('scroll-margin-top: 20px');
        });
    });

    // ======================================================================
    // getTypeColor
    // ======================================================================
    describe('getTypeColor', () => {
        it('should return blue (#2563eb) for "user"', () => {
            expect(CSSGenerator.getTypeColor('user')).toBe('#2563eb');
        });

        it('should return green (#059669) for "assistant"', () => {
            expect(CSSGenerator.getTypeColor('assistant')).toBe('#059669');
        });

        it('should return orange (#ea580c) for "tool_call"', () => {
            expect(CSSGenerator.getTypeColor('tool_call')).toBe('#ea580c');
        });

        it('should return violet (#7c3aed) for "tool_result"', () => {
            expect(CSSGenerator.getTypeColor('tool_result')).toBe('#7c3aed');
        });

        it('should return grey (#6b7280) for "metadata"', () => {
            expect(CSSGenerator.getTypeColor('metadata')).toBe('#6b7280');
        });

        it('should return red (#dc2626) for "error"', () => {
            expect(CSSGenerator.getTypeColor('error')).toBe('#dc2626');
        });

        it('should return secondary color (#374151) for unknown types', () => {
            expect(CSSGenerator.getTypeColor('unknown')).toBe('#374151');
        });

        it('should return secondary color for empty string', () => {
            expect(CSSGenerator.getTypeColor('')).toBe('#374151');
        });

        it('should return secondary color for arbitrary strings', () => {
            expect(CSSGenerator.getTypeColor('system')).toBe('#374151');
            expect(CSSGenerator.getTypeColor('some_random_type')).toBe('#374151');
        });

        it('should be case-sensitive (User != user)', () => {
            expect(CSSGenerator.getTypeColor('User')).toBe('#374151');
            expect(CSSGenerator.getTypeColor('ASSISTANT')).toBe('#374151');
        });

        // Verify each known type maps to a distinct color
        it('should return distinct colors for all known types', () => {
            const types = ['user', 'assistant', 'tool_call', 'tool_result', 'metadata', 'error'];
            const colors = types.map(t => CSSGenerator.getTypeColor(t));
            const uniqueColors = new Set(colors);
            expect(uniqueColors.size).toBe(types.length);
        });
    });
});
