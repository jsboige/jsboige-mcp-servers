/**
 * TraceSummaryService - Service de génération de résumés intelligents de traces Roo
 *
 * Ce service porte la logique du script PowerShell Convert-TraceToSummary-Optimized.ps1
 * vers un service Node.js/TypeScript intégré dans l'écosystème roo-state-manager.
 *
 * SDDD Phase 3 : Intégration Strategy Pattern pour 6 niveaux de détail
 */

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

/**
 * Options de configuration pour la génération de résumé
 */
export type ExportFormat = 'markdown' | 'html' | 'json' | 'csv';
export type JsonVariant = 'light' | 'full';
export type CsvVariant = 'conversations' | 'messages' | 'tools';

export interface SummaryOptions {
    detailLevel: 'Full' | 'NoTools' | 'NoResults' | 'Messages' | 'Summary' | 'UserOnly';
    truncationChars: number;
    compactStats: boolean;
    includeCss: boolean;
    generateToc: boolean;
    outputFormat: ExportFormat;
    jsonVariant?: JsonVariant;
    csvVariant?: CsvVariant;
    // SDDD Phase 3: Feature flag pour les strategies
    enableDetailLevels?: boolean;
}

/**
 * Résultat de génération de résumé
 */
export interface SummaryResult {
    success: boolean;
    content: string;
    statistics: SummaryStatistics;
    error?: string;
}

/**
 * Statistiques calculées sur le contenu
 */
export interface SummaryStatistics {
    totalSections: number;
    userMessages: number;
    assistantMessages: number;
    toolResults: number;
    userContentSize: number;
    assistantContentSize: number;
    toolResultsSize: number;
    totalContentSize: number;
    userPercentage: number;
    assistantPercentage: number;
    toolResultsPercentage: number;
    compressionRatio?: number;
}

/**
 * Formats d'export JSON
 */
export interface JsonExportLight {
    format: 'roo-conversation-light';
    version: string;
    exportTime: string;
    summary: {
        totalConversations: number;
        totalMessages: number;
        totalSize: number;
        dateRange: {
            earliest: string;
            latest: string;
        };
    };
    conversations: JsonConversationSkeleton[];
    drillDown: {
        available: boolean;
        endpoint: string;
        fullDataEndpoint: string;
    };
}

export interface JsonConversationSkeleton {
    taskId: string;
    firstUserMessage: string;
    isCompleted: boolean;
    workspace: string;
    createdAt: string;
    lastActivity: string;
    messageCount: number;
    actionCount: number;
    totalSize: number;
    children: string[];
}

export interface JsonExportFull {
    format: 'roo-conversation-full';
    version: string;
    exportTime: string;
    task: {
        taskId: string;
        metadata: {
            createdAt: string;
            lastActivity: string;
            messageCount: number;
            actionCount: number;
            totalSize: number;
            workspace: string;
            location?: string;
        };
        messages: JsonMessage[];
        children: string[];
    };
}

export interface JsonMessage {
    role: 'user' | 'assistant';
    timestamp: string;
    content: string;
    isTruncated: boolean;
    toolCalls: JsonToolCall[];
}

export interface JsonToolCall {
    toolName: string;
    serverName?: string;
    arguments: Record<string, any>;
    result: string;
    success: boolean;
}

/**
 * Formats d'export CSV
 */
export interface CsvConversationRecord {
    taskId: string;
    workspace: string;
    isCompleted: boolean;
    createdAt: string;
    lastActivity: string;
    messageCount: number;
    actionCount: number;
    totalSize: number;
    firstUserMessage: string;
}

export interface CsvMessageRecord {
    taskId: string;
    messageIndex: number;
    role: string;
    timestamp: string;
    contentLength: number;
    isTruncated: boolean;
    toolCount: number;
    workspace: string;
}

export interface CsvToolRecord {
    taskId: string;
    messageIndex: number;
    toolName: string;
    serverName: string;
    executionTime: string;
    success: boolean;
    argsCount: number;
    resultLength: number;
    workspace: string;
}

/**
 * Contenu classifié après parsing
 */
