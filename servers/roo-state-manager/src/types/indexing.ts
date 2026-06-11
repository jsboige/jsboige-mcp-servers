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
    action: 'skip' | 'index' | 'retry' | 'rebuild';
    backoffUntil?: string;
    requiresSave?: boolean; // 🆕 Flag pour signaler qu'une sauvegarde est nécessaire (migration legacy)
}

export interface IndexingMetrics {
    totalTasks: number;
    skippedTasks: number;
    indexedTasks: number;
    failedTasks: number;
    retryTasks: number;
    bandwidthSaved: number; // Estimation en octets
    lastIndexedAt?: string; // ISO datetime of last successful indexing
}

export const INDEX_VERSION_CURRENT = "1.2"; // #2455: bump to trigger fleet-wide reindex for workspace_name propagation
export const DEFAULT_REINDEX_TTL_HOURS = 168; // 7 jours
export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_BACKOFF_BASE_MS = 60000; // 1 minute base

/**
 * Rebuild backoff — applied ONLY when a task is re-indexed because of an
 * index-version migration (decision.action === 'rebuild'). Uniform random
 * jitter [MIN, MAX] in milliseconds is awaited BEFORE processing the task.
 *
 * Goals:
 *  - Avoid the thundering-herd pattern across a fleet of MCP instances all
 *    bumped to the same INDEX_VERSION_CURRENT at the same time (cf. the
 *    embedding-service hammering incident around 2026-05-09).
 *  - Cap fleet-wide load on the shared embedding API while still completing
 *    the rebuild in a few days, not weeks.
 *
 * Defaults sized for ~28K tasks/machine, 6-machine fleet, mean 7s/task ⇒
 * ~2.3 days/machine end-to-end with ~8.6 req/s fleet load on embeddings —
 * roughly 10× below the observed crisis level. Override via env vars
 * ROO_INDEX_REBUILD_BACKOFF_MIN_MS / ROO_INDEX_REBUILD_BACKOFF_MAX_MS.
 */
export const REBUILD_BACKOFF_MIN_MS_DEFAULT = 2000;
export const REBUILD_BACKOFF_MAX_MS_DEFAULT = 12000;