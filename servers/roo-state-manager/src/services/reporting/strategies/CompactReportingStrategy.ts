/**
 * CompactReportingStrategy - Stratégie pour le mode Compact
 *
 * Nouveau mode introduit pour fix #881:
 * - Affiche les messages conversationnels (user/assistant) de façon complète
 * - Résume les tool calls (nom + statut, pas de params)
 * - Résume les tool results (type + taille, pas le contenu complet)
 * - Garde les réflexions thinking en details collapsibles
 *
 * Ce mode remplace le comportement attendu de "NoTools" qui était trompeur.
 */

import { BaseReportingStrategy, FormattedMessage } from '../IReportingStrategy.js';
import { ClassifiedContent, EnhancedSummaryOptions } from '../../../types/enhanced-conversation.js';

export class CompactReportingStrategy extends BaseReportingStrategy {
    readonly detailLevel = 'Compact';
    readonly description = 'Messages complets avec outils résumés (nom + statut uniquement)';

    /**
     * Le mode Compact n'est pas "TOC Only" - il affiche tous les contenus avec résumé des outils
     */
    isTocOnlyMode(): boolean {
        return false;
    }

    /**
     * Formate le contenu d'un message en résumant les outils
     */
    formatMessageContent(
        content: ClassifiedContent,
        messageIndex: number,
        options: EnhancedSummaryOptions
    ): FormattedMessage {
        const anchor = this.generateAnchor(content, messageIndex);
        const title = this.generateMessageTitle(content, messageIndex);
        const cssClass = this.getCssClass(content);

        // Essayer le formatage avancé Phase 4 si activé
        const advancedFormatted = this.formatWithAdvancedFormatterIfEnabled(
            content, messageIndex, options
        );

        if (advancedFormatted) {
            return {
                content: advancedFormatted,
                cssClass: this.getCssClass(content),
                shouldRender: true,
                messageType: this.getMessageType(content),
                anchor,
                metadata: {
                    messageIndex,
                    contentLength: content.content.length,
                    hasToolDetails: false,
                    title,
                    cssClass,
                    anchor,
                    shouldDisplay: true,
                    messageType: this.getMessageType(content)
                },
                processingNotes: [`Mode Compact: outils résumés (nom + statut)`, 'Phase 4 CSS avancé activé']
            };
        }

        // Formatage classique (fallback)
        let formattedContent: string[] = [];

        // En-tête du message avec ancre
        const firstLine = this.getTruncatedFirstLine(content.content, 200);
        formattedContent.push(`### ${title} - ${firstLine} {#${anchor}}`);
        formattedContent.push('');

        // Div avec classe CSS
        formattedContent.push(`<div class="${cssClass}">`);

        if (content.subType === 'UserMessage') {
            // Messages utilisateur nettoyés mais complets
            const cleanedContent = this.cleanUserMessage(content.content);
            formattedContent.push(cleanedContent);
        } else if (content.subType === 'ToolResult') {
            // Résultats d'outils RÉSUMÉS (pas de contenu complet)
            formattedContent.push(this.formatToolResultSummary(content));
        } else if (content.type === 'Assistant') {
            // Messages assistant avec outils résumés
            formattedContent.push(this.formatAssistantMessageCompact(content));
        } else {
            // Autres types de contenu
            formattedContent.push(content.content);
        }

        formattedContent.push('</div>');
        formattedContent.push('');
        formattedContent.push('<div style="text-align: right; font-size: 0.9em; color: #666;"><a href="#table-des-matieres">^ Table des matières</a></div>');
        formattedContent.push('');

        return {
            content: formattedContent.join('\n'),
            cssClass,
            shouldRender: true,
            messageType: this.getMessageType(content),
            anchor,
            metadata: {
                messageIndex,
                contentLength: content.content.length,
                hasToolDetails: false,
                title,
                cssClass,
                anchor,
                shouldDisplay: true,
                messageType: this.getMessageType(content)
            },
            processingNotes: [`Mode Compact: outils résumés (nom + statut)`]
        };
    }

