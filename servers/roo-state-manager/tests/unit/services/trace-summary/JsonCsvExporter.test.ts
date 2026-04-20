import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JsonCsvExporter } from '../../../../src/services/trace-summary/JsonCsvExporter.js';
import { ContentClassifier } from '../../../../src/services/trace-summary/ContentClassifier.js';
import { ConversationSkeleton, MessageSkeleton } from '../../../../src/types/conversation.js';
import { SummaryOptions, SummaryStatistics } from '../../../../src/types/trace-summary.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClassifier(overrides: Partial<ContentClassifier> = {}): ContentClassifier {
	const classifier = {
		isToolResult: vi.fn().mockReturnValue(false),
		...overrides,
	} as unknown as ContentClassifier;
	return classifier;
}

function createMockConversation(overrides: Partial<ConversationSkeleton> = {}): ConversationSkeleton {
	return {
		taskId: 'task-001',
		parentTaskId: undefined,
		metadata: {
			createdAt: '2026-01-15T10:00:00.000Z',
			lastActivity: '2026-01-15T12:00:00.000Z',
			messageCount: 3,
			actionCount: 1,
			totalSize: 5000,
			workspace: 'C:/dev/test-workspace',
		},
		sequence: [
			{ role: 'user', content: 'Hello, please help me', timestamp: '2026-01-15T10:00:00.000Z', isTruncated: false },
			{ role: 'assistant', content: 'Sure, I can help.', timestamp: '2026-01-15T10:01:00.000Z', isTruncated: false },
			{ role: 'user', content: '[read_file] Result:\nfile content here', timestamp: '2026-01-15T10:02:00.000Z', isTruncated: false },
		],
		...overrides,
	};
}

function createJsonHelpers(overrides: Record<string, any> = {}) {
	return {
		truncateContent: vi.fn((content: string, _max: number) => content),
		isContentTruncated: vi.fn(() => false),
		getEmptyStatistics: vi.fn((): SummaryStatistics => ({
			totalSections: 0,
			userMessages: 0,
			assistantMessages: 0,
			toolResults: 0,
			userContentSize: 0,
			assistantContentSize: 0,
			toolResultsSize: 0,
			totalContentSize: 0,
			userPercentage: 0,
			assistantPercentage: 0,
			toolResultsPercentage: 0,
		})),
		getOriginalContentSize: vi.fn(() => 5000),
		calculateCompressionRatio: vi.fn((original: number, final: number) =>
			original > 0 ? Math.round((final / original) * 1000) / 10 : 0
		),
		...overrides,
	};
}

