/**
 * Tests pour EnrichContentClassifier (récupéré issue #813)
 * Anti-stub: vérifie des valeurs significatives, pas juste l'existence.
 */

import { describe, it, expect } from 'vitest';
import { EnrichContentClassifier } from '../EnrichContentClassifier.js';

describe('EnrichContentClassifier', () => {
	const classifier = new EnrichContentClassifier();

	describe('classifyMessage — user messages', () => {
		it('should classify plain user message', async () => {
			const result = await classifier.classifyMessage('Help me fix the bug in auth.ts', 'user', 0);

			expect(result.type).toBe('User');
			expect(result.subType).toBe('UserMessage');
			expect(result.confidenceScore).toBeGreaterThan(0.5);
			expect(result.isRelevant).toBe(true);
			expect(result.contentSize).toBe(30);
		});

		it('should classify tool result messages', async () => {
			const result = await classifier.classifyMessage(
				'[read_file for "src/index.ts"] Result:\nconst x = 1;', 'user', 1
			);

			expect(result.type).toBe('User');
			expect(result.subType).toBe('ToolResult');
			expect(result.toolResultDetails).toBeDefined();
			expect(result.toolResultDetails!.success).toBe(true);
			expect(result.toolResultDetails!.resultType).toBe('text');
		});

		it('should detect error in tool results', async () => {
			const result = await classifier.classifyMessage(
				'[execute_command] Result: Error: file not found\nUnable to read path', 'user', 2
			);

			expect(result.subType).toBe('ToolResult');
			expect(result.toolResultDetails!.success).toBe(false);
			expect(result.toolResultDetails!.resultType).toBe('error');
			expect(result.toolResultDetails!.errorMessage).toBeDefined();
		});
	});

	describe('classifyMessage — assistant messages', () => {
		it('should classify completion messages', async () => {
			const result = await classifier.classifyMessage(
				'<attempt_completion>\nThe bug is fixed.\n</attempt_completion>', 'assistant', 0
			);

			expect(result.type).toBe('Assistant');
			expect(result.subType).toBe('Completion');
			expect(result.confidenceScore).toBeGreaterThanOrEqual(0.9);
		});

		it('should classify thinking messages', async () => {
			const result = await classifier.classifyMessage(
				'<thinking>\nI need to analyze the code first.\n</thinking>', 'assistant', 0
			);

			expect(result.type).toBe('Assistant');
			expect(result.subType).toBe('Thinking');
		});

		it('should classify tool call messages and extract details', async () => {
			const result = await classifier.classifyMessage(
				'<read_file><path>src/index.ts</path></read_file>', 'assistant', 0
			);

			expect(result.type).toBe('Assistant');
			expect(result.subType).toBe('ToolCall');
			expect(result.toolCallDetails).toBeDefined();
			expect(result.toolCallDetails!.toolName).toBe('read_file');
			expect(result.toolCallDetails!.parseSuccess).toBe(true);
			expect(result.toolCallDetails!.arguments).toHaveProperty('path');
			expect(result.toolCallDetails!.arguments['path']).toBe('src/index.ts');
		});
	});

	describe('relevance scoring', () => {
		it('should mark very short content as irrelevant', async () => {
			const result = await classifier.classifyMessage('ok', 'user', 0);
			expect(result.isRelevant).toBe(false);
		});

		it('should mark environment_details as irrelevant', async () => {
			const result = await classifier.classifyMessage(
				'<environment_details>\nVS Code 1.80\n</environment_details>', 'user', 0
			);
			expect(result.isRelevant).toBe(false);
		});

		it('should penalize confidence for very short content', async () => {
			const short = await classifier.classifyMessage('Yes', 'user', 0);
			const normal = await classifier.classifyMessage('Please fix the authentication bug in the login component', 'user', 1);

			expect(short.confidenceScore).toBeLessThan(normal.confidenceScore);
		});
	});

	describe('classifyConversationContent', () => {
		it('should classify a full conversation', async () => {
			const conversation = {
				taskId: 'test-task',
				sequence: [
					{ role: 'user' as const, content: 'Fix the bug', index: 0, contentSize: 11, isRelevant: true, confidenceScore: 1, isTruncated: false },
					{ role: 'assistant' as const, content: '<read_file><path>bug.ts</path></read_file>', index: 1, contentSize: 42, isRelevant: true, confidenceScore: 1, isTruncated: false },
					{ type: 'action' as const, toolName: 'read_file', index: 2 },
					{ role: 'user' as const, content: '[read_file for "bug.ts"] Result:\ncode here', index: 3, contentSize: 40, isRelevant: true, confidenceScore: 1, isTruncated: false },
				],
				metadata: {
					messageCount: 3, actionCount: 1, totalSize: 93,
					createdAt: '2026-01-01', lastActivity: '2026-01-01'
				}
			};

			const classified = await classifier.classifyConversationContent(conversation as any);

			// Should only classify MessageSkeleton items (not ActionMetadata)
			expect(classified.length).toBe(3);
			expect(classified[0].subType).toBe('UserMessage');
			expect(classified[1].subType).toBe('ToolCall');
			expect(classified[2].subType).toBe('ToolResult');
		});
	});
});
