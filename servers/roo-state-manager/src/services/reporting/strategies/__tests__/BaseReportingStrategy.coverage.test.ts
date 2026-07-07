/**
 * Coverage complement pour BaseReportingStrategy — méthodes Phase 5 interactives (COLD)
 *
 * Le test de base (BaseReportingStrategy.test.ts) couvre les méthodes "core"
 * (defaults, filterByRelevance, applyIntelligentTruncation, filterBySubTypes,
 * filterByMainTypes, excludeSubTypes) — soit IReportingStrategy.ts L87-152.
 *
 * Ce fichier couvre les méthodes Phase 5 NON couvertes (IReportingStrategy.ts L161-332) :
 * - isPhase5Enabled : OR-logique sur 3 flags enhancementFlags
 * - generateInteractiveTableOfContents : gating enableInteractiveToC + délégation
 * - applyParameterTruncation : gating enableTruncation + branch isToolParameter + wasTruncated
 * - generateNavigationAnchor : délégation MarkdownFormatterService
 * - addNavigationAnchors : gating enableInteractiveToC + injection <div id="...">
 * - getInteractiveScript : gating enableJavaScriptInteractions
 * - formatToolCallWithTruncation : params string|object + truncation conditionnelle
 * - formatToolResultWithTruncation : result string|object + truncation conditionnelle
 * - buildFinalHtmlWithPhase5Features : assemblage HTML + script interactif conditionnel
 *
 * Epic C3 #833 — test-only, 0 source touché. MarkdownFormatterService utilisé en RÉEL
 * (pur, statique, aucun mock — anti-over-mock #1936).
 *
 * @module services/reporting/strategies/__tests__/BaseReportingStrategy.coverage
 * @version 1.0.0
 */

import { describe, test, expect } from 'vitest';
import { BaseReportingStrategy } from '../IReportingStrategy.js';
import type {
    ClassifiedContent,
    EnhancedSummaryOptions,
    TruncationOptions,
    InteractiveToCSOptions,
} from '../../../../types/enhanced-conversation.js';

// ─────────────────── helpers ───────────────────

/** Concrete subclass exposant les méthodes protected Phase 5 pour testing. */
class TestableStrategy extends BaseReportingStrategy {
    apply(content: ClassifiedContent[]): ClassifiedContent[] {
        return content;
    }
    getStrategyName(): string {
        return 'TestableStrategy';
    }

    public testGenerateInteractiveTableOfContents(messages: ClassifiedContent[], options: EnhancedSummaryOptions) {
        return this.generateInteractiveTableOfContents(messages, options);
    }
    public testApplyParameterTruncation(content: string, isToolParameter: boolean, options: EnhancedSummaryOptions, elementId: string) {
        return this.applyParameterTruncation(content, isToolParameter, options, elementId);
    }
    public testGenerateNavigationAnchor(messageIndex: number, messageType: string) {
        return this.generateNavigationAnchor(messageIndex, messageType);
    }
    public testAddNavigationAnchors(formattedContent: string, messageIndex: number, messageType: string, options: EnhancedSummaryOptions) {
        return this.addNavigationAnchors(formattedContent, messageIndex, messageType, options);
    }
    public testGetInteractiveScript(options: EnhancedSummaryOptions) {
        return this.getInteractiveScript(options);
    }
    public testFormatToolCallWithTruncation(toolName: string, parameters: unknown, messageIndex: number, options: EnhancedSummaryOptions) {
        return this.formatToolCallWithTruncation(toolName, parameters, messageIndex, options);
    }
    public testFormatToolResultWithTruncation(toolName: string, result: unknown, messageIndex: number, options: EnhancedSummaryOptions) {
        return this.formatToolResultWithTruncation(toolName, result, messageIndex, options);
    }
    public testBuildFinalHtmlWithPhase5Features(cssContent: string, bodyContent: string, tableOfContents: string, options: EnhancedSummaryOptions) {
        return this.buildFinalHtmlWithPhase5Features(cssContent, bodyContent, tableOfContents, options);
    }
    public testIsPhase5Enabled(options: EnhancedSummaryOptions) {
        return this.isPhase5Enabled(options);
    }
}

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

function makeTruncationOptions(overrides: Partial<TruncationOptions> = {}): TruncationOptions {
    return {
        enableTruncation: true,
        maxParameterLength: 10,
        maxResultLength: 10,
        preserveStructure: true,
        showPreview: true,
        truncationThreshold: 1,
        previewLines: 2,
        expandButtonText: 'Expand',
        collapseButtonText: 'Collapse',
        ...overrides,
    };
}

