/**
 * IReportingStrategy - Interface du pattern Strategy pour le filtrage de contenu
 * 
 * Définit le contrat pour les différentes stratégies de filtrage selon DetailLevel
 * Selon l'architecture définie dans docs/sddd/markdown_export_architecture.md
 */

import { ClassifiedContent, EnhancedSummaryOptions } from '../../../types/enhanced-conversation.js';
import { MarkdownFormatterService } from '../../MarkdownFormatterService.js';

/**
 * Interface principale du pattern Strategy pour le filtrage de rapports
 */
export interface IReportingStrategy {
    /**
     * Applique la stratégie de filtrage au contenu classifié
     * @param content - Contenu classifié à filtrer
     * @returns Contenu filtré selon la stratégie
     */
    apply(content: ClassifiedContent[]): ClassifiedContent[];

    /**
     * Indique si cette stratégie doit afficher les détails des outils
     * @returns true si les détails d'outils doivent être montrés
     */
    shouldShowToolDetails(): boolean;

    /**
     * Indique si cette stratégie doit afficher les sections "thinking"
     * @returns true si les sections thinking doivent être montrées
     */
    shouldShowThinking(): boolean;

    /**
     * Indique si cette stratégie doit afficher les résultats d'outils
     * @returns true si les résultats d'outils doivent être montrés
     */
    shouldShowToolResults(): boolean;

    /**
     * Indique si cette stratégie doit afficher les messages utilisateur uniquement
     * @returns true si seuls les messages utilisateur doivent être montrés
     */
    isUserOnlyMode(): boolean;

    /**
     * Fournit le nom de la stratégie pour le logging/debugging
     * @returns nom de la stratégie
     */
    getStrategyName(): string;

    /**
     * Applique un filtrage de pertinence basé sur le confidence score
     * @param content - Contenu à filtrer
     * @param minConfidenceScore - Score minimum de confiance (0.0 - 1.0)
     * @returns Contenu filtré par pertinence
     */
    filterByRelevance(content: ClassifiedContent[], minConfidenceScore: number): ClassifiedContent[];

    /**
     * Applique une troncature intelligente selon la stratégie
     * @param content - Contenu à tronquer
     * @param maxChars - Nombre maximum de caractères
     * @returns Contenu tronqué intelligemment
     */
    applyIntelligentTruncation(content: ClassifiedContent[], maxChars: number): ClassifiedContent[];
}

/**
 * Classe de base abstraite pour les stratégies de reporting
 * Fournit des implémentations communes et des méthodes utilitaires
 */
export abstract class BaseReportingStrategy implements IReportingStrategy {
    /**
     * Implémentation de base du filtrage - à override dans les classes concrètes
     */
    abstract apply(content: ClassifiedContent[]): ClassifiedContent[];
    
    /**
     * Nom de la stratégie - à override dans les classes concrètes
     */
    abstract getStrategyName(): string;

    /**
     * Configuration par défaut - à override selon les besoins
     */
    shouldShowToolDetails(): boolean { return true; }
    shouldShowThinking(): boolean { return false; }
    shouldShowToolResults(): boolean { return true; }
    isUserOnlyMode(): boolean { return false; }

    /**
     * Filtrage par pertinence - implémentation commune
     */
    filterByRelevance(content: ClassifiedContent[], minConfidenceScore: number): ClassifiedContent[] {
        return content.filter(item => 
            item.confidenceScore >= minConfidenceScore && item.isRelevant
        );
    }

    /**
     * Troncature intelligente - implémentation commune
     */
    applyIntelligentTruncation(content: ClassifiedContent[], maxChars: number): ClassifiedContent[] {
        if (maxChars <= 0) return content;

        let totalChars = 0;
        const result: ClassifiedContent[] = [];

        // Prioriser le contenu par score de confiance
        const sortedContent = [...content].sort((a, b) => b.confidenceScore - a.confidenceScore);

        for (const item of sortedContent) {
            if (totalChars + item.contentSize <= maxChars) {
                result.push(item);
                totalChars += item.contentSize;
            } else if (result.length === 0) {
                // Si même le premier élément dépasse, le tronquer
                const truncatedContent = item.content.substring(0, maxChars - totalChars - 10) + '...[truncated]';
                result.push({
                    ...item,
                    content: truncatedContent,
                    contentSize: truncatedContent.length
                });
                break;
            }
        }

        // Remettre dans l'ordre original
        return result.sort((a, b) => a.index - b.index);
    }

    /**
     * Filtre le contenu par sous-types
     */
    protected filterBySubTypes(content: ClassifiedContent[], allowedSubTypes: string[]): ClassifiedContent[] {
        return content.filter(item => allowedSubTypes.includes(item.subType));
    }

    /**
     * Filtre le contenu par types principaux
     */
    protected filterByMainTypes(content: ClassifiedContent[], allowedTypes: ('User' | 'Assistant')[]): ClassifiedContent[] {
        return content.filter(item => allowedTypes.includes(item.type));
    }

    /**
     * Exclut certains sous-types
     */
    protected excludeSubTypes(content: ClassifiedContent[], excludedSubTypes: string[]): ClassifiedContent[] {
        return content.filter(item => !excludedSubTypes.includes(item.subType));
    }

