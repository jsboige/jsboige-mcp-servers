/**
 * SummaryReportingStrategy - Stratégie pour le mode Summary
 * 
 * MODE SUMMARY selon script PowerShell référence :
 * - Génère SEULEMENT table des matières + instruction initiale
 * - Liens externes vers fichier source avec numéros de ligne  
 * - Aucun contenu des messages dans le résumé
 * - Mode "TOC Only" = true
 */

import { BaseReportingStrategy, FormattedMessage } from '../IReportingStrategy.js';
import { ClassifiedContent, EnhancedSummaryOptions } from '../../../types/enhanced-conversation.js';

export class SummaryReportingStrategy extends BaseReportingStrategy {
    readonly detailLevel = 'Summary';
    readonly description = 'Table des matières avec liens vers fichier source + instruction initiale seulement';

    /**
     * Le mode Summary génère seulement une table des matières
     */
    isTocOnlyMode(): boolean {
        return true;
    }

    /**
     * En mode Summary, les messages ne sont pas formatés individuellement
     * (sauf l'instruction initiale qui est gérée dans generateReport)
     */
    formatMessageContent(
        content: ClassifiedContent, 
        messageIndex: number, 
        options: EnhancedSummaryOptions
    ): FormattedMessage {
        // En mode Summary, seule l'instruction initiale est affichée
        const isFirstUserMessage = content.subType === 'UserMessage' && messageIndex === 0;
        
        return {
            content: '', // Pas de contenu individuel en mode Summary
            metadata: {
                title: this.generateMessageTitle(content, messageIndex),
                cssClass: this.getCssClass(content),
                anchor: this.generateAnchor(content, messageIndex),
                shouldDisplay: false, // Les messages ne sont pas affichés individuellement
                messageType: this.getMessageType(content)
            },
            processingNotes: [`Mode Summary: message non affiché individuellement`]
        };
    }

    /**
     * Génère la table des matières avec liens externes vers fichier source
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
            const lineNumber = this.estimateLineNumber(content);
            
            if (content.subType === 'UserMessage') {
                if (isFirstUser) {
                    const link = sourceFilePath ? ` -> ${sourceFilePath}#L${lineNumber}` : '';
                    toc.push(`- **Instruction de tâche initiale**${link}`);
                    isFirstUser = false;
                } else {
                    if (sourceFilePath) {
                        toc.push(`- <a href="${sourceFilePath}#L${lineNumber}" class="toc-user">**MESSAGE UTILISATEUR #${userMessageCounter}** - ${firstLine}</a> [L${lineNumber}]`);
                    } else {
                        toc.push(`- <a href="#L${lineNumber}" class="toc-user">**MESSAGE UTILISATEUR #${userMessageCounter}** - ${firstLine}</a>`);
                    }
                    userMessageCounter++;
                }
            } else if (content.subType === 'ToolResult') {
                if (sourceFilePath) {
                    toc.push(`- <a href="${sourceFilePath}#L${lineNumber}" class="toc-tool">**RESULTAT OUTIL #${toolResultCounter}** - ${firstLine}</a> [L${lineNumber}]`);
                } else {
                    toc.push(`- <a href="#L${lineNumber}" class="toc-tool">**RESULTAT OUTIL #${toolResultCounter}** - ${firstLine}</a>`);
                }
                toolResultCounter++;
            } else if (content.type === 'Assistant') {
                const label = content.subType === 'Completion' ? 
                    `REPONSE ASSISTANT #${assistantMessageCounter} (Terminaison)` :
                    `REPONSE ASSISTANT #${assistantMessageCounter}`;
                
                if (sourceFilePath) {
                    toc.push(`- <a href="${sourceFilePath}#L${lineNumber}" class="toc-assistant">**${label}** - ${firstLine}</a> [L${lineNumber}]`);
                } else {
                    toc.push(`- <a href="#L${lineNumber}" class="toc-assistant">**${label}** - ${firstLine}</a>`);
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
     * Génère le rapport complet Summary : TOC + instruction initiale + footer
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
        
        // Table des matières avec liens externes
        report.push(this.generateTableOfContents(contents, options, sourceFilePath));
        
        // Instruction initiale (spécifique au mode Summary)
        const firstUserMessage = contents.find(c => c.subType === 'UserMessage');
        if (firstUserMessage) {
            report.push('## INSTRUCTION DE TACHE INITIALE');
            report.push('');
            
            // Extraction du contenu principal et des environment_details
            const cleanedContent = this.extractMainContent(firstUserMessage.content);
            report.push('```markdown');
            report.push(cleanedContent);
            report.push('```');
            report.push('');
            report.push('---');
            report.push('');
        }
        
        // Footer Summary
        report.push('---');
        report.push('');
        report.push('**Résumé généré automatiquement par Convert-TraceToSummary.ps1**');
        report.push(`**Date :** ${new Date().toLocaleDateString('fr-FR')} à ${new Date().toLocaleTimeString('fr-FR')}`);
        report.push(`**Mode :** Summary (Table des matières + Instruction initiale)`);
        
        return report.join('\n');
    }

    /**
     * Extrait le contenu principal en supprimant les environment_details
     */
    private extractMainContent(content: string): string {
        // Si le contenu contient environment_details, les séparer
        const envMatch = content.match(/(.*?)<environment_details>.*?<\/environment_details>(.*)/s);
        if (envMatch) {
            const beforeEnv = envMatch[1].trim();
            const afterEnv = envMatch[2].trim();
            return beforeEnv + (afterEnv ? '\n\n' + afterEnv : '');
        }
        
        return this.cleanUserMessage(content);
    }

    /**
     * Génère le titre d'un message
     */
    private generateMessageTitle(content: ClassifiedContent, messageIndex: number): string {
        if (content.subType === 'UserMessage') {
            return messageIndex === 0 ? 'Instruction de tâche initiale' : `Message utilisateur #${messageIndex}`;
        } else if (content.subType === 'ToolResult') {
            return `Résultat outil #${messageIndex}`;
        } else if (content.type === 'Assistant') {
            return content.subType === 'Completion' ? 
                `Réponse assistant #${messageIndex} (Terminaison)` :
                `Réponse assistant #${messageIndex}`;
        }
        return `Message #${messageIndex}`;
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