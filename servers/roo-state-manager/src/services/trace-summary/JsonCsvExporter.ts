/**
 * JsonCsvExporter - Export de conversations aux formats JSON et CSV
 *
 * Extrait de TraceSummaryService.ts pour modularisation (#521)
 */

import {
    SummaryOptions,
    SummaryResult,
    SummaryStatistics,
    JsonExportLight,
    JsonConversationSkeleton,
    JsonExportFull,
    JsonMessage,
    JsonToolCall,
    CsvConversationRecord,
    CsvMessageRecord,
    CsvToolRecord
} from '../../types/trace-summary.js';
import { ConversationSkeleton, MessageSkeleton } from '../../types/conversation.js';
import { ContentClassifier } from './ContentClassifier.js';

/**
 * Interface pour les messages JSON
 */
interface JsonMessageInternal {
    role: 'user' | 'assistant';
    timestamp: string;
    content: string;
    isTruncated: boolean;
    toolCalls: JsonToolCall[];
}

/**
 * Service d'export JSON et CSV pour les résumés de conversation
 */
export class JsonCsvExporter {
    constructor(private classifier: ContentClassifier) {}

    /**
     * Génère un résumé au format JSON
     */
    public async generateJsonSummary(
        conversation: ConversationSkeleton,
        options: SummaryOptions,
        helpers: {
            truncateContent: (content: string, maxChars: number) => string;
            isContentTruncated: (content: string, maxChars: number) => boolean;
            getEmptyStatistics: () => SummaryStatistics;
            getOriginalContentSize: (conversation: ConversationSkeleton) => number;
            calculateCompressionRatio: (original: number, final: number) => number;
        }
    ): Promise<SummaryResult> {
        const variant = options.jsonVariant || 'light';

        try {
            let content: string;
            let statistics: SummaryStatistics;

            if (variant === 'light') {
                const conversations = [conversation];
                const jsonExport: JsonExportLight = {
                    format: 'roo-conversation-light',
                    version: '1.0',
                    exportTime: new Date().toISOString(),
                    summary: this.calculateJsonLightSummary(conversations),
                    conversations: conversations.map(conv => this.convertToJsonSkeleton(conv)),
                    drillDown: {
                        available: true,
                        endpoint: 'view_task_details',
                        fullDataEndpoint: 'get_raw_conversation'
                    }
                };
                content = JSON.stringify(jsonExport, null, 2);
                statistics = this.calculateJsonStatistics(conversations, this.classifier);
            } else {
                const jsonExport: JsonExportFull = {
                    format: 'roo-conversation-full',
                    version: '1.0',
                    exportTime: new Date().toISOString(),
                    task: {
                        taskId: conversation.taskId,
                        metadata: {
                            createdAt: conversation.metadata.createdAt,
                            lastActivity: conversation.metadata.lastActivity,
                            messageCount: conversation.metadata.messageCount,
                            actionCount: conversation.metadata.actionCount,
                            totalSize: conversation.metadata.totalSize,
                            workspace: conversation.metadata.workspace || 'unknown'
                        },
                        messages: this.convertToJsonMessages(conversation, options, helpers),
                        children: []
                    }
                };
                content = JSON.stringify(jsonExport, null, 2);
                statistics = this.calculateJsonStatistics([conversation], this.classifier);
            }

            return {
                success: true,
                content,
                statistics: {
                    ...statistics,
                    compressionRatio: helpers.calculateCompressionRatio(
                        helpers.getOriginalContentSize(conversation),
                        content.length
                    )
                }
            };
        } catch (error) {
            return {
                success: false,
                content: '',
                statistics: helpers.getEmptyStatistics(),
                error: error instanceof Error ? error.message : 'JSON generation error'
            };
        }
    }

    /**
     * Génère un résumé au format CSV
     */
    public async generateCsvSummary(
        conversation: ConversationSkeleton,
        options: SummaryOptions,
        helpers: {
            isContentTruncated: (content: string, maxChars: number) => boolean;
            getEmptyStatistics: () => SummaryStatistics;
            truncateText: (text: string, maxLength: number) => string;
        }
    ): Promise<SummaryResult> {
        const validVariants = ['conversations', 'messages', 'tools'] as const;
        const variant = options.csvVariant || 'conversations';

        // Validation du variant
        if (!validVariants.includes(variant)) {
            return {
                success: false,
                content: '',
                statistics: helpers.getEmptyStatistics(),
                error: `Unsupported CSV variant: ${variant}. Supported: ${validVariants.join(', ')}`
            };
        }

        try {
            let content: string;
            const conversations = [conversation];

            switch (variant) {
                case 'messages':
                    content = this.generateCsvMessages(conversation, options, helpers);
                    break;
                case 'tools':
                    content = this.generateCsvTools(conversation, options);
                    break;
                case 'conversations':
                default:
                    content = this.generateCsvConversations(conversations, helpers);
                    break;
            }

            return {
                success: true,
                content,
                statistics: helpers.getEmptyStatistics()
            };
        } catch (error) {
            return {
                success: false,
                content: '',
                statistics: helpers.getEmptyStatistics(),
                error: error instanceof Error ? error.message : 'CSV generation error'
            };
        }
    }

