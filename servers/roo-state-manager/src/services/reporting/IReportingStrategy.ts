/**
 * IReportingStrategy - Interface pour les stratégies de formatage de contenu
 * 
 * ARCHITECTURE CORRIGÉE selon script PowerShell référence :
 * - Tous les messages sont TOUJOURS inclus (pas de filtrage de messages)  
 * - Les stratégies contrôlent le FORMAT/CONTENU de chaque message
 * - Summary génère table des matières avec liens externes + instruction seulement
 * 
 * Niveaux de détail selon Convert-TraceToSummary.ps1 :
 * - Summary : TOC + instruction initiale seulement, liens vers fichier source
 * - Messages : Tous messages + masque paramètres outils 
 * - NoTools : Tous messages + masque paramètres outils seulement
 * - NoResults : Tous messages + masque contenu résultats seulement
 * - Full : Tous messages avec contenu intégral
 */

import { ClassifiedContent, EnhancedSummaryOptions } from '../../types/enhanced-conversation.js';
import { MarkdownFormatterService, AdvancedFormattingOptions } from '../MarkdownFormatterService.js';

/**
 * Interface principale pour les stratégies de reporting
 */
export interface IReportingStrategy {
    /**
     * Niveau de détail géré par cette stratégie
     */
    readonly detailLevel: string;
    
    /**
     * Description de la stratégie
     */
    readonly description: string;
    
    /**
     * Indique si cette stratégie génère seulement une table des matières
     * (true pour Summary, false pour les autres)
     */
    isTocOnlyMode(): boolean;
    
    /**
     * Génère la table des matières pour cette stratégie
     * @param contents - Tous les contenus classifiés
     * @param options - Options de configuration
     * @param sourceFilePath - Chemin du fichier source (pour liens externes en mode Summary)
     * @returns HTML/Markdown de la table des matières
     */
    generateTableOfContents(
        contents: ClassifiedContent[], 
        options: EnhancedSummaryOptions,
        sourceFilePath?: string
    ): string;
    
    /**
     * Formate le contenu d'un message selon la stratégie
     * @param content - Contenu classifié à formater
     * @param messageIndex - Index du message dans la conversation
     * @param options - Options de configuration
     * @returns Contenu formaté avec métadonnées
     */
    formatMessageContent(
        content: ClassifiedContent, 
        messageIndex: number, 
        options: EnhancedSummaryOptions
    ): FormattedMessage;
    
    /**
     * Génère la vue d'ensemble de la stratégie
     * @param contents - Tous les contenus classifiés
     * @param options - Options de configuration
     * @returns Vue d'ensemble formatée
     */
    generateOverview(contents: ClassifiedContent[], options: EnhancedSummaryOptions): string;
    
    /**
     * Génère le rapport complet pour cette stratégie
     * @param contents - Tous les contenus classifiés
     * @param options - Options de configuration
     * @returns Rapport complet formaté
     */
    generateReport(contents: ClassifiedContent[], options: EnhancedSummaryOptions): string;
}

/**
 * Structure pour un message formaté
 */
export interface FormattedMessage {
    content: string;
    cssClass: string;
    shouldRender: boolean;
    messageType: string;
    timestamp?: string;
    anchor?: string;
    processingNotes?: string[];
    metadata?: {
        messageIndex?: number;
        contentLength?: number;
        hasToolDetails?: boolean;
        title?: string;
        cssClass?: string;
        anchor?: string;
        shouldDisplay?: boolean;
        messageType?: string;
    };
}

/**
 * Classe de base abstraite pour toutes les stratégies de reporting
 * Implémente la logique commune et les méthodes utilitaires
 */
export abstract class BaseReportingStrategy implements IReportingStrategy {
    public abstract readonly detailLevel: string;
    public abstract readonly description: string;
    
    /**
     * Par défaut, les stratégies ne sont pas en mode TOC uniquement
     * (sauf SummaryReportingStrategy qui override cette méthode)
     */
    public isTocOnlyMode(): boolean {
        return false;
    }
    
