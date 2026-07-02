/**
 * Tests for BaseReportingStrategy utility methods
 * Proficiency #507 - Task 1 (myia-ai-01)
 *
 * Tests the protected/public helper methods of the abstract BaseReportingStrategy class
 * by using a concrete test subclass.
 */
import { describe, it, expect } from 'vitest';
import { BaseReportingStrategy, FormattedMessage } from '../IReportingStrategy.js';
import type { ClassifiedContent, EnhancedSummaryOptions } from '../../../types/enhanced-conversation.js';

/**
 * Concrete subclass for testing abstract class methods
 */
class TestableStrategy extends BaseReportingStrategy {
    readonly detailLevel = 'Test';
    readonly description = 'Test strategy for unit testing';

    formatMessageContent(
        content: ClassifiedContent,
        messageIndex: number,
        _options: EnhancedSummaryOptions
    ): FormattedMessage {
        return {
            content: content.content,
            cssClass: this.getCssClass(content),
            shouldRender: true,
            messageType: this.getMessageType(content)
        };
    }

    // Expose protected methods for testing
    public testGetTruncatedFirstLine(content: string, maxLength?: number) {
        return this.getTruncatedFirstLine(content, maxLength);
    }
    public testGetCssClass(content: ClassifiedContent) {
        return this.getCssClass(content);
    }
    public testGetMessageType(content: ClassifiedContent) {
        return this.getMessageType(content);
    }
    public testGetToolResultType(result: string) {
        return this.getToolResultType(result);
    }
    public testCleanAssistantMessage(content: string) {
        return this.cleanAssistantMessage(content);
    }
    public testCleanUserMessage(content: string) {
        return this.cleanUserMessage(content);
    }
    public testGenerateAnchor(content: ClassifiedContent, counter: number) {
        return this.generateAnchor(content, counter);
    }
    public testHasToolDetails(content: ClassifiedContent) {
        return this.hasToolDetails(content);
    }
    public testIsTechnicalContent(content: ClassifiedContent) {
        return this.isTechnicalContent(content);
    }
    public testGenerateMessageTitle(content: ClassifiedContent, index: number) {
        return this.generateMessageTitle(content, index);
    }
    public testGenerateStatistics(contents: ClassifiedContent[]) {
        return this.generateStatistics(contents);
    }
}

function makeContent(overrides: Partial<ClassifiedContent>): ClassifiedContent {
    return {
        type: 'User',
        subType: 'UserMessage',
        content: 'test content',
        index: 0,
        ...overrides
    } as ClassifiedContent;
}

