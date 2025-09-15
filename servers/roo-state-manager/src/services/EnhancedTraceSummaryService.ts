/**
 * EnhancedTraceSummaryService - Service de génération de résumés avec architecture améliorée
 * 
 * Ce service étend TraceSummaryService avec nos nouveaux composants :
 * - EnrichContentClassifier pour classification avancée
 * - DetailLevelStrategyFactory pour filtrage par stratégie
 * - SmartCleanerService pour nettoyage intelligent
 * - MarkdownRenderer pour rendu avancé avec CSS et TOC
 * 
 * Utilise un système de feature flags pour migration progressive
 */

import { TraceSummaryService, SummaryOptions, SummaryResult } from './TraceSummaryService.js';
import { ExportConfigManager } from './ExportConfigManager.js';
import { EnrichContentClassifier } from './EnrichContentClassifier.js';
import { DetailLevelStrategyFactory } from './reporting/DetailLevelStrategyFactory.js';
import { SmartCleanerService, CleaningConfig } from './SmartCleanerService.js';
import { MarkdownRenderer, MarkdownRenderingConfig } from './MarkdownRenderer.js';
import { ClassifiedContent } from '../types/enhanced-conversation.js';
import { ConversationSkeleton } from '../types/conversation.js';

/**
 * Feature flags pour la migration progressive
 */
export interface EnhancementFlags {
    useEnhancedClassification: boolean;    // Utiliser EnrichContentClassifier
    useStrategyFiltering: boolean;         // Utiliser le pattern Strategy pour filtrage
    useSmartCleaning: boolean;            // Utiliser SmartCleanerService
    useAdvancedRendering: boolean;        // Utiliser MarkdownRenderer
    preserveLegacyBehavior: boolean;      // Maintenir compatibilité ascendante
}

/**
 * Options étendues avec configuration d'amélioration
 */
export interface EnhancedSummaryOptions extends SummaryOptions {
    enhancementFlags?: Partial<EnhancementFlags>;
    cleaningConfig?: Partial<CleaningConfig>;
    renderingConfig?: Partial<MarkdownRenderingConfig>;
}

export class EnhancedTraceSummaryService extends TraceSummaryService {
    private enrichContentClassifier: EnrichContentClassifier;
    private strategyFactory: DetailLevelStrategyFactory;
    private smartCleaner: SmartCleanerService;
    private markdownRenderer: MarkdownRenderer;
    
    private defaultEnhancementFlags: EnhancementFlags = {
        useEnhancedClassification: true,
        useStrategyFiltering: true,
        useSmartCleaning: true,
        useAdvancedRendering: true,
        preserveLegacyBehavior: true
    };

    constructor(exportConfigManager: ExportConfigManager) {
        super(exportConfigManager);
        
        // Initialiser les nouveaux services
        this.enrichContentClassifier = new EnrichContentClassifier();
        this.strategyFactory = new DetailLevelStrategyFactory();
        this.smartCleaner = new SmartCleanerService();
        this.markdownRenderer = new MarkdownRenderer();
    }

    /**
     * Génère un résumé intelligent avec architecture améliorée
     * 
     * Cette méthode override la méthode de base pour intégrer
     * progressivement nos nouveaux composants selon les feature flags
     */
    async generateSummary(
        conversation: ConversationSkeleton,
        options: Partial<EnhancedSummaryOptions> = {}
    ): Promise<SummaryResult> {
        const enhancedOptions = this.mergeEnhancedOptions(options);
        const flags = this.getEffectiveFlags(enhancedOptions.enhancementFlags);

        try {
            // Si tous les flags d'amélioration sont désactivés, utiliser l'implémentation legacy
            if (!this.shouldUseEnhancedPipeline(flags)) {
                return super.generateSummary(conversation, options);
            }

            // Pipeline amélioré
            return await this.generateEnhancedSummary(conversation, enhancedOptions, flags);
            
        } catch (error) {
            // Fallback vers l'implémentation legacy en cas d'erreur
            if (flags.preserveLegacyBehavior) {
                console.warn('Enhanced pipeline failed, falling back to legacy:', error);
                return super.generateSummary(conversation, options);
            }
            throw error;
        }
    }

