/**
 * IReportingStrategy - Interface du pattern Strategy pour le filtrage de contenu
 * 
 * Définit le contrat pour les différentes stratégies de filtrage selon DetailLevel
 * Selon l'architecture définie dans docs/sddd/markdown_export_architecture.md
 */

import { ClassifiedContent } from '../../../types/enhanced-conversation.js';

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
}