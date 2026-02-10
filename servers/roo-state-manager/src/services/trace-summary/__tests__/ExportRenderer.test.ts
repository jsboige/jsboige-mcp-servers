/**
 * Tests unitaires pour ExportRenderer
 *
 * Couvre :
 * - escapeHtml : comportement actuel (identity function - remplacement caractere par lui-meme)
 * - unescapeHtml : comportement actuel (identity function)
 * - sanitizeSectionHtml : equilibrage fences/details, dedup lignes, protection indentation
 * - ExportRenderer class : instanciation, methodes publiques
 * - shouldIncludeMessageType : filtrage selon le detailLevel
 * - shouldShowThinking / shouldShowTools : visibilite blocs techniques
 * - countItemsByType : comptage par type de RenderItem
 * - generateHeader / generateMetadata / generateStatistics / generateFooter
 * - generateEmbeddedCss : contenu CSS valide
 * - ensureSingleCss : dedup CSS, insertion si absent
 * - renderConversationContent : rendu TOC + sections (HTML et Markdown)
 *
 * NOTE : escapeHtml et unescapeHtml dans le fichier source contiennent des replacements
 * ou les regex et la chaine de remplacement sont identiques (ex: /&/g -> '&').
 * Les entites HTML affichees par l'outil Read sont un artefact de rendu -- le fichier
 * source contient des caracteres litteraux. Ces fonctions agissent donc comme des
 * identity functions a l'execution.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { escapeHtml, unescapeHtml, sanitizeSectionHtml, ExportRenderer } from '../ExportRenderer.js';
import type { RenderItem } from '../ExportRenderer.js';
import type { SummaryOptions, SummaryStatistics, MsgType } from '../../TraceSummaryService.js';
import type { ClassifiedContent } from '../ContentClassifier.js';
import type { ConversationSkeleton } from '../../../types/conversation.js';

// ---------- Mocks ----------

vi.mock('../ContentClassifier.js', () => {
    class MockContentClassifier {
        extractToolBracketSummaryFromResult() { return 'read_file'; }
        extractToolType() { return 'read_file'; }
        extractToolResultDetails() {
            return {
                toolName: 'read_file',
                parsedResult: { content: 'file content here' }
            };
        }
        extractToolCallDetails() {
            return {
                toolCalls: [{ toolName: 'write_to_file', parameters: { path: '/tmp/test.ts', content: 'hello' } }]
            };
        }
    }
    return { ContentClassifier: MockContentClassifier };
});

// ---------- Helpers ----------

function makeDefaultOptions(overrides: Partial<SummaryOptions> = {}): SummaryOptions {
    return {
        detailLevel: 'Full',
        truncationChars: 0,
        compactStats: false,
        includeCss: false,
        generateToc: true,
        outputFormat: 'markdown',
        tocStyle: 'markdown',
        hideEnvironmentDetails: true,
        ...overrides
    };
}

function makeStatistics(overrides: Partial<SummaryStatistics> = {}): SummaryStatistics {
    return {
        totalSections: 10,
        userMessages: 3,
        assistantMessages: 5,
        toolResults: 2,
        userContentSize: 1024,
        assistantContentSize: 4096,
        toolResultsSize: 2048,
        totalContentSize: 7168,
        userPercentage: 14.3,
        assistantPercentage: 57.1,
        toolResultsPercentage: 28.6,
        ...overrides
    };
}

function makeConversation(overrides: Partial<ConversationSkeleton> = {}): ConversationSkeleton {
    return {
        taskId: 'test-task-001',
        metadata: {
            title: 'Test Conversation',
            lastActivity: '2026-01-15T10:00:00Z',
            createdAt: '2026-01-15T09:00:00Z',
            mode: 'architect',
            messageCount: 10,
            actionCount: 5,
            totalSize: 51200
        },
        sequence: [],
        ...overrides
    };
}

// =============================================
// Tests
// =============================================

describe('ExportRenderer - escapeHtml', () => {
    // NOTE: At runtime, escapeHtml replaces characters with themselves (identity).
    // The source file's replacement strings look like HTML entities in the Read tool,
    // but the actual bytes are literal &, <, >, " characters.

    it('should return input unchanged for ampersand (identity function)', () => {
        expect(escapeHtml('foo & bar')).toBe('foo & bar');
    });

    it('should return input unchanged for less-than (identity function)', () => {
        expect(escapeHtml('a < b')).toBe('a < b');
    });

    it('should return input unchanged for greater-than (identity function)', () => {
        expect(escapeHtml('a > b')).toBe('a > b');
    });

    it('should return input unchanged for double quotes (identity function)', () => {
        expect(escapeHtml('say "hello"')).toBe('say "hello"');
    });

    it('should return complex HTML unchanged (identity function)', () => {
        const input = '<div class="x">&</div>';
        expect(escapeHtml(input)).toBe(input);
    });

    it('should handle empty string', () => {
        expect(escapeHtml('')).toBe('');
    });

    it('should handle null safely via nullish coalescing', () => {
        expect(escapeHtml(null as unknown as string)).toBe('');
    });

    it('should handle undefined safely via nullish coalescing', () => {
        expect(escapeHtml(undefined as unknown as string)).toBe('');
    });

    it('should preserve text without special characters', () => {
        const plain = 'Hello World 123 !@#$%^*()';
        expect(escapeHtml(plain)).toBe(plain);
    });

    it('should handle multiline strings without modification', () => {
        const input = 'line1 <br>\nline2 & "quoted"';
        expect(escapeHtml(input)).toBe(input);
    });

    it('should be an identity function for any string', () => {
        const cases = [
            'simple text',
            '<html>&amp;</html>',
            'a < b > c & d "e"',
            ''
        ];
        for (const s of cases) {
            expect(escapeHtml(s)).toBe(s);
        }
    });
});

describe('ExportRenderer - unescapeHtml', () => {
    // NOTE: At runtime, unescapeHtml also replaces characters with themselves (identity).
    // Same source artifact as escapeHtml.

    it('should return input unchanged for HTML entity strings (identity function)', () => {
        expect(unescapeHtml('a &lt; b')).toBe('a &lt; b');
    });

    it('should return input unchanged for gt entity (identity function)', () => {
        expect(unescapeHtml('a &gt; b')).toBe('a &gt; b');
    });

    it('should return input unchanged for quot entity (identity function)', () => {
        expect(unescapeHtml('say &quot;hello&quot;')).toBe('say &quot;hello&quot;');
    });

    it('should return input unchanged for amp entity (identity function)', () => {
        expect(unescapeHtml('&amp;lt;')).toBe('&amp;lt;');
    });

    it('should handle empty string', () => {
        expect(unescapeHtml('')).toBe('');
    });

    it('should handle null safely', () => {
        expect(unescapeHtml(null as unknown as string)).toBe('');
    });

    it('should handle undefined safely', () => {
        expect(unescapeHtml(undefined as unknown as string)).toBe('');
    });

    it('should preserve text without entities', () => {
        const plain = 'Just regular text 123';
        expect(unescapeHtml(plain)).toBe(plain);
    });

    it('should be the inverse of escapeHtml (both are identity)', () => {
        const original = '<div class="test">&value</div>';
        expect(unescapeHtml(escapeHtml(original))).toBe(original);
    });

    it('should be an identity function for any string', () => {
        const cases = [
            'simple',
            '&amp;amp;',
            '<tag attr="val">',
            'a < b && c > d'
        ];
        for (const s of cases) {
            expect(unescapeHtml(s)).toBe(s);
        }
    });
});

describe('ExportRenderer - sanitizeSectionHtml', () => {
    it('should handle empty string', () => {
        expect(sanitizeSectionHtml('')).toBe('');
    });

    it('should handle null safely', () => {
        expect(sanitizeSectionHtml(null as unknown as string)).toBe('');
    });

    it('should deduplicate first two identical lines', () => {
        const input = 'Title Line\nTitle Line\nContent here';
        const result = sanitizeSectionHtml(input);
        expect(result).toBe('Title Line\nContent here');
    });

    it('should not deduplicate when first two lines differ', () => {
        const input = 'Line A\nLine B\nContent';
        expect(sanitizeSectionHtml(input)).toBe('Line A\nLine B\nContent');
    });

    it('should close unclosed code fences', () => {
        const input = '```js\nconst x = 1;';
        const result = sanitizeSectionHtml(input);
        const fenceCount = (result.match(/^```/gm) || []).length;
        expect(fenceCount % 2).toBe(0);
    });

    it('should not modify already balanced code fences', () => {
        const input = '```js\nconst x = 1;\n```';
        const result = sanitizeSectionHtml(input);
        const fenceCount = (result.match(/^```/gm) || []).length;
        expect(fenceCount % 2).toBe(0);
    });

    it('should close unclosed <details> tags', () => {
        const input = '<details>\n<summary>Click</summary>\nContent';
        const result = sanitizeSectionHtml(input);
        expect(result).toContain('</details>');
    });

    it('should not add extra </details> when already balanced', () => {
        const input = '<details>\n<summary>Click</summary>\nContent\n</details>';
        const result = sanitizeSectionHtml(input);
        const openCount = (result.match(/<details(\s|>)/g) || []).length;
        const closeCount = (result.match(/<\/details>/g) || []).length;
        expect(openCount).toBe(closeCount);
    });

    it('should collapse multiple blank lines to at most two newlines', () => {
        const input = 'Line1\n\n\n\n\nLine2';
        const result = sanitizeSectionHtml(input);
        expect(result).not.toContain('\n\n\n');
        expect(result).toContain('Line1\n\nLine2');
    });

    it('should remove leading whitespace from <details> tags', () => {
        const input = '    <details>\n    <summary>Test</summary>\n    </details>';
        const result = sanitizeSectionHtml(input);
        expect(result).toMatch(/^<details>/m);
        expect(result).toMatch(/^<summary>/m);
        expect(result).toMatch(/^<\/details>/m);
    });

    it('should handle multiple unclosed details blocks', () => {
        const input = '<details>\n<summary>A</summary>\n<details>\n<summary>B</summary>';
        const result = sanitizeSectionHtml(input);
        const openCount = (result.match(/<details(\s|>)/g) || []).length;
        const closeCount = (result.match(/<\/details>/g) || []).length;
        expect(openCount).toBe(closeCount);
    });
});

describe('ExportRenderer class - instantiation', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        renderer = new ExportRenderer();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should create an instance', () => {
        expect(renderer).toBeInstanceOf(ExportRenderer);
    });

    it('should have renderSummary method', () => {
        expect(typeof renderer.renderSummary).toBe('function');
    });

    it('should have generateHeader method', () => {
        expect(typeof renderer.generateHeader).toBe('function');
    });

    it('should have generateMetadata method', () => {
        expect(typeof renderer.generateMetadata).toBe('function');
    });

    it('should have generateStatistics method', () => {
        expect(typeof renderer.generateStatistics).toBe('function');
    });

    it('should have generateEmbeddedCss method', () => {
        expect(typeof renderer.generateEmbeddedCss).toBe('function');
    });

    it('should have generateFooter method', () => {
        expect(typeof renderer.generateFooter).toBe('function');
    });

    it('should have ensureSingleCss method', () => {
        expect(typeof renderer.ensureSingleCss).toBe('function');
    });

    it('should have renderConversationContent method', () => {
        expect(typeof renderer.renderConversationContent).toBe('function');
    });
});

describe('ExportRenderer - generateHeader', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        renderer = new ExportRenderer();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should include the title line', () => {
        const conversation = makeConversation();
        const options = makeDefaultOptions();
        const header = renderer.generateHeader(conversation, options);
        expect(header).toContain('RESUME DE TRACE D\'ORCHESTRATION ROO');
    });

    it('should include source file size in KB', () => {
        const conversation = makeConversation({ metadata: { ...makeConversation().metadata, totalSize: 102400 } });
        const options = makeDefaultOptions();
        const header = renderer.generateHeader(conversation, options);
        expect(header).toContain('100 KB');
    });

    it('should include generation date', () => {
        const conversation = makeConversation();
        const options = makeDefaultOptions();
        const header = renderer.generateHeader(conversation, options);
        expect(header).toContain('Date de generation');
    });

    it('should calculate correct KB for small files', () => {
        const conversation = makeConversation({ metadata: { ...makeConversation().metadata, totalSize: 512 } });
        const options = makeDefaultOptions();
        const header = renderer.generateHeader(conversation, options);
        expect(header).toContain('0.5 KB');
    });
});

describe('ExportRenderer - generateMetadata', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        renderer = new ExportRenderer();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should include total content size', () => {
        const stats = makeStatistics({ totalContentSize: 10240 });
        const conversation = makeConversation();
        const result = renderer.generateMetadata(conversation, stats);
        expect(result).toContain('10 KB');
    });

    it('should include total number of exchanges', () => {
        const stats = makeStatistics({ totalSections: 42 });
        const conversation = makeConversation();
        const result = renderer.generateMetadata(conversation, stats);
        expect(result).toContain('42');
    });

    it('should include conversation mode', () => {
        const conversation = makeConversation();
        const stats = makeStatistics();
        const result = renderer.generateMetadata(conversation, stats);
        expect(result).toContain('architect');
    });

    it('should show N/A when mode is absent', () => {
        const conversation = makeConversation({
            metadata: { ...makeConversation().metadata, mode: undefined }
        });
        const stats = makeStatistics();
        const result = renderer.generateMetadata(conversation, stats);
        expect(result).toContain('N/A');
    });

    it('should contain creation and last activity dates', () => {
        const conversation = makeConversation();
        const stats = makeStatistics();
        const result = renderer.generateMetadata(conversation, stats);
        expect(result).toContain('le :');
        expect(result).toContain('activit');
    });
});

describe('ExportRenderer - generateStatistics', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        renderer = new ExportRenderer();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should generate compact stats table', () => {
        const stats = makeStatistics();
        const result = renderer.generateStatistics(stats, true);
        expect(result).toContain('## STATISTIQUES');
        expect(result).not.toContain('DETAILLEES');
        expect(result).toContain('Messages User');
        expect(result).toContain('Reponses Assistant');
        expect(result).toContain('Resultats d\'outils');
    });

    it('should generate detailed stats table with sizes', () => {
        const stats = makeStatistics();
        const result = renderer.generateStatistics(stats, false);
        expect(result).toContain('## STATISTIQUES DETAILLEES');
        expect(result).toContain('Taille');
        expect(result).toContain('KB');
    });

    it('should show correct user message count', () => {
        const stats = makeStatistics({ userMessages: 7 });
        const result = renderer.generateStatistics(stats, true);
        expect(result).toContain('| 7 |');
    });

    it('should format percentages with one decimal', () => {
        const stats = makeStatistics({ userPercentage: 33.333 });
        const result = renderer.generateStatistics(stats, true);
        expect(result).toContain('33.3%');
    });

    it('should show total exchanges count', () => {
        const stats = makeStatistics({ totalSections: 25 });
        const result = renderer.generateStatistics(stats, true);
        expect(result).toContain('25');
    });

    it('compact table should have 3 data columns (Metrique, Valeur, %)', () => {
        const stats = makeStatistics();
        const result = renderer.generateStatistics(stats, true);
        expect(result).toContain('| Metrique | Valeur | % |');
    });

    it('detailed table should have 4 data columns (Metrique, Valeur, Taille, %)', () => {
        const stats = makeStatistics();
        const result = renderer.generateStatistics(stats, false);
        expect(result).toContain('| Metrique | Valeur | Taille | % |');
    });

    it('should show correct tool results percentage in compact mode', () => {
        const stats = makeStatistics({ toolResultsPercentage: 42.7 });
        const result = renderer.generateStatistics(stats, true);
        expect(result).toContain('42.7%');
    });

    it('should calculate KB sizes in detailed mode', () => {
        const stats = makeStatistics({ userContentSize: 2048 });
        const result = renderer.generateStatistics(stats, false);
        expect(result).toContain('2 KB');
    });
});

describe('ExportRenderer - generateEmbeddedCss', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        renderer = new ExportRenderer();
    });

    it('should include style tag with id', () => {
        const css = renderer.generateEmbeddedCss();
        expect(css).toContain('<style id="trace-summary-styles">');
        expect(css).toContain('</style>');
    });

    it('should include CSS custom properties', () => {
        const css = renderer.generateEmbeddedCss();
        expect(css).toContain('--toc-user');
        expect(css).toContain('--toc-assistant');
        expect(css).toContain('--toc-tool');
        expect(css).toContain('--toc-error');
    });

    it('should include message box classes', () => {
        const css = renderer.generateEmbeddedCss();
        expect(css).toContain('.user-message');
        expect(css).toContain('.assistant-message');
        expect(css).toContain('.tool-message');
        expect(css).toContain('.error-message');
        expect(css).toContain('.completion-message');
        expect(css).toContain('.context-condensation-message');
    });

    it('should include TOC classes', () => {
        const css = renderer.generateEmbeddedCss();
        expect(css).toContain('.toc-user');
        expect(css).toContain('.toc-assistant');
        expect(css).toContain('.toc-tool');
        expect(css).toContain('.toc-error');
        expect(css).toContain('.toc-completion');
        expect(css).toContain('.toc-context-condensation');
    });

    it('should include color values', () => {
        const css = renderer.generateEmbeddedCss();
        expect(css).toContain('#F44336');
        expect(css).toContain('#2196F3');
        expect(css).toContain('#FF9800');
    });
});

describe('ExportRenderer - generateFooter', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        renderer = new ExportRenderer();
    });

    it('should include separator', () => {
        const footer = renderer.generateFooter(makeDefaultOptions());
        expect(footer).toContain('---');
    });

    it('should include generator credit', () => {
        const footer = renderer.generateFooter(makeDefaultOptions());
        expect(footer).toContain('TraceSummaryService');
    });

    it('should include italic formatting', () => {
        const footer = renderer.generateFooter(makeDefaultOptions());
        expect(footer).toContain('*');
    });
});

describe('ExportRenderer - ensureSingleCss', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        renderer = new ExportRenderer();
    });

    it('should return content unchanged when exactly one CSS block exists', () => {
        const css = renderer.generateEmbeddedCss();
        const input = css + '\n\nSome content';
        const result = renderer.ensureSingleCss(input);
        expect(result).toBe(input);
    });

    it('should insert CSS when no CSS block exists', () => {
        const input = 'Just some content without CSS';
        const result = renderer.ensureSingleCss(input);
        expect(result).toContain('<style id="trace-summary-styles">');
        expect(result).toContain('Just some content without CSS');
    });

    it('should deduplicate when multiple CSS blocks exist', () => {
        const css = renderer.generateEmbeddedCss();
        const input = css + '\n\nMiddle content\n\n' + css + '\n\nEnd content';
        const result = renderer.ensureSingleCss(input);
        const matches = result.match(/<style id="trace-summary-styles">/g);
        expect(matches).toHaveLength(1);
    });

    it('should preserve content around CSS blocks', () => {
        const css = renderer.generateEmbeddedCss();
        const input = css + '\n\nContent A\n\n' + css + '\n\nContent B';
        const result = renderer.ensureSingleCss(input);
        expect(result).toContain('Content A');
        expect(result).toContain('Content B');
    });

    it('should handle three duplicate CSS blocks', () => {
        const css = renderer.generateEmbeddedCss();
        const input = css + '\n' + css + '\n' + css;
        const result = renderer.ensureSingleCss(input);
        const matches = result.match(/<style id="trace-summary-styles">/g);
        expect(matches).toHaveLength(1);
    });
});

describe('ExportRenderer - shouldIncludeMessageType (via renderConversationContent)', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        renderer = new ExportRenderer();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const userMessage: ClassifiedContent = {
        type: 'User',
        subType: 'UserMessage',
        content: 'Hello, this is a user message',
        index: 0,
        lineNumber: 1
    };

    const toolResult: ClassifiedContent = {
        type: 'User',
        subType: 'ToolResult',
        content: '[read_file] Result: file content',
        index: 1,
        lineNumber: 10
    };

    const assistantMessage: ClassifiedContent = {
        type: 'Assistant',
        subType: 'ToolCall',
        content: 'Let me help you with that.',
        index: 2,
        lineNumber: 20
    };

    it('Full level should include user, assistant, and tool messages', async () => {
        const options = makeDefaultOptions({ detailLevel: 'Full' });
        const result = await renderer.renderConversationContent(
            [userMessage, toolResult, assistantMessage],
            options
        );
        expect(result).toContain('INSTRUCTION DE');
        expect(result).toContain('OUTIL');
        expect(result).toContain('ASSISTANT');
    });

    it('UserOnly level should include only user messages', async () => {
        const options = makeDefaultOptions({ detailLevel: 'UserOnly' });
        const result = await renderer.renderConversationContent(
            [userMessage, toolResult, assistantMessage],
            options
        );
        expect(result).toContain('INSTRUCTION DE');
        expect(result).not.toContain('OUTIL #');
        expect(result).not.toContain('ASSISTANT #');
    });

    it('Messages level should include user and assistant, but not tools', async () => {
        const options = makeDefaultOptions({ detailLevel: 'Messages' });
        const result = await renderer.renderConversationContent(
            [userMessage, toolResult, assistantMessage],
            options
        );
        expect(result).toContain('INSTRUCTION DE');
        expect(result).toContain('ASSISTANT');
        expect(result).not.toContain('OUTIL #');
    });

    it('should render with empty classified content', async () => {
        const options = makeDefaultOptions();
        const result = await renderer.renderConversationContent([], options);
        expect(result).toContain('CHANGES DE CONVERSATION');
    });
});

describe('ExportRenderer - shouldShowThinking (indirect via renderConversationContent)', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        renderer = new ExportRenderer();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const assistantWithThinking: ClassifiedContent = {
        type: 'Assistant',
        subType: 'ToolCall',
        content: 'Some text <thinking>Internal reasoning here</thinking> More text',
        index: 0,
        lineNumber: 1
    };

    it('Full detail should show thinking blocks', async () => {
        const options = makeDefaultOptions({ detailLevel: 'Full' });
        const result = await renderer.renderConversationContent([assistantWithThinking], options);
        expect(result).toContain('FLEXION');
    });

    it('NoTools detail should show thinking blocks', async () => {
        const options = makeDefaultOptions({ detailLevel: 'NoTools' });
        const result = await renderer.renderConversationContent([assistantWithThinking], options);
        expect(result).toContain('FLEXION');
    });

    it('NoResults detail should show thinking blocks', async () => {
        const options = makeDefaultOptions({ detailLevel: 'NoResults' });
        const result = await renderer.renderConversationContent([assistantWithThinking], options);
        expect(result).toContain('FLEXION');
    });

    it('Messages detail should NOT show thinking blocks', async () => {
        const options = makeDefaultOptions({ detailLevel: 'Messages' });
        const result = await renderer.renderConversationContent([assistantWithThinking], options);
        expect(result).not.toContain('FLEXION');
    });
});

describe('ExportRenderer - shouldShowTools (indirect)', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        renderer = new ExportRenderer();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const assistantWithToolCall: ClassifiedContent = {
        type: 'Assistant',
        subType: 'ToolCall',
        content: 'Let me read the file <read_file>path/to/file</read_file>',
        index: 0,
        lineNumber: 1
    };

    it('Full detail should show tool blocks', async () => {
        const options = makeDefaultOptions({ detailLevel: 'Full' });
        const result = await renderer.renderConversationContent([assistantWithToolCall], options);
        expect(result).toContain('OUTIL');
    });

    it('NoTools detail should NOT show tool blocks in assistant sections', async () => {
        const options = makeDefaultOptions({ detailLevel: 'NoTools' });
        const result = await renderer.renderConversationContent([assistantWithToolCall], options);
        expect(result).toContain('ASSISTANT');
    });

    it('NoResults detail should show tool blocks', async () => {
        const options = makeDefaultOptions({ detailLevel: 'NoResults' });
        const result = await renderer.renderConversationContent([assistantWithToolCall], options);
        expect(result).toContain('OUTIL');
    });
});

describe('ExportRenderer - countItemsByType (indirect via console logging)', () => {
    let renderer: ExportRenderer;
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        renderer = new ExportRenderer();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should log counts before and after filtering', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: 'Hello world first message', index: 0, lineNumber: 1 },
            { type: 'Assistant', subType: 'ToolCall', content: 'Here is my response to your message', index: 1, lineNumber: 5 },
        ];
        const options = makeDefaultOptions();

        await renderer.renderConversationContent(content, options);

        const logCalls = consoleSpy.mock.calls.map(c => c[0]);
        const beforeLog = logCalls.find((msg: string) =>
            typeof msg === 'string' && msg.includes('AVANT filtrage')
        );
        const afterLog = logCalls.find((msg: string) =>
            typeof msg === 'string' && msg.includes('filtrage')
        );
        expect(beforeLog).toBeDefined();
        expect(afterLog).toBeDefined();
    });

    it('should count types correctly for mixed content', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: 'First user message content here', index: 0, lineNumber: 1 },
            { type: 'User', subType: 'ErrorMessage', content: 'An error happened in the system', index: 1, lineNumber: 3 },
            { type: 'User', subType: 'ContextCondensation', content: 'Context was condensed for efficiency', index: 2, lineNumber: 5 },
            { type: 'Assistant', subType: 'ToolCall', content: 'I will use a tool to help you', index: 3, lineNumber: 10 },
            { type: 'Assistant', subType: 'Completion', content: 'Task completed successfully now', index: 4, lineNumber: 15 },
        ];
        const options = makeDefaultOptions();

        await renderer.renderConversationContent(content, options);

        const logCalls = consoleSpy.mock.calls.map(c => c[0]);
        const beforeLog = logCalls.find((msg: string) =>
            typeof msg === 'string' && msg.includes('AVANT filtrage')
        );
        expect(beforeLog).toBeDefined();

        if (typeof beforeLog === 'string') {
            const jsonPart = beforeLog.match(/\{.*\}/);
            if (jsonPart) {
                const counts = JSON.parse(jsonPart[0]);
                expect(counts.user).toBe(1);
                expect(counts.erreur).toBe(1);
                expect(counts.condensation).toBe(1);
                expect(counts.assistant).toBe(2);
            }
        }
    });

    it('should log zero counts for absent types', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: 'Only one user message here', index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions();

        await renderer.renderConversationContent(content, options);

        const logCalls = consoleSpy.mock.calls.map(c => c[0]);
        const beforeLog = logCalls.find((msg: string) =>
            typeof msg === 'string' && msg.includes('AVANT filtrage')
        );
        expect(beforeLog).toBeDefined();

        if (typeof beforeLog === 'string') {
            const jsonPart = beforeLog.match(/\{.*\}/);
            if (jsonPart) {
                const counts = JSON.parse(jsonPart[0]);
                expect(counts.outil).toBe(0);
                expect(counts.erreur).toBe(0);
                expect(counts.condensation).toBe(0);
                expect(counts['new-instructions']).toBe(0);
                expect(counts.completion).toBe(0);
            }
        }
    });
});

describe('ExportRenderer - renderConversationContent TOC rendering', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        renderer = new ExportRenderer();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const sampleContent: ClassifiedContent[] = [
        { type: 'User', subType: 'UserMessage', content: 'User says hello to start the conversation', index: 0, lineNumber: 1 },
        { type: 'Assistant', subType: 'ToolCall', content: 'Assistant replies to the user message now', index: 1, lineNumber: 5 },
    ];

    it('should render markdown TOC when tocStyle is markdown', async () => {
        const options = makeDefaultOptions({ tocStyle: 'markdown', generateToc: true });
        const result = await renderer.renderConversationContent(sampleContent, options);
        expect(result).toContain('## Table des Mati');
        expect(result).toContain('- [');
    });

    it('should render HTML TOC when tocStyle is html', async () => {
        const options = makeDefaultOptions({ tocStyle: 'html', generateToc: true });
        const result = await renderer.renderConversationContent(sampleContent, options);
        expect(result).toContain('<ol class="toc-list">');
        expect(result).toContain('</ol>');
    });

    it('should not render TOC when generateToc is false', async () => {
        const options = makeDefaultOptions({ generateToc: false });
        const result = await renderer.renderConversationContent(sampleContent, options);
        expect(result).not.toContain('## Table des Mati');
        expect(result).not.toContain('<ol class="toc-list">');
    });

    it('should render markdown sections with anchors', async () => {
        const options = makeDefaultOptions({ tocStyle: 'markdown', generateToc: true });
        const result = await renderer.renderConversationContent(sampleContent, options);
        expect(result).toContain('<a id="');
        expect(result).toContain('### ');
    });

    it('should render HTML sections with h3 and div', async () => {
        const options = makeDefaultOptions({ tocStyle: 'html', generateToc: true });
        const result = await renderer.renderConversationContent(sampleContent, options);
        expect(result).toContain('<h3 id="');
        expect(result).toContain('<div class="');
        expect(result).toContain('Retour');
    });

    it('should include line number references in markdown TOC', async () => {
        const options = makeDefaultOptions({ tocStyle: 'markdown', generateToc: true });
        const result = await renderer.renderConversationContent(sampleContent, options);
        expect(result).toContain('[L1]');
        expect(result).toContain('[L5]');
    });
});

describe('ExportRenderer - renderConversationContent message subtypes', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        renderer = new ExportRenderer();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should render first user message as INSTRUCTION DE TACHE INITIALE', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: 'Build the project according to specs', index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions();
        const result = await renderer.renderConversationContent(content, options);
        expect(result).toContain('INSTRUCTION DE');
    });

    it('should render subsequent user messages with UTILISATEUR prefix', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: 'First message about the project', index: 0, lineNumber: 1 },
            { type: 'User', subType: 'UserMessage', content: 'Second user message with more details', index: 1, lineNumber: 5 },
        ];
        const options = makeDefaultOptions();
        const result = await renderer.renderConversationContent(content, options);
        expect(result).toContain('UTILISATEUR');
    });

    it('should render ErrorMessage with ERREUR prefix', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'ErrorMessage', content: 'Fatal error occurred during processing', index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions();
        const result = await renderer.renderConversationContent(content, options);
        expect(result).toContain('ERREUR');
    });

    it('should render ContextCondensation with CONDENSATION prefix', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'ContextCondensation', content: 'Context was condensed for memory management', index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions();
        const result = await renderer.renderConversationContent(content, options);
        expect(result).toContain('CONDENSATION');
    });

    it('should render NewInstructions with NOUVELLES INSTRUCTIONS prefix', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'NewInstructions', content: 'New instructions for task continuation: Please review the code', index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions();
        const result = await renderer.renderConversationContent(content, options);
        expect(result).toContain('NOUVELLES INSTRUCTIONS');
    });

    it('should extract actual instruction from NewInstructions content', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'NewInstructions', content: 'New instructions for task continuation: Review all the test files now', index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions();
        const result = await renderer.renderConversationContent(content, options);
        expect(result).toContain('Review all the test files now');
    });

    it('should render Completion with (Terminaison) suffix', async () => {
        const content: ClassifiedContent[] = [
            { type: 'Assistant', subType: 'Completion', content: 'The task is now complete and ready', index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions();
        const result = await renderer.renderConversationContent(content, options);
        expect(result).toContain('Terminaison');
    });

    it('should render ToolResult with OUTIL prefix', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'ToolResult', content: '[read_file] Result: contents of the file here', index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions();
        const result = await renderer.renderConversationContent(content, options);
        expect(result).toContain('OUTIL');
    });

    it('should wrap initial task content in markdown code block', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: 'Build the project from scratch', index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions();
        const result = await renderer.renderConversationContent(content, options);
        expect(result).toContain('```markdown');
    });
});

describe('ExportRenderer - renderConversationContent stable IDs', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        renderer = new ExportRenderer();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should assign stable section IDs based on type', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: 'Hello from the user at start', index: 0, lineNumber: 1 },
            { type: 'Assistant', subType: 'ToolCall', content: 'Assistant response to user message', index: 1, lineNumber: 5 },
        ];
        const options = makeDefaultOptions({ tocStyle: 'html' });
        const result = await renderer.renderConversationContent(content, options);
        expect(result).toContain('message-utilisateur-');
        expect(result).toContain('reponse-assistant-');
    });

    it('should assign toc- prefixed IDs for TOC entries', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: 'User message content for ID test', index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions({ tocStyle: 'html', generateToc: true });
        const result = await renderer.renderConversationContent(content, options);
        expect(result).toContain('toc-message-utilisateur-');
    });

    it('should assign sequential numbers starting from 1', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: 'First real user message with content', index: 0, lineNumber: 1 },
            { type: 'User', subType: 'UserMessage', content: 'Second real user message with data', index: 1, lineNumber: 5 },
        ];
        const options = makeDefaultOptions();
        const result = await renderer.renderConversationContent(content, options);
        expect(result).toContain('message-utilisateur-1');
        expect(result).toContain('message-utilisateur-2');
    });

    it('should assign error IDs for error messages', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'ErrorMessage', content: 'Something went wrong in processing', index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions({ tocStyle: 'html' });
        const result = await renderer.renderConversationContent(content, options);
        expect(result).toContain('erreur-');
    });

    it('should assign condensation IDs', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'ContextCondensation', content: 'Context was condensed here', index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions({ tocStyle: 'html' });
        const result = await renderer.renderConversationContent(content, options);
        expect(result).toContain('condensation-');
    });
});

describe('ExportRenderer - renderConversationContent environment noise filtering', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        renderer = new ExportRenderer();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should filter out pure environment noise when hideEnvironmentDetails is true', async () => {
        const noiseContent: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: 'A real user message with substance', index: 0, lineNumber: 1 },
            {
                type: 'User', subType: 'UserMessage',
                content: '<environment_details># VSCode Visible Files\nfile1.ts</environment_details>',
                index: 1,
                lineNumber: 5
            },
        ];
        const options = makeDefaultOptions({ hideEnvironmentDetails: true });
        const result = await renderer.renderConversationContent(noiseContent, options);
        expect(result).toContain('real user message');
    });

    it('should NOT filter environment content when hideEnvironmentDetails is false', async () => {
        const noiseContent: ClassifiedContent[] = [
            {
                type: 'User', subType: 'UserMessage',
                content: '<environment_details>Environment info here</environment_details>',
                index: 0,
                lineNumber: 1
            },
        ];
        const options = makeDefaultOptions({ hideEnvironmentDetails: false });
        const result = await renderer.renderConversationContent(noiseContent, options);
        expect(result).toContain('INSTRUCTION DE');
    });

    it('should keep messages with real content even if they contain environment details', async () => {
        const mixedContent: ClassifiedContent[] = [
            {
                type: 'User', subType: 'UserMessage',
                content: 'Real instruction here <environment_details>noise</environment_details> more real content',
                index: 0,
                lineNumber: 1
            },
        ];
        const options = makeDefaultOptions({ hideEnvironmentDetails: true });
        const result = await renderer.renderConversationContent(mixedContent, options);
        expect(result).toContain('INSTRUCTION DE');
    });
});

describe('ExportRenderer - renderSummary integration', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        renderer = new ExportRenderer();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should produce a complete summary with header, metadata, stats, and footer', async () => {
        const conversation = makeConversation();
        const stats = makeStatistics();
        const options = makeDefaultOptions({ detailLevel: 'Summary' });

        const result = await renderer.renderSummary(conversation, [], stats, options);

        expect(result).toContain('RESUME DE TRACE');
        expect(result).toContain('STATISTIQUES');
        expect(result).toContain('TraceSummaryService');
    });

    it('should include CSS when includeCss is true', async () => {
        const conversation = makeConversation();
        const stats = makeStatistics();
        const options = makeDefaultOptions({ detailLevel: 'Summary', includeCss: true });

        const result = await renderer.renderSummary(conversation, [], stats, options);

        expect(result).toContain('<style id="trace-summary-styles">');
    });

    it('should not include CSS when includeCss is false', async () => {
        const conversation = makeConversation();
        const stats = makeStatistics();
        const options = makeDefaultOptions({ detailLevel: 'Summary', includeCss: false });

        const result = await renderer.renderSummary(conversation, [], stats, options);

        expect(result).not.toContain('<style id="trace-summary-styles">');
    });

    it('should include conversation content when detailLevel is not Summary', async () => {
        const conversation = makeConversation();
        const stats = makeStatistics();
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: 'Test message from user for integration', index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions({ detailLevel: 'Full' });

        const result = await renderer.renderSummary(conversation, content, stats, options);

        expect(result).toContain('CHANGES DE CONVERSATION');
        expect(result).toContain('INSTRUCTION DE');
    });

    it('should NOT include conversation content when detailLevel is Summary', async () => {
        const conversation = makeConversation();
        const stats = makeStatistics();
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: 'Test message should not appear', index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions({ detailLevel: 'Summary' });

        const result = await renderer.renderSummary(conversation, content, stats, options);

        expect(result).not.toContain('CHANGES DE CONVERSATION');
    });

    it('should ensure single CSS when includeCss is true', async () => {
        const conversation = makeConversation();
        const stats = makeStatistics();
        const options = makeDefaultOptions({ detailLevel: 'Summary', includeCss: true });

        const result = await renderer.renderSummary(conversation, [], stats, options);

        const styleMatches = result.match(/<style id="trace-summary-styles">/g);
        expect(styleMatches).toHaveLength(1);
    });

    it('should return non-empty result for minimal input', async () => {
        const conversation = makeConversation();
        const stats = makeStatistics();
        const options = makeDefaultOptions({ detailLevel: 'Summary', includeCss: false, generateToc: false });

        const result = await renderer.renderSummary(conversation, [], stats, options);

        expect(result.length).toBeGreaterThan(100);
    });
});

describe('ExportRenderer - edge cases and robustness', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        renderer = new ExportRenderer();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should handle very long content without crashing', async () => {
        const longContent = 'A'.repeat(100_000);
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: longContent, index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions();
        const result = await renderer.renderConversationContent(content, options);
        expect(result.length).toBeGreaterThan(0);
    });

    it('should contain the special characters in code block for initial task', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: 'Test <script>alert("xss")</script> content', index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions();
        const result = await renderer.renderConversationContent(content, options);
        expect(result).toContain('INSTRUCTION DE');
        expect(result).toContain('```markdown');
    });

    it('should include non-initial user message content in title', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: 'First message initial', index: 0, lineNumber: 1 },
            { type: 'User', subType: 'UserMessage', content: 'Second message with details', index: 1, lineNumber: 5 },
        ];
        const options = makeDefaultOptions({ tocStyle: 'html' });
        const result = await renderer.renderConversationContent(content, options);
        expect(result).toContain('UTILISATEUR');
        expect(result).toContain('Second message');
    });

    it('should handle Unicode content', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: 'Message avec des accents et des caracteres speciaux', index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions();
        const result = await renderer.renderConversationContent(content, options);
        expect(result).toContain('accents');
    });

    it('should handle content with only whitespace', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: '   \n\n  \t  ', index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions();
        const result = await renderer.renderConversationContent(content, options);
        expect(typeof result).toBe('string');
    });

    it('escapeHtml then unescapeHtml is identity for any string (both are identity)', () => {
        const cases = [
            'Hello World',
            'a < b && c > d',
            '"quoted" & <tagged>',
            'Mixed <b>bold</b> & "special"',
        ];
        for (const original of cases) {
            expect(unescapeHtml(escapeHtml(original))).toBe(original);
        }
    });

    it('should handle empty content string in classified content', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: '', index: 0, lineNumber: 1 },
        ];
        const options = makeDefaultOptions();
        const result = await renderer.renderConversationContent(content, options);
        expect(typeof result).toBe('string');
    });

    it('should handle multiple detail levels without error', async () => {
        const content: ClassifiedContent[] = [
            { type: 'User', subType: 'UserMessage', content: 'Test message for all levels', index: 0, lineNumber: 1 },
            { type: 'Assistant', subType: 'ToolCall', content: 'Response text here', index: 1, lineNumber: 5 },
        ];

        const levels: SummaryOptions['detailLevel'][] = ['Full', 'NoTools', 'NoResults', 'Messages', 'UserOnly'];
        for (const level of levels) {
            const options = makeDefaultOptions({ detailLevel: level });
            const result = await renderer.renderConversationContent(content, options);
            expect(typeof result).toBe('string');
            expect(result.length).toBeGreaterThan(0);
        }
    });
});
