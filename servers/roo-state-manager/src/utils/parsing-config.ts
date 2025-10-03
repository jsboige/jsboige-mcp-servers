/**
 * Configuration pour le système de parsing
 * Gère la bascule progressive vers le nouveau système MessageToSkeletonTransformer
 * 
 * @module parsing-config
 */

/**
 * Configuration pour le système de parsing
 * Gère la bascule progressive vers le nouveau système
 */
export interface ParsingConfig {
  /** Utiliser le nouveau système de parsing (MessageToSkeletonTransformer) */
  useNewParsing: boolean;
  
  /** Mode de comparaison : exécute ancien + nouveau et compare */
  comparisonMode: boolean;
  
  /** Logger les différences en mode comparaison */
  logDifferences: boolean;
  
  /** Seuil de tolérance pour les différences (%) */
  differenceTolerance: number;
}

/**
 * Configuration par défaut (ancien système actif)
 */
const DEFAULT_CONFIG: ParsingConfig = {
  useNewParsing: false,
  comparisonMode: false,
  logDifferences: false,
  differenceTolerance: 5, // 5% de différence tolérée
};

/**
 * Récupère la configuration depuis les variables d'environnement
 */
export function getParsingConfig(): ParsingConfig {
  return {
    useNewParsing: process.env.USE_NEW_PARSING === 'true',
    comparisonMode: process.env.PARSING_COMPARISON_MODE === 'true',
    logDifferences: process.env.LOG_PARSING_DIFFERENCES === 'true',
    differenceTolerance: parseInt(process.env.PARSING_DIFFERENCE_TOLERANCE || '5', 10),
  };
}

/**
 * Détermine quel système utiliser
 * @returns true si le nouveau système doit être utilisé
 */
export function shouldUseNewParsing(): boolean {
  const config = getParsingConfig();
  return config.useNewParsing || config.comparisonMode;
}

/**
 * Détermine si on est en mode comparaison
 * @returns true si le mode comparaison est activé
 */
export function isComparisonMode(): boolean {
  return getParsingConfig().comparisonMode;
}

/**
 * Retourne la configuration par défaut
 * @returns Configuration par défaut
 */
export function getDefaultConfig(): ParsingConfig {
  return { ...DEFAULT_CONFIG };
}