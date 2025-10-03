/**
 * Configuration pour le système de parsing
 * Gère la bascule progressive vers le nouveau système MessageToSkeletonTransformer
 * 
 * 🚨 **ALERTE CRITIQUE POST-VALIDATION MASSIVE (2025-10-03)** 🚨
 * INCOMPATIBILITÉS MAJEURES DÉTECTÉES : 44.44% similarité vs 90% requis
 * 
 * ⛔ DÉPLOIEMENT SUSPENDU jusqu'à résolution Phase 2c
 * ⚠️  USE_NEW_PARSING=true INTERDIT en production
 * 📋 Voir: PHASE-2B-COMPATIBILITY-ALERT.md
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
 * 
 * 🔒 SÉCURISÉ SUITE À LA VALIDATION MASSIVE 🔒
 * Les incompatibilités critiques détectées imposent le verrouillage
 * sur l'ancien système jusqu'à résolution Phase 2c.
 */
const DEFAULT_CONFIG: ParsingConfig = {
  useNewParsing: false,        // 🔒 VERROUILLÉ - Incompatibilités critiques
  comparisonMode: false,       // 🔒 DÉSACTIVÉ - Production uniquement ancien système
  logDifferences: false,       // 🔒 DÉSACTIVÉ - Pas de logs différences en prod
  differenceTolerance: 5,      // ⚠️  INVALIDE - Seuil 90% requis non atteint (44.44%)
};

/**
 * 🚨 INDICATEUR CRITIQUE - Phase 2c Investigation Requise
 * Cette variable bloque l'activation du nouveau système
 * tant que les incompatibilités ne sont pas résolues
 */
const PHASE_2C_INVESTIGATION_REQUIRED = true;

/**
 * Récupère la configuration depuis les variables d'environnement
 * 
 * 🚨 SÉCURITÉ CRITIQUE : Bloque activation nouveau système
 * si Phase 2c investigation n'est pas terminée
 */
export function getParsingConfig(): ParsingConfig {
  // 🔒 SÉCURITÉ CRITIQUE - Bloquer nouveau système si investigation requise
  if (PHASE_2C_INVESTIGATION_REQUIRED) {
    console.warn('🚨 [PARSING-CONFIG] NOUVEAU SYSTÈME BLOQUÉ - Phase 2c investigation requise');
    console.warn('📋 Incompatibilités critiques : 44.44% similarité vs 90% requis');
    console.warn('⛔ Voir: PHASE-2B-COMPATIBILITY-ALERT.md pour détails');
    
    return {
      useNewParsing: false,           // 🔒 FORCÉ à false
      comparisonMode: false,          // 🔒 FORCÉ à false
      logDifferences: false,          // 🔒 FORCÉ à false
      differenceTolerance: 90,        // ⚠️  Seuil critique non atteint
    };
  }
  
  // Configuration normale (après résolution Phase 2c)
  return {
    useNewParsing: process.env.USE_NEW_PARSING === 'true',
    comparisonMode: process.env.PARSING_COMPARISON_MODE === 'true',
    logDifferences: process.env.LOG_PARSING_DIFFERENCES === 'true',
    differenceTolerance: parseInt(process.env.PARSING_DIFFERENCE_TOLERANCE || '5', 10),
  };
}

/**
 * Détermine quel système utiliser
 * 
 * 🚨 SÉCURITÉ CRITIQUE : Force ancien système tant que Phase 2c non résolue
 * @returns true si le nouveau système doit être utilisé
 */
export function shouldUseNewParsing(): boolean {
  // 🔒 SÉCURITÉ ABSOLUE - Phase 2c investigation requise
  if (PHASE_2C_INVESTIGATION_REQUIRED) {
    return false;  // 🔒 FORCÉ - Ancien système uniquement
  }
  
  const config = getParsingConfig();
  return config.useNewParsing || config.comparisonMode;
}

/**
 * Détermine si on est en mode comparaison
 * 
 * 🚨 SÉCURITÉ : Mode comparaison désactivé en production
 * @returns true si le mode comparaison est activé
 */
export function isComparisonMode(): boolean {
  // 🔒 SÉCURITÉ - Pas de comparaison en production tant que Phase 2c active
  if (PHASE_2C_INVESTIGATION_REQUIRED) {
    return false;  // 🔒 FORCÉ - Pas de mode comparaison
  }
  
  return getParsingConfig().comparisonMode;
}

/**
 * 🚨 NOUVELLE FONCTION - Vérifie si Phase 2c est terminée
 * @returns true si investigation terminée et système peut être réactivé
 */
export function isPhase2cComplete(): boolean {
  return !PHASE_2C_INVESTIGATION_REQUIRED;
}

/**
 * 🚨 NOUVELLE FONCTION - Retourne le statut de compatibilité système
 * @returns Objet avec détails de blocage
 */
export function getCompatibilityStatus(): {
  blocked: boolean;
  reason: string;
  similarityAchieved: number;
  similarityRequired: number;
  alertDocument: string;
} {
  return {
    blocked: PHASE_2C_INVESTIGATION_REQUIRED,
    reason: 'Incompatibilités comportementales majeures détectées lors validation massive',
    similarityAchieved: 44.44,
    similarityRequired: 90.0,
    alertDocument: 'mcps/internal/servers/roo-state-manager/docs/PHASE-2B-COMPATIBILITY-ALERT.md'
  };
}

/**
 * Retourne la configuration par défaut
 * @returns Configuration par défaut
 */
export function getDefaultConfig(): ParsingConfig {
  return { ...DEFAULT_CONFIG };
}