describe('BaseReportingStrategy', () => {
    const strategy = new TestableStrategy();

    describe('isTocOnlyMode', () => {
        it('should return false by default', () => {
            expect(strategy.isTocOnlyMode()).toBe(false);
        });
    });

    describe('getTruncatedFirstLine', () => {
        it('should return first non-empty line', () => {
            expect(strategy.testGetTruncatedFirstLine('hello world')).toBe('hello world');
        });

        it('should skip empty lines', () => {
            expect(strategy.testGetTruncatedFirstLine('\n\nhello')).toBe('hello');
        });

        it('should truncate long lines', () => {
            const long = 'a'.repeat(200);
            const result = strategy.testGetTruncatedFirstLine(long, 50);
            expect(result).toBe('a'.repeat(50) + '...');
        });

        it('should return empty for empty/whitespace input', () => {
            expect(strategy.testGetTruncatedFirstLine('')).toBe('');
            expect(strategy.testGetTruncatedFirstLine('   ')).toBe('');
        });

        it('should extract content from <user_message> tags', () => {
            const content = '<user_message>Important request</user_message>';
            expect(strategy.testGetTruncatedFirstLine(content)).toBe('Important request');
        });

        it('should skip lines starting with < (XML tags)', () => {
            const content = '<environment_details>foo</environment_details>\nActual message';
            expect(strategy.testGetTruncatedFirstLine(content)).toBe('Actual message');
        });

        it('should handle null/undefined gracefully', () => {
            expect(strategy.testGetTruncatedFirstLine(null as any)).toBe('');
            expect(strategy.testGetTruncatedFirstLine(undefined as any)).toBe('');
        });
    });

    describe('getCssClass', () => {
        it('should return user-message for UserMessage', () => {
            expect(strategy.testGetCssClass(makeContent({ subType: 'UserMessage' }))).toBe('user-message');
        });
        it('should return tool-result for ToolResult', () => {
            expect(strategy.testGetCssClass(makeContent({ subType: 'ToolResult' }))).toBe('tool-result');
        });
        it('should return tool-call for ToolCall', () => {
            expect(strategy.testGetCssClass(makeContent({ subType: 'ToolCall' }))).toBe('tool-call');
        });
        it('should return assistant-message for Assistant type', () => {
            expect(strategy.testGetCssClass(makeContent({ type: 'Assistant', subType: 'Completion' }))).toBe('assistant-message');
        });
        it('should return default-message for unknown types', () => {
            expect(strategy.testGetCssClass(makeContent({ type: 'User', subType: 'NewInstructions' }))).toBe('default-message');
        });
    });

    describe('getMessageType', () => {
        it('should return MESSAGE UTILISATEUR for UserMessage', () => {
            expect(strategy.testGetMessageType(makeContent({ subType: 'UserMessage' }))).toBe('MESSAGE UTILISATEUR');
        });
        it('should return RÉSULTAT OUTIL for ToolResult', () => {
            expect(strategy.testGetMessageType(makeContent({ subType: 'ToolResult' }))).toBe('RÉSULTAT OUTIL');
        });
        it('should return APPEL OUTIL for ToolCall', () => {
            expect(strategy.testGetMessageType(makeContent({ subType: 'ToolCall' }))).toBe('APPEL OUTIL');
        });
        it('should return ASSISTANT + OUTILS when content has XML tags', () => {
            expect(strategy.testGetMessageType(makeContent({
                type: 'Assistant', subType: 'Completion', content: '<tool>call</tool>'
            }))).toBe('ASSISTANT + OUTILS');
        });
        it('should return ASSISTANT for plain assistant message', () => {
            expect(strategy.testGetMessageType(makeContent({
                type: 'Assistant', subType: 'Completion', content: 'Just text response'
            }))).toBe('ASSISTANT');
        });
    });

    describe('getToolResultType', () => {
        it('should detect success', () => {
            expect(strategy.testGetToolResultType('{"success":true}')).toBe('Succès');
        });
        it('should detect success with operation created', () => {
            expect(strategy.testGetToolResultType('{"operation":"created"}')).toBe('Succès');
        });
        it('should detect error', () => {
            expect(strategy.testGetToolResultType('Error: something failed')).toBe('Erreur');
        });
        it('should detect HTML', () => {
            expect(strategy.testGetToolResultType('<html><body>test</body></html>')).toBe('HTML');
        });
        it('should detect JSON result', () => {
            expect(strategy.testGetToolResultType('{"success":false}')).toBe('Résultat JSON');
        });
        it('should default to Texte', () => {
            expect(strategy.testGetToolResultType('just plain text output')).toBe('Texte');
        });
    });

    describe('cleanAssistantMessage', () => {
        it('should remove <thinking> blocks', () => {
            const input = 'Before <thinking>internal thoughts</thinking> After';
            expect(strategy.testCleanAssistantMessage(input)).toBe('Before  After');
        });

        it('should replace tool XML with summaries', () => {
            const input = 'Text <read_file attr="val">content</read_file> more';
            const result = strategy.testCleanAssistantMessage(input);
            expect(result).toContain('[Appel d\'outil : read_file]');
        });

        it('should handle empty/null input', () => {
            expect(strategy.testCleanAssistantMessage('')).toBe('');
            expect(strategy.testCleanAssistantMessage('   ')).toBe('');
            expect(strategy.testCleanAssistantMessage(null as any)).toBe('');
        });

        it('should collapse multiple newlines', () => {
            const input = 'line1\n\n\n\n\nline2';
            expect(strategy.testCleanAssistantMessage(input)).toBe('line1\n\nline2');
        });
    });

    describe('cleanUserMessage', () => {
        it('should remove environment_details', () => {
            const input = 'Request <environment_details>lots of stuff</environment_details>';
            const result = strategy.testCleanUserMessage(input);
            expect(result).toContain('[Environment details supprimés');
            expect(result).not.toContain('lots of stuff');
        });

        it('should handle empty/null input', () => {
            expect(strategy.testCleanUserMessage('')).toBe('');
            expect(strategy.testCleanUserMessage(null as any)).toBe('');
        });

        it('should extract user_message content when cleaned result is too short', () => {
            const input = '<user_message>Important request here</user_message>' + '<environment_details>' + 'x'.repeat(300) + '</environment_details>';
            const result = strategy.testCleanUserMessage(input);
            expect(result.length).toBeGreaterThan(10);
        });
    });

    describe('generateAnchor', () => {
        it('should generate anchor from subType and counter', () => {
            expect(strategy.testGenerateAnchor(makeContent({ subType: 'UserMessage' }), 3)).toBe('UserMessage-3');
        });
        it('should use type as fallback', () => {
            const content = makeContent({ subType: undefined as any, type: 'Assistant' });
            expect(strategy.testGenerateAnchor(content, 1)).toBe('assistant-1');
        });
    });

    describe('hasToolDetails', () => {
        it('should return true when toolCallDetails present', () => {
            expect(strategy.testHasToolDetails(makeContent({
                toolCallDetails: { toolName: 'read', arguments: {}, rawXml: '', parseSuccess: true }
            }))).toBe(true);
        });
        it('should return false when no tool details', () => {
            expect(strategy.testHasToolDetails(makeContent({}))).toBe(false);
        });
    });

    describe('isTechnicalContent', () => {
        it('should return true for ToolCall', () => {
            expect(strategy.testIsTechnicalContent(makeContent({ subType: 'ToolCall' }))).toBe(true);
        });
        it('should return true for ToolResult', () => {
            expect(strategy.testIsTechnicalContent(makeContent({ subType: 'ToolResult' }))).toBe(true);
        });
        it('should return false for UserMessage without tool details', () => {
            expect(strategy.testIsTechnicalContent(makeContent({ subType: 'UserMessage' }))).toBe(false);
        });
    });

    describe('generateMessageTitle', () => {
        it('should include user emoji for UserMessage', () => {
            const title = strategy.testGenerateMessageTitle(makeContent({ subType: 'UserMessage' }), 1);
            expect(title).toContain('MESSAGE UTILISATEUR');
            expect(title).toContain('#1');
        });
        it('should include tool emoji for ToolResult', () => {
            const title = strategy.testGenerateMessageTitle(makeContent({ subType: 'ToolResult' }), 2);
            expect(title).toContain('OUTIL');
            expect(title).toContain('#2');
        });
        it('should include robot emoji for Assistant', () => {
            const title = strategy.testGenerateMessageTitle(
                makeContent({ type: 'Assistant', subType: 'Completion', content: 'plain text' }), 5
            );
            expect(title).toContain('ASSISTANT');
            expect(title).toContain('#5');
        });
    });

    describe('generateStatistics', () => {
        it('should count message types correctly', () => {
            const contents: ClassifiedContent[] = [
                makeContent({ type: 'User', subType: 'UserMessage' }),
                makeContent({ type: 'Assistant', subType: 'Completion' }),
                makeContent({ type: 'Assistant', subType: 'Completion' }),
                makeContent({ type: 'User', subType: 'ToolResult' }),
            ];
            const stats = strategy.testGenerateStatistics(contents);
            expect(stats).toContain('Messages User | 1');
            expect(stats).toContain('Réponses Assistant | 2');
            expect(stats).toContain("Résultats d'outils | 1");
            expect(stats).toContain('**Total échanges** | **4**');
        });

        it('should handle empty contents', () => {
            const stats = strategy.testGenerateStatistics([]);
            expect(stats).toContain('Messages User | 0');
            expect(stats).toContain('**Total échanges** | **0**');
        });
    });

    describe('formatMessageContent (concrete implementation)', () => {
        it('should produce a FormattedMessage with correct fields', () => {
            const content = makeContent({ subType: 'UserMessage', content: 'Hello' });
            const result = strategy.formatMessageContent(content, 1, {} as EnhancedSummaryOptions);
            expect(result.content).toBe('Hello');
            expect(result.cssClass).toBe('user-message');
            expect(result.shouldRender).toBe(true);
            expect(result.messageType).toBe('MESSAGE UTILISATEUR');
        });
    });
});

