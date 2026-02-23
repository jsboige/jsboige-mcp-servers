/**
 * Tests for debug-analyze.tool.ts
 * Issue #492 - Coverage for debug analyze conversation tool
 *
 * @module tools/conversation/__tests__/debug-analyze.tool
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { debugAnalyzeTool } from '../debug-analyze.tool.js';
import { ConversationSkeleton } from '../../../types/conversation.js';
import { GenericError } from '../../../types/errors.js';

describe('debugAnalyzeTool', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ============================================================
	// Tool definition
	// ============================================================

	describe('tool definition', () => {
		test('has correct name', () => {
			expect(debugAnalyzeTool.definition.name).toBe('debug_analyze_conversation');
		});

		test('has description', () => {
			expect(debugAnalyzeTool.definition.description).toBeTruthy();
		});

		test('requires taskId parameter', () => {
			expect(debugAnalyzeTool.definition.inputSchema.required).toContain('taskId');
		});

		test('taskId is string type', () => {
			const props = debugAnalyzeTool.definition.inputSchema.properties as any;
			expect(props.taskId.type).toBe('string');
		});
	});

	// ============================================================
	// Handler
	// ============================================================

	describe('handler', () => {
		function createMockSkeleton(taskId: string, overrides?: Partial<ConversationSkeleton>): ConversationSkeleton {
			return {
				taskId,
				parentTaskId: null,
				metadata: {
					conversationId: 'conv-1',
					mode: 'code',
					workspace: '/test',
					taskInstruction: 'Test instruction',
					timestamp: '2024-01-01T00:00:00Z',
					messageCount: 5,
					totalContentSize: 1000,
					tokenEstimate: 250,
					createdAt: '2024-01-01T00:00:00Z',
					updatedAt: '2024-01-01T01:00:00Z'
				},
				messages: [],
				...overrides
			} as ConversationSkeleton;
		}

		test('returns skeleton for existing task', async () => {
			const cache = new Map<string, ConversationSkeleton>();
			const skeleton = createMockSkeleton('task-123');
			cache.set('task-123', skeleton);

			const result = await debugAnalyzeTool.handler({ taskId: 'task-123' }, cache);

			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe('text');

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.taskId).toBe('task-123');
			expect(parsed.metadata.mode).toBe('code');
		});

		test('returns pretty-printed JSON', async () => {
			const cache = new Map<string, ConversationSkeleton>();
			cache.set('task-1', createMockSkeleton('task-1'));

			const result = await debugAnalyzeTool.handler({ taskId: 'task-1' }, cache);
			const text = result.content[0].text;

			// Pretty-printed JSON should have newlines and indentation
			expect(text).toContain('\n');
			expect(text).toContain('  ');
		});

		test('throws GenericError for missing task', async () => {
			const cache = new Map<string, ConversationSkeleton>();

			await expect(
				debugAnalyzeTool.handler({ taskId: 'nonexistent' }, cache)
			).rejects.toThrow(GenericError);
		});

		test('error message includes task ID', async () => {
			const cache = new Map<string, ConversationSkeleton>();

			try {
				await debugAnalyzeTool.handler({ taskId: 'missing-task-xyz' }, cache);
				expect.fail('Should have thrown');
			} catch (error: any) {
				expect(error.message).toContain('missing-task-xyz');
			}
		});

		test('returns full skeleton data including messages', async () => {
			const cache = new Map<string, ConversationSkeleton>();
			const skeleton = createMockSkeleton('task-2', {
				messages: [
					{ role: 'user', content: 'Hello' } as any,
					{ role: 'assistant', content: 'Hi there' } as any
				]
			});
			cache.set('task-2', skeleton);

			const result = await debugAnalyzeTool.handler({ taskId: 'task-2' }, cache);
			const parsed = JSON.parse(result.content[0].text);

			expect(parsed.messages).toHaveLength(2);
			expect(parsed.messages[0].role).toBe('user');
		});

		test('works with empty cache', async () => {
			const cache = new Map<string, ConversationSkeleton>();

			await expect(
				debugAnalyzeTool.handler({ taskId: 'any-id' }, cache)
			).rejects.toThrow();
		});

		test('returns correct skeleton among multiple', async () => {
			const cache = new Map<string, ConversationSkeleton>();
			cache.set('task-a', createMockSkeleton('task-a'));
			cache.set('task-b', createMockSkeleton('task-b'));
			cache.set('task-c', createMockSkeleton('task-c'));

			const result = await debugAnalyzeTool.handler({ taskId: 'task-b' }, cache);
			const parsed = JSON.parse(result.content[0].text);

			expect(parsed.taskId).toBe('task-b');
		});
	});
});
