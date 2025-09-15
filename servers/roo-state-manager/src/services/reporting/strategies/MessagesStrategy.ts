/**
 * MessagesStrategy - Stratégie "Messages" qui ne garde que les échanges conversationnels
 * 
 * Correspond au DetailLevel "Messages" - uniquement UserMessage et Completion
 * Selon l'architecture définie dans docs/sddd/markdown_export_architecture.md
 */

import { ClassifiedContent } from '../../../types/enhanced-conversation.js';
import { BaseReportingStrategy } from './IReportingStrategy.js';

export class MessagesStrategy extends BaseReportingStrategy {
    
    getStrategyName(): string {
        return 'Messages';
    }

    /**
     * Stratégie Messages : garde uniquement les échanges conversationnels principaux
     */
    apply(content: ClassifiedContent[]): ClassifiedContent[] {
        // Garder seulement UserMessage et Completion - l'essence de la conversation
        return this.filterBySubTypes(content, ['UserMessage', 'Completion']);
    }

    /**
     * Configuration Messages : focus sur la conversation pure
     */
    shouldShowToolDetails(): boolean { 
        return false; // Pas de détails techniques
    }

    shouldShowThinking(): boolean { 
        return false; // Pas de thinking
    }

    shouldShowToolResults(): boolean { 
        return false; // Pas de résultats d'outils
    }

    isUserOnlyMode(): boolean { 
        return false; // User + Assistant, pas seulement user
    }

    /**
     * Filtrage spécialisé pour Messages - plus strict sur la pertinence
     */
    filterByRelevance(content: ClassifiedContent[], minConfidenceScore: number): ClassifiedContent[] {
        // Pour Messages, on veut vraiment que le contenu conversationnel de qualité
        // Augmenter légèrement le seuil minimum
        const adjustedThreshold = Math.min(0.9, minConfidenceScore * 1.2);
        
        let filtered = content.filter(item => 
            item.confidenceScore >= adjustedThreshold && item.isRelevant
        );
        
        // Puis appliquer le filtre des sous-types autorisés
        return this.filterBySubTypes(filtered, ['UserMessage', 'Completion']);
    }

    /**
     * Troncature intelligente pour Messages - équilibrer user/assistant
     */
    applyIntelligentTruncation(content: ClassifiedContent[], maxChars: number): ClassifiedContent[] {
        if (maxChars <= 0) return content;

        // Stratégie équilibrée pour Messages:
        // Essayer de maintenir un ratio équilibré entre UserMessage et Completion
        const userMessages = content.filter(item => item.subType === 'UserMessage');
        const completions = content.filter(item => item.subType === 'Completion');

        // Allouer l'espace de manière proportionnelle mais équilibrée
        const totalUserChars = userMessages.reduce((sum, item) => sum + item.contentSize, 0);
        const totalCompletionChars = completions.reduce((sum, item) => sum + item.contentSize, 0);
        const totalChars = totalUserChars + totalCompletionChars;

        if (totalChars <= maxChars) {
            return content; // Tout rentre
        }

        // Répartition équilibrée : minimum 30% pour chaque type, reste proportionnel
        const userRatio = Math.max(0.3, Math.min(0.7, totalUserChars / totalChars));
        const completionRatio = 1 - userRatio;

        const maxUserChars = Math.floor(maxChars * userRatio);
        const maxCompletionChars = Math.floor(maxChars * completionRatio);

        const selectedUsers = this.selectBestContent(userMessages, maxUserChars);
        const selectedCompletions = this.selectBestContent(completions, maxCompletionChars);

        // Combiner et remettre dans l'ordre chronologique
        const result = [...selectedUsers, ...selectedCompletions];
        return result.sort((a, b) => a.index - b.index);
    }

    /**
     * Sélectionne le meilleur contenu dans une limite de caractères
     */
    private selectBestContent(items: ClassifiedContent[], maxChars: number): ClassifiedContent[] {
        // Trier par score de confiance décroissant
        const sortedItems = [...items].sort((a, b) => b.confidenceScore - a.confidenceScore);
        
        const result: ClassifiedContent[] = [];
        let usedChars = 0;

        for (const item of sortedItems) {
            if (usedChars + item.contentSize <= maxChars) {
                result.push(item);
                usedChars += item.contentSize;
            }
        }

        return result;
    }
}