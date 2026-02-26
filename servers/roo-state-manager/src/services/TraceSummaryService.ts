/**
 * TraceSummaryService - Service de génération de résumés intelligents de traces Roo
 *
 * Ce service porte la logique du script PowerShell Convert-TraceToSummary-Optimized.ps1
 * vers un service Node.js/TypeScript intégré dans l'écosystème roo-state-manager.
 *
 * SDDD Phase 3 : Intégration Strategy Pattern pour 6 niveaux de détail
 */

import * as path from 'path';
import * as fs from 'fs';
import {
    ConversationSkeleton,
    MessageSkeleton,
    ActionMetadata,
    ClusterSummaryOptions,
    ClusterSummaryResult
} from '../types/conversation.js';
import { ExportConfigManager } from './ExportConfigManager.js';
import { DetailLevelStrategyFactory } from './reporting/DetailLevelStrategyFactory.js';
import { IReportingStrategy } from './reporting/IReportingStrategy.js';
import { DetailLevel, EnhancedSummaryOptions } from '../types/enhanced-conversation.js';
import { ClassifiedContent as EnhancedClassifiedContent } from '../types/enhanced-conversation.js';
import { SummaryGenerator } from './trace-summary/SummaryGenerator.js';
import { ContentClassifier, ClassifiedContent } from './trace-summary/ContentClassifier.js';
import { sanitizeSectionHtml } from './trace-summary/ExportRenderer.js';
import { JsonCsvExporter } from './trace-summary/JsonCsvExporter.js';
import { ClusterSummaryService } from './trace-summary/ClusterSummaryService.js';
import { TraceSummaryServiceError, TraceSummaryServiceErrorCode } from '../types/errors.js';

export { sanitizeSectionHtml };

// Import types depuis le fichier dédié
import {
    ExportFormat,
    JsonVariant,
    CsvVariant,
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
    CsvToolRecord,
    MsgType,
    RenderItem
} from '../types/trace-summary.js';

// Re-export pour compatibilité
export type {
    ExportFormat,
    JsonVariant,
    CsvVariant,
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
    CsvToolRecord,
    MsgType,
    RenderItem
};

export type { ClassifiedContent }

/**
 * Service principal de génération de résumés intelligents
 */
export class TraceSummaryService {
    private readonly MCP_TOOLS = [
        'read_file', 'list_files', 'write_to_file', 'apply_diff',
        'execute_command', 'browser_action', 'search_files', 'codebase_search',
        'new_task', 'ask_followup_question', 'attempt_completion',
        'insert_content', 'search_and_replace', 'use_mcp_tool'
    ];

    private summaryGenerator: SummaryGenerator;
    private classifier: ContentClassifier;
    private jsonCsvExporter: JsonCsvExporter;
    private clusterSummaryService: ClusterSummaryService;

    constructor(
        private readonly exportConfigManager: ExportConfigManager
    ) {
        this.summaryGenerator = new SummaryGenerator();
        this.classifier = new ContentClassifier();
        this.jsonCsvExporter = new JsonCsvExporter(this.classifier);
        this.clusterSummaryService = new ClusterSummaryService();
    }

