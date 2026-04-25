import { describe, it, expect } from 'vitest';
import { CSSGenerator } from '../../../../src/services/markdown-formatter/CSSGenerator.js';

describe('CSSGenerator', () => {
    describe('generateCSS', () => {
        it('should generate default CSS when no options are provided', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain(':root {');
            expect(css).toContain('--color-user: #2563eb;');
            expect(css).toContain('/* === ROO CONVERSATION EXPORT - PHASE 4 ADVANCED CSS === */');
        });

        it('should include animations when animationsEnabled is true', () => {
            const css = CSSGenerator.generateCSS({
                enableAdvancedCSS: true,
                responsiveDesign: true,
                syntaxHighlighting: true,
                animationsEnabled: true,
                compactMode: false
            });
            expect(css).toContain('@keyframes pulse');
            expect(css).toContain('transition: all var(--transition-base);');
        });

        it('should exclude animations when animationsEnabled is false', () => {
            const css = CSSGenerator.generateCSS({
                enableAdvancedCSS: true,
                responsiveDesign: true,
                syntaxHighlighting: true,
                animationsEnabled: false,
                compactMode: false
            });
            expect(css).not.toContain('@keyframes pulse');
            expect(css).not.toContain('transition: all var(--transition-base);');
        });

        it('should include responsive styles when responsiveDesign is true', () => {
            const css = CSSGenerator.generateCSS({
                enableAdvancedCSS: true,
                responsiveDesign: true,
                syntaxHighlighting: true,
                animationsEnabled: true,
                compactMode: false
            });
            expect(css).toContain('@media (max-width: 768px)');
        });

        it('should exclude responsive styles when responsiveDesign is false', () => {
            const css = CSSGenerator.generateCSS({
                enableAdvancedCSS: true,
                responsiveDesign: false,
                syntaxHighlighting: true,
                animationsEnabled: true,
                compactMode: false
            });
            expect(css).not.toContain('@media (max-width: 768px)');
        });

        it('should include syntax highlighting styles when syntaxHighlighting is true', () => {
            const css = CSSGenerator.generateCSS({
                enableAdvancedCSS: true,
                responsiveDesign: true,
                syntaxHighlighting: true,
                animationsEnabled: true,
                compactMode: false
            });
            expect(css).toContain('.hljs-keyword');
        });

        it('should use simple code styles when syntaxHighlighting is false', () => {
            const css = CSSGenerator.generateCSS({
                enableAdvancedCSS: true,
                responsiveDesign: true,
                syntaxHighlighting: false,
                animationsEnabled: true,
                compactMode: false
            });
            expect(css).not.toContain('.hljs-keyword');
            expect(css).toContain('pre, code {');
        });

        it('should adjust styles for compact mode', () => {
            const css = CSSGenerator.generateCSS({
                enableAdvancedCSS: true,
                responsiveDesign: true,
                syntaxHighlighting: true,
                animationsEnabled: true,
                compactMode: true
            });
            expect(css).toContain('max-width: 900px');
            expect(css).toContain('padding: 16px');
            expect(css).toContain('/* Mode Compact */');
        });
    });

    describe('generateInteractiveCSS', () => {
        it('should generate interactive CSS', () => {
            const css = CSSGenerator.generateInteractiveCSS();
            expect(css).toContain('/* ===========================');
            expect(css).toContain('PHASE 5: CSS INTERACTIF');
            expect(css).toContain('.toc-search input');
            expect(css).toContain('.expand-button');
        });
    });

    describe('getTypeColor', () => {
        it('should return correct color for user', () => {
            expect(CSSGenerator.getTypeColor('user')).toBe('#2563eb');
        });

        it('should return correct color for assistant', () => {
            expect(CSSGenerator.getTypeColor('assistant')).toBe('#059669');
        });

        it('should return correct color for tool_call', () => {
            expect(CSSGenerator.getTypeColor('tool_call')).toBe('#ea580c');
        });

        it('should return correct color for tool_result', () => {
            expect(CSSGenerator.getTypeColor('tool_result')).toBe('#7c3aed');
        });

        it('should return correct color for metadata', () => {
            expect(CSSGenerator.getTypeColor('metadata')).toBe('#6b7280');
        });

        it('should return correct color for error', () => {
            expect(CSSGenerator.getTypeColor('error')).toBe('#dc2626');
        });

        it('should return default color for unknown type', () => {
            expect(CSSGenerator.getTypeColor('unknown')).toBe('#374151');
        });

        it('should return default color for empty string', () => {
            expect(CSSGenerator.getTypeColor('')).toBe('#374151');
        });
    });

    describe('generateCSS - CSS variables', () => {
        it('should include all message color variables', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('--color-user: #2563eb');
            expect(css).toContain('--color-assistant: #059669');
            expect(css).toContain('--color-tool-call: #ea580c');
            expect(css).toContain('--color-tool-result: #7c3aed');
            expect(css).toContain('--color-metadata: #6b7280');
            expect(css).toContain('--color-error: #dc2626');
        });

        it('should include all background color variables', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('--bg-user: #dbeafe');
            expect(css).toContain('--bg-assistant: #dcfce7');
            expect(css).toContain('--bg-tool-call: #fed7aa');
            expect(css).toContain('--bg-tool-result: #e9d5ff');
            expect(css).toContain('--bg-metadata: #f3f4f6');
            expect(css).toContain('--bg-error: #fee2e2');
        });

        it('should include shadow variables', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('--shadow-subtle');
            expect(css).toContain('--shadow-medium');
        });

        it('should include radius variables', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('--radius-sm');
            expect(css).toContain('--radius-md');
            expect(css).toContain('--radius-lg');
        });

        it('should include transition variable', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('--transition-base');
        });
    });

    describe('generateCSS - structural elements', () => {
        it('should include body styles with correct max-width (1200px default)', () => {
            const css = CSSGenerator.generateCSS({ compactMode: false } as any);
            expect(css).toContain('max-width: 1200px');
        });

        it('should include body styles with correct max-width (900px compact)', () => {
            const css = CSSGenerator.generateCSS({ compactMode: true } as any);
            expect(css).toContain('max-width: 900px');
        });

        it('should include body padding 24px by default', () => {
            const css = CSSGenerator.generateCSS({ compactMode: false } as any);
            expect(css).toContain('padding: 24px');
        });

        it('should include body padding 16px in compact mode', () => {
            const css = CSSGenerator.generateCSS({ compactMode: true } as any);
            expect(css).toContain('padding: 16px');
        });

        it('should include font-family stack in body', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('font-family:');
            expect(css).toContain('sans-serif');
        });

        it('should wrap output in <style> tags', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toMatch(/^<style>/);
            expect(css).toMatch(/<\/style>$/);
        });
    });

    describe('generateCSS - always-present sections', () => {
        it('should include print styles', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('@media print');
        });

        it('should include accessibility styles (.screen-reader-only)', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('.screen-reader-only');
        });

        it('should include focus states', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('.toc-link:focus');
            expect(css).toContain('.message-badge:focus');
        });

        it('should include message badge styles for all types', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('.message-badge.user');
            expect(css).toContain('.message-badge.assistant');
            expect(css).toContain('.message-badge.tool-call');
            expect(css).toContain('.message-badge.tool-result');
        });

        it('should include section separator with gradient', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('.section-separator');
            expect(css).toContain('linear-gradient(90deg');
        });

        it('should include conversation section styles', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('.conversation-section');
            expect(css).toContain('.user-message');
            expect(css).toContain('.assistant-message');
        });

        it('should include table styles', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('table');
            expect(css).toContain('border-collapse: collapse');
        });

        it('should include error message styles', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('.error-message');
            expect(css).toContain('.warning-message');
        });

        it('should include stats grid styles', () => {
            const css = CSSGenerator.generateCSS();
            expect(css).toContain('.stats-grid');
            expect(css).toContain('.stat-card');
        });
    });

    describe('generateCSS - compact mode overrides', () => {
        it('should include compact section overrides when compactMode is true', () => {
            const css = CSSGenerator.generateCSS({ compactMode: true } as any);
            expect(css).toContain('/* Mode Compact */');
        });

        it('should not include compact padding overrides when compactMode is false', () => {
            const css = CSSGenerator.generateCSS({ compactMode: false } as any);
            expect(css).not.toContain('.conversation-section {\n\t    padding: 12px;');
        });
    });

    describe('generateCSS - option combinations', () => {
        it('should work with all options disabled', () => {
            const css = CSSGenerator.generateCSS({
                enableAdvancedCSS: false,
                responsiveDesign: false,
                syntaxHighlighting: false,
                animationsEnabled: false,
                compactMode: false
            });
            expect(css).toContain(':root {');
            expect(css).not.toContain('@keyframes');
            expect(css).not.toContain('@media (max-width: 768px)');
            expect(css).not.toContain('.hljs-');
        });

        it('should work with all options enabled', () => {
            const css = CSSGenerator.generateCSS({
                enableAdvancedCSS: true,
                responsiveDesign: true,
                syntaxHighlighting: true,
                animationsEnabled: true,
                compactMode: true
            });
            expect(css).toContain('@keyframes pulse');
            expect(css).toContain('@media (max-width: 768px)');
            expect(css).toContain('.hljs-keyword');
            expect(css).toContain('max-width: 900px');
        });
    });

    describe('generateInteractiveCSS', () => {
        it('should contain TOC-related styles', () => {
            const css = CSSGenerator.generateInteractiveCSS();
            expect(css).toContain('.toc-container');
            expect(css).toContain('.toc-search');
            expect(css).toContain('.toc-stats-grid');
            expect(css).toContain('.toc-link');
        });

        it('should contain expandable content styles', () => {
            const css = CSSGenerator.generateInteractiveCSS();
            expect(css).toContain('.expandable-container');
            expect(css).toContain('.expand-toggle');
            expect(css).toContain('.expandable-content');
        });

        it('should contain copy button styles', () => {
            const css = CSSGenerator.generateInteractiveCSS();
            expect(css).toContain('.copy-button');
        });

        it('should contain responsive media query', () => {
            const css = CSSGenerator.generateInteractiveCSS();
            expect(css).toContain('@media (max-width: 768px)');
        });

        it('should contain highlight flash animation', () => {
            const css = CSSGenerator.generateInteractiveCSS();
            expect(css).toContain('@keyframes highlightFlash');
        });

        it('should always include transitions (not conditional)', () => {
            const css = CSSGenerator.generateInteractiveCSS();
            expect(css).toContain('transition:');
        });
    });

    describe('getTypeColor - consistency', () => {
        it('should match CSS --color-user variable value', () => {
            const css = CSSGenerator.generateCSS();
            const color = CSSGenerator.getTypeColor('user');
            expect(css).toContain(`--color-user: ${color}`);
        });

        it('should match CSS --color-assistant variable value', () => {
            const css = CSSGenerator.generateCSS();
            const color = CSSGenerator.getTypeColor('assistant');
            expect(css).toContain(`--color-assistant: ${color}`);
        });

        it('should match CSS --color-error variable value', () => {
            const css = CSSGenerator.generateCSS();
            const color = CSSGenerator.getTypeColor('error');
            expect(css).toContain(`--color-error: ${color}`);
        });
    });
});