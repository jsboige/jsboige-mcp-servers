import { describe, test, expect } from 'vitest';
import { MarkdownRenderer } from '../MarkdownRenderer.js';

describe('MarkdownRenderer', () => {
    describe('formatUserMessage', () => {
        test('generates HTML with user message content', () => {
            const result = MarkdownRenderer.formatUserMessage('Hello world');
            expect(result).toContain('user-message');
            expect(result).toContain('Message Utilisateur');
            expect(result).toContain('Hello world');
        });

        test('includes timestamp when provided', () => {
            const result = MarkdownRenderer.formatUserMessage('Test', '2026-01-15 10:30');
            expect(result).toContain('2026-01-15 10:30');
            expect(result).toContain('timestamp');
        });

        test('omits timestamp when not provided', () => {
            const result = MarkdownRenderer.formatUserMessage('Test');
            expect(result).not.toContain('<small class="timestamp">');
        });
    });

    describe('formatAssistantMessage', () => {
        test('generates HTML with assistant message content', () => {
            const result = MarkdownRenderer.formatAssistantMessage('Response text');
            expect(result).toContain('assistant-message');
            expect(result).toContain('Réponse Assistant');
            expect(result).toContain('Response text');
        });

        test('includes timestamp when provided', () => {
            const result = MarkdownRenderer.formatAssistantMessage('Test', '15:30');
            expect(result).toContain('15:30');
        });
    });

    describe('formatToolCall', () => {
        test('generates HTML with tool name', () => {
            const result = MarkdownRenderer.formatToolCall('read_file', { path: '/test.ts' });
            expect(result).toContain('tool-call');
            expect(result).toContain('read_file');
        });

        test('includes parameter table for objects', () => {
            const result = MarkdownRenderer.formatToolCall('read_file', { path: '/test.ts', encoding: 'utf-8' });
            expect(result).toContain('tool-parameters-table');
            expect(result).toContain('path');
            expect(result).toContain('/test.ts');
            expect(result).toContain('encoding');
        });

        test('handles null parameters', () => {
            const result = MarkdownRenderer.formatToolCall('some_tool', null);
            expect(result).toContain('some_tool');
            expect(result).toContain('<pre><code>');
        });
    });

    describe('formatToolResult', () => {
        test('generates HTML with string result', () => {
            const result = MarkdownRenderer.formatToolResult('read_file', 'file contents here');
            expect(result).toContain('tool-result');
            expect(result).toContain('Résultat: read_file');
            expect(result).toContain('file contents here');
        });

        test('JSON-stringifies object results', () => {
            const result = MarkdownRenderer.formatToolResult('get_status', { ok: true, count: 5 });
            expect(result).toContain('"ok": true');
            expect(result).toContain('"count": 5');
        });
    });

    describe('formatConversationHeader', () => {
        test('generates header with task ID', () => {
            const result = MarkdownRenderer.formatConversationHeader({ taskId: 'abc-123' });
            expect(result).toContain('abc-123');
            expect(result).toContain('conversation-header');
        });

        test('uses custom title when provided', () => {
            const result = MarkdownRenderer.formatConversationHeader({ taskId: 'id', title: 'My Custom Title' });
            expect(result).toContain('My Custom Title');
        });

        test('uses default title when none provided', () => {
            const result = MarkdownRenderer.formatConversationHeader({ taskId: 'id' });
            expect(result).toContain("RESUME DE TRACE D'ORCHESTRATION ROO");
        });

        test('includes message count', () => {
            const result = MarkdownRenderer.formatConversationHeader({ taskId: 'id', messageCount: 42 });
            expect(result).toContain('42');
        });

        test('includes total size', () => {
            const result = MarkdownRenderer.formatConversationHeader({ taskId: 'id', totalSize: '15 KB' });
            expect(result).toContain('15 KB');
        });

        test('formats creation date in French', () => {
            const result = MarkdownRenderer.formatConversationHeader({
                taskId: 'id',
                createdAt: '2026-01-15T10:30:00Z'
            });
            expect(result).toContain('15');
        });
    });

    describe('formatSectionSeparator', () => {
        test('generates separator with title and color', () => {
            const result = MarkdownRenderer.formatSectionSeparator('Section A', '#ff0000');
            expect(result).toContain('Section A');
            expect(result).toContain('#ff0000');
            expect(result).toContain('section-separator-with-title');
        });
    });

    describe('formatMetadataTable', () => {
        test('generates HTML table from key-value pairs', () => {
            const result = MarkdownRenderer.formatMetadataTable({ Name: 'Test', Version: '1.0' });
            expect(result).toContain('metadata-table');
            expect(result).toContain('Name');
            expect(result).toContain('Test');
            expect(result).toContain('Version');
            expect(result).toContain('1.0');
        });

        test('handles empty data', () => {
            const result = MarkdownRenderer.formatMetadataTable({});
            expect(result).toContain('metadata-table');
        });
    });

    describe('formatToolParametersTable', () => {
        test('generates table for object parameters', () => {
            const result = MarkdownRenderer.formatToolParametersTable({ path: 'test.ts', mode: 'read' });
            expect(result).toContain('tool-parameters-table');
            expect(result).toContain('path');
            expect(result).toContain('test.ts');
        });

        test('returns pre/code block for non-object params', () => {
            const result = MarkdownRenderer.formatToolParametersTable('plain text');
            expect(result).toContain('<pre><code>plain text</code></pre>');
        });

        test('returns pre/code block for null params', () => {
            const result = MarkdownRenderer.formatToolParametersTable(null);
            expect(result).toContain('<pre><code>');
        });

        test('JSON-stringifies nested objects in parameters', () => {
            const result = MarkdownRenderer.formatToolParametersTable({ config: { debug: true } });
            expect(result).toContain('"debug": true');
        });
    });
});
