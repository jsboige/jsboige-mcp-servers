/**
 * MessagesReportingStrategy - Stratégie pour le mode Messages
 * 
 * MODE MESSAGES selon script PowerShell référence :
 * - Affiche tous les messages avec métadonnées d'outils
 * - Masque les paramètres lourds des appels d'outils
 * - Garde les résultats d'outils et les réflexions techniques
 * - Table des matières avec liens internes
 */

import { BaseReportingStrategy, FormattedMessage } from '../IReportingStrategy.js';
import { ClassifiedContent, EnhancedSummaryOptions } from '../../../types/enhanced-conversation.js';

export class MessagesReportingStrategy extends BaseReportingStrategy {
    readonly detailLevel = 'Messages';
    readonly description = 'Messages avec métadonnées d\'outils mais paramètres masqués';

    /**
     * Le mode Messages n'est pas "TOC Only" - il affiche tous les contenus avec filtrage
     */
    isTocOnlyMode(): boolean {
        return false;
    }

    /**
     * Formate le contenu d'un message en masquant les paramètres d'outils
     */
    formatMessageContent(
        content: ClassifiedContent, 
        messageIndex: number, 
        options: EnhancedSummaryOptions
    ): FormattedMessage {
        const anchor = this.generateAnchor(content, messageIndex);
        const title = this.generateMessageTitle(content, messageIndex);
        const cssClass = this.getCssClass(content);
        
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
            // Résultats d'outils avec détails complets (pas masqués en mode Messages)
            formattedContent.push(this.formatToolResult(content));
        } else if (content.type === 'Assistant') {
            // Messages assistant avec paramètres d'outils masqués
            formattedContent.push(this.formatAssistantMessage(content));
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
            metadata: {
                title,
                cssClass,
                anchor,
                shouldDisplay: true,
                messageType: this.getMessageType(content)
            },
            processingNotes: [`Mode Messages: paramètres outils masqués`]
        };
    }

    /**
     * Formate un résultat d'outil avec tous les détails (pas masqués en mode Messages)
     */
    private formatToolResult(content: ClassifiedContent): string {
        const parts: string[] = [];
        
        // Extraire le nom de l'outil et le résultat
        const toolResultMatch = content.content.match(/\[([^\]]+)\] Result:\s*(.*)/s);
        if (toolResultMatch) {
            const toolName = toolResultMatch[1];
            const result = toolResultMatch[2].trim();
            
            parts.push(`**Résultat d'outil :** \`\`${toolName}\`\``);
            parts.push('');
            
            // Contexte avant le résultat (s'il existe)
            const beforeResult = content.content.substring(0, content.content.indexOf('[' + toolName + '] Result:'));
            if (beforeResult.trim()) {
                const cleanedBefore = this.cleanUserMessage(beforeResult);
                parts.push('**Contexte :**');
                parts.push(cleanedBefore);
                parts.push('');
            }
            
            // Résultat complet avec tous les détails (mode Messages garde les résultats)
            if (result) {
                const resultType = this.detectResultType(result);
                parts.push('<details>');
                parts.push(`<summary>**${resultType} :** Cliquez pour afficher</summary>`);
                parts.push('');
                parts.push('```');
                parts.push(result);
                parts.push('```');
                parts.push('</details>');
            }
        } else {
            // Format de résultat non reconnu - afficher tel quel
            parts.push('**Résultat d\'outil**');
            parts.push('');
            parts.push('```');
            parts.push(content.content);
            parts.push('```');
        }
        
        return parts.join('\n');
    }

    /**
     * Formate un message assistant en masquant SEULEMENT les paramètres d'outils
     */
    private formatAssistantMessage(content: ClassifiedContent): string {
        const parts: string[] = [];
        
        let textContent = content.content;
        const technicalBlocks: Array<{type: string; content: string; tag?: string}> = [];
        
        // Extraction des blocs <thinking> (gardés en mode Messages)
        const thinkingMatches = textContent.match(/<thinking>.*?<\/thinking>/gs);
        if (thinkingMatches) {
            thinkingMatches.forEach(match => {
                technicalBlocks.push({type: 'Reflexion', content: match});
                textContent = textContent.replace(match, '');
            });
        }
        
        // Extraction des blocs d'outils XML (paramètres masqués)
        const toolMatches = textContent.match(/<([a-zA-Z_][a-zA-Z0-9_\-:]+)(?:\s+[^>]*)?>.*?<\/\1>/gs);
        if (toolMatches) {
            toolMatches.forEach(match => {
                const tagMatch = match.match(/<([a-zA-Z_][a-zA-Z0-9_\-:]+)/);
                const tagName = tagMatch ? tagMatch[1] : 'outil';
                if (tagName !== 'thinking') {
                    technicalBlocks.push({type: 'Outil', content: match, tag: tagName});
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
        
        // Traitement des blocs techniques selon mode Messages
        technicalBlocks.forEach(block => {
            if (block.type === 'Outil' && block.tag) {
                // Mode Messages : masquer les paramètres d'outils mais garder les sections collapsibles
                parts.push('<details>');
                parts.push(`<summary>OUTIL - ${block.tag} [Paramètres masqués en mode Messages]</summary>`);
                parts.push('');
                parts.push('*Contenu des paramètres d\'outil masqué - utilisez -DetailLevel Full pour afficher*');
                parts.push('</details>');
            } else {
                // Réflexions et autres détails techniques : affichés complets
                parts.push('<details>');
                parts.push(`<summary>DETAILS TECHNIQUE - ${block.type}</summary>`);
                parts.push('');
                parts.push('```xml');
                parts.push(block.content);
                parts.push('```');
                parts.push('</details>');
            }
            parts.push('');
        });
        
        return parts.join('\n');
    }

    /**
     * Détecte le type de résultat d'outil
     */
    private detectResultType(result: string): string {
        if (result.includes('<files>')) return 'fichiers';
        if (result.includes('<file_write_result>')) return 'écriture fichier';
        if (result.includes('Command executed')) return 'exécution commande';
        if (result.includes('Browser') && result.includes('action')) return 'navigation web';
        if (result.includes('<environment_details>')) return 'détails environnement';
        if (result.match(/error|failed|unable/i)) return 'erreur';
        if (result.includes('Todo list updated')) return 'mise à jour todo';
        return 'résultat';
    }

    /**
     * Génère le titre d'un message
     */
    private generateMessageTitle(content: ClassifiedContent, messageIndex: number): string {
        if (content.subType === 'UserMessage') {
            return messageIndex === 0 ? 'INSTRUCTION DE TACHE INITIALE' : `MESSAGE UTILISATEUR #${messageIndex}`;
        } else if (content.subType === 'ToolResult') {
            return `RESULTAT OUTIL #${messageIndex}`;
        } else if (content.type === 'Assistant') {
            return content.subType === 'Completion' ? 
                `REPONSE ASSISTANT #${messageIndex} (Terminaison)` :
                `REPONSE ASSISTANT #${messageIndex}`;
        }
        return `MESSAGE #${messageIndex}`;
    }

    /**
     * Détermine la classe CSS selon le type de contenu
     */
    private getCssClass(content: ClassifiedContent): string {
        if (content.subType === 'UserMessage') return 'user-message';
        if (content.subType === 'ToolResult') return 'tool-message';
        if (content.subType === 'Completion') return 'completion-message';
        if (content.type === 'Assistant') return 'assistant-message';
        return 'message';
    }

    /**
     * Génère l'ancre pour un message
     */
    private generateAnchor(content: ClassifiedContent, messageIndex: number): string {
        if (content.subType === 'UserMessage') {
            return messageIndex === 0 ? 'instruction-de-tache-initiale' : `message-utilisateur-${messageIndex}`;
        } else if (content.subType === 'ToolResult') {
            return `outil-${messageIndex}`;
        } else if (content.type === 'Assistant') {
            return `reponse-assistant-${messageIndex}`;
        }
        return `message-${messageIndex}`;
    }

    /**
     * Détermine le type de message pour les métadonnées
     */
    private getMessageType(content: ClassifiedContent): 'user' | 'assistant' | 'tool' | 'completion' {
        if (content.subType === 'UserMessage') return 'user';
        if (content.subType === 'ToolResult') return 'tool';
        if (content.subType === 'Completion') return 'completion';
        if (content.type === 'Assistant') return 'assistant';
        return 'user';
    }
}