export interface ClassifiedContent {
    type: 'User' | 'Assistant';
    subType: 'UserMessage' | 'ToolResult' | 'ToolCall' | 'Completion';
    content: string;
    index: number;
    lineNumber?: number;
    toolType?: string;
    resultType?: string;
}

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

    constructor(
        private readonly exportConfigManager: ExportConfigManager
    ) {}

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
            let content: string;
            let statistics: SummaryStatistics;
            
            switch (fullOptions.outputFormat) {
                case 'json':
                    return await this.generateJsonSummary(conversation, fullOptions);
                case 'csv':
                    return await this.generateCsvSummary(conversation, fullOptions);
                case 'markdown':
                case 'html':
                default:
                    // Logique existante pour markdown/html
                    const classifiedContent = this.classifyConversationContent(conversation);
                    statistics = this.calculateStatistics(classifiedContent);
                    
                    content = await this.renderSummary(
                        conversation,
                        classifiedContent,
                        statistics,
                        fullOptions
                    );

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

    /**
     * Classifie le contenu de la conversation en sections typées
     */
    private classifyConversationContent(conversation: ConversationSkeleton): ClassifiedContent[] {
        const classified: ClassifiedContent[] = [];
        let index = 0;

        // Filtrer seulement les MessageSkeleton de la sequence
        const messages = conversation.sequence.filter((item): item is MessageSkeleton =>
            'role' in item && 'content' in item);


        for (const message of messages) {
            if (message.role === 'user') {
                const isToolResult = this.isToolResult(message.content);
                classified.push({
                    type: 'User',
                    subType: isToolResult ? 'ToolResult' : 'UserMessage',
                    content: message.content,
                    index: index++,
                    toolType: isToolResult ? this.extractToolType(message.content) : undefined,
                    resultType: isToolResult ? this.getResultType(message.content) : undefined
                });
            } else if (message.role === 'assistant') {
                const isCompletion = this.isCompletionMessage(message.content);
                classified.push({
                    type: 'Assistant',
                    subType: isCompletion ? 'Completion' : 'ToolCall',
                    content: message.content,
                    index: index++
                });
            }
        }

        return classified;
    }

    /**
     * Calcule les statistiques détaillées du contenu
     */
    private calculateStatistics(classifiedContent: ClassifiedContent[]): SummaryStatistics {
        let userMessages = 0;
        let assistantMessages = 0;
        let toolResults = 0;
        let userContentSize = 0;
        let assistantContentSize = 0;
        let toolResultsSize = 0;

        for (const item of classifiedContent) {
            const contentSize = item.content.length;

            switch (item.subType) {
                case 'UserMessage':
                    userMessages++;
                    userContentSize += contentSize;
                    break;
                case 'ToolResult':
                    toolResults++;
                    toolResultsSize += contentSize;
                    break;
                case 'ToolCall':
                case 'Completion':
                    assistantMessages++;
                    assistantContentSize += contentSize;
                    break;
            }
        }

        const totalContentSize = userContentSize + assistantContentSize + toolResultsSize;
        
        return {
            totalSections: classifiedContent.length,
            userMessages,
            assistantMessages,
            toolResults,
            userContentSize,
            assistantContentSize,
            toolResultsSize,
            totalContentSize,
            userPercentage: totalContentSize > 0 ? Math.round((userContentSize / totalContentSize) * 100 * 10) / 10 : 0,
            assistantPercentage: totalContentSize > 0 ? Math.round((assistantContentSize / totalContentSize) * 100 * 10) / 10 : 0,
            toolResultsPercentage: totalContentSize > 0 ? Math.round((toolResultsSize / totalContentSize) * 100 * 10) / 10 : 0
        };
    }

    /**
     * Génère le contenu du résumé selon les options
     */
    private async renderSummary(
        conversation: ConversationSkeleton,
        classifiedContent: ClassifiedContent[],
        statistics: SummaryStatistics,
        options: SummaryOptions
    ): Promise<string> {
        const parts: string[] = [];

        // 1. En-tête et métadonnées
        parts.push(this.generateHeader(conversation, options));
        parts.push(this.generateMetadata(conversation, statistics));

        // 2. CSS si demandé
        if (options.includeCss) {
            parts.push(this.generateEmbeddedCss());
        }

        // 3. Statistiques
        parts.push(this.generateStatistics(statistics, options.compactStats));

        // 4. Table des matières (si demandée et pas en mode Summary)
        if (options.generateToc && options.detailLevel !== 'Summary') {
            const toc = this.generateTableOfContents(classifiedContent, options);
            parts.push(toc);
        }

        // 5. NOUVELLE SECTION : Contenu conversationnel
        if (options.detailLevel !== 'Summary') {
            // SDDD Phase 3: Utilisation des strategies si activées
            const conversationContent = await this.renderConversationContentWithStrategies(
                classifiedContent,
                options
            );
            parts.push(conversationContent);
        }

        // 6. Footer
        parts.push(this.generateFooter(options));

        return parts.join('\n\n');
    }

    // ============================================================================
    // SDDD PHASE 3: INTÉGRATION STRATEGY PATTERN POUR 6 NIVEAUX DE DÉTAIL
    // ============================================================================

    /**
     * Génère le contenu conversationnel en utilisant les strategies (SDDD Phase 3)
     */
    private async renderConversationContentWithStrategies(
        classifiedContent: ClassifiedContent[],
        options: SummaryOptions
    ): Promise<string> {
        // Feature flag pour activer/désactiver les strategies
        if (!options.enableDetailLevels) {
            return this.renderConversationContent(classifiedContent, options);
        }

        try {
            // Convertir le format legacy vers le format enhanced
            const enhancedContent = this.convertToEnhancedFormat(classifiedContent);
            
            // Créer la strategy appropriée
            const strategy = DetailLevelStrategyFactory.createStrategy(options.detailLevel as DetailLevel);
            
            // Générer le contenu avec la strategy
            const enhancedOptions: EnhancedSummaryOptions = {
                detailLevel: options.detailLevel as DetailLevel,
                outputFormat: options.outputFormat === 'markdown' ? 'markdown' : 'html',
                truncationChars: options.truncationChars,
                compactStats: options.compactStats,
                includeCss: options.includeCss,
                generateToc: options.generateToc
            };

            const strategicContent = strategy.generateReport(enhancedContent, enhancedOptions);
            
            return strategicContent;
            
        } catch (error) {
            console.warn('Strategy rendering failed, falling back to legacy:', error);
            return this.renderConversationContent(classifiedContent, options);
        }
    }

    /**
     * Convertit le format ClassifiedContent legacy vers EnhancedClassifiedContent
     */
    private convertToEnhancedFormat(legacyContent: ClassifiedContent[]): EnhancedClassifiedContent[] {
        return legacyContent.map((item, index) => ({
            ...item,
            // Propriétés requises par le format enhanced
            contentSize: item.content.length,
            isRelevant: true, // Par défaut, considérer comme pertinent
            confidenceScore: 0.8, // Score de confiance par défaut
            // Parsing XML amélioré pour les outils
            toolCallDetails: this.extractToolCallDetails(item),
            toolResultDetails: this.extractToolResultDetails(item),
            // Métadonnées supplémentaires
            timestamp: new Date().toISOString(),
            processingNotes: []
        }));
    }

    /**
     * Extrait les détails d'appel d'outil avec parsing XML amélioré (SDDD Phase 3)
     */
    private extractToolCallDetails(item: ClassifiedContent): any {
        if (item.type !== 'Assistant' || item.subType !== 'ToolCall') {
            return undefined;
        }

        // Parsing XML amélioré pour les outils
        const toolXmlMatches = item.content.match(/<([a-zA-Z_][a-zA-Z0-9_\-:]+)(?:\s+[^>]*)?>[\s\S]*?<\/\1>/g);
        
        if (!toolXmlMatches) {
            return undefined;
        }

        const toolCalls = toolXmlMatches.map(xmlBlock => {
            const tagMatch = xmlBlock.match(/<([a-zA-Z_][a-zA-Z0-9_\-:]+)/);
            const toolName = tagMatch ? tagMatch[1] : 'unknown_tool';
            
            // Extraction des paramètres avec parsing XML amélioré
            const parameters = this.parseToolParameters(xmlBlock);
            
            return {
                toolName,
                parameters,
                rawXml: xmlBlock,
                parsedSuccessfully: parameters !== null
            };
        });

        return {
            toolCalls,
            totalCalls: toolCalls.length,
            hasParsingErrors: toolCalls.some(call => !call.parsedSuccessfully)
        };
    }

    /**
     * Parse sophistiqué des paramètres d'outils XML (SDDD Phase 3)
     */
    private parseToolParameters(xmlBlock: string): Record<string, any> | null {
        try {
            // Extraction basique des paramètres pour l'instant
            // TODO: Implémenter un parsing XML plus sophistiqué si nécessaire
            const paramMatches = xmlBlock.match(/<([a-zA-Z_][a-zA-Z0-9_\-:]+)>([\s\S]*?)<\/\1>/g);
            
            if (!paramMatches) {
                return null;
            }

            const parameters: Record<string, any> = {};
            
            for (const paramMatch of paramMatches) {
                const tagMatch = paramMatch.match(/<([a-zA-Z_][a-zA-Z0-9_\-:]+)>([\s\S]*?)<\/\1>/);
                if (tagMatch) {
                    const [, paramName, paramValue] = tagMatch;
                    // Éviter de parser les balises racines d'outils
                    if (!this.isRootToolTag(paramName)) {
                        parameters[paramName] = paramValue.trim();
                    }
                }
            }

            return parameters;
        } catch (error) {
            console.warn('Failed to parse tool parameters:', error);
            return null;
        }
    }

    /**
     * Vérifie si une balise est une balise racine d'outil
     */
    private isRootToolTag(tagName: string): boolean {
        const rootToolTags = [
            'read_file', 'write_to_file', 'apply_diff', 'execute_command',
            'browser_action', 'search_files', 'codebase_search', 'list_files',
            'new_task', 'ask_followup_question', 'attempt_completion',
            'insert_content', 'search_and_replace', 'use_mcp_tool'
        ];
        return rootToolTags.includes(tagName);
    }

    /**
     * Extrait les détails de résultats d'outils
     */
    private extractToolResultDetails(item: ClassifiedContent): any {
        if (item.type !== 'User' || item.subType !== 'ToolResult') {
            return undefined;
        }

        const resultMatch = item.content.match(/\[([^\]]+)\] Result:\s*(.*)/s);
        if (!resultMatch) {
            return undefined;
        }

        const [, toolName, result] = resultMatch;
        
        return {
            toolName,
            resultType: this.getResultType(result),
            contentLength: result.length,
            hasError: this.detectResultError(result),
            parsedResult: this.parseStructuredResult(result)
        };
    }

    /**
     * Détecte si un résultat contient une erreur
     */
    private detectResultError(result: string): boolean {
        return /error|failed|unable|exception|denied/i.test(result);
    }

    /**
     * Parse les résultats structurés (JSON, XML, etc.)
     */
    private parseStructuredResult(result: string): any {
        // Tentative de parsing JSON
        try {
            return JSON.parse(result);
        } catch {
            // Pas un JSON valide
        }

        // Détection de structures XML ou autres formats
        if (result.includes('<files>') || result.includes('<file>')) {
            return { type: 'file_structure', content: result };
        }

        if (result.includes('Command executed')) {
            return { type: 'command_output', content: result };
        }

        return { type: 'text', content: result };
    }

    /**
     * Détecte si un message est un résultat d'outil
     */
    private isToolResult(content: string): boolean {
        return /\[[^\]]+\] Result:/i.test(content);
    }

    /**
     * Détecte si un message assistant est une completion
     */
    private isCompletionMessage(content: string): boolean {
        return /<attempt_completion>/i.test(content);
    }

    /**
     * Extrait le type d'outil d'un message
     */
    private extractToolType(content: string): string {
        const match = content.match(/\[([^\]]+)\] Result:/);
        return match ? match[1] : 'outil';
    }

    /**
     * Détermine le type de résultat d'un outil
     */
    private getResultType(content: string): string {
        if (/<files>/i.test(content)) return 'files';
        if (/<file_write_result>/i.test(content)) return 'écriture fichier';
        if (/Command executed/i.test(content)) return 'exécution commande';
        if (/Browser launched|Browser.*action/i.test(content)) return 'navigation web';
        if (/<environment_details>/i.test(content)) return 'détails environnement';
        if (/Result:.*Error|Unable to apply diff/i.test(content)) return 'erreur';
        if (/Todo list updated/i.test(content)) return 'mise à jour todo';
        return 'résultat';
    }

    /**
     * Génère l'en-tête du résumé
     */
    private generateHeader(conversation: ConversationSkeleton, options: SummaryOptions): string {
        return `# RÉSUMÉ DE TRACE D'ORCHESTRATION ROO

**Task ID :** ${conversation.taskId}
**Titre :** ${conversation.metadata.title || 'N/A'}
**Date de génération :** ${new Date().toLocaleString('fr-FR')}
**Mode de détail :** ${options.detailLevel}`;
    }

    /**
     * Génère les métadonnées de base
     */
    private generateMetadata(conversation: ConversationSkeleton, statistics: SummaryStatistics): string {
        return `**Taille totale du contenu :** ${Math.round(statistics.totalContentSize / 1024 * 10) / 10} KB
**Nombre total d'échanges :** ${statistics.totalSections}
**Créé le :** ${new Date(conversation.metadata.createdAt).toLocaleString('fr-FR')}
**Dernière activité :** ${new Date(conversation.metadata.lastActivity).toLocaleString('fr-FR')}
**Mode de conversation :** ${conversation.metadata.mode || 'N/A'}`;
    }

    /**
     * Génère le CSS embarqué pour le styling
     */
    private generateEmbeddedCss(): string {
        return `<style>
.user-message {
    background-color: #FFEBEE;
    border-left: 4px solid #F44336;
    padding: 15px;
    margin: 10px 0;
    border-radius: 5px;
}
.assistant-message {
    background-color: #E8F4FD;
    border-left: 4px solid #2196F3;
    padding: 15px;
    margin: 10px 0;
    border-radius: 5px;
}
.tool-message {
    background-color: #FFF8E1;
    border-left: 4px solid #FF9800;
    padding: 15px;
    margin: 10px 0;
    border-radius: 5px;
}
.completion-message {
    background-color: #E8F5E8;
    border-left: 4px solid #4CAF50;
    padding: 15px;
    margin: 10px 0;
    border-radius: 5px;
}
.toc {
    background-color: #f8f9fa;
    border: 1px solid #dee2e6;
    border-radius: 8px;
    padding: 20px;
    margin: 15px 0;
}
.toc h3 {
    margin-top: 0;
    color: #495057;
    border-bottom: 2px solid #6c757d;
    padding-bottom: 10px;
}
</style>`;
    }

    /**
     * Génère les statistiques détaillées
     */
    private generateStatistics(statistics: SummaryStatistics, compact: boolean): string {
        const header = compact ? "## STATISTIQUES" : "## STATISTIQUES DÉTAILLÉES";
        
        if (compact) {
            return `${header}

| Métrique | Valeur | % |
|----------|--------|---|
| Messages User | ${statistics.userMessages} | ${statistics.userPercentage}% |
| Réponses Assistant | ${statistics.assistantMessages} | ${statistics.assistantPercentage}% |
| Résultats d'outils | ${statistics.toolResults} | ${statistics.toolResultsPercentage}% |
| Total échanges | ${statistics.totalSections} | 100% |`;
        } else {
            return `${header}

| Métrique | Valeur | Taille | % |
|----------|--------|--------|---|
| Messages User | ${statistics.userMessages} | ${Math.round(statistics.userContentSize/1024 * 10)/10} KB | ${statistics.userPercentage}% |
| Réponses Assistant | ${statistics.assistantMessages} | ${Math.round(statistics.assistantContentSize/1024 * 10)/10} KB | ${statistics.assistantPercentage}% |
| Résultats d'outils | ${statistics.toolResults} | ${Math.round(statistics.toolResultsSize/1024 * 10)/10} KB | ${statistics.toolResultsPercentage}% |
| **Total échanges** | **${statistics.totalSections}** | **${Math.round(statistics.totalContentSize/1024 * 10)/10} KB** | **100%** |`;
        }
    }

    /**
     * Génère la table des matières
     */
    private generateTableOfContents(classifiedContent: ClassifiedContent[], options: SummaryOptions): string {
        const parts: string[] = [
            '<div class="toc">',
            '',
            '### SOMMAIRE DES MESSAGES {#table-des-matieres}',
            ''
        ];

        let userCounter = 1;
        let assistantCounter = 1;
        let toolCounter = 1;

        for (const item of classifiedContent) {
            const firstLine = this.getTruncatedFirstLine(item.content, 100);
            
            switch (item.subType) {
                case 'UserMessage':
                    const userAnchor = `message-utilisateur-${userCounter}`;
                    parts.push(`- [MESSAGE UTILISATEUR #${userCounter}](#${userAnchor}) - ${firstLine}`);
                    userCounter++;
                    break;
                    
                case 'ToolResult':
                    const toolAnchor = `outil-${toolCounter}`;
                    parts.push(`- [RÉSULTAT OUTIL #${toolCounter}](#${toolAnchor}) - ${firstLine}`);
                    toolCounter++;
                    break;
                    
                case 'ToolCall':
                case 'Completion':
                    const assistantAnchor = `reponse-assistant-${assistantCounter}`;
                    const completionSuffix = item.subType === 'Completion' ? ' (Terminaison)' : '';
                    parts.push(`- [RÉPONSE ASSISTANT #${assistantCounter}](#${assistantAnchor})${completionSuffix} - ${firstLine}`);
                    assistantCounter++;
                    break;
            }
        }

        parts.push('', '</div>');
        return parts.join('\n');
    }

    /**
     * Extrait et tronque la première ligne d'un contenu
     */
    private getTruncatedFirstLine(content: string, maxLength: number = 100): string {
        if (!content) return '';
        
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine && !trimmedLine.startsWith('<')) {
                return trimmedLine.length > maxLength 
                    ? trimmedLine.substring(0, maxLength) + '...'
                    : trimmedLine;
            }
        }
        
        return '';
    }

    /**
     * Génère le footer du résumé
     */
    private generateFooter(options: SummaryOptions): string {
        return `---

**Résumé généré automatiquement par TraceSummaryService**  
**Date :** ${new Date().toLocaleString('fr-FR')}  
**Mode :** ${options.detailLevel}`;
    }

    /**
     * Fusionne les options avec les valeurs par défaut
     */
    private mergeWithDefaultOptions(options: Partial<SummaryOptions>): SummaryOptions {
        console.log('🔍 DEBUG mergeWithDefaultOptions - input options.jsonVariant:', options.jsonVariant);
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
            enableDetailLevels: options.enableDetailLevels || false
        };
        console.log('🔍 DEBUG mergeWithDefaultOptions - result.jsonVariant:', result.jsonVariant);
        console.log('🔍 DEBUG mergeWithDefaultOptions - result.enableDetailLevels:', result.enableDetailLevels);
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

    /**
     * Génère le contenu conversationnel complet selon le niveau de détail
     */
    private async renderConversationContent(
        classifiedContent: ClassifiedContent[],
        options: SummaryOptions
    ): Promise<string> {
        const parts: string[] = [];
        
        // Section d'introduction
        parts.push("## ÉCHANGES DE CONVERSATION");
        parts.push("");

        let userCounter = 1;
        let assistantCounter = 1;
        let toolCounter = 1;
        let isFirstUser = true;

        for (const item of classifiedContent) {
            switch (item.subType) {
                case 'UserMessage':
                    if (this.shouldIncludeMessageType('user', options.detailLevel)) {
                        const userSection = await this.renderUserMessage(
                            item,
                            userCounter,
                            isFirstUser,
                            options
                        );
                        parts.push(userSection);
                        userCounter++;
                        isFirstUser = false;
                    }
                    break;

                case 'ToolResult':
                    if (this.shouldIncludeMessageType('tool', options.detailLevel)) {
                        const toolSection = await this.renderToolResult(
                            item,
                            toolCounter,
                            options
                        );
                        parts.push(toolSection);
                        toolCounter++;
                    }
                    break;

                case 'ToolCall':
                case 'Completion':
                    if (this.shouldIncludeMessageType('assistant', options.detailLevel)) {
                        const assistantSection = await this.renderAssistantMessage(
                            item,
                            assistantCounter,
                            options
                        );
                        parts.push(assistantSection);
                        assistantCounter++;
                    }
                    break;
            }
        }

        return parts.join('\n\n');
    }

    /**
     * Rend une section message utilisateur
     */
    private async renderUserMessage(
        item: ClassifiedContent,
        counter: number,
        isFirst: boolean,
        options: SummaryOptions
    ): Promise<string> {
        const firstLine = this.getTruncatedFirstLine(item.content, 200);
        const parts: string[] = [];
        
        if (isFirst) {
            parts.push("### INSTRUCTION DE TÂCHE INITIALE");
            parts.push("");
            
            // Traitement spécial pour la première tâche (avec environment_details)
            const processedContent = this.processInitialTaskContent(item.content);
            parts.push(processedContent);
            
            parts.push("");
            parts.push("---");
        } else {
            const anchor = `message-utilisateur-${counter}`;
            parts.push(`### MESSAGE UTILISATEUR #${counter} - ${firstLine} {#${anchor}}`);
            parts.push("");
            
            parts.push('<div class="user-message">');
            const cleanedContent = this.cleanUserMessage(item.content);
            parts.push(cleanedContent);
            parts.push('</div>');
            parts.push("");
            parts.push(this.generateBackToTocLink());
        }
        
        return parts.join('\n');
    }

    /**
     * Rend une section résultat d'outil
     */
    private async renderToolResult(
        item: ClassifiedContent,
        counter: number,
        options: SummaryOptions
    ): Promise<string> {
        const parts: string[] = [];
        const toolName = item.toolType || 'outil';
        const firstLine = this.getTruncatedFirstLine(toolName, 200);
        const anchor = `outil-${counter}`;
        
        parts.push(`### RÉSULTAT OUTIL #${counter} - ${firstLine} {#${anchor}}`);
        parts.push("");
        
        parts.push('<div class="tool-message">');
        parts.push(`**Résultat d'outil :** \`${toolName}\``);
        
        if (this.shouldShowDetailedResults(options.detailLevel)) {
            const resultContent = this.extractToolResultContent(item.content);
            const resultType = item.resultType || 'résultat';
            
            parts.push("");
            parts.push("<details>");
            parts.push(`<summary>**${resultType} :** Cliquez pour afficher</summary>`);
            parts.push("");
            parts.push('```');
            parts.push(resultContent);
            parts.push('```');
            parts.push("</details>");
        } else {
            parts.push("");
            parts.push(`*Contenu des résultats masqué - utilisez -DetailLevel Full pour afficher*`);
        }
        
        parts.push('</div>');
        parts.push("");
        parts.push(this.generateBackToTocLink());
        
        return parts.join('\n');
    }

    /**
     * Rend une section réponse assistant
     */
    private async renderAssistantMessage(
        item: ClassifiedContent,
        counter: number,
        options: SummaryOptions
    ): Promise<string> {
        const parts: string[] = [];
        const firstLine = this.getTruncatedFirstLine(item.content, 200);
        const anchor = `reponse-assistant-${counter}`;
        const isCompletion = item.subType === 'Completion';
        
        const title = isCompletion
            ? `### RÉPONSE ASSISTANT #${counter} (Terminaison) - ${firstLine} {#${anchor}}`
            : `### RÉPONSE ASSISTANT #${counter} - ${firstLine} {#${anchor}}`;
        
        parts.push(title);
        parts.push("");
        
        const cssClass = isCompletion ? 'completion-message' : 'assistant-message';
        parts.push(`<div class="${cssClass}">`);
        
        // Extraction et traitement du contenu
        const processedContent = await this.processAssistantContent(item.content, options);
        parts.push(processedContent.textContent);
        
        // Ajout des blocs techniques selon le niveau de détail
        if (processedContent.technicalBlocks.length > 0) {
            const technicalSections = await this.renderTechnicalBlocks(
                processedContent.technicalBlocks,
                options
            );
            parts.push(technicalSections);
        }
        
        parts.push('</div>');
        parts.push("");
        parts.push(this.generateBackToTocLink());
        
        return parts.join('\n');
    }

    /**
     * Détermine quels types de messages inclure selon le mode
     */
    private shouldIncludeMessageType(
        messageType: 'user' | 'assistant' | 'tool',
        detailLevel: string
    ): boolean {
        switch (detailLevel) {
            case 'UserOnly':
                return messageType === 'user';
            case 'Messages':
                return ['user', 'assistant'].includes(messageType);
            default:
                return true;
        }
    }

    /**
     * Détermine si les résultats détaillés doivent être affichés
     */
    private shouldShowDetailedResults(detailLevel: string): boolean {
        return ['Full', 'NoTools'].includes(detailLevel);
    }

    /**
     * Traite le contenu de la tâche initiale avec Progressive Disclosure
     */
    private processInitialTaskContent(content: string): string {
        const parts: string[] = [];
        
        // Détecter et séparer environment_details
        const envDetailsMatch = content.match(/<environment_details>[\s\S]*?<\/environment_details>/);
        
        if (envDetailsMatch) {
            const beforeEnv = content.substring(0, envDetailsMatch.index!).trim();
            const afterEnv = content.substring(envDetailsMatch.index! + envDetailsMatch[0].length).trim();
            
            // Contenu principal
            if (beforeEnv) {
                parts.push('```markdown');
                parts.push(beforeEnv);
                parts.push('```');
                parts.push("");
            }
            
            // Environment details en Progressive Disclosure
            parts.push("<details>");
            parts.push("<summary>**Environment Details** - Cliquez pour afficher</summary>");
            parts.push("");
            parts.push('```');
            parts.push(envDetailsMatch[0]);
            parts.push('```');
            parts.push("</details>");
            
            // Contenu après environment_details
            if (afterEnv) {
                parts.push("");
                parts.push('```markdown');
                parts.push(afterEnv);
                parts.push('```');
            }
        } else {
            // Pas d'environment_details, affichage normal
            parts.push('```markdown');
            parts.push(content);
            parts.push('```');
        }
        
        return parts.join('\n');
    }

    /**
     * Nettoie le contenu des messages utilisateur
     */
    private cleanUserMessage(content: string): string {
        let cleaned = content;
        
        // Supprimer les environment_details très verbeux
        cleaned = cleaned.replace(
            /<environment_details>[\s\S]*?<\/environment_details>/g,
            '[Environment details supprimés pour lisibilité]'
        );
        
        // Supprimer les listes de fichiers très longues
        cleaned = cleaned.replace(
            /# Current Workspace Directory[\s\S]*?(?=# [A-Z]|\n\n|$)/g,
            '[Liste des fichiers workspace supprimée]'
        );
        
        // Garder les informations importantes mais raccourcir
        cleaned = cleaned.replace(
            /# VSCode Visible Files\n([^\n]*)\n\n# VSCode Open Tabs\n([^\n]*(?:\n[^\n#]*)*)/g,
            "**Fichiers actifs:** $1"
        );
        
        // Supprimer les métadonnées redondantes
        cleaned = cleaned.replace(/# Current (Cost|Time)[\s\S]*?\n/g, '');
        
        // Nettoyer les espaces multiples
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        cleaned = cleaned.trim();
        
        // Si le message devient trop court, extraire l'essentiel
        if (cleaned.length < 50 && content.length > 200) {
            const userMessageMatch = content.match(/<user_message>([\s\S]*?)<\/user_message>/);
            if (userMessageMatch) {
                cleaned = userMessageMatch[1].trim();
            }
        }
        
        return cleaned;
    }

    /**
     * Extrait le contenu des résultats d'outils
     */
    private extractToolResultContent(content: string): string {
        // Supprimer les métadonnées de début de ligne du type "[tool_name] Result:"
        let cleaned = content.replace(/^\[[^\]]+\] Result:\s*/i, '');
        
        // Si le contenu est trop long, le tronquer intelligemment
        if (cleaned.length > 2000) {
            const lines = cleaned.split('\n');
            if (lines.length > 50) {
                // Garder le début et la fin
                const startLines = lines.slice(0, 20);
                const endLines = lines.slice(-10);
                cleaned = [
                    ...startLines,
                    '',
                    `... [${lines.length - 30} lignes supprimées pour lisibilité] ...`,
                    '',
                    ...endLines
                ].join('\n');
            } else {
                // Juste tronquer à 2000 chars
                cleaned = cleaned.substring(0, 2000) + '\n\n... [Contenu tronqué] ...';
            }
        }
        
        return cleaned;
    }

    /**
     * Traite le contenu assistant et extrait les blocs techniques
     */
    private async processAssistantContent(
        content: string,
        options: SummaryOptions
    ): Promise<{textContent: string, technicalBlocks: TechnicalBlock[]}> {
        let textContent = content;
        const technicalBlocks: TechnicalBlock[] = [];
        
        // 1. Extraction des blocs <thinking>
        let thinkingMatch;
        while ((thinkingMatch = textContent.match(/<thinking>[\s\S]*?<\/thinking>/)) !== null) {
            technicalBlocks.push({
                type: 'thinking',
                content: thinkingMatch[0]
            });
            textContent = textContent.replace(thinkingMatch[0], '');
        }
        
        // 2. Extraction des outils XML (patterns simples d'abord)
        const commonTools = ['read_file', 'write_to_file', 'apply_diff', 'execute_command', 'codebase_search', 'search_files'];
        for (const toolName of commonTools) {
            const toolRegex = new RegExp(`<${toolName}>([\\s\\S]*?)<\\/${toolName}>`, 'g');
            let toolMatch;
            while ((toolMatch = toolRegex.exec(textContent)) !== null) {
                technicalBlocks.push({
                    type: 'tool',
                    content: toolMatch[0],
                    toolTag: toolName
                });
                textContent = textContent.replace(toolMatch[0], '');
            }
        }
        
        return {
            textContent: textContent.trim(),
            technicalBlocks
        };
    }

    /**
     * Rend les blocs techniques avec Progressive Disclosure
     */
    private async renderTechnicalBlocks(
        blocks: TechnicalBlock[],
        options: SummaryOptions
    ): Promise<string> {
        const parts: string[] = [];
        
        for (const block of blocks) {
            switch (block.type) {
                case 'thinking':
                    if (this.shouldShowThinking(options.detailLevel)) {
                        parts.push("");
                        parts.push("<details>");
                        parts.push("<summary>**RÉFLEXION** - Cliquez pour afficher</summary>");
                        parts.push("");
                        parts.push('```xml');
                        parts.push(block.content);
                        parts.push('```');
                        parts.push("</details>");
                    }
                    break;
                    
                case 'tool':
                    if (this.shouldShowTools(options.detailLevel)) {
                        const toolSection = await this.renderToolBlock(block, options);
                        parts.push(toolSection);
                    }
                    break;
            }
        }
        
        return parts.join('\n');
    }

    /**
     * Rend un bloc outil XML avec Progressive Disclosure
     */
    private async renderToolBlock(
        block: TechnicalBlock,
        options: SummaryOptions
    ): Promise<string> {
        const parts: string[] = [];
        
        parts.push("");
        parts.push("<details>");
        parts.push(`<summary>**OUTIL - ${block.toolTag}** - Cliquez pour afficher</summary>`);
        parts.push("");
        
        if (this.shouldShowToolDetails(options.detailLevel)) {
            // Modes avec détails : affichage XML brut
            parts.push('```xml');
            parts.push(block.content);
            parts.push('```');
        } else {
            // Modes sans détails : placeholder
            parts.push(`*Contenu des paramètres d'outil masqué - utilisez -DetailLevel Full pour afficher*`);
        }
        
        parts.push("</details>");
        
        return parts.join('\n');
    }

    /**
     * Détermine si les blocs thinking doivent être affichés
     */
    private shouldShowThinking(detailLevel: string): boolean {
        return ['Full', 'NoTools', 'NoResults'].includes(detailLevel);
    }

    /**
     * Détermine si les outils doivent être affichés
     */
    private shouldShowTools(detailLevel: string): boolean {
        return !['NoTools', 'Messages'].includes(detailLevel);
    }

    /**
     * Détermine si les détails des outils doivent être affichés
     */
    private shouldShowToolDetails(detailLevel: string): boolean {
        return ['Full', 'NoResults'].includes(detailLevel);
    }

    /**
     * Génère un lien de retour vers la table des matières
     */
    private generateBackToTocLink(): string {
        return '<div style="text-align: right; font-size: 0.9em; color: #666;">' +
               '<a href="#table-des-matieres">^ Table des matières</a></div>';
    }

    // ============================================================================
    // MÉTHODES POUR LES GRAPPES DE TÂCHES (CLUSTER SUMMARY)
    // ============================================================================

    /**
     * Génère un résumé complet pour une grappe de tâches
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
        try {
            // 1. Validation des entrées
            this.validateClusterInput(rootTask, childTasks);
            
            // 2. Configuration avec valeurs par défaut
            const finalOptions = this.mergeClusterOptions(options);
            
            // 3. Tri et organisation des tâches
            const organizedTasks = this.organizeClusterTasks(rootTask, childTasks, finalOptions);
            
            // 4. Classification du contenu agrégé
            const classifiedContent = this.classifyClusterContent(organizedTasks);
            
            // 5. Calcul des statistiques de grappe
            const clusterStats = this.calculateClusterStatistics(organizedTasks, classifiedContent);
            
            // 6. Génération du contenu selon le mode
            const content = await this.renderClusterSummary(
                organizedTasks,
                clusterStats,
                finalOptions
            );
            
            // 7. Construction du résultat
            return this.buildClusterResult(content, clusterStats, organizedTasks, finalOptions);
            
        } catch (error) {
            return {
                success: false,
                content: '',
                statistics: this.getEmptyClusterStatistics(),
                error: error instanceof Error ? error.message : 'Unknown error',
                clusterMetadata: {
                    rootTaskId: rootTask.taskId,
                    totalTasks: 0,
                    clusterMode: options.clusterMode || 'aggregated',
                    generationTimestamp: new Date().toISOString()
                },
                taskIndex: [],
                format: options.outputFormat || 'markdown',
                size: 0
            };
        }
    }

    /**
     * Valide les entrées pour la génération de résumé de grappe
     */
    private validateClusterInput(rootTask: ConversationSkeleton, childTasks: ConversationSkeleton[]): void {
        if (!rootTask || !rootTask.taskId) {
            throw new Error('Root task is required and must have a taskId');
        }
        
        if (!Array.isArray(childTasks)) {
            throw new Error('Child tasks must be an array');
        }
        
        // Vérification que toutes les tâches enfantes référencent bien la tâche racine
        for (const child of childTasks) {
            if (child.parentTaskId !== rootTask.taskId) {
                console.warn(`Child task ${child.taskId} does not reference root task ${rootTask.taskId}`);
            }
        }
    }

    /**
     * Fusionne les options avec les valeurs par défaut pour les grappes
     */
    private mergeClusterOptions(options: Partial<ClusterSummaryOptions>): ClusterSummaryOptions {
        return {
            // Options héritées des résumés standards
            detailLevel: options.detailLevel || 'Full',
            truncationChars: options.truncationChars || 0,
            compactStats: options.compactStats || false,
            includeCss: options.includeCss !== false,
            generateToc: options.generateToc !== false,
            outputFormat: options.outputFormat || 'markdown',
            
            // Options spécifiques aux grappes
            clusterMode: options.clusterMode || 'aggregated',
            includeClusterStats: options.includeClusterStats !== false,
            crossTaskAnalysis: options.crossTaskAnalysis || false,
            maxClusterDepth: options.maxClusterDepth || 10,
            clusterSortBy: options.clusterSortBy || 'chronological',
            includeClusterTimeline: options.includeClusterTimeline || false,
            clusterTruncationChars: options.clusterTruncationChars || 0,
            showTaskRelationships: options.showTaskRelationships !== false
        };
    }

    /**
     * Organise et trie les tâches de la grappe selon les options
     */
    private organizeClusterTasks(
        rootTask: ConversationSkeleton,
        childTasks: ConversationSkeleton[],
        options: ClusterSummaryOptions
    ): OrganizedClusterTasks {
        
        const allTasks = [rootTask, ...childTasks];
        
        // Tri selon la stratégie choisie
        let sortedTasks: ConversationSkeleton[];
        switch (options.clusterSortBy) {
            case 'chronological':
                sortedTasks = this.sortTasksByChronology(allTasks);
                break;
            case 'size':
                sortedTasks = this.sortTasksBySize(allTasks);
                break;
            case 'activity':
                sortedTasks = this.sortTasksByActivity(allTasks);
                break;
            case 'alphabetical':
                sortedTasks = this.sortTasksAlphabetically(allTasks);
                break;
            default:
                sortedTasks = this.sortTasksByChronology(allTasks);
        }
        
        // Construction de la hiérarchie
        const taskHierarchy = new Map<string, ConversationSkeleton[]>();
        taskHierarchy.set(rootTask.taskId, childTasks);
        
        return {
            rootTask,
            allTasks,
            sortedTasks,
            taskHierarchy,
            taskOrder: sortedTasks.map(task => task.taskId)
        };
    }

    /**
     * Tri chronologique des tâches (par date de création)
     */
    private sortTasksByChronology(tasks: ConversationSkeleton[]): ConversationSkeleton[] {
        return [...tasks].sort((a, b) =>
            new Date(a.metadata.createdAt).getTime() - new Date(b.metadata.createdAt).getTime()
        );
    }

    /**
     * Tri par taille de contenu
     */
    private sortTasksBySize(tasks: ConversationSkeleton[]): ConversationSkeleton[] {
        return [...tasks].sort((a, b) => b.metadata.totalSize - a.metadata.totalSize);
    }

    /**
     * Tri par activité récente
     */
    private sortTasksByActivity(tasks: ConversationSkeleton[]): ConversationSkeleton[] {
        return [...tasks].sort((a, b) =>
            new Date(b.metadata.lastActivity).getTime() - new Date(a.metadata.lastActivity).getTime()
        );
    }

    /**
     * Tri alphabétique par titre
     */
    private sortTasksAlphabetically(tasks: ConversationSkeleton[]): ConversationSkeleton[] {
        return [...tasks].sort((a, b) => {
            const titleA = a.metadata.title || a.taskId;
            const titleB = b.metadata.title || b.taskId;
            return titleA.localeCompare(titleB);
        });
    }

    /**
     * Classifie le contenu agrégé de toutes les tâches de la grappe
     */
    private classifyClusterContent(organizedTasks: OrganizedClusterTasks): ClassifiedClusterContent {
        const allClassifiedContent: ClassifiedContent[] = [];
        const perTaskContent = new Map<string, ClassifiedContent[]>();
        
        // Classification par tâche individuelle
        for (const task of organizedTasks.allTasks) {
            const taskContent = this.classifyConversationContent(task);
            perTaskContent.set(task.taskId, taskContent);
            allClassifiedContent.push(...taskContent);
        }
        
        // Identification des patterns cross-task
        const crossTaskPatterns = this.identifyCrossTaskPatterns(perTaskContent);
        
        return {
            aggregatedContent: allClassifiedContent,
            perTaskContent,
            crossTaskPatterns
        };
    }

    /**
     * Identifie les patterns communs à travers les tâches
     */
    private identifyCrossTaskPatterns(perTaskContent: Map<string, ClassifiedContent[]>): CrossTaskPattern[] {
        const patterns: CrossTaskPattern[] = [];
        const toolUsage = new Map<string, string[]>();
        const modeUsage = new Map<string, string[]>();
        
        // Analyse des outils utilisés par tâche
        for (const [taskId, content] of perTaskContent) {
            const usedTools = new Set<string>();
            
            for (const item of content) {
                if (item.toolType) {
                    usedTools.add(item.toolType);
                }
            }
            
            for (const tool of usedTools) {
                if (!toolUsage.has(tool)) {
                    toolUsage.set(tool, []);
                }
                toolUsage.get(tool)!.push(taskId);
            }
        }
        
        // Création des patterns pour les outils fréquents
        for (const [tool, taskIds] of toolUsage) {
            if (taskIds.length > 1) {
                patterns.push({
                    pattern: tool,
                    frequency: taskIds.length,
                    taskIds,
                    category: 'tool'
                });
            }
        }
        
        return patterns.sort((a, b) => b.frequency - a.frequency);
    }

    /**
     * Calcule les statistiques complètes de la grappe
     */
    private calculateClusterStatistics(
        organizedTasks: OrganizedClusterTasks,
        classifiedContent: ClassifiedClusterContent
    ): ClusterSummaryStatistics {
        
        // Statistiques de base (réutilise la logique existante)
        const baseStats = this.calculateStatistics(classifiedContent.aggregatedContent);
        
        // Métriques spécifiques aux grappes
        const totalTasks = organizedTasks.allTasks.length;
        const clusterDepth = this.calculateClusterDepth(organizedTasks);
        const averageTaskSize = organizedTasks.allTasks.reduce((sum, task) =>
            sum + task.metadata.totalSize, 0) / totalTasks;
        
        // Distribution des tâches
        const taskDistribution = this.calculateTaskDistribution(organizedTasks.allTasks);
        
        // Analyse temporelle
        const clusterTimeSpan = this.calculateClusterTimeSpan(organizedTasks.allTasks);
        
        // Métriques de contenu agrégées
        const clusterContentStats = this.aggregateContentStats(organizedTasks.allTasks);
        
        // Patterns communs
        const commonPatterns = this.analyzeCommonPatterns(classifiedContent);
        
        return {
            // Statistiques héritées
            ...baseStats,
            
            // Métriques spécifiques aux grappes
            totalTasks,
            clusterDepth,
            averageTaskSize,
            taskDistribution,
            clusterTimeSpan,
            clusterContentStats,
            commonPatterns
        };
    }

    /**
     * Calcule la profondeur de la grappe (niveau hiérarchique)
     */
    private calculateClusterDepth(organizedTasks: OrganizedClusterTasks): number {
        // Pour l'instant, nous gérons seulement 1 niveau (parent + enfants)
        return organizedTasks.allTasks.length > 1 ? 2 : 1;
    }

    /**
     * Calcule la distribution des tâches par différents critères
     */
    private calculateTaskDistribution(tasks: ConversationSkeleton[]) {
        const byMode: Record<string, number> = {};
        const bySize = { small: 0, medium: 0, large: 0 };
        const byActivity: Record<string, number> = {};
        
        for (const task of tasks) {
            // Distribution par mode
            const mode = task.metadata.mode || 'unknown';
            byMode[mode] = (byMode[mode] || 0) + 1;
            
            // Distribution par taille
            const size = task.metadata.totalSize;
            if (size < 10000) bySize.small++;
            else if (size < 100000) bySize.medium++;
            else bySize.large++;
            
            // Distribution par date d'activité (par jour)
            const activityDate = new Date(task.metadata.lastActivity).toDateString();
            byActivity[activityDate] = (byActivity[activityDate] || 0) + 1;
        }
        
        return { byMode, bySize, byActivity };
    }

    /**
     * Calcule le span temporel de la grappe
     */
    private calculateClusterTimeSpan(tasks: ConversationSkeleton[]) {
        const dates = tasks.map(task => new Date(task.metadata.createdAt));
        const startTime = new Date(Math.min(...dates.map(d => d.getTime())));
        const endTime = new Date(Math.max(...dates.map(d => d.getTime())));
        const totalDurationHours = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);
        
        return {
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            totalDurationHours
        };
    }

    /**
     * Agrège les statistiques de contenu de toutes les tâches
     */
    private aggregateContentStats(tasks: ConversationSkeleton[]) {
        let totalUserMessages = 0;
        let totalAssistantMessages = 0;
        let totalToolResults = 0;
        let totalContentSize = 0;
        
        for (const task of tasks) {
            const messages = task.sequence.filter((item): item is MessageSkeleton =>
                'role' in item);
                
            for (const message of messages) {
                if (message.role === 'user') {
                    if (this.isToolResult(message.content)) {
                        totalToolResults++;
                    } else {
                        totalUserMessages++;
                    }
                } else if (message.role === 'assistant') {
                    totalAssistantMessages++;
                }
                totalContentSize += message.content.length;
            }
        }
        
        const averageMessagesPerTask = tasks.length > 0 ?
            (totalUserMessages + totalAssistantMessages + totalToolResults) / tasks.length : 0;
        
        return {
            totalUserMessages,
            totalAssistantMessages,
            totalToolResults,
            totalContentSize,
            averageMessagesPerTask
        };
    }

    /**
     * Analyse les patterns communs dans le contenu classifié
     */
    private analyzeCommonPatterns(classifiedContent: ClassifiedClusterContent) {
        const frequentTools: Record<string, number> = {};
        const commonModes: Record<string, number> = {};
        const crossTaskTopics: string[] = [];
        
        // Analyse des outils fréquents
        for (const pattern of classifiedContent.crossTaskPatterns) {
            if (pattern.category === 'tool') {
                frequentTools[pattern.pattern] = pattern.frequency;
            } else if (pattern.category === 'mode') {
                commonModes[pattern.pattern] = pattern.frequency;
            }
        }
        
        // Les topics cross-task peuvent être extraits des patterns
        crossTaskTopics.push(...classifiedContent.crossTaskPatterns
            .filter(p => p.category === 'topic')
            .map(p => p.pattern));
        
        return {
            frequentTools,
            commonModes,
            crossTaskTopics
        };
    }

    /**
     * Génère les statistiques vides pour les cas d'erreur
     */
    private getEmptyClusterStatistics(): ClusterSummaryStatistics {
        const emptyStats = this.getEmptyStatistics();
        return {
            ...emptyStats,
            totalTasks: 0,
            clusterDepth: 0,
            averageTaskSize: 0,
            taskDistribution: {
                byMode: {},
                bySize: { small: 0, medium: 0, large: 0 },
                byActivity: {}
            },
            clusterTimeSpan: {
                startTime: new Date().toISOString(),
                endTime: new Date().toISOString(),
                totalDurationHours: 0
            },
            clusterContentStats: {
                totalUserMessages: 0,
                totalAssistantMessages: 0,
                totalToolResults: 0,
                totalContentSize: 0,
                averageMessagesPerTask: 0
            }
        };
    }

    /**
     * Pipeline de rendu complet du résumé de grappe selon le mode choisi
     */
    private async renderClusterSummary(
        organizedTasks: OrganizedClusterTasks,
        statistics: ClusterSummaryStatistics,
        options: ClusterSummaryOptions
    ): Promise<string> {
        
        const parts: string[] = [];
        
        // En-tête de grappe
        parts.push(this.renderClusterHeader(organizedTasks.rootTask, statistics, options));
        
        // Métadonnées de grappe
        parts.push(this.renderClusterMetadata(organizedTasks, statistics, options));
        
        // Statistiques de grappe
        if (options.includeClusterStats) {
            parts.push(this.renderClusterStatistics(statistics, options));
        }
        
        // Table des matières
        if (options.generateToc) {
            parts.push(this.renderClusterTableOfContents(organizedTasks, options));
        }
        
        // Timeline unifiée
        if (options.includeClusterTimeline) {
            parts.push(this.renderClusterTimeline(organizedTasks, statistics));
        }
        
        // Contenu selon le mode
        switch (options.clusterMode) {
            case 'aggregated':
                parts.push(await this.renderAggregatedContent(organizedTasks, statistics, options));
                break;
            case 'detailed':
                parts.push(await this.renderDetailedContent(organizedTasks, statistics, options));
                break;
            case 'comparative':
                parts.push(await this.renderComparativeContent(organizedTasks, statistics, options));
                break;
            default:
                parts.push(await this.renderAggregatedContent(organizedTasks, statistics, options));
        }
        
        // Analyse cross-task
        if (options.crossTaskAnalysis) {
            parts.push(this.renderCrossTaskAnalysis(organizedTasks, statistics));
        }
        
        return parts.join('\n\n');
    }

    /**
     * Rendu de l'en-tête de grappe avec métadonnées principales
     */
    private renderClusterHeader(
        rootTask: ConversationSkeleton,
        statistics: ClusterSummaryStatistics,
        options: ClusterSummaryOptions
    ): string {
        
        const title = rootTask.metadata.title || 'Grappe de Tâches Sans Titre';
        const taskCount = statistics.totalTasks;
        const timeSpan = this.formatDuration(statistics.clusterTimeSpan.totalDurationHours);
        
        if (options.outputFormat === 'html') {
            return `<h1>🔗 ${title}</h1>
<div class="cluster-summary-header">
    <p><strong>Type:</strong> Résumé de Grappe de Tâches</p>
    <p><strong>Nombre de tâches:</strong> ${taskCount}</p>
    <p><strong>Durée totale:</strong> ${timeSpan}</p>
    <p><strong>Mode de rendu:</strong> ${options.clusterMode}</p>
</div>`;
        } else {
            return `# 🔗 ${title}

**Type:** Résumé de Grappe de Tâches
**Nombre de tâches:** ${taskCount}
**Durée totale:** ${timeSpan}
**Mode de rendu:** ${options.clusterMode}
**Généré le:** ${new Date().toLocaleString('fr-FR')}`;
        }
    }

    /**
     * Formate une durée en heures vers un format lisible
     */
    private formatDuration(hours: number): string {
        if (hours < 1) {
            return `${Math.round(hours * 60)} minutes`;
        } else if (hours < 24) {
            return `${Math.round(hours * 10) / 10} heures`;
        } else {
            const days = Math.floor(hours / 24);
            const remainingHours = Math.round((hours % 24) * 10) / 10;
            return `${days}j ${remainingHours}h`;
        }
    }

    /**
     * Rendu des métadonnées de grappe (informations générales)
     */
    private renderClusterMetadata(
        organizedTasks: OrganizedClusterTasks,
        statistics: ClusterSummaryStatistics,
        options: ClusterSummaryOptions
    ): string {
        const metadata = statistics.clusterContentStats;
        const timeSpan = statistics.clusterTimeSpan;
        
        if (options.outputFormat === 'html') {
            return `<div class="cluster-metadata">
<h2>📊 Métadonnées de la Grappe</h2>
<div class="metadata-grid">
    <div class="metadata-item">
        <strong>Tâche racine :</strong> ${organizedTasks.rootTask.metadata.title || organizedTasks.rootTask.taskId}
    </div>
    <div class="metadata-item">
        <strong>Nombre de tâches enfantes :</strong> ${organizedTasks.allTasks.length - 1}
    </div>
    <div class="metadata-item">
        <strong>Profondeur de grappe :</strong> ${statistics.clusterDepth} niveau${statistics.clusterDepth > 1 ? 'x' : ''}
    </div>
    <div class="metadata-item">
        <strong>Période d'activité :</strong> ${new Date(timeSpan.startTime).toLocaleDateString('fr-FR')} - ${new Date(timeSpan.endTime).toLocaleDateString('fr-FR')}
    </div>
    <div class="metadata-item">
        <strong>Durée totale :</strong> ${this.formatDuration(timeSpan.totalDurationHours)}
    </div>
    <div class="metadata-item">
        <strong>Taille moyenne par tâche :</strong> ${this.formatBytes(statistics.averageTaskSize)}
    </div>
    <div class="metadata-item">
        <strong>Messages totaux :</strong> ${metadata.totalUserMessages + metadata.totalAssistantMessages}
    </div>
    <div class="metadata-item">
        <strong>Résultats d'outils :</strong> ${metadata.totalToolResults}
    </div>
</div>
</div>`;
        } else {
            return `## 📊 Métadonnées de la Grappe

| **Propriété** | **Valeur** |
|---------------|------------|
| **Tâche racine** | ${organizedTasks.rootTask.metadata.title || organizedTasks.rootTask.taskId} |
| **Nombre de tâches enfantes** | ${organizedTasks.allTasks.length - 1} |
| **Profondeur de grappe** | ${statistics.clusterDepth} niveau${statistics.clusterDepth > 1 ? 'x' : ''} |
| **Période d'activité** | ${new Date(timeSpan.startTime).toLocaleDateString('fr-FR')} - ${new Date(timeSpan.endTime).toLocaleDateString('fr-FR')} |
| **Durée totale** | ${this.formatDuration(timeSpan.totalDurationHours)} |
| **Taille moyenne par tâche** | ${this.formatBytes(statistics.averageTaskSize)} |
| **Messages totaux** | ${metadata.totalUserMessages + metadata.totalAssistantMessages} |
| **Résultats d'outils** | ${metadata.totalToolResults} |`;
        }
    }

    /**
     * Formate les bytes en format lisible
     */
    private formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024 * 10) / 10} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024) * 10) / 10} MB`;
        return `${Math.round(bytes / (1024 * 1024 * 1024) * 10) / 10} GB`;
    }

    /**
     * Rendu des statistiques détaillées de grappe
     */
    private renderClusterStatistics(statistics: ClusterSummaryStatistics, options: ClusterSummaryOptions): string {
        const dist = statistics.taskDistribution;
        const patterns = statistics.commonPatterns;
        
        if (options.compactStats) {
            return this.renderCompactClusterStats(statistics);
        }
        
        if (options.outputFormat === 'html') {
            return `<div class="cluster-statistics">