    /**
     * Génère la table des matières par défaut
     */
    public generateTableOfContents(
        contents: ClassifiedContent[], 
        options: EnhancedSummaryOptions,
        sourceFilePath?: string
    ): string {
        const toc: string[] = [];
        // Cible des back-links "^ Table des matières" générés par les stratégies (#756)
        toc.push('## <a id="table-des-matieres"></a>TABLE DES MATIÈRES');
        toc.push('');

        let userMessageCounter = 0;
        let toolResultCounter = 0;
        let assistantMessageCounter = 0;
        
        for (const content of contents) {
            const firstLine = this.getTruncatedFirstLine(content.content, 200);
            
            if (content.subType === 'UserMessage') {
                userMessageCounter++;
                if (sourceFilePath && this.isTocOnlyMode()) {
                    // Mode Summary avec liens externes vers le fichier source
                    toc.push(`- <a href="${sourceFilePath}#L${this.estimateLineNumber(content)}" class="toc-user">**MESSAGE UTILISATEUR #${userMessageCounter}** - ${firstLine}</a>`);
                } else {
                    // Mode standard avec ancres internes
                    toc.push(`- <a href="#${this.generateAnchor(content, userMessageCounter)}" class="toc-user">**MESSAGE UTILISATEUR #${userMessageCounter}** - ${firstLine}</a>`);
                }
            } else if (content.subType === 'ToolResult') {
                toolResultCounter++;
                if (sourceFilePath && this.isTocOnlyMode()) {
                    toc.push(`- <a href="${sourceFilePath}#L${this.estimateLineNumber(content)}" class="toc-tool">**OUTIL #${toolResultCounter}** - ${firstLine}</a>`);
                } else {
                    toc.push(`- <a href="#${this.generateAnchor(content, toolResultCounter)}" class="toc-tool">**RÉSULTAT OUTIL #${toolResultCounter}** - ${firstLine}</a>`);
                }
            } else if (content.type === 'Assistant') {
                assistantMessageCounter++;
                const hasTools = content.content.includes('<') || content.toolCallDetails;
                const label = hasTools ? `MESSAGE ASSISTANT + OUTILS #${assistantMessageCounter}` : `MESSAGE ASSISTANT #${assistantMessageCounter}`;
                
                if (sourceFilePath && this.isTocOnlyMode()) {
                    toc.push(`- <a href="${sourceFilePath}#L${this.estimateLineNumber(content)}" class="toc-assistant">**${label}** - ${firstLine}</a>`);
                } else {
                    toc.push(`- <a href="#${this.generateAnchor(content, assistantMessageCounter)}" class="toc-assistant">**${label}** - ${firstLine}</a>`);
                }
            }
        }
        
        return toc.join('\n');
    }
    
    /**
     * Méthodes abstraites à implémenter par les classes concrètes
     */
    public abstract formatMessageContent(
        content: ClassifiedContent, 
        messageIndex: number, 
        options: EnhancedSummaryOptions
    ): FormattedMessage;
    
    /**
     * Génère une vue d'ensemble par défaut
     */
    public generateOverview(contents: ClassifiedContent[], options: EnhancedSummaryOptions): string {
        const report: string[] = [];
        
        // Titre avec niveau de détail
        report.push(`# RÉSUMÉ DE TRACE - ${this.detailLevel.toUpperCase()}`);
        report.push('');
        report.push(`**Stratégie:** ${this.description}`);
        report.push('');
        
        // Statistiques
        report.push(this.generateStatistics(contents));
        report.push('');
        
        // Table des matières
        report.push(this.generateTableOfContents(contents, options));
        report.push('');
        
        // Pour le mode Summary, n'afficher que l'instruction initiale
        if (this.isTocOnlyMode()) {
            const firstUserMessage = contents.find(c => c.subType === 'UserMessage');
            if (firstUserMessage) {
                report.push('## INSTRUCTION INITIALE');
                report.push('');
                report.push(this.cleanUserMessage(firstUserMessage.content));
                report.push('');
            }
        }
        
        return report.join('\n');
    }