    /**
     * Génère un résumé intelligent à partir d'un ConversationSkeleton
     */
    async generateSummary(
        conversation: ConversationSkeleton,
        options: Partial<SummaryOptions> = {}
    ): Promise<SummaryResult> {
        try {
            const fullOptions = this.mergeWithDefaultOptions(options);

            // Dispatcher selon le format de sortie
            switch (fullOptions.outputFormat) {
                case 'json':
                    return await this.jsonCsvExporter.generateJsonSummary(conversation, fullOptions, {
                        truncateContent: (c, m) => this.truncateContent(c, m),
                        isContentTruncated: (c, m) => this.isContentTruncated(c, m),
                        getEmptyStatistics: () => this.getEmptyStatistics(),
                        getOriginalContentSize: (c) => this.getOriginalContentSize(c),
                        calculateCompressionRatio: (o, f) => this.calculateCompressionRatio(o, f)
                    });
                case 'csv':
                    return await this.jsonCsvExporter.generateCsvSummary(conversation, fullOptions, {
                        isContentTruncated: (c, m) => this.isContentTruncated(c, m),
                        getEmptyStatistics: () => this.getEmptyStatistics(),
                        truncateText: (t, m) => this.truncateText(t, m)
                    });
                case 'markdown':
                case 'html':
                default:
                    // Déléguer au SummaryGenerator pour les formats standard
                    return await this.summaryGenerator.generateSummary(conversation, options);
            }

        } catch (error) {
            return {
                success: false,
                content: '',
                statistics: this.getEmptyStatistics(),
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    // ============================================================================
    // MÉTHODES POUR LES GRAPPES DE TÂCHES (CLUSTER SUMMARY)
    // ============================================================================

    /**
     * Génère un résumé complet pour une grappe de tâches
     * Délègue au ClusterSummaryService
     */
    async generateClusterSummary(
        rootTask: ConversationSkeleton,
        childTasks: ConversationSkeleton[],
        options: Partial<ClusterSummaryOptions> = {}
    ): Promise<ClusterSummaryResult> {
        return this.clusterSummaryService.generateClusterSummary(
            rootTask,
            childTasks,
            options,
            async (conversation, opts) => {
                return await this.generateSummary(conversation, opts);
            }
        );
    }

    /**
     * Génère un résumé au format JSON (light ou full)
     */
    private async generateJsonSummary(
        conversation: ConversationSkeleton,
        options: SummaryOptions
    ): Promise<SummaryResult> {
        const variant = options.jsonVariant || 'light';

        try {
            let content: string;
            let statistics: SummaryStatistics;

            if (variant === 'light') {
                // JSON Light - Multiple conversations skeleton
                const conversations = [conversation]; // Pour l'instant, une seule conversation
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
                statistics = this.calculateJsonStatistics(conversations);
            } else {
                // JSON Full - Single conversation avec détails complets
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
                        messages: this.convertToJsonMessages(conversation, options),
                        children: [] // À implémenter avec les relations parent-enfant
                    }
                };
                content = JSON.stringify(jsonExport, null, 2);
                statistics = this.calculateJsonStatistics([conversation]);
            }

            return {
                success: true,
                content,
                statistics: {
                    ...statistics,
                    compressionRatio: this.calculateCompressionRatio(
                        this.getOriginalContentSize(conversation),
                        content.length
                    )
                }
            };
        } catch (error) {
            return {
                success: false,
                content: '',
                statistics: this.getEmptyStatistics(),
                error: error instanceof Error ? error.message : 'JSON generation error'
            };
        }
    }

    /**
     * Génère un résumé au format CSV (conversations, messages, ou tools)
     */
    private async generateCsvSummary(
        conversation: ConversationSkeleton,
        options: SummaryOptions
    ): Promise<SummaryResult> {
        const variant = options.csvVariant || 'conversations';

        try {
            let content: string;
            let statistics: SummaryStatistics;

            switch (variant) {
                case 'conversations':
                    content = this.generateCsvConversations([conversation]);
                    break;
                case 'messages':
                    content = this.generateCsvMessages(conversation, options);
                    break;
                case 'tools':
                    content = this.generateCsvTools(conversation, options);
                    break;
                default:
                    throw new TraceSummaryServiceError(
                        `Unsupported CSV variant: ${variant}`,
                        TraceSummaryServiceErrorCode.EXPORT_FAILED,
                        { variant, supportedVariants: ['conversations', 'messages', 'tools'] }
                    );
            }

            statistics = this.calculateJsonStatistics([conversation]); // Réutiliser la logique de calcul

            return {
                success: true,
                content,
                statistics: {
                    ...statistics,
                    compressionRatio: this.calculateCompressionRatio(
                        this.getOriginalContentSize(conversation),
                        content.length
                    )
                }
            };
        } catch (error) {
            return {
                success: false,
                content: '',
                statistics: this.getEmptyStatistics(),
                error: error instanceof Error ? error.message : 'CSV generation error'
            };
        }
    }

    /**
     * Calcule les statistiques de résumé pour les formats JSON
     */
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

    /**
     * Convertit un ConversationSkeleton en JsonConversationSkeleton
     */
    private convertToJsonSkeleton(conversation: ConversationSkeleton): JsonConversationSkeleton {
        // Récupérer le premier message utilisateur
        const firstUserMessage = this.extractFirstUserMessage(conversation);

        return {
            taskId: conversation.taskId,
            firstUserMessage: this.truncateText(firstUserMessage, 200),
            isCompleted: false, // À déterminer selon la logique métier
            workspace: conversation.metadata.workspace || 'unknown',
            createdAt: conversation.metadata.createdAt,
            lastActivity: conversation.metadata.lastActivity,
            messageCount: conversation.metadata.messageCount,
            actionCount: conversation.metadata.actionCount,
            totalSize: conversation.metadata.totalSize,
            children: [] // À implémenter avec les relations parent-enfant
        };
    }

    /**
     * Extrait le premier message utilisateur d'une conversation
     */
    private extractFirstUserMessage(conversation: ConversationSkeleton): string {
        const userMessages = conversation.sequence.filter(item =>
            'role' in item && item.role === 'user'
        ) as MessageSkeleton[];

        if (userMessages.length > 0) {
            return userMessages[0].content || '';
        }
        return '';
    }

    /**
     * Convertit les messages en format JSON avec extraction des tool calls
     */
    private convertToJsonMessages(conversation: ConversationSkeleton, options: SummaryOptions): JsonMessage[] {
        const messages = conversation.sequence.filter(item =>
            'role' in item && 'content' in item
        ) as MessageSkeleton[];

        return messages.map(message => {
            const toolCalls = this.extractToolCallsFromMessage(message.content);

            return {
                role: message.role as 'user' | 'assistant',
                timestamp: message.timestamp,
                content: this.truncateContent(message.content, options.truncationChars),
                isTruncated: this.isContentTruncated(message.content, options.truncationChars),
                toolCalls: toolCalls
            };
        });
    }

    /**
     * Extrait les appels d'outils depuis le contenu d'un message
     */
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
                result: result.substring(0, 500), // Limiter la taille du résultat
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
                        result: '', // Sera extrait du message suivant
                        success: true
                    });
                }
            } catch (e) {
                // Ignorer les erreurs de parsing XML
            }
        }

        return toolCalls;
    }

    /**
     * Génère un CSV de conversations
     */
    private generateCsvConversations(conversations: ConversationSkeleton[]): string {
        const headers = [
            'taskId', 'workspace', 'isCompleted', 'createdAt', 'lastActivity',
            'messageCount', 'actionCount', 'totalSize', 'firstUserMessage'
        ];

        const rows = conversations.map(conv => {
            const firstUserMessage = this.extractFirstUserMessage(conv);
            return [
                conv.taskId,
                this.escapeCsv(conv.metadata.workspace || ''),
                false, // isCompleted - À déterminer selon la logique métier
                conv.metadata.createdAt,
                conv.metadata.lastActivity,
                conv.metadata.messageCount,
                conv.metadata.actionCount,
                conv.metadata.totalSize,
                this.escapeCsv(this.truncateText(firstUserMessage, 200))
            ];
        });

        return this.formatCsvOutput(headers, rows);
    }

    /**
     * Génère un CSV de messages
     */
    private generateCsvMessages(conversation: ConversationSkeleton, options: SummaryOptions): string {
        const headers = [
            'taskId', 'messageIndex', 'role', 'timestamp', 'contentLength',
            'isTruncated', 'toolCount', 'workspace'
        ];

        const messages = conversation.sequence.filter(item =>
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
                this.isContentTruncated(message.content, options.truncationChars),
                toolCalls.length,
                this.escapeCsv(conversation.metadata.workspace || '')
            ];
        });

        return this.formatCsvOutput(headers, rows);
    }

    /**
     * Génère un CSV d'outils
     */
    private generateCsvTools(conversation: ConversationSkeleton, options: SummaryOptions): string {
        const headers = [
            'taskId', 'messageIndex', 'toolName', 'serverName', 'executionTime',
            'success', 'argsCount', 'resultLength', 'workspace'
        ];

        const rows: any[][] = [];
        const messages = conversation.sequence.filter(item =>
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
                    tool.serverName ? message.timestamp : message.timestamp, // executionTime
                    tool.success,
                    Object.keys(tool.arguments || {}).length,
                    tool.result?.length || 0,
                    this.escapeCsv(conversation.metadata.workspace || '')
                ]);
            });
        });

        return this.formatCsvOutput(headers, rows);
    }

    /**
     * Formate la sortie CSV finale
     */
    private formatCsvOutput(headers: string[], rows: any[][]): string {
        const csvLines = [headers.join(',')];

        rows.forEach(row => {
            const escapedRow = row.map(cell => this.escapeCsv(cell));
            csvLines.push(escapedRow.join(','));
        });

        return csvLines.join('\n');
    }

    /**
     * Échappe les valeurs CSV
     */
    private escapeCsv(value: any): string {
        const str = String(value || '');
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    }

    /**
     * Tronque le contenu selon les options
     */
    private truncateContent(content: string, maxChars: number): string {
        if (maxChars > 0 && content && content.length > maxChars) {
            const halfLength = Math.floor(maxChars / 2);
            return content.substring(0, halfLength) +
                   `\n\n... [TRUNCATED ${content.length - maxChars} chars] ...\n\n` +
                   content.substring(content.length - halfLength);
        }
        return content;
    }

    /**
     * Vérifie si le contenu est tronqué
     */
    private isContentTruncated(content: string, maxChars: number): boolean {
        return maxChars > 0 && !!content && content.length > maxChars;
    }

    /**
     * Tronque le texte intelligemment
     */
    private truncateText(text: string, maxLength: number): string {
        if (!text || text.length <= maxLength) return text;

        const truncated = text.substring(0, maxLength);
        const lastSpace = truncated.lastIndexOf(' ');

        return (lastSpace > maxLength * 0.8)
            ? truncated.substring(0, lastSpace) + '...'
            : truncated + '...';
    }

    /**
     * Calcule les statistiques pour les formats JSON/CSV
     */
    private calculateJsonStatistics(conversations: ConversationSkeleton[]): SummaryStatistics {
        let totalMessages = 0;
        let totalSize = 0;
        let userMessages = 0;
        let assistantMessages = 0;
        let toolResults = 0;

        for (const conv of conversations) {
            totalMessages += conv.metadata.messageCount;
            totalSize += conv.metadata.totalSize;

            const messages = conv.sequence.filter(item =>
                'role' in item && 'content' in item
            ) as MessageSkeleton[];

            for (const message of messages) {
                if (message.role === 'user') {
                    if (this.classifier.isToolResult(message.content)) {
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
            userContentSize: Math.round(totalSize * 0.4), // Estimation
            assistantContentSize: Math.round(totalSize * 0.4), // Estimation
            toolResultsSize: Math.round(totalSize * 0.2), // Estimation
            totalContentSize: totalSize,
            userPercentage: totalSize > 0 ? Math.round((totalSize * 0.4 / totalSize) * 100 * 10) / 10 : 0,
            assistantPercentage: totalSize > 0 ? Math.round((totalSize * 0.4 / totalSize) * 100 * 10) / 10 : 0,
            toolResultsPercentage: totalSize > 0 ? Math.round((totalSize * 0.2 / totalSize) * 100 * 10) / 10 : 0
        };
    }

    /**
     * Fusionne les options avec les valeurs par défaut
     */
    private mergeWithDefaultOptions(options: Partial<SummaryOptions>): SummaryOptions {
        const result = {
            detailLevel: options.detailLevel || 'Full',
            truncationChars: options.truncationChars || 0,
            compactStats: options.compactStats || false,
            includeCss: options.includeCss !== undefined ? options.includeCss : true,
            generateToc: options.generateToc !== undefined ? options.generateToc : true,
            outputFormat: options.outputFormat || 'markdown',
            jsonVariant: options.jsonVariant,
            csvVariant: options.csvVariant,
            // SDDD Phase 3: Feature flag pour les strategies (désactivé par défaut pour compatibilité)
            enableDetailLevels: options.enableDetailLevels || false,
            // CORRECTION CRITIQUE: tocStyle doit être synchronisé avec outputFormat
            // Si outputFormat est 'markdown', utiliser 'markdown' pour éviter les balises HTML
            tocStyle: options.tocStyle || ((options.outputFormat || 'markdown') === 'html' ? 'html' : 'markdown'),
            hideEnvironmentDetails: options.hideEnvironmentDetails !== undefined ? options.hideEnvironmentDetails : true,
            startIndex: options.startIndex,
            endIndex: options.endIndex
        };
        return result;
    }

    /**
     * Calcule le ratio de compression
     */
    private calculateCompressionRatio(originalSize: number, finalSize: number): number {
        return finalSize > 0 ? Math.round((originalSize / finalSize) * 100) / 100 : 1;
    }

    /**
     * Calcule la taille du contenu original
     */
    private getOriginalContentSize(conversation: ConversationSkeleton): number {
        const messages = conversation.sequence.filter((item): item is MessageSkeleton =>
            'role' in item && 'content' in item);

        return messages.reduce((total: number, message: MessageSkeleton) => total + message.content.length, 0);
    }

    /**
     * Retourne des statistiques vides en cas d'erreur
     */
    private getEmptyStatistics(): SummaryStatistics {
        return {
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
            toolResultsPercentage: 0
        };
    }
}