<h2>📈 Statistiques de la Grappe</h2>

<h3>Distribution des Tâches</h3>
<div class="stats-section">
    <h4>Par Mode :</h4>
    <ul>${Object.entries(dist.byMode).map(([mode, count]) =>
        `<li><strong>${mode}</strong>: ${count} tâche${count > 1 ? 's' : ''}</li>`).join('')}</ul>
    
    <h4>Par Taille :</h4>
    <ul>
        <li><strong>Petites</strong> (&lt;10KB): ${dist.bySize.small} tâche${dist.bySize.small > 1 ? 's' : ''}</li>
        <li><strong>Moyennes</strong> (10-100KB): ${dist.bySize.medium} tâche${dist.bySize.medium > 1 ? 's' : ''}</li>
        <li><strong>Grandes</strong> (&gt;100KB): ${dist.bySize.large} tâche${dist.bySize.large > 1 ? 's' : ''}</li>
    </ul>
</div>

${patterns ? `<h3>Outils Fréquents</h3>
<div class="tools-section">
    <ul>${Object.entries(patterns.frequentTools).map(([tool, count]) =>
        `<li><strong>${tool}</strong>: utilisé dans ${count} tâche${count > 1 ? 's' : ''}</li>`).join('')}</ul>
</div>` : ''}

