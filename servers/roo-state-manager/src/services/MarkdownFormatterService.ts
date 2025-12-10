/**
 * MarkdownFormatterService - Service de formatage Markdown avancé avec CSS Phase 4
 * 
 * SDDD Phase 4: CSS Avancé et Couleurs Différenciées
 * 
 * Système de couleurs spécifique Phase 4 :
 * - Messages utilisateur : Bleu (#2563eb)
 * - Messages assistant : Vert (#059669)
 * - Appels d'outils : Orange (#ea580c)
 * - Résultats d'outils : Violet (#7c3aed)
 * - Métadonnées/contexte : Gris (#6b7280)
 * - Erreurs/warnings : Rouge (#dc2626)
 */

import {
    ClassifiedContent,
    EnhancedSummaryOptions,
    TruncationOptions,
    InteractiveToCSOptions,
    MessageCounters
} from '../types/enhanced-conversation.js';

import { MarkdownRenderer } from './markdown-formatter/MarkdownRenderer.js';
import { InteractiveFormatter } from './markdown-formatter/InteractiveFormatter.js';
import { CSSGenerator } from './markdown-formatter/CSSGenerator.js';
import { TruncationEngine } from './markdown-formatter/TruncationEngine.js';

export interface AdvancedFormattingOptions {
    enableAdvancedCSS: boolean;
    responsiveDesign: boolean;
    syntaxHighlighting: boolean;
    animationsEnabled: boolean;
    compactMode: boolean;
}

export class MarkdownFormatterService {
    // Délégation vers CSSGenerator
    private static readonly CSS_THEME_COLORS = {
        userMessage: '#2563eb',
        assistantMessage: '#059669',
        toolCall: '#ea580c',
        toolResult: '#7c3aed',
        metadata: '#6b7280',
        error: '#dc2626',
        background: {
            userMessage: '#dbeafe',
            assistantMessage: '#dcfce7',
            toolCall: '#fed7aa',
            toolResult: '#e9d5ff',
            metadata: '#f3f4f6',
            error: '#fee2e2'
        },
        primary: '#1f2937',
        secondary: '#374151',
        accent: '#3b82f6',
        success: '#10b981',
        warning: '#f59e0b',
        danger: '#ef4444'
    };

    /**
     * Génère le CSS complet intégré pour la Phase 4
     */
    static generateCSS(options: AdvancedFormattingOptions = {
        enableAdvancedCSS: true,
        responsiveDesign: true,
        syntaxHighlighting: true,
        animationsEnabled: true,
        compactMode: false
    }): string {
        return CSSGenerator.generateCSS(options);
    }

    /**
     * Formate un message utilisateur avec le style Phase 4
     */
    static formatUserMessage(content: string, timestamp?: string): string {
        return MarkdownRenderer.formatUserMessage(content, timestamp);
    }

    /**
     * Formate un message assistant avec le style Phase 4
     */
    static formatAssistantMessage(content: string, timestamp?: string): string {
        return MarkdownRenderer.formatAssistantMessage(content, timestamp);
    }

    /**
     * Formate un appel d'outil avec le style Phase 4
     */
    static formatToolCall(toolName: string, parameters: any, timestamp?: string): string {
        return MarkdownRenderer.formatToolCall(toolName, parameters, timestamp);
    }

    /**
     * Formate un résultat d'outil avec le style Phase 4
     */
    static formatToolResult(toolName: string, result: any, timestamp?: string): string {
        return MarkdownRenderer.formatToolResult(toolName, result, timestamp);
    }

    /**
     * Génère l'en-tête de conversation avec métadonnées
     */
    static formatConversationHeader(metadata: {
        taskId: string;
        title?: string;
        createdAt?: string;
        messageCount?: number;
        totalSize?: string;
    }): string {
        return MarkdownRenderer.formatConversationHeader(metadata);
    }

    /**
     * Génère un séparateur visuel entre sections
     */
    static formatSectionSeparator(title: string, color: string): string {
        return MarkdownRenderer.formatSectionSeparator(title, color);
    }

