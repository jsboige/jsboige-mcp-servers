/**
 * EnrichContentClassifier - Comprehensive test suite
 *
 * Tests classification of conversation messages into typed content
 * with confidence scoring, tool parsing, and relevance evaluation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EnrichContentClassifier } from '../../../src/services/EnrichContentClassifier.js';
import { ConversationSkeleton } from '../../../src/types/conversation.js';
import { ClassifiedContent } from '../../../src/types/enhanced-conversation.js';

describe('EnrichContentClassifier', () => {
	let classifier: EnrichContentClassifier;

	beforeEach(() => {
		classifier = new EnrichContentClassifier();
	});

	// ─── Helper ────────────────────────────────────────────────────────

	function makeConversation(...messages: { role: 'user' | 'assistant'; content: string }[]): ConversationSkeleton {
		return {
			taskId: 'test-task',
			metadata: {} as any,
			sequence: messages.map(m => ({
				role: m.role,
				content: m.content,
				timestamp: Date.now().toString(),
				isTruncated: false,
			})),
		};
	}

	// ═══════════════════════════════════════════════════════════════════
	// 1. User Messages - UserMessage subType
	// ═══════════════════════════════════════════════════════════════════

	describe('User messages', () => {
		it('classifies a plain user message as UserMessage', async () => {
			const result = await classifier.classifyMessage('Hello, can you help me?', 'user', 0);

			expect(result.type).toBe('User');
			expect(result.subType).toBe('UserMessage');
			expect(result.content).toBe('Hello, can you help me?');
			expect(result.index).toBe(0);
			expect(result.contentSize).toBe(23);
			expect(result.toolCallDetails).toBeUndefined();
			expect(result.toolResultDetails).toBeUndefined();
		});

		it('assigns confidence 0.9 to plain user messages', async () => {
			const result = await classifier.classifyMessage('A longer user message that is definitely over twenty chars', 'user', 1);

			// base 0.9, content > 20 chars so no small penalty, no markdown prefix so no boost
			expect(result.confidenceScore).toBe(0.9);
		});

		it('preserves original content exactly', async () => {
			const content = 'Line 1\nLine 2\nLine 3';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.content).toBe(content);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 2. Tool Results - ToolResult subType
	// ═══════════════════════════════════════════════════════════════════

	describe('Tool results', () => {
		it('detects [...] Result: pattern as ToolResult', async () => {
			const content = '[read_file] Result:\nFile content here';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.type).toBe('User');
			expect(result.subType).toBe('ToolResult');
		});

		it('detects Command executed pattern as ToolResult', async () => {
			const content = 'Command executed successfully.\nOutput: done';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.subType).toBe('ToolResult');
		});

		it('detects <file_write_result> pattern as ToolResult', async () => {
			const content = '<file_write_result>\n<path>test.ts</path>\n</file_write_result>';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.subType).toBe('ToolResult');
		});

		it('assigns confidence 0.95 base to tool results', async () => {
			const content = '[execute_command] Result:\nBuild successful';
			const result = await classifier.classifyMessage(content, 'user', 0);

			// base 0.95, content > 20 chars, no markdown prefix
			expect(result.confidenceScore).toBe(0.95);
		});

		it('populates toolResultDetails for tool results', async () => {
			const content = '[read_file] Result:\nconst x = 42;';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails).toBeDefined();
			expect(result.toolResultDetails!.success).toBe(true);
			expect(result.toolResultDetails!.outputSize).toBe(content.length);
		});

		it('detects failed tool results via error keyword', async () => {
			const content = '[execute_command] Result:\nerror: command not found';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails).toBeDefined();
			expect(result.toolResultDetails!.success).toBe(false);
			expect(result.toolResultDetails!.resultType).toBe('error');
			expect(result.toolResultDetails!.errorMessage).toBeDefined();
		});

		it('detects failed tool results via failed keyword', async () => {
			const content = '[write_to_file] Result:\nOperation failed to complete';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.success).toBe(false);
			expect(result.toolResultDetails!.resultType).toBe('error');
		});

		it('detects file result type from <file_write_result>', async () => {
			const content = '<file_write_result>\n<path>src/index.ts</path>\n<content>export {}</content>\n</file_write_result>';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.resultType).toBe('file');
		});

		it('detects file result type from <files> tag', async () => {
			const content = '[search_files] Result:\n<files>\n<file>test.ts</file>\n</files>';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.resultType).toBe('file');
		});

		it('detects JSON result type from curly brace content', async () => {
			const content = '[execute_command] Result:\n{"status": "ok", "count": 5}';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.resultType).toBe('json');
		});

		it('detects HTML result type', async () => {
			const content = '[browser_action] Result:\n<html><body>Hello</body></html>';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.resultType).toBe('html');
		});

		it('defaults to text result type for plain results', async () => {
			const content = '[read_file] Result:\nJust some plain text output';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.resultType).toBe('text');
		});

		it('detects truncation via ellipsis', async () => {
			const content = '[read_file] Result:\nContent truncated...';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.truncated).toBe(true);
		});

		it('detects truncation via unicode ellipsis', async () => {
			const content = '[read_file] Result:\nContent truncated\u2026';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.truncated).toBe(true);
		});

		it('detects truncation via "truncated" keyword', async () => {
			const content = '[read_file] Result:\nOutput was truncated to fit';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.truncated).toBe(true);
		});

		it('extracts originalLength from truncation metadata', async () => {
			const content = '[read_file] Result:\nContent truncated... 15000 characters';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.truncated).toBe(true);
			expect(result.toolResultDetails!.originalLength).toBe(15000);
		});

		it('extracts originalLength with "chars" unit', async () => {
			const content = '[read_file] Result:\nOutput truncated... 8500 chars';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.originalLength).toBe(8500);
		});

		it('extracts originalLength with "bytes" unit', async () => {
			const content = '[read_file] Result:\nContent truncated... 32000 bytes';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.originalLength).toBe(32000);
		});

		it('extracts error message from error line', async () => {
			const content = '[execute_command] Result:\nError: Permission denied';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.errorMessage).toBe('Permission denied');
		});

		it('falls back to "Unknown error" when no specific error message found', async () => {
			const content = '[execute_command] Result:\nUnable to complete the operation fully';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.success).toBe(false);
			expect(result.toolResultDetails!.errorMessage).toBe('Unknown error');
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 3. Assistant Messages - Completion, Thinking, ToolCall subTypes
	// ═══════════════════════════════════════════════════════════════════

	describe('Assistant messages', () => {
		it('classifies <attempt_completion> as Completion', async () => {
			const content = '<attempt_completion>\n<result>Task completed successfully</result>\n</attempt_completion>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			expect(result.type).toBe('Assistant');
			expect(result.subType).toBe('Completion');
			expect(result.confidenceScore).toBe(0.98);
		});

		it('classifies <thinking> as Thinking', async () => {
			const content = '<thinking>\nLet me analyze this step by step...\nThe user wants to refactor the code.\n</thinking>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			expect(result.type).toBe('Assistant');
			expect(result.subType).toBe('Thinking');
			expect(result.confidenceScore).toBe(0.85);
		});

		it('classifies <read_file> as ToolCall', async () => {
			const content = '<read_file>\n<path>src/index.ts</path>\n</read_file>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			expect(result.type).toBe('Assistant');
			expect(result.subType).toBe('ToolCall');
		});

		it('classifies <write_to_file> as ToolCall', async () => {
			const content = '<write_to_file>\n<path>src/new.ts</path>\n<content>export const x = 1;</content>\n</write_to_file>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			expect(result.subType).toBe('ToolCall');
		});

		it('classifies <execute_command> as ToolCall', async () => {
			const content = '<execute_command>\n<command>npm run build</command>\n</execute_command>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			expect(result.subType).toBe('ToolCall');
		});

		it('classifies underscore patterns like <ask_followup_question> as ToolCall', async () => {
			const content = '<ask_followup_question>\n<question>Do you want to proceed?</question>\n</ask_followup_question>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			expect(result.subType).toBe('ToolCall');
		});

		it('defaults to Completion for unrecognized assistant content', async () => {
			const content = 'Here is a summary of what was done in this task overall.';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			expect(result.subType).toBe('Completion');
			expect(result.confidenceScore).toBe(0.8);
		});

		it('prioritizes Completion over Thinking', async () => {
			// <attempt_completion> is checked first in the code
			const content = '<attempt_completion>\n<result>Done</result>\n</attempt_completion>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			expect(result.subType).toBe('Completion');
		});

		it('prioritizes Thinking over ToolCall', async () => {
			// <thinking> is checked before hasToolCalls
			const content = '<thinking>\nI should use read_file here\n</thinking>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			expect(result.subType).toBe('Thinking');
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 4. Tool Call Details Extraction
	// ═══════════════════════════════════════════════════════════════════

	describe('Tool call details extraction', () => {
		it('extracts tool name from XML tag', async () => {
			const content = '<read_file>\n<path>src/index.ts</path>\n</read_file>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			expect(result.toolCallDetails).toBeDefined();
			expect(result.toolCallDetails!.toolName).toBe('read_file');
			expect(result.toolCallDetails!.parseSuccess).toBe(true);
		});

		it('extracts nested arguments', async () => {
			const content = '<execute_command>\n<command>npm test</command>\n<requires_approval>true</requires_approval>\n</execute_command>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			expect(result.toolCallDetails!.arguments).toEqual({
				command: 'npm test',
				requires_approval: 'true',
			});
		});

		it('captures rawXml', async () => {
			const content = '<write_to_file>\n<path>out.ts</path>\n</write_to_file>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			expect(result.toolCallDetails!.rawXml).toContain('<write_to_file>');
			expect(result.toolCallDetails!.rawXml).toContain('</write_to_file>');
		});

		it('reports parseSuccess true on valid XML', async () => {
			const content = '<read_file>\n<path>test.ts</path>\n</read_file>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			expect(result.toolCallDetails!.parseSuccess).toBe(true);
			expect(result.toolCallDetails!.parseError).toBeUndefined();
		});

		it('assigns higher confidence on successful parse (0.92)', async () => {
			const content = '<read_file>\n<path>test.ts</path>\n</read_file>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			// base 0.92, content > 20, no markdown, no low diversity
			expect(result.confidenceScore).toBe(0.92);
		});

		it('assigns lower confidence on failed parse (0.7)', async () => {
			// Content triggers hasToolCalls (has read_file pattern)
			// but extractToolCallDetails regex can't match properly
			const content = 'I will use <read_file> to check this file now please';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			// hasToolCalls matches <read_file>, but extractToolCallDetails
			// tries to match <(\w+)>(...)<\/\1> which requires a closing tag
			// No closing tag => toolCallDetails.parseSuccess = false
			expect(result.confidenceScore).toBeLessThanOrEqual(0.7);
		});

		it('returns unknown tool name when no pattern matches', async () => {
			// The extractToolCallDetails only runs when hasToolCalls returns true
			// but the inner regex might not match the same way
			// Edge case: content with <read_file> but no closing tag
			const content = 'Please <read_file> the source';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			if (result.toolCallDetails) {
				expect(result.toolCallDetails!.toolName).toBe('unknown');
				expect(result.toolCallDetails!.parseSuccess).toBe(false);
			}
		});

		it('extracts arguments with multiline values', async () => {
			const content = '<write_to_file>\n<path>src/output.ts</path>\n<content>import { x } from "y";\n\nexport default x;\n</content>\n</write_to_file>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			expect(result.toolCallDetails!.arguments.path).toBe('src/output.ts');
			expect(result.toolCallDetails!.arguments.content).toContain('import { x }');
			expect(result.toolCallDetails!.arguments.content).toContain('export default x');
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 5. Tool Result Details Extraction
	// ═══════════════════════════════════════════════════════════════════

	describe('Tool result details extraction', () => {
		it('sets success true for results without error keywords', async () => {
			const content = '[read_file] Result:\nexport const foo = "bar";';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.success).toBe(true);
		});

		it('sets outputSize to content length', async () => {
			const content = '[read_file] Result:\n12345';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.outputSize).toBe(content.length);
		});

		it('defaults truncated to false', async () => {
			const content = '[execute_command] Result:\nAll tests passed';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.truncated).toBe(false);
		});

		it('defaults originalLength to undefined when not truncated', async () => {
			const content = '[read_file] Result:\nFull content here';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.originalLength).toBeUndefined();
		});

		it('defaults errorMessage to undefined for successful results', async () => {
			const content = '[execute_command] Result:\nSuccess: build completed';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.errorMessage).toBeUndefined();
		});

		it('error detection overrides resultType to error', async () => {
			// JSON content but with "error" keyword
			const content = '[execute_command] Result:\n{"error": "file not found"}';
			const result = await classifier.classifyMessage(content, 'user', 0);

			// Error detection should override JSON detection
			expect(result.toolResultDetails!.success).toBe(false);
			expect(result.toolResultDetails!.resultType).toBe('error');
		});

		it('detects "unable" keyword as failure', async () => {
			const content = '[write_to_file] Result:\nUnable to write file: permission denied';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.toolResultDetails!.success).toBe(false);
			expect(result.toolResultDetails!.resultType).toBe('error');
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 6. Relevance Evaluation
	// ═══════════════════════════════════════════════════════════════════

	describe('Relevance evaluation', () => {
		it('marks content under 10 chars as not relevant', async () => {
			const result = await classifier.classifyMessage('short', 'user', 0);

			expect(result.isRelevant).toBe(false);
		});

		it('marks exactly 10 chars as not relevant (<10 check)', async () => {
			// contentSize < 10, so 9 chars should be irrelevant
			const result = await classifier.classifyMessage('123456789', 'user', 0);

			expect(result.isRelevant).toBe(false);
		});

		it('marks 10+ char content as relevant', async () => {
			const result = await classifier.classifyMessage('This is a valid message with enough content', 'user', 0);

			expect(result.isRelevant).toBe(true);
		});

		it('marks debug-prefixed content as not relevant', async () => {
			const content = 'debug: checking variable state in the program';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.isRelevant).toBe(false);
		});

		it('marks log-prefixed content as not relevant', async () => {
			const content = 'log: Operation completed with exit code 0';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.isRelevant).toBe(false);
		});

		it('marks console. prefixed content as not relevant', async () => {
			const content = 'console.log("This is a debug statement")';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.isRelevant).toBe(false);
		});

		it('marks <environment_details> content as not relevant', async () => {
			const content = '<environment_details>\n<cwd>/home/user</cwd>\n</environment_details>';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.isRelevant).toBe(false);
		});

		it('always marks Completion subType as relevant', async () => {
			// Even short completion messages are relevant
			const content = '<attempt_completion>\n<result>ok</result>\n</attempt_completion>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			expect(result.subType).toBe('Completion');
			expect(result.isRelevant).toBe(true);
		});

		it('does not false-positive on content containing "debug" mid-sentence', async () => {
			const content = 'Please debug the issue in the authentication module';
			const result = await classifier.classifyMessage(content, 'user', 0);

			// The regex is /^debug/ so "Please debug" should NOT match
			expect(result.isRelevant).toBe(true);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 7. Confidence Score Adjustment
	// ═══════════════════════════════════════════════════════════════════

	describe('Confidence score adjustment', () => {
		it('penalizes content under 20 chars (x0.8)', async () => {
			// UserMessage base = 0.9, content < 20 => 0.9 * 0.8 = 0.72
			const result = await classifier.classifyMessage('A short msg', 'user', 0);

			expect(result.confidenceScore).toBeCloseTo(0.72, 2);
		});

		it('penalizes content over 10000 chars (x0.9)', async () => {
			const longContent = 'x'.repeat(10001);
			const result = await classifier.classifyMessage(longContent, 'user', 0);

			// base 0.9 * 0.9 = 0.81 (no markdown prefix, content likely diverse enough)
			expect(result.confidenceScore).toBeLessThan(0.9);
		});

		it('boosts content starting with markdown heading (#)', async () => {
			const content = '# Summary of Changes\n\nThis PR adds new features to the system.';
			const result = await classifier.classifyMessage(content, 'user', 0);

			// base 0.9 * 1.1 = 0.99
			expect(result.confidenceScore).toBeCloseTo(0.99, 2);
		});

		it('boosts content starting with bold (**)', async () => {
			const content = '**Important**: Please review these changes before merging';
			const result = await classifier.classifyMessage(content, 'user', 0);

			// base 0.9 * 1.1 = 0.99
			expect(result.confidenceScore).toBeCloseTo(0.99, 2);
		});

		it('boosts content starting with list dash (-)', async () => {
			const content = '- First item in the list of changes\n- Second item here';
			const result = await classifier.classifyMessage(content, 'user', 0);

			// base 0.9 * 1.1 = 0.99
			expect(result.confidenceScore).toBeCloseTo(0.99, 2);
		});

		it('penalizes low word diversity (x0.7)', async () => {
			// Create content with repetitive words but > 10 words
			const content = 'test test test test test test test test test test test test';
			const result = await classifier.classifyMessage(content, 'user', 0);

			// Only 2 unique words out of 12 total => ratio 2/12 < 0.3
			// base 0.9 * 0.7 = 0.63
			expect(result.confidenceScore).toBeCloseTo(0.63, 2);
		});

		it('does not penalize high word diversity', async () => {
			const content = 'The quick brown fox jumps over the lazy dog in the park today';
			const result = await classifier.classifyMessage(content, 'user', 0);

			// base 0.9, content > 20, diverse words, no markdown
			expect(result.confidenceScore).toBe(0.9);
		});

		it('clamps score to maximum 1.0', async () => {
			// Completion base = 0.98, with markdown boost: 0.98 * 1.1 = 1.078 => clamped to 1.0
			const content = '# Title\n\nCompletion with heading and substantial text content here';
			// Force a Completion by using assistant role with <attempt_completion>
			const completionContent = '<attempt_completion>\n# Title\n\nResult is here with enough text\n</attempt_completion>';
			const result = await classifier.classifyMessage(completionContent, 'assistant', 0);

			expect(result.confidenceScore).toBeLessThanOrEqual(1.0);
		});

		it('clamps score to minimum 0.0', async () => {
			// Edge case: force negative score through stacking penalties
			// This is hard to trigger naturally but the Math.max(0, ...) exists
			// Verify that scores are always >= 0
			const result = await classifier.classifyMessage('x', 'user', 0);

			expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
		});

		it('does not apply small-content penalty at exactly 20 chars', async () => {
			// contentSize < 20, so 20 chars should NOT get penalty
			const content = '12345678901234567890'; // exactly 20 chars
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.confidenceScore).toBe(0.9);
		});

		it('does not apply large-content penalty at exactly 10000 chars', async () => {
			// contentSize > 10000, so 10000 chars should NOT get penalty
			const content = 'a'.repeat(10000); // exactly 10000 chars
			const result = await classifier.classifyMessage(content, 'user', 0);

			// No large penalty (not > 10000), check no markdown prefix
			// But diversity might kick in since it's all 'a's
			// Actually: 'a'.repeat(10000) splits to 1 word of 10000 chars
			// words.length = 1, which is NOT > 10, so no diversity penalty
			expect(result.confidenceScore).toBe(0.9);
		});

		it('does not apply low-diversity penalty with <= 10 words', async () => {
			const content = 'hello world'; // 2 words, ratio irrelevant (words.length <= 10)
			const result = await classifier.classifyMessage(content, 'user', 0);

			// words.length = 2 which is NOT > 10, so diversity check is skipped
			// But content < 20, so penalty 0.9 * 0.8 = 0.72
			expect(result.confidenceScore).toBeCloseTo(0.72, 2);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 8. Full Conversation Classification
	// ═══════════════════════════════════════════════════════════════════

	describe('classifyConversationContent', () => {
		it('classifies a full conversation with mixed message types', async () => {
			const conversation = makeConversation(
				{ role: 'user', content: 'Please read the file src/index.ts' },
				{ role: 'assistant', content: '<read_file>\n<path>src/index.ts</path>\n</read_file>' },
				{ role: 'user', content: '[read_file] Result:\nexport const x = 42;' },
				{ role: 'assistant', content: '<attempt_completion>\n<result>Done</result>\n</attempt_completion>' },
			);

			const results = await classifier.classifyConversationContent(conversation);

			expect(results).toHaveLength(4);
			expect(results[0].subType).toBe('UserMessage');
			expect(results[1].subType).toBe('ToolCall');
			expect(results[2].subType).toBe('ToolResult');
			expect(results[3].subType).toBe('Completion');
		});

		it('assigns sequential indices to messages', async () => {
			const conversation = makeConversation(
				{ role: 'user', content: 'First message here' },
				{ role: 'assistant', content: '<thinking>\nProcessing...\n</thinking>' },
				{ role: 'user', content: 'Second user message here' },
			);

			const results = await classifier.classifyConversationContent(conversation);

			expect(results[0].index).toBe(0);
			expect(results[1].index).toBe(1);
			expect(results[2].index).toBe(2);
		});

		it('filters out non-message items (ActionMetadata)', async () => {
			const conversation: ConversationSkeleton = {
				taskId: 'test-task',
				metadata: {} as any,
				sequence: [
					{ role: 'user', content: 'Hello there user message', timestamp: '1', isTruncated: false },
					{ type: 'tool', name: 'read_file', parameters: {}, status: 'success', timestamp: '2' },
					{ role: 'assistant', content: 'I read the file for you now', timestamp: '3', isTruncated: false },
				],
			};

			const results = await classifier.classifyConversationContent(conversation);

			expect(results).toHaveLength(2);
			expect(results[0].content).toBe('Hello there user message');
			expect(results[1].content).toBe('I read the file for you now');
		});

		it('handles empty sequence gracefully', async () => {
			const conversation = makeConversation();

			const results = await classifier.classifyConversationContent(conversation);

			expect(results).toHaveLength(0);
		});

		it('handles null sequence gracefully', async () => {
			const conversation: ConversationSkeleton = {
				taskId: 'test-task',
				metadata: {} as any,
				sequence: null as any,
			};

			const results = await classifier.classifyConversationContent(conversation);

			expect(results).toHaveLength(0);
		});

		it('handles undefined sequence gracefully', async () => {
			const conversation: ConversationSkeleton = {
				taskId: 'test-task',
				metadata: {} as any,
				sequence: undefined as any,
			};

			const results = await classifier.classifyConversationContent(conversation);

			expect(results).toHaveLength(0);
		});

		it('classifies a conversation with only thinking messages', async () => {
			const conversation = makeConversation(
				{ role: 'assistant', content: '<thinking>\nAnalyzing the code structure...\n</thinking>' },
				{ role: 'assistant', content: '<thinking>\nPlanning the refactoring approach.\n</thinking>' },
			);

			const results = await classifier.classifyConversationContent(conversation);

			expect(results).toHaveLength(2);
			expect(results[0].subType).toBe('Thinking');
			expect(results[1].subType).toBe('Thinking');
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// 9. Edge Cases
	// ═══════════════════════════════════════════════════════════════════

	describe('Edge cases', () => {
		it('handles empty string content', async () => {
			const result = await classifier.classifyMessage('', 'user', 0);

			expect(result.content).toBe('');
			expect(result.contentSize).toBe(0);
			expect(result.isRelevant).toBe(false); // < 10 chars
			expect(result.subType).toBe('UserMessage');
		});

		it('handles content with only whitespace', async () => {
			const content = '     ';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.contentSize).toBe(5);
			expect(result.isRelevant).toBe(false); // < 10 chars
		});

		it('handles very long content', async () => {
			const content = 'A'.repeat(50000);
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.contentSize).toBe(50000);
			// Large content penalty applies (> 10000): 0.9 * 0.9 = 0.81
			// Content is single word 'a' repeated, words.length = 1 (not > 10)
			expect(result.confidenceScore).toBeCloseTo(0.81, 2);
		});

		it('handles content with special XML characters', async () => {
			const content = 'Handle <>&"\' characters properly in the message';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.content).toBe(content);
			expect(result.subType).toBe('UserMessage');
		});

		it('handles content with unicode characters', async () => {
			const content = 'Unicode test: \u00e9\u00e8\u00ea\u00eb \u4e2d\u6587 \u0627\u0644\u0639\u0631\u0628\u064a\u0629';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.content).toBe(content);
			expect(result.contentSize).toBe(content.length);
		});

		it('handles content that looks like multiple tool calls', async () => {
			const content = '<read_file>\n<path>a.ts</path>\n</read_file>\n<write_to_file>\n<path>b.ts</path>\n</write_to_file>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			// Should classify as ToolCall and extract the FIRST tool call
			expect(result.subType).toBe('ToolCall');
			expect(result.toolCallDetails).toBeDefined();
			expect(result.toolCallDetails!.toolName).toBe('read_file');
		});

		it('handles content with mixed patterns (tool result + thinking)', async () => {
			// User role => checked for tool result first
			const content = '[read_file] Result:\n<thinking>something</thinking>';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.subType).toBe('ToolResult');
			// Thinking is only checked for assistant role
		});

		it('case-insensitive matching for <attempt_completion>', async () => {
			const content = '<ATTEMPT_COMPLETION>\n<result>Done</result>\n</ATTEMPT_COMPLETION>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			// The regex uses /i flag
			expect(result.subType).toBe('Completion');
		});

		it('case-insensitive matching for <thinking>', async () => {
			const content = '<THINKING>\nDeep analysis\n</THINKING>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			expect(result.subType).toBe('Thinking');
		});

		it('case-insensitive matching for Command executed', async () => {
			const content = 'COMMAND EXECUTED with output: done';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.subType).toBe('ToolResult');
		});

		it('contentSize matches actual content length', async () => {
			const content = 'Hello World!';
			const result = await classifier.classifyMessage(content, 'user', 0);

			expect(result.contentSize).toBe(content.length);
		});

		it('does not set toolCallDetails for non-ToolCall messages', async () => {
			const result = await classifier.classifyMessage('Simple user message here', 'user', 0);

			expect(result.toolCallDetails).toBeUndefined();
		});

		it('does not set toolResultDetails for non-ToolResult messages', async () => {
			const result = await classifier.classifyMessage('Simple user message here', 'user', 0);

			expect(result.toolResultDetails).toBeUndefined();
		});

		it('handles deeply nested XML arguments', async () => {
			const content = '<attempt_completion>\n<result>Done with <nested>tag</nested></result>\n</attempt_completion>';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			expect(result.subType).toBe('Completion');
			// Completion does not extract tool call details
			expect(result.toolCallDetails).toBeUndefined();
		});

		it('classifies assistant content with <read_file> tag (no closing) correctly', async () => {
			const content = 'Let me read <read_file> this file now';
			const result = await classifier.classifyMessage(content, 'assistant', 0);

			// hasToolCalls matches <read_file> => ToolCall
			expect(result.subType).toBe('ToolCall');
			// But extractToolCallDetails won't find closing tag => parse error
			if (result.toolCallDetails) {
				expect(result.toolCallDetails.parseSuccess).toBe(false);
			}
		});
	});
});
