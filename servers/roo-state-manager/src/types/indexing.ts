/**
 * Types pour le mécanisme d'idempotence et de checkpoint de l'indexation
 */

export type IndexStatus = 'success' | 'retry' | 'failed' | 'skip';

export interface IndexingState {
    lastIndexedAt?: string;        // ISO datetime de dernière indexation réussie
    indexStatus?: IndexStatus;     // Statut granulaire d'indexation
    indexError?: string;           // Message d'erreur pour échecs permanents
    indexVersion?: string;         // Version d'index pour migrations
    nextReindexAfter?: string;     // ISO datetime pour TTL/rafraîchissement
    indexRetryCount?: number;      // Compteur de tentatives pour backoff
    lastIndexAttempt?: string;     // ISO datetime de dernière tentative (réussie ou non)
}

export interface IndexingDecision {
    shouldIndex: boolean;
    reason: string;
    action: 'skip' | 'index' | 'retry';
    backoffUntil?: string;
}

export interface IndexingMetrics {
    totalTasks: number;
    skippedTasks: number;
    indexedTasks: number;
    failedTasks: number;
    retryTasks: number;
    bandwidthSaved: number; // Estimation en octets
}

export const INDEX_VERSION_CURRENT = "1.0";
export const DEFAULT_REINDEX_TTL_HOURS = 168; // 7 jours
export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_BACKOFF_BASE_MS = 60000; // 1 minute base