    /**
     * Formate un résultat d'outil en RÉSUMÉ (pas de contenu complet)
     */
    private formatToolResultSummary(content: ClassifiedContent): string {
        const parts: string[] = [];

        // Extraire le nom de l'outil et le résultat
        const toolResultMatch = content.content.match(/\[([^\]]+)\] Result:\s*(.*)/s);
        if (toolResultMatch) {
            const toolName = toolResultMatch[1];
            const result = toolResultMatch[2].trim();

            // En-tête compact
            const resultType = this.detectResultType(result);
            const resultSize = this.formatContentSize(result.length);
            const success = !result.toLowerCase().includes('error') && !result.toLowerCase().includes('failed');
            const statusIcon = success ? '✅' : '❌';

            parts.push(`**${statusIcon} Outil :** \`\`${toolName}\`\` — ${resultType} (${resultSize})`);

            // Si erreur, afficher un extrait
            if (!success && result.length > 0) {
                const errorPreview = result.substring(0, 200);
                parts.push('');
                parts.push(`> ⚠️ **Erreur:** ${errorPreview}${result.length > 200 ? '...' : ''}`);
            }
        } else {
            // Format de résultat non reconnu - afficher type uniquement
            const size = this.formatContentSize(content.content.length);
            parts.push(`**📦 Résultat d'outil** (${size})`);
        }

        return parts.join('\n');
    }

    /**
     * Formate un message assistant en mode compact
     */
    private formatAssistantMessageCompact(content: ClassifiedContent): string {
        const parts: string[] = [];

        let textContent = content.content;
        const toolCalls: Array<{tag: string; content: string}> = [];
        const thinkingBlocks: string[] = [];

        // Extraction des blocs <thinking>
        const thinkingMatches = textContent.match(/<thinking>.*?<\/thinking>/gs);
        if (thinkingMatches) {
            thinkingMatches.forEach(match => {
                thinkingBlocks.push(match);
                textContent = textContent.replace(match, '');
            });
        }

        // Extraction des blocs d'outils XML
        const toolMatches = textContent.match(/<([a-zA-Z_][a-zA-Z0-9_\-:]+)(?:\s+[^>]*)?>.*?<\/\1>/gs);
        if (toolMatches) {
            toolMatches.forEach(match => {
                const tagMatch = match.match(/<([a-zA-Z_][a-zA-Z0-9_\-:]+)/);
                const tagName = tagMatch ? tagMatch[1] : 'outil';
                if (tagName !== 'thinking') {
                    toolCalls.push({tag: tagName, content: match});
                    textContent = textContent.replace(match, '');
                }
            });
        }

        textContent = textContent.trim();

        // Affichage du contenu textuel principal
        if (textContent) {
            parts.push(textContent);
            parts.push('');
        }

        // Liste compacte des appels d'outils
        if (toolCalls.length > 0) {
            parts.push(`**🔧 Outils appelés (${toolCalls.length}) :**`);
            toolCalls.forEach(call => {
                parts.push(`- \`\`${call.tag}\`\``);
            });
            parts.push('');
        }

        // Réflexions en details (compact)
        if (thinkingBlocks.length > 0) {
            parts.push('<details>');
            parts.push(`<summary>💭 Réflexions (${thinkingBlocks.length})</summary>`);
            parts.push('');
            thinkingBlocks.forEach((block, i) => {
                // Extraire le contenu sans les balises
                const content = block.replace(/<\/?thinking>/g, '').trim();
                const preview = content.substring(0, 300);
                parts.push(`**Réflexion ${i + 1}:** ${preview}${content.length > 300 ? '...' : ''}`);
            });
            parts.push('</details>');
            parts.push('');
        }

        return parts.join('\n');
    }

    /**
     * Détecte le type de résultat d'outil
     */
    private detectResultType(result: string): string {
        if (result.includes('<files>')) return 'Liste fichiers';
        if (result.includes('<file_write_result>')) return 'Écriture fichier';
        if (result.includes('Command executed')) return 'Exécution commande';
        if (result.includes('Browser') && result.includes('action')) return 'Navigation web';
        if (result.includes('<environment_details>')) return 'Détails environnement';
        if (result.match(/error|failed|unable/i)) return 'Erreur';
        if (result.includes('Todo list updated')) return 'Mise à jour todo';
        return 'Résultat';
    }

    /**
     * Formate une taille de contenu de façon lisible
     */
    private formatContentSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
        return `${Math.round(bytes / (1024 * 1024) * 10) / 10} MB`;
    }

    // Les méthodes generateMessageTitle, getCssClass, generateAnchor et getMessageType
    // sont héritées de BaseReportingStrategy
}
