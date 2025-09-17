/**
 * Modèles de données pour le système de synthèse de conversations v3
 * 
 * Ce module définit les structures de données pour le système de synthèse
 * intégrant la construction de contexte narratif récursif.
 * 
 * Patterns respectés :
 * - PascalCase pour les interfaces
 * - camelCase pour les propriétés  
 * - JSDoc complet pour toutes les interfaces
 * - Rétrocompatibilité avec les types existants
 * 
 * @author Roo Code v4 - SDDD Phase 1
 * @version 3.0.0
 */

// =============================================================================
// EXTENSIONS DES TYPES EXISTANTS
// =============================================================================

/**
 * Métadonnées de synthèse intégrées au ConversationSkeleton existant.
 * Optimisé pour le lazy loading et l'efficacité mémoire.
 */
export interface SynthesisMetadata {
  /** État actuel de la synthèse pour cette conversation */
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  
  /** Résumé très court (1-2 phrases) idéal pour les aperçus */
  headline: string;
  
  /** Chemin vers le fichier d'analyse détaillée */
  analysisFilePath: string; // ex: ".skeletons/synthesis/atomic/task-123.json"

  /** 
   * Pointeur optionnel vers un lot de synthèse condensée.
   * Si présent, le NarrativeContextBuilder l'utilise à la place
   * du fichier d'analyse atomique pour économiser le contexte.
   */
  condensedBatchPath?: string; // ex: ".skeletons/synthesis/batches/batch-abc.json"

  /** Timestamp de la dernière mise à jour (ISO 8601) */
  lastUpdated: string;
}

// =============================================================================
// MODÈLES DE SYNTHÈSE ATOMIQUE
// =============================================================================

/**
 * Trace la provenance du contexte utilisé pour une synthèse.
 * Permet la traçabilité et le debug des contextes narratifs.
 *
 * ARCHITECTURE V3 : Étendu pour supporter le parcours topologique complet
 */
export interface ContextTrace {
  /** ID de la tâche racine de la conversation */
  rootTaskId: string;
  
  /** ID de la tâche parent directe (optionnel) */
  parentTaskId?: string;
  
  /** Liste des tâches sœurs précédentes incluses dans le contexte initial */
  previousSiblingTaskIds: string[];
  
  /** Contextes des tâches parentes collectées dans l'ordre topologique */
  parentContexts?: Array<{
    taskId: string;
    synthesisType: 'atomic' | 'condensed' | 'generated_on_demand';
    summary: string;
    includedInContext: boolean;
  }>;
  
  /** Contextes des tâches sœurs collectées dans l'ordre chronologique */
  siblingContexts?: Array<{
    taskId: string;
    synthesisType: 'atomic' | 'condensed' | 'generated_on_demand';
    summary: string;
    includedInContext: boolean;
  }>;
  
  /** Contextes des tâches enfants collectées (synthèses finales) */
  childContexts?: Array<{
    taskId: string;
    synthesisType: 'atomic' | 'condensed' | 'generated_on_demand';
    summary: string;
    includedInContext: boolean;
  }>;
  
  /** Lots de synthèse condensée utilisés pendant la construction */
  condensedBatches?: Array<{
    batchId: string;
    sourceTaskIds: string[];
    batchSummary: string;
    usedInContext: boolean;
  }>;
  
  /** Type de synthèse générée pour cette tâche */
  synthesisType?: 'atomic' | 'condensed' | 'generated_on_demand';
}

/**
 * Section de synthèse narrative incrémentale.
 * Sépare le contexte amont de la synthèse de la tâche actuelle.
 */
export interface SynthesisNarrative {
  /** 
   * Synthèse du contexte narratif AMONT (parents, frères).
   * C'est le préambule fourni au LLM avant d'analyser la tâche actuelle.
   * Calculé par le NarrativeContextBuilderService.
   */
  initialContextSummary: string;

  /** 
   * Synthèse de la tâche actuelle, peut inclure les synthèses finales de ses enfants.
   * C'est le résultat final de l'analyse de CETTE tâche.
   */
  finalTaskSummary: string;
}

/**
 * Modèle représentant la synthèse détaillée d'UNE seule conversation.
 * Restructuré pour supporter la synthèse incrémentale et la traçabilité.
 */
export interface ConversationAnalysis {
  // === Métadonnées de l'analyse ===
  /** ID unique de la tâche analysée */
  taskId: string;
  
  /** Version du moteur d'analyse utilisé */
  analysisEngineVersion: string;
  
  /** Timestamp de création de cette analyse (ISO 8601) */
  analysisTimestamp: string;
  
  /** Identifiant du modèle LLM utilisé */
  llmModelId: string;
  
  // === Traçabilité du contexte ===
  /** Trace la provenance du contexte utilisé pour cette synthèse */
  contextTrace: ContextTrace;

  // === Sections d'analyse structurée ===
  /** Objectifs identifiés dans la conversation */
  objectives: Record<string, any>;
  
  /** Stratégie observée dans l'approche */
  strategy: Record<string, any>;
  
  /** Évaluation qualitative de la conversation */
  quality: Record<string, any>;
  
  /** Métriques quantitatives calculées */
  metrics: Record<string, any>;

  // === Synthèse narrative incrémentale ===
  /** Section de synthèse narrative avec contexte et résumé final */
  synthesis: SynthesisNarrative;
}

// =============================================================================
// MODÈLES DE SYNTHÈSE PAR LOTS
// =============================================================================

/**
 * Modèle représentant une "synthèse de synthèses".
 * Créé dynamiquement par le NarrativeContextBuilderService quand 
 * la taille du contexte narratif dépasse un certain seuil.
 */
export interface CondensedSynthesisBatch {
  /** Identifiant unique du lot (UUID) */
  batchId: string;
  
