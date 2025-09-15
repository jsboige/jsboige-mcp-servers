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
     * Tous les messages sont inclus, seul le formatage change
     * @param content - Contenu à formater
     * @param messageIndex - Index du message pour ancres/compteurs
     * @param options - Options de configuration  
     * @returns Contenu formaté avec métadonnées
     */
    formatMessageContent(
        content: ClassifiedContent, 
        messageIndex: number,
        options: EnhancedSummaryOptions
    ): FormattedMessage;
    
    /**
     * Génère le contenu complet selon cette stratégie
     * @param contents - Tous les contenus classifiés
     * @param options - Options de configuration
     * @param sourceFilePath - Chemin du fichier source
     * @returns Contenu Markdown complet
     */
    generateReport(
        contents: ClassifiedContent[], 
        options: EnhancedSummaryOptions,
        sourceFilePath?: string
    ): string;
}

/**
 * Résultat du formatage d'un message
 */
export interface FormattedMessage {
    /** Contenu principal formaté */
    content: string;
    /** Métadonnées pour l'affichage */
    metadata: {
        title?: string;
        cssClass?: string;
        anchor?: string;
        shouldDisplay: boolean;
        messageType: 'user' | 'assistant' | 'tool' | 'completion';
    };
    /** Notes de traitement pour debug */
    processingNotes?: string[];
}

/**
 * Interface pour les options spécifiques aux stratégies  
 */
export interface StrategyOptions {
    /** Inclure les métadonnées dans le rendu */
    includeMetadata?: boolean;
    /** Niveau de troncature pour le contenu long */
    truncationLevel?: 'none' | 'light' | 'moderate' | 'aggressive';
    /** Inclure les timestamps */
    includeTimestamps?: boolean;
    /** Format de sortie préféré */
    outputFormat?: 'markdown' | 'html' | 'text';
    /** Inclure les statistiques dans la sortie */
    includeStats?: boolean;
}

/**
 * Classe de base abstraite pour les stratégies de reporting
 * Fournit des utilitaires communs pour toutes les stratégies
 */
export abstract class BaseReportingStrategy implements IReportingStrategy {
    abstract readonly detailLevel: string;
    abstract readonly description: string;
    
    abstract isTocOnlyMode(): boolean;
    abstract formatMessageContent(
        content: ClassifiedContent, 
        messageIndex: number, 
        options: EnhancedSummaryOptions
    ): FormattedMessage;
    
    /**
     * Implémentation par défaut de la génération de table des matières
     */
    generateTableOfContents(
        contents: ClassifiedContent[], 
        options: EnhancedSummaryOptions,
        sourceFilePath?: string
    ): string {
        const toc: string[] = [];
        let userMessageCounter = 1;
        let assistantMessageCounter = 1;
        let toolResultCounter = 1;
        let isFirstUser = true;

        toc.push('<div class="toc">');
        toc.push('');
        toc.push('### SOMMAIRE DES MESSAGES {#table-des-matieres}');
        toc.push('');

        for (const content of contents) {
            const firstLine = this.getTruncatedFirstLine(content.content, 200);
            
            if (content.subType === 'UserMessage') {
                if (isFirstUser) {
                    if (this.isTocOnlyMode() && sourceFilePath) {
                        toc.push(`- **Instruction de tâche initiale** -> ${sourceFilePath}#L1`);
                    } else {
                        toc.push(`- [Instruction de tâche initiale](#instruction-de-tache-initiale)`);
                    }
                    isFirstUser = false;
                } else {
                    const anchor = `message-utilisateur-${userMessageCounter}`;
                    if (this.isTocOnlyMode() && sourceFilePath) {
                        toc.push(`- <a href="${sourceFilePath}#L${this.estimateLineNumber(content)}" class="toc-user">**MESSAGE UTILISATEUR #${userMessageCounter}** - ${firstLine}</a>`);
                    } else {
                        toc.push(`- <a href="#${anchor}" class="toc-user">MESSAGE UTILISATEUR #${userMessageCounter} - ${firstLine}</a>`);
                    }
                    userMessageCounter++;
                }
            } else if (content.subType === 'ToolResult') {
                const anchor = `outil-${toolResultCounter}`;
                if (this.isTocOnlyMode() && sourceFilePath) {
                    toc.push(`- <a href="${sourceFilePath}#L${this.estimateLineNumber(content)}" class="toc-tool">**RESULTAT OUTIL #${toolResultCounter}** - ${firstLine}</a>`);
                } else {
                    toc.push(`- <a href="#${anchor}" class="toc-tool">RESULTAT OUTIL #${toolResultCounter} - ${firstLine}</a>`);
                }
                toolResultCounter++;
            } else if (content.type === 'Assistant') {
                const anchor = `reponse-assistant-${assistantMessageCounter}`;
                const label = content.subType === 'Completion' ? 
                    `REPONSE ASSISTANT #${assistantMessageCounter} (Terminaison)` :
                    `REPONSE ASSISTANT #${assistantMessageCounter}`;
                
                if (this.isTocOnlyMode() && sourceFilePath) {
                    toc.push(`- <a href="${sourceFilePath}#L${this.estimateLineNumber(content)}" class="toc-assistant">**${label}** - ${firstLine}</a>`);
                } else {
                    toc.push(`- <a href="#${anchor}" class="toc-assistant">${label} - ${firstLine}</a>`);
                }
                assistantMessageCounter++;
            }
        }

        toc.push('');
        toc.push('</div>');
        toc.push('');
        
        return toc.join('\n');
    }
    
