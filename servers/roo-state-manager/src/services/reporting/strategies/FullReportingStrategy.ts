/**
 * FullReportingStrategy - Stratégie pour le mode Full avec support Phase 4
 * 
 * MODE FULL selon script PowerShell référence :
 * - Affiche tous les messages intégralement
 * - Contenu complet des outils ET des résultats
 * - Tous les détails techniques visibles  
 * - Table des matières avec liens internes
 * 
 * Phase 4: Support du CSS avancé avec couleurs différenciées
 */

import { BaseReportingStrategy, FormattedMessage } from '../IReportingStrategy.js';
import { ClassifiedContent, EnhancedSummaryOptions } from '../../../types/enhanced-conversation.js';
import { MarkdownFormatterService } from '../../MarkdownFormatterService.js';

export class FullReportingStrategy extends BaseReportingStrategy {
    readonly detailLevel = 'Full';
    readonly description = 'Affichage complet de tous les messages avec tous les détails techniques';

    /**
     * Le mode Full n'est pas "TOC Only" - il affiche tous les contenus
     */
    isTocOnlyMode(): boolean {
        return false;
    }

    /**
     * Formate le contenu complet d'un message avec support Phase 4
     */
    formatMessageContent(
        content: ClassifiedContent, 
        messageIndex: number, 
        options: EnhancedSummaryOptions
    ): FormattedMessage {
        const anchor = this.generateAnchor(content, messageIndex);
        const title = this.generateMessageTitle(content, messageIndex);
        const cssClass = this.getCssClass(content);
        
        // Phase 4: essayer d'utiliser le nouveau formateur si activé
        const advancedFormatted = this.formatWithAdvancedFormatterIfEnabled(content, messageIndex, options);
        if (advancedFormatted) {
            return {
                content: advancedFormatted,
                cssClass: this.getCssClass(content),
                shouldRender: true,
                messageType: this.getMessageType(content),
                anchor,
                metadata: {
                    title,
                    cssClass: 'conversation-section',
                    anchor,
                    shouldDisplay: true,
                    messageType: this.getMessageType(content)
                },
                processingNotes: [`Mode Full Phase 4: formatage avancé utilisé`]
            };
        }
        
        // Comportement classique (fallback)
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
            // Résultats d'outils avec détails complets
            formattedContent.push(this.formatToolResultClassic(content));
        } else if (content.type === 'Assistant') {
            // Messages assistant avec tous les détails techniques
            formattedContent.push(this.formatAssistantMessageClassic(content));
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
                title,
                cssClass,
                anchor,
                shouldDisplay: true,
                messageType: this.getMessageType(content)
            },
            processingNotes: [`Mode Full: contenu complet affiché (classique)`]
        };
    }

    /**
     * Formate un résultat d'outil avec le style classique
     */
    private formatToolResultClassic(content: ClassifiedContent): string {
        const parts: string[] = [];
        
        // Format simplifié pour la compatibilité
        const toolResultMatch = content.content.match(/\[([^\]]+)\] Result:\s*(.*)/s);
        if (toolResultMatch) {
            const toolName = toolResultMatch[1];
            const result = toolResultMatch[2].trim();
            
            parts.push(`**Résultat d'outil :** \`${toolName}\``);
            parts.push('');
            
            // Résultat avec détails (mode Full)
            if (result.length > 1000) {
                parts.push('<details>');
                parts.push('<summary>**Résultat complet** - Cliquez pour afficher</summary>');
                parts.push('');
                parts.push('```');
                parts.push(result);
                parts.push('```');
                parts.push('</details>');
            } else {
                parts.push('```');
                parts.push(result);
                parts.push('```');
            }
        } else {
            parts.push('**Résultat d\'outil**');
            parts.push('');
            parts.push('```');
            parts.push(content.content);
            parts.push('```');
        }
        
        return parts.join('\n');
    }

    /**
     * Formate un message assistant avec le style classique
     */
    private formatAssistantMessageClassic(content: ClassifiedContent): string {
        const parts: string[] = [];
        
        let textContent = content.content;
        const technicalBlocks: Array<{type: string; content: string}> = [];
        
        // Extraction des blocs <thinking> (mode Full les affiche)
        const thinkingMatches = textContent.match(/<thinking>.*?<\/thinking>/gs);
        if (thinkingMatches) {
            thinkingMatches.forEach(match => {
                technicalBlocks.push({type: 'Réflexion', content: match.replace(/<\/?thinking>/g, '')});
                textContent = textContent.replace(match, '');
            });
        }
        
        // Extraction des blocs d'outils XML (mode Full les affiche)
        const toolMatches = textContent.match(/<([a-zA-Z_][a-zA-Z0-9_\-:]+)(?:\s+[^>]*)?>.*?<\/\1>/gs);
        if (toolMatches) {
            toolMatches.forEach(match => {
                const tagMatch = match.match(/<([a-zA-Z_][a-zA-Z0-9_\-:]+)/);
                const tagName = tagMatch ? tagMatch[1] : 'outil';
                technicalBlocks.push({type: `Outil: ${tagName}`, content: match});
                textContent = textContent.replace(match, `\n**[Appel d'outil: ${tagName}]**\n`);
            });
        }
        
        // Contenu principal nettoyé
        const cleanedText = textContent.trim();
        if (cleanedText) {
            parts.push(cleanedText);
            parts.push('');
        }
        
        // Afficher tous les détails techniques en mode Full
        if (technicalBlocks.length > 0) {
            parts.push('**Détails techniques :**');
            parts.push('');
            
            technicalBlocks.forEach(block => {
                parts.push('<details>');
                parts.push(`<summary>${block.type}</summary>`);
                parts.push('');
                parts.push('```');
                parts.push(block.content.trim());
                parts.push('```');
                parts.push('</details>');
                parts.push('');
            });
        }
        
        return parts.join('\n');
    }
}