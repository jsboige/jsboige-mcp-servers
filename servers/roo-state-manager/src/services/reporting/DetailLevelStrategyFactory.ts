/**
 * DetailLevelStrategyFactory - Factory pour créer les stratégies de filtrage
 * 
 * Implémente le pattern Factory pour instancier la bonne stratégie selon DetailLevel
 * Selon l'architecture définie dans docs/sddd/markdown_export_architecture.md
 */

import { IReportingStrategy } from './strategies/IReportingStrategy.js';
import { FullStrategy } from './strategies/FullStrategy.js';
import { NoToolsStrategy } from './strategies/NoToolsStrategy.js';
import { NoResultsStrategy } from './strategies/NoResultsStrategy.js';
import { MessagesStrategy } from './strategies/MessagesStrategy.js';
import { SummaryStrategy } from './strategies/SummaryStrategy.js';
import { UserOnlyStrategy } from './strategies/UserOnlyStrategy.js';
import { ClassifiedContent } from '../../types/enhanced-conversation.js';

/**
 * Types de DetailLevel supportés
 */
export type DetailLevel = 'Full' | 'NoTools' | 'NoResults' | 'Messages' | 'Summary' | 'UserOnly';

/**
 * Factory pour créer les stratégies de reporting
 */
export class DetailLevelStrategyFactory {
    private static strategies = new Map<DetailLevel, () => IReportingStrategy>([
        ['Full', () => new FullStrategy()],
        ['NoTools', () => new NoToolsStrategy()],
        ['NoResults', () => new NoResultsStrategy()],
        ['Messages', () => new MessagesStrategy()],
        ['Summary', () => new SummaryStrategy()],
        ['UserOnly', () => new UserOnlyStrategy()]
    ]);

    /**
     * Crée une stratégie selon le DetailLevel demandé
     */
    static createStrategy(detailLevel: DetailLevel): IReportingStrategy {
        const strategyCreator = this.strategies.get(detailLevel);
        
        if (!strategyCreator) {
            throw new Error(`Stratégie non supportée pour DetailLevel: ${detailLevel}`);
        }

        return strategyCreator();
    }

    /**
     * Vérifie si un DetailLevel est supporté
     */
    static isSupportedDetailLevel(detailLevel: string): detailLevel is DetailLevel {
        return this.strategies.has(detailLevel as DetailLevel);
    }

    /**
     * Retourne tous les DetailLevel supportés
     */
    static getSupportedDetailLevels(): DetailLevel[] {
        return Array.from(this.strategies.keys());
    }

    /**
     * Crée une stratégie avec validation et fallback
     */
    static createStrategyWithFallback(detailLevel: string, fallback: DetailLevel = 'Full'): IReportingStrategy {
        if (this.isSupportedDetailLevel(detailLevel)) {
            return this.createStrategy(detailLevel);
        }

        console.warn(`DetailLevel "${detailLevel}" non supporté, utilisation de "${fallback}"`);
        return this.createStrategy(fallback);
    }

    /**
     * Enregistre une nouvelle stratégie personnalisée (pour extensibilité future)
     */
    static registerStrategy(detailLevel: string, strategyCreator: () => IReportingStrategy): void {
        if (this.strategies.has(detailLevel as DetailLevel)) {
            console.warn(`Remplacement de la stratégie existante pour DetailLevel: ${detailLevel}`);
        }
        
        // Note: pour l'instant on ne supporte que les DetailLevel prédéfinis
        // Cette méthode est là pour une extensibilité future
        console.info(`Enregistrement de stratégie personnalisée: ${detailLevel}`);
    }

    /**
     * Obtient les informations sur une stratégie sans l'instancier
     */
    static getStrategyInfo(detailLevel: DetailLevel): {
        name: string;
        description: string;
        showsToolDetails: boolean;
        showsThinking: boolean;
        showsToolResults: boolean;
        isUserOnly: boolean;
    } {
        // Créer temporairement la stratégie pour obtenir ses infos
        const strategy = this.createStrategy(detailLevel);
        
        return {
            name: strategy.getStrategyName(),
            description: this.getStrategyDescription(detailLevel),
            showsToolDetails: strategy.shouldShowToolDetails(),
            showsThinking: strategy.shouldShowThinking(),
            showsToolResults: strategy.shouldShowToolResults(),
            isUserOnly: strategy.isUserOnlyMode()
        };
    }