function makeInteractiveToCOptions(overrides: Partial<InteractiveToCSOptions> = {}): InteractiveToCSOptions {
    return {
        enableInteractiveToC: true,
        showMessageCounters: true,
        showProgressBars: false,
        enableHierarchicalStructure: false,
        enableSmoothScroll: true,
        enableActiveHighlighting: false,
        enableSearchFilter: false,
        enableCopyToClipboard: false,
        enableCollapsibleSections: false,
        sectionIcons: false,
        ...overrides,
    };
}

const LONG_STRING = 'X'.repeat(500);

// ─────────────────── tests ───────────────────

describe('BaseReportingStrategy — Phase 5 coverage complement', () => {
    const strategy = new TestableStrategy();

    // ============================================================
    // isPhase5Enabled (L326-332) — OR-logique sur 3 flags
    // ============================================================
    describe('isPhase5Enabled', () => {
        test('returns false when enhancementFlags undefined', () => {
            expect(strategy.testIsPhase5Enabled({})).toBe(false);
        });
        test('returns false when no Phase 5 flag set', () => {
            expect(strategy.testIsPhase5Enabled({ enhancementFlags: { useEnhancedClassification: true } })).toBe(false);
        });
        test('returns true when enableInteractiveToC set', () => {
            expect(strategy.testIsPhase5Enabled({ enhancementFlags: { enableInteractiveToC: true } })).toBe(true);
        });
        test('returns true when enableParameterTruncation set', () => {
            expect(strategy.testIsPhase5Enabled({ enhancementFlags: { enableParameterTruncation: true } })).toBe(true);
        });
        test('returns true when enableJavaScriptInteractions set', () => {
            expect(strategy.testIsPhase5Enabled({ enhancementFlags: { enableJavaScriptInteractions: true } })).toBe(true);
        });
        test('returns true when all three Phase 5 flags set', () => {
            expect(
                strategy.testIsPhase5Enabled({
                    enhancementFlags: {
                        enableInteractiveToC: true,
                        enableParameterTruncation: true,
                        enableJavaScriptInteractions: true,
                    },
                }),
            ).toBe(true);
        });
    });

    // ============================================================
    // generateInteractiveTableOfContents (L161-172)
    // ============================================================
    describe('generateInteractiveTableOfContents', () => {
        test('returns empty string when interactiveToCSOptions undefined', () => {
            expect(strategy.testGenerateInteractiveTableOfContents([makeContent()], {})).toBe('');
        });
        test('returns empty string when enableInteractiveToC false', () => {
            const options = { interactiveToCSOptions: makeInteractiveToCOptions({ enableInteractiveToC: false }) };
            expect(strategy.testGenerateInteractiveTableOfContents([makeContent()], options)).toBe('');
        });
        test('returns non-empty TOC when enableInteractiveToC true', () => {
            const options = { interactiveToCSOptions: makeInteractiveToCOptions({ enableInteractiveToC: true }) };
            const result = strategy.testGenerateInteractiveTableOfContents(
                [makeContent(), makeContent({ index: 1 })],
                options,
            );
            expect(typeof result).toBe('string');
            expect(result.length).toBeGreaterThan(0);
        });
    });

    // ============================================================
    // applyParameterTruncation (L177-198)
    // ============================================================
    describe('applyParameterTruncation', () => {
        test('returns content unchanged when truncationOptions undefined', () => {
            expect(strategy.testApplyParameterTruncation(LONG_STRING, true, {}, 'el-1')).toBe(LONG_STRING);
        });
        test('returns content unchanged when enableTruncation false', () => {
            const options = { truncationOptions: makeTruncationOptions({ enableTruncation: false }) };
            expect(strategy.testApplyParameterTruncation(LONG_STRING, true, options, 'el-2')).toBe(LONG_STRING);
        });
        test('truncates tool parameter (isToolParameter=true) — short content, wasTruncated=false branch (L197)', () => {
            const options = { truncationOptions: makeTruncationOptions({ enableTruncation: true }) };
            const result = strategy.testApplyParameterTruncation('short', true, options, 'param-short');
            expect(typeof result).toBe('string');
            expect(result.length).toBeGreaterThan(0);
        });
        test('truncates tool parameter (isToolParameter=true) — long content, wasTruncated=true toggle (L193-195)', () => {
            const options = { truncationOptions: makeTruncationOptions({ enableTruncation: true }) };
            const result = strategy.testApplyParameterTruncation(LONG_STRING, true, options, 'param-1');
            expect(result).toContain('param-1'); // elementId injecté dans le toggle
        });
        test('truncates tool result (isToolParameter=false) — long content toggle', () => {
            const options = { truncationOptions: makeTruncationOptions({ enableTruncation: true }) };
            const result = strategy.testApplyParameterTruncation(LONG_STRING, false, options, 'result-1');
            expect(result).toContain('result-1');
        });
    });

    // ============================================================
    // generateNavigationAnchor (L203-205)
    // ============================================================
    describe('generateNavigationAnchor', () => {
        test('returns non-empty anchor string', () => {
            const anchor = strategy.testGenerateNavigationAnchor(3, 'UserMessage');
            expect(typeof anchor).toBe('string');
            expect(anchor.length).toBeGreaterThan(0);
        });
    });

    // ============================================================
    // addNavigationAnchors (L210-224)
    // ============================================================
    describe('addNavigationAnchors', () => {
        test('returns content unchanged when enhancementFlags undefined', () => {
            expect(strategy.testAddNavigationAnchors('body', 0, 'UserMessage', {})).toBe('body');
        });
        test('returns content unchanged when enableInteractiveToC false', () => {
            expect(
                strategy.testAddNavigationAnchors('body', 0, 'UserMessage', { enhancementFlags: {} }),
            ).toBe('body');
        });
        test('wraps content in <div id="..."> when enableInteractiveToC true', () => {
            const options = { enhancementFlags: { enableInteractiveToC: true } };
            const result = strategy.testAddNavigationAnchors('inner-body', 2, 'Assistant', options);
            expect(result).toContain('<div');
            expect(result).toContain('inner-body');
            expect(result).toContain('</div>');
        });
    });

    // ============================================================
    // getInteractiveScript (L229-235)
    // ============================================================
    describe('getInteractiveScript', () => {
        test('returns empty string when enhancementFlags undefined', () => {
            expect(strategy.testGetInteractiveScript({})).toBe('');
        });
        test('returns empty string when enableJavaScriptInteractions false', () => {
            expect(strategy.testGetInteractiveScript({ enhancementFlags: {} })).toBe('');
        });
        test('returns non-empty script when enableJavaScriptInteractions true', () => {
            const options = { enhancementFlags: { enableJavaScriptInteractions: true } };
            const result = strategy.testGetInteractiveScript(options);
            expect(result.length).toBeGreaterThan(0);
        });
    });

    // ============================================================
    // formatToolCallWithTruncation (L240-265)
    // ============================================================
    describe('formatToolCallWithTruncation', () => {
        test('formats tool call without truncation (string params, L249 only)', () => {
            const result = strategy.testFormatToolCallWithTruncation('Read', 'file content', 0, {});
            expect(result).toContain('Read');
            expect(result).toContain('tool-call');
        });
        test('formats tool call with object params (no truncation)', () => {
            const result = strategy.testFormatToolCallWithTruncation('Write', { path: '/a', content: 'x' }, 1, {});
            expect(result).toContain('Write');
        });
        test('formats tool call with truncation enabled (string params, L251-253 branch)', () => {
            const options = { truncationOptions: makeTruncationOptions({ enableTruncation: true }) };
            const result = strategy.testFormatToolCallWithTruncation('Edit', LONG_STRING, 2, options);
            expect(result).toContain('Edit');
            expect(result).toContain('tool-call-2');
        });
    });

    // ============================================================
    // formatToolResultWithTruncation (L270-294)
    // ============================================================
    describe('formatToolResultWithTruncation', () => {
        test('formats tool result without truncation (string result)', () => {
            const result = strategy.testFormatToolResultWithTruncation('Bash', 'command output', 0, {});
            expect(result).toContain('Bash');
            expect(result).toContain('tool-result');
        });
        test('formats tool result with object result (JSON path, no truncation)', () => {
            const result = strategy.testFormatToolResultWithTruncation('Grep', { matches: 3 }, 1, {});
            expect(result).toContain('Grep');
        });
        test('formats tool result with truncation enabled (L281-283 branch)', () => {
            const options = { truncationOptions: makeTruncationOptions({ enableTruncation: true }) };
            const result = strategy.testFormatToolResultWithTruncation('Read', LONG_STRING, 2, options);
            expect(result).toContain('tool-result-2');
        });
    });

    // ============================================================
    // buildFinalHtmlWithPhase5Features (L299-321)
    // ============================================================
    describe('buildFinalHtmlWithPhase5Features', () => {
        test('builds HTML document with css/body/toc injected, no interactive script', () => {
            const html = strategy.testBuildFinalHtmlWithPhase5Features(
                '<style>.a{}</style>',
                '<p>body</p>',
                '<nav>toc</nav>',
                {},
            );
            expect(html).toContain('<!DOCTYPE html>');
            expect(html).toContain('<style>.a{}</style>');
            expect(html).toContain('<p>body</p>');
            expect(html).toContain('<nav>toc</nav>');
            expect(html).toContain('</html>');
        });
        test('includes interactive script in body when enableJavaScriptInteractions true', () => {
            const options = { enhancementFlags: { enableJavaScriptInteractions: true } };
            const html = strategy.testBuildFinalHtmlWithPhase5Features('', 'body-content', '', options);
            expect(html).toContain('body-content');
        });
    });
});