/**
 * Coverage C3 (#833, myia-po-2023) — public report-generation contract.
 *
 * The block above exercises the protected helpers; the three PUBLIC methods
 * (generateTableOfContents / generateOverview / generateReport) plus
 * shouldUseAdvancedCSS and estimateLineNumber were previously untested.
 * Every assertion is anchored to a line of IReportingStrategy.ts.
 */
class TocOnlyStrategy extends BaseReportingStrategy {
    readonly detailLevel = 'Summary';
    readonly description = 'TOC-only test strategy';
    // src L118-120 overridden: only the Summary strategy is TOC-only
    public isTocOnlyMode(): boolean {
        return true;
    }
    formatMessageContent(
        content: ClassifiedContent,
        _messageIndex: number,
        _options: EnhancedSummaryOptions
    ): FormattedMessage {
        return { content: content.content, cssClass: '', shouldRender: true, messageType: '' };
    }
}

class NonRenderingStrategy extends BaseReportingStrategy {
    readonly detailLevel = 'Hidden';
    readonly description = 'strategy that renders nothing';
    formatMessageContent(
        _content: ClassifiedContent,
        _messageIndex: number,
        _options: EnhancedSummaryOptions
    ): FormattedMessage {
        // shouldRender:false → generateReport must skip this message (src L240)
        return { content: 'SHOULD_NOT_APPEAR', cssClass: '', shouldRender: false, messageType: '' };
    }
}

