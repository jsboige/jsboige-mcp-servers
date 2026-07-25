/**
 * Types pour le mécanisme d'idempotence et de checkpoint de l'indexation
 */

export type IndexStatus = 'success' | 'retry' | 'failed' | 'skip';

/**
 * #2766 S2+ Error class taxonomy for dead-letter routing.
 *
 * The S1 typed classifier (#882) emits `openai_error_type` strings on the
 * embedding response. We bucket those into 7 stable classes for the
 * dead-letter UI / triage workflow so operators can distinguish "needs a
 * key rotation" from "transient infra blip" at a glance.
 *
 * - `claude_session_not_found` / `file_not_found` / `access_denied` /
 *   `permission_denied` / `invalid_format` / `corrupted_data` /
 *   `quota_exceeded` / `auth_failed` → permanent (dead-letter, no retry)
 * - `network_timeout` / `service_503` / `rate_limit` / `connection_reset` /
 *   `dns_failure` / `embedding_timeout` / `unknown` → transient (retry
 *   with backoff, NEVER rotate key)
 *
 * Adding a new class = extend this union + classifyIndexingError() map +
 * tests. The status tool groups failed tasks by this field.
 */
export type IndexingErrorClass =
    | 'claude_session_not_found'
    | 'file_not_found'
    | 'access_denied'
    | 'permission_denied'
    | 'invalid_format'
    | 'corrupted_data'
    | 'quota_exceeded'
    | 'auth_failed'
    | 'network_timeout'
    | 'service_503'
    | 'rate_limit'
    | 'connection_reset'
    | 'dns_failure'
    | 'embedding_timeout'
    | 'unknown';

export interface IndexingState {
    lastIndexedAt?: string;        // ISO datetime de dernière indexation réussie
    indexStatus?: IndexStatus;     // Statut granulaire d'indexation
    indexError?: string;           // Message d'erreur pour échecs permanents
    /**
     * #2766 S2+: Stable error class taxonomy (see IndexingErrorClass).
     * Populated by classifyIndexingError() alongside indexError. Lets the
     * status tool cluster failed tasks by root-cause category instead of
     * dumping raw messages.
     */
    errorClass?: IndexingErrorClass;
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
 * #2766 S2+ P1 follow-up — single-source-of-truth for "this task is stuck in
 * retry-with-no-progress" detection. The status tool's failed_task_details
 * loop and the `cleanup_failed` action both need to identify retry-budget-
 * exhausted tasks (recoverable stale state from the pre-#886 livelock era,
 * not a true perm-fail). Without this helper, the `retryCount >= 3` magic
 * number was duplicated in two call-sites (NanoClaw review nit #1 of #887).
 *
 * Semantics: returns true iff indexStatus='retry' AND retryCount has hit
 * the MAX_RETRY_ATTEMPTS ceiling. Perm-failed tasks (`indexStatus='failed'`)
 * are NOT stuck-retry — they are operator-actionable and should be routed
 * via `cleanup_failed error_class=...`, not silently dropped.
 */
export function isStuckRetry(idx: IndexingState | undefined | null): boolean {
    if (!idx) return false;
    if (idx.indexStatus !== 'retry') return false;
    return (idx.indexRetryCount ?? 0) >= MAX_RETRY_ATTEMPTS;
}

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