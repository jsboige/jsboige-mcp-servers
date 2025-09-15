/**
 * UserOnlyStrategy - Stratégie "UserOnly" qui ne garde que les messages utilisateur
 * 
 * Correspond au DetailLevel "UserOnly" - uniquement les messages de l'utilisateur
 * Selon l'architecture définie dans docs/sddd/markdown_export_architecture.md
 */

import { ClassifiedContent } from '../../../types/enhanced-conversation.js';
import { BaseReportingStrategy } from './IReportingStrategy.js';

export class UserOnlyStrategy extends BaseReportingStrategy {
    
    getStrategyName(): string {
        return 'UserOnly';
    }

    /**
     * Stratégie UserOnly : garde uniquement les messages utilisateur
     */
    apply(content: ClassifiedContent[]): ClassifiedContent[] {
        // Ne garder que les messages utilisateur
        return this.filterBySubTypes(content, ['UserMessage']);
    }

    /**
     * Configuration UserOnly : rien d'autre que les messages utilisateur
     */
    shouldShowToolDetails(): boolean { 
        return false; // Pas de détails d'outils
    }

    shouldShowThinking(): boolean { 
        return false; // Pas de thinking
    }

    shouldShowToolResults(): boolean { 
        return false; // Pas de résultats d'outils
    }

    isUserOnlyMode(): boolean { 
        return true; // C'est exactement le mode UserOnly
    }

    /**
     * Filtrage ultra-spécialisé pour UserOnly
     */
    filterByRelevance(content: ClassifiedContent[], minConfidenceScore: number): ClassifiedContent[] {
        // Pour UserOnly, on veut vraiment tous les messages utilisateur, même ceux à faible score
        // Car l'intention de l'utilisateur est toujours pertinente
        const userOnlyContent = content.filter(item => item.subType === 'UserMessage');
        
        // Appliquer un seuil très bas pour inclure presque tous les messages utilisateur
        const lowThreshold = Math.max(0.1, minConfidenceScore * 0.5);
        
        return userOnlyContent.filter(item => 
            item.confidenceScore >= lowThreshold
        );
    }

    /**
     * Troncature pour UserOnly - préserver l'ordre chronologique
     */
    applyIntelligentTruncation(content: ClassifiedContent[], maxChars: number): ClassifiedContent[] {
        if (maxChars <= 0) return content;

        // Pour UserOnly, on maintient l'ordre chronologique strict
        // Et on priorise les messages les plus récents et les plus longs (plus d'information)
        
        const userMessages = content.filter(item => item.subType === 'UserMessage');
        
        // Calculer la priorité : combiner recency et substantialité
        const prioritizedMessages = userMessages.map(item => ({
            ...item,
            userOnlyPriority: this.calculateUserOnlyPriority(item, userMessages.length)
        })).sort((a, b) => b.userOnlyPriority - a.userOnlyPriority);

        let totalChars = 0;
        const result: ClassifiedContent[] = [];

        for (const item of prioritizedMessages) {
            if (totalChars + item.contentSize <= maxChars) {
                const { userOnlyPriority, ...cleanItem } = item;
                result.push(cleanItem);
                totalChars += item.contentSize;
            } else if (result.length === 0) {
                // Si même le premier message dépasse, le tronquer partiellement
                const availableChars = maxChars - 20; // Réserver pour le marqueur de troncature
                const truncatedContent = item.content.substring(0, availableChars) + '...[message tronqué]';
                const { userOnlyPriority, ...cleanItem } = item;
                result.push({
                    ...cleanItem,
                    content: truncatedContent,
                    contentSize: truncatedContent.length
                });
                break;
            }
        }

        // Remettre dans l'ordre chronologique original
        return result.sort((a, b) => a.index - b.index);
    }

    /**
     * Calcule la priorité pour UserOnly
     */
    private calculateUserOnlyPriority(item: ClassifiedContent, totalUserMessages: number): number {
        let priority = item.confidenceScore;

        // Bonus pour la recency (plus récent = plus important)
        const recencyBonus = (item.index / totalUserMessages) * 0.3;
        priority += recencyBonus;

        // Bonus pour la substantialité (plus de contenu = plus d'information)
        if (item.contentSize >= 100) {
            priority += 0.2;
        }
        if (item.contentSize >= 500) {
            priority += 0.1;
        }

        // Bonus pour les questions (contiennent souvent '?')
        if (item.content.includes('?')) {
            priority += 0.15; // Les questions sont importantes
        }

        // Bonus pour les messages avec du code ou des chemins (contiennent souvent '/' ou '{')
        if (item.content.includes('/') || item.content.includes('{') || item.content.includes('`')) {
            priority += 0.1; // Instructions techniques importantes
        }

        return priority;
    }
}