<h3>Métriques de Contenu</h3>
<div class="content-metrics">
    <p><strong>Messages utilisateur :</strong> ${statistics.clusterContentStats.totalUserMessages}</p>
    <p><strong>Messages assistant :</strong> ${statistics.clusterContentStats.totalAssistantMessages}</p>
    <p><strong>Résultats d'outils :</strong> ${statistics.clusterContentStats.totalToolResults}</p>
    <p><strong>Moyenne messages/tâche :</strong> ${Math.round(statistics.clusterContentStats.averageMessagesPerTask * 10) / 10}</p>
</div>
</div>`;
        } else {
            return `## 📈 Statistiques de la Grappe

### Distribution des Tâches

**Par Mode :**
${Object.entries(dist.byMode).map(([mode, count]) =>
    `- **${mode}** : ${count} tâche${count > 1 ? 's' : ''}`).join('\n')}

**Par Taille :**
- **Petites** (<10KB) : ${dist.bySize.small} tâche${dist.bySize.small > 1 ? 's' : ''}
- **Moyennes** (10-100KB) : ${dist.bySize.medium} tâche${dist.bySize.medium > 1 ? 's' : ''}
- **Grandes** (>100KB) : ${dist.bySize.large} tâche${dist.bySize.large > 1 ? 's' : ''}

