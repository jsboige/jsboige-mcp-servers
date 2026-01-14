/**
 * NoResultsReportingStrategy - Stratégie pour le mode NoResults
 * 
 * MODE NORESULTS selon script PowerShell référence :
 * - Affiche tous les messages avec paramètres d'outils complets
 * - Masque SEULEMENT les contenus des résultats d'outils
 * - Garde les paramètres et réflexions techniques
 * - Table des matières avec liens internes
 */

import { BaseReportingStrategy, FormattedMessage } from '../IReportingStrategy.js';
import { ClassifiedContent, EnhancedSummaryOptions } from '../../../types/enhanced-conversation.js';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { StateManagerError } from '../../../types/errors.js';

export class NoResultsReportingStrategy extends BaseReportingStrategy {
    readonly detailLevel = 'NoResults';
    readonly description = 'Messages complets avec paramètres d\'outils mais résultats masqués';

    /**
     * Le mode NoResults n'est pas "TOC Only" - il affiche tous les contenus avec filtrage
     */
    isTocOnlyMode(): boolean {
        return false;
    }

    /**
     * Formate le contenu d'un message en masquant SEULEMENT les contenus des résultats
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
                processingNotes: [`Mode NoResults: paramètres outils complets, résultats masqués`, 'Phase 4 CSS avancé activé']
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
            // Résultats d'outils avec contenu masqué (mode NoResults)
            formattedContent.push(this.formatToolResult(content));
        } else if (content.type === 'Assistant') {
            // Messages assistant avec paramètres d'outils complets
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
            processingNotes: [`Mode NoResults: paramètres outils complets, résultats masqués`]
        };
    }

    /**
     * Formate un résultat d'outil avec contenu MASQUÉ (mode NoResults)
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
            
            // Contexte avant le résultat (s'il existe) - GARDÉ en mode NoResults
            const beforeResult = content.content.substring(0, content.content.indexOf('[' + toolName + '] Result:'));
            if (beforeResult.trim()) {
                const cleanedBefore = this.cleanUserMessage(beforeResult);
                parts.push('**Contexte :**');
                parts.push(cleanedBefore);
                parts.push('');
            }
            
            // Résultat MASQUÉ (mode NoResults cache les contenus des résultats)
            if (result) {
                const resultType = this.detectResultType(result);
                parts.push('<details>');
                parts.push(`<summary>**${resultType} :** [Contenu masqué en mode NoResults]</summary>`);
                parts.push('');
                parts.push('*Contenu des résultats masqué - utilisez -DetailLevel Full pour afficher*');
                parts.push('</details>');
            }
        } else {
            // Format de résultat non reconnu - masquer le contenu
            parts.push('**Résultat d\'outil**');
            parts.push('');
            parts.push('<details>');
            parts.push('<summary>[Contenu masqué en mode NoResults]</summary>');
            parts.push('');
            parts.push('*Contenu des résultats masqué - utilisez -DetailLevel Full pour afficher*');
            parts.push('</details>');
        }
        
        return parts.join('\n');
    }

    /**
     * Formate un message assistant avec paramètres d'outils COMPLETS
     */
    private formatAssistantMessage(content: ClassifiedContent): string {
        const parts: string[] = [];
        
        let textContent = content.content;
        const technicalBlocks: Array<{type: string; content: string; tag?: string}> = [];
        
        // Extraction des blocs <thinking> (gardés complets en mode NoResults)
        const thinkingMatches = textContent.match(/<thinking>.*?<\/thinking>/gs);
        if (thinkingMatches) {
            thinkingMatches.forEach(match => {
                technicalBlocks.push({type: 'Reflexion', content: match});
                textContent = textContent.replace(match, '');
            });
        }
        
        // Extraction des blocs d'outils XML (gardés complets en mode NoResults)
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
        
        // Traitement des blocs techniques selon mode NoResults
        technicalBlocks.forEach(block => {
            if (block.type === 'Outil' && block.tag) {
                // Mode NoResults : affichage COMPLET des paramètres d'outils
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
     * Formate un bloc XML d'outil avec parsing sophistiqué (complet en mode NoResults)
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
                throw new StateManagerError(
                    'Erreur de parsing XML',
                    'XML_PARSE_ERROR',
                    'NoResultsReportingStrategy',
                    { method: 'processXmlContent' }
                );
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
    private getAllXmlElements(node: any): any[] {
        const elements: any[] = [];
        
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

    // Les méthodes generateMessageTitle, getCssClass, generateAnchor et getMessageType
    // sont maintenant héritées de BaseReportingStrategy
}