  /** Timestamp de création du lot (ISO 8601) */
  creationTimestamp: string;
  
  /** Modèle utilisé pour condenser les synthèses */
  llmModelId: string;

  /** La synthèse de haut niveau du lot */
  batchSummary: string;

  /** 
   * Liste des IDs des tâches dont les synthèses atomiques ont été incluses
   * et sont maintenant représentées par ce lot.
   */
  sourceTaskIds: string[];
}

// =============================================================================
// MODÈLES DE TRAITEMENT PAR LOTS
// =============================================================================

/**
 * Configuration de filtrage des tâches à traiter dans un lot.
 * Extensible pour supporter différents critères de sélection.
 */
export interface TaskFilter {
  /** Workspace spécifique à filtrer (ex: "d:/dev/project-foo") */
  workspace?: string;
  
  /** Liste explicite d'IDs de tâches à traiter */
  taskIds?: string[];
  
  /** Date de début pour filtrer par période (ISO 8601) */
  startDate?: string;
  
  /** Date de fin pour filtrer par période (ISO 8601) */
  endDate?: string;
  
  /** Fichiers de contexte externe personnalisé */
  customContextPrefixFiles?: string[];
}

/**
 * Configuration complète d'un traitement par lots.
 * Contrôle tous les aspects du processus de synthèse.
 */
export interface BatchSynthesisConfig {
  /** Filtres pour sélectionner les tâches à traiter */
  taskFilter: TaskFilter;
  
  /** Nombre maximum de synthèses à traiter en parallèle */
  maxConcurrency: number;
  
  /** Identifiant du modèle LLM à utiliser */
  llmModelId: string;
  
  /** Si true, écrase les synthèses existantes */
  overwriteExisting: boolean;
}

/**
 * Statistiques de progression d'un traitement par lots.
 * Permet le suivi en temps réel des opérations.
 */
export interface BatchProgress {
  /** Nombre total de tâches à traiter */
  totalTasks: number;
  
  /** Nombre de tâches complétées avec succès */
  completedTasks: number;
  
  /** Nombre de tâches en échec */
  failedTasks: number;
  
  /** Nombre de tâches actuellement en cours de traitement */
  inProgressTasks: number;
  
  /** Pourcentage de completion (0-100) */
  completionPercentage: number;
}

/**
 * Résultats détaillés d'un traitement par lots.
 * Agrège les informations de toutes les tâches traitées.
 */
export interface BatchResults {
  /** Nombre total de synthèses créées */
  synthesisCount: number;
  
  /** Nombre total d'erreurs rencontrées */
  errorCount: number;
  
  /** Liste des erreurs détaillées pour le debug */
  errors: Array<{
    taskId: string;
    error: string;
    timestamp: string;
  }>;
  
  /** Chemins des fichiers de sortie générés */
  outputFiles: string[];
}

/**
 * Représentation complète d'une tâche de traitement par lots.
 * Mis à jour pour inclure la nouvelle option de contexte préfixe.
 */
export interface BatchSynthesisTask {
  /** Identifiant unique du lot */
  batchId: string;
  
  /** État actuel du traitement */
  status: 'queued' | 'running' | 'completed' | 'failed';
  
  /** Timestamp de début du traitement (ISO 8601) */
  startTime: string;
  
  /** Timestamp de fin du traitement (ISO 8601, optionnel) */
  endTime?: string;

  /** Configuration complète du traitement */
  config: BatchSynthesisConfig;
  
  /** Statistiques de progression en temps réel */
  progress: BatchProgress;
  
  /** Liste des IDs des tâches correspondant au filtre */
  taskIds: string[];
  
  /** Résultats détaillés du traitement */
  results: BatchResults;
}

// =============================================================================
// TYPES AUXILIAIRES ET UTILITAIRES
// =============================================================================

/**
 * États possibles d'une synthèse individuelle.
 * Utilisé pour le suivi granulaire des opérations.
 */
export type SynthesisStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Niveaux de priorité pour le traitement des synthèses.
 * Permet l'ordonnancement intelligent des tâches.
 */
export type SynthesisPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * Options de configuration pour la génération de contexte narratif.
 * Contrôle le comportement du NarrativeContextBuilderService.
 */
export interface ContextBuildingOptions {
  /** Profondeur maximale de remontée dans l'arbre des tâches */
  maxDepth: number;
  
  /** Taille maximale du contexte en caractères avant condensation */
  maxContextSize: number;
  
  /** Si true, inclut les tâches sœurs dans le contexte */
  includeSiblings: boolean;
  
  /** Si true, inclut les synthèses des tâches enfants */
  includeChildrenSyntheses: boolean;
}

/**
 * Résultat de la construction de contexte narratif.
 * Retourné par le NarrativeContextBuilderService.
 */
export interface ContextBuildingResult {
  /** Le contexte narratif construit */
  contextSummary: string;
  
  /** Trace de la construction pour le debug */
  buildTrace: ContextTrace;
  
  /** Si true, le contexte a été condensé pour économiser l'espace */
  wasCondensed: boolean;
  
  /** Chemin vers le lot condensé utilisé (si applicable) */
  condensedBatchPath?: string;
}

/**
 * Options pour l'exportation des résultats de synthèse.
 * Supporté par les outils MCP d'export.
 */
export interface ExportOptions {
  /** Format de sortie désiré */
  format: 'json' | 'markdown' | 'html' | 'csv';
  
  /** Si true, inclut les métadonnées détaillées */
  includeMetadata: boolean;
  
  /** Si true, inclut les traces de contexte pour le debug */
  includeTraces: boolean;
  
  /** Niveau de détail de l'export */
  detailLevel: 'summary' | 'detailed' | 'full';
}