    // ============================================================================
    // MÉTHODES PRIVÉES JSON
    // ============================================================================

    private calculateJsonLightSummary(conversations: ConversationSkeleton[]) {
        const totalMessages = conversations.reduce((sum, conv) => sum + conv.metadata.messageCount, 0);
        const totalSize = conversations.reduce((sum, conv) => sum + conv.metadata.totalSize, 0);

        const dates = conversations
            .map(conv => new Date(conv.metadata.createdAt).getTime())
            .sort((a, b) => a - b);

        return {
            totalConversations: conversations.length,
            totalMessages: totalMessages,
            totalSize: totalSize,
            dateRange: {
                earliest: new Date(dates[0] || Date.now()).toISOString(),
                latest: new Date(dates[dates.length - 1] || Date.now()).toISOString()
            }
        };
    }

    private convertToJsonSkeleton(conversation: ConversationSkeleton): JsonConversationSkeleton {
        const firstUserMessage = this.extractFirstUserMessage(conversation);

        return {
            taskId: conversation.taskId,
            firstUserMessage: this.truncateText(firstUserMessage, 200),
            isCompleted: false,
            workspace: conversation.metadata.workspace || 'unknown',
            createdAt: conversation.metadata.createdAt,
            lastActivity: conversation.metadata.lastActivity,
            messageCount: conversation.metadata.messageCount,
            actionCount: conversation.metadata.actionCount,
            totalSize: conversation.metadata.totalSize,
            children: []
        };
    }

    private extractFirstUserMessage(conversation: ConversationSkeleton): string {
        const userMessages = (conversation.sequence ?? []).filter(item =>
            'role' in item && item.role === 'user'
        ) as MessageSkeleton[];

        if (userMessages.length > 0) {
            return userMessages[0].content || '';
        }
        return '';
    }

    private convertToJsonMessages(
        conversation: ConversationSkeleton,
        options: SummaryOptions,
        helpers: {
            truncateContent: (content: string, maxChars: number) => string;
            isContentTruncated: (content: string, maxChars: number) => boolean;
        }
    ): JsonMessageInternal[] {
        const messages = (conversation.sequence ?? []).filter(item =>
            'role' in item && 'content' in item
        ) as MessageSkeleton[];

        return messages.map(message => {
            const toolCalls = this.extractToolCallsFromMessage(message.content);

            return {
                role: message.role as 'user' | 'assistant',
                timestamp: message.timestamp,
                content: helpers.truncateContent(message.content, options.truncationChars),
                isTruncated: helpers.isContentTruncated(message.content, options.truncationChars),
                toolCalls: toolCalls
            };
        });
    }

    private extractToolCallsFromMessage(content: string): JsonToolCall[] {
        const toolCalls: JsonToolCall[] = [];

        if (!content) return toolCalls;

        // Pattern 1: Résultats d'outils standard [tool_name] Result:
        const toolResultPattern = /\[([^\]]+)(?:\s+for\s+['"]([^'"]*?)['"])?\]\s*Result:([\s\S]*?)(?=\n\[|$)/g;
        let match;

        while ((match = toolResultPattern.exec(content)) !== null) {
            const toolName = match[1];
            const targetPath = match[2];
            const result = match[3]?.trim() || '';

            toolCalls.push({
                toolName: toolName,
                arguments: targetPath ? { path: targetPath } : {},
                result: result.substring(0, 500),
                success: !result.toLowerCase().includes('error') && !result.toLowerCase().includes('failed')
            });
        }

        // Pattern 2: Appels MCP <use_mcp_tool>
        const mcpPattern = /<use_mcp_tool>([\s\S]*?)<\/use_mcp_tool>/g;
        while ((match = mcpPattern.exec(content)) !== null) {
            try {
                const serverMatch = match[1].match(/<server_name>(.*?)<\/server_name>/);
                const toolNameMatch = match[1].match(/<tool_name>(.*?)<\/tool_name>/);
                const argsMatch = match[1].match(/<arguments>([\s\S]*?)<\/arguments>/);

                if (toolNameMatch) {
                    toolCalls.push({
                        toolName: toolNameMatch[1],
                        serverName: serverMatch?.[1],
                        arguments: argsMatch ? JSON.parse(argsMatch[1]) : {},
                        result: '',
                        success: true
                    });
                }
            } catch (e) {
                // Ignorer les erreurs de parsing XML
            }
        }

        return toolCalls;
    }

    // ============================================================================
    // MÉTHODES PRIVÉES CSV
    // ============================================================================

