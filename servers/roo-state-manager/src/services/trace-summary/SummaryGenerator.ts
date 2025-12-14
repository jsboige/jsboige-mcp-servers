import { ConversationSkeleton, MessageSkeleton } from '../../types/conversation.js';
import { SummaryOptions, SummaryResult, SummaryStatistics } from '../TraceSummaryService.js';
import { ContentClassifier, ClassifiedContent } from './ContentClassifier.js';
import { ExportRenderer } from './ExportRenderer.js';
import { InteractiveFeatures } from './InteractiveFeatures.js';

/**
 * Service principal de génération de résumés
 * Orchestre la classification, le rendu et les fonctionnalités interactives
 */
export class SummaryGenerator {
    private classifier: ContentClassifier;
    private renderer: ExportRenderer;
    private interactive: InteractiveFeatures;

    constructor() {
        this.classifier = new ContentClassifier();
        this.renderer = new ExportRenderer();
        this.interactive = new InteractiveFeatures();
    }

    /**
     * Génère un résumé intelligent à partir d'un ConversationSkeleton
     */
    public async generateSummary(
        conversation: ConversationSkeleton,
        options: Partial<SummaryOptions> = {}
    ): Promise<SummaryResult> {
        try {
            const fullOptions = this.mergeWithDefaultOptions(options);

            // Dispatcher selon le format de sortie
            // Note: JSON et CSV sont gérés par TraceSummaryService pour l'instant (ou délégués si on veut tout migrer)
            // Pour ce refactoring, on se concentre sur le flux principal (Markdown/HTML)
            // Les appels JSON/CSV seront gérés par le service parent qui appellera les méthodes spécifiques

            // NOUVELLE LOGIQUE : Chercher d'abord un fichier .md source
            const classifiedContent = await this.classifier.classifyContentFromMarkdownOrJson(conversation, fullOptions);
            const statistics = this.calculateStatistics(classifiedContent);

            let content: string;

            // Utiliser InteractiveFeatures pour le rendu si activé, sinon ExportRenderer
            if (fullOptions.enableDetailLevels && fullOptions.detailLevel !== 'Summary') {
                // Note: InteractiveFeatures utilise ExportRenderer en interne ou ses propres stratégies
                // Ici on doit reconstruire le flux complet : Header + Metadata + CSS + Stats + Content + Footer
                // InteractiveFeatures.renderConversationContentWithStrategies ne rend QUE le contenu conversationnel
                
                // On utilise ExportRenderer.renderSummary mais on surcharge la partie contenu
                // C'est un peu délicat car ExportRenderer.renderSummary appelle renderConversationContent
                // On va plutôt appeler renderSummary de ExportRenderer, et ExportRenderer devra être capable d'utiliser InteractiveFeatures
                // OU on réimplémente l'orchestration ici.
                
                // Option choisie : Réimplémenter l'orchestration ici pour plus de contrôle
                const parts: string[] = [];
                parts.push(this.renderer.generateHeader(conversation, fullOptions));
                parts.push(this.renderer.generateMetadata(conversation, statistics));
                
                if (fullOptions.includeCss) {
                    parts.push(this.renderer.generateEmbeddedCss());
                }
                
                parts.push(this.renderer.generateStatistics(statistics, fullOptions.compactStats));
                
                const conversationContent = await this.interactive.renderConversationContentWithStrategies(
                    classifiedContent,
                    fullOptions
                );
                parts.push(conversationContent);
                
                parts.push(this.renderer.generateFooter(fullOptions));
                
                content = parts.join('\n\n');
                
                if (fullOptions.includeCss) {
                    content = this.renderer.ensureSingleCss(content);
                }

            } else {
                // Flux standard via ExportRenderer
                content = await this.renderer.renderSummary(
                    conversation,
                    classifiedContent,
                    statistics,
                    fullOptions
                );
            }

            return {
                success: true,
                content,
                statistics: {
                    ...statistics,
                    compressionRatio: this.calculateCompressionRatio(
                        this.getOriginalContentSize(conversation),
                        content.length
                    )
                }
            };

        } catch (error) {
            return {
                success: false,
                content: '',
                statistics: this.getEmptyStatistics(),
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    /**
     * Calcule les statistiques détaillées du contenu
     */
    public calculateStatistics(classifiedContent: ClassifiedContent[]): SummaryStatistics {
        let userMessages = 0;
        let assistantMessages = 0;
        let toolResults = 0;
        let userContentSize = 0;
        let assistantContentSize = 0;
        let toolResultsSize = 0;

        for (const item of classifiedContent) {
            const contentSize = item.content.length;

            switch (item.subType) {
                case 'UserMessage':
                    userMessages++;
                    userContentSize += contentSize;
                    break;
                case 'ErrorMessage':
                case 'ContextCondensation':
                case 'NewInstructions':
                    // SDDD: Nouveaux types comptés comme messages utilisateur
                    userMessages++;
                    userContentSize += contentSize;
                    break;
                case 'ToolResult':
                    toolResults++;
                    toolResultsSize += contentSize;
                    break;
                case 'ToolCall':
                case 'Completion':
                    assistantMessages++;
                    assistantContentSize += contentSize;
                    break;
            }
        }

        const totalContentSize = userContentSize + assistantContentSize + toolResultsSize;

        return {
            totalSections: classifiedContent.length,
            userMessages,
            assistantMessages,
            toolResults,
            userContentSize,
            assistantContentSize,
            toolResultsSize,
            totalContentSize,
            userPercentage: totalContentSize > 0 ? Math.round((userContentSize / totalContentSize) * 100 * 10) / 10 : 0,
            assistantPercentage: totalContentSize > 0 ? Math.round((assistantContentSize / totalContentSize) * 100 * 10) / 10 : 0,
            toolResultsPercentage: totalContentSize > 0 ? Math.round((toolResultsSize / totalContentSize) * 100 * 10) / 10 : 0
        };
    }

    /**
     * Fusionne les options avec les valeurs par défaut
     */
    public mergeWithDefaultOptions(options: Partial<SummaryOptions>): SummaryOptions {
        const result = {
            detailLevel: options.detailLevel || 'Full',
            truncationChars: options.truncationChars || 0,
            compactStats: options.compactStats || false,
            includeCss: options.includeCss !== undefined ? options.includeCss : true,
            generateToc: options.generateToc !== undefined ? options.generateToc : true,
            outputFormat: options.outputFormat || 'markdown',
            jsonVariant: options.jsonVariant,
            csvVariant: options.csvVariant,
            // SDDD Phase 3: Feature flag pour les strategies (désactivé par défaut pour compatibilité)
            enableDetailLevels: options.enableDetailLevels || false,
            // CORRECTION CRITIQUE: tocStyle doit être synchronisé avec outputFormat
            // Si outputFormat est 'markdown', utiliser 'markdown' pour éviter les balises HTML
            tocStyle: options.tocStyle || ((options.outputFormat || 'markdown') === 'html' ? 'html' : 'markdown'),
            hideEnvironmentDetails: options.hideEnvironmentDetails !== undefined ? options.hideEnvironmentDetails : true,
            startIndex: options.startIndex,
            endIndex: options.endIndex
        };
        return result;
    }

    /**
     * Calcule le ratio de compression
     */
    private calculateCompressionRatio(originalSize: number, finalSize: number): number {
        return finalSize > 0 ? Math.round((originalSize / finalSize) * 100) / 100 : 1;
    }

    /**
     * Calcule la taille du contenu original
     */
    public getOriginalContentSize(conversation: ConversationSkeleton): number {
        const messages = conversation.sequence.filter((item): item is MessageSkeleton =>
            'role' in item && 'content' in item);

        return messages.reduce((total: number, message: MessageSkeleton) => total + message.content.length, 0);
    }

    /**
     * Retourne des statistiques vides en cas d'erreur
     */
    public getEmptyStatistics(): SummaryStatistics {
        return {
            totalSections: 0,
            userMessages: 0,
            assistantMessages: 0,
            toolResults: 0,
            userContentSize: 0,
            assistantContentSize: 0,
            toolResultsSize: 0,
            totalContentSize: 0,
            userPercentage: 0,
            assistantPercentage: 0,
            toolResultsPercentage: 0
        };
    }
}