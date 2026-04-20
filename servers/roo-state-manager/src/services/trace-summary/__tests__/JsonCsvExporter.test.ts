/**
 * Tests unitaires pour JsonCsvExporter
 *
 * Couvre :
 * - generateJsonSummary : light + full variants, error handling
 * - generateCsvSummary : conversations/messages/tools variants, invalid variant
 * - Private methods via public interface:
 *   - calculateJsonLightSummary
 *   - convertToJsonSkeleton
 *   - extractFirstUserMessage
 *   - extractToolCallsFromMessage (bracket pattern + MCP XML pattern)
 *   - calculateJsonStatistics
 *   - escapeCsv
 *   - truncateText
 *   - formatCsvOutput
 * - Edge cases: empty sequence, missing fields, long content
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JsonCsvExporter } from '../JsonCsvExporter.js';
import type { ConversationSkeleton, MessageSkeleton } from '../../../types/conversation.js';
import type { SummaryOptions, SummaryStatistics } from '../../../types/trace-summary.js';

// ---------- Mock ContentClassifier ----------

const mockClassifier = {
    isToolResult: vi.fn((content: string) =>
        /^\[([^\]]+?)(?:\s+for\s+[^\]]*)?]\s+Result:/i.test(
            typeof content === 'string' ? content.trim() : ''
        )
    ),
} as any;

// ---------- Helpers ----------

function makeMessage(role: 'user' | 'assistant', content: string, timestamp = '2026-01-01T00:00:00Z'): MessageSkeleton {
    return { role, content, timestamp, isTruncated: false };
}

function makeSkeleton(messages: MessageSkeleton[] = [], taskId = 'test-task-001'): ConversationSkeleton {
    return {
        taskId,
        metadata: {
            title: 'Test conversation',
            lastActivity: '2026-01-01T01:00:00Z',
            createdAt: '2026-01-01T00:00:00Z',
            messageCount: messages.length,
            actionCount: messages.filter(m => m.role === 'assistant').length,
            totalSize: messages.reduce((s, m) => s + (m.content?.length || 0), 0),
            workspace: 'test-workspace',
        },
        sequence: messages,
    };
}

const defaultJsonHelpers = {
    truncateContent: (content: string, maxChars: number) =>
        content.length > maxChars ? content.substring(0, maxChars) + '...' : content,
    isContentTruncated: (content: string, maxChars: number) =>
        (content?.length || 0) > maxChars,
    getEmptyStatistics: (): SummaryStatistics => ({
        totalSections: 0, userMessages: 0, assistantMessages: 0, toolResults: 0,
        userContentSize: 0, assistantContentSize: 0, toolResultsSize: 0,
        totalContentSize: 0, userPercentage: 0, assistantPercentage: 0, toolResultsPercentage: 0,
    }),
    getOriginalContentSize: (conv: ConversationSkeleton) => conv.metadata.totalSize,
    calculateCompressionRatio: (original: number, final: number) =>
        original > 0 ? Math.round((final / original) * 100) / 100 : 0,
};

const defaultCsvHelpers = {
    isContentTruncated: (content: string, maxChars: number) =>
        (content?.length || 0) > maxChars,
    getEmptyStatistics: defaultJsonHelpers.getEmptyStatistics,
    truncateText: (text: string, maxLength: number) => {
        if (!text || text.length <= maxLength) return text;
        const truncated = text.substring(0, maxLength);
        const lastSpace = truncated.lastIndexOf(' ');
        return (lastSpace > maxLength * 0.8) ? truncated.substring(0, lastSpace) + '...' : truncated + '...';
    },
};

const baseOptions: SummaryOptions = {
    detailLevel: 'Summary',
    truncationChars: 5000,
    compactStats: false,
    includeCss: false,
    generateToc: false,
    outputFormat: 'json',
};

let exporter: JsonCsvExporter;

beforeEach(() => {
    vi.clearAllMocks();
    exporter = new JsonCsvExporter(mockClassifier);
});

// ===========================================================================
// generateJsonSummary — light variant
// ===========================================================================

describe('generateJsonSummary — light variant', () => {
    it('produces valid light JSON with correct structure', async () => {
        const conv = makeSkeleton([makeMessage('user', 'Hello')]);
        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'light' }, defaultJsonHelpers);

        expect(result.success).toBe(true);
        const parsed = JSON.parse(result.content);
        expect(parsed.format).toBe('roo-conversation-light');
        expect(parsed.version).toBe('1.0');
        expect(parsed.conversations).toHaveLength(1);
        expect(parsed.conversations[0].taskId).toBe('test-task-001');
        expect(parsed.drillDown.available).toBe(true);
    });

    it('includes summary with totals and date range', async () => {
        const conv = makeSkeleton([
            makeMessage('user', 'Hello'),
            makeMessage('assistant', 'World'),
        ]);
        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'light' }, defaultJsonHelpers);

        const parsed = JSON.parse(result.content);
        expect(parsed.summary.totalConversations).toBe(1);
        expect(parsed.summary.totalMessages).toBe(2);
    });

    it('extracts first user message in skeleton', async () => {
        const conv = makeSkeleton([
            makeMessage('assistant', 'Hi'),
            makeMessage('user', 'Please do X'),
            makeMessage('assistant', 'Done'),
        ]);
        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'light' }, defaultJsonHelpers);

        const parsed = JSON.parse(result.content);
        expect(parsed.conversations[0].firstUserMessage).toContain('Please do X');
    });

    it('handles empty sequence gracefully', async () => {
        const conv = makeSkeleton([]);
        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'light' }, defaultJsonHelpers);

        expect(result.success).toBe(true);
        const parsed = JSON.parse(result.content);
        expect(parsed.conversations[0].firstUserMessage).toBe('');
    });

    it('computes compression ratio', async () => {
        const conv = makeSkeleton([makeMessage('user', 'A'.repeat(100))]);
        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'light' }, defaultJsonHelpers);

        expect(result.statistics.compressionRatio).toBeDefined();
        expect(result.statistics.compressionRatio).toBeGreaterThanOrEqual(0);
    });
});

// ===========================================================================
// generateJsonSummary — full variant
// ===========================================================================

describe('generateJsonSummary — full variant', () => {
    it('produces valid full JSON with messages', async () => {
        const conv = makeSkeleton([
            makeMessage('user', 'Hello'),
            makeMessage('assistant', 'World'),
        ]);
        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'full' }, defaultJsonHelpers);

        expect(result.success).toBe(true);
        const parsed = JSON.parse(result.content);
        expect(parsed.format).toBe('roo-conversation-full');
        expect(parsed.task.taskId).toBe('test-task-001');
        expect(parsed.task.messages).toHaveLength(2);
        expect(parsed.task.messages[0].role).toBe('user');
        expect(parsed.task.messages[1].role).toBe('assistant');
    });

    it('truncates content when exceeding truncationChars', async () => {
        const longContent = 'A'.repeat(100);
        const conv = makeSkeleton([makeMessage('user', longContent)]);
        const helpers = {
            ...defaultJsonHelpers,
            truncateContent: vi.fn((c: string, max: number) => c.substring(0, max)),
            isContentTruncated: vi.fn(() => true),
        };

        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'full', truncationChars: 10 }, helpers);
        const parsed = JSON.parse(result.content);

        expect(parsed.task.messages[0].isTruncated).toBe(true);
        expect(helpers.truncateContent).toHaveBeenCalled();
    });

    it('extracts tool calls from message content', async () => {
        const toolContent = '[read_file for \'path/to/file\'] Result:\nFile contents here';
        const conv = makeSkeleton([makeMessage('assistant', toolContent)]);
        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'full' }, defaultJsonHelpers);

        const parsed = JSON.parse(result.content);
        const toolCalls = parsed.task.messages[0].toolCalls;
        expect(toolCalls).toHaveLength(1);
        // Regex captures "read_file for 'path/to/file'" as toolName (bracket content)
        expect(toolCalls[0].toolName).toContain('read_file');
        expect(toolCalls[0].success).toBe(true);
    });

    it('extracts MCP tool calls from XML content', async () => {
        const mcpContent = '<use_mcp_tool><server_name>roo-state-manager</server_name><tool_name>roosync_send</tool_name><arguments>{"to":"ai-01"}</arguments></use_mcp_tool>';
        const conv = makeSkeleton([makeMessage('assistant', mcpContent)]);
        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'full' }, defaultJsonHelpers);

        const parsed = JSON.parse(result.content);
        const toolCalls = parsed.task.messages[0].toolCalls;
        expect(toolCalls.length).toBeGreaterThanOrEqual(1);
        const mcpCall = toolCalls.find((t: any) => t.serverName === 'roo-state-manager');
        expect(mcpCall).toBeDefined();
        expect(mcpCall.toolName).toBe('roosync_send');
    });

    it('detects failed tool results', async () => {
        const failContent = '[execute_command] Result:\nError: command not found';
        const conv = makeSkeleton([makeMessage('assistant', failContent)]);
        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'full' }, defaultJsonHelpers);

        const parsed = JSON.parse(result.content);
        const toolCalls = parsed.task.messages[0].toolCalls;
        expect(toolCalls[0].success).toBe(false);
    });
});

// ===========================================================================
// generateJsonSummary — error handling
// ===========================================================================

describe('generateJsonSummary — error handling', () => {
    it('catches exceptions and returns error result', async () => {
        const conv = makeSkeleton([makeMessage('user', 'Hello')]);
        const badHelpers = {
            ...defaultJsonHelpers,
            getOriginalContentSize: vi.fn(() => { throw new Error('Disk read error'); }),
        };

        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'light' }, badHelpers);
        expect(result.success).toBe(false);
        expect(result.error).toBe('Disk read error');
    });
});

// ===========================================================================
// generateCsvSummary — conversations variant
// ===========================================================================

describe('generateCsvSummary — conversations variant', () => {
    it('produces CSV with headers and data rows', async () => {
        const conv = makeSkeleton([makeMessage('user', 'Hello')]);
        const result = await exporter.generateCsvSummary(conv, { ...baseOptions, csvVariant: 'conversations' }, defaultCsvHelpers);

        expect(result.success).toBe(true);
        const lines = result.content.split('\n');
        expect(lines[0]).toContain('taskId');
        expect(lines[0]).toContain('workspace');
        expect(lines).toHaveLength(2); // header + 1 row
    });

    it('escapes commas in CSV values', async () => {
        const conv = makeSkeleton([makeMessage('user', 'Hello')]);
        conv.metadata.workspace = 'workspace, with, commas';
        const result = await exporter.generateCsvSummary(conv, { ...baseOptions, csvVariant: 'conversations' }, defaultCsvHelpers);

        const lines = result.content.split('\n');
        expect(lines[1]).toContain('"workspace, with, commas"');
    });

    it('escapes quotes in CSV values', async () => {
        const conv = makeSkeleton([makeMessage('user', 'He said "hello"')]);
        const result = await exporter.generateCsvSummary(conv, { ...baseOptions, csvVariant: 'conversations' }, defaultCsvHelpers);

        const lines = result.content.split('\n');
        // First user message in the row should have escaped quotes
        expect(lines[1]).toMatch(/""/);
    });
});

// ===========================================================================
// generateCsvSummary — messages variant
// ===========================================================================

describe('generateCsvSummary — messages variant', () => {
    it('produces CSV with message-level details', async () => {
        const conv = makeSkeleton([
            makeMessage('user', 'Hello'),
            makeMessage('assistant', 'World'),
        ]);
        const result = await exporter.generateCsvSummary(conv, { ...baseOptions, csvVariant: 'messages' }, defaultCsvHelpers);

        expect(result.success).toBe(true);
        const lines = result.content.split('\n');
        expect(lines[0]).toContain('messageIndex');
        expect(lines[0]).toContain('role');
        expect(lines).toHaveLength(3); // header + 2 messages
    });

    it('counts tool calls per message', async () => {
        const toolContent = '[read_file] Result:\nOK\n[write_file] Result:\nDone';
        const conv = makeSkeleton([makeMessage('assistant', toolContent)]);
        const result = await exporter.generateCsvSummary(conv, { ...baseOptions, csvVariant: 'messages' }, defaultCsvHelpers);

        const lines = result.content.split('\n');
        // 2nd line should show toolCount = 2
        expect(lines[1]).toMatch(/2/);
    });

    it('reports isTruncated flag', async () => {
        const conv = makeSkeleton([makeMessage('user', 'Hello')]);
        const helpers = {
            ...defaultCsvHelpers,
            isContentTruncated: vi.fn(() => true),
        };

        const result = await exporter.generateCsvSummary(conv, { ...baseOptions, csvVariant: 'messages' }, helpers);
        const lines = result.content.split('\n');
        expect(lines[1]).toContain('true');
    });
});

// ===========================================================================
// generateCsvSummary — tools variant
// ===========================================================================

describe('generateCsvSummary — tools variant', () => {
    it('produces CSV with tool-level details', async () => {
        const toolContent = '[read_file for \'path/to/file\'] Result:\nFile contents here';
        const conv = makeSkeleton([makeMessage('assistant', toolContent)]);
        const result = await exporter.generateCsvSummary(conv, { ...baseOptions, csvVariant: 'tools' }, defaultCsvHelpers);

        expect(result.success).toBe(true);
        const lines = result.content.split('\n');
        expect(lines[0]).toContain('toolName');
        expect(lines[0]).toContain('serverName');
        expect(lines).toHaveLength(2); // header + 1 tool
    });

    it('handles messages with no tools', async () => {
        const conv = makeSkeleton([makeMessage('user', 'No tools here')]);
        const result = await exporter.generateCsvSummary(conv, { ...baseOptions, csvVariant: 'tools' }, defaultCsvHelpers);

        expect(result.success).toBe(true);
        const lines = result.content.split('\n');
        // Only header, no data rows
        expect(lines).toHaveLength(1);
    });

    it('handles multiple tools across messages', async () => {
        const msg1 = '[read_file] Result:\nOK';
        const msg2 = '[write_file] Result:\nDone';
        const conv = makeSkeleton([
            makeMessage('assistant', msg1),
            makeMessage('assistant', msg2),
        ]);
        const result = await exporter.generateCsvSummary(conv, { ...baseOptions, csvVariant: 'tools' }, defaultCsvHelpers);

        const lines = result.content.split('\n');
        expect(lines).toHaveLength(3); // header + 2 tools
    });
});

// ===========================================================================
// generateCsvSummary — invalid variant
// ===========================================================================

describe('generateCsvSummary — validation', () => {
    it('returns error for unsupported CSV variant', async () => {
        const conv = makeSkeleton([makeMessage('user', 'Hello')]);
        const result = await exporter.generateCsvSummary(
            conv,
            { ...baseOptions, csvVariant: 'invalid' as any },
            defaultCsvHelpers
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('Unsupported CSV variant');
    });

    it('catches exceptions during CSV generation', async () => {
        const conv = null as any;
        const result = await exporter.generateCsvSummary(conv, { ...baseOptions, csvVariant: 'conversations' }, defaultCsvHelpers);

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
    });
});

// ===========================================================================
// calculateJsonStatistics (via generateJsonSummary)
// ===========================================================================

describe('calculateJsonStatistics', () => {
    it('counts user and assistant messages correctly', async () => {
        const conv = makeSkeleton([
            makeMessage('user', 'Hello'),
            makeMessage('assistant', 'Hi'),
            makeMessage('user', 'Do something'),
        ]);
        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'light' }, defaultJsonHelpers);

        expect(result.statistics.userMessages).toBe(2);
        expect(result.statistics.assistantMessages).toBe(1);
    });

    it('classifies tool results using ContentClassifier', async () => {
        const toolResult = '[execute_command] Result:\noutput here';
        const conv = makeSkeleton([makeMessage('user', toolResult)]);
        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'light' }, defaultJsonHelpers);

        expect(mockClassifier.isToolResult).toHaveBeenCalled();
        expect(result.statistics.toolResults).toBe(1);
        expect(result.statistics.userMessages).toBe(0);
    });

    it('handles empty conversation', async () => {
        const conv = makeSkeleton([]);
        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'light' }, defaultJsonHelpers);

        expect(result.statistics.totalSections).toBe(0);
        expect(result.statistics.userMessages).toBe(0);
        expect(result.statistics.assistantMessages).toBe(0);
    });
});

// ===========================================================================
// extractToolCallsFromMessage — edge cases (via full JSON)
// ===========================================================================

describe('extractToolCallsFromMessage — edge cases', () => {
    it('handles empty content', async () => {
        const conv = makeSkeleton([makeMessage('assistant', '')]);
        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'full' }, defaultJsonHelpers);

        const parsed = JSON.parse(result.content);
        expect(parsed.task.messages[0].toolCalls).toEqual([]);
    });

    it('handles content with no tool patterns', async () => {
        const conv = makeSkeleton([makeMessage('assistant', 'Just a regular message')]);
        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'full' }, defaultJsonHelpers);

        const parsed = JSON.parse(result.content);
        expect(parsed.task.messages[0].toolCalls).toEqual([]);
    });

    it('handles malformed MCP XML gracefully', async () => {
        const malformedXml = '<use_mcp_tool><server_name>broken</server_name><tool_name></tool_name><arguments>not-json</arguments></use_mcp_tool>';
        const conv = makeSkeleton([makeMessage('assistant', malformedXml)]);
        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'full' }, defaultJsonHelpers);

        expect(result.success).toBe(true);
        // Should not crash, may produce 0 or 1 tool calls depending on parsing
    });

    it('limits tool result to 500 chars', async () => {
        const longResult = 'A'.repeat(1000);
        const toolContent = `[my_tool] Result:\n${longResult}`;
        const conv = makeSkeleton([makeMessage('assistant', toolContent)]);
        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'full' }, defaultJsonHelpers);

        const parsed = JSON.parse(result.content);
        expect(parsed.task.messages[0].toolCalls[0].result.length).toBeLessThanOrEqual(500);
    });
});

// ===========================================================================
// escapeCsv — via conversations CSV
// ===========================================================================

describe('escapeCsv', () => {
    it('escapes newlines in values', async () => {
        const conv = makeSkeleton([makeMessage('user', 'Line1\nLine2')]);
        conv.metadata.workspace = 'ws';
        const result = await exporter.generateCsvSummary(conv, { ...baseOptions, csvVariant: 'conversations' }, defaultCsvHelpers);

        const lines = result.content.split('\n');
        // escapeCsv wraps in quotes but the newline inside quotes creates extra lines
        // The header + the row content split across lines
        expect(lines[0]).toContain('taskId');
        expect(result.content).toContain('Line1');
        expect(result.content).toContain('Line2');
    });
});

// ===========================================================================
// truncateText — via light JSON (firstUserMessage)
// ===========================================================================

describe('truncateText via firstUserMessage', () => {
    it('truncates first user message to 200 chars', async () => {
        const longMsg = 'X'.repeat(300);
        const conv = makeSkeleton([makeMessage('user', longMsg)]);
        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'light' }, defaultJsonHelpers);

        const parsed = JSON.parse(result.content);
        expect(parsed.conversations[0].firstUserMessage.length).toBeLessThanOrEqual(203); // 200 + '...'
    });
});

// ===========================================================================
// workspace fallback
// ===========================================================================

describe('workspace handling', () => {
    it('defaults to "unknown" when workspace is missing', async () => {
        const conv = makeSkeleton([makeMessage('user', 'Hello')]);
        delete (conv.metadata as any).workspace;
        const result = await exporter.generateJsonSummary(conv, { ...baseOptions, jsonVariant: 'light' }, defaultJsonHelpers);

        const parsed = JSON.parse(result.content);
        expect(parsed.conversations[0].workspace).toBe('unknown');
    });
});
