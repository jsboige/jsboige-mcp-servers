/**
 * Architecture Consolidée Roo-State-Manager - Interfaces Unifiées
 * 
 * Implémentation des interfaces TypeScript unifiées pour les 32 outils réels
 * Basé sur l'audit complet et l'architecture consolidée
 */

import { z } from 'zod';

/**
 * Catégories validées par l'audit (5 catégories pour 32 outils)
 */
export enum ToolCategory {
  DISPLAY = 'display',
  SEARCH = 'search',
  SUMMARY = 'summary',
  EXPORT = 'export',
  UTILITY = 'utility'
}

/**
 * Niveau de traitement selon l'architecture 2-niveaux découverte
 */
export enum ProcessingLevel {
  IMMEDIATE = 'immediate',
  BACKGROUND = 'background',
  MIXED = 'hybrid'
}

/**
 * Presets intelligents couvrant 90% des cas d'usage des 32 outils
 */
export enum DisplayPreset {
  QUICK_OVERVIEW = 'quick',
  DETAILED_ANALYSIS = 'detailed',
  SEARCH_RESULTS = 'search',
  EXPORT_FORMAT = 'export',
  TREE_NAVIGATION = 'tree'
}

/**
 * Stratégies de cache basées sur le Cache Anti-Fuite (220GB protection)
 */
export type CacheStrategy = 'aggressive' | 'moderate' | 'conservative' | 'bypass';

/**
 * Contrat unifié pour tous les outils roo-state-manager
 * Implémente les patterns découverts dans l'audit documentaire
 */
export interface UnifiedToolContract<TInput = any, TOutput = any> {
  /** Nom de l'outil (conforme aux 32 outils réels identifiés) */
  name: string;
  
  /** Catégorie fonctionnelle (5 catégories validées) */
  category: ToolCategory;
  
  /** Schéma d'entrée avec validation Zod */
  inputSchema: z.ZodSchema<TInput>;
  
  /** Méthode d'exécution avec contexte unifié */
  execute(input: TInput, context: ExecutionContext): Promise<ToolResult<TOutput>>;
  
  /** Niveau de traitement (Architecture 2-Niveaux découverte) */
  processingLevel: ProcessingLevel;
  
  /** Configuration de cache (Cache Anti-Fuite intégré) */
  cacheConfig?: CacheConfiguration;
  
  /** Stratégie d'export (réutilise Strategy Pattern existant) */
  exportStrategy?: ExportStrategy;

  /** Description pour la documentation auto-générée */
  description: string;

  /** Version pour la backward compatibility */
  version: string;
}

/**
 * Contexte d'exécution unifié intégrant patterns découverts
 * Réutilise la Dependency Injection existante
 */
export interface ExecutionContext {
  /** Services DI (réutilise architecture modulaire existante) */
  services: UnifiedServices;
  
  /** Configuration workspace (harmonisé sur tous les 32 outils) */
  workspace?: string;
  
  /** Métadonnées de sécurité et validation */
  security: SecurityContext;
  
  /** Monitoring 2-niveaux (architecture découverte) */
  monitoring: {
    immediate: IMonitoringService;
    background: IBackgroundMonitoringService;
  };

  /** Cache Anti-Fuite manager (protection 220GB) */
  cacheManager: ICacheAntiLeakManager;

  /** User context pour la traçabilité */
  user?: UserContext;
}

/**
 * Services unifiés avec Dependency Injection
 * Basé sur l'architecture modulaire existante découverte
 */
export interface UnifiedServices {
  storage: IStorageService;
  cache: ICacheAntiLeakService;
  search: ISearchService;
  export: IExportService;
  summary: ISummaryService;
  display: IDisplayService;
  utility: IUtilityService;
}

/**
 * Résultat unifié avec gestion d'erreurs gracieuse
 * Pattern découvert dans l'analyse des outils existants
 */
export interface ToolResult<T> {
  /** Succès de l'opération */
  success: boolean;
  
  /** Données de résultat */
  data?: T;
  
  /** Erreur avec fallback gracieux */
  error?: {
    code: string;
    message: string;
    fallback?: T;
    recovery?: RecoveryStrategy;
    details?: any;
  };
  