    // ===========================
    // PHASE 5: NOUVELLES FONCTIONNALITÉS INTERACTIVES
    // ===========================

    /**
     * Génère la table des matières interactive Phase 5
     */
    protected generateInteractiveTableOfContents(
        messages: ClassifiedContent[],
        options: EnhancedSummaryOptions
    ): string {
        const interactiveTocOptions = options.interactiveToCSOptions;
        
        if (!interactiveTocOptions?.enableInteractiveToC) {
            return '';
        }

        return MarkdownFormatterService.generateTableOfContents(messages, interactiveTocOptions);
    }

    /**
     * Applique la troncature intelligente aux paramètres d'outils Phase 5
     */
    protected applyParameterTruncation(
        content: string,
        isToolParameter: boolean,
        options: EnhancedSummaryOptions,
        elementId: string
    ): string {
        const truncationOptions = options.truncationOptions;
        
        if (!truncationOptions?.enableTruncation) {
            return content;
        }

        const result = isToolParameter
            ? MarkdownFormatterService.truncateToolParameters(content, truncationOptions)
            : MarkdownFormatterService.truncateToolResult(content, truncationOptions);
            
        if (result.wasTruncated) {
            return MarkdownFormatterService.generateTruncationToggle(content, result.content, elementId);
        }

        return result.content;
    }

    /**
     * Génère les ancres de navigation Phase 5 pour un message
     */
    protected generateNavigationAnchor(messageIndex: number, messageType: string): string {
        return MarkdownFormatterService.generateNavigationAnchors(messageIndex, messageType);
    }

    /**
     * Ajoute les ancres de navigation aux messages formatés
     */
    protected addNavigationAnchors(
        formattedContent: string,
        messageIndex: number,
        messageType: string,
        options: EnhancedSummaryOptions
    ): string {
        if (!options.enhancementFlags?.enableInteractiveToC) {
            return formattedContent;
        }

        const anchor = this.generateNavigationAnchor(messageIndex, messageType);
        
        // Injecter l'ancre au début du contenu
        return `<div id="${anchor}">\n${formattedContent}\n</div>`;
    }

    /**
     * Génère le script JavaScript interactif si activé
     */
    protected getInteractiveScript(options: EnhancedSummaryOptions): string {
        if (!options.enhancementFlags?.enableJavaScriptInteractions) {
            return '';
        }

        return MarkdownFormatterService.generateInteractiveScript();
    }

    /**
     * Formate un appel d'outil avec troncature optionnelle Phase 5
     */
    protected formatToolCallWithTruncation(
        toolName: string,
        parameters: any,
        messageIndex: number,
        options: EnhancedSummaryOptions
    ): string {
        const elementId = `tool-call-${messageIndex}`;
        
        // Appliquer la troncature si activée
        let formattedParams = MarkdownFormatterService.formatToolParametersTable(parameters);
        
        if (options.truncationOptions?.enableTruncation) {
            const paramStr = typeof parameters === 'string' ? parameters : JSON.stringify(parameters, null, 2);
            formattedParams = this.applyParameterTruncation(paramStr, true, options, elementId);
        }

        return `
<div class="conversation-section tool-call">
    <div class="section-header">
        <span class="message-badge tool-call">Appel d'Outil: ${toolName}</span>
    </div>
    <div class="message-content">
        ${formattedParams}
    </div>
</div>`;
    }

    /**
     * Formate un résultat d'outil avec troncature optionnelle Phase 5
     */
    protected formatToolResultWithTruncation(
        toolName: string,
        result: any,
        messageIndex: number,
        options: EnhancedSummaryOptions
    ): string {
        const elementId = `tool-result-${messageIndex}`;
        
        // Appliquer la troncature si activée
        let formattedResult = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        
        if (options.truncationOptions?.enableTruncation) {
            formattedResult = this.applyParameterTruncation(formattedResult, false, options, elementId);
        }

        return `
<div class="conversation-section tool-result">
    <div class="section-header">
        <span class="message-badge tool-result">Résultat: ${toolName}</span>
    </div>
    <div class="message-content">
        <pre><code>${formattedResult}</code></pre>
    </div>
</div>`;
    }

    /**
     * Construit le HTML final avec toutes les fonctionnalités Phase 5
     */
    protected buildFinalHtmlWithPhase5Features(
        cssContent: string,
        bodyContent: string,
        tableOfContents: string,
        options: EnhancedSummaryOptions
    ): string {
        const interactiveScript = this.getInteractiveScript(options);
        
        return `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Résumé de Conversation Roo - Phase 5</title>
    ${cssContent}
</head>
<body>
    ${tableOfContents}
    ${bodyContent}
    ${interactiveScript}
</body>
</html>`;
    }

    /**
     * Méthode utilitaire pour déterminer si les fonctionnalités Phase 5 sont activées
     */
    protected isPhase5Enabled(options: EnhancedSummaryOptions): boolean {
        return !!(
            options.enhancementFlags?.enableInteractiveToC ||
            options.enhancementFlags?.enableParameterTruncation ||
            options.enhancementFlags?.enableJavaScriptInteractions
        );
    }
}