describe('BaseReportingStrategy - public report generation (coverage C3 #833)', () => {
    const strategy = new TestableStrategy();
    const noCssOptions = {} as EnhancedSummaryOptions;

    describe('generateTableOfContents', () => {
        it('should start with the TOC header (src L131-132)', () => {
            const toc = strategy.generateTableOfContents([], noCssOptions);
            expect(toc.startsWith('## TABLE DES MATIÈRES')).toBe(true);
        });

        it('should render a UserMessage as an internal anchor with user class (src L147-148)', () => {
            const toc = strategy.generateTableOfContents(
                [makeContent({ type: 'User', subType: 'UserMessage', content: 'Do the thing', index: 0 })],
                noCssOptions
            );
            expect(toc).toContain('class="toc-user"');
            expect(toc).toContain('MESSAGE UTILISATEUR #1');
            expect(toc).toContain('href="#UserMessage-1"');
            expect(toc).toContain('Do the thing');
        });

        it('should render a ToolResult as an internal anchor with tool class (src L154-155)', () => {
            const toc = strategy.generateTableOfContents(
                [makeContent({ type: 'User', subType: 'ToolResult', content: 'result body', index: 0 })],
                noCssOptions
            );
            expect(toc).toContain('class="toc-tool"');
            expect(toc).toContain('RÉSULTAT OUTIL #1');
            expect(toc).toContain('href="#ToolResult-1"');
        });

        it('should label an assistant message carrying XML as "+ OUTILS" (src L159-160)', () => {
            const toc = strategy.generateTableOfContents(
                [makeContent({ type: 'Assistant', subType: 'Completion', content: '<read_file>x</read_file>', index: 0 })],
                noCssOptions
            );
            expect(toc).toContain('MESSAGE ASSISTANT + OUTILS #1');
            expect(toc).toContain('class="toc-assistant"');
        });

        it('should label a plain assistant message without "+ OUTILS" (src L160)', () => {
            const toc = strategy.generateTableOfContents(
                [makeContent({ type: 'Assistant', subType: 'Completion', content: 'plain answer', index: 0 })],
                noCssOptions
            );
            expect(toc).toContain('MESSAGE ASSISTANT #1');
            expect(toc).not.toContain('+ OUTILS');
        });

        it('should increment counters independently per category (src L134-136,141-157)', () => {
            const toc = strategy.generateTableOfContents([
                makeContent({ type: 'User', subType: 'UserMessage', content: 'u1', index: 0 }),
                makeContent({ type: 'User', subType: 'UserMessage', content: 'u2', index: 1 }),
                makeContent({ type: 'User', subType: 'ToolResult', content: 't1', index: 2 }),
            ], noCssOptions);
            expect(toc).toContain('MESSAGE UTILISATEUR #1');
            expect(toc).toContain('MESSAGE UTILISATEUR #2');
            expect(toc).toContain('RÉSULTAT OUTIL #1');
        });

        it('should emit external source links (not internal anchors) in TOC-only mode (src L143-145)', () => {
            const tocOnly = new TocOnlyStrategy();
            const toc = tocOnly.generateTableOfContents(
                [makeContent({ type: 'User', subType: 'UserMessage', content: 'hi', index: 4 })],
                noCssOptions,
                'trace.html'
            );
            // estimateLineNumber = (index || 0) + 1 = 5  (src L443)
            expect(toc).toContain('href="trace.html#L5"');
            expect(toc).not.toContain('href="#UserMessage');
        });
    });

    describe('generateOverview', () => {
        const contents = [
            makeContent({ type: 'User', subType: 'UserMessage', content: 'the question', index: 0 }),
            makeContent({ type: 'Assistant', subType: 'Completion', content: 'the answer', index: 1 }),
        ];

        it('should include the detail-level title uppercased and the description (src L189-191)', () => {
            const overview = strategy.generateOverview(contents, noCssOptions);
            expect(overview).toContain('# RÉSUMÉ DE TRACE - TEST');
            expect(overview).toContain('**Stratégie:** Test strategy for unit testing');
        });

        it('should embed statistics and the table of contents (src L195,199)', () => {
            const overview = strategy.generateOverview(contents, noCssOptions);
            expect(overview).toContain('## STATISTIQUES');
            expect(overview).toContain('## TABLE DES MATIÈRES');
        });

        it('should NOT emit an initial instruction in non-TOC-only mode (src L203 guard)', () => {
            const overview = strategy.generateOverview(contents, noCssOptions);
            expect(overview).not.toContain('## INSTRUCTION INITIALE');
        });

        it('should emit the initial instruction (first user message, cleaned) in TOC-only mode (src L203-211)', () => {
            const tocOnly = new TocOnlyStrategy();
            const overview = tocOnly.generateOverview(contents, noCssOptions);
            expect(overview).toContain('## INSTRUCTION INITIALE');
            expect(overview).toContain('the question');
        });
    });

    describe('generateReport', () => {
        const contents = [
            makeContent({ type: 'User', subType: 'UserMessage', content: 'USER_BODY', index: 0 }),
        ];

        it('should start with the overview when advanced CSS is off (src L223 false → L229)', () => {
            const report = strategy.generateReport(contents, noCssOptions);
            expect(report.startsWith('# RÉSUMÉ DE TRACE')).toBe(true);
        });

        it('should append the MESSAGES section with rendered content in non-TOC-only mode (src L232-244)', () => {
            const report = strategy.generateReport(contents, noCssOptions);
            expect(report).toContain('## MESSAGES');
            expect(report).toContain('USER_BODY');
        });

        it('should prepend a CSS block before the overview when advanced CSS is enabled (src L222-226)', () => {
            const cssOn = { enhancementFlags: { enableAdvancedCSS: true } } as EnhancedSummaryOptions;
            const reportOff = strategy.generateReport(contents, noCssOptions);
            const reportOn = strategy.generateReport(contents, cssOn);
            expect(reportOn.length).toBeGreaterThan(reportOff.length);
            expect(reportOn).toContain('# RÉSUMÉ DE TRACE');
            expect(reportOn.startsWith('# RÉSUMÉ DE TRACE')).toBe(false);
        });

        it('should omit the MESSAGES section entirely in TOC-only mode (src L232 guard)', () => {
            const tocOnly = new TocOnlyStrategy();
            const report = tocOnly.generateReport(contents, noCssOptions);
            expect(report).not.toContain('## MESSAGES');
        });

        it('should skip messages whose formatted result has shouldRender=false (src L240)', () => {
            const hidden = new NonRenderingStrategy();
            const report = hidden.generateReport(contents, noCssOptions);
            expect(report).toContain('## MESSAGES');
            expect(report).not.toContain('SHOULD_NOT_APPEAR');
        });
    });

    describe('shouldUseAdvancedCSS', () => {
        it('should return true when the enableAdvancedCSS flag is set (src L253-254)', () => {
            const opts = { enhancementFlags: { enableAdvancedCSS: true } } as EnhancedSummaryOptions;
            expect((strategy as any).shouldUseAdvancedCSS(opts)).toBe(true);
        });
        it('should return false when the flag is explicitly false (src L254)', () => {
            const opts = { enhancementFlags: { enableAdvancedCSS: false } } as EnhancedSummaryOptions;
            expect((strategy as any).shouldUseAdvancedCSS(opts)).toBe(false);
        });
        it('should return false when enhancementFlags is absent (optional chaining, src L254)', () => {
            expect((strategy as any).shouldUseAdvancedCSS({} as EnhancedSummaryOptions)).toBe(false);
        });
    });

    describe('estimateLineNumber', () => {
        it('should return index + 1 (src L443)', () => {
            expect((strategy as any).estimateLineNumber(makeContent({ index: 5 }))).toBe(6);
        });
        it('should return 1 for index 0 (src L443)', () => {
            expect((strategy as any).estimateLineNumber(makeContent({ index: 0 }))).toBe(1);
        });
        it('should default a missing index to 0 → 1 (src L443 `|| 0`)', () => {
            expect((strategy as any).estimateLineNumber(makeContent({ index: undefined as any }))).toBe(1);
        });
    });
});