    /**
     * Génère le rapport complet par défaut
     */
    public generateReport(contents: ClassifiedContent[], options: EnhancedSummaryOptions): string {
        const report: string[] = [];
        
        // CSS avancé si activé
        if (this.shouldUseAdvancedCSS(options)) {
            report.push(MarkdownFormatterService.generateCSS());
            report.push('');
        }
        
        // Vue d'ensemble
        report.push(this.generateOverview(contents, options));
        
        // Messages formatés (si pas en mode TOC uniquement)
        if (!this.isTocOnlyMode()) {
            report.push('---');
            report.push('');
            report.push('## MESSAGES');
            report.push('');

            // Compteurs par type alignés sur generateTableOfContents (#756) :
            // l'ancre générée ici doit être identique à celle liée par la TOC
            const counters = { user: 0, toolResult: 0, assistant: 0 };
            let fallbackIndex = 0;
            contents.forEach((content) => {
                let index: number;
                if (content.subType === 'UserMessage') {
                    counters.user++;
                    index = counters.user;
                } else if (content.subType === 'ToolResult') {
                    counters.toolResult++;
                    index = counters.toolResult;
                } else if (content.type === 'Assistant') {
                    counters.assistant++;
                    index = counters.assistant;
                } else {
                    fallbackIndex++;
                    index = fallbackIndex;
                }
                const formatted = this.formatMessageContent(content, index, options);
                if (formatted.shouldRender) {
                    report.push(formatted.content);
                    report.push('');
                }
            });
        }
        
        return report.join('\n');
    }
    
    /**
     * Vérifie si le CSS avancé doit être utilisé
     */
    protected shouldUseAdvancedCSS(options: EnhancedSummaryOptions): boolean {
        return options.enhancementFlags?.enableAdvancedCSS === true;
    }
    
    /**
     * Génère l'ancre pour les liens internes
     */
    protected generateAnchor(content: ClassifiedContent, counter: number): string {
        const type = content.subType || content.type?.toLowerCase() || 'content';
        return `${type}-${counter}`;
    }
    
    /**
     * Obtient la classe CSS appropriée pour un type de contenu
     */
    protected getCssClass(content: ClassifiedContent): string {
        if (content.subType === 'UserMessage') return 'user-message';
        if (content.subType === 'ToolResult') return 'tool-result';
        if (content.subType === 'ToolCall') return 'tool-call';
        if (content.type === 'Assistant') return 'assistant-message';
        return 'default-message';
    }
    
    /**
     * Détermine le type de message pour l'affichage
     */
    protected getMessageType(content: ClassifiedContent): string {
        if (content.subType === 'UserMessage') return 'MESSAGE UTILISATEUR';
        if (content.subType === 'ToolResult') return 'RÉSULTAT OUTIL';
        if (content.subType === 'ToolCall') return 'APPEL OUTIL';
        if (content.type === 'Assistant') {
            const hasTools = content.content.includes('<') || content.toolCallDetails;
            return hasTools ? 'ASSISTANT + OUTILS' : 'ASSISTANT';
        }
        return 'MESSAGE';
    }
    
    /**
     * Extrait le type de résultat d'outil
     */
    protected getToolResultType(result: string): string {
        if (result.includes('success":true') || result.includes('"operation":"created"')) {
            return 'Succès';
        } else if (result.includes('Error') || result.includes('error') || result.includes('failed')) {
            return 'Erreur';
        } else if (result.includes('<html>') || result.includes('<!DOCTYPE')) {
            return 'HTML';
        } else if (result.includes('"success"') || result.includes('"error"')) {
            return 'Résultat JSON';
        }
        return 'Texte';
    }

