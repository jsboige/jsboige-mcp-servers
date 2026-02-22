/**
 * Tests pour XmlParsingService.ts
 * Issue #492 - Couverture du service de parsing XML
 *
 * @module services/__tests__/XmlParsingService
 */

import { describe, test, expect } from 'vitest';
import { XmlParsingService } from '../XmlParsingService.js';

describe('XmlParsingService', () => {
	let service: XmlParsingService;

	// Fresh instance for each describe block
	function createService(): XmlParsingService {
		return new XmlParsingService();
	}

	// ============================================================
	// isValidToolCall
	// ============================================================

	describe('isValidToolCall', () => {
		test('returns true for read_file', () => {
			service = createService();
			expect(service.isValidToolCall('<read_file><path>test.ts</path></read_file>')).toBe(true);
		});

		test('returns true for write_to_file', () => {
			service = createService();
			expect(service.isValidToolCall('<write_to_file><path>test.ts</path><content>hello</content></write_to_file>')).toBe(true);
		});

		test('returns true for execute_command', () => {
			service = createService();
			expect(service.isValidToolCall('<execute_command><command>ls</command></execute_command>')).toBe(true);
		});

		test('returns true for search_files', () => {
			service = createService();
			expect(service.isValidToolCall('<search_files><path>src</path></search_files>')).toBe(true);
		});

		test('returns true for use_mcp_tool', () => {
			service = createService();
			expect(service.isValidToolCall('<use_mcp_tool><server_name>roo</server_name></use_mcp_tool>')).toBe(true);
		});

		test('returns true for generic XML with matching open/close tags', () => {
			service = createService();
			expect(service.isValidToolCall('<custom_tool>content</custom_tool>')).toBe(true);
		});

		test('returns false for empty string', () => {
			service = createService();
			expect(service.isValidToolCall('')).toBe(false);
		});

		test('returns false for null/undefined', () => {
			service = createService();
			expect(service.isValidToolCall(null as any)).toBe(false);
			expect(service.isValidToolCall(undefined as any)).toBe(false);
		});

		test('returns false for plain text without XML', () => {
			service = createService();
			expect(service.isValidToolCall('Just a plain text message')).toBe(false);
		});

		test('returns false for non-string input', () => {
			service = createService();
			expect(service.isValidToolCall(42 as any)).toBe(false);
		});
	});

	// ============================================================
	// extractToolName
	// ============================================================

	describe('extractToolName', () => {
		test('extracts tool name from read_file', () => {
			service = createService();
			expect(service.extractToolName('<read_file><path>test.ts</path></read_file>')).toBe('read_file');
		});

		test('extracts tool name from write_to_file', () => {
			service = createService();
			expect(service.extractToolName('<write_to_file><path>a.ts</path><content>x</content></write_to_file>')).toBe('write_to_file');
		});

		test('extracts tool name from execute_command', () => {
			service = createService();
			expect(service.extractToolName('<execute_command><command>npm run build</command></execute_command>')).toBe('execute_command');
		});

		test('returns null for empty string', () => {
			service = createService();
			expect(service.extractToolName('')).toBeNull();
		});

		test('returns null for non-XML content', () => {
			service = createService();
			expect(service.extractToolName('plain text')).toBeNull();
		});
	});

	// ============================================================
	// parseToolCall
	// ============================================================

	describe('parseToolCall', () => {
		test('parses read_file successfully', () => {
			service = createService();
			const result = service.parseToolCall('<read_file><path>src/index.ts</path></read_file>');
			expect(result.success).toBe(true);
			expect(result.toolName).toBe('read_file');
			expect(result.arguments).toBeDefined();
			expect(result.arguments!.path).toBe('src/index.ts');
		});

		test('parses execute_command with arguments', () => {
			service = createService();
			const result = service.parseToolCall('<execute_command><command>npm run build</command></execute_command>');
			expect(result.success).toBe(true);
			expect(result.toolName).toBe('execute_command');
			expect(result.arguments!.command).toBe('npm run build');
		});

		test('parses search_files with multiple params', () => {
			service = createService();
			const result = service.parseToolCall('<search_files><path>src</path><regex>function</regex></search_files>');
			expect(result.success).toBe(true);
			expect(result.toolName).toBe('search_files');
			expect(result.arguments!.path).toBe('src');
			expect(result.arguments!.regex).toBe('function');
		});

		test('returns error for empty content', () => {
			service = createService();
			const result = service.parseToolCall('');
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});

		test('returns error for non-tool content', () => {
			service = createService();
			const result = service.parseToolCall('Just a plain message');
			expect(result.success).toBe(false);
		});

		test('preserves rawContent', () => {
			service = createService();
			const xml = '<read_file><path>test.ts</path></read_file>';
			const result = service.parseToolCall(xml);
			expect(result.rawContent).toBe(xml);
		});
	});

	// ============================================================
	// extractArguments
	// ============================================================

	describe('extractArguments', () => {
		test('extracts arguments from valid XML', () => {
			service = createService();
			const args = service.extractArguments('<read_file><path>src/index.ts</path></read_file>');
			expect(args).toBeDefined();
			expect(args!.path).toBe('src/index.ts');
		});

		test('returns null for invalid content', () => {
			service = createService();
			expect(service.extractArguments('not xml')).toBeNull();
		});

		test('returns null for empty string', () => {
			service = createService();
			expect(service.extractArguments('')).toBeNull();
		});
	});

	// ============================================================
	// createToolCallDetails
	// ============================================================

	describe('createToolCallDetails', () => {
		test('creates details for valid tool call', () => {
			service = createService();
			const details = service.createToolCallDetails('<read_file><path>test.ts</path></read_file>');
			expect(details.toolName).toBe('read_file');
			expect(details.parseSuccess).toBe(true);
			expect(details.rawXml).toContain('read_file');
			expect(details.parseError).toBeUndefined();
		});

		test('creates details with unknown for invalid XML', () => {
			service = createService();
			const details = service.createToolCallDetails('plain text');
			expect(details.toolName).toBe('unknown');
			expect(details.parseSuccess).toBe(false);
			expect(details.parseError).toBeDefined();
		});

		test('always includes rawXml', () => {
			service = createService();
			const xml = '<execute_command><command>ls</command></execute_command>';
			const details = service.createToolCallDetails(xml);
			expect(details.rawXml).toBe(xml);
		});

		test('always includes arguments object', () => {
			service = createService();
			const details = service.createToolCallDetails('<read_file><path>a.ts</path></read_file>');
			expect(details.arguments).toBeDefined();
			expect(typeof details.arguments).toBe('object');
		});
	});
});
