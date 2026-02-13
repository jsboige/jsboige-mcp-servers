/**
 * Tests unitaires pour ContentClassifier
 *
 * Couvre toutes les methodes publiques :
 * - classifyConversationContent : classification sequence -> ClassifiedContent[]
 * - classifyContentFromMarkdownOrJson : fallback markdown -> JSON (fs mock)
 * - extractToolCallDetails : extraction XML tool calls
 * - parseToolParameters : parsing parametres XML
 * - extractToolResultDetails : extraction resultats outils
 * - isToolResult : detection resultat outil (string et array)
 * - extractToolBracketSummaryFromResult : extraction bracket summary
 * - extractToolType : extraction nom outil
 * - getResultType : determination type resultat
 * - extractTextContent : extraction texte (string et array)
 * - parseStructuredResult : parsing JSON, XML, texte
 * - extractFirstToolName : detection premier outil XML
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContentClassifier, ClassifiedContent } from '../ContentClassifier.js';
import type { ConversationSkeleton, MessageSkeleton } from '../../../types/conversation.js';

// ---------- Mocks ----------

vi.mock('fs', () => {
    return {
        default: {
            promises: {
                access: vi.fn(),
                readFile: vi.fn(),
            },
        },
        promises: {
            access: vi.fn(),
            readFile: vi.fn(),
        },
    };
});

// Suppress console output during tests
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

// ---------- Helpers ----------

function makeMessage(role: 'user' | 'assistant', content: string): MessageSkeleton {
    return {
        role,
        content,
        timestamp: '2026-01-01T00:00:00Z',
        isTruncated: false,
    };
}

function makeSkeleton(messages: MessageSkeleton[], taskId = 'test-task-001'): ConversationSkeleton {
    return {
        taskId,
        metadata: {
            title: 'Test conversation',
            lastActivity: '2026-01-01T00:00:00Z',
            createdAt: '2026-01-01T00:00:00Z',
            messageCount: messages.length,
            actionCount: 0,
            totalSize: 1000,
        },
        sequence: messages,
    };
}

// ---------- Tests ----------

describe('ContentClassifier', () => {
    let classifier: ContentClassifier;

    beforeEach(() => {
        classifier = new ContentClassifier();
        consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleLogSpy.mockRestore();
        consoleWarnSpy.mockRestore();
        vi.restoreAllMocks();
    });

    // ====================================================================
    // extractTextContent
    // ====================================================================
    describe('extractTextContent', () => {
        it('should return string content as-is', () => {
            expect(classifier.extractTextContent('hello world')).toBe('hello world');
        });

        it('should join text items from array format', () => {
            const arr = [
                { type: 'text', text: 'first' },
                { type: 'text', text: 'second' },
            ];
            expect(classifier.extractTextContent(arr)).toBe('first second');
        });

        it('should filter out non-text items from array', () => {
            const arr = [
                { type: 'text', text: 'visible' },
                { type: 'image', url: 'http://example.com/img.png' },
                { type: 'text', text: 'also visible' },
            ];
            expect(classifier.extractTextContent(arr)).toBe('visible also visible');
        });

        it('should return empty string for empty array', () => {
            expect(classifier.extractTextContent([])).toBe('');
        });

        it('should return empty string for non-string, non-array input', () => {
            expect(classifier.extractTextContent(42 as any)).toBe('');
            expect(classifier.extractTextContent(null as any)).toBe('');
            expect(classifier.extractTextContent(undefined as any)).toBe('');
        });
    });

    // ====================================================================
    // isToolResult
    // ====================================================================
    describe('isToolResult', () => {
        it('should detect bracket result format in string', () => {
            expect(classifier.isToolResult('[read_file] Result: file contents')).toBe(true);
        });

        it('should detect bracket result with for-clause in string', () => {
            expect(classifier.isToolResult("[read_file for '/path/file.ts'] Result: ...")).toBe(true);
        });

        it('should reject plain user message', () => {
            expect(classifier.isToolResult('Please read the file')).toBe(false);
        });

        it('should detect bracket result in array format', () => {
            const arr = [{ type: 'text', text: '[execute_command] Result: done' }];
            expect(classifier.isToolResult(arr)).toBe(true);
        });

        it('should reject non-result array', () => {
            const arr = [{ type: 'text', text: 'just a user message' }];
            expect(classifier.isToolResult(arr)).toBe(false);
        });

        it('should return false for non-string non-array', () => {
            expect(classifier.isToolResult(123 as any)).toBe(false);
            expect(classifier.isToolResult({} as any)).toBe(false);
        });

        it('should handle case-insensitive Result:', () => {
            expect(classifier.isToolResult('[search_files] result: found')).toBe(true);
        });
    });

    // ====================================================================
    // extractToolType
    // ====================================================================
    describe('extractToolType', () => {
        it('should extract tool name from bracket format', () => {
            expect(classifier.extractToolType('[read_file] Result: contents')).toBe('read_file');
        });

        it('should extract tool name ignoring for-clause', () => {
            expect(classifier.extractToolType("[write_to_file for '/path'] Result: ok")).toBe('write_to_file');
        });

        it('should return "outil" for unrecognized format', () => {
            expect(classifier.extractToolType('some random text')).toBe('outil');
        });

        it('should handle array content format', () => {
            const arr = [{ type: 'text', text: '[list_files] Result: dir listing' }];
            expect(classifier.extractToolType(arr)).toBe('list_files');
        });
    });

    // ====================================================================
    // getResultType
    // ====================================================================
    describe('getResultType', () => {
        it('should detect files type', () => {
            expect(classifier.getResultType('<files>some files</files>')).toBe('files');
        });

        it('should detect file write result', () => {
            expect(classifier.getResultType('<file_write_result>ok</file_write_result>')).toBe('\u00e9criture fichier');
        });

        it('should detect command execution', () => {
            expect(classifier.getResultType('Command executed successfully')).toBe('ex\u00e9cution commande');
        });

        it('should detect browser navigation', () => {
            expect(classifier.getResultType('Browser launched at http://localhost')).toBe('navigation web');
        });

        it('should detect browser action variant', () => {
            expect(classifier.getResultType('Browser action completed')).toBe('navigation web');
        });

        it('should detect environment details', () => {
            expect(classifier.getResultType('<environment_details>...</environment_details>')).toBe('d\u00e9tails environnement');
        });

        it('should detect error results', () => {
            expect(classifier.getResultType('Result: Error reading file')).toBe('erreur');
            expect(classifier.getResultType('Unable to apply diff')).toBe('erreur');
        });

        it('should detect todo update', () => {
            expect(classifier.getResultType('Todo list updated successfully')).toBe('mise \u00e0 jour todo');
        });

        it('should default to "r\u00e9sultat"', () => {
            expect(classifier.getResultType('some output data')).toBe('r\u00e9sultat');
        });

        it('should handle array content', () => {
            const arr = [{ type: 'text', text: '<files>list</files>' }];
            expect(classifier.getResultType(arr)).toBe('files');
        });
    });

    // ====================================================================
    // extractToolBracketSummaryFromResult
    // ====================================================================
    describe('extractToolBracketSummaryFromResult', () => {
        it('should extract bracket summary from standard result', () => {
            const result = classifier.extractToolBracketSummaryFromResult("[read_file for '/path/file.ts'] Result: ...");
            expect(result).toBe("read_file for '/path/file.ts'");
        });

        it('should extract simple bracket summary', () => {
            const result = classifier.extractToolBracketSummaryFromResult('[execute_command] Result: done');
            expect(result).toBe('execute_command');
        });

        it('should return null for no bracket pattern', () => {
            const result = classifier.extractToolBracketSummaryFromResult('plain text no brackets');
            expect(result).toBeNull();
        });

        it('should parse JSON tool format with tool field', () => {
            const json = JSON.stringify({ tool: 'read_file', path: '/some/path.ts' });
            const result = classifier.extractToolBracketSummaryFromResult(json);
            expect(result).toBe("read_file for '/some/path.ts'");
        });

        it('should parse JSON tool format with serverName/toolName', () => {
            const json = JSON.stringify({ tool: 'mcp', serverName: 'myServer', toolName: 'myTool' });
            const result = classifier.extractToolBracketSummaryFromResult(json);
            expect(result).toBe('myServer/myTool');
        });

        it('should parse JSON tool format with type fallback', () => {
            const json = JSON.stringify({ tool: 'generic', type: 'use_mcp_tool' });
            const result = classifier.extractToolBracketSummaryFromResult(json);
            expect(result).toBe('use_mcp_tool');
        });

        it('should truncate long paths', () => {
            const longPath = '/very/long/path/that/exceeds/fifty/characters/in/total/and/then/some/more.ts';
            const json = JSON.stringify({ tool: 'read_file', path: longPath });
            const result = classifier.extractToolBracketSummaryFromResult(json);
            expect(result).toContain('...');
            expect(result!.startsWith('read_file for ')).toBe(true);
        });

        it('should return null for invalid JSON without bracket', () => {
            const result = classifier.extractToolBracketSummaryFromResult('{invalid json');
            expect(result).toBeNull();
        });
    });

    // ====================================================================
    // parseStructuredResult
    // ====================================================================
    describe('parseStructuredResult', () => {
        it('should parse valid JSON', () => {
            const parsed = classifier.parseStructuredResult('{"key":"value"}');
            expect(parsed).toEqual({ key: 'value' });
        });

        it('should detect file structure XML', () => {
            const result = classifier.parseStructuredResult('<files><file>a.ts</file></files>');
            expect(result).toEqual({ type: 'file_structure', content: '<files><file>a.ts</file></files>' });
        });

        it('should detect file tag XML', () => {
            const result = classifier.parseStructuredResult('<file>something</file>');
            expect(result).toEqual({ type: 'file_structure', content: '<file>something</file>' });
        });

        it('should detect command output', () => {
            const result = classifier.parseStructuredResult('Command executed successfully');
            expect(result).toEqual({ type: 'command_output', content: 'Command executed successfully' });
        });

        it('should default to text type', () => {
            const result = classifier.parseStructuredResult('just plain text');
            expect(result).toEqual({ type: 'text', content: 'just plain text' });
        });
    });

    // ====================================================================
    // parseToolParameters
    // ====================================================================
    describe('parseToolParameters', () => {
        it('should parse XML with root tool tag -- regex matches outermost only', () => {
            // The regex /<tag>(.*?)<\/tag>/g with backreference matches the outermost
            // <read_file>...</read_file> as a single match. Since read_file is a root tool
            // tag, it is skipped, and inner tags are consumed. Result: empty object.
            const xml = '<read_file><path>/src/index.ts</path><lines>1-50</lines></read_file>';
            const params = classifier.parseToolParameters(xml);
            // Root tag consumes inner content; inner params not separately matched
            expect(params).toEqual({});
        });

        it('should skip root tool tags in the result', () => {
            const xml = '<read_file><path>/src/index.ts</path></read_file>';
            const params = classifier.parseToolParameters(xml);
            expect(params).not.toHaveProperty('read_file');
            // Due to regex behavior, inner <path> is consumed by outer match
            expect(params).toEqual({});
        });

        it('should parse non-root tag and include its content', () => {
            // unknown_tag is NOT a root tool tag, so it appears in results
            const xml = '<unknown_tag>plain text no inner tags</unknown_tag>';
            const params = classifier.parseToolParameters(xml);
            expect(params).toBeDefined();
            expect(params).toHaveProperty('unknown_tag', 'plain text no inner tags');
        });

        it('should return null for empty XML block', () => {
            const params = classifier.parseToolParameters('');
            expect(params).toBeNull();
        });

        it('should skip root tag execute_command (inner params consumed)', () => {
            // execute_command is a root tool tag; the regex matches the whole block
            const xml = '<execute_command><command>  npm run build  </command></execute_command>';
            const params = classifier.parseToolParameters(xml);
            expect(params).not.toHaveProperty('execute_command');
            // Inner <command> is consumed by outer match
            expect(params).toEqual({});
        });

        it('should skip root tag write_to_file (inner params consumed)', () => {
            const xml = '<write_to_file><path>/out.txt</path><content>hello</content></write_to_file>';
            const params = classifier.parseToolParameters(xml);
            expect(params).not.toHaveProperty('write_to_file');
            // Inner params consumed by outer match
            expect(params).toEqual({});
        });

        it('should parse sibling non-root tags at same level', () => {
            // When tags are siblings (not nested), each is matched separately
            const xml = '<server_name>myServer</server_name><tool_name>myTool</tool_name>';
            const params = classifier.parseToolParameters(xml);
            expect(params).toHaveProperty('server_name', 'myServer');
            expect(params).toHaveProperty('tool_name', 'myTool');
        });

        it('should return null on parse error', () => {
            // No matching open/close tags
            const params = classifier.parseToolParameters('no xml here at all');
            expect(params).toBeNull();
        });
    });

    // ====================================================================
    // extractToolCallDetails
    // ====================================================================
    describe('extractToolCallDetails', () => {
        it('should return undefined for non-ToolCall items', () => {
            const item: ClassifiedContent = {
                type: 'User',
                subType: 'UserMessage',
                content: 'hello',
                index: 0,
            };
            expect(classifier.extractToolCallDetails(item)).toBeUndefined();
        });

        it('should return undefined for Assistant Completion', () => {
            const item: ClassifiedContent = {
                type: 'Assistant',
                subType: 'Completion',
                content: '<attempt_completion><result>done</result></attempt_completion>',
                index: 0,
            };
            expect(classifier.extractToolCallDetails(item)).toBeUndefined();
        });

        it('should extract tool call from XML content', () => {
            const item: ClassifiedContent = {
                type: 'Assistant',
                subType: 'ToolCall',
                content: 'I will read the file. <read_file><path>/src/index.ts</path></read_file>',
                index: 0,
            };
            const details = classifier.extractToolCallDetails(item);
            expect(details).toBeDefined();
            expect(details.totalCalls).toBe(1);
            expect(details.toolCalls[0].toolName).toBe('read_file');
            // Due to regex behavior, root tool tag consumes inner params
            // Parameters object is non-null (empty {}), so parsedSuccessfully is true
            expect(details.toolCalls[0].parameters).toBeDefined();
            expect(details.toolCalls[0].parsedSuccessfully).toBe(true);
        });

        it('should extract multiple tool calls', () => {
            const item: ClassifiedContent = {
                type: 'Assistant',
                subType: 'ToolCall',
                content: '<read_file><path>a.ts</path></read_file> then <write_to_file><path>b.ts</path><content>data</content></write_to_file>',
                index: 0,
            };
            const details = classifier.extractToolCallDetails(item);
            expect(details).toBeDefined();
            expect(details.totalCalls).toBe(2);
            expect(details.toolCalls[0].toolName).toBe('read_file');
            expect(details.toolCalls[1].toolName).toBe('write_to_file');
        });

        it('should return undefined when no XML tool tags found', () => {
            const item: ClassifiedContent = {
                type: 'Assistant',
                subType: 'ToolCall',
                content: 'Just a plain assistant message with no tools.',
                index: 0,
            };
            expect(classifier.extractToolCallDetails(item)).toBeUndefined();
        });

        it('should report hasParsingErrors false when parameters are empty but non-null', () => {
            // <custom_tool></custom_tool> matches the outer regex. parseToolParameters
            // matches the same <custom_tool></custom_tool> again internally, and since
            // custom_tool is not a root tool tag, it produces { custom_tool: '' }.
            // Non-null means parsedSuccessfully = true.
            const item: ClassifiedContent = {
                type: 'Assistant',
                subType: 'ToolCall',
                content: '<custom_tool></custom_tool>',
                index: 0,
            };
            const details = classifier.extractToolCallDetails(item);
            expect(details).toBeDefined();
            expect(details.hasParsingErrors).toBe(false);
            expect(details.toolCalls[0].parsedSuccessfully).toBe(true);
        });

        it('should report hasParsingErrors true when no inner tags match', () => {
            // Content with no valid XML tags should cause parseToolParameters to return null
            // We need a ToolCall item where the XML regex matches the outer extractToolCallDetails
            // but parseToolParameters returns null. This happens when we spy on parseToolParameters.
            const spy = vi.spyOn(classifier, 'parseToolParameters').mockReturnValue(null);
            const item: ClassifiedContent = {
                type: 'Assistant',
                subType: 'ToolCall',
                content: '<some_tool>content</some_tool>',
                index: 0,
            };
            const details = classifier.extractToolCallDetails(item);
            expect(details).toBeDefined();
            expect(details.hasParsingErrors).toBe(true);
            expect(details.toolCalls[0].parsedSuccessfully).toBe(false);
            spy.mockRestore();
        });
    });

    // ====================================================================
    // extractToolResultDetails
    // ====================================================================
    describe('extractToolResultDetails', () => {
        it('should return undefined for non-ToolResult items', () => {
            const item: ClassifiedContent = {
                type: 'User',
                subType: 'UserMessage',
                content: 'hello',
                index: 0,
            };
            expect(classifier.extractToolResultDetails(item)).toBeUndefined();
        });

        it('should return undefined for Assistant items', () => {
            const item: ClassifiedContent = {
                type: 'Assistant',
                subType: 'ToolCall',
                content: '<read_file><path>a.ts</path></read_file>',
                index: 0,
            };
            expect(classifier.extractToolResultDetails(item)).toBeUndefined();
        });

        it('should extract tool result details', () => {
            const item: ClassifiedContent = {
                type: 'User',
                subType: 'ToolResult',
                content: '[read_file] Result: file content here',
                index: 0,
            };
            const details = classifier.extractToolResultDetails(item);
            expect(details).toBeDefined();
            expect(details.toolName).toBe('read_file');
            expect(details.contentLength).toBeGreaterThan(0);
            expect(details.parsedResult).toBeDefined();
        });

        it('should detect error in result', () => {
            const item: ClassifiedContent = {
                type: 'User',
                subType: 'ToolResult',
                content: '[read_file] Result: Error reading file: permission denied',
                index: 0,
            };
            const details = classifier.extractToolResultDetails(item);
            expect(details).toBeDefined();
            expect(details.hasError).toBe(true);
        });

        it('should detect no error in clean result', () => {
            const item: ClassifiedContent = {
                type: 'User',
                subType: 'ToolResult',
                content: '[list_files] Result: src/index.ts',
                index: 0,
            };
            const details = classifier.extractToolResultDetails(item);
            expect(details).toBeDefined();
            expect(details.hasError).toBe(false);
        });

        it('should return undefined when no bracket pattern found', () => {
            const item: ClassifiedContent = {
                type: 'User',
                subType: 'ToolResult',
                content: 'some content without bracket pattern',
                index: 0,
            };
            expect(classifier.extractToolResultDetails(item)).toBeUndefined();
        });
    });

    // ====================================================================
    // extractFirstToolName
    // ====================================================================
    describe('extractFirstToolName', () => {
        it('should find read_file tag', () => {
            expect(classifier.extractFirstToolName('<read_file><path>a.ts</path></read_file>')).toBe('read_file');
        });

        it('should find write_to_file tag', () => {
            expect(classifier.extractFirstToolName('text before <write_to_file>...</write_to_file>')).toBe('write_to_file');
        });

        it('should find execute_command tag', () => {
            expect(classifier.extractFirstToolName('<execute_command><command>ls</command></execute_command>')).toBe('execute_command');
        });

        it('should find attempt_completion tag', () => {
            expect(classifier.extractFirstToolName('<attempt_completion><result>done</result></attempt_completion>')).toBe('attempt_completion');
        });

        it('should find codebase_search tag', () => {
            expect(classifier.extractFirstToolName('<codebase_search><query>foo</query></codebase_search>')).toBe('codebase_search');
        });

        it('should find browser_action tag', () => {
            expect(classifier.extractFirstToolName('<browser_action>click</browser_action>')).toBe('browser_action');
        });

        it('should find use_mcp_tool tag', () => {
            expect(classifier.extractFirstToolName('<use_mcp_tool><server_name>srv</server_name></use_mcp_tool>')).toBe('use_mcp_tool');
        });

        it('should find use_mcp_tool with server_name detail', () => {
            // When use_mcp_tool with server_name is matched by the MCP regex
            const content = '<use_mcp_tool><server_name>my-server</server_name><tool_name>do_thing</tool_name></use_mcp_tool>';
            const result = classifier.extractFirstToolName(content);
            // It matches use_mcp_tool from the common tools list first
            expect(result).toBe('use_mcp_tool');
        });

        it('should return null for content without tool tags', () => {
            expect(classifier.extractFirstToolName('just plain text')).toBeNull();
        });

        it('should return null for empty string', () => {
            expect(classifier.extractFirstToolName('')).toBeNull();
        });

        it('should return null for null/undefined', () => {
            expect(classifier.extractFirstToolName(null as any)).toBeNull();
            expect(classifier.extractFirstToolName(undefined as any)).toBeNull();
        });

        it('should find first tool when multiple are present', () => {
            const content = 'I will first <list_files><path>.</path></list_files> then <read_file><path>x</path></read_file>';
            // The method iterates the commonTools list in order, so it returns whichever is first in that list
            // read_file comes before list_files in the list
            const result = classifier.extractFirstToolName(content);
            expect(result).toBe('read_file');
        });
    });

    // ====================================================================
    // classifyConversationContent
    // ====================================================================
    describe('classifyConversationContent', () => {
        it('should classify a simple user message', () => {
            const conv = makeSkeleton([makeMessage('user', 'Hello, please help me')]);
            const result = classifier.classifyConversationContent(conv);
            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('User');
            expect(result[0].subType).toBe('UserMessage');
            expect(result[0].index).toBe(0);
        });

        it('should classify a tool result message', () => {
            const conv = makeSkeleton([makeMessage('user', '[read_file] Result: file content')]);
            const result = classifier.classifyConversationContent(conv);
            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('User');
            expect(result[0].subType).toBe('ToolResult');
            expect(result[0].toolType).toBe('read_file');
            expect(result[0].resultType).toBeDefined();
        });

        it('should classify an error message', () => {
            const conv = makeSkeleton([makeMessage('user', '[ERROR] Something went wrong')]);
            const result = classifier.classifyConversationContent(conv);
            expect(result).toHaveLength(1);
            expect(result[0].subType).toBe('ErrorMessage');
        });

        it('should classify a context condensation message', () => {
            const conv = makeSkeleton([
                makeMessage('user', '1. **Previous Conversation:** The user asked to build a web app...'),
            ]);
            const result = classifier.classifyConversationContent(conv);
            expect(result).toHaveLength(1);
            expect(result[0].subType).toBe('ContextCondensation');
        });

        it('should classify new instructions message', () => {
            const conv = makeSkeleton([
                makeMessage('user', 'New instructions for task continuation: please finish the deployment'),
            ]);
            const result = classifier.classifyConversationContent(conv);
            expect(result).toHaveLength(1);
            expect(result[0].subType).toBe('NewInstructions');
        });

        it('should classify an assistant tool call', () => {
            const conv = makeSkeleton([
                makeMessage('assistant', 'Let me read the file. <read_file><path>src/index.ts</path></read_file>'),
            ]);
            const result = classifier.classifyConversationContent(conv);
            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('Assistant');
            expect(result[0].subType).toBe('ToolCall');
        });

        it('should classify an assistant completion', () => {
            const conv = makeSkeleton([
                makeMessage('assistant', 'I have finished. <attempt_completion><result>All done!</result></attempt_completion>'),
            ]);
            const result = classifier.classifyConversationContent(conv);
            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('Assistant');
            expect(result[0].subType).toBe('Completion');
        });

        it('should classify a mixed conversation', () => {
            const conv = makeSkeleton([
                makeMessage('user', 'Please read index.ts'),
                makeMessage('assistant', '<read_file><path>index.ts</path></read_file>'),
                makeMessage('user', '[read_file] Result: export function main() {}'),
                makeMessage('assistant', '<attempt_completion><result>Done</result></attempt_completion>'),
            ]);
            const result = classifier.classifyConversationContent(conv);
            expect(result).toHaveLength(4);
            expect(result[0].subType).toBe('UserMessage');
            expect(result[1].subType).toBe('ToolCall');
            expect(result[2].subType).toBe('ToolResult');
            expect(result[3].subType).toBe('Completion');
        });

        it('should assign sequential indices', () => {
            const conv = makeSkeleton([
                makeMessage('user', 'msg1'),
                makeMessage('assistant', 'msg2'),
                makeMessage('user', 'msg3'),
            ]);
            const result = classifier.classifyConversationContent(conv);
            expect(result.map(r => r.index)).toEqual([0, 1, 2]);
        });

        it('should filter out ActionMetadata from sequence', () => {
            const conv = makeSkeleton([makeMessage('user', 'hello')]);
            // Add an ActionMetadata to the sequence
            conv.sequence.push({
                type: 'tool',
                name: 'some_tool',
                parameters: {},
                status: 'success',
                timestamp: '2026-01-01T00:00:00Z',
            });
            const result = classifier.classifyConversationContent(conv);
            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('User');
        });

        it('should handle empty conversation', () => {
            const conv = makeSkeleton([]);
            const result = classifier.classifyConversationContent(conv);
            expect(result).toHaveLength(0);
        });

        it('should apply startIndex filter', () => {
            const conv = makeSkeleton([
                makeMessage('user', 'msg1'),
                makeMessage('assistant', 'msg2'),
                makeMessage('user', 'msg3'),
                makeMessage('assistant', 'msg4'),
            ]);
            // startIndex is 1-based, so startIndex=3 means start from 3rd message (0-based index 2)
            const result = classifier.classifyConversationContent(conv, {
                startIndex: 3,
                detailLevel: 'Full',
                truncationChars: 1000,
                compactStats: false,
                includeCss: false,
                generateToc: false,
                outputFormat: 'markdown',
            });
            expect(result).toHaveLength(2);
            expect(result[0].content).toBe('msg3');
        });

        it('should apply endIndex filter', () => {
            const conv = makeSkeleton([
                makeMessage('user', 'msg1'),
                makeMessage('assistant', 'msg2'),
                makeMessage('user', 'msg3'),
                makeMessage('assistant', 'msg4'),
            ]);
            const result = classifier.classifyConversationContent(conv, {
                endIndex: 2,
                detailLevel: 'Full',
                truncationChars: 1000,
                compactStats: false,
                includeCss: false,
                generateToc: false,
                outputFormat: 'markdown',
            });
            expect(result).toHaveLength(2);
            expect(result[0].content).toBe('msg1');
            expect(result[1].content).toBe('msg2');
        });

        it('should apply both startIndex and endIndex', () => {
            const conv = makeSkeleton([
                makeMessage('user', 'msg1'),
                makeMessage('assistant', 'msg2'),
                makeMessage('user', 'msg3'),
                makeMessage('assistant', 'msg4'),
                makeMessage('user', 'msg5'),
            ]);
            const result = classifier.classifyConversationContent(conv, {
                startIndex: 2,
                endIndex: 4,
                detailLevel: 'Full',
                truncationChars: 1000,
                compactStats: false,
                includeCss: false,
                generateToc: false,
                outputFormat: 'markdown',
            });
            expect(result).toHaveLength(3);
            expect(result[0].content).toBe('msg2');
            expect(result[1].content).toBe('msg3');
            expect(result[2].content).toBe('msg4');
        });

        it('should warn on invalid range', () => {
            const conv = makeSkeleton([makeMessage('user', 'msg1')]);
            classifier.classifyConversationContent(conv, {
                startIndex: 10,
                endIndex: 20,
                detailLevel: 'Full',
                truncationChars: 1000,
                compactStats: false,
                includeCss: false,
                generateToc: false,
                outputFormat: 'markdown',
            });
            expect(consoleWarnSpy).toHaveBeenCalled();
        });

        it('should set toolType and resultType for ToolResult user messages', () => {
            const conv = makeSkeleton([
                makeMessage('user', '[execute_command] Result: Command executed OK'),
            ]);
            const result = classifier.classifyConversationContent(conv);
            expect(result[0].toolType).toBe('execute_command');
            expect(result[0].resultType).toBeDefined();
        });

        it('should not set toolType for UserMessage', () => {
            const conv = makeSkeleton([makeMessage('user', 'just a normal question')]);
            const result = classifier.classifyConversationContent(conv);
            expect(result[0].toolType).toBeUndefined();
            expect(result[0].resultType).toBeUndefined();
        });

        it('should classify JSON tool result format', () => {
            const jsonContent = '{"tool":"read_file","type":"use_mcp_tool"}';
            const conv = makeSkeleton([makeMessage('user', jsonContent)]);
            const result = classifier.classifyConversationContent(conv);
            expect(result[0].subType).toBe('ToolResult');
        });
    });

    // ====================================================================
    // classifyContentFromMarkdownOrJson
    // ====================================================================
    describe('classifyContentFromMarkdownOrJson', () => {
        it('should fall back to JSON classification when no markdown file found', async () => {
            // fs.promises.access will throw (file not found) for any path
            const fsMock = await import('fs');
            vi.mocked(fsMock.promises.access).mockRejectedValue(new Error('ENOENT'));

            const conv = makeSkeleton([
                makeMessage('user', 'hello'),
                makeMessage('assistant', 'hi there'),
            ]);

            const result = await classifier.classifyContentFromMarkdownOrJson(conv);
            expect(result).toHaveLength(2);
            expect(result[0].type).toBe('User');
            expect(result[1].type).toBe('Assistant');
        });

        it('should use markdown file when found and readable', async () => {
            const fsMock = await import('fs');
            // Make access succeed for any path
            vi.mocked(fsMock.promises.access).mockResolvedValue(undefined);
            // Provide markdown content
            const mdContent = '**User:** Hello world\n\n**Assistant:** I can help you.';
            vi.mocked(fsMock.promises.readFile).mockResolvedValue(mdContent);

            const conv = makeSkeleton([makeMessage('user', 'fallback')]);

            const result = await classifier.classifyContentFromMarkdownOrJson(conv);
            // The markdown parsing should produce classified content from the markdown
            // Even if taskId is not in taskMap, the fallback trace file check may succeed
            expect(result).toBeDefined();
            expect(Array.isArray(result)).toBe(true);
        });

        it('should handle markdown read error gracefully by throwing', async () => {
            const fsMock = await import('fs');
            // access succeeds (file appears to exist)
            vi.mocked(fsMock.promises.access).mockResolvedValue(undefined);
            // readFile fails
            vi.mocked(fsMock.promises.readFile).mockRejectedValue(new Error('read error'));

            const conv = makeSkeleton([makeMessage('user', 'test')]);

            await expect(
                classifier.classifyContentFromMarkdownOrJson(conv)
            ).rejects.toThrow('read error');
        });
    });

    // ====================================================================
    // User subtype detection (via classifyConversationContent)
    // ====================================================================
    describe('User subtype detection edge cases', () => {
        it('should detect [ERROR] case-insensitively', () => {
            const conv = makeSkeleton([makeMessage('user', '[error] Something failed')]);
            const result = classifier.classifyConversationContent(conv);
            expect(result[0].subType).toBe('ErrorMessage');
        });

        it('should detect "1. Previous Conversation:" without bold', () => {
            const conv = makeSkeleton([
                makeMessage('user', '1. Previous Conversation: The user was working on...'),
            ]);
            const result = classifier.classifyConversationContent(conv);
            expect(result[0].subType).toBe('ContextCondensation');
        });

        it('should detect context condensation with numbered bold format', () => {
            const conv = makeSkeleton([
                makeMessage('user', '1. **Previous Conversation:** They discussed...'),
            ]);
            const result = classifier.classifyConversationContent(conv);
            expect(result[0].subType).toBe('ContextCondensation');
        });

        it('should detect ToolResult with for-clause bracket', () => {
            const conv = makeSkeleton([
                makeMessage('user', "[search_files for 'pattern'] Result: 5 matches found"),
            ]);
            const result = classifier.classifyConversationContent(conv);
            expect(result[0].subType).toBe('ToolResult');
        });

        it('should prioritize ToolResult over ErrorMessage', () => {
            // If content starts with bracket result format, it should be ToolResult even if it contains error keywords
            const conv = makeSkeleton([
                makeMessage('user', '[read_file] Result: Error reading file'),
            ]);
            const result = classifier.classifyConversationContent(conv);
            expect(result[0].subType).toBe('ToolResult');
        });
    });

    // ====================================================================
    // Assistant subtype detection edge cases
    // ====================================================================
    describe('Assistant subtype detection edge cases', () => {
        it('should detect attempt_completion anywhere in content', () => {
            const conv = makeSkeleton([
                makeMessage('assistant', 'Here is the result. <attempt_completion><result>All tasks done.</result></attempt_completion>'),
            ]);
            const result = classifier.classifyConversationContent(conv);
            expect(result[0].subType).toBe('Completion');
        });

        it('should default to ToolCall for assistant without completion', () => {
            const conv = makeSkeleton([
                makeMessage('assistant', 'I will analyze the code and provide recommendations.'),
            ]);
            const result = classifier.classifyConversationContent(conv);
            expect(result[0].subType).toBe('ToolCall');
        });
    });
});
