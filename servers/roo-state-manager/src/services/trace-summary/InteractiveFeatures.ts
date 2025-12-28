import { SummaryOptions } from '../TraceSummaryService.js';
import { ClassifiedContent, ContentClassifier } from './ContentClassifier.js';
import { ExportRenderer } from './ExportRenderer.js';
import { DetailLevelStrategyFactory } from '../reporting/DetailLevelStrategyFactory.js';
import { DetailLevel, EnhancedSummaryOptions, ClassifiedContent as EnhancedClassifiedContent } from '../../types/enhanced-conversation.js';

/**
 * Service responsable des fonctionnalités interactives et des stratégies de rendu avancées
 */
export class InteractiveFeatures {
    private classifier: ContentClassifier;
    private renderer: ExportRenderer;

    constructor() {
        this.classifier = new ContentClassifier();
        this.renderer = new ExportRenderer();
    }

    /**
     * Génère le contenu conversationnel en utilisant les strategies (SDDD Phase 3)
     */
    public async renderConversationContentWithStrategies(
        classifiedContent: ClassifiedContent[],
        options: SummaryOptions
    ): Promise<string> {
        // Feature flag pour activer/désactiver les strategies
        if (!options.enableDetailLevels) {
            return this.renderer.renderConversationContent(classifiedContent, options);
        }

        try {
            // Convertir le format legacy vers le format enhanced
            const enhancedContent = this.convertToEnhancedFormat(classifiedContent);

            // Créer la strategy appropriée
            const strategy = DetailLevelStrategyFactory.createStrategy(options.detailLevel as DetailLevel);

            // Générer le contenu avec la strategy
            const enhancedOptions: EnhancedSummaryOptions = {
                detailLevel: options.detailLevel as DetailLevel,
                outputFormat: options.outputFormat === 'markdown' ? 'markdown' : 'html',
                truncationChars: options.truncationChars,
                compactStats: options.compactStats,
                includeCss: options.includeCss,
                generateToc: options.generateToc
            };

            const strategicContent = strategy.generateReport(enhancedContent, enhancedOptions);

            return strategicContent;

        } catch (error) {
            console.warn('Strategy rendering failed, falling back to legacy:', error);
            return this.renderer.renderConversationContent(classifiedContent, options);
        }
    }

    /**
     * Convertit le format ClassifiedContent legacy vers EnhancedClassifiedContent
     */
    private convertToEnhancedFormat(legacyContent: ClassifiedContent[]): EnhancedClassifiedContent[] {
        return legacyContent.map((item, index) => ({
            ...item,
            // Propriétés requises par le format enhanced
            contentSize: item.content.length,
            isRelevant: true, // Par défaut, considérer comme pertinent
            confidenceScore: 0.8, // Score de confiance par défaut
            // Parsing XML amélioré pour les outils
            toolCallDetails: this.classifier.extractToolCallDetails(item),
            toolResultDetails: this.classifier.extractToolResultDetails(item),
            // Métadonnées supplémentaires
            timestamp: new Date().toISOString(),
            processingNotes: []
        }));
    }
}