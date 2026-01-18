/**
 * Types pour le Commit Log Service
 *
 * Ce fichier définit les types et interfaces pour le service de commit log
 * qui garantit la cohérence distribuée entre les machines RooSync.
 *
 * @module CommitLogTypes
 * @version 1.0.0
 */

/**
 * Types d'entrées dans le commit log
 */
export enum CommitEntryType {
  DECISION = 'decision',      // Décision de synchronisation
  CONFIG = 'config',          // Changement de configuration
  BASELINE = 'baseline',      // Mise à jour de baseline
  HEARTBEAT = 'heartbeat',    // Événement de heartbeat
  SYSTEM = 'system'           // Événement système
}

/**
 * Statut d'une entrée de commit
 */
export enum CommitStatus {
  PENDING = 'pending',        // En attente d'application
  APPLIED = 'applied',        // Appliquée avec succès
  FAILED = 'failed',          // Échec d'application
  ROLLED_BACK = 'rolled_back' // Annulée (rollback)
}

/**
 * Entrée de commit log
 */
export interface CommitEntry {
  /** Numéro de séquence unique (auto-incrémenté) */
  sequenceNumber: number;
  
  /** Type de l'entrée */
  type: CommitEntryType;
  
  /** Identifiant de la machine qui a créé l'entrée */
  machineId: string;
  
  /** Timestamp de création */
  timestamp: string;
  
  /** Statut de l'entrée */
  status: CommitStatus;
  
  /** Données de l'entrée (structure selon le type) */
  data: CommitEntryData;
  
  /** Hash de l'entrée pour vérification d'intégrité */
  hash: string;
  
  /** Signature optionnelle pour authentification */
  signature?: string;
  
  /** Métadonnées supplémentaires */
  metadata?: {
    parentId?: number;        // Entrée parente (pour dépendances)
    retryCount?: number;      // Nombre de tentatives
    lastError?: string;       // Dernière erreur
    appliedAt?: string;       // Timestamp d'application
    appliedBy?: string;       // Machine qui a appliqué
  };
}

/**
 * Données de l'entrée selon le type
 */
export type CommitEntryData = 
  | DecisionCommitData
  | ConfigCommitData
  | BaselineCommitData
  | HeartbeatCommitData
  | SystemCommitData;

/**
 * Données pour une décision de synchronisation
 */
export interface DecisionCommitData {
  /** Identifiant de la décision */
  decisionId: string;
  
  /** Type de décision */
  decisionType: 'apply' | 'rollback' | 'approve' | 'reject';
  
  /** Cible de la décision */
  target: {
    machineId?: string;
    configPath?: string;
    baselineId?: string;
  };
  
  /** Paramètres de la décision */
  parameters?: Record<string, any>;
}

/**
 * Données pour un changement de configuration
 */
export interface ConfigCommitData {
  /** Chemin du fichier de configuration */
  configPath: string;
  
  /** Type de changement */
  changeType: 'create' | 'update' | 'delete';
  
  /** Contenu de la configuration (si applicable) */
  content?: any;
  
  /** Diff du changement (si applicable) */
  diff?: {
    before?: any;
    after?: any;
  };
}

/**
 * Données pour une mise à jour de baseline
 */
export interface BaselineCommitData {
  /** Identifiant de la baseline */
  baselineId: string;
  
  /** Type de mise à jour */
  updateType: 'create' | 'update' | 'migrate';
  
  /** Version de la baseline */
  version: string;
  
  /** Machine source de la baseline */
  sourceMachineId: string;
}

/**
 * Données pour un événement de heartbeat
 */
export interface HeartbeatCommitData {
  /** Statut de la machine */
  status: 'online' | 'offline' | 'warning';
  
  /** Métadonnées du heartbeat */
  metadata?: {
    uptime?: number;
    load?: number;
    memory?: number;
  };
}

/**
 * Données pour un événement système
 */
export interface SystemCommitData {
  /** Type d'événement système */
  eventType: 'startup' | 'shutdown' | 'error' | 'maintenance';
  
  /** Message de l'événement */
  message: string;
  
  /** Détails de l'événement */
  details?: Record<string, any>;
}

/**
 * État du Commit Log Service
 */
export interface CommitLogState {
  /** Numéro de séquence actuel */
  currentSequenceNumber: number;
  
  /** Entrées de commit par numéro de séquence */
  entries: Map<number, CommitEntry>;
  
  /** Entrées par statut */
  entriesByStatus: {
    pending: number[];
    applied: number[];
    failed: number[];
    rolledBack: number[];
  };
  
  /** Statistiques */
  statistics: {
    totalEntries: number;
    pendingEntries: number;
    appliedEntries: number;
    failedEntries: number;
    rolledBackEntries: number;
    lastCommitTimestamp: string;
    lastAppliedTimestamp: string;
  };
  
  /** Métadonnées du service */
  metadata: {
    version: string;
    createdAt: string;
    lastUpdated: string;
    machineId: string;
  };
}

/**
 * Configuration du Commit Log Service
 */
export interface CommitLogConfig {
  /** Chemin vers le répertoire du commit log */
  commitLogPath: string;
  
  /** Intervalle de synchronisation automatique (ms) */
  syncInterval: number;
  
  /** Nombre maximum d'entrées à conserver */
  maxEntries: number;
  
  /** Nombre maximum de tentatives pour une entrée échouée */
  maxRetryAttempts: number;
  
  /** Délai entre les tentatives (ms) */
  retryDelay: number;
  
  /** Activer la compression des entrées anciennes */
  enableCompression: boolean;
  
  /** Âge maximum avant compression (ms) */
  compressionAge: number;
  
  /** Activer la signature des entrées */
  enableSigning: boolean;
  
  /** Algorithme de hashage */
  hashAlgorithm: 'sha256' | 'sha512';
}

/**
 * Résultat d'ajout d'une entrée
 */
export interface AppendCommitResult {
  /** Succès de l'opération */
  success: boolean;
  
  /** Numéro de séquence assigné */
  sequenceNumber?: number;
  
  /** Hash de l'entrée */
  hash?: string;
  
  /** Message d'erreur si échec */
  error?: string;
}

/**
 * Résultat de récupération d'entrées
 */
export interface GetCommitsResult {
  /** Entrées récupérées */
  entries: CommitEntry[];
  
  /** Nombre total d'entrées */
  totalCount: number;
  
  /** Indicateur de pagination */
  hasMore: boolean;
  
  /** Prochain numéro de séquence */
  nextSequenceNumber?: number;
}

/**
 * Résultat de vérification de cohérence
 */
export interface ConsistencyCheckResult {
  /** Cohérence globale */
  isConsistent: boolean;
  
  /** Entrées incohérentes */
  inconsistentEntries: Array<{
    sequenceNumber: number;
    issue: string;
    severity: 'low' | 'medium' | 'high';
  }>;
  
  /** Recommandations */
  recommendations: string[];
  
  /** Statistiques de cohérence */
  statistics: {
    totalEntries: number;
    consistentEntries: number;
    inconsistentEntries: number;
    consistencyRate: number;
  };
}

/**
 * Résultat d'application d'une entrée
 */
export interface ApplyCommitResult {
  /** Succès de l'application */
  success: boolean;
  
  /** Numéro de séquence appliqué */
  sequenceNumber: number;
  
  /** Timestamp d'application */
  appliedAt: string;
  
  /** Message d'erreur si échec */
  error?: string;
  
  /** Détails de l'application */
  details?: {
    operation: string;
    duration: number;
    affectedFiles?: string[];
  };
}
