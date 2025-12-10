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
    });
});