${patterns && Object.keys(patterns.frequentTools).length > 0 ? `### Outils Fréquents

${Object.entries(patterns.frequentTools).map(([tool, count]) =>
    `- **${tool}** : utilisé dans ${count} tâche${count > 1 ? 's' : ''}`).join('\n')}
` : ''}

### Métriques de Contenu

- **Messages utilisateur :** ${statistics.clusterContentStats.totalUserMessages}
- **Messages assistant :** ${statistics.clusterContentStats.totalAssistantMessages}
- **Résultats d'outils :** ${statistics.clusterContentStats.totalToolResults}
- **Moyenne messages/tâche :** ${Math.round(statistics.clusterContentStats.averageMessagesPerTask * 10) / 10}`;
        }
    }

    /**
     * Rendu compact des statistiques (version courte)
     */
    private renderCompactClusterStats(statistics: ClusterSummaryStatistics): string {
        const content = statistics.clusterContentStats;
        return `**Statistiques :** ${statistics.totalTasks} tâches, ${content.totalUserMessages + content.totalAssistantMessages} messages, ${content.totalToolResults} outils, ${this.formatDuration(statistics.clusterTimeSpan.totalDurationHours)}`;
    }

    /**
     * Génère la table des matières pour une grappe
     */
    private renderClusterTableOfContents(organizedTasks: OrganizedClusterTasks, options: ClusterSummaryOptions): string {
        if (options.outputFormat === 'html') {
            return `<div class="cluster-toc" id="table-des-matieres">
