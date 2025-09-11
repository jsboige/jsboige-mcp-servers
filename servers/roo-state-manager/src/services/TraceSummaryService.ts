/**
 * TraceSummaryService - Service de génération de résumés intelligents de traces Roo
 * 
 * Ce service porte la logique du script PowerShell Convert-TraceToSummary-Optimized.ps1
 * vers un service Node.js/TypeScript intégré dans l'écosystème roo-state-manager.
 */

import { ConversationSkeleton, MessageSkeleton, ActionMetadata } from '../types/conversation.js';
import { ExportConfigManager } from './ExportConfigManager.js';

/**
 * Options de configuration pour la génération de résumé
 */
export interface SummaryOptions {
    detailLevel: 'Full' | 'NoTools' | 'NoResults' | 'Messages' | 'Summary' | 'UserOnly';
    truncationChars: number;
    compactStats: boolean;
    includeCss: boolean;
    generateToc: boolean;
    outputFormat: 'markdown' | 'html';
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
            
            // 1. Classification du contenu
            const classifiedContent = this.classifyConversationContent(conversation);
            
            // 2. Calcul des statistiques
            const statistics = this.calculateStatistics(classifiedContent);
            
            // 3. Génération du résumé selon le niveau de détail
            const content = await this.renderSummary(
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

        // 5. Footer
        parts.push(this.generateFooter(options));

        return parts.join('\n\n');
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
        return {
            detailLevel: options.detailLevel || 'Full',
            truncationChars: options.truncationChars || 0,
            compactStats: options.compactStats || false,
            includeCss: options.includeCss !== undefined ? options.includeCss : true,
            generateToc: options.generateToc !== undefined ? options.generateToc : true,
            outputFormat: options.outputFormat || 'markdown'
        };
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