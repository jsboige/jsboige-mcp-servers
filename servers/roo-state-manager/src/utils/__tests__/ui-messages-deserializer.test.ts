/**
 * Tests pour ui-messages-deserializer.ts
 * Issue #492 - Couverture des utilitaires de parsing
 *
 * @module utils/__tests__/ui-messages-deserializer
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockAccess, mockReadFile } = vi.hoisted(() => ({
	mockAccess: vi.fn(),
	mockReadFile: vi.fn()
}));

vi.mock('fs/promises', () => ({
	default: {
		access: mockAccess,
		readFile: mockReadFile
	},
	access: mockAccess,
	readFile: mockReadFile
}));

import { UIMessagesDeserializer } from '../ui-messages-deserializer.js';

describe('UIMessagesDeserializer', () => {
	let deserializer: UIMessagesDeserializer;

	beforeEach(() => {
		vi.clearAllMocks();
		deserializer = new UIMessagesDeserializer();
	});

	// ============================================================
	// safeJsonParse
	// ============================================================

	describe('safeJsonParse', () => {
		test('parses valid JSON', () => {
			const result = deserializer.safeJsonParse('{"key": "value"}');
			expect(result).toEqual({ key: 'value' });
		});

		test('returns default for null input', () => {
			const result = deserializer.safeJsonParse(null, { fallback: true });
			expect(result).toEqual({ fallback: true });
		});

		test('returns default for undefined input', () => {
			const result = deserializer.safeJsonParse(undefined, 'default');
			expect(result).toBe('default');
		});

		test('returns default for empty string', () => {
			const result = deserializer.safeJsonParse('', { empty: true });
			expect(result).toEqual({ empty: true });
		});

		test('returns default for invalid JSON', () => {
			const result = deserializer.safeJsonParse('not json{{{', 'fallback');
			expect(result).toBe('fallback');
		});

		test('returns undefined when no default provided and input is null', () => {
			const result = deserializer.safeJsonParse(null);
			expect(result).toBeUndefined();
		});

		test('parses arrays', () => {
			const result = deserializer.safeJsonParse('[1, 2, 3]');
			expect(result).toEqual([1, 2, 3]);
		});
	});

	// ============================================================
	// readTaskMessages
	// ============================================================

	describe('readTaskMessages', () => {
		test('returns empty for non-existent file', async () => {
			mockAccess.mockRejectedValue(new Error('ENOENT'));
			const result = await deserializer.readTaskMessages('/fake/path.json');
			expect(result).toEqual([]);
		});

		test('reads and parses valid ui_messages.json', async () => {
			const messages = [
				{ type: 'say', say: 'text', text: 'Hello' },
				{ type: 'ask', ask: 'tool', text: '{"tool":"read_file"}' }
			];
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(JSON.stringify(messages));

			const result = await deserializer.readTaskMessages('/test/ui_messages.json');
			expect(result).toHaveLength(2);
			expect(result[0].text).toBe('Hello');
		});

		test('returns empty for non-array JSON', async () => {
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue('{"not": "an array"}');

			const result = await deserializer.readTaskMessages('/test/ui_messages.json');
			expect(result).toEqual([]);
		});

		test('returns empty on parse error', async () => {
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue('invalid json{{{');

			const result = await deserializer.readTaskMessages('/test/ui_messages.json');
			expect(result).toEqual([]);
		});
	});

	// ============================================================
	// extractToolCalls
	// ============================================================

	describe('extractToolCalls', () => {
		test('extracts tool calls from ask:tool messages', () => {
			const messages = [
				{ type: 'ask', ask: 'tool', text: '{"tool":"read_file","path":"/test"}', ts: 1000 },
				{ type: 'say', say: 'text', text: 'Just text' },
				{ type: 'ask', ask: 'tool', text: '{"tool":"write_to_file","content":"hello"}', ts: 2000 }
			] as any[];

			const result = deserializer.extractToolCalls(messages);
			expect(result).toHaveLength(2);
			expect(result[0].tool).toBe('read_file');
			expect(result[1].tool).toBe('write_to_file');
		});

		test('skips messages without text', () => {
			const messages = [
				{ type: 'ask', ask: 'tool' }
			] as any[];
			expect(deserializer.extractToolCalls(messages)).toHaveLength(0);
		});

		test('skips messages with invalid JSON in text', () => {
			const messages = [
				{ type: 'ask', ask: 'tool', text: 'not json' }
			] as any[];
			expect(deserializer.extractToolCalls(messages)).toHaveLength(0);
		});

		test('extracts timestamp from ts field', () => {
			const messages = [
				{ type: 'ask', ask: 'tool', text: '{"tool":"read_file"}', ts: 12345 }
			] as any[];
			const result = deserializer.extractToolCalls(messages);
			expect(result[0].timestamp).toBe(12345);
		});

		test('extracts mode and message fields', () => {
			const messages = [
				{
					type: 'ask', ask: 'tool',
					text: '{"tool":"newTask","mode":"code","message":"Fix the bug"}',
					ts: 1000
				}
			] as any[];
			const result = deserializer.extractToolCalls(messages);
			expect(result[0].mode).toBe('code');
			expect(result[0].message).toBe('Fix the bug');
		});

		test('supports content field as fallback for message', () => {
			const messages = [
				{
					type: 'ask', ask: 'tool',
					text: '{"tool":"newTask","mode":"code","content":"Fix via content field"}',
					ts: 1000
				}
			] as any[];
			const result = deserializer.extractToolCalls(messages);
			expect(result[0].message).toBe('Fix via content field');
		});
	});

	// ============================================================
	// extractNewTasks
	// ============================================================

	describe('extractNewTasks', () => {
		test('extracts new_task tool calls', () => {
			const messages = [
				{
					type: 'ask', ask: 'tool',
					text: '{"tool":"new_task","mode":"code","message":"Build the auth module"}',
					ts: 1000
				},
				{
					type: 'ask', ask: 'tool',
					text: '{"tool":"read_file","path":"/test"}',
					ts: 2000
				}
			] as any[];

			const result = deserializer.extractNewTasks(messages);
			expect(result).toHaveLength(1);
			expect(result[0].mode).toBe('code');
			expect(result[0].message).toBe('Build the auth module');
		});

		test('also recognizes newTask (camelCase)', () => {
			const messages = [
				{
					type: 'ask', ask: 'tool',
					text: '{"tool":"newTask","mode":"debug","message":"Debug the issue"}',
					ts: 1000
				}
			] as any[];

			const result = deserializer.extractNewTasks(messages);
			expect(result).toHaveLength(1);
			expect(result[0].mode).toBe('debug');
		});

		test('skips tasks without mode or message', () => {
			const messages = [
				{ type: 'ask', ask: 'tool', text: '{"tool":"new_task"}', ts: 1000 },
				{ type: 'ask', ask: 'tool', text: '{"tool":"new_task","mode":"code"}', ts: 2000 }
			] as any[];

			const result = deserializer.extractNewTasks(messages);
			expect(result).toHaveLength(0);
		});
	});

	// ============================================================
	// extractUserMessages
	// ============================================================

	describe('extractUserMessages', () => {
		test('extracts ask messages without ask subtype', () => {
			const messages = [
				{ type: 'ask', text: 'User question' },
				{ type: 'ask', ask: 'tool', text: '{}' },
				{ type: 'say', text: 'Response' },
				{ type: 'ask', text: 'Another question' }
			] as any[];

			const result = deserializer.extractUserMessages(messages);
			expect(result).toHaveLength(2);
			expect(result[0].text).toBe('User question');
		});
	});

	// ============================================================
	// extractErrors
	// ============================================================

	describe('extractErrors', () => {
		test('extracts say:error messages', () => {
			const messages = [
				{ type: 'say', say: 'error', text: 'Something failed' },
				{ type: 'say', say: 'text', text: 'Normal text' },
				{ type: 'say', say: 'error', text: 'Another error' }
			] as any[];

			const result = deserializer.extractErrors(messages);
			expect(result).toHaveLength(2);
		});
	});

	// ============================================================
	// getInitialInstruction
	// ============================================================

	describe('getInitialInstruction', () => {
		test('returns first user message text', () => {
			const messages = [
				{ type: 'ask', text: 'Build the notification system' },
				{ type: 'say', say: 'text', text: 'Starting...' },
				{ type: 'ask', text: 'Second question' }
			] as any[];

			expect(deserializer.getInitialInstruction(messages)).toBe('Build the notification system');
		});

		test('returns undefined when no user messages', () => {
			const messages = [
				{ type: 'say', say: 'text', text: 'Response' }
			] as any[];

			expect(deserializer.getInitialInstruction(messages)).toBeUndefined();
		});
	});

	// ============================================================
	// getMessageStats
	// ============================================================

	describe('getMessageStats', () => {
		test('counts all message types', () => {
			const messages = [
				{ type: 'ask', text: 'Question' },
				{ type: 'ask', ask: 'tool', text: '{"tool":"read_file"}' },
				{ type: 'say', say: 'text', text: 'Response' },
				{ type: 'say', say: 'api_req_started', text: '{"request":"..."}' },
				{ type: 'say', say: 'error', text: 'Error' }
			] as any[];

			const stats = deserializer.getMessageStats(messages);
			expect(stats.total).toBe(5);
			expect(stats.askMessages).toBe(2);
			expect(stats.sayMessages).toBe(3);
			expect(stats.toolCalls).toBe(1);
			expect(stats.errors).toBe(1);
		});

		test('returns zeros for empty array', () => {
			const stats = deserializer.getMessageStats([]);
			expect(stats.total).toBe(0);
			expect(stats.askMessages).toBe(0);
			expect(stats.sayMessages).toBe(0);
		});
	});
});