    /**
     * Formate le contenu avec le nouveau formateur Phase 4 si activé
     */
    protected formatWithAdvancedFormatterIfEnabled(
        content: ClassifiedContent,
        messageIndex: number,
        options: EnhancedSummaryOptions
    ): string | null {
        if (!this.shouldUseAdvancedCSS(options)) {
            return null; // Utiliser le formatage classique
        }

        // Utiliser le nouveau formateur Phase 4
        const timestamp = new Date().toISOString();
        
        if (content.subType === 'UserMessage') {
            const cleanedContent = this.cleanUserMessage(content.content);
            return MarkdownFormatterService.formatUserMessage(cleanedContent, timestamp);
        } else if (content.subType === 'ToolResult') {
            // Extraire le nom de l'outil et le résultat
            const toolResultMatch = content.content.match(/\[([^\]]+)\] Result:\s*(.*)/s);
            if (toolResultMatch) {
                const toolName = toolResultMatch[1];
                const result = toolResultMatch[2].trim();
                return MarkdownFormatterService.formatToolResult(toolName, result, timestamp);
            } else {
                return MarkdownFormatterService.formatToolResult('Outil', content.content, timestamp);
            }
        } else if (content.subType === 'ToolCall') {
            // Extraire les détails de l'appel d'outil depuis toolCallDetails si disponible
            if (content.toolCallDetails) {
                return MarkdownFormatterService.formatToolCall(
                    content.toolCallDetails.toolName,
                    content.toolCallDetails.arguments,
                    timestamp
                );
            } else {
                // Fallback : essayer de parser depuis le contenu
                const toolMatch = content.content.match(/<([a-zA-Z_][a-zA-Z0-9_\-:]+)(?:\s+[^>]*)?>.*?<\/\1>/s);
                if (toolMatch) {
                    const toolName = toolMatch[1];
                    return MarkdownFormatterService.formatToolCall(toolName, {}, timestamp);
                }
                return MarkdownFormatterService.formatToolCall('Outil', {}, timestamp);
            }
        } else if (content.type === 'Assistant') {
            const cleanedContent = this.cleanAssistantMessage(content.content);
            return MarkdownFormatterService.formatAssistantMessage(cleanedContent, timestamp);
        }