  /** Métadonnées de performance (Architecture 2-niveaux) */
  metrics: {
    executionTime: number;
    cacheHit?: boolean;
    processingLevel: ProcessingLevel;
    memoryUsage?: number;
    qdrantCalls?: number;
  };

  /** Métadonnées de validation et traçabilité */
  metadata?: {
    toolVersion: string;
    timestamp: number;
    requestId?: string;
    workspace?: string;
  };
}

/**
 * Configuration de cache avec Anti-Fuite
 * Réutilise les seuils découverts (24h consistency, 4h reindex)
 */
export interface CacheConfiguration {
  strategy: CacheStrategy;
  ttl: number; // Time to live en millisecondes
  maxSize?: number; // Taille max pour protection 220GB
  consistencyCheck?: boolean;
  reindexThreshold?: number; // 4h minimum découvert
}

/**
 * Stratégie d'export (réutilise Strategy Pattern découvert)
 */
export interface ExportStrategy {
  format: 'json' | 'csv' | 'xml' | 'markdown' | 'trace_summary' | 'cluster_summary';
  variant?: string;
  options?: Record<string, any>;
}

/**
 * Contexte de sécurité et validation
 */
export interface SecurityContext {
  validateInput: boolean;
  sanitizeOutput: boolean;
  allowedWorkspaces?: string[];
  rateLimit?: {
    maxRequests: number;
    windowMs: number;
  };
}

/**
 * Stratégie de récupération d'erreur
 */
export interface RecoveryStrategy {
  type: 'retry' | 'fallback' | 'skip';
  attempts?: number;
  delay?: number;
  fallbackTool?: string;
}

/**
 * Contexte utilisateur pour traçabilité
 */
export interface UserContext {
  id?: string;
  session?: string;
  preferences?: Record<string, any>;
}

// ===============================
// Services Interfaces (DI)
// ===============================

export interface IStorageService {
  detectRooStorage(): Promise<string[]>;
  getStorageStats(): Promise<any>;
  getConversationSkeleton(taskId: string): Promise<any>;
}

export interface ICacheAntiLeakService {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, config: CacheConfiguration): Promise<void>;
  clear(pattern?: string): Promise<void>;
  getStats(): Promise<any>;
}

export interface ISearchService {
  searchTasksSemantic(query: string, options?: any): Promise<any>;
  indexTask(taskId: string): Promise<void>;
}

export interface IExportService {
  export(format: string, data: any, options?: any): Promise<any>;
}

export interface ISummaryService {
  generateTraceSummary(taskId: string, options?: any): Promise<any>;
  generateClusterSummary(rootTaskId: string, options?: any): Promise<any>;
  getConversationSynthesis(taskId: string): Promise<any>;
}

export interface IDisplayService {
  viewConversationTree(taskId: string, options?: any): Promise<any>;
  getTaskTree(conversationId: string, options?: any): Promise<any>;
  listConversations(options?: any): Promise<any>;
  viewTaskDetails(taskId: string, options?: any): Promise<any>;
}

export interface IUtilityService {
  rebuildSkeletonCache(options?: any): Promise<any>;
  manageMcpSettings(action: string, options?: any): Promise<any>;
  readVscodeLogs(options?: any): Promise<any>;
}

export interface IMonitoringService {
  recordExecution(execution: ExecutionRecord): Promise<void>;
  getMetrics(): Promise<any>;
}

export interface IBackgroundMonitoringService extends IMonitoringService {
  recordBackground(task: BackgroundTask): Promise<void>;
}

export interface ICacheAntiLeakManager {
  get<T>(key: string): Promise<CacheResult<T> | null>;
  store<T>(key: string, data: T, strategy: CacheStrategy): Promise<void>;
  evictOldEntries(): Promise<void>;
  getTotalSize(): number;
}

// ===============================
// Supporting Types
// ===============================

export interface ExecutionRecord {
  tool: string;
  category: ToolCategory;
  executionTime: number;
  processingLevel: ProcessingLevel;
  cached: boolean;
  success: boolean;
  timestamp: number;
}

