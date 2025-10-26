/**
 * Types et interfaces pour le BaselineService - RooSync v2.1
 * 
 * Ce fichier définit toutes les structures de données nécessaires
 * pour l'architecture baseline-driven de RooSync v2.1
 */

/**
 * Configuration baseline complète (ancienne structure pour compatibilité)
 */
export interface BaselineConfig {
  machineId: string;
  config: {
    roo: {
      modes: string[];
      mcpSettings: Record<string, any>;
      userSettings: Record<string, any>;
    };
    hardware: {
      cpu: string;
      ram: string;
      disks: Array<{name: string; size: string}>;
      gpu?: string;
    };
    software: {
      powershell: string;
      node: string;
      python: string;
    };
    system: {
      os: string;
      architecture: string;
    };
  };
  lastUpdated: string;
  version: string;
}

/**
 * Configuration baseline fichier (nouvelle structure pour sync-config.ref.json)
 */
export interface BaselineFileConfig {
  version: string;
  baselineId: string;
  timestamp?: string;
  lastUpdated?: string;
  machineId: string;
  autoSync: boolean;
  conflictStrategy: string;
  logLevel: string;
  sharedStatePath: string;
  machines: Array<{
    id: string;
    name: string;
    hostname: string;
    os: string;
    architecture: string;
    lastSeen: string;
    roo: {
      modes: Array<any>;
      mcpServers: Array<any>;
      sdddSpecs: Array<any>;
    };
    hardware: {
      cpu: {
        cores: number;
        threads: number;
      };
      memory: {
        total: number;
      };
    };
    software: {
      node?: string;
      python?: string;
    };
  }>;
  syncTargets: Array<{
    name: string;
    localPath: string;
    remotePath: string;
    direction: string;
  }>;
  syncPaths: Array<{
    type: string;
    path: string;
    exclusions: string[];
  }>;
  decisions: Array<any>;
  messages: Array<any>;
}

/**
 * Différence détectée entre baseline et machine cible
 */
export interface BaselineDifference {
  category: 'config' | 'hardware' | 'software' | 'system';
  severity: 'CRITICAL' | 'IMPORTANT' | 'WARNING' | 'INFO';
  path: string;
  description: string;
  baselineValue: any;
  actualValue: any;
  recommendedAction: string;
}

/**
 * Rapport de comparaison baseline vs machine
 */
export interface BaselineComparisonReport {
  baselineMachine: string;
  targetMachine: string;
  baselineVersion: string;
  differences: BaselineDifference[];
  summary: {
    total: number;
    critical: number;
    important: number;
    warning: number;
    info: number;
  };
  generatedAt: string;
}

/**
 * Décision de synchronisation
 */
export interface SyncDecision {
  id: string;
  machineId: string;
  differenceId: string;
  category: string;
  description: string;
  baselineValue: any;
  targetValue: any;
  action: 'sync_to_baseline' | 'keep_target' | 'manual_review';
  severity: string;
  status: 'pending' | 'approved' | 'rejected' | 'applied';
  createdAt: string;
  updatedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  appliedAt?: string;
  notes?: string;
}

/**
 * Options de comparaison avec la baseline
 */
export interface CompareWithBaselineOptions {
  targetMachineId: string;
  forceRefresh?: boolean;
  severityThreshold?: 'CRITICAL' | 'IMPORTANT' | 'WARNING' | 'INFO';
  createDecisions?: boolean;
}

/**
 * Résultat de l'application d'une décision
 */
export interface DecisionApplicationResult {
  success: boolean;
  decisionId: string;
  appliedAt: string;
  message: string;
  error?: string;
}

/**
 * État du système BaselineService
 */
export interface BaselineServiceState {
  isBaselineLoaded: boolean;
  baselineMachine?: string;
  baselineVersion?: string;
  lastComparison?: string;
  pendingDecisions: number;
  approvedDecisions: number;
  appliedDecisions: number;
}

/**
 * Configuration du service BaselineService
 */
export interface BaselineServiceConfig {
  baselinePath: string;
  roadmapPath: string;
  cacheEnabled: boolean;
  cacheTTL: number; // en secondes
  logLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
}