        return null; // Utiliser le formatage classique pour les autres types
    }

    /**
     * Nettoie le contenu d'un message assistant (supprime les balises techniques)
     */
    protected cleanAssistantMessage(content: string): string {
        if (!content?.trim()) return '';
        
        let cleaned = content;
        
        // Supprimer les blocs <thinking>
        cleaned = cleaned.replace(/<thinking>.*?<\/thinking>/gs, '');
        
        // Remplacer les blocs d'outils XML par des résumés
        cleaned = cleaned.replace(/<([a-zA-Z_][a-zA-Z0-9_\-:]+)(?:\s+[^>]*)?>.*?<\/\1>/gs, (match, toolName) => {
            return `\n**[Appel d'outil : ${toolName}]**\n`;
        });
        
        // Nettoyer les espaces multiples
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        cleaned = cleaned.trim();
        
        return cleaned;
    }
    
    /**
     * Génère les statistiques du contenu
     */
    protected generateStatistics(contents: ClassifiedContent[]): string {
        const userMessages = contents.filter(c => c.subType === 'UserMessage').length;
        const assistantMessages = contents.filter(c => c.type === 'Assistant').length;
        const toolResults = contents.filter(c => c.subType === 'ToolResult').length;
        
        const stats: string[] = [];
        stats.push('## STATISTIQUES');
        stats.push('');
        stats.push('| Métrique | Valeur |');
        stats.push('|----------|--------|');
        stats.push(`| Messages User | ${userMessages} |`);
        stats.push(`| Réponses Assistant | ${assistantMessages} |`);
        stats.push(`| Résultats d'outils | ${toolResults} |`);
        stats.push(`| **Total échanges** | **${contents.length}** |`);
        
        return stats.join('\n');
    }
    
    /**
     * Extrait la première ligne tronquée d'un contenu
     */
    protected getTruncatedFirstLine(content: string, maxLength: number = 100): string {
        if (!content?.trim()) return '';
        
        // Cas spécial : messages utilisateur avec balises <user_message>
        const userMessageMatch = content.match(/<user_message>(.*?)<\/user_message>/s);
        if (userMessageMatch) {
            const userMessageContent = userMessageMatch[1].trim();
            const lines = userMessageContent.split(/\r?\n/);
            for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine && trimmedLine.length > 0) {
                    return trimmedLine.length > maxLength ? 
                        trimmedLine.substring(0, maxLength) + '...' : 
                        trimmedLine;
                }
            }
        }
        
        // Comportement standard : première ligne non vide
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine && !trimmedLine.startsWith('<')) {
                return trimmedLine.length > maxLength ? 
                    trimmedLine.substring(0, maxLength) + '...' : 
                    trimmedLine;
            }
        }
        
        return '';
    }
    
    /**
     * Estime le numéro de ligne d'un contenu (approximation)
     */
    protected estimateLineNumber(content: ClassifiedContent): number {
        // Pour l'instant, utilisation de l'index comme approximation
        return (content.index || 0) + 1;
    }
    
    /**
     * Nettoie le contenu utilisateur (supprime environment_details, etc.)
     */
    protected cleanUserMessage(content: string): string {
        if (!content?.trim()) return '';
        
        let cleaned = content;
        
        // Supprimer les environment_details très verbeux
        cleaned = cleaned.replace(/<environment_details>.*?<\/environment_details>/gs, '[Environment details supprimés pour lisibilité]');
        
        // Supprimer les listes de fichiers très longues
        cleaned = cleaned.replace(/# Current Workspace Directory.*?(?=# [A-Z]|\n\n|$)/gs, '[Liste des fichiers workspace supprimée]');
        
        // Garder les informations importantes mais raccourcir
        cleaned = cleaned.replace(/# VSCode Visible Files\n([^\n]*)\n\n# VSCode Open Tabs\n([^\n]*(?:\n[^\n#]*)*)/gs, '**Fichiers actifs:** $1');
        
        // Supprimer les métadonnées redondantes
        cleaned = cleaned.replace(/# Current (Cost|Time).*?\n/gs, '');
        
        // Nettoyer les espaces multiples
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        cleaned = cleaned.trim();
        
        // Si le message devient trop court, extraire l'essentiel
        if (cleaned.length < 50 && content.length > 200) {
            const userMessageMatch = content.match(/<user_message>(.*?)<\/user_message>/s);
            if (userMessageMatch) {
                cleaned = userMessageMatch[1].trim();
            }
        }
        
        return cleaned;
    }

    /**
     * Variante de cleanUserMessage qui préserve les <environment_details>
     * dans une section <details> collapsible au lieu de les supprimer (#756)
     */
    protected cleanUserMessagePreservingEnvDetails(content: string): string {
        if (!content?.trim()) return '';

        const envBlocks: string[] = [];
        const withPlaceholders = content.replace(
            /<environment_details>([\s\S]*?)<\/environment_details>/g,
            (_match: string, inner: string) => {
                envBlocks.push(inner.trim());
                return `@@ENV_DETAILS_${envBlocks.length - 1}@@`;
            }
        );

        const cleaned = this.cleanUserMessage(withPlaceholders);
        if (envBlocks.length === 0) return cleaned;

        let result = cleaned;
        envBlocks.forEach((block, i) => {
            const placeholder = `@@ENV_DETAILS_${i}@@`;
            const details = [
                '<details>',
                `<summary>🌍 Environment details (${block.length} caractères)</summary>`,
                '',
                '```',
                block,
                '```',
                '',
                '</details>'
            ].join('\n');
            // Fallback : si cleanUserMessage a éliminé le placeholder (message
            // devenu trop court → extraction <user_message>), réattacher en fin
            result = result.includes(placeholder)
                ? result.replace(placeholder, details)
                : `${result}\n\n${details}`;
        });
        return result;
    }

    /**
     * Vérifie si le contenu contient des détails d'outils
     */
    protected hasToolDetails(content: ClassifiedContent): boolean {
        return content.toolCallDetails !== undefined || content.toolResultDetails !== undefined;
    }
    
    /**
     * Vérifie si le contenu est considéré comme technique
     */
    protected isTechnicalContent(content: ClassifiedContent): boolean {
        return content.subType === 'ToolCall' ||
               content.subType === 'ToolResult' ||
               this.hasToolDetails(content);
    }

    /**
     * Génère le titre d'un message (sans préfixe de heading —
     * les stratégies ajoutent leur propre `### `/#756 double-heading fix)
     */
    protected generateMessageTitle(content: ClassifiedContent, messageIndex: number): string {
        const messageType = this.getMessageType(content);

        if (content.subType === 'UserMessage') {
            return `👤 ${messageType} #${messageIndex}`;
        } else if (content.subType === 'ToolResult') {
            return `🔧 ${messageType} #${messageIndex}`;
        } else if (content.subType === 'ToolCall') {
            return `⚙️ ${messageType} #${messageIndex}`;
        } else if (content.type === 'Assistant') {
            const hasTools = content.content.includes('<') || content.toolCallDetails;
            return hasTools ? `🤖⚙️ ${messageType} #${messageIndex}` : `🤖 ${messageType} #${messageIndex}`;
        }

        return `💬 ${messageType} #${messageIndex}`;
    }
}