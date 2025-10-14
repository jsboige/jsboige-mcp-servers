/**
 * NoToolsStrategy - Stratégie "NoTools" qui exclut les appels d'outils
 * 
 * Correspond au DetailLevel "NoTools" - affiche tout sauf les appels d'outils
 * Selon l'architecture définie dans docs/sddd/markdown_export_architecture.md
 */

import { ClassifiedContent } from '../../../types/enhanced-conversation.js';
import { BaseReportingStrategy } from './IReportingStrategy.js';

export class NoToolsStrategy extends BaseReportingStrategy {
    
    getStrategyName(): string {
        return 'NoTools';
    }

    /**
     * Stratégie NoTools : exclut les appels d'outils mais garde leurs résultats
     */
    apply(content: ClassifiedContent[]): ClassifiedContent[] {
        // Exclure spécifiquement les ToolCall
        return this.excludeSubTypes(content, ['ToolCall']);
    }

    /**
     * Configuration NoTools : pas de détails d'outils mais résultats OK
     */
    shouldShowToolDetails(): boolean { 
        return false; // Pas de détails d'outils
    }

    shouldShowThinking(): boolean { 
        return false; // Pas de thinking non plus
    }

    shouldShowToolResults(): boolean { 
        return true; // Mais on garde les résultats
    }

    isUserOnlyMode(): boolean { 
        return false; 
    }

    /**
     * Filtrage spécialisé pour NoTools
     */
    filterByRelevance(content: ClassifiedContent[], minConfidenceScore: number): ClassifiedContent[] {
        // D'abord appliquer le filtrage de base
        let filtered = super.filterByRelevance(content, minConfidenceScore);
        
        // Puis spécifiquement exclure les ToolCall même s'ils sont pertinents
        return filtered.filter(item => item.subType !== 'ToolCall');
    }

    /**
     * Troncature intelligente pour NoTools - priorise les résultats et messages
     */
    applyIntelligentTruncation(content: ClassifiedContent[], maxChars: number): ClassifiedContent[] {
        if (maxChars <= 0) return content;

        // Stratégie de priorisation pour NoTools:
        // 1. Messages utilisateur (score de base + 0.3)
        // 2. Réponses assistant (score de base + 0.2)
        // 3. Résultats d'outils (score de base + 0.1)
        // 4. Reste (score de base)
        
        const prioritizedContent = content.map(item => ({
            ...item,
            priority: this.calculateNoToolsPriority(item)
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
     * Calcule la priorité pour NoTools
     */
    private calculateNoToolsPriority(item: ClassifiedContent): number {
        let priority = item.confidenceScore;

        // Bonus selon le type de contenu
        switch (item.subType) {
            case 'UserMessage':
                priority += 0.3;
                break;
            case 'Completion':
                priority += 0.2;
                break;
            case 'ToolResult':
                priority += 0.1;
                break;
            case 'ToolCall':
                priority -= 0.5; // Pénalité forte pour décourager
                break;
            default:
                // Pas de bonus/malus
                break;
        }

        return priority;
    }
}