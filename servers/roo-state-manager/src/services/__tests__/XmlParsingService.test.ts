/**
 * Tests for XmlParsingService
 * Issue #813 - Recovery of destroyed code
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { XmlParsingService } from '../XmlParsingService.js';

describe('XmlParsingService', () => {
	let parser: XmlParsingService;

	beforeEach(() => {
		parser = new XmlParsingService();
	});

	describe('isValidToolCall', () => {
		test('detects read_file tool call', () => {
			expect(parser.isValidToolCall('<read_file><path>test.ts</path></read_file>')).toBe(true);
		});

		test('detects write_to_file tool call', () => {
			expect(parser.isValidToolCall('<write_to_file><path>test.ts</path><content>x</content></write_to_file>')).toBe(true);
		});

		test('detects execute_command tool call', () => {
			expect(parser.isValidToolCall('<execute_command><command>ls</command></execute_command>')).toBe(true);
		});

		test('detects generic XML tool call', () => {
			expect(parser.isValidToolCall('<custom_tool><arg>val</arg></custom_tool>')).toBe(true);
		});

		test('rejects plain text', () => {
			expect(parser.isValidToolCall('This is just plain text')).toBe(false);
		});

		test('rejects empty string', () => {
			expect(parser.isValidToolCall('')).toBe(false);
		});

		test('rejects null/undefined', () => {
			expect(parser.isValidToolCall(null as any)).toBe(false);
			expect(parser.isValidToolCall(undefined as any)).toBe(false);
		});
	});

	describe('parseToolCall', () => {
		test('parses simple tool call', () => {
			const result = parser.parseToolCall('<read_file><path>src/index.ts</path></read_file>');
			expect(result.success).toBe(true);
			expect(result.toolName).toBe('read_file');
			expect(result.arguments).toHaveProperty('path', 'src/index.ts');
		});

		test('parses tool call with multiple arguments', () => {
			const xml = '<write_to_file><path>test.ts</path><content>hello world</content></write_to_file>';
			const result = parser.parseToolCall(xml);
			expect(result.success).toBe(true);
			expect(result.toolName).toBe('write_to_file');
			expect(result.arguments?.path).toBe('test.ts');
			expect(result.arguments?.content).toBe('hello world');
		});

		test('returns error for invalid XML', () => {
			const result = parser.parseToolCall('not xml at all');
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});

		test('returns error for empty content', () => {
			const result = parser.parseToolCall('');
			expect(result.success).toBe(false);
			expect(result.error).toContain('vide');
		});

		test('preserves rawContent', () => {
			const xml = '<read_file><path>x</path></read_file>';
			const result = parser.parseToolCall(xml);
			expect(result.rawContent).toBe(xml);
		});
	});

	describe('extractToolName', () => {
		test('extracts tool name from valid XML', () => {
			expect(parser.extractToolName('<read_file><path>x</path></read_file>')).toBe('read_file');
		});

		test('extracts tool name from whitespaced XML', () => {
			expect(parser.extractToolName('  <execute_command><cmd>ls</cmd></execute_command>  ')).toBe('execute_command');
		});

		test('returns null for invalid content', () => {
			expect(parser.extractToolName('plain text')).toBe(null);
		});

		test('returns null for empty string', () => {
			expect(parser.extractToolName('')).toBe(null);
		});
	});

	describe('extractArguments', () => {
		test('extracts arguments from valid tool call', () => {
			const args = parser.extractArguments('<read_file><path>test.ts</path></read_file>');
			expect(args).toEqual({ path: 'test.ts' });
		});

		test('returns null for invalid content', () => {
			expect(parser.extractArguments('not xml')).toBe(null);
		});
	});

	describe('createToolCallDetails', () => {
		test('creates details for valid tool call', () => {
			const details = parser.createToolCallDetails('<read_file><path>x</path></read_file>');
			expect(details.toolName).toBe('read_file');
			expect(details.parseSuccess).toBe(true);
			expect(details.rawXml).toContain('read_file');
		});

		test('creates details with error for invalid content', () => {
			const details = parser.createToolCallDetails('plain text');
			expect(details.toolName).toBe('unknown');
			expect(details.parseSuccess).toBe(false);
			expect(details.parseError).toBeDefined();
		});
	});

	describe('anti-stub checks', () => {
		test('parseToolCall produces different results for different inputs', () => {
			const r1 = parser.parseToolCall('<read_file><path>a.ts</path></read_file>');
			const r2 = parser.parseToolCall('<write_to_file><path>b.ts</path><content>x</content></write_to_file>');

			expect(r1.toolName).not.toBe(r2.toolName);
			expect(Object.keys(r1.arguments || {}).length).not.toBe(Object.keys(r2.arguments || {}).length);
		});
	});
});