    /**
     * Génère le rapport complet avec en-tête, TOC, contenu et footer
     */
    generateReport(
        contents: ClassifiedContent[], 
        options: EnhancedSummaryOptions,
        sourceFilePath?: string
    ): string {
        const report: string[] = [];
        
        // En-tête avec CSS
        report.push('# RESUME DE TRACE D\'ORCHESTRATION ROO');
        report.push('');
        report.push(this.generateCssStyles());
        report.push('');
        
        if (sourceFilePath) {
            const fileName = sourceFilePath.split('/').pop() || sourceFilePath;
            report.push(`**Fichier source :** ${fileName}`);
        }
        report.push(`**Date de generation :** ${new Date().toLocaleDateString('fr-FR')} à ${new Date().toLocaleTimeString('fr-FR')}`);
        report.push(`**Mode de détail :** ${this.detailLevel}`);
        report.push('');
        
        // Statistiques
        report.push(this.generateStatistics(contents));
        report.push('');
        
        // Table des matières
        report.push(this.generateTableOfContents(contents, options, sourceFilePath));
        
        // Contenu des messages (sauf pour Summary)
        if (!this.isTocOnlyMode()) {
            report.push('## ECHANGES DE CONVERSATION');
            report.push('');
            
            let messageIndex = 0;
            for (const content of contents) {
                const formatted = this.formatMessageContent(content, messageIndex++, options);
                if (formatted.metadata.shouldDisplay) {
                    report.push(formatted.content);
                    report.push('');
                }
            }
        } else {
            // Mode Summary : ajouter l'instruction initiale
            const firstUserMessage = contents.find(c => c.subType === 'UserMessage');
            if (firstUserMessage) {
                report.push('## INSTRUCTION DE TACHE INITIALE');
                report.push('');
                report.push('```markdown');
                report.push(this.cleanUserMessage(firstUserMessage.content));
                report.push('```');
                report.push('');
            }
        }
        
        // Footer
        report.push('---');
        report.push('');
        report.push('**Résumé généré automatiquement par Enhanced Export MCP**');
        report.push(`**Date :** ${new Date().toLocaleDateString('fr-FR')} à ${new Date().toLocaleTimeString('fr-FR')}`);
        
        return report.join('\n');
    }
    
    /**
     * Génère les styles CSS pour le rendu
     */
    protected generateCssStyles(): string {
        return `<style>
.user-message {
    background-color: #FFEBEE;
    border-left: 4px solid #F44336;
    padding: 15px;
    margin: 10px 0;
    border-radius: 5px;
}
.assistant-message {
    background-color: #E8F4FD;
    border-left: 4px solid #2196F3;
    padding: 15px;
    margin: 10px 0;
    border-radius: 5px;
}
.tool-message {
    background-color: #FFF8E1;
    border-left: 4px solid #FF9800;
    padding: 15px;
    margin: 10px 0;
    border-radius: 5px;
}
.completion-message {
    background-color: #E8F5E8;
    border-left: 4px solid #4CAF50;
    padding: 15px;
    margin: 10px 0;
    border-radius: 5px;
    box-shadow: 0 2px 4px rgba(76,175,80,0.1);
}
.toc {
    background-color: #f8f9fa;
    border: 1px solid #dee2e6;
    border-radius: 8px;
    padding: 20px;
    margin: 15px 0;
}
.toc h3 {
    margin-top: 0;
    color: #495057;
    border-bottom: 2px solid #6c757d;
    padding-bottom: 10px;
}
.toc-user { color: #F44336 !important; font-weight: bold; text-decoration: none; }
.toc-user:hover { background-color: #FFEBEE; padding: 2px 4px; border-radius: 3px; }
.toc-assistant { color: #2196F3 !important; font-weight: bold; text-decoration: none; }
.toc-assistant:hover { background-color: #E8F4FD; padding: 2px 4px; border-radius: 3px; }
.toc-tool { color: #FF9800 !important; font-weight: bold; text-decoration: none; }
.toc-tool:hover { background-color: #FFF8E1; padding: 2px 4px; border-radius: 3px; }
.toc-completion { color: #4CAF50 !important; font-weight: bold; text-decoration: none; }
.toc-completion:hover { background-color: #E8F5E8; padding: 2px 4px; border-radius: 3px; }
</style>`;
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
}