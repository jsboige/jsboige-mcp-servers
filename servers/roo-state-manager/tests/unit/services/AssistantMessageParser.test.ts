/**
 * Tests unitaires pour AssistantMessageParser
 * Parse les messages assistant XML de Roo (tool_use + texte)
 */
import { describe, it, expect } from 'vitest';
import {
    parseAssistantMessage,
    parseEncodedAssistantMessage,
    type TextContent,
    type ToolUse
} from '../../../src/services/AssistantMessageParser.js';

describe('parseAssistantMessage', () => {
    describe('text-only messages', () => {
        it('should parse plain text without any tags', () => {
            const result = parseAssistantMessage('Hello, this is a simple message.');
            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('text');
            expect((result[0] as TextContent).content).toBe('Hello, this is a simple message.');
        });

        it('should return empty array for empty string', () => {
            const result = parseAssistantMessage('');
            expect(result).toHaveLength(0);
        });

        it('should return empty array for whitespace-only string', () => {
            const result = parseAssistantMessage('   \n  \t  ');
            expect(result).toHaveLength(0);
        });

        it('should preserve text with special characters', () => {
            const result = parseAssistantMessage('Use `code` and "quotes" & more');
            expect(result).toHaveLength(1);
            expect((result[0] as TextContent).content).toContain('&');
        });
    });

    describe('single tool parsing', () => {
        it('should parse a tool with underscore in name', () => {
            const msg = '<read_file><path>src/index.ts</path></read_file>';
            const result = parseAssistantMessage(msg);
            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('tool_use');
            const tool = result[0] as ToolUse;
            expect(tool.name).toBe('read_file');
            expect(tool.params.path).toBe('src/index.ts');
        });

        it('should parse a tool with multiple parameters', () => {
            const msg = '<search_files><path>src/</path><regex>function\\s+\\w+</regex><file_pattern>*.ts</file_pattern></search_files>';
            const result = parseAssistantMessage(msg);
            expect(result).toHaveLength(1);
            const tool = result[0] as ToolUse;
            expect(tool.name).toBe('search_files');
            expect(tool.params.path).toBe('src/');
            expect(tool.params.regex).toBe('function\\s+\\w+');
            expect(tool.params.file_pattern).toBe('*.ts');
        });

        it('should parse whitelisted tool names without underscore', () => {
            // 'file', 'path', 'task', 'args' are in the whitelist
            const msg = '<task><command>run tests</command></task>';
            const result = parseAssistantMessage(msg);
            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('tool_use');
            expect((result[0] as ToolUse).name).toBe('task');
        });
    });

    describe('text + tool interleaving', () => {
        it('should parse text before a tool', () => {
            const msg = 'I will read the file now.\n<read_file><path>test.ts</path></read_file>';
            const result = parseAssistantMessage(msg);
            expect(result).toHaveLength(2);
            expect(result[0].type).toBe('text');
            expect((result[0] as TextContent).content).toContain('I will read the file');
            expect(result[1].type).toBe('tool_use');
        });

        it('should parse text after a tool', () => {
            const msg = '<read_file><path>test.ts</path></read_file>\nHere is what I found.';
            const result = parseAssistantMessage(msg);
            expect(result).toHaveLength(2);
            expect(result[0].type).toBe('tool_use');
            expect(result[1].type).toBe('text');
            expect((result[1] as TextContent).content).toContain('Here is what I found');
        });

        it('should parse text-tool-text pattern', () => {
            const msg = 'Before.\n<read_file><path>a.ts</path></read_file>\nAfter.';
            const result = parseAssistantMessage(msg);
            expect(result).toHaveLength(3);
            expect(result[0].type).toBe('text');
            expect(result[1].type).toBe('tool_use');
            expect(result[2].type).toBe('text');
        });
    });

    describe('multiple tools', () => {
        it('should parse consecutive tools', () => {
            const msg = '<read_file><path>a.ts</path></read_file><read_file><path>b.ts</path></read_file>';
            const result = parseAssistantMessage(msg);
            expect(result).toHaveLength(2);
            expect(result[0].type).toBe('tool_use');
            expect(result[1].type).toBe('tool_use');
            expect((result[0] as ToolUse).params.path).toBe('a.ts');
            expect((result[1] as ToolUse).params.path).toBe('b.ts');
        });
    });

    describe('write_to_file special handling', () => {
        it('should use lastIndexOf for write_to_file closing tag', () => {
            // Content contains a nested </write_to_file> string
            const fileContent = 'line1\n</write_to_file>\nline3';
            const msg = `<write_to_file><path>test.ts</path><content>${fileContent}</content></write_to_file>`;
            const result = parseAssistantMessage(msg);
            expect(result).toHaveLength(1);
            const tool = result[0] as ToolUse;
            expect(tool.name).toBe('write_to_file');
            // The content param should include the nested tag as part of the value
            expect(tool.params.content).toContain('</write_to_file>');
        });
    });

    describe('content parameter preservation', () => {
        it('should preserve newlines in content parameter', () => {
            const content = '\nline1\nline2\n  indented\n';
            const msg = `<write_to_file><path>test.ts</path><content>${content}</content></write_to_file>`;
            const result = parseAssistantMessage(msg);
            const tool = result[0] as ToolUse;
            expect(tool.params.content).toBe(content);
        });

        it('should trim non-content parameters', () => {
            const msg = '<read_file><path>  src/index.ts  </path></read_file>';
            const result = parseAssistantMessage(msg);
            const tool = result[0] as ToolUse;
            expect(tool.params.path).toBe('src/index.ts');
        });
    });

    describe('non-tool tags', () => {
        it('should treat tags without underscore as text', () => {
            const msg = 'Use <bold>text</bold> for emphasis';
            const result = parseAssistantMessage(msg);
            // <bold> doesn't have _ and isn't in whitelist, treated as text
            expect(result.length).toBeGreaterThanOrEqual(1);
            const allText = result.filter(r => r.type === 'text');
            expect(allText.length).toBeGreaterThan(0);
        });

        it('should skip closing tags (</...>)', () => {
            const msg = 'some text </orphan> more text';
            const result = parseAssistantMessage(msg);
            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('text');
        });

        it('should skip comment tags (<!...>)', () => {
            const msg = 'before <!-- comment --> after';
            const result = parseAssistantMessage(msg);
            const texts = result.filter(r => r.type === 'text');
            expect(texts.length).toBeGreaterThanOrEqual(1);
        });

        it('should skip processing instructions (<?...>)', () => {
            const msg = 'before <?xml version="1.0"?> after';
            const result = parseAssistantMessage(msg);
            const texts = result.filter(r => r.type === 'text');
            expect(texts.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('edge cases', () => {
        it('should handle unclosed tool tag (no closing tag)', () => {
            const msg = 'text <read_file><path>test.ts</path> no closing';
            const result = parseAssistantMessage(msg);
            // Should fall back to text since no closing </read_file>
            const texts = result.filter(r => r.type === 'text');
            expect(texts.length).toBeGreaterThanOrEqual(1);
        });

        it('should handle tag at end without closing >', () => {
            const msg = 'some text <read_file';
            const result = parseAssistantMessage(msg);
            expect(result.length).toBeGreaterThanOrEqual(1);
        });

        it('should handle lone < at end of message', () => {
            const msg = 'some text <';
            const result = parseAssistantMessage(msg);
            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('text');
        });

        it('should set partial to false for all blocks', () => {
            const msg = 'text <read_file><path>a.ts</path></read_file> more text';
            const result = parseAssistantMessage(msg);
            for (const block of result) {
                expect(block.partial).toBe(false);
            }
        });

        it('should handle missing parameter (not in toolParamNames)', () => {
            const msg = '<read_file><unknown_param>value</unknown_param><path>test.ts</path></read_file>';
            const result = parseAssistantMessage(msg);
            const tool = result[0] as ToolUse;
            // unknown_param should not be in params
            expect(tool.params.path).toBe('test.ts');
            expect(tool.params).not.toHaveProperty('unknown_param');
        });
    });
});

describe('parseEncodedAssistantMessage', () => {
    it('should decode HTML entities and parse', () => {
        const encoded = '&lt;read_file&gt;&lt;path&gt;test.ts&lt;/path&gt;&lt;/read_file&gt;';
        const result = parseEncodedAssistantMessage(encoded);
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('tool_use');
        expect((result[0] as ToolUse).name).toBe('read_file');
        expect((result[0] as ToolUse).params.path).toBe('test.ts');
    });

    it('should decode &amp; entities', () => {
        const encoded = 'text with &amp; ampersand';
        const result = parseEncodedAssistantMessage(encoded);
        expect(result).toHaveLength(1);
        expect((result[0] as TextContent).content).toContain('& ampersand');
    });

    it('should force partial=false on all blocks', () => {
        const encoded = 'Hello &lt;read_file&gt;&lt;path&gt;a.ts&lt;/path&gt;&lt;/read_file&gt; World';
        const result = parseEncodedAssistantMessage(encoded);
        for (const block of result) {
            expect(block.partial).toBe(false);
        }
    });

    it('should handle passthrough (no encoding)', () => {
        const plain = 'just plain text, no encoding';
        const result = parseEncodedAssistantMessage(plain);
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('text');
    });
});