    private generateCsvConversations(
        conversations: ConversationSkeleton[],
        helpers: { truncateText: (text: string, maxLength: number) => string; }
    ): string {
        const headers = [
            'taskId', 'workspace', 'isCompleted', 'createdAt', 'lastActivity',
            'messageCount', 'actionCount', 'totalSize', 'firstUserMessage'
        ];

        const rows = conversations.map(conv => {
            const firstUserMessage = this.extractFirstUserMessage(conv);
            return [
                conv.taskId,
                this.escapeCsv(conv.metadata.workspace || ''),
                false,
                conv.metadata.createdAt,
                conv.metadata.lastActivity,
                conv.metadata.messageCount,
                conv.metadata.actionCount,
                conv.metadata.totalSize,
                this.escapeCsv(helpers.truncateText(firstUserMessage, 200))
            ];
        });

        return this.formatCsvOutput(headers, rows);
    }

    private generateCsvMessages(
        conversation: ConversationSkeleton,
        options: SummaryOptions,
        helpers: { isContentTruncated: (content: string, maxChars: number) => boolean; }
    ): string {
        const headers = [
            'taskId', 'messageIndex', 'role', 'timestamp', 'contentLength',
            'isTruncated', 'toolCount', 'workspace'
        ];

        const messages = (conversation.sequence ?? []).filter(item =>
            'role' in item && 'content' in item
        ) as MessageSkeleton[];

        const rows = messages.map((message, index) => {
            const toolCalls = this.extractToolCallsFromMessage(message.content);

            return [
                conversation.taskId,
                index + 1,
                message.role,
                message.timestamp,
                message.content?.length || 0,
                helpers.isContentTruncated(message.content, options.truncationChars),
                toolCalls.length,
                this.escapeCsv(conversation.metadata.workspace || '')
            ];
        });

        return this.formatCsvOutput(headers, rows);
    }

    private generateCsvTools(conversation: ConversationSkeleton, options: SummaryOptions): string {
        const headers = [
            'taskId', 'messageIndex', 'toolName', 'serverName', 'executionTime',
            'success', 'argsCount', 'resultLength', 'workspace'
        ];

        const rows: any[][] = [];
        const messages = (conversation.sequence ?? []).filter(item =>
            'role' in item && 'content' in item
        ) as MessageSkeleton[];

        messages.forEach((message, messageIndex) => {
            const toolCalls = this.extractToolCallsFromMessage(message.content);

            toolCalls.forEach(tool => {
                rows.push([
                    conversation.taskId,
                    messageIndex + 1,
                    tool.toolName,
                    tool.serverName || '',
                    message.timestamp,
                    tool.success,
                    Object.keys(tool.arguments || {}).length,
                    tool.result?.length || 0,
                    this.escapeCsv(conversation.metadata.workspace || '')
                ]);
            });
        });

        return this.formatCsvOutput(headers, rows);
    }

    private formatCsvOutput(headers: string[], rows: any[][]): string {
        const csvLines = [headers.join(',')];

        rows.forEach(row => {
            const escapedRow = row.map(cell => this.escapeCsv(cell));
            csvLines.push(escapedRow.join(','));
        });

        return csvLines.join('\n');
    }

    private escapeCsv(value: any): string {
        const str = String(value || '');
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    }

    private truncateText(text: string, maxLength: number): string {
        if (!text || text.length <= maxLength) return text;

        const truncated = text.substring(0, maxLength);
        const lastSpace = truncated.lastIndexOf(' ');

        return (lastSpace > maxLength * 0.8)
            ? truncated.substring(0, lastSpace) + '...'
            : truncated + '...';
    }

    // ============================================================================
    // MÉTHODES PRIVÉES STATISTIQUES
    // ============================================================================

    private calculateJsonStatistics(
        conversations: ConversationSkeleton[],
        classifier: ContentClassifier
    ): SummaryStatistics {
        let totalMessages = 0;
        let totalSize = 0;
        let userMessages = 0;
        let assistantMessages = 0;
        let toolResults = 0;

        for (const conv of conversations) {
            totalMessages += conv.metadata.messageCount;
            totalSize += conv.metadata.totalSize;

            const messages = (conv.sequence ?? []).filter(item =>
                'role' in item && 'content' in item
            ) as MessageSkeleton[];

            for (const message of messages) {
                if (message.role === 'user') {
                    if (classifier.isToolResult(message.content)) {
                        toolResults++;
                    } else {
                        userMessages++;
                    }
                } else if (message.role === 'assistant') {
                    assistantMessages++;
                }
            }
        }

        return {
            totalSections: totalMessages,
            userMessages: userMessages,
            assistantMessages: assistantMessages,
            toolResults: toolResults,
            userContentSize: Math.round(totalSize * 0.4),
            assistantContentSize: Math.round(totalSize * 0.4),
            toolResultsSize: Math.round(totalSize * 0.2),
            totalContentSize: totalSize,
            userPercentage: totalSize > 0 ? Math.round((totalSize * 0.4 / totalSize) * 100 * 10) / 10 : 0,
            assistantPercentage: totalSize > 0 ? Math.round((totalSize * 0.4 / totalSize) * 100 * 10) / 10 : 0,
            toolResultsPercentage: totalSize > 0 ? Math.round((totalSize * 0.2 / totalSize) * 100 * 10) / 10 : 0
        };
    }
}
