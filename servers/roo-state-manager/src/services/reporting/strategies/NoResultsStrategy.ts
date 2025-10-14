/**
 * NoResultsStrategy - Stratégie "NoResults" qui exclut les résultats d'outils
 * 
 * Correspond au DetailLevel "NoResults" - affiche tout sauf les résultats d'outils
 * Selon l'architecture définie dans docs/sddd/markdown_export_architecture.md
 */

import { ClassifiedContent } from '../../../types/enhanced-conversation.js';
import { BaseReportingStrategy } from './IReportingStrategy.js';

export class NoResultsStrategy extends BaseReportingStrategy {
    
    getStrategyName(): string {
        return 'NoResults';
    }

    /**
     * Stratégie NoResults : exclut les résultats d'outils mais garde les appels
     */
    apply(content: ClassifiedContent[]): ClassifiedContent[] {
        // Exclure spécifiquement les ToolResult
        return this.excludeSubTypes(content, ['ToolResult']);
    }

    /**
     * Configuration NoResults : détails d'outils OK mais pas les résultats
     */
    shouldShowToolDetails(): boolean { 
        return true; // On garde les détails d'outils (les appels)
    }

    shouldShowThinking(): boolean { 
        return false; // Pas de thinking
    }

    shouldShowToolResults(): boolean { 
        return false; // Pas de résultats d'outils
    }

    isUserOnlyMode(): boolean { 
        return false; 
    }

    /**
     * Filtrage spécialisé pour NoResults
     */
    filterByRelevance(content: ClassifiedContent[], minConfidenceScore: number): ClassifiedContent[] {
        // D'abord appliquer le filtrage de base
        let filtered = super.filterByRelevance(content, minConfidenceScore);
        
        // Puis spécifiquement exclure les ToolResult même s'ils sont pertinents
        return filtered.filter(item => item.subType !== 'ToolResult');
    }

    /**
     * Troncature intelligente pour NoResults - priorise les appels et messages
     */
    applyIntelligentTruncation(content: ClassifiedContent[], maxChars: number): ClassifiedContent[] {
        if (maxChars <= 0) return content;

        // Stratégie de priorisation pour NoResults:
        // 1. Messages utilisateur (score de base + 0.3)
        // 2. Appels d'outils (score de base + 0.2) - ils sont informatifs
        // 3. Réponses assistant (score de base + 0.1)
        // 4. Résultats d'outils (pénalité forte)
        
        const prioritizedContent = content.map(item => ({
            ...item,
            priority: this.calculateNoResultsPriority(item)
        })).sort((a, b) => b.priority - a.priority);

        let totalChars = 0;
        const result: ClassifiedContent[] = [];

        for (const item of prioritizedContent) {
            if (totalChars + item.contentSize <= maxChars) {
                // Retirer la propriété priority avant d'ajouter
                const { priority, ...cleanItem } = item;
                result.push(cleanItem);
                totalChars += item.contentSize;
            }
        }

        // Remettre dans l'ordre chronologique original
        return result.sort((a, b) => a.index - b.index);
    }

    /**
     * Calcule la priorité pour NoResults
     */
    private calculateNoResultsPriority(item: ClassifiedContent): number {
        let priority = item.confidenceScore;

        // Bonus selon le type de contenu
        switch (item.subType) {
            case 'UserMessage':
                priority += 0.3; // Messages utilisateur très importants
                break;
            case 'ToolCall':
                priority += 0.2; // Appels d'outils informatifs
                break;
            case 'Completion':
                priority += 0.1; // Réponses assistant importantes
                break;
            case 'ToolResult':
                priority -= 0.8; // Pénalité très forte pour décourager
                break;
            default:
                // Pas de bonus/malus
                break;
        }

        return priority;
    }
}