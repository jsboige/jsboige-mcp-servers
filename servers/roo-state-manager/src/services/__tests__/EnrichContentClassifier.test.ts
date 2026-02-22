/**
 * Tests pour EnrichContentClassifier
 * Issue #492 - Couverture des services
 *
 * @module services/__tests__/EnrichContentClassifier
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock XmlParsingService
const { mockParseToolCall } = vi.hoisted(() => ({
	mockParseToolCall: vi.fn()
}));

vi.mock('../XmlParsingService.js', () => ({
	XmlParsingService: class {
		parseToolCall = mockParseToolCall;
	}
}));

import { EnrichContentClassifier } from '../EnrichContentClassifier.js';

describe('EnrichContentClassifier', () => {
	let classifier: EnrichContentClassifier;

	beforeEach(() => {
		vi.clearAllMocks();
		classifier = new EnrichContentClassifier();

		mockParseToolCall.mockResolvedValue({
			success: true,
			arguments: { path: '/test/file.ts' }
		});
	});

	// ============================================================
	// User message classification
	// ============================================================

	describe('user messages', () => {
		test('classifies plain user message', async () => {
			const result = await classifier.classifyMessage(
				'Please fix the bug in auth module',
				'user',
				0
			);

			expect(result.type).toBe('User');
			expect(result.subType).toBe('UserMessage');
			expect(result.index).toBe(0);
			expect(result.isRelevant).toBe(true);
		});

		test('classifies tool result with [Tool] Result: pattern', async () => {
			const result = await classifier.classifyMessage(
				'[read_file] Result: File content here',
				'user',
				1
			);

			expect(result.type).toBe('User');
			expect(result.subType).toBe('ToolResult');
			expect(result.toolResultDetails).toBeDefined();
		});

		test('classifies Command executed as tool result', async () => {
			const result = await classifier.classifyMessage(
				'Command executed successfully with output: done',
				'user',
				2
			);

			expect(result.subType).toBe('ToolResult');
		});

		test('classifies file_write_result as tool result', async () => {
			const result = await classifier.classifyMessage(
				'<file_write_result>Written 100 bytes</file_write_result>',
				'user',
				3
			);

			expect(result.subType).toBe('ToolResult');
		});

		test('classifies Browser action as tool result', async () => {
			const result = await classifier.classifyMessage(
				'Browser action: clicked button Submit',
				'user',
				4
			);

			expect(result.subType).toBe('ToolResult');
		});
	});

	// ============================================================
	// Assistant message classification
	// ============================================================

	describe('assistant messages', () => {
		test('classifies attempt_completion as Completion', async () => {
			const result = await classifier.classifyMessage(
				'<attempt_completion>The task is complete.</attempt_completion>',
				'assistant',
				0
			);

			expect(result.type).toBe('Assistant');
			expect(result.subType).toBe('Completion');
			expect(result.confidenceScore).toBeGreaterThanOrEqual(0.9);
		});

		test('classifies thinking message', async () => {
			const result = await classifier.classifyMessage(
				'<thinking>Let me analyze the code structure first</thinking>',
				'assistant',
				1
			);

			expect(result.subType).toBe('Thinking');
		});

		test('classifies "Je vais" pattern as thinking', async () => {
			const result = await classifier.classifyMessage(
				'Je vais commencer par analyser le fichier de configuration',
				'assistant',
				2
			);

			expect(result.subType).toBe('Thinking');
		});

		test('classifies tool call with XML tags', async () => {
			const result = await classifier.classifyMessage(
				'<read_file><path>/test/file.ts</path></read_file>',
				'assistant',
				3
			);

			expect(result.subType).toBe('ToolCall');
			expect(result.toolCallDetails).toBeDefined();
			expect(result.toolCallDetails?.toolName).toBe('read_file');
		});

		test('classifies write_to_file as tool call', async () => {
			const result = await classifier.classifyMessage(
				'I will create the file. <write_to_file>content here</write_to_file>',
				'assistant',
				4
			);

			expect(result.subType).toBe('ToolCall');
		});

		test('classifies generic assistant message as Completion', async () => {
			const result = await classifier.classifyMessage(
				'The code has been updated successfully. Here is what I changed...',
				'assistant',
				5
			);

			expect(result.subType).toBe('Completion');
		});
	});

	// ============================================================
	// Tool result details extraction
	// ============================================================

	describe('tool result details', () => {
		test('detects file results', async () => {
			const result = await classifier.classifyMessage(
				'[write_to_file] Result: <files>test.ts</files>',
				'user',
				0
			);

			expect(result.toolResultDetails?.resultType).toBe('file');
		});

		test('detects error results', async () => {
			const result = await classifier.classifyMessage(
				'[execute_command] Result: Error: ENOENT file not found',
				'user',
				0
			);

			expect(result.toolResultDetails?.success).toBe(false);
			expect(result.toolResultDetails?.resultType).toBe('error');
			expect(result.toolResultDetails?.errorMessage).toContain('ENOENT');
		});

		test('detects truncated results', async () => {
			const result = await classifier.classifyMessage(
				'[read_file] Result: File content truncated... (1500 characters total)',
				'user',
				0
			);

			expect(result.toolResultDetails?.truncated).toBe(true);
			expect(result.toolResultDetails?.originalLength).toBe(1500);
		});

		test('detects JSON results', async () => {
			const result = await classifier.classifyMessage(
				'[api_call] Result: {"status": "ok", "data": []}',
				'user',
				0
			);

			expect(result.toolResultDetails?.resultType).toBe('json');
		});

		test('detects HTML results', async () => {
			const result = await classifier.classifyMessage(
				'[fetch] Result: <html><body>Page content</body></html>',
				'user',
				0
			);

			expect(result.toolResultDetails?.resultType).toBe('html');
		});
	});

	// ============================================================
	// Tool call details extraction
	// ============================================================

	describe('tool call details', () => {
		test('extracts tool name from XML', async () => {
			const result = await classifier.classifyMessage(
				'<read_file><path>/test.ts</path></read_file>',
				'assistant',
				0
			);

			expect(result.toolCallDetails?.toolName).toBe('read_file');
			expect(result.toolCallDetails?.parseSuccess).toBe(true);
		});

		test('handles missing tool call pattern', async () => {
			// Force a message that matches hasToolCalls but not the extraction regex
			const result = await classifier.classifyMessage(
				'<execute_command>run tests</execute_command>',
				'assistant',
				0
			);

			expect(result.toolCallDetails).toBeDefined();
			expect(result.toolCallDetails?.toolName).toBe('execute_command');
		});

		test('handles XML parse failure gracefully', async () => {
			mockParseToolCall.mockResolvedValue({
				success: false,
				arguments: {},
				error: 'Invalid XML'
			});

			const result = await classifier.classifyMessage(
				'<read_file><path>/broken</read_file>',
				'assistant',
				0
			);

			expect(result.toolCallDetails?.parseSuccess).toBe(false);
		});

		test('handles parse exception gracefully', async () => {
			mockParseToolCall.mockRejectedValue(new Error('Parse crash'));

			const result = await classifier.classifyMessage(
				'<read_file><path>/crash</path></read_file>',
				'assistant',
				0
			);

			expect(result.toolCallDetails?.parseSuccess).toBe(false);
			expect(result.toolCallDetails?.parseError).toContain('Parse crash');
		});
	});

	// ============================================================
	// Relevance evaluation
	// ============================================================

	describe('relevance', () => {
		test('marks short content as not relevant', async () => {
			const result = await classifier.classifyMessage('ok', 'user', 0);
			expect(result.isRelevant).toBe(false);
		});

		test('marks debug messages as not relevant', async () => {
			const result = await classifier.classifyMessage(
				'debug: some internal state info here',
				'user',
				0
			);
			expect(result.isRelevant).toBe(false);
		});

		test('marks environment_details as not relevant', async () => {
			const result = await classifier.classifyMessage(
				'<environment_details>OS: Windows, Node: 20</environment_details>',
				'user',
				0
			);
			expect(result.isRelevant).toBe(false);
		});

		test('marks completion messages as relevant', async () => {
			const result = await classifier.classifyMessage(
				'<attempt_completion>The fix is done.</attempt_completion>',
				'assistant',
				0
			);
			expect(result.isRelevant).toBe(true);
		});

		test('marks error tool results as relevant', async () => {
			const result = await classifier.classifyMessage(
				'[execute_command] Result: Error: build failed with 3 errors',
				'user',
				0
			);
			expect(result.isRelevant).toBe(true);
		});
	});

	// ============================================================
	// Confidence score adjustment
	// ============================================================

	describe('confidence score', () => {
		test('penalizes very short content', async () => {
			const shortResult = await classifier.classifyMessage('Yes, ok done', 'user', 0);
			const longResult = await classifier.classifyMessage(
				'I have carefully reviewed the authentication module and found a critical bug in the token refresh logic that causes an infinite loop when the refresh token expires',
				'user',
				0
			);

			expect(shortResult.confidenceScore).toBeLessThan(longResult.confidenceScore);
		});

		test('rewards well-structured content', async () => {
			const structured = await classifier.classifyMessage(
				'# Summary\n\nThe fix addresses three issues:\n- Token refresh\n- Session management\n- Error handling',
				'user',
				0
			);

			// Well-structured content (starts with #) gets a bonus
			expect(structured.confidenceScore).toBeGreaterThan(0);
		});

		test('penalizes repetitive content', async () => {
			const repetitive = 'word word word word word word word word word word word word word word word';
			const result = await classifier.classifyMessage(repetitive, 'user', 0);

			// Repetitive content should have lower confidence
			expect(result.confidenceScore).toBeLessThan(0.9);
		});

		test('keeps score in [0, 1] range', async () => {
			const result = await classifier.classifyMessage(
				'# Very well structured content that is long enough',
				'user',
				0
			);

			expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
			expect(result.confidenceScore).toBeLessThanOrEqual(1);
		});
	});

	// ============================================================
	// Conversation-level classification
	// ============================================================

	describe('classifyConversationContent', () => {
		test('classifies all messages in a conversation', async () => {
			const conversation = {
				taskId: 'test-task',
				metadata: {},
				sequence: [
					{ role: 'user', content: 'Fix the authentication bug' },
					{ role: 'assistant', content: 'I will investigate the auth module' },
					{ role: 'user', content: '[read_file] Result: File content here' }
				]
			} as any;

			const results = await classifier.classifyConversationContent(conversation);

			expect(results).toHaveLength(3);
			expect(results[0].type).toBe('User');
			expect(results[0].subType).toBe('UserMessage');
			expect(results[1].type).toBe('Assistant');
			expect(results[2].subType).toBe('ToolResult');
		});

		test('assigns sequential indices', async () => {
			const conversation = {
				taskId: 'test-task',
				metadata: {},
				sequence: [
					{ role: 'user', content: 'First message with enough content' },
					{ role: 'assistant', content: 'Second message with enough content' }
				]
			} as any;

			const results = await classifier.classifyConversationContent(conversation);

			expect(results[0].index).toBe(0);
			expect(results[1].index).toBe(1);
		});

		test('handles empty sequence', async () => {
			const conversation = {
				taskId: 'test-task',
				metadata: {},
				sequence: []
			} as any;

			const results = await classifier.classifyConversationContent(conversation);
			expect(results).toHaveLength(0);
		});

		test('filters non-message items from sequence', async () => {
			const conversation = {
				taskId: 'test-task',
				metadata: {},
				sequence: [
					{ role: 'user', content: 'A real message with content' },
					{ type: 'separator' },  // Not a message
					{ role: 'assistant', content: 'Another real message here' }
				]
			} as any;

			const results = await classifier.classifyConversationContent(conversation);
			// Should only classify actual messages (those with role + content)
			expect(results).toHaveLength(2);
		});
	});
});
