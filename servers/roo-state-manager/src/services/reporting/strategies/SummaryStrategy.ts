/**
 * SummaryStrategy - Stratégie "Summary" qui ne garde que l'essentiel
 * 
 * Correspond au DetailLevel "Summary" - contenu ultra-concentré et pertinent
 * Selon l'architecture définie dans docs/sddd/markdown_export_architecture.md
 */

import { ClassifiedContent } from '../../../types/enhanced-conversation.js';
import { BaseReportingStrategy } from './IReportingStrategy.js';

export class SummaryStrategy extends BaseReportingStrategy {
    
    getStrategyName(): string {
        return 'Summary';
    }

    /**
     * Stratégie Summary : garde seulement le contenu le plus pertinent
     */
    apply(content: ClassifiedContent[]): ClassifiedContent[] {
        // Étape 1: Filtrer par sous-types pertinents (pas de thinking, focus sur l'essentiel)
        const relevantContent = this.filterBySubTypes(content, [
            'UserMessage', 
            'Completion', 
            'ToolCall', // Garder quelques appels critiques
            'ToolResult' // Garder quelques résultats importants
        ]);

        // Étape 2: Filtrage agressif par pertinence (seuil élevé)
        const highConfidenceContent = relevantContent.filter(item => 
            item.confidenceScore >= 0.7 && item.isRelevant
        );

        // Étape 3: Prioriser et limiter le nombre d'éléments
        const prioritized = this.prioritizeForSummary(highConfidenceContent);
        
        // Étape 4: Limiter à un nombre raisonnable d'éléments pour un summary
        const maxItems = Math.max(10, Math.floor(content.length * 0.2)); // Max 20% du contenu original
        return prioritized.slice(0, maxItems);
    }

    /**
     * Configuration Summary : très sélectif
     */
    shouldShowToolDetails(): boolean { 
        return false; // Pas de détails techniques dans un résumé
    }

    shouldShowThinking(): boolean { 
        return false; // Absolument pas de thinking
    }

    shouldShowToolResults(): boolean { 
        return false; // Résultats seulement s'ils sont critiques
    }

    isUserOnlyMode(): boolean { 
        return false; 
    }

    /**
     * Filtrage ultra-sélectif pour Summary
     */
    filterByRelevance(content: ClassifiedContent[], minConfidenceScore: number): ClassifiedContent[] {
        // Pour Summary, on veut vraiment que le contenu exceptionnel
        // Seuil minimum très élevé
        const summaryThreshold = Math.max(0.75, minConfidenceScore);
        
        return content.filter(item => 
            item.confidenceScore >= summaryThreshold && 
            item.isRelevant &&
            this.isCriticalContent(item)
        );
    }

    /**
     * Troncature très agressive pour Summary
     */
    applyIntelligentTruncation(content: ClassifiedContent[], maxChars: number): ClassifiedContent[] {
        if (maxChars <= 0) return content;

        // Pour Summary, on priorise fortement la qualité sur la quantité
        const ultraPrioritized = content.map(item => ({
            ...item,
            summaryPriority: this.calculateSummaryPriority(item)
        })).sort((a, b) => b.summaryPriority - a.summaryPriority);

        let totalChars = 0;
        const result: ClassifiedContent[] = [];

        for (const item of ultraPrioritized) {
            if (totalChars + item.contentSize <= maxChars) {
                const { summaryPriority, ...cleanItem } = item;
                result.push(cleanItem);
                totalChars += item.contentSize;
            } else {
                // Pour Summary, si on dépasse, on s'arrête (pas de troncature partielle)
                break;
            }
        }

        // Remettre dans l'ordre chronologique mais seulement les éléments les plus importants
        return result.sort((a, b) => a.index - b.index);
    }

    /**
     * Priorise le contenu pour le résumé
     */
    private prioritizeForSummary(content: ClassifiedContent[]): ClassifiedContent[] {
        return content
            .map(item => ({
                ...item,
                summaryScore: this.calculateSummaryScore(item)
            }))
            .sort((a, b) => b.summaryScore - a.summaryScore)
            .map(({ summaryScore, ...item }) => item);
    }

    /**
     * Calcule le score de pertinence pour le résumé
     */
    private calculateSummaryScore(item: ClassifiedContent): number {
        let score = item.confidenceScore;

        // Bonus majeurs pour le contenu vraiment important
        switch (item.subType) {
            case 'UserMessage':
                score += 0.4; // Messages utilisateur très importants dans un résumé
                break;
            case 'Completion':
                score += 0.3; // Réponses principales importantes
                break;
            case 'ToolCall':
                // Seulement les appels d'outils vraiment critiques
                if (this.isCriticalTool(item)) {
                    score += 0.2;
                } else {
                    score -= 0.3; // Pénalité pour les outils non critiques
                }
                break;
            case 'ToolResult':
                // Seulement les résultats vraiment importants
                if (item.toolResultDetails?.success && item.contentSize < 500) {
                    score += 0.1;
                } else {
                    score -= 0.4; // Pénalité forte pour les résultats verbeux
                }
                break;
            default:
                score -= 0.2; // Pénalité pour tout le reste
                break;
        }

        // Bonus pour le contenu concis
        if (item.contentSize <= 200) {
            score += 0.2;
        } else if (item.contentSize > 1000) {
            score -= 0.3; // Pénalité pour le contenu verbeux
        }

        return score;
    }

    /**
     * Calcule la priorité spécifique pour Summary
     */
    private calculateSummaryPriority(item: ClassifiedContent): number {
        return this.calculateSummaryScore(item);
    }

    /**
     * Détermine si c'est un contenu critique pour un résumé
     */
    private isCriticalContent(item: ClassifiedContent): boolean {
        switch (item.subType) {
            case 'UserMessage':
            case 'Completion':
                return true; // Messages conversationnels toujours critiques
            case 'ToolCall':
                return this.isCriticalTool(item);
            case 'ToolResult':
                return item.toolResultDetails?.success === true && item.contentSize < 300;
            default:
                return false;
        }
    }

    /**
     * Détermine si c'est un appel d'outil critique
     */
    private isCriticalTool(item: ClassifiedContent): boolean {
        const criticalTools = [
            'write_to_file',
            'apply_diff',
            'execute_command',
            'read_file' // Seulement si petit
        ];

        const toolName = item.toolCallDetails?.toolName || item.toolType || '';
        
        if (criticalTools.includes(toolName)) {
            // Pour read_file, seulement si pas trop verbeux
            if (toolName === 'read_file' && item.contentSize > 500) {
                return false;
            }
            return true;
        }
        
        return false;
    }
}