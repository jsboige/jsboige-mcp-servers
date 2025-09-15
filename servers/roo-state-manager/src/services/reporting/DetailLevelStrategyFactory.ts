/**
 * DetailLevelStrategyFactory - Factory pour créer les stratégies de filtrage
 *
 * Implémente le pattern Factory pour instancier la bonne stratégie selon DetailLevel
 * Version complète avec tous les 6 niveaux selon script PowerShell référence
 */

import { IReportingStrategy } from './IReportingStrategy.js';
import { DetailLevel } from '../../types/enhanced-conversation.js';
import { FullReportingStrategy } from './strategies/FullReportingStrategy.js';
import { MessagesReportingStrategy } from './strategies/MessagesReportingStrategy.js';
import { SummaryReportingStrategy } from './strategies/SummaryReportingStrategy.js';
import { NoToolsReportingStrategy } from './strategies/NoToolsReportingStrategy.js';
import { NoResultsReportingStrategy } from './strategies/NoResultsReportingStrategy.js';

/**
 * Factory pour créer les stratégies de reporting
 */
export class DetailLevelStrategyFactory {
    private static strategies = new Map<DetailLevel, () => IReportingStrategy>([
        ['Full', () => new FullReportingStrategy()],
        ['Messages', () => new MessagesReportingStrategy()],
        ['Summary', () => new SummaryReportingStrategy()],
        ['NoTools', () => new NoToolsReportingStrategy()],
        ['NoResults', () => new NoResultsReportingStrategy()],
        ['UserOnly', () => new SummaryReportingStrategy()] // Temporaire - à implémenter
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
     * Obtient les informations sur une stratégie sans l'instancier
     */
    static getStrategyInfo(detailLevel: DetailLevel): {
        name: string;
        description: string;
    } {
        return {
            name: detailLevel,
            description: this.getStrategyDescription(detailLevel)
        };
    }

    /**
     * Descriptions des stratégies pour documentation/UI
     */
    private static getStrategyDescription(detailLevel: DetailLevel): string {
        switch (detailLevel) {
            case 'Full':
                return 'Inclut tout le contenu sans filtrage - niveau de détail maximum avec métadonnées complètes';
            case 'Messages':
                return 'Messages conversationnels avec paramètres d\'outils masqués mais résultats complets';
            case 'Summary':
                return 'Table des matières avec liens et instruction initiale uniquement';
            case 'NoTools':
                return 'Messages complets avec paramètres d\'outils masqués mais résultats affichés';
            case 'NoResults':
                return 'Messages avec paramètres d\'outils complets mais résultats masqués';
            case 'UserOnly':
                return 'Contenu filtré pour ne montrer que les interactions utilisateur essentielles';
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
        if (detailLevel === 'Summary' && params?.truncationChars && params.truncationChars > 50000) {
            result.warnings.push('Summary avec troncature > 50k chars peut être inefficace');
        }

        return result;
    }

    /**
     * Crée toutes les stratégies disponibles (pour tests ou comparaisons)
     */
    static createAllStrategies(): Map<DetailLevel, IReportingStrategy> {
        const strategies = new Map<DetailLevel, IReportingStrategy>();
        
        for (const detailLevel of this.getSupportedDetailLevels()) {
            strategies.set(detailLevel, this.createStrategy(detailLevel));
        }
        
        return strategies;
    }

    /**
     * Enregistre une nouvelle stratégie personnalisée (extensibilité future)
     */
    static registerCustomStrategy(detailLevel: string, strategyCreator: () => IReportingStrategy): void {
        if (this.strategies.has(detailLevel as DetailLevel)) {
            console.warn(`Remplacement de la stratégie existante pour DetailLevel: ${detailLevel}`);
        }
        
        // Pour l'extensibilité future, on pourrait permettre l'ajout de stratégies personnalisées
        console.info(`Enregistrement de stratégie personnalisée: ${detailLevel} (non implémenté pour l'instant)`);
    }
}