    /**
     * Pipeline de génération amélioré
     */
    private async generateEnhancedSummary(
        conversation: ConversationSkeleton,
        options: EnhancedSummaryOptions,
        flags: EnhancementFlags
    ): Promise<SummaryResult> {
        // Étape 1 : Classification du contenu
        let classifiedContent: ClassifiedContent[];
        
        if (flags.useEnhancedClassification) {
            // Utiliser notre nouveau classificateur
            classifiedContent = await this.enrichContentClassifier.classifyConversationContent(conversation);
        } else {
            // Convertir le format legacy vers le nouveau format
            const legacyClassified = (this as any).classifyConversationContent(conversation);
            classifiedContent = this.convertLegacyToEnhancedFormat(legacyClassified);
        }

        // Étape 2 : Filtrage par stratégie selon le niveau de détail
        if (flags.useStrategyFiltering) {
            const strategy = DetailLevelStrategyFactory.createStrategy(options.detailLevel);
            // TODO: Adapter à la nouvelle API IReportingStrategy.generateReport()
            // classifiedContent = strategy.apply(classifiedContent); // Cette méthode n'existe plus
            console.warn('Strategy filtering temporairement désactivé - nouvelle API en cours d\'intégration');
        }

        // Étape 3 : Nettoyage intelligent
        if (flags.useSmartCleaning) {
            const cleaningResult = this.smartCleaner.cleanContent(
                classifiedContent, 
                options.cleaningConfig
            );
            classifiedContent = cleaningResult.cleanedContent;
        }

        // Étape 4 : Rendu avancé
        let content: string;
        if (flags.useAdvancedRendering && options.outputFormat === 'markdown') {
            // Utiliser notre nouveau renderer
            const renderConfig: Partial<MarkdownRenderingConfig> = {
                includeCss: options.includeCss ?? true,
                generateToc: options.generateToc ?? true,
                compactStats: options.compactStats ?? false,
                ...options.renderingConfig
            };
            
            const renderResult = this.markdownRenderer.render(
                classifiedContent,
                conversation.metadata.title,
                renderConfig
            );
            
            content = renderResult.content;
        } else {
            // Fallback vers le rendu legacy
            const legacyClassified = this.convertEnhancedToLegacyFormat(classifiedContent);
            const statistics = (this as any).calculateStatistics(legacyClassified);
            content = await (this as any).renderSummary(conversation, legacyClassified, statistics, options);
        }

        // Calculer les statistiques finales
        const statistics = this.calculateEnhancedStatistics(classifiedContent, content);

        return {
            success: true,
            content,
            statistics
        };
    }

    /**
     * Convertit le format legacy ClassifiedContent vers le format enhanced
     */
    private convertLegacyToEnhancedFormat(legacyContent: any[]): ClassifiedContent[] {
        return legacyContent.map((item, index) => ({
            type: item.type,
            subType: item.subType,
            content: item.content,
            index,
            contentSize: item.content.length,
            isRelevant: true,
            confidenceScore: 1.0,
            // Préservation des propriétés legacy pour compatibilité
            toolType: item.toolType,
            resultType: item.resultType
        }));
    }

    /**
     * Convertit le format enhanced vers le format legacy pour fallback
     */
    private convertEnhancedToLegacyFormat(enhancedContent: ClassifiedContent[]): any[] {
        return enhancedContent.map(item => ({
            type: item.type,
            subType: item.subType,
            content: item.content,
            index: item.index,
            toolType: item.toolType,
            resultType: item.resultType
        }));
    }

    /**
     * Détermine si le pipeline amélioré doit être utilisé
     */
    private shouldUseEnhancedPipeline(flags: EnhancementFlags): boolean {
        return flags.useEnhancedClassification || 
               flags.useStrategyFiltering || 
               flags.useSmartCleaning || 
               flags.useAdvancedRendering;
    }

