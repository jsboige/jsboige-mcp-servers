/**
 * FullReportingStrategy - Stratégie pour le mode Full
 * 
 * MODE FULL selon script PowerShell référence :
 * - Affiche tous les messages intégralement
 * - Contenu complet des outils ET des résultats
 * - Tous les détails techniques visibles  
 * - Table des matières avec liens internes
 */

import { BaseReportingStrategy, FormattedMessage } from '../IReportingStrategy.js';
import { ClassifiedContent, EnhancedSummaryOptions } from '../../../types/enhanced-conversation.js';

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
     * Formate le contenu complet d'un message (sans masquer quoi que ce soit)
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
            // Résultats d'outils avec détails complets
            formattedContent.push(this.formatToolResult(content));
        } else if (content.type === 'Assistant') {
            // Messages assistant avec tous les détails techniques
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
            processingNotes: [`Mode Full: contenu complet affiché`]
        };
    }

    /**
     * Formate un résultat d'outil avec tous les détails
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
            
            // Résultat complet avec tous les détails
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
     * Formate un message assistant avec tous les détails techniques
     */
    private formatAssistantMessage(content: ClassifiedContent): string {
        const parts: string[] = [];
        
        let textContent = content.content;
        const technicalBlocks: Array<{type: string; content: string; tag?: string}> = [];
        
        // Extraction des blocs <thinking>
        const thinkingMatches = textContent.match(/<thinking>.*?<\/thinking>/gs);
        if (thinkingMatches) {
            thinkingMatches.forEach(match => {
                technicalBlocks.push({type: 'Reflexion', content: match});
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
        
        // Affichage complet de tous les blocs techniques (mode Full)
        technicalBlocks.forEach(block => {
            if (block.type === 'Outil' && block.tag) {
                // Parsing XML sophistiqué pour les outils
                try {
                    parts.push(this.formatXmlToolBlock(block.content, block.tag));
                } catch (error) {
                    // Fallback en cas d'erreur XML
                    parts.push('<details>');
                    parts.push(`<summary>OUTIL - ${block.tag} [Erreur parsing]</summary>`);
                    parts.push('');
                    parts.push('```xml');
                    parts.push(block.content);
                    parts.push('```');
                    parts.push('</details>');
                }
            } else {
                // Traitement classique pour les autres types
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
     * Formate un bloc XML d'outil avec parsing sophistiqué
     */
    private formatXmlToolBlock(xmlContent: string, tagName: string): string {
        const parts: string[] = [];
        
        parts.push('<details>');
        parts.push(`<summary>OUTIL - ${tagName}</summary>`);
        parts.push('');
        parts.push('*Voir sections détaillées ci-dessous*');
        parts.push('</details>');
        
        // Parsing XML et création de sections séquentielles
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xmlContent, 'text/xml');
            const rootElement = doc.documentElement;
            
            if (!rootElement || rootElement.tagName === 'parsererror') {
                throw new Error('Erreur de parsing XML');
            }
            
            // Extraire tous les éléments enfants
            const allElements = this.getAllXmlElements(rootElement);
            
            // Créer des sections séquentielles au même niveau
            allElements.forEach(element => {
                parts.push('<details>');
                parts.push(`<summary>${element.tagName}</summary>`);
                parts.push('');
                parts.push('```xml');
                parts.push(new XMLSerializer().serializeToString(element));
                parts.push('```');
                parts.push('</details>');
            });
            
        } catch (error) {
            // Fallback simple en cas d'erreur
            parts.push('<details>');
            parts.push(`<summary>OUTIL - ${tagName} [Format simple]</summary>`);
            parts.push('');
            parts.push('```xml');
            parts.push(xmlContent);
            parts.push('```');
            parts.push('</details>');
        }
        
        return parts.join('\n');
    }

    /**
     * Extrait tous les éléments XML récursivement
     */
    private getAllXmlElements(node: Element): Element[] {
        const elements: Element[] = [];
        
        for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i];
            elements.push(child);
            
            // Récursivement extraire les enfants
            if (child.children.length > 0) {
                elements.push(...this.getAllXmlElements(child));
            }
        }
        
        return elements;
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