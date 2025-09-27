/**
 * Service de décision d'indexation - Mécanisme d'idempotence et de checkpoint
 * Implémente la logique "shouldIndex" avec règles de skip anti-fuite
 */

import { ConversationSkeleton } from '../types/conversation.js';
import { 
    IndexingDecision, 
    IndexingState, 
    INDEX_VERSION_CURRENT, 
    DEFAULT_REINDEX_TTL_HOURS,
    MAX_RETRY_ATTEMPTS,
    RETRY_BACKOFF_BASE_MS
} from '../types/indexing.js';

export class IndexingDecisionService {
    private readonly forceReindex: boolean;
    private readonly indexVersion: string;

    constructor() {
        this.forceReindex = process.env.ROO_INDEX_FORCE === '1' || process.env.ROO_INDEX_FORCE === 'true';
        this.indexVersion = process.env.ROO_INDEX_VERSION || INDEX_VERSION_CURRENT;
    }

    /**
     * Décide si une tâche doit être indexée selon les règles d'idempotence
     */
    public shouldIndex(skeleton: ConversationSkeleton): IndexingDecision {
        const taskId = skeleton.taskId;
        const indexingState = skeleton.metadata.indexingState || {};
        const lastActivity = new Date(skeleton.metadata.lastActivity).getTime();
        const now = Date.now();

        // FORCE MODE : ignorer tous les skips
        if (this.forceReindex) {
            return {
                shouldIndex: true,
                reason: `FORCE_REINDEX mode activé (ROO_INDEX_FORCE=${process.env.ROO_INDEX_FORCE})`,
                action: 'index'
            };
        }

        // Migration d'index : version différente = réindexation nécessaire
        if (indexingState.indexVersion && indexingState.indexVersion !== this.indexVersion) {
            return {
                shouldIndex: true,
                reason: `Migration d'index requise (v${indexingState.indexVersion} → v${this.indexVersion})`,
                action: 'index'
            };
        }

        // SKIP : Échecs permanents (jusqu'à action manuelle)
        if (indexingState.indexStatus === 'failed') {
            return {
                shouldIndex: false,
                reason: `Échec permanent : ${indexingState.indexError || 'erreur non spécifiée'}`,
                action: 'skip'
            };
        }

        // RETRY avec backoff : tentatives limitées
        if (indexingState.indexStatus === 'retry') {
            const retryCount = indexingState.indexRetryCount || 0;
            
            if (retryCount >= MAX_RETRY_ATTEMPTS) {
                return {
                    shouldIndex: false,
                    reason: `Maximum de tentatives atteint (${retryCount}/${MAX_RETRY_ATTEMPTS})`,
                    action: 'skip'
                };
            }

            // Vérifier le backoff
            if (indexingState.lastIndexAttempt) {
                const lastAttempt = new Date(indexingState.lastIndexAttempt).getTime();
                const backoffDelay = this.calculateBackoffDelay(retryCount);
                const backoffUntil = lastAttempt + backoffDelay;

                if (now < backoffUntil) {
                    return {
                        shouldIndex: false,
                        reason: `Backoff actif, retry dans ${Math.round((backoffUntil - now) / 60000)}min`,
                        action: 'skip',
                        backoffUntil: new Date(backoffUntil).toISOString()
                    };
                }
            }

            return {
                shouldIndex: true,
                reason: `Retry n°${retryCount + 1}/${MAX_RETRY_ATTEMPTS} après backoff`,
                action: 'retry'
            };
        }

        // SKIP : Déjà indexé avec succès et dans le TTL
        if (indexingState.indexStatus === 'success') {
            // Vérifier le TTL de réindexation
            if (indexingState.nextReindexAfter) {
                const nextReindex = new Date(indexingState.nextReindexAfter).getTime();
                if (now < nextReindex) {
                    const hoursRemaining = Math.round((nextReindex - now) / (60 * 60 * 1000));
                    return {
                        shouldIndex: false,
                        reason: `TTL actif, réindexation dans ${hoursRemaining}h`,
                        action: 'skip'
                    };
                }
            }

            // Vérifier si le contenu a été modifié depuis la dernière indexation
            if (indexingState.lastIndexedAt) {
                const lastIndexed = new Date(indexingState.lastIndexedAt).getTime();
                if (lastActivity <= lastIndexed) {
                    return {
                        shouldIndex: false,
                        reason: `Contenu inchangé depuis dernière indexation (${indexingState.lastIndexedAt})`,
                        action: 'skip'
                    };
                }
            }
        }

        // SUPPORT RÉTROCOMPATIBILITÉ : Migration depuis qdrantIndexedAt
        if (!indexingState.indexStatus && skeleton.metadata.qdrantIndexedAt) {
            const legacyIndexed = new Date(skeleton.metadata.qdrantIndexedAt).getTime();
            if (lastActivity <= legacyIndexed) {
                return {
                    shouldIndex: false,
                    reason: `Migration legacy : contenu inchangé depuis ${skeleton.metadata.qdrantIndexedAt}`,
                    action: 'skip'
                };
            }
        }

        // PAR DÉFAUT : Indexation nécessaire
        return {
            shouldIndex: true,
            reason: indexingState.indexStatus ? 
                `Contenu modifié, réindexation requise` : 
                `Première indexation`,
            action: 'index'
        };
    }

