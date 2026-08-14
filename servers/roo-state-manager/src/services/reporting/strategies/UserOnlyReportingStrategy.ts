/**
 * UserOnlyReportingStrategy - Stratégie pour le mode UserOnly
 *
 * MODE USERONLY selon script PowerShell référence :
 * - Affiche uniquement les messages de l'utilisateur
 * - Exclut tous les messages de l'assistant et détails d'outils
 * - Préserve l'ordre chronologique des interactions utilisateur
 * - Idéal pour extraire le contexte/demandes utilisateur uniquement
 */

import { BaseReportingStrategy, FormattedMessage } from '../IReportingStrategy.js';
import { ClassifiedContent, EnhancedSummaryOptions } from '../../../types/enhanced-conversation.js';

export class UserOnlyReportingStrategy extends BaseReportingStrategy {
    readonly detailLevel = 'UserOnly';
    readonly description = 'Seulement les messages utilisateur, sans réponses ni outils';

    /**
     * Le mode UserOnly n'est pas "TOC Only" - il affiche les messages utilisateur complets
     */
    isTocOnlyMode(): boolean {
        return false;
    }

    /**
     * Formate le contenu d'un message - ne garde que les messages utilisateur
     */
    formatMessageContent(
        content: ClassifiedContent,
        messageIndex: number,
        options: EnhancedSummaryOptions
    ): FormattedMessage {
        
        // Pour UserOnly, on ne garde que les messages utilisateur
        if (content.type !== 'User' || content.subType !== 'UserMessage') {
            return {
                content: '',
                cssClass: 'hidden-message',
                shouldRender: false,
                messageType: 'user',
                metadata: {
                    messageIndex,
                    contentLength: content.content.length,
                    hasToolDetails: false,
                    shouldDisplay: false,
                    messageType: 'user'
                }
            };
        }

        const messageContent = content.content || '';

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
                anchor: this.generateAnchor(content, messageIndex),
                metadata: {
                    messageIndex,
                    contentLength: content.content.length,
                    hasToolDetails: false,
                    title: this.generateMessageTitle(content, messageIndex),
                    cssClass: this.getCssClass(content),
                    anchor: this.generateAnchor(content, messageIndex),
                    shouldDisplay: true,
                    messageType: this.getMessageType(content)
                },
                processingNotes: [`Mode UserOnly: messages utilisateur uniquement`, 'Phase 4 CSS avancé activé']
            };
        }

        // Formatage classique (fallback)
        // En mode UserOnly, on affiche les messages utilisateur complets
        // mais on peut appliquer une troncature si nécessaire
        let processedContent = messageContent;

        // Appliquer la troncature si définie
        if (options.truncationChars && options.truncationChars > 0 &&
            messageContent.length > options.truncationChars) {
            const halfSize = Math.floor(options.truncationChars / 2);
            processedContent = messageContent.substring(0, halfSize) +
                             '\n\n...[MESSAGE TRONQUÉ]...\n\n' +
                             messageContent.substring(messageContent.length - halfSize);
        }

        // Format simple pour les messages utilisateur
        const anchor = `user-message-${messageIndex}`;
        const title = `Message Utilisateur #${messageIndex + 1}`;

        // Ancre HTML explicite : la TOC UserOnly lie vers #user-message-N (#756)
        const formattedContent = [
            `<a id="${anchor}"></a>`,
            '',
            `## ${title}`,
            '',
            processedContent,
            ''
        ].join('\n');

        return {
            content: formattedContent,
            cssClass: 'user-message',
            shouldRender: true,
            messageType: 'user',
            anchor,
            metadata: {
                messageIndex,
                contentLength: content.content.length,
                hasToolDetails: false,
                title,
                anchor,
                shouldDisplay: true,
                messageType: 'user',
                cssClass: 'user-message'
            }
        };
    }

    /**
     * Génère la table des matières spécifique au mode UserOnly
     */
    generateTableOfContents(
        contents: ClassifiedContent[],
        options: EnhancedSummaryOptions,
        sourceFilePath?: string
    ): string {
        const userMessages = contents.filter(c =>
            c.type === 'User' && c.subType === 'UserMessage'
        );

        if (userMessages.length === 0) {
            return '## 📑 Table des Matières\n\n*Aucun message utilisateur trouvé*\n\n';
        }

        const tocItems = userMessages.map((content, index) => {
            const preview = this.createMessagePreview(content.content || '', 60);
            return `- [💬 Message ${index + 1}](#user-message-${index}) - ${preview}`;
        }).join('\n');

        return `## 📑 Table des Matières\n\n${tocItems}\n\n`;
    }

    /**
     * Génère le rapport complet pour UserOnly
     */
    generateReport(
        contents: ClassifiedContent[],
        options: EnhancedSummaryOptions,
        sourceFilePath?: string
    ): string {
        const userMessages = contents.filter(c =>
            c.type === 'User' && c.subType === 'UserMessage'
        );

        if (userMessages.length === 0) {
            return '# Rapport UserOnly\n\n*Aucun message utilisateur trouvé dans cette conversation*\n\n';
        }

        const sections: string[] = [];

        // En-tête
        sections.push(`# Rapport de Conversation - Mode ${this.detailLevel}`);
        sections.push(`> ${this.description}\n`);

        // Métadonnées
        const totalMessages = contents.length;
        const userMessageCount = userMessages.length;
        const totalChars = userMessages.reduce((sum, c) => sum + (c.content?.length || 0), 0);

        sections.push('## 📊 Statistiques');
        sections.push(`- **Messages Total :** ${totalMessages}`);
        sections.push(`- **Messages Utilisateur :** ${userMessageCount}`);
        sections.push(`- **Caractères Utilisateur :** ${totalChars.toLocaleString()}`);
        sections.push(`- **Taux de Filtrage :** ${((totalMessages - userMessageCount) / totalMessages * 100).toFixed(1)}%\n`);

        // Table des matières
        sections.push(this.generateTableOfContents(contents, options, sourceFilePath));

        // Contenu des messages
        sections.push('## 💬 Messages Utilisateur\n');

        userMessages.forEach((content, index) => {
            const formatted = this.formatMessageContent(content, index, options);
            if (formatted.metadata?.shouldDisplay) {
                sections.push(formatted.content);
            }
        });

        return sections.join('\n');
    }

    /**
     * Crée un aperçu court d'un message pour la TOC
     */
    private createMessagePreview(content: string, maxLength: number): string {
        if (!content) return '[message vide]';
        
        // Nettoyer le contenu (retirer les sauts de ligne multiples, etc.)
        const cleaned = content.replace(/\n+/g, ' ').trim();
        
        if (cleaned.length <= maxLength) {
            return cleaned;
        }
        
        return cleaned.substring(0, maxLength - 3) + '...';
    }
}