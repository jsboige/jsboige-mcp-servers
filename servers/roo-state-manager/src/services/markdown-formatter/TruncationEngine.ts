/**
 * TruncationEngine - Moteur de troncature intelligente
 * 
 * Responsable de la troncature des contenus longs (paramètres, résultats)
 * avec préservation de la structure et du contexte.
 */

import { TruncationOptions } from '../../types/enhanced-conversation.js';

export class TruncationEngine {
    /**
     * Troncature intelligente des paramètres d'outils
     */
    static truncateToolParameters(params: any, options?: Partial<TruncationOptions>): { content: string, wasTruncated: boolean } {
        const maxLength = options?.maxParameterLength ?? 500;
        const preserveStructure = options?.preserveStructure ?? true;

        if (!params) {
            return { content: 'N/A', wasTruncated: false };
        }

        let content = typeof params === 'string' ? params : JSON.stringify(params, null, 2);

        if (content.length <= maxLength) {
            return { content, wasTruncated: false };
        }

        if (preserveStructure && typeof params === 'object') {
            // Troncature intelligente pour JSON
            const truncatedParams = this.truncateObjectIntelligently(params, maxLength);
            content = JSON.stringify(truncatedParams, null, 2);
        } else {
            // Troncature simple
            content = content.substring(0, maxLength) + '...';
        }

        return { content, wasTruncated: true };
    }

    /**
     * Troncature intelligente des résultats d'outils
     */
    static truncateToolResult(result: any, options?: Partial<TruncationOptions>): { content: string, wasTruncated: boolean } {
        const maxLength = options?.maxResultLength ?? 1000;
        
        if (!result) {
            return { content: 'N/A', wasTruncated: false };
        }

        let content = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        
        if (content.length <= maxLength) {
            return { content, wasTruncated: false };
        }

        // Préservation des premières et dernières lignes pour le contexte
        const lines = content.split('\n');
        if (lines.length > 10) {
            const firstLines = lines.slice(0, 5).join('\n');
            const lastLines = lines.slice(-3).join('\n');
            content = `${firstLines}\n\n[... ${lines.length - 8} lignes tronquées ...]\n\n${lastLines}`;
        } else {
            content = content.substring(0, maxLength) + '...';
        }

        return { content, wasTruncated: true };
    }

    /**
     * Génère un bouton toggle pour le contenu tronqué
     */
    static generateTruncationToggle(fullContent: string, truncatedContent: string, elementId: string): string {
        return `
<div class="truncation-container">
    <div class="truncated-content" id="truncated-${elementId}">
        <pre><code>${truncatedContent}</code></pre>
        <button class="expand-button" onclick="toggleTruncation('${elementId}')" data-action="expand">
            📖 Voir le contenu complet
        </button>
    </div>
    <div class="full-content hidden" id="full-${elementId}">
        <pre><code>${fullContent}</code></pre>
        <button class="collapse-button" onclick="toggleTruncation('${elementId}')" data-action="collapse">
            📚 Réduire
        </button>
    </div>
</div>`;
    }

    /**
     * Génère le contenu expandable avec preview
     */
    static generateExpandableContent(content: string, summary: string, elementId: string): string {
        return `
<div class="expandable-container">
    <div class="content-summary">${summary}</div>
    <button class="expand-toggle" onclick="toggleExpandable('${elementId}')">
        <span class="expand-icon">▶</span>
        <span class="expand-text">Développer</span>
    </button>
    <div class="expandable-content hidden" id="expandable-${elementId}">
        ${content}
    </div>
</div>`;
    }

    /**
     * Troncature intelligente d'objet JSON
     */
    private static truncateObjectIntelligently(obj: any, maxLength: number): any {
        const jsonStr = JSON.stringify(obj, null, 2);
        if (jsonStr.length <= maxLength) {
            return obj;
        }

        // Stratégie de troncature intelligente
        const truncated: any = {};
        const entries = Object.entries(obj);
        let currentLength = 2; // Pour {}

        for (const [key, value] of entries) {
            const entryStr = JSON.stringify({ [key]: value }, null, 2);
            if (currentLength + entryStr.length > maxLength) {
                truncated['...'] = `${entries.length - Object.keys(truncated).length} autres propriétés`;
                break;
            }
            truncated[key] = value;
            currentLength += entryStr.length;
        }

        return truncated;
    }
}