    /**
     * Met à jour l'état d'indexation après un succès
     */
    public markIndexingSuccess(skeleton: ConversationSkeleton): void {
        const now = new Date().toISOString();
        const nextReindex = new Date(Date.now() + (DEFAULT_REINDEX_TTL_HOURS * 60 * 60 * 1000)).toISOString();

        if (!skeleton.metadata.indexingState) {
            skeleton.metadata.indexingState = {};
        }

        skeleton.metadata.indexingState = {
            ...skeleton.metadata.indexingState,
            lastIndexedAt: now,
            indexStatus: 'success',
            indexVersion: this.indexVersion,
            nextReindexAfter: nextReindex,
            lastIndexAttempt: now,
            // Nettoyer les champs d'erreur/retry
            indexError: undefined,
            indexRetryCount: undefined
        };

        // Migration : nettoyer l'ancien champ
        if (skeleton.metadata.qdrantIndexedAt) {
            delete skeleton.metadata.qdrantIndexedAt;
        }
    }

    /**
     * Met à jour l'état d'indexation après un échec
     */
    public markIndexingFailure(skeleton: ConversationSkeleton, error: string, isPermanent: boolean = false): void {
        const now = new Date().toISOString();

        if (!skeleton.metadata.indexingState) {
            skeleton.metadata.indexingState = {};
        }

        const currentRetryCount = skeleton.metadata.indexingState.indexRetryCount || 0;

        if (isPermanent || currentRetryCount >= MAX_RETRY_ATTEMPTS - 1) {
            // Échec permanent
            skeleton.metadata.indexingState = {
                ...skeleton.metadata.indexingState,
                indexStatus: 'failed',
                indexError: error,
                lastIndexAttempt: now,
                indexRetryCount: currentRetryCount + 1
            };
        } else {
            // Échec temporaire, programmer un retry
            skeleton.metadata.indexingState = {
                ...skeleton.metadata.indexingState,
                indexStatus: 'retry',
                indexError: error,
                lastIndexAttempt: now,
                indexRetryCount: currentRetryCount + 1
            };
        }
    }

    /**
     * Calcule le délai de backoff exponentiel avec jitter
     */
    private calculateBackoffDelay(retryCount: number): number {
        const baseDelay = RETRY_BACKOFF_BASE_MS;
        const exponentialDelay = baseDelay * Math.pow(2, retryCount);
        const jitter = Math.random() * 0.3 + 0.85; // 85-115% du délai
        return Math.floor(exponentialDelay * jitter);
    }

    /**
     * Réinitialise l'état d'indexation pour forcer une réindexation
     */
    public resetIndexingState(skeleton: ConversationSkeleton): void {
        if (skeleton.metadata.indexingState) {
            skeleton.metadata.indexingState = {
                indexVersion: this.indexVersion
            };
        }
        if (skeleton.metadata.qdrantIndexedAt) {
            delete skeleton.metadata.qdrantIndexedAt;
        }
    }

    /**
     * Migre l'ancien format qdrantIndexedAt vers le nouveau format
     */
    public migrateLegacyIndexingState(skeleton: ConversationSkeleton): boolean {
        if (!skeleton.metadata.indexingState && skeleton.metadata.qdrantIndexedAt) {
            const now = new Date().toISOString();
            const nextReindex = new Date(Date.now() + (DEFAULT_REINDEX_TTL_HOURS * 60 * 60 * 1000)).toISOString();

            skeleton.metadata.indexingState = {
                lastIndexedAt: skeleton.metadata.qdrantIndexedAt,
                indexStatus: 'success',
                indexVersion: this.indexVersion,
                nextReindexAfter: nextReindex,
                lastIndexAttempt: skeleton.metadata.qdrantIndexedAt
            };

            delete skeleton.metadata.qdrantIndexedAt;
            return true; // Migration effectuée
        }
        return false; // Pas de migration nécessaire
    }
}