    /**
     * Descriptions des stratégies pour documentation/UI
     */
    private static getStrategyDescription(detailLevel: DetailLevel): string {
        switch (detailLevel) {
            case 'Full':
                return 'Inclut tout le contenu sans filtrage - niveau de détail maximum';
            case 'NoTools':
                return 'Exclut les appels d\'outils mais garde leurs résultats';
            case 'NoResults':
                return 'Exclut les résultats d\'outils mais garde les appels';
            case 'Messages':
                return 'Ne garde que les échanges conversationnels (UserMessage + Completion)';
            case 'Summary':
                return 'Contenu ultra-concentré et pertinent pour un résumé exécutif';
            case 'UserOnly':
                return 'Uniquement les messages de l\'utilisateur';
            default:
                return 'Description non disponible';
        }
    }

    /**
     * Valide les paramètres d'une stratégie avant création
     */
    static validateStrategyParams(detailLevel: string, params?: any): {
        isValid: boolean;
        errors: string[];
        warnings: string[];
    } {
        const result = {
            isValid: true,
            errors: [] as string[],
            warnings: [] as string[]
        };

        if (!this.isSupportedDetailLevel(detailLevel)) {
            result.isValid = false;
            result.errors.push(`DetailLevel "${detailLevel}" n'est pas supporté`);
        }

        // Validation spécifique selon les stratégies
        if (detailLevel === 'Summary' && params?.truncationChars > 50000) {
            result.warnings.push('Summary avec troncature > 50k chars peut être inefficace');
        }

        if (detailLevel === 'UserOnly' && params?.includeCss) {
            result.warnings.push('CSS non applicable pour UserOnly');
        }

        return result;
    }
}

/**
 * Interface pour la configuration avancée des stratégies
 */
export interface StrategyConfig {
    detailLevel: DetailLevel;
    minConfidenceScore?: number;
    maxTruncationChars?: number;
    customFilters?: string[];
    debugMode?: boolean;
}

/**
 * Factory étendue avec configuration avancée
 */
export class ConfigurableStrategyFactory extends DetailLevelStrategyFactory {
    /**
     * Crée une stratégie avec configuration personnalisée
     */
    static createConfiguredStrategy(config: StrategyConfig): IReportingStrategy {
        const baseStrategy = this.createStrategy(config.detailLevel);
        
        // Si pas de config avancée, retourner la stratégie de base
        if (!config.minConfidenceScore && !config.maxTruncationChars && !config.customFilters) {
            return baseStrategy;
        }

        // Wrapper la stratégie avec la configuration
        return new ConfiguredStrategyWrapper(baseStrategy, config);
    }
}

/**
 * Wrapper pour appliquer une configuration personnalisée à une stratégie
 */
class ConfiguredStrategyWrapper implements IReportingStrategy {
    constructor(
        private baseStrategy: IReportingStrategy,
        private config: StrategyConfig
    ) {}
apply(content: ClassifiedContent[]): ClassifiedContent[] {
    let result = this.baseStrategy.apply(content);

    // Appliquer les filtres de configuration
    if (this.config.minConfidenceScore !== undefined) {
        result = this.baseStrategy.filterByRelevance(result, this.config.minConfidenceScore);
    }

    if (this.config.maxTruncationChars !== undefined) {
        result = this.baseStrategy.applyIntelligentTruncation(result, this.config.maxTruncationChars);
    }

    return result;
}

shouldShowToolDetails(): boolean { return this.baseStrategy.shouldShowToolDetails(); }
shouldShowThinking(): boolean { return this.baseStrategy.shouldShowThinking(); }
shouldShowToolResults(): boolean { return this.baseStrategy.shouldShowToolResults(); }
isUserOnlyMode(): boolean { return this.baseStrategy.isUserOnlyMode(); }
getStrategyName(): string { return `${this.baseStrategy.getStrategyName()}_Configured`; }

filterByRelevance(content: ClassifiedContent[], minConfidenceScore: number): ClassifiedContent[] {
    return this.baseStrategy.filterByRelevance(content, minConfidenceScore);
}

applyIntelligentTruncation(content: ClassifiedContent[], maxChars: number): ClassifiedContent[] {
    return this.baseStrategy.applyIntelligentTruncation(content, maxChars);
}
}