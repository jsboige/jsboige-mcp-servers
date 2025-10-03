/**
 * Configuration pour le système de parsing
 * SEUILS RECALIBRÉS POST-INVESTIGATION SDDD
 */
export interface ParsingConfig {
  useNewParsing: boolean;
  comparisonMode: boolean;
  logDifferences: boolean;
  
  // ✅ SEUILS RECALIBRÉS (investigation SDDD validée)
  /** Seuil de similarité recalibré - 40-60% acceptable si améliorations documentées */
  similarityThreshold: number;
  
  /** Activer validation stricte des améliorations */
  validateImprovements: boolean;
  
  /** Seuil minimum child tasks détectés (nouveau système doit être > ancien) */
  minChildTasksImprovement: number;
}

const DEFAULT_CONFIG: ParsingConfig = {
  useNewParsing: false,
  comparisonMode: false,
  logDifferences: false,
  
  // ✅ NOUVEAUX SEUILS VALIDÉS (ajustés d'après investigation)
  similarityThreshold: 44, // 44% minimum pour 44.44% observé dans SDDD
  validateImprovements: true,
  minChildTasksImprovement: 10, // Minimum 10 child tasks de plus que l'ancien
};

/**
 * Valide si les résultats sont acceptables avec les nouveaux critères
 */
export function validateComparisonResults(
  similarityScore: number,
  oldChildTasks: number,
  newChildTasks: number,
  improvements: string[]
): { isValid: boolean; reason: string } {
  const config = getParsingConfig();
  
  // Critère 1 : Similarité base
  if (similarityScore < config.similarityThreshold) {
    return {
      isValid: false,
      reason: `Similarité ${similarityScore}% < seuil minimum ${config.similarityThreshold}%`
    };
  }
  
  // Critère 2 : Amélioration child tasks
  const childTasksImprovement = newChildTasks - oldChildTasks;
  if (childTasksImprovement < config.minChildTasksImprovement) {
    return {
      isValid: false,
      reason: `Amélioration child tasks ${childTasksImprovement} < minimum ${config.minChildTasksImprovement}`
    };
  }
  
  // Critère 3 : Améliorations documentées
  if (config.validateImprovements && improvements.length === 0) {
    return {
      isValid: false,
      reason: 'Aucune amélioration documentée alors que validateImprovements=true'
    };
  }
  
  return {
    isValid: true,
    reason: `Validation réussie : similarité ${similarityScore}%, +${childTasksImprovement} child tasks, ${improvements.length} améliorations`
  };
}

/**
 * Récupère la configuration depuis les variables d'environnement
 */
export function getParsingConfig(): ParsingConfig {
  return {
    useNewParsing: process.env.USE_NEW_PARSING === 'true',
    comparisonMode: process.env.PARSING_COMPARISON_MODE === 'true',
    logDifferences: process.env.LOG_PARSING_DIFFERENCES === 'true',
    similarityThreshold: parseInt(process.env.PARSING_SIMILARITY_THRESHOLD || DEFAULT_CONFIG.similarityThreshold.toString(), 10),
    validateImprovements: process.env.VALIDATE_IMPROVEMENTS === 'true' || DEFAULT_CONFIG.validateImprovements,
    minChildTasksImprovement: parseInt(process.env.MIN_CHILD_TASKS_IMPROVEMENT || DEFAULT_CONFIG.minChildTasksImprovement.toString(), 10),
  };
}

/**
 * Détermine quel système utiliser
 */
export function shouldUseNewParsing(): boolean {
  const config = getParsingConfig();
  return config.useNewParsing || config.comparisonMode;
}

/**
 * Détermine si on est en mode comparaison
 */
export function isComparisonMode(): boolean {
  return getParsingConfig().comparisonMode;
}

/**
 * Retourne la configuration par défaut
 */
export function getDefaultConfig(): ParsingConfig {
  return { ...DEFAULT_CONFIG };
}