    /**
     * Formate un tableau de métadonnées
     */
    static formatMetadataTable(data: Record<string, any>): string {
        return MarkdownRenderer.formatMetadataTable(data);
    }

    /**
     * Formate un tableau de paramètres d'outil
     */
    static formatToolParametersTable(params: any): string {
        return MarkdownRenderer.formatToolParametersTable(params);
    }

    // ===========================
    // PHASE 5: FONCTIONNALITÉS INTERACTIVES
    // ===========================

    /**
     * Génère une table des matières interactive avec compteurs visuels
     */
    static generateTableOfContents(messages: ClassifiedContent[], options?: InteractiveToCSOptions): string {
        return InteractiveFormatter.generateTableOfContents(messages, options);
    }

    /**
     * Génère les ancres de navigation pour un message
     */
    static generateNavigationAnchors(messageIndex: number, messageType: string): string {
        return InteractiveFormatter.generateNavigationAnchors(messageIndex, messageType);
    }

    /**
     * Calcule les compteurs de messages par type
     */
    static generateMessageCounters(messages: ClassifiedContent[]): MessageCounters {
        return InteractiveFormatter.generateMessageCounters(messages);
    }

    /**
     * Troncature intelligente des paramètres d'outils
     */
    static truncateToolParameters(params: any, options?: TruncationOptions): { content: string, wasTruncated: boolean } {
        return TruncationEngine.truncateToolParameters(params, options);
    }

    /**
     * Troncature intelligente des résultats d'outils
     */
    static truncateToolResult(result: any, options?: TruncationOptions): { content: string, wasTruncated: boolean } {
        return TruncationEngine.truncateToolResult(result, options);
    }

    /**
     * Génère un bouton toggle pour le contenu tronqué
     */
    static generateTruncationToggle(fullContent: string, truncatedContent: string, elementId: string): string {
        return TruncationEngine.generateTruncationToggle(fullContent, truncatedContent, elementId);
    }

    /**
     * Génère le contenu expandable avec preview
     */
    static generateExpandableContent(content: string, summary: string, elementId: string): string {
        return TruncationEngine.generateExpandableContent(content, summary, elementId);
    }

    /**
     * Génère le script JavaScript interactif Phase 5
     */
    static generateInteractiveScript(): string {
        return InteractiveFormatter.generateInteractiveScript();
    }

    // ===========================
    // MÉTHODES UTILITAIRES PHASE 5
    // ===========================

    /**
     * Retourne l'icône appropriée pour un type de message
     * @deprecated Use InteractiveFormatter internal logic instead
     */
    private static getTypeIcon(type: string): string {
        switch (type) {
            case 'user': return '🔵';
            case 'assistant': return '🟢';
            case 'tool_call': return '🟠';
            case 'tool_result': return '🟣';
            case 'metadata': return '⚫';
            case 'error': return '🔴';
            default: return '⚪';
        }
    }

    /**
     * Retourne la couleur appropriée pour un type de message
     * @deprecated Use CSSGenerator.getTypeColor instead
     */
    private static getTypeColor(type: string): string {
        return CSSGenerator.getTypeColor(type);
    }

    /**
     * Retourne le label approprié pour un type de message
     * @deprecated Use InteractiveFormatter internal logic instead
     */
    private static getTypeLabel(type: string): string {
        switch (type) {
            case 'user': return 'Utilisateur';
            case 'assistant': return 'Assistant';
            case 'tool_call': return 'Appel Outil';
            case 'tool_result': return 'Résultat Outil';
            case 'metadata': return 'Métadonnées';
            case 'error': return 'Erreur';
            default: return 'Inconnu';
        }
    }

    /**
     * Troncature intelligente d'objet JSON
     * @deprecated Use TruncationEngine internal logic instead
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

    /**
     * Génère le CSS additionnel pour les fonctionnalités Phase 5
     */
    static generateInteractiveCSS(): string {
        return CSSGenerator.generateInteractiveCSS();
    }
}