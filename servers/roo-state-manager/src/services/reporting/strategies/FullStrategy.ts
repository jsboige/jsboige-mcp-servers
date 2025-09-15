/**
 * FullStrategy - Stratégie "Full" qui inclut tout le contenu
 * 
 * Correspond au DetailLevel "Full" - affiche tout sans filtrage
 * Selon l'architecture définie dans docs/sddd/markdown_export_architecture.md
 */

import { ClassifiedContent } from '../../../types/enhanced-conversation.js';
import { BaseReportingStrategy } from './IReportingStrategy.js';

export class FullStrategy extends BaseReportingStrategy {
    
    getStrategyName(): string {
        return 'Full';
    }

    /**
     * Stratégie Full : inclut absolument tout le contenu
     * Aucun filtrage n'est appliqué
     */
    apply(content: ClassifiedContent[]): ClassifiedContent[] {
        // La stratégie Full ne filtre rien - on retourne tout le contenu tel quel
        return content;
    }

    /**
     * Configuration Full : tout est affiché
     */
    shouldShowToolDetails(): boolean { 
        return true; 
    }

    shouldShowThinking(): boolean { 
        return true; // Full inclut même le thinking
    }

    shouldShowToolResults(): boolean { 
        return true; 
    }

    isUserOnlyMode(): boolean { 
        return false; 
    }

    /**
     * Override pour la troncature - Full évite la troncature autant que possible
     */
    applyIntelligentTruncation(content: ClassifiedContent[], maxChars: number): ClassifiedContent[] {
        // Si maxChars est 0, pas de limite
        if (maxChars <= 0) return content;

        // Pour Full, on essaie d'inclure le maximum de contenu
        // en préservant l'ordre chronologique plutôt que par pertinence
        let totalChars = 0;
        const result: ClassifiedContent[] = [];

        for (const item of content) {
            if (totalChars + item.contentSize <= maxChars) {
                result.push(item);
                totalChars += item.contentSize;
            } else if (result.length === 0) {
                // Si même le premier élément dépasse, le tronquer mais garder le maximum
                const availableChars = maxChars - 20; // Reserve for truncation marker
                const truncatedContent = item.content.substring(0, availableChars) + '...[truncated for Full export]';
                result.push({
                    ...item,
                    content: truncatedContent,
                    contentSize: truncatedContent.length
                });
                break;
            } else {
                // Arrêter dès qu'on ne peut plus ajouter d'éléments
                break;
            }
        }

        return result;
    }

    /**
     * Override pour la pertinence - Full inclut même le contenu peu pertinent
     */
    filterByRelevance(content: ClassifiedContent[], minConfidenceScore: number): ClassifiedContent[] {
        // Full ignore largement le filtrage par pertinence
        // On abaisse significativement le seuil minimum
        const loweredThreshold = Math.max(0.1, minConfidenceScore * 0.3);
        return content.filter(item => item.confidenceScore >= loweredThreshold);
    }
}