<h2>📑 Table des Matières</h2>
<nav class="toc-nav">
    <ol>
        <li><a href="#tache-racine-${this.sanitizeId(organizedTasks.rootTask.taskId)}">
            🎯 ${organizedTasks.rootTask.metadata.title || 'Tâche Racine'}
        </a></li>
        ${organizedTasks.sortedTasks.slice(1).map((task, index) =>
            `<li><a href="#tache-${this.sanitizeId(task.taskId)}">
                📝 ${task.metadata.title || `Tâche ${index + 1}`}
            </a></li>`
        ).join('')}
    </ol>
</nav>
</div>`;
        } else {
            return `## 📑 Table des Matières

1. [🎯 ${organizedTasks.rootTask.metadata.title || 'Tâche Racine'}](#tache-racine-${this.sanitizeId(organizedTasks.rootTask.taskId)})
${organizedTasks.sortedTasks.slice(1).map((task, index) =>
    `${index + 2}. [📝 ${task.metadata.title || `Tâche ${index + 1}`}](#tache-${this.sanitizeId(task.taskId)})`
).join('\n')}`;
        }
    }

    /**
     * Sanitise un ID pour les ancres HTML/Markdown
     */
    private sanitizeId(id: string): string {
        return id.toLowerCase()
            .replace(/[^a-z0-9-_]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
    }

    /**
     * Génère une timeline chronologique de la grappe
     */
    private renderClusterTimeline(organizedTasks: OrganizedClusterTasks, statistics: ClusterSummaryStatistics): string {
        const sortedByDate = [...organizedTasks.allTasks].sort((a, b) =>
            new Date(a.metadata.createdAt).getTime() - new Date(b.metadata.createdAt).getTime()
        );
        
        return `## ⏰ Timeline de la Grappe

${sortedByDate.map(task => {
            const date = new Date(task.metadata.createdAt);
            const icon = task === organizedTasks.rootTask ? '🎯' : '📝';
            const size = this.formatBytes(task.metadata.totalSize);
            
            return `**${date.toLocaleDateString('fr-FR')} ${date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}** - ${icon} ${task.metadata.title || task.taskId} (${size})`;
        }).join('\n')}`;
    }

    /**
     * Rendu du contenu en mode agrégé (fusion de tous les contenus)
     */
    private async renderAggregatedContent(
        organizedTasks: OrganizedClusterTasks,
        statistics: ClusterSummaryStatistics,
        options: ClusterSummaryOptions
    ): Promise<string> {
        const parts: string[] = [];
        
        // En-tête du contenu agrégé
        parts.push(`## 🔗 Contenu Agrégé de la Grappe`);
        
        // Résumé global
        const globalSummary = await this.generateGlobalClusterSummary(organizedTasks, options);
        parts.push(`### Résumé Global\n${globalSummary}`);
        
        // Contenu par tâche avec sections condensées
        parts.push(`### Contenu des Tâches`);
        
        for (const task of organizedTasks.sortedTasks) {
            const taskSummary = await this.generateSummary(task, {
                detailLevel: 'Summary',
                truncationChars: options.clusterTruncationChars || 1000,
                compactStats: true,
                includeCss: false,
                generateToc: false,
                outputFormat: options.outputFormat
            });
            
            const icon = task === organizedTasks.rootTask ? '🎯' : '📝';
            const taskId = this.sanitizeId(task.taskId);
            const title = task.metadata.title || task.taskId;
            
            parts.push(`#### ${icon} ${title} {#tache${task === organizedTasks.rootTask ? '-racine' : ''}-${taskId}}`);
            parts.push(taskSummary.content);
            
            if (options.showTaskRelationships && task !== organizedTasks.rootTask) {
                parts.push(`*Tâche enfante de : ${organizedTasks.rootTask.metadata.title || organizedTasks.rootTask.taskId}*`);
            }
            
            parts.push('---'); // Séparateur
        }
        
        return parts.join('\n\n');
    }

    /**
     * Génère un résumé global de toute la grappe
     */
    private async generateGlobalClusterSummary(
        organizedTasks: OrganizedClusterTasks,
        options: ClusterSummaryOptions
    ): Promise<string> {
        // Agrège les interactions principales de toutes les tâches
        const allInteractions: string[] = [];
        const toolsUsed = new Set<string>();
        const modesUsed = new Set<string>();
        
        // Calcul de la durée totale
        const allDates = organizedTasks.allTasks.map(task => new Date(task.metadata.createdAt));
        const startTime = new Date(Math.min(...allDates.map(d => d.getTime())));
        const endTime = new Date(Math.max(...allDates.map(d => d.getTime())));
        const totalDurationHours = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);
        
        for (const task of organizedTasks.allTasks) {
            // Extrait le contexte principal de chaque tâche
            const messages = task.sequence.filter((item): item is MessageSkeleton => 'role' in item);
            
            // Première et dernière interaction utilisateur pour le contexte
            const userMessages = messages.filter(m => m.role === 'user' && !this.isToolResult(m.content));
            
            if (userMessages.length > 0) {
                const firstMessage = userMessages[0].content.substring(0, 200);
                allInteractions.push(`**${task.metadata.title || task.taskId}**: ${firstMessage}...`);
            }
            
            // Collecte des outils et modes
            if (task.metadata.mode) modesUsed.add(task.metadata.mode);
            
            // Extraction des outils depuis les messages d'outils
            const toolMessages = messages.filter(m => m.role === 'user' && this.isToolResult(m.content));
            for (const toolMsg of toolMessages) {
                const toolMatch = toolMsg.content.match(/\[(\w+) for/);
                if (toolMatch) toolsUsed.add(toolMatch[1]);
            }
        }
        
        const summary = `Cette grappe de ${organizedTasks.allTasks.length} tâches${organizedTasks.allTasks.length > 1 ? ` organisée autour de "${organizedTasks.rootTask.metadata.title || 'la tâche racine'}"` : ''} couvre une période de ${this.formatDuration(totalDurationHours)}.

**Modes utilisés :** ${Array.from(modesUsed).join(', ') || 'Non spécifié'}
**Outils principaux :** ${Array.from(toolsUsed).slice(0, 5).join(', ') || 'Aucun outil détecté'}${Array.from(toolsUsed).length > 5 ? ' et autres...' : ''}

**Interactions principales :**
${allInteractions.slice(0, 3).join('\n')}${allInteractions.length > 3 ? '\n*...et autres interactions*' : ''}`;
        
        return summary;
    }

    /**
     * Rendu du contenu en mode détaillé (chaque tâche complète)
     */
    private async renderDetailedContent(
        organizedTasks: OrganizedClusterTasks,
        statistics: ClusterSummaryStatistics,
        options: ClusterSummaryOptions
    ): Promise<string> {
        const parts: string[] = [];
        
        parts.push(`## 📋 Contenu Détaillé de la Grappe`);
        
        for (const task of organizedTasks.sortedTasks) {
            const taskSummary = await this.generateSummary(task, {
                detailLevel: options.detailLevel,
                truncationChars: options.truncationChars,
                compactStats: false,
                includeCss: false,
                generateToc: false,
                outputFormat: options.outputFormat
            });
            
            const icon = task === organizedTasks.rootTask ? '🎯' : '📝';
            const taskId = this.sanitizeId(task.taskId);
            const title = task.metadata.title || task.taskId;
            
            parts.push(`### ${icon} ${title} {#tache${task === organizedTasks.rootTask ? '-racine' : ''}-${taskId}}`);
            
            // Métadonnées de la tâche individuelle
            parts.push(`**ID :** \`${task.taskId}\`
**Mode :** ${task.metadata.mode || 'Non spécifié'}
**Créé le :** ${new Date(task.metadata.createdAt).toLocaleString('fr-FR')}
**Taille :** ${this.formatBytes(task.metadata.totalSize)}
${task !== organizedTasks.rootTask ? `**Parent :** ${organizedTasks.rootTask.metadata.title || organizedTasks.rootTask.taskId}` : '**Type :** Tâche racine de la grappe'}`);
            
            parts.push(taskSummary.content);
            
            parts.push('---'); // Séparateur entre tâches
        }
        
        return parts.join('\n\n');
    }

    /**
     * Rendu du contenu en mode comparatif (analyse côte à côte)
     */
    private async renderComparativeContent(
        organizedTasks: OrganizedClusterTasks,
        statistics: ClusterSummaryStatistics,
        options: ClusterSummaryOptions
    ): Promise<string> {
        const parts: string[] = [];
        
        parts.push(`## ⚖️ Analyse Comparative de la Grappe`);
        
        // Tableau comparatif des métadonnées
        parts.push(`### Comparaison des Tâches`);
        
        if (options.outputFormat === 'html') {
            parts.push(`<table class="comparative-table">
<thead>
    <tr>
        <th>Tâche</th>
        <th>Mode</th>
        <th>Taille</th>
        <th>Messages</th>
        <th>Date</th>
    </tr>
</thead>
<tbody>
    ${organizedTasks.sortedTasks.map(task => {
                const messageCount = task.sequence.filter(item => 'role' in item).length;
                const icon = task === organizedTasks.rootTask ? '🎯' : '📝';
                return `<tr>
        <td>${icon} ${task.metadata.title || task.taskId}</td>
        <td>${task.metadata.mode || 'N/A'}</td>
        <td>${this.formatBytes(task.metadata.totalSize)}</td>
        <td>${messageCount}</td>
        <td>${new Date(task.metadata.createdAt).toLocaleDateString('fr-FR')}</td>
    </tr>`;
            }).join('')}
</tbody>
</table>`);
        } else {
            parts.push(`| Tâche | Mode | Taille | Messages | Date |
|-------|------|--------|----------|------|
${organizedTasks.sortedTasks.map(task => {
                const messageCount = task.sequence.filter(item => 'role' in item).length;
                const icon = task === organizedTasks.rootTask ? '🎯' : '📝';
                return `| ${icon} ${task.metadata.title || task.taskId} | ${task.metadata.mode || 'N/A'} | ${this.formatBytes(task.metadata.totalSize)} | ${messageCount} | ${new Date(task.metadata.createdAt).toLocaleDateString('fr-FR')} |`;
            }).join('\n')}`);
        }
        
        // Comparaison des patterns de contenu
        parts.push(`### Patterns de Contenu`);
        
        const contentAnalysis = await this.generateComparativeAnalysis(organizedTasks);
        parts.push(contentAnalysis);
        
        return parts.join('\n\n');
    }

    /**
     * Génère une analyse comparative des patterns de contenu
     */
    private async generateComparativeAnalysis(organizedTasks: OrganizedClusterTasks): Promise<string> {
        const analysis: string[] = [];
        
        // Analyse des similitudes et différences
        const toolUsageByTask = new Map<string, Set<string>>();
        const contentTypesByTask = new Map<string, { user: number; assistant: number; tools: number }>();
        
        for (const task of organizedTasks.allTasks) {
            const tools = new Set<string>();
            const contentTypes = { user: 0, assistant: 0, tools: 0 };
            
            const messages = task.sequence.filter((item): item is MessageSkeleton => 'role' in item);
            
            for (const message of messages) {
                if (message.role === 'user') {
                    if (this.isToolResult(message.content)) {
                        contentTypes.tools++;
                        // Extraction du nom de l'outil
                        const toolMatch = message.content.match(/\[(\w+) for/);
                        if (toolMatch) tools.add(toolMatch[1]);
                    } else {
                        contentTypes.user++;
                    }
                } else if (message.role === 'assistant') {
                    contentTypes.assistant++;
                }
            }
            
            toolUsageByTask.set(task.taskId, tools);
            contentTypesByTask.set(task.taskId, contentTypes);
        }
        
        // Outils communs
        const allTools = new Set<string>();
        toolUsageByTask.forEach(tools => tools.forEach(tool => allTools.add(tool)));
        
        const commonTools: string[] = [];
        for (const tool of allTools) {
            const usageCount = Array.from(toolUsageByTask.values()).filter(taskTools => taskTools.has(tool)).length;
            if (usageCount > 1) {
                commonTools.push(`**${tool}** (${usageCount}/${organizedTasks.allTasks.length} tâches)`);
            }
        }
        
        if (commonTools.length > 0) {
            analysis.push(`**Outils communs :**\n${commonTools.join(', ')}`);
        }
        
        // Distribution des types de contenu
        const avgContentTypes = Array.from(contentTypesByTask.values()).reduce(
            (acc, types) => ({
                user: acc.user + types.user,
                assistant: acc.assistant + types.assistant,
                tools: acc.tools + types.tools
            }),
            { user: 0, assistant: 0, tools: 0 }
        );
        
        const taskCount = organizedTasks.allTasks.length;
        analysis.push(`**Moyenne par tâche :**
- Messages utilisateur : ${Math.round(avgContentTypes.user / taskCount * 10) / 10}
- Messages assistant : ${Math.round(avgContentTypes.assistant / taskCount * 10) / 10}
- Résultats d'outils : ${Math.round(avgContentTypes.tools / taskCount * 10) / 10}`);
        
        return analysis.join('\n\n');
    }

    /**
     * Rendu de l'analyse cross-task (patterns inter-tâches)
     */
    private renderCrossTaskAnalysis(organizedTasks: OrganizedClusterTasks, statistics: ClusterSummaryStatistics): string {
        const parts: string[] = [];
        
        parts.push(`## 🔄 Analyse Cross-Task`);
        
        // Récupération des patterns depuis les statistiques
        if (statistics.commonPatterns) {
            const patterns = statistics.commonPatterns;
            
            if (Object.keys(patterns.frequentTools).length > 0) {
                parts.push(`### Outils Récurrents`);
                parts.push(Object.entries(patterns.frequentTools)
                    .sort(([,a], [,b]) => b - a)
                    .map(([tool, count]) => `- **${tool}** : utilisé dans ${count} tâche${count > 1 ? 's' : ''}`)
                    .join('\n'));
            }
            
            if (Object.keys(patterns.commonModes).length > 0) {
                parts.push(`### Modes Fréquents`);
                parts.push(Object.entries(patterns.commonModes)
                    .sort(([,a], [,b]) => b - a)
                    .map(([mode, count]) => `- **${mode}** : ${count} tâche${count > 1 ? 's' : ''}`)
                    .join('\n'));
            }
            
            if (patterns.crossTaskTopics.length > 0) {
                parts.push(`### Sujets Transversaux`);
                parts.push(patterns.crossTaskTopics.map(topic => `- ${topic}`).join('\n'));
            }
        }
        
        // Analyse des dépendances et relations
        parts.push(`### Relations entre Tâches`);
        
        const relationships: string[] = [];
        const rootTask = organizedTasks.rootTask;
        const childTasks = organizedTasks.allTasks.filter(task => task !== rootTask);
        
        relationships.push(`**Tâche racine :** ${rootTask.metadata.title || rootTask.taskId}`);
        
        if (childTasks.length > 0) {
            relationships.push(`**Tâches dépendantes (${childTasks.length}) :**`);
            childTasks.forEach((child, index) => {
                relationships.push(`${index + 1}. ${child.metadata.title || child.taskId} (${this.formatBytes(child.metadata.totalSize)})`);
            });
        }
        
        parts.push(relationships.join('\n'));
        
        return parts.join('\n\n');
    }

    /**
     * Construction du résultat final
     */
    private buildClusterResult(
        content: string,
        statistics: ClusterSummaryStatistics,
        organizedTasks: OrganizedClusterTasks,
        options: ClusterSummaryOptions
    ): ClusterSummaryResult {
        
        const taskIndex = organizedTasks.sortedTasks.map((task, index) => ({
            taskId: task.taskId,
            title: task.metadata.title || task.taskId,
            order: index,
            size: task.metadata.totalSize
        }));
        
        return {
            success: true,
            content,
            statistics,
            clusterMetadata: {
                rootTaskId: organizedTasks.rootTask.taskId,
                totalTasks: statistics.totalTasks,
                clusterMode: options.clusterMode || 'aggregated',
                generationTimestamp: new Date().toISOString()
            },
            taskIndex,
            format: options.outputFormat || 'markdown',
            size: content.length
        };
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
                    throw new Error(`Unsupported CSV variant: ${variant}`);
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
                    if (this.isToolResult(message.content)) {
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
}

/**
 * Interface pour les blocs techniques extraits
 */
interface TechnicalBlock {
    type: 'thinking' | 'tool' | 'other';
    content: string;
    toolTag?: string;
}