/**
 * Métadonnées de validation humaine
 */
export interface HumanValidationMetadata {
  validatedBy: string;
  validatedAt: string;
  validationMethod: 'manual' | 'batch' | 'automatic';
  confidence: number; // 0-1
  comments?: string;
}

/**
 * Statistiques de comparaison
 */
export interface ComparisonStatistics {
  totalComparisons: number;
  successfulComparisons: number;
  failedComparisons: number;
  averageComparisonTime: number; // en millisecondes
  lastComparisonTime: string;
  mostCommonDifferences: Array<{
    category: string;
    count: number;
  }>;
}

/**
 * Événement de synchronisation
 */
export interface SyncEvent {
  id: string;
  type: 'comparison_started' | 'comparison_completed' | 'decision_created' | 'decision_approved' | 'decision_applied' | 'error';
  timestamp: string;
  machineId?: string;
  decisionId?: string;
  details: Record<string, any>;
}

/**
 * Filtres pour la recherche de décisions
 */
export interface DecisionFilter {
  machineId?: string;
  status?: SyncDecision['status'];
  severity?: SyncDecision['severity'];
  category?: string;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Rapport de validation humaine
 */
export interface ValidationReport {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  applied: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  lastUpdated: string;
}

/**
 * Configuration de l'inventaire machine
 */
export interface MachineInventory {
  machineId: string;
  timestamp: string;
  config: {
    roo: {
      modes: string[];
      mcpSettings: Record<string, any>;
      userSettings: Record<string, any>;
    };
    hardware: {
      cpu: string;
      ram: string;
      disks: Array<{name: string; size: string}>;
      gpu?: string;
    };
    software: {
      powershell: string;
      node: string;
      python: string;
    };
    system: {
      os: string;
      architecture: string;
    };
  };
  metadata: {
    collectionDuration: number; // en millisecondes
    source: 'local' | 'remote';
    collectorVersion: string;
  };
}

/**
 * Options de mise à jour de la baseline
 */
export interface UpdateBaselineOptions {
  validateBeforeUpdate: boolean;
  createBackup: boolean;
  backupRetentionDays: number;
  updateReason: string;
  updatedBy: string;
}

/**
 * Résultat de la mise à jour de baseline
 */
export interface BaselineUpdateResult {
  success: boolean;
  previousVersion?: string;
  newVersion: string;
  backupPath?: string;
  updatedAt: string;
  message: string;
  error?: string;
}

/**
 * Types d'erreurs spécifiques au BaselineService
 */
export class BaselineServiceError extends Error {
  public readonly code: string;
  public readonly details?: any;

  constructor(message: string, code: string, details?: any) {
    super(message);
    this.name = 'BaselineServiceError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Codes d'erreur BaselineService
 */
export enum BaselineServiceErrorCode {
  BASELINE_NOT_FOUND = 'BASELINE_NOT_FOUND',
  BASELINE_INVALID = 'BASELINE_INVALID',
  COMPARISON_FAILED = 'COMPARISON_FAILED',
  DECISION_NOT_FOUND = 'DECISION_NOT_FOUND',
  DECISION_INVALID_STATUS = 'DECISION_INVALID_STATUS',
  APPLICATION_FAILED = 'APPLICATION_FAILED',
  INVENTORY_COLLECTION_FAILED = 'INVENTORY_COLLECTION_FAILED',
  ROADMAP_UPDATE_FAILED = 'ROADMAP_UPDATE_FAILED'
}

/**
 * Interface pour le service de collection d'inventaire
 */
export interface IInventoryCollector {
  collectInventory(machineId: string, forceRefresh?: boolean): Promise<MachineInventory | null>;
}

/**
 * Interface pour le service de détection de différences
 */
export interface IDiffDetector {
  compareBaselineWithMachine(baseline: BaselineConfig, inventory: MachineInventory): Promise<BaselineDifference[]>;
}

/**
 * Interface pour le service de configuration
 */
export interface IConfigService {
  getSharedStatePath(): string;
  getBaselineServiceConfig(): BaselineServiceConfig;
}