export interface BackgroundTask {
  id: string;
  tool: string;
  params: any;
  enqueuedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface CacheResult<T> {
  hit: boolean;
  data: T;
  timestamp?: number;
}

// ===============================
// API Gateway Types
// ===============================

/**
 * Options d'affichage pour l'API Gateway unifiée
 * Intègre tous les paramètres identifiés dans l'audit des 32 outils
 */
export interface DisplayOptions {
  /** Troncature des contenus longs (0 = pas de troncature) */
  truncate?: number;
  
  /** Nombre maximum de résultats */
  maxResults?: number;
  
  /** Niveau de détail (skeleton, summary, full) */
  detailLevel?: 'skeleton' | 'summary' | 'full';
  
  /** Inclure le contenu complet */
  includeContent?: boolean;
  
  /** Format de sortie */
  outputFormat?: 'json' | 'csv' | 'xml' | 'markdown' | 'html';
  
  /** Options d'export */
  prettyPrint?: boolean;
  includeCss?: boolean;
  
  /** Diagnostic de l'index */
  diagnoseIndex?: boolean;
  
  /** Force la reconstruction */
  forceRebuild?: boolean;
  force_rebuild?: boolean;
  
  /** Sauvegarde automatique */
  backup?: boolean;
  
  /** Index de début pour plage */
  startIndex?: number;
  
  /** Index de fin pour plage */
  endIndex?: number;
  
  // === Paramètres de recherche ===
  /** Requête de recherche sémantique */
  searchQuery?: string;
  query?: string;
  
  // === Identifiants des entités ===
  /** ID de la tâche */
  taskId?: string;
  /** ID de conversation */
  conversationId?: string;
  /** ID de la tâche racine */
  rootTaskId?: string;
  
  // === Navigation et hiérarchie ===
  /** Profondeur maximale */
  maxDepth?: number;
  /** Mode d'affichage */
  viewMode?: 'single' | 'chain' | 'cluster';
  /** Inclure les tâches sœurs */
  includeSiblings?: boolean;
  
  // === Filtres et tri ===
  /** Critère de tri */
  sortBy?: 'lastActivity' | 'messageCount' | 'totalSize';
  /** Ordre de tri */
  sortOrder?: 'asc' | 'desc';
  /** Filtre par workspace */
  workspace?: string;
  /** Filtre API history */
  hasApiHistory?: boolean;
  /** Filtre messages UI */
  hasUiMessages?: boolean;
  
  // === Export et synthèse ===
  /** Chemin de sauvegarde */
  filePath?: string;
  file_path?: string;
  /** Variante JSON */
  jsonVariant?: 'light' | 'full';
  /** Variante CSV */
  csvVariant?: 'conversations' | 'messages' | 'tools';
  /** Troncature en caractères */
  truncationChars?: number;
  /** Stats compactes */
  compactStats?: boolean;
  /** Générer table des matières */
  generateToc?: boolean;
  
  // === Mode simulation ===
  /** Mode dry run */
  dryRun?: boolean;
  dry_run?: boolean;
}

/**
 * Résultat d'affichage unifié
 */
export interface DisplayResult {
  /** Succès de l'opération */
  success: boolean;
  
  /** Données de résultat */
  data?: any;
  
  /** Métadonnées */
  metadata?: {
    processingLevel?: ProcessingLevel;
    executionTime?: Date;
    toolsCount?: number;
    estimatedCompletionTime?: Date;
  };
  
  /** Erreurs rencontrées */
  errors?: string[];
}

/**
 * Résultat de validation
 */
export interface ValidationResult {
  /** Validation réussie */
  isValid: boolean;
  
  /** Liste des erreurs de validation */
  errors: string[];
  
  /** Avertissements non bloquants */
  warnings?: string[];
}

/**
 * Configuration Cache Anti-Fuite
 */
export interface CacheAntiLeakConfig {
  /** Trafic maximum en GB (protection 220GB) */
  maxTrafficGB: number;
  
  /** Intervalle de vérification de cohérence en heures */
  consistencyCheckHours: number;
  
  /** Intervalle minimum de réindexation en heures */
  minReindexIntervalHours: number;
  
  /** Cache activé */
  enabled: boolean;
  
  /** Alertes et seuils */
  alerts: {
    memoryThresholdGB: number;
    processingTimeoutMs: number;
  };
}