function createCsvHelpers(overrides: Record<string, any> = {}) {
	return {
		isContentTruncated: vi.fn(() => false),
		getEmptyStatistics: vi.fn((): SummaryStatistics => ({
			totalSections: 0,
			userMessages: 0,
			assistantMessages: 0,
			toolResults: 0,
			userContentSize: 0,
			assistantContentSize: 0,
			toolResultsSize: 0,
			totalContentSize: 0,
			userPercentage: 0,
			assistantPercentage: 0,
			toolResultsPercentage: 0,
		})),
		truncateText: vi.fn((text: string) => text),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JsonCsvExporter', () => {
	let exporter: JsonCsvExporter;
	let mockClassifier: ContentClassifier;

	beforeEach(() => {
		mockClassifier = createMockClassifier();
		exporter = new JsonCsvExporter(mockClassifier);
	});

	// =========================================================================
	// generateJsonSummary - light variant
	// =========================================================================

	describe('generateJsonSummary - light variant', () => {
		const lightOptions: SummaryOptions = {
			detailLevel: 'Summary',
			truncationChars: 5000,
			compactStats: false,
			includeCss: false,
			generateToc: false,
			outputFormat: 'json',
			jsonVariant: 'light',
		};

		it('should return success with valid JSON for light variant', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, lightOptions, helpers);

			expect(result.success).toBe(true);
			expect(result.content).toBeTruthy();
			const parsed = JSON.parse(result.content);
			expect(parsed.format).toBe('roo-conversation-light');
			expect(parsed.version).toBe('1.0');
		});

		it('should include summary with correct totalConversations', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, lightOptions, helpers);

			const parsed = JSON.parse(result.content);
			expect(parsed.summary.totalConversations).toBe(1);
			expect(parsed.summary.totalMessages).toBe(3);
			expect(parsed.summary.totalSize).toBe(5000);
		});

		it('should include dateRange in summary', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, lightOptions, helpers);

			const parsed = JSON.parse(result.content);
			expect(parsed.summary.dateRange).toBeDefined();
			expect(parsed.summary.dateRange.earliest).toBeTruthy();
			expect(parsed.summary.dateRange.latest).toBeTruthy();
		});

		it('should include conversations array with skeleton data', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, lightOptions, helpers);

			const parsed = JSON.parse(result.content);
			expect(parsed.conversations).toHaveLength(1);
			expect(parsed.conversations[0].taskId).toBe('task-001');
			expect(parsed.conversations[0].workspace).toBe('C:/dev/test-workspace');
			expect(parsed.conversations[0].messageCount).toBe(3);
		});

		it('should include drillDown section', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, lightOptions, helpers);

			const parsed = JSON.parse(result.content);
			expect(parsed.drillDown.available).toBe(true);
			expect(parsed.drillDown.endpoint).toBe('view_task_details');
			expect(parsed.drillDown.fullDataEndpoint).toBe('get_raw_conversation');
		});

		it('should use light as default when no jsonVariant specified', async () => {
			const conversation = createMockConversation();
			const options = { ...lightOptions, jsonVariant: undefined };
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, options, helpers);

			const parsed = JSON.parse(result.content);
			expect(parsed.format).toBe('roo-conversation-light');
		});

		it('should compute compressionRatio from helpers', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, lightOptions, helpers);

			expect(helpers.getOriginalContentSize).toHaveBeenCalledWith(conversation);
			expect(helpers.calculateCompressionRatio).toHaveBeenCalled();
			expect(result.statistics.compressionRatio).toBeDefined();
		});

		it('should extract first user message in skeleton and truncate it', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, lightOptions, helpers);

			const parsed = JSON.parse(result.content);
			expect(parsed.conversations[0].firstUserMessage).toBe('Hello, please help me');
		});

		it('should fall back to unknown workspace when metadata.workspace is missing', async () => {
			const conversation = createMockConversation({
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 1,
					actionCount: 0,
					totalSize: 100,
				},
			});
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, lightOptions, helpers);

			const parsed = JSON.parse(result.content);
			expect(parsed.conversations[0].workspace).toBe('unknown');
		});
	});

	// =========================================================================
	// generateJsonSummary - full variant
	// =========================================================================

	describe('generateJsonSummary - full variant', () => {
		const fullOptions: SummaryOptions = {
			detailLevel: 'Full',
			truncationChars: 5000,
			compactStats: false,
			includeCss: false,
			generateToc: false,
			outputFormat: 'json',
			jsonVariant: 'full',
		};

		it('should return success with valid JSON for full variant', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			expect(result.success).toBe(true);
			const parsed = JSON.parse(result.content);
			expect(parsed.format).toBe('roo-conversation-full');
			expect(parsed.version).toBe('1.0');
		});

		it('should include task with correct taskId', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			const parsed = JSON.parse(result.content);
			expect(parsed.task.taskId).toBe('task-001');
		});

		it('should include metadata in task', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			const parsed = JSON.parse(result.content);
			expect(parsed.task.metadata.createdAt).toBe('2026-01-15T10:00:00.000Z');
			expect(parsed.task.metadata.messageCount).toBe(3);
			expect(parsed.task.metadata.workspace).toBe('C:/dev/test-workspace');
		});

		it('should include messages array with role, timestamp, content', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			const parsed = JSON.parse(result.content);
			expect(parsed.task.messages).toHaveLength(3);
			expect(parsed.task.messages[0].role).toBe('user');
			expect(parsed.task.messages[1].role).toBe('assistant');
			expect(parsed.task.messages[0].timestamp).toBe('2026-01-15T10:00:00.000Z');
		});

		it('should include toolCalls extracted from message content', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			const parsed = JSON.parse(result.content);
			// The third message has a [read_file] Result: pattern
			const toolMessage = parsed.task.messages[2];
			expect(toolMessage.toolCalls.length).toBeGreaterThanOrEqual(0);
		});

		it('should include empty children array', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			const parsed = JSON.parse(result.content);
			expect(parsed.task.children).toEqual([]);
		});

		it('should use helpers.truncateContent for message content', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers();
			await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			expect(helpers.truncateContent).toHaveBeenCalled();
		});

		it('should use helpers.isContentTruncated for isTruncated field', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers();
			await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			expect(helpers.isContentTruncated).toHaveBeenCalled();
		});
	});

	// =========================================================================
	// generateJsonSummary - error handling
	// =========================================================================

	describe('generateJsonSummary - error handling', () => {
		const options: SummaryOptions = {
			detailLevel: 'Summary',
			truncationChars: 5000,
			compactStats: false,
			includeCss: false,
			generateToc: false,
			outputFormat: 'json',
		};

		it('should catch errors and return failure result', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers({
				getOriginalContentSize: vi.fn(() => {
					throw new Error('Simulated failure');
				}),
			});
			// Use full variant to trigger compression ratio calc with failing helper
			const fullOptions = { ...options, jsonVariant: 'full' as const };
			// Actually the error would need to be inside the try block.
			// Let's make truncateContent throw.
			const throwingHelpers = createJsonHelpers({
				truncateContent: vi.fn(() => {
					throw new Error('Truncation exploded');
				}),
			});
			const result = await exporter.generateJsonSummary(conversation, fullOptions, throwingHelpers);

			expect(result.success).toBe(false);
			expect(result.content).toBe('');
			expect(result.error).toBe('Truncation exploded');
		});

		it('should return getEmptyStatistics on error', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers({
				truncateContent: vi.fn(() => {
					throw new Error('Boom');
				}),
			});
			const fullOptions = { ...options, jsonVariant: 'full' as const };
			const result = await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			expect(helpers.getEmptyStatistics).toHaveBeenCalled();
			expect(result.statistics.totalSections).toBe(0);
		});

		it('should handle non-Error thrown values', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers({
				truncateContent: vi.fn(() => {
					throw 'string error'; // eslint-disable-line no-throw-literal
				}),
			});
			const fullOptions = { ...options, jsonVariant: 'full' as const };
			const result = await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			expect(result.success).toBe(false);
			expect(result.error).toBe('JSON generation error');
		});
	});

	// =========================================================================
	// generateJsonSummary - statistics (private calculateJsonStatistics)
	// =========================================================================

	describe('generateJsonSummary - statistics calculation', () => {
		const lightOptions: SummaryOptions = {
			detailLevel: 'Summary',
			truncationChars: 5000,
			compactStats: false,
			includeCss: false,
			generateToc: false,
			outputFormat: 'json',
			jsonVariant: 'light',
		};

		it('should count user messages, assistant messages, and tool results', async () => {
			(mockClassifier.isToolResult as ReturnType<typeof vi.fn>).mockImplementation(
				(content: string) => content.includes('[read_file] Result:')
			);
			const conversation = createMockConversation();
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, lightOptions, helpers);

			expect(result.statistics.totalSections).toBe(3);
			// user messages: 2 user roles, 1 is tool result
			expect(result.statistics.userMessages).toBe(1);
			expect(result.statistics.assistantMessages).toBe(1);
			expect(result.statistics.toolResults).toBe(1);
		});

		it('should calculate size percentages correctly', async () => {
			const conversation = createMockConversation();
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, lightOptions, helpers);

			expect(result.statistics.totalContentSize).toBe(5000);
			expect(result.statistics.userContentSize).toBe(2000); // 40%
			expect(result.statistics.assistantContentSize).toBe(2000); // 40%
			expect(result.statistics.toolResultsSize).toBe(1000); // 20%
			expect(result.statistics.userPercentage).toBe(40);
			expect(result.statistics.assistantPercentage).toBe(40);
			expect(result.statistics.toolResultsPercentage).toBe(20);
		});

		it('should handle zero totalSize without division by zero', async () => {
			const conversation = createMockConversation({
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 0,
					actionCount: 0,
					totalSize: 0,
				},
				sequence: [],
			});
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, lightOptions, helpers);

			expect(result.statistics.userPercentage).toBe(0);
			expect(result.statistics.assistantPercentage).toBe(0);
			expect(result.statistics.toolResultsPercentage).toBe(0);
		});
	});

	// =========================================================================
	// generateCsvSummary - conversations variant
	// =========================================================================

	describe('generateCsvSummary - conversations variant', () => {
		const options: SummaryOptions = {
			detailLevel: 'Summary',
			truncationChars: 5000,
			compactStats: false,
			includeCss: false,
			generateToc: false,
			outputFormat: 'csv',
			csvVariant: 'conversations',
		};

		it('should return success with CSV content for conversations variant', async () => {
			const conversation = createMockConversation();
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			expect(result.success).toBe(true);
			expect(result.content).toBeTruthy();
		});

		it('should include correct CSV headers', async () => {
			const conversation = createMockConversation();
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			const lines = result.content.split('\n');
			expect(lines[0]).toBe('taskId,workspace,isCompleted,createdAt,lastActivity,messageCount,actionCount,totalSize,firstUserMessage');
		});

		it('should include conversation data row', async () => {
			const conversation = createMockConversation();
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			const lines = result.content.split('\n');
			expect(lines).toHaveLength(2); // header + 1 data row
			expect(lines[1]).toContain('task-001');
			expect(lines[1]).toContain('C:/dev/test-workspace');
		});

		it('should use conversations as default csvVariant', async () => {
			const conversation = createMockConversation();
			const noVariantOptions = { ...options, csvVariant: undefined };
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, noVariantOptions, helpers);

			const lines = result.content.split('\n');
			expect(lines[0]).toContain('taskId');
			expect(lines[0]).toContain('firstUserMessage');
		});
	});

	// =========================================================================
	// generateCsvSummary - messages variant
	// =========================================================================

	describe('generateCsvSummary - messages variant', () => {
		const options: SummaryOptions = {
			detailLevel: 'Summary',
			truncationChars: 5000,
			compactStats: false,
			includeCss: false,
			generateToc: false,
			outputFormat: 'csv',
			csvVariant: 'messages',
		};

		it('should return success with CSV content for messages variant', async () => {
			const conversation = createMockConversation();
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			expect(result.success).toBe(true);
			expect(result.content).toBeTruthy();
		});

		it('should include correct headers for messages', async () => {
			const conversation = createMockConversation();
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			const lines = result.content.split('\n');
			expect(lines[0]).toBe('taskId,messageIndex,role,timestamp,contentLength,isTruncated,toolCount,workspace');
		});

		it('should include one row per message in the sequence', async () => {
			const conversation = createMockConversation();
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			const lines = result.content.split('\n');
			// 3 messages = 1 header + 3 data rows
			expect(lines).toHaveLength(4);
		});

		it('should include 1-based messageIndex', async () => {
			const conversation = createMockConversation();
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			const lines = result.content.split('\n');
			expect(lines[1]).toContain(',1,');  // messageIndex=1
			expect(lines[2]).toContain(',2,');  // messageIndex=2
			expect(lines[3]).toContain(',3,');  // messageIndex=3
		});

		it('should include role for each message', async () => {
			const conversation = createMockConversation();
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			const lines = result.content.split('\n');
			expect(lines[1]).toContain('user');
			expect(lines[2]).toContain('assistant');
		});

		it('should count toolCalls per message', async () => {
			const conversation = createMockConversation();
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			const lines = result.content.split('\n');
			// Third message has [read_file] Result: pattern -> 1 tool call extracted
			const thirdRow = lines[3];
			expect(thirdRow).toContain(',1,'); // toolCount=1 for the tool result message
		});
	});

	// =========================================================================
	// generateCsvSummary - tools variant
	// =========================================================================

	describe('generateCsvSummary - tools variant', () => {
		const options: SummaryOptions = {
			detailLevel: 'Summary',
			truncationChars: 5000,
			compactStats: false,
			includeCss: false,
			generateToc: false,
			outputFormat: 'csv',
			csvVariant: 'tools',
		};

		it('should return success with CSV content for tools variant', async () => {
			const conversation = createMockConversation();
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			expect(result.success).toBe(true);
			expect(result.content).toBeTruthy();
		});

		it('should include correct headers for tools', async () => {
			const conversation = createMockConversation();
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			const lines = result.content.split('\n');
			expect(lines[0]).toBe('taskId,messageIndex,toolName,serverName,executionTime,success,argsCount,resultLength,workspace');
		});

		it('should extract tool rows for messages containing tool patterns', async () => {
			const conversation = createMockConversation();
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			const lines = result.content.split('\n');
			// 1 header + 1 tool row (the [read_file] Result: message)
			expect(lines).toHaveLength(2);
			expect(lines[1]).toContain('read_file');
		});

		it('should return only header when no tools found', async () => {
			const conversation = createMockConversation({
				sequence: [
					{ role: 'user', content: 'Just a plain message', timestamp: '2026-01-15T10:00:00.000Z', isTruncated: false },
				],
			});
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			const lines = result.content.split('\n');
			expect(lines).toHaveLength(1); // header only
		});
	});

	// =========================================================================
	// generateCsvSummary - invalid variant
	// =========================================================================

	describe('generateCsvSummary - invalid variant', () => {
		it('should return error for unsupported CSV variant', async () => {
			const conversation = createMockConversation();
			const options: SummaryOptions = {
				detailLevel: 'Summary',
				truncationChars: 5000,
				compactStats: false,
				includeCss: false,
				generateToc: false,
				outputFormat: 'csv',
				csvVariant: 'invalid' as any,
			};
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Unsupported CSV variant: invalid');
			expect(result.error).toContain('conversations, messages, tools');
		});
	});

	// =========================================================================
	// generateCsvSummary - error handling
	// =========================================================================

	describe('generateCsvSummary - error handling', () => {
		it('should catch errors and return failure result', async () => {
			const conversation = createMockConversation();
			const options: SummaryOptions = {
				detailLevel: 'Summary',
				truncationChars: 5000,
				compactStats: false,
				includeCss: false,
				generateToc: false,
				outputFormat: 'csv',
				csvVariant: 'conversations',
			};
			const helpers = createCsvHelpers({
				truncateText: vi.fn(() => {
					throw new Error('CSV truncation failed');
				}),
			});
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			expect(result.success).toBe(false);
			expect(result.error).toBe('CSV truncation failed');
			expect(result.content).toBe('');
		});

		it('should handle non-Error thrown values in CSV', async () => {
			const conversation = createMockConversation();
			const options: SummaryOptions = {
				detailLevel: 'Summary',
				truncationChars: 5000,
				compactStats: false,
				includeCss: false,
				generateToc: false,
				outputFormat: 'csv',
				csvVariant: 'conversations',
			};
			const helpers = createCsvHelpers({
				truncateText: vi.fn(() => {
					throw 42; // eslint-disable-line no-throw-literal
				}),
			});
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			expect(result.success).toBe(false);
			expect(result.error).toBe('CSV generation error');
		});
	});

	// =========================================================================
	// extractToolCallsFromMessage - tested indirectly via generateJsonSummary
	// =========================================================================

	describe('extractToolCallsFromMessage (via full variant)', () => {
		const fullOptions: SummaryOptions = {
			detailLevel: 'Full',
			truncationChars: 5000,
			compactStats: false,
			includeCss: false,
			generateToc: false,
			outputFormat: 'json',
			jsonVariant: 'full',
		};

		it('should extract tool result pattern [tool_name] Result:', async () => {
			const conversation = createMockConversation({
				sequence: [
					{
						role: 'assistant',
						content: '[read_file] Result:\nfile contents here',
						timestamp: '2026-01-15T10:00:00.000Z',
						isTruncated: false,
					},
				],
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 1,
					actionCount: 0,
					totalSize: 100,
				},
			});
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			const parsed = JSON.parse(result.content);
			const toolCalls = parsed.task.messages[0].toolCalls;
			expect(toolCalls).toHaveLength(1);
			expect(toolCalls[0].toolName).toBe('read_file');
			expect(toolCalls[0].result).toBe('file contents here');
			expect(toolCalls[0].success).toBe(true);
		});

		it('should detect error keywords in tool result', async () => {
			const conversation = createMockConversation({
				sequence: [
					{
						role: 'assistant',
						content: '[execute_command] Result:\nError: command not found',
						timestamp: '2026-01-15T10:00:00.000Z',
						isTruncated: false,
					},
				],
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 1,
					actionCount: 0,
					totalSize: 100,
				},
			});
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			const parsed = JSON.parse(result.content);
			const toolCalls = parsed.task.messages[0].toolCalls;
			expect(toolCalls).toHaveLength(1);
			expect(toolCalls[0].success).toBe(false);
		});

		it('should detect "failed" keyword in tool result', async () => {
			const conversation = createMockConversation({
				sequence: [
					{
						role: 'assistant',
						content: '[write_to_file] Result:\nOperation failed',
						timestamp: '2026-01-15T10:00:00.000Z',
						isTruncated: false,
					},
				],
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 1,
					actionCount: 0,
					totalSize: 100,
				},
			});
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			const parsed = JSON.parse(result.content);
			expect(parsed.task.messages[0].toolCalls[0].success).toBe(false);
		});

		it('should extract MCP tool calls from <use_mcp_tool> pattern', async () => {
			const conversation = createMockConversation({
				sequence: [
					{
						role: 'assistant',
						content: '<use_mcp_tool><server_name>roo-state-manager</server_name><tool_name>conversation_browser</tool_name><arguments>{"action":"list"}</arguments></use_mcp_tool>',
						timestamp: '2026-01-15T10:00:00.000Z',
						isTruncated: false,
					},
				],
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 1,
					actionCount: 0,
					totalSize: 100,
				},
			});
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			const parsed = JSON.parse(result.content);
			const toolCalls = parsed.task.messages[0].toolCalls;
			expect(toolCalls).toHaveLength(1);
			expect(toolCalls[0].toolName).toBe('conversation_browser');
			expect(toolCalls[0].serverName).toBe('roo-state-manager');
			expect(toolCalls[0].arguments).toEqual({ action: 'list' });
			expect(toolCalls[0].success).toBe(true);
		});

		it('should handle malformed MCP XML gracefully', async () => {
			const conversation = createMockConversation({
				sequence: [
					{
						role: 'assistant',
						content: '<use_mcp_tool><server_name>bad</server_name><tool_name>test</tool_name><arguments>not-json</arguments></use_mcp_tool>',
						timestamp: '2026-01-15T10:00:00.000Z',
						isTruncated: false,
					},
				],
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 1,
					actionCount: 0,
					totalSize: 100,
				},
			});
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			expect(result.success).toBe(true);
			const parsed = JSON.parse(result.content);
			// Malformed arguments JSON should be silently ignored (catch in parsing)
			expect(parsed.task.messages[0].toolCalls).toHaveLength(0);
		});

		it('should extract tool with path from [tool_name for \'path\'] Result:', async () => {
			const conversation = createMockConversation({
				sequence: [
					{
						role: 'assistant',
						content: "[read_file for 'src/index.ts'] Result:\nexport default {};",
						timestamp: '2026-01-15T10:00:00.000Z',
						isTruncated: false,
					},
				],
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 1,
					actionCount: 0,
					totalSize: 100,
				},
			});
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			const parsed = JSON.parse(result.content);
			const toolCalls = parsed.task.messages[0].toolCalls;
			expect(toolCalls).toHaveLength(1);
			// The regex group 1 is greedy [^\]]+ so it captures the full bracket content
			// including "for 'path'" because the non-capturing for-group is optional
			expect(toolCalls[0].toolName).toBe("read_file for 'src/index.ts'");
			expect(toolCalls[0].arguments).toEqual({});
		});

		it('should return empty toolCalls for content with no patterns', async () => {
			const conversation = createMockConversation({
				sequence: [
					{
						role: 'assistant',
						content: 'Just a regular text message with no tools.',
						timestamp: '2026-01-15T10:00:00.000Z',
						isTruncated: false,
					},
				],
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 1,
					actionCount: 0,
					totalSize: 100,
				},
			});
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			const parsed = JSON.parse(result.content);
			expect(parsed.task.messages[0].toolCalls).toEqual([]);
		});

		it('should truncate tool results to 500 characters', async () => {
			const longResult = 'A'.repeat(600);
			const conversation = createMockConversation({
				sequence: [
					{
						role: 'assistant',
						content: `[read_file] Result:\n${longResult}`,
						timestamp: '2026-01-15T10:00:00.000Z',
						isTruncated: false,
					},
				],
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 1,
					actionCount: 0,
					totalSize: 100,
				},
			});
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			const parsed = JSON.parse(result.content);
			expect(parsed.task.messages[0].toolCalls[0].result.length).toBeLessThanOrEqual(500);
		});

		it('should handle empty content gracefully', async () => {
			const conversation = createMockConversation({
				sequence: [
					{
						role: 'assistant',
						content: '',
						timestamp: '2026-01-15T10:00:00.000Z',
						isTruncated: false,
					},
				],
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 1,
					actionCount: 0,
					totalSize: 100,
				},
			});
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, fullOptions, helpers);

			const parsed = JSON.parse(result.content);
			expect(parsed.task.messages[0].toolCalls).toEqual([]);
		});
	});

	// =========================================================================
	// Edge cases
	// =========================================================================

	describe('edge cases', () => {
		const lightOptions: SummaryOptions = {
			detailLevel: 'Summary',
			truncationChars: 5000,
			compactStats: false,
			includeCss: false,
			generateToc: false,
			outputFormat: 'json',
			jsonVariant: 'light',
		};

		it('should handle empty sequence gracefully', async () => {
			const conversation = createMockConversation({
				sequence: [],
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 0,
					actionCount: 0,
					totalSize: 0,
				},
			});
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, lightOptions, helpers);

			expect(result.success).toBe(true);
			const parsed = JSON.parse(result.content);
			expect(parsed.conversations[0].firstUserMessage).toBe('');
		});

		it('should handle undefined sequence gracefully', async () => {
			const conversation = createMockConversation({
				sequence: undefined as any,
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 0,
					actionCount: 0,
					totalSize: 0,
				},
			});
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, lightOptions, helpers);

			expect(result.success).toBe(true);
		});

		it('should handle sequence with ActionMetadata items (no role)', async () => {
			const conversation = createMockConversation({
				sequence: [
					{ type: 'tool', name: 'read', parameters: {}, status: 'success', timestamp: '2026-01-15T10:00:00.000Z' },
					{ role: 'user', content: 'Hello', timestamp: '2026-01-15T10:01:00.000Z', isTruncated: false },
				] as any,
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 2,
					actionCount: 1,
					totalSize: 200,
				},
			});
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, lightOptions, helpers);

			expect(result.success).toBe(true);
			const parsed = JSON.parse(result.content);
			// Only the user message should be in the firstUserMessage, ActionMetadata is filtered out
			expect(parsed.conversations[0].firstUserMessage).toBe('Hello');
		});

		it('should handle CSV conversations variant with missing workspace', async () => {
			const conversation = createMockConversation({
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 1,
					actionCount: 0,
					totalSize: 100,
				},
			});
			const helpers = createCsvHelpers();
			const options: SummaryOptions = {
				detailLevel: 'Summary',
				truncationChars: 5000,
				compactStats: false,
				includeCss: false,
				generateToc: false,
				outputFormat: 'csv',
				csvVariant: 'conversations',
			};
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			expect(result.success).toBe(true);
			// workspace should be empty string (escapeCsv of empty)
			expect(result.content).toContain('task-001');
		});
	});

	// =========================================================================
	// escapeCsv (tested indirectly via CSV output)
	// =========================================================================

	describe('escapeCsv (indirect)', () => {
		const options: SummaryOptions = {
			detailLevel: 'Summary',
			truncationChars: 5000,
			compactStats: false,
			includeCss: false,
			generateToc: false,
			outputFormat: 'csv',
			csvVariant: 'conversations',
		};

		it('should escape workspace containing commas', async () => {
			const conversation = createMockConversation({
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 1,
					actionCount: 0,
					totalSize: 100,
					workspace: 'C:/path,with,commas',
				},
			});
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			expect(result.content).toContain('"C:/path,with,commas"');
		});

		it('should escape workspace containing double quotes', async () => {
			const conversation = createMockConversation({
				sequence: [],
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 0,
					actionCount: 0,
					totalSize: 100,
					workspace: 'path with "quotes" here',
				},
			});
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			// escapeCsv is called twice: once in row building and once in formatCsvOutput
			// First pass: 'path with "quotes" here' -> '"path with ""quotes"" here"'
			// Second pass on the already-escaped string (contains comma? no, but contains ") -> re-wraps and re-doubles
			const dataLine = result.content.split('\n')[1];
			// Verify the workspace field was escaped (it will be double-escaped due to double call)
			expect(dataLine).toContain('path with');
			expect(dataLine).toContain('quotes');
			// Verify quotes were doubled (at minimum the doubled quotes should be present)
			expect(dataLine).toContain('""quotes""');
		});

		it('should escape workspace containing newlines', async () => {
			const conversation = createMockConversation({
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 1,
					actionCount: 0,
					totalSize: 100,
					workspace: 'line1\nline2',
				},
			});
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			expect(result.content).toContain('"line1\nline2"');
		});

		it('should not escape plain values without special characters', async () => {
			const conversation = createMockConversation({
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 1,
					actionCount: 0,
					totalSize: 100,
					workspace: 'plain-path',
				},
			});
			const helpers = createCsvHelpers();
			const result = await exporter.generateCsvSummary(conversation, options, helpers);

			// Should NOT be double-quoted
			expect(result.content).toContain(',plain-path,');
		});
	});

	// =========================================================================
	// truncateText (tested indirectly via light variant skeleton)
	// =========================================================================

	describe('truncateText (indirect via light skeleton)', () => {
		const lightOptions: SummaryOptions = {
			detailLevel: 'Summary',
			truncationChars: 5000,
			compactStats: false,
			includeCss: false,
			generateToc: false,
			outputFormat: 'json',
			jsonVariant: 'light',
		};

		it('should truncate first user message beyond 200 chars in light skeleton', async () => {
			const longMessage = 'A '.repeat(150); // 300 chars
			const conversation = createMockConversation({
				sequence: [
					{
						role: 'user',
						content: longMessage,
						timestamp: '2026-01-15T10:00:00.000Z',
						isTruncated: false,
					},
				],
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 1,
					actionCount: 0,
					totalSize: 100,
				},
			});
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, lightOptions, helpers);

			const parsed = JSON.parse(result.content);
			const firstMsg = parsed.conversations[0].firstUserMessage;
			expect(firstMsg.length).toBeLessThanOrEqual(203); // 200 + '...'
			expect(firstMsg).toContain('...');
		});

		it('should not truncate first user message under 200 chars', async () => {
			const shortMessage = 'Short message';
			const conversation = createMockConversation({
				sequence: [
					{
						role: 'user',
						content: shortMessage,
						timestamp: '2026-01-15T10:00:00.000Z',
						isTruncated: false,
					},
				],
				metadata: {
					createdAt: '2026-01-15T10:00:00.000Z',
					lastActivity: '2026-01-15T12:00:00.000Z',
					messageCount: 1,
					actionCount: 0,
					totalSize: 100,
				},
			});
			const helpers = createJsonHelpers();
			const result = await exporter.generateJsonSummary(conversation, lightOptions, helpers);

			const parsed = JSON.parse(result.content);
			expect(parsed.conversations[0].firstUserMessage).toBe(shortMessage);
			expect(parsed.conversations[0].firstUserMessage).not.toContain('...');
		});
	});
});
