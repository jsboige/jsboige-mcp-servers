/**
 * Tests for minimal-test.tool.ts
 * Issue #492 - Coverage for minimal test tool
 *
 * @module tools/test/__tests__/minimal-test.tool
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { minimal_test_tool, MinimalTestToolSchema } from '../minimal-test.tool.js';

describe('minimal_test_tool', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ============================================================
	// Tool definition
	// ============================================================

	describe('tool definition', () => {
		test('has correct name', () => {
			expect(minimal_test_tool.definition.name).toBe('minimal_test_tool');
		});

		test('has description', () => {
			expect(minimal_test_tool.definition.description).toBeTruthy();
		});

		test('requires message parameter', () => {
			expect(minimal_test_tool.definition.inputSchema.required).toContain('message');
		});

		test('has string message property', () => {
			const props = minimal_test_tool.definition.inputSchema.properties as any;
			expect(props.message.type).toBe('string');
		});
	});

	// ============================================================
	// Zod schema
	// ============================================================

	describe('MinimalTestToolSchema', () => {
		test('accepts valid input', () => {
			const result = MinimalTestToolSchema.parse({ message: 'hello' });
			expect(result.message).toBe('hello');
		});

		test('rejects missing message', () => {
			expect(() => MinimalTestToolSchema.parse({})).toThrow();
		});

		test('rejects non-string message', () => {
			expect(() => MinimalTestToolSchema.parse({ message: 123 })).toThrow();
		});
	});

	// ============================================================
	// Handler
	// ============================================================

	describe('handler', () => {
		test('returns success content', async () => {
			const result = await minimal_test_tool.handler({ message: 'Test message' });

			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe('text');
		});

		test('includes the message in output', async () => {
			const result = await minimal_test_tool.handler({ message: 'Hello World' });
			const text = result.content[0].text;

			expect(text).toContain('Hello World');
		});

		test('includes timestamp in output', async () => {
			const result = await minimal_test_tool.handler({ message: 'test' });
			const text = result.content[0].text;

			// Should contain an ISO timestamp
			expect(text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		});

		test('includes success status', async () => {
			const result = await minimal_test_tool.handler({ message: 'test' });
			const text = result.content[0].text;

			expect(text).toContain('Succès');
		});

		test('returns markdown formatted text', async () => {
			const result = await minimal_test_tool.handler({ message: 'test' });
			const text = result.content[0].text;

			// Should contain markdown headers
			expect(text).toContain('# Test Minimal MCP');
			expect(text).toContain('**Message:**');
			expect(text).toContain('**Timestamp:**');
		});

		test('handles special characters in message', async () => {
			const result = await minimal_test_tool.handler({ message: 'Test <script>alert("xss")</script>' });
			const text = result.content[0].text;

			expect(text).toContain('Test <script>alert("xss")</script>');
		});

		test('handles empty string message', async () => {
			const result = await minimal_test_tool.handler({ message: '' });

			expect(result.content).toHaveLength(1);
			expect(result.content[0].text).toContain('**Message:**');
		});
	});
});