    /**
     * Fusionne les options avec les valeurs par défaut
     */
    private mergeEnhancedOptions(options: Partial<EnhancedSummaryOptions>): EnhancedSummaryOptions {
        const baseOptions = (this as any).mergeWithDefaultOptions(options);
        
        return {
            ...baseOptions,
            enhancementFlags: {
                ...this.defaultEnhancementFlags,
                ...options.enhancementFlags
            },
            cleaningConfig: options.cleaningConfig || {},
            renderingConfig: options.renderingConfig || {}
        };
    }

    /**
     * Calcule les flags effectifs en tenant compte des overrides
     */
    private getEffectiveFlags(flags?: Partial<EnhancementFlags>): EnhancementFlags {
        return {
            ...this.defaultEnhancementFlags,
            ...flags
        };
    }

    /**
     * Calcule les statistiques pour le format enhanced
     */
    private calculateEnhancedStatistics(classifiedContent: ClassifiedContent[], finalContent: string): any {
        const userMessages = classifiedContent.filter(item => item.subType === 'UserMessage').length;
        const assistantMessages = classifiedContent.filter(item => 
            item.subType === 'Completion' || item.subType === 'Thinking'
        ).length;
        const toolCalls = classifiedContent.filter(item => item.subType === 'ToolCall').length;
        const toolResults = classifiedContent.filter(item => item.subType === 'ToolResult').length;

        const totalContentSize = classifiedContent.reduce((sum, item) => sum + item.contentSize, 0);
        const userContentSize = classifiedContent
            .filter(item => item.subType === 'UserMessage')
            .reduce((sum, item) => sum + item.contentSize, 0);
        const assistantContentSize = classifiedContent
            .filter(item => item.subType === 'Completion' || item.subType === 'Thinking')
            .reduce((sum, item) => sum + item.contentSize, 0);
        const toolResultsSize = classifiedContent
            .filter(item => item.subType === 'ToolResult')
            .reduce((sum, item) => sum + item.contentSize, 0);

        return {
            totalSections: classifiedContent.length,
            userMessages,
            assistantMessages,
            toolResults: toolResults,
            toolCalls,
            userContentSize,
            assistantContentSize,
            toolResultsSize,
            totalContentSize,
            userPercentage: totalContentSize > 0 ? Math.round((userContentSize / totalContentSize) * 100) : 0,
            assistantPercentage: totalContentSize > 0 ? Math.round((assistantContentSize / totalContentSize) * 100) : 0,
            toolPercentage: totalContentSize > 0 ? Math.round((toolResultsSize / totalContentSize) * 100) : 0,
            compressionRatio: (this as any).calculateCompressionRatio(totalContentSize, finalContent.length)
        };
    }

    /**
     * Méthodes utilitaires pour activation/désactivation progressive des fonctionnalités
     */

    /**
     * Active toutes les améliorations (mode full enhanced)
     */
    enableAllEnhancements(): void {
        this.defaultEnhancementFlags = {
            useEnhancedClassification: true,
            useStrategyFiltering: true,
            useSmartCleaning: true,
            useAdvancedRendering: true,
            preserveLegacyBehavior: true
        };
    }

    /**
     * Désactive toutes les améliorations (mode legacy)
     */
    disableAllEnhancements(): void {
        this.defaultEnhancementFlags = {
            useEnhancedClassification: false,
            useStrategyFiltering: false,
            useSmartCleaning: false,
            useAdvancedRendering: false,
            preserveLegacyBehavior: true
        };
    }

    /**
     * Active progressivement une fonctionnalité spécifique
     */
    enableEnhancement(enhancement: keyof EnhancementFlags): void {
        this.defaultEnhancementFlags[enhancement] = true;
    }

    /**
     * Désactive une fonctionnalité spécifique
     */
    disableEnhancement(enhancement: keyof EnhancementFlags): void {
        this.defaultEnhancementFlags[enhancement] = false;
    }

    /**
     * Retourne l'état actuel des feature flags
     */
    getCurrentEnhancementFlags(): EnhancementFlags {
        return { ...this.defaultEnhancementFlags };
    }
}