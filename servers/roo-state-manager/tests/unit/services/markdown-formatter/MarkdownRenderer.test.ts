import { describe, it, expect } from 'vitest';
import { MarkdownRenderer } from '../../../../src/services/markdown-formatter/MarkdownRenderer.js';

describe('MarkdownRenderer', () => {
    describe('formatUserMessage', () => {
        it('should format user message with timestamp', () => {
            const content = 'Hello world';
            const timestamp = '2023-01-01 12:00:00';
            const result = MarkdownRenderer.formatUserMessage(content, timestamp);
            
            expect(result).toContain('conversation-section user-message');
            expect(result).toContain('Message Utilisateur');
            expect(result).toContain(timestamp);
            expect(result).toContain(content);
        });

        it('should format user message without timestamp', () => {
            const content = 'Hello world';
            const result = MarkdownRenderer.formatUserMessage(content);
            
            expect(result).toContain('conversation-section user-message');
            expect(result).toContain(content);
            expect(result).not.toContain('timestamp');
        });
    });

    describe('formatAssistantMessage', () => {
        it('should format assistant message', () => {
            const content = 'I am here';
            const result = MarkdownRenderer.formatAssistantMessage(content);
            
            expect(result).toContain('conversation-section assistant-message');
            expect(result).toContain('Réponse Assistant');
            expect(result).toContain(content);
        });
    });

    describe('formatToolCall', () => {
        it('should format tool call', () => {
            const toolName = 'read_file';
            const params = { path: 'test.txt' };
            const result = MarkdownRenderer.formatToolCall(toolName, params);
            
            expect(result).toContain('conversation-section tool-call');
            expect(result).toContain(`Appel d'Outil: ${toolName}`);
            expect(result).toContain('test.txt');
        });
    });

    describe('formatToolResult', () => {
        it('should format tool result', () => {
            const toolName = 'read_file';
            const output = 'File content';
            const result = MarkdownRenderer.formatToolResult(toolName, output);
            
            expect(result).toContain('conversation-section tool-result');
            expect(result).toContain(`Résultat: ${toolName}`);
            expect(result).toContain(output);
        });
    });

    describe('formatConversationHeader', () => {
        it('should format header with metadata', () => {
            const metadata = {
                taskId: 'task-123',
                title: 'Test Task',
                messageCount: 5,
                totalSize: '1KB',
                createdAt: '2023-01-01'
            };
            const result = MarkdownRenderer.formatConversationHeader(metadata);
            
            expect(result).toContain('Test Task');
            expect(result).toContain('task-123');
            expect(result).toContain('5');
            expect(result).toContain('1KB');
        });
    });

    describe('formatSectionSeparator', () => {
        it('should format separator', () => {
            const title = 'New Section';
            const color = '#ff0000';
            const result = MarkdownRenderer.formatSectionSeparator(title, color);
            
            expect(result).toContain(title);
            expect(result).toContain(color);
        });
    });

    describe('formatMetadataTable', () => {
        it('should format metadata table', () => {
            const data = { key1: 'value1', key2: 'value2' };
            const result = MarkdownRenderer.formatMetadataTable(data);
            
            expect(result).toContain('key1');
            expect(result).toContain('value1');
            expect(result).toContain('key2');
            expect(result).toContain('value2');
        });
    });

    describe('formatToolParametersTable', () => {
        it('should format parameters table', () => {
            const params = { param1: 'val1' };
            const result = MarkdownRenderer.formatToolParametersTable(params);
            
            expect(result).toContain('param1');
            expect(result).toContain('val1');
        });

        it('should handle non-object parameters', () => {
            const result = MarkdownRenderer.formatToolParametersTable('string param');
            expect(result).toContain('string param');
        });
    });
});