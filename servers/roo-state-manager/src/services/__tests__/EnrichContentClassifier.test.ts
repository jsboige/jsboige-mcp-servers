/**
 * Tests for EnrichContentClassifier
 * Issue #813 - Recovery of destroyed code
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { EnrichContentClassifier } from '../EnrichContentClassifier.js';
import { ConversationSkeleton } from '../../types/conversation.js';

describe('EnrichContentClassifier', () => {
	let classifier: EnrichContentClassifier;

	beforeEach(() => {
		classifier = new EnrichContentClassifier();
	});

	describe('classifyMessage', () => {
		test('classifies user message', async () => {
			const result = await classifier.classifyMessage('Please help me fix this bug', 'user', 0);
			expect(result.type).toBe('User');
			expect(result.subType).toBe('UserMessage');
			expect(result.contentSize).toBe('Please help me fix this bug'.length);
			expect(result.confidenceScore).toBeGreaterThan(0);
			expect(result.confidenceScore).toBeLessThanOrEqual(1);
		});

		test('classifies tool result from user message', async () => {
			const content = "[read_file for 'src/index.ts'] Result:\nFile content here";
			const result = await classifier.classifyMessage(content, 'user', 0);
			expect(result.type).toBe('User');
			expect(result.subType).toBe('ToolResult');
			expect(result.toolResultDetails).toBeDefined();
		});

		test('classifies assistant completion message', async () => {
			const content = '<attempt_completion>Task completed successfully</attempt_completion>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);
			expect(result.type).toBe('Assistant');
			expect(result.subType).toBe('Completion');
			expect(result.confidenceScore).toBeGreaterThan(0.9);
		});

		test('classifies assistant thinking message', async () => {
			const content = '<thinking>Let me analyze the code structure</thinking>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);
			expect(result.type).toBe('Assistant');
			expect(result.subType).toBe('Thinking');
		});

		test('classifies assistant tool call', async () => {
			const content = '<read_file><path>src/index.ts</path></read_file>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);
			expect(result.type).toBe('Assistant');
			expect(result.subType).toBe('ToolCall');
			expect(result.toolCallDetails).toBeDefined();
			expect(result.toolCallDetails?.toolName).toBe('read_file');
		});

		test('defaults assistant to Completion', async () => {
			const content = 'Here is the explanation of how the code works.';
			const result = await classifier.classifyMessage(content, 'assistant', 0);
			expect(result.type).toBe('Assistant');
			expect(result.subType).toBe('Completion');
		});

		test('sets correct index', async () => {
			const result = await classifier.classifyMessage('test', 'user', 42);
			expect(result.index).toBe(42);
		});

		test('evaluates relevance — short content is irrelevant', async () => {
			const result = await classifier.classifyMessage('hi', 'user', 0);
			expect(result.isRelevant).toBe(false);
		});

		test('evaluates relevance — environment_details is irrelevant', async () => {
			const result = await classifier.classifyMessage('<environment_details>VSCode info</environment_details>', 'user', 0);
			expect(result.isRelevant).toBe(false);
		});

		test('adjusts confidence for very short content', async () => {
			const shortResult = await classifier.classifyMessage('tiny msg here!', 'user', 0);
			const longResult = await classifier.classifyMessage('This is a much longer message with enough content to not trigger the short penalty', 'user', 1);
			// Short content should get penalized
			expect(shortResult.confidenceScore).toBeLessThan(longResult.confidenceScore);
		});
	});

	describe('classifyConversationContent', () => {
		test('classifies all messages in a conversation', async () => {
			const conversation: ConversationSkeleton = {
				id: 'test-1',
				timestamp: '2026-01-01T00:00:00Z',
				lastActivityTimestamp: '2026-01-01T00:00:00Z',
				sequence: [
					{ role: 'user', content: 'Help me fix the bug in index.ts', timestamp: '2026-01-01T00:00:00Z', isTruncated: false },
					{ role: 'assistant', content: '<read_file><path>index.ts</path></read_file>', timestamp: '2026-01-01T00:00:01Z', isTruncated: false },
					{ role: 'user', content: "[read_file for 'index.ts'] Result:\nconst x = 1;", timestamp: '2026-01-01T00:00:02Z', isTruncated: false },
				],
				metadata: {},
			};

			const classified = await classifier.classifyConversationContent(conversation);
			expect(classified).toHaveLength(3);
			expect(classified[0].type).toBe('User');
			expect(classified[0].subType).toBe('UserMessage');
			expect(classified[1].type).toBe('Assistant');
			expect(classified[1].subType).toBe('ToolCall');
			expect(classified[2].type).toBe('User');
			expect(classified[2].subType).toBe('ToolResult');
		});

		test('handles empty conversation', async () => {
			const conversation: ConversationSkeleton = {
				id: 'test-2',
				timestamp: '2026-01-01T00:00:00Z',
				lastActivityTimestamp: '2026-01-01T00:00:00Z',
				sequence: [],
				metadata: {},
			};

			const classified = await classifier.classifyConversationContent(conversation);
			expect(classified).toHaveLength(0);
		});
	});

	describe('tool result details', () => {
		test('detects error in tool result', async () => {
			const content = "[execute_command] Result:\nError: Command not found";
			const result = await classifier.classifyMessage(content, 'user', 0);
			expect(result.toolResultDetails?.success).toBe(false);
			expect(result.toolResultDetails?.resultType).toBe('error');
		});

		test('detects file result type', async () => {
			const content = "<file_write_result>File written successfully</file_write_result>";
			const result = await classifier.classifyMessage(content, 'user', 0);
			expect(result.toolResultDetails?.resultType).toBe('file');
		});

		test('detects truncated content', async () => {
			const content = "[read_file for 'big.ts'] Result:\nContent... 1000 characters truncated";
			const result = await classifier.classifyMessage(content, 'user', 0);
			expect(result.toolResultDetails?.truncated).toBe(true);
		});
	});

	describe('anti-stub checks', () => {
		test('confidence scores vary with input quality', async () => {
			const completion = await classifier.classifyMessage(
				'<attempt_completion>Done</attempt_completion>', 'assistant', 0);
			const toolCall = await classifier.classifyMessage(
				'<read_file><path>x</path></read_file>', 'assistant', 1);
			const plain = await classifier.classifyMessage(
				'Just a regular response', 'assistant', 2);

			// Different subtypes should get different base confidence scores
			expect(new Set([completion.confidenceScore, toolCall.confidenceScore, plain.confidenceScore]).size)
				.toBeGreaterThanOrEqual(2);
		});

		test('subType classification is input-dependent, not hardcoded', async () => {
			const r1 = await classifier.classifyMessage('hello world from user', 'user', 0);
			const r2 = await classifier.classifyMessage("[read_file] Result: data", 'user', 1);
			expect(r1.subType).not.toBe(r2.subType);
		});
	});
});
