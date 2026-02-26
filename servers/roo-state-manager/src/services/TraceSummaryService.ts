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
    ClusterSummaryStatistics,
    ClusterSummaryResult,
    OrganizedClusterTasks,
    ClassifiedClusterContent,
    CrossTaskPattern
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
    // MÉTHODES POUR LES GRAPPES DE TÂCHES (CLUSTER SUMMARY) - DÉLÉGATION
    // ============================================================================

    /**
     * Génère un résumé complet pour une grappe de tâches
     *
     * Délègue au module ClusterSummaryService pour la logique spécifique aux grappes.
     *
     * @param rootTask Tâche racine de la grappe (parent principal)
     * @param childTasks Liste des tâches enfantes de la grappe
     * @param options Options de génération spécifiques aux grappes
     * @returns Résumé structuré de la grappe complète
     */
    async generateClusterSummary(
        rootTask: ConversationSkeleton,
        childTasks: ConversationSkeleton[],
        options: Partial<ClusterSummaryOptions> = {}
    ): Promise<ClusterSummaryResult> {
        // Déléguer au service spécialisé avec callback pour les résumés individuels
        return this.clusterSummaryService.generateClusterSummary(
            rootTask,
            childTasks,
            options,
            async (conversation, opts) => this.generateSummary(conversation, opts)
        );
    }

    // ============================================================================
    // MÉTHODES UTILITAIRES POUR LES EXPORTS
    // ============================================================================

    /**
     * Tronque le contenu à un nombre maximum de caractères
     */
    private truncateContent(content: string, maxChars: number): string {
        if (maxChars <= 0 || content.length <= maxChars) {
            return content;
        }
        return content.substring(0, maxChars) + '\n\n... [Contenu tronqué]';
    }

    /**
     * Vérifie si le contenu a été tronqué
     */
    private isContentTruncated(content: string, maxChars: number): boolean {
        return maxChars > 0 && content.length > maxChars;
    }

    /**
     * Tronque un texte à une longueur maximale sans coupure de mot
     */
    private truncateText(text: string, maxLength: number): string {
        if (maxLength <= 0 || text.length <= maxLength) {
            return text;
        }
        const truncated = text.substring(0, maxLength);
        const lastSpace = truncated.lastIndexOf(' ');
        return (lastSpace > maxLength * 0.8 ? truncated.substring(0, lastSpace) : truncated) + '...';
    }

    /**
     * Fusionne les options avec les valeurs par défaut
     */
    private mergeWithDefaultOptions(options: Partial<SummaryOptions>): SummaryOptions {
        const defaults: SummaryOptions = {
            detailLevel: 'Full',
            truncationChars: 0,
            compactStats: false,
            includeCss: true,
            generateToc: true,
            outputFormat: 'markdown'
        };

        const result: SummaryOptions = {
            ...defaults,
            ...options,
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
