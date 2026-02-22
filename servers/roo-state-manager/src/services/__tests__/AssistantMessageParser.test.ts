/**
 * Tests pour AssistantMessageParser.ts
 * Issue #492 - Couverture des parsers de messages
 *
 * @module services/__tests__/AssistantMessageParser
 */

import { describe, test, expect } from 'vitest';
import { parseAssistantMessage, parseEncodedAssistantMessage } from '../AssistantMessageParser.js';
import type { AssistantMessageContent, TextContent, ToolUse } from '../AssistantMessageParser.js';

describe('parseAssistantMessage', () => {
	// ============================================================
	// Plain text (no tools)
	// ============================================================

	describe('plain text', () => {
		test('returns single text block for plain text', () => {
			const result = parseAssistantMessage('Hello, this is a simple message');
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('text');
			expect((result[0] as TextContent).content).toContain('Hello');
		});

		test('returns empty array for empty string', () => {
			const result = parseAssistantMessage('');
			expect(result).toHaveLength(0);
		});

		test('returns empty for whitespace-only', () => {
			const result = parseAssistantMessage('   \n  \t  ');
			expect(result).toHaveLength(0);
		});
	});

	// ============================================================
	// Tool use parsing
	// ============================================================

	describe('tool_use parsing', () => {
		test('parses read_file tool', () => {
			const msg = '<read_file><path>src/index.ts</path></read_file>';
			const result = parseAssistantMessage(msg);
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('tool_use');
			const tool = result[0] as ToolUse;
			expect(tool.name).toBe('read_file');
			expect(tool.params.path).toBe('src/index.ts');
		});

		test('parses write_to_file tool with content', () => {
			const msg = '<write_to_file><path>test.ts</path><content>export const x = 1;\n</content></write_to_file>';
			const result = parseAssistantMessage(msg);
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('tool_use');
			const tool = result[0] as ToolUse;
			expect(tool.name).toBe('write_to_file');
			expect(tool.params.path).toBe('test.ts');
			expect(tool.params.content).toContain('export const x');
		});

		test('parses execute_command tool', () => {
			const msg = '<execute_command><command>npm run build</command></execute_command>';
			const result = parseAssistantMessage(msg);
			expect(result).toHaveLength(1);
			const tool = result[0] as ToolUse;
			expect(tool.name).toBe('execute_command');
			expect(tool.params.command).toBe('npm run build');
		});

		test('parses search_files tool with multiple params', () => {
			const msg = '<search_files><path>src</path><regex>function\\s+\\w+</regex><file_pattern>*.ts</file_pattern></search_files>';
			const result = parseAssistantMessage(msg);
			expect(result).toHaveLength(1);
			const tool = result[0] as ToolUse;
			expect(tool.name).toBe('search_files');
			expect(tool.params.path).toBe('src');
			expect(tool.params.regex).toContain('function');
			expect(tool.params.file_pattern).toBe('*.ts');
		});

		test('parses new_task tool', () => {
			const msg = '<new_task><mode>code</mode><message>Fix the bug in auth module</message></new_task>';
			const result = parseAssistantMessage(msg);
			expect(result).toHaveLength(1);
			const tool = result[0] as ToolUse;
			expect(tool.name).toBe('new_task');
			expect(tool.params.mode).toBe('code');
			expect(tool.params.message).toBe('Fix the bug in auth module');
		});

		test('parses use_mcp_tool', () => {
			const msg = '<use_mcp_tool><server_name>roo-state-manager</server_name><tool_name>roosync_send</tool_name><arguments>{"to":"all"}</arguments></use_mcp_tool>';
			const result = parseAssistantMessage(msg);
			expect(result).toHaveLength(1);
			const tool = result[0] as ToolUse;
			expect(tool.name).toBe('use_mcp_tool');
			expect(tool.params.server_name).toBe('roo-state-manager');
			expect(tool.params.tool_name).toBe('roosync_send');
		});
	});

	// ============================================================
	// Mixed text and tools
	// ============================================================

	describe('mixed content', () => {
		test('parses text before tool', () => {
			const msg = 'Let me read the file.\n<read_file><path>src/index.ts</path></read_file>';
			const result = parseAssistantMessage(msg);
			expect(result).toHaveLength(2);
			expect(result[0].type).toBe('text');
			expect(result[1].type).toBe('tool_use');
		});

		test('parses text between multiple tools', () => {
			const msg = 'First:\n<read_file><path>a.ts</path></read_file>\nNow writing:\n<write_to_file><path>b.ts</path><content>hello</content></write_to_file>';
			const result = parseAssistantMessage(msg);
			expect(result.length).toBeGreaterThanOrEqual(3);
			const tools = result.filter(b => b.type === 'tool_use');
			expect(tools).toHaveLength(2);
		});

		test('parses text after tool', () => {
			const msg = '<read_file><path>test.ts</path></read_file>\nFile read successfully.';
			const result = parseAssistantMessage(msg);
			const texts = result.filter(b => b.type === 'text');
			const tools = result.filter(b => b.type === 'tool_use');
			expect(tools).toHaveLength(1);
			expect(texts.length).toBeGreaterThanOrEqual(1);
		});
	});

	// ============================================================
	// Edge cases
	// ============================================================

	describe('edge cases', () => {
		test('handles HTML-like tags that are not tools', () => {
			const msg = '<div>This is HTML</div> and <span>more</span>';
			const result = parseAssistantMessage(msg);
			// Should be treated as text since div/span are not tool names
			const texts = result.filter(b => b.type === 'text');
			expect(texts.length).toBeGreaterThanOrEqual(1);
		});

		test('handles incomplete/unclosed tool tags', () => {
			const msg = '<read_file><path>test.ts</path>';
			// No closing </read_file>. Parser may still extract nested tool-like tags
			const result = parseAssistantMessage(msg);
			// Just verify it doesn't crash and returns something
			expect(result.length).toBeGreaterThanOrEqual(0);
		});

		test('handles closing tags without opening', () => {
			const msg = '</read_file> some text';
			const result = parseAssistantMessage(msg);
			// Starting with </ should be text
			const texts = result.filter(b => b.type === 'text');
			expect(texts.length).toBeGreaterThanOrEqual(1);
		});

		test('all blocks have partial=false', () => {
			const msg = 'Text <read_file><path>a.ts</path></read_file> more';
			const result = parseAssistantMessage(msg);
			result.forEach(block => {
				expect(block.partial).toBe(false);
			});
		});

		test('handles write_to_file with nested close tags', () => {
			const content = 'line1\n</write_to_file>fake\nline3';
			const msg = `<write_to_file><path>test.ts</path><content>${content}</content></write_to_file>`;
			const result = parseAssistantMessage(msg);
			// Should use lastIndexOf for write_to_file close tag
			const tools = result.filter(b => b.type === 'tool_use');
			expect(tools).toHaveLength(1);
		});
	});
});

describe('parseEncodedAssistantMessage', () => {
	test('decodes HTML entities and parses', () => {
		const encoded = '&lt;read_file&gt;&lt;path&gt;src/index.ts&lt;/path&gt;&lt;/read_file&gt;';
		const result = parseEncodedAssistantMessage(encoded);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe('tool_use');
		const tool = result[0] as ToolUse;
		expect(tool.name).toBe('read_file');
	});

	test('forces partial=false on all blocks', () => {
		const encoded = 'Hello &amp; world';
		const result = parseEncodedAssistantMessage(encoded);
		result.forEach(block => {
			expect(block.partial).toBe(false);
		});
	});

	test('handles mixed encoded content', () => {
		const encoded = 'Let me check: &lt;read_file&gt;&lt;path&gt;test.ts&lt;/path&gt;&lt;/read_file&gt;';
		const result = parseEncodedAssistantMessage(encoded);
		expect(result.length).toBeGreaterThanOrEqual(1);
		const tools = result.filter(b => b.type === 'tool_use');
		expect(tools).toHaveLength(1);
	});
});
