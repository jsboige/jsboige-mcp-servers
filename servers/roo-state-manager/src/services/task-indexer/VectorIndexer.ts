import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Schemas } from '@qdrant/js-client-rest';
import { getQdrantClient } from '../qdrant.js';
import getOpenAIClient, { getEmbeddingModel, getEmbeddingDimensions } from '../openai.js';
import { validateVectorGlobal, sanitizePayload } from './EmbeddingValidator.js';
import { extractChunksFromTask, extractChunksFromClaudeSession, splitChunk, Chunk, MAX_CHUNKS_PER_TASK } from './ChunkExtractor.js';
import { networkMetrics } from './QdrantHealthMonitor.js';
import { GenericError, GenericErrorCode } from '../../types/errors.js';

type PointStruct = Schemas['PointStruct'];

const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

/** Configurable batch size for Qdrant upserts (was hardcoded to 1 for debug) */
const INDEXING_BATCH_SIZE = Math.max(1, parseInt(process.env.INDEXING_BATCH_SIZE || '50', 10) || 50);

// --- Circuit Breaker Configuration ---
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000; // 2 seconds
const CIRCUIT_BREAKER_TIMEOUT_MS = 30000; // 30 seconds
type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
let circuitBreakerState: CircuitBreakerState = 'CLOSED';
let failureCount = 0;
let lastFailureTime = 0;

/**
 * #2165: Observable circuit-breaker state.
 *
 * The Qdrant circuit breaker used to be a silent module-level variable: when it
 * opened, `safeQdrantUpsert` returned `false` and `indexTask` threw — but nothing
 * upstream could see *why* writes were failing, nor avoid the expensive embedding
 * computation that precedes the (doomed) upsert. Under sustained Qdrant latency
 * this produced the embedding-server hammering described in #2165: chunks were
 * re-embedded every background cycle even though every upsert was being rejected.
 *
 * Exposing the state lets `indexTask` short-circuit BEFORE embedding, and lets
 * diagnostics surface the breaker instead of guessing.
 */
export interface CircuitBreakerSnapshot {
    state: CircuitBreakerState;
    failureCount: number;
    lastFailureTime: number;
    /** ms remaining before an OPEN breaker is allowed to probe (HALF_OPEN). 0 when not OPEN. */
    msUntilHalfOpen: number;
}

export function getCircuitBreakerState(): CircuitBreakerSnapshot {
    let msUntilHalfOpen = 0;
    if (circuitBreakerState === 'OPEN') {
        msUntilHalfOpen = Math.max(0, CIRCUIT_BREAKER_TIMEOUT_MS - (Date.now() - lastFailureTime));
    }
    return {
        state: circuitBreakerState,
        failureCount,
        lastFailureTime,
        msUntilHalfOpen,
    };
}

/**
 * #2165: Returns true when the circuit breaker would reject an upsert right now.
 * Unlike `canMakeRequest()` (which has the side effect of transitioning OPEN→HALF_OPEN),
 * this is a pure read used by `indexTask` to decide whether embedding is even worth it.
 */
export function isCircuitBreakerBlocking(): boolean {
    if (circuitBreakerState === 'CLOSED' || circuitBreakerState === 'HALF_OPEN') {
        return false;
    }
    // OPEN — blocking unless the cooldown has elapsed (next call would probe via HALF_OPEN)
    return (Date.now() - lastFailureTime) <= CIRCUIT_BREAKER_TIMEOUT_MS;
}

/** #2165: Test-only — reset breaker between unit tests without reimporting the module. */
export function resetCircuitBreakerForTest(): void {
    circuitBreakerState = 'CLOSED';
    failureCount = 0;
    lastFailureTime = 0;
}

/**
 * #2634: Runtime reset mechanism for embeddings circuit breaker.
 *
 * Call this to immediately reset the breaker state without requiring a VS Code restart.
 * Used by diagnostic tools and recovery procedures when Qdrant becomes available again
 * after an outage.
 *
 * Returns the previous state for logging/audit purposes.
 */
export function resetEmbeddingCircuitBreaker(): CircuitBreakerSnapshot {
    const previousState = getCircuitBreakerState();

    circuitBreakerState = 'CLOSED';
    failureCount = 0;
    lastFailureTime = 0;

    console.log(`✅ [#2634] Embedding circuit breaker reset by diagnostic tool. Previous state: ${previousState.state} (${previousState.failureCount} failures, ${previousState.msUntilHalfOpen}ms until half-open)`);

    return previousState;
}

// #2195: Per-cycle embedding metrics — in-process counters since MCP boot
export interface EmbeddingMetrics {
    embeddings_called_total: number;
    embeddings_cached_hit_total: number;
    embeddings_preflight_skipped_total: number;
    embeddings_post_dedup_skipped_total: number;
    embeddings_circuit_breaker_blocked_total: number;
    embeddings_wrong_dim_total: number;
    embeddings_rate_limit_waited_total: number;
    preflight_batches_total: number;
    preflight_batches_qdrant_unreachable_total: number;
    preflight_chunks_returned_existing_total: number;
    preflight_chunks_returned_missing_total: number;
}

const _metrics: EmbeddingMetrics = {
    embeddings_called_total: 0,
    embeddings_cached_hit_total: 0,
    embeddings_preflight_skipped_total: 0,
    embeddings_post_dedup_skipped_total: 0,
    embeddings_circuit_breaker_blocked_total: 0,
    embeddings_wrong_dim_total: 0,
    embeddings_rate_limit_waited_total: 0,
    preflight_batches_total: 0,
    preflight_batches_qdrant_unreachable_total: 0,
    preflight_chunks_returned_existing_total: 0,
    preflight_chunks_returned_missing_total: 0,
};

export function getEmbeddingMetrics(): Readonly<EmbeddingMetrics> {
    return { ..._metrics };
}

export function resetEmbeddingMetricsForTest(): void {
    for (const key of Object.keys(_metrics) as (keyof EmbeddingMetrics)[]) {
        _metrics[key] = 0;
    }
}

// 🛡️ CACHE ANTI-FUITE POUR ÉVITER EMBEDDINGS RÉPÉTÉS
const embeddingCache = new Map<string, { vector: number[], timestamp: number }>();
const EMBEDDING_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 jours cache pour embeddings (FIX: augmenté de 24h)
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
// Embedding ops per minute per instance. Default 30 sized for fleet (12 MCP instances × 30 = 360/min ≈ 6 emb/s),
// matching the qwen3-4b-awq embedder capacity on po-2026 (~5-10 req/s). Override via env to accelerate
// once the cache is warm (steady-state sees high cache hits and the embedder is barely touched).
const MAX_OPERATIONS_PER_WINDOW = parseInt(process.env.EMBEDDING_OPS_PER_MINUTE || '30', 10);
// #2194: Batch size for embedding API calls. 1 = legacy single-input (backward compat).
// Batch 16-32 yields ~3-5x throughput by amortizing HTTP round-trips.
const EMBEDDING_BATCH_SIZE = parseInt(process.env.EMBEDDING_BATCH_SIZE || '16', 10);
// Approximate max tokens per batch request. Split batch if sum of content lengths exceeds this.
const EMBEDDING_BATCH_MAX_TOKENS = parseInt(process.env.EMBEDDING_BATCH_MAX_TOKENS || '7000', 10);
let operationTimestamps: number[] = [];

const MAX_CHUNK_SIZE = 800; // Approx. 200-400 tokens, ultra-conservative safety margin below 8192 limit for text-embedding-3-small

/**
 * ✅ CORRECTION P0 (2025-10-15)
 * Rate Limiter pour protéger Qdrant des surcharges
 * Limite: 10 requêtes/seconde maximum vers Qdrant
 */
export class QdrantRateLimiter {
    private queue: Array<() => Promise<any>> = [];
    private processing = false;
    private lastExecution = 0;
    private minInterval = 100; // 100ms entre requêtes = max 10 req/s

    async execute<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    // Attendre intervalle minimum
                    const now = Date.now();
                    const elapsed = now - this.lastExecution;
                    if (elapsed < this.minInterval) {
                        await new Promise(r => setTimeout(r, this.minInterval - elapsed));
                    }

                    const result = await fn();
                    this.lastExecution = Date.now();
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });

            if (!this.processing) {
                this.processQueue();
            }
        });
    }

    private async processQueue() {
        this.processing = true;
        while (this.queue.length > 0) {
            const fn = this.queue.shift();
            if (fn) await fn();
        }
        this.processing = false;
    }
}

export const qdrantRateLimiter = new QdrantRateLimiter();

// 🛡️ FONCTION DE RETRY AVEC BACKOFF EXPONENTIEL
export async function retryWithBackoff<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries: number = MAX_RETRY_ATTEMPTS
): Promise<T> {
    let lastError: Error = new Error('Aucune tentative effectuée');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await operation();
            if (attempt > 1) {
                console.log(`✅ ${operationName} réussi après ${attempt} tentatives`);
            }
            return result;
        } catch (error: any) {
            lastError = error;
            console.warn(`⚠️ ${operationName} échoué (tentative ${attempt}/${maxRetries}):`, error.message);

            if (attempt < maxRetries) {
                const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1); // Backoff exponentiel
                console.log(`🔄 Retry dans ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    console.error(`❌ ${operationName} échoué définitivement après ${maxRetries} tentatives`);
    throw lastError;
}

/**
 * Circuit Breaker pour protéger les appels à Qdrant
 */
function canMakeRequest(): boolean {
    if (circuitBreakerState === 'CLOSED') {
        return true;
    }

    if (circuitBreakerState === 'OPEN') {
        const timeSinceLastFailure = Date.now() - lastFailureTime;
        if (timeSinceLastFailure > CIRCUIT_BREAKER_TIMEOUT_MS) {
            circuitBreakerState = 'HALF_OPEN';
            console.log('🟡 Circuit breaker: HALF_OPEN - tentative de reconnexion');
            return true;
        }
        return false;
    }

    // HALF_OPEN: permettre une tentative
    return circuitBreakerState === 'HALF_OPEN';
}

function recordSuccess(): void {
    failureCount = 0;
    circuitBreakerState = 'CLOSED';
    console.log('✅ Circuit breaker: SUCCESS - retour à l\'état CLOSED');
}

function recordFailure(): void {
    failureCount++;
    lastFailureTime = Date.now();

    if (failureCount >= MAX_RETRY_ATTEMPTS) {
        circuitBreakerState = 'OPEN';
        console.error(`🔴 Circuit breaker: OPEN - trop d'échecs (${failureCount}), arrêt pendant ${CIRCUIT_BREAKER_TIMEOUT_MS}ms`);
    }
}

/**
 * Assure que la collection Qdrant existe. Si non, la crée.
 */
export async function ensureCollectionExists() {
    try {
        const qdrant = getQdrantClient();
        const result = await qdrant.getCollections();
        const collectionExists = result.collections.some((collection) => collection.name === COLLECTION_NAME);

        if (!collectionExists) {
            const vectorSize = getEmbeddingDimensions();
            console.log(`Collection "${COLLECTION_NAME}" not found. Creating with vector size ${vectorSize}...`);

            await qdrant.createCollection(COLLECTION_NAME, {
                vectors: {
                    size: vectorSize,
                    distance: 'Cosine',
                },
                hnsw_config: {
                    max_indexing_threads: 2  // ✅ DOIT être > 0 pour éviter deadlock avec wait=true
                }
            });
            console.log(`Collection "${COLLECTION_NAME}" created successfully (size=${vectorSize}, max_indexing_threads=2)`);
        }

        // #2699/#2700: Ensure the payload index on `task_id` exists (idempotent, every boot).
        await ensureTaskIdPayloadIndex();
    } catch (error) {
        console.error('Error ensuring Qdrant collection exists:', error);
        throw error;
    }
}

/**
 * #2699/#2700: Ensure a payload index exists on `task_id`.
 *
 * RSM filters by `task_id` at multiple sites (count, search, scroll, delete).
 * Without an index, every filtered query does a full on-disk payload scan of the
 * whole collection (3-19s at peak load on ~889k points) → exceeds the MCP ~15s
 * timeout → intermittent indexing/search stall (gate #4).
 *
 * Idempotent: Qdrant re-creating an existing index is a no-op (returns acknowledged).
 * Non-blocking: `wait: false` so the index builds in the background without stalling
 * MCP startup on large existing collections.
 */
async function ensureTaskIdPayloadIndex(): Promise<void> {
    const qdrant = getQdrantClient();
    try {
        await qdrant.createPayloadIndex(COLLECTION_NAME, {
            field_name: 'task_id',
            field_schema: 'keyword',
            wait: false,
        });
    } catch (error: any) {
        // Non-fatal: index creation failure must not block startup. The collection
        // existing is more important than the index; the scan still works (slowly).
        console.warn(`Could not ensure payload index on "task_id":`, error?.message ?? error);
    }
}

/**
 * Appel sécurisé à Qdrant avec circuit breaker, retry et batching intelligent
 */
export async function safeQdrantUpsert(points: PointStruct[]): Promise<boolean> {
    const startTime = Date.now();

    // 📊 LOGGING DÉTAILLÉ - État initial
    console.log(`🔍 [safeQdrantUpsert] DÉBUT - Circuit: ${circuitBreakerState}, Échecs: ${failureCount}, Points: ${points.length}`);
    console.log(`📈 [safeQdrantUpsert] Métadonnées: Endpoint=${process.env.QDRANT_URL}, Collection=${COLLECTION_NAME}`);

    if (!canMakeRequest()) {
        console.warn(`🚫 [safeQdrantUpsert] Circuit breaker: Requête bloquée - état ${circuitBreakerState}`);
        console.warn(`🚫 [safeQdrantUpsert] Dernière erreur il y a ${Date.now() - lastFailureTime}ms`);
        return false;
    }

    // 🔍 LOGGING DÉTAILLÉ - Validation des payloads
    console.log(`🔍 [safeQdrantUpsert] Validation et nettoyage de ${points.length} points`);

    // Valider et nettoyer tous les payloads
    const sanitizedPoints = points.map((point, index) => {
        const originalPayload = point.payload;
        const sanitizedPayload = sanitizePayload(originalPayload);

        // Valider le vecteur
        try {
            validateVectorGlobal(point.vector as number[]);
        } catch (error: any) {
            console.error(`❌ [safeQdrantUpsert] Validation vecteur échouée pour point ${index}:`, error.message);
            throw error;
        }

        // Log des transformations critiques
        const payloadChanges = Object.keys(originalPayload || {}).length - Object.keys(sanitizedPayload).length;
        if (payloadChanges > 0) {
            console.log(`🧹 [safeQdrantUpsert] Point ${index}: ${payloadChanges} champs nettoyés`);
        }

        return {
            ...point,
            payload: sanitizedPayload
        };
    });

    // 🔍 LOGGING DÉTAILLÉ - Informations sur la requête
    const payloadSample = sanitizedPoints[0]?.payload || {};
    console.log(`📤 [safeQdrantUpsert] Échantillon payload:`, {
        task_id: payloadSample.task_id,
        parent_task_id: payloadSample.parent_task_id,
        workspace: payloadSample.workspace,
        chunk_type: payloadSample.chunk_type,
        content_length: payloadSample.content?.length || 0,
        host_os: payloadSample.host_os
    });

    // 🚀 BATCHING INTELLIGENT: Configurable via INDEXING_BATCH_SIZE env var
    const batchSize = INDEXING_BATCH_SIZE;
    const totalBatches = Math.ceil(sanitizedPoints.length / batchSize);

    if (totalBatches > 1) {
        console.log(`📦 [safeQdrantUpsert] Batching activé: ${sanitizedPoints.length} points en ${totalBatches} batches`);
    }

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
        const batchStart = batchIdx * batchSize;
        const batch = sanitizedPoints.slice(batchStart, batchStart + batchSize);
        const isLastBatch = batchIdx === totalBatches - 1;

        // wait=true seulement sur le dernier batch pour garantir indexation
        const shouldWait = isLastBatch;

        let attempt = 0;
        let batchSuccess = false;

        while (attempt < MAX_RETRY_ATTEMPTS && !batchSuccess) {
            const attemptStartTime = Date.now();

            try {
                console.log(`🔄 [safeQdrantUpsert] Batch ${batchIdx + 1}/${totalBatches}, Tentative ${attempt + 1}/${MAX_RETRY_ATTEMPTS} (${batch.length} points, wait=${shouldWait})`);

                // DEBUG: Logger le premier point pour diagnostic 400 (seulement si verbose)
                if (attempt === 0 && process.env.QDRANT_VERBOSE === 'true') {
                    const sample = batch[0];
                    console.log(`🔍 [safeQdrantUpsert] Sample Point ID: ${sample.id}`);
                    console.log(`🔍 [safeQdrantUpsert] Sample Payload Keys: ${Object.keys(sample.payload || {}).join(', ')}`);
                    console.log(`🔍 [safeQdrantUpsert] Sample Vector Length: ${Array.isArray(sample.vector) ? sample.vector.length : 'Not array'}`);
                }

                await getQdrantClient().upsert(COLLECTION_NAME, {
                    wait: shouldWait,
                    points: batch,
                });

                const attemptDuration = Date.now() - attemptStartTime;

                batchSuccess = true;

                // 📊 Mise à jour métriques réseau
                networkMetrics.qdrantCalls++;
                networkMetrics.bytesTransferred += batch.length * getEmbeddingDimensions() * 4;

                console.log(`✅ [safeQdrantUpsert] Batch ${batchIdx + 1}/${totalBatches} réussi - ${batch.length} points (${attemptDuration}ms)`);

            } catch (error: any) {
                attempt++;
                const attemptDuration = Date.now() - attemptStartTime;

                // 📊 LOGGING CRITIQUE - Erreurs détaillées
                console.error(`❌ [safeQdrantUpsert] ÉCHEC batch ${batchIdx + 1}/${totalBatches}, tentative ${attempt}/${MAX_RETRY_ATTEMPTS} après ${attemptDuration}ms`);
                console.error(`🔍 [safeQdrantUpsert] Type erreur: ${error?.constructor?.name || 'Unknown'}`);
                console.error(`🔍 [safeQdrantUpsert] Message erreur: ${error?.message || 'No message'}`);
                console.error(`🔍 [safeQdrantUpsert] Code erreur: ${error?.code || error?.status || 'No code'}`);

                // Logging des détails de requête pour reproduction
                if (error?.response) {
                    console.error(`🔍 [safeQdrantUpsert] Réponse HTTP: ${error.response.status} - ${error.response.statusText}`);
                    console.error(`🔍 [safeQdrantUpsert] Headers réponse:`, JSON.stringify(error.response.headers, null, 2));
                }

                // 🚨 FIX CRITIQUE: Ne JAMAIS retry les erreurs HTTP 400 (Bad Request)
                const httpStatus = error?.response?.status || error?.status;
                if (httpStatus === 400) {
                    // #2209: HTTP 400 is a permanent error (bad payload), NOT a transient failure.
                    // Don't trip the circuit breaker — it would block all subsequent indexing.
                    console.warn(`[#2209] HTTP 400 in safeQdrantUpsert — permanent error, NOT tripping breaker`);
                    const totalDuration = Date.now() - startTime;

                    console.error(`🔴 [safeQdrantUpsert] ERREUR HTTP 400 - NE PAS RETRY - Abandon immédiat`);
                    console.error(`🔴 [safeQdrantUpsert] Les erreurs 400 indiquent un problème avec les données envoyées`);

                    // Log détaillé de la réponse d'erreur Qdrant si disponible
                    if (error?.response) {
                         console.error(`🔴 [safeQdrantUpsert] Response Status: ${error.response.status}`);
                         console.error(`🔴 [safeQdrantUpsert] Response Data:`, JSON.stringify(error.response.data, null, 2));
                    } else {
                        console.error(`🔴 [safeQdrantUpsert] Pas de réponse HTTP détaillée disponible.`);
                        console.error(`🔴 [safeQdrantUpsert] Erreur brute:`, JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
                    }

                    // Dumper le premier point du batch pour analyse
                    if (batch.length > 0) {
                        console.error(`🔴 [safeQdrantUpsert] DUMP DU PREMIER POINT (pour debug):`);
                        console.error(JSON.stringify(batch[0], null, 2));
                    }

                    console.error(`🔴 [safeQdrantUpsert] Durée totale: ${totalDuration}ms`);
                    console.error(`🔴 [safeQdrantUpsert] Circuit breaker activé - État: ${circuitBreakerState}`);

                    return false;
                }

                if (attempt >= MAX_RETRY_ATTEMPTS) {
                    recordFailure();

                    console.error(`🔴 [safeQdrantUpsert] ÉCHEC DÉFINITIF batch ${batchIdx + 1} après ${MAX_RETRY_ATTEMPTS} tentatives`);
                    console.error(`🔴 [safeQdrantUpsert] Circuit breaker activé - État: ${circuitBreakerState}`);

                    return false;
                }

                // Délai exponentiel : 2s, 4s, 8s
                const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
                console.log(`⏳ [safeQdrantUpsert] Attente ${delay}ms avant retry batch ${batchIdx + 1}...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        // Pause entre batches pour éviter surcharge (sauf dernier)
        if (!isLastBatch) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    const totalDuration = Date.now() - startTime;
    recordSuccess();

    // 📊 LOGGING DÉTAILLÉ - Succès complet
    console.log(`✅ [safeQdrantUpsert] Upsert Qdrant COMPLET - ${sanitizedPoints.length} points indexés en ${totalBatches} batch(es)`);
    console.log(`⏱️ [safeQdrantUpsert] Durée totale: ${totalDuration}ms`);
    console.log(`🔄 [safeQdrantUpsert] Circuit breaker réinitialisé - État: CLOSED`);

    return true;
}

/**
 * #1985: Deduplicate points by contentHash before upserting to Qdrant.
 * Queries Qdrant for existing points with matching contentHash values.
 * Prevents re-indexing of already-indexed content (especially Claude Code /resume sessions).
 */
async function dedupByContentHash(points: PointStruct[]): Promise<PointStruct[]> {
    if (points.length === 0) return points;

    const contentHashes = points
        .map(p => (p.payload as any)?.contentHash as string | undefined)
        .filter((h): h is string => !!h);

    if (contentHashes.length === 0) return points;

    try {
        const qdrant = getQdrantClient();

        const uniqueHashes = [...new Set(contentHashes)];
        const existingHashes = new Set<string>();

        const BATCH_SIZE = 100;
        for (let i = 0; i < uniqueHashes.length; i += BATCH_SIZE) {
            const batch = uniqueHashes.slice(i, i + BATCH_SIZE);
            try {
                const results = await qdrant.scroll(COLLECTION_NAME, {
                    filter: {
                        should: batch.map(hash => ({
                            key: 'contentHash',
                            match: { value: hash },
                        })),
                    },
                    limit: 1000,
                    with_vector: false,
                    with_payload: { include: ['contentHash'] },
                });

                for (const point of results.points) {
                    const hash = (point.payload as any)?.contentHash as string | undefined;
                    if (hash) existingHashes.add(hash);
                }

                while (results.next_page_offset) {
                    const nextResults = await qdrant.scroll(COLLECTION_NAME, {
                        filter: {
                            should: batch.map(hash => ({
                                key: 'contentHash',
                                match: { value: hash },
                            })),
                        },
                        limit: 1000,
                        offset: results.next_page_offset,
                        with_vector: false,
                        with_payload: { include: ['contentHash'] },
                    });
                    for (const point of nextResults.points) {
                        const hash = (point.payload as any)?.contentHash as string | undefined;
                        if (hash) existingHashes.add(hash);
                    }
                    if (!nextResults.next_page_offset) break;
                }
            } catch (scrollError: any) {
                console.warn(`[#1985] Dedup scroll failed for batch ${i}: ${scrollError?.message || scrollError}`);
            }
        }

        if (existingHashes.size === 0) return points;

        const before = points.length;
        const filtered = points.filter(p => {
            const hash = (p.payload as any)?.contentHash as string | undefined;
            return !hash || !existingHashes.has(hash);
        });
        console.log(`[#1985] Content-hash dedup: ${before - filtered.length}/${before} points already in Qdrant`);
        _metrics.embeddings_post_dedup_skipped_total += (before - filtered.length);
        return filtered;
    } catch (error: any) {
        console.warn(`[#1985] Dedup check failed (non-blocking): ${error?.message || error}`);
        return points;
    }
}

/**
 * #2018 Phase 2: Pre-flight dedup using deterministic chunk_ids.
 * Checks Qdrant for existing points BEFORE computing expensive embeddings.
 * Uses retrieve() API (O(1) per ID) instead of scroll-based contentHash filter.
 *
 * This eliminates the race condition window: with deterministic chunk_ids from Phase 1,
 * concurrent MCPs that write the same chunk_id produce identical points (idempotent upsert).
 * The pre-flight check skips embedding computation entirely for already-indexed chunks.
 */
interface PreflightDedupResult {
    /** Sub-chunks that still need embedding + upsert. */
    subChunks: Array<{ chunk: Chunk; contentHash: string }>;
    /**
     * #2165: True only if EVERY batch retrieve succeeded. When false, the dedup
     * check is unreliable (Qdrant unreachable / slow) and the caller must NOT
     * blindly embed everything — that is exactly the condition that produced the
     * embedding-server hammering loop. Callers should back off instead.
     */
    qdrantReachable: boolean;
}

async function preflightDedupByChunkId(
    subChunks: Array<{ chunk: Chunk; contentHash: string }>
): Promise<PreflightDedupResult> {
    if (subChunks.length === 0) return { subChunks, qdrantReachable: true };

    try {
        const qdrant = getQdrantClient();

        // #2209: Skip preflight entirely for huge collections — retrieve() is too slow
        // on millions of points. Rely on post-index content-hash dedup instead.
        try {
            const collectionInfo = await qdrant.count(COLLECTION_NAME, { exact: false });
            if (collectionInfo.count > 5_000_000) {
                console.log(`[#2209] Collection has ~${collectionInfo.count} points — skipping preflight dedup, relying on post-index content-hash dedup`);
                return { subChunks, qdrantReachable: true };
            }
        } catch { /* ignore count failure, proceed with preflight */ }

        const chunkIds = subChunks.map(sc => sc.chunk.chunk_id);
        const existingContentHashes = new Map<string, string>(); // chunk_id -> contentHash
        let allBatchesSucceeded = true;

        // Batch retrieve — check which chunk_ids already exist (O(1) per ID)
        const BATCH_SIZE = 100;
        for (let i = 0; i < chunkIds.length; i += BATCH_SIZE) {
            const batch = chunkIds.slice(i, i + BATCH_SIZE);
            _metrics.preflight_batches_total++;
            try {
                // #2209: Race with 5s timeout — slow retrieves on large collections
                // should not block indexing indefinitely or trip the circuit breaker.
                const points = await Promise.race([
                    qdrant.retrieve(COLLECTION_NAME, {
                        ids: batch,
                        with_payload: true,
                        with_vector: false,
                    }),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error('Preflight retrieve timeout after 5000ms')), 5000)
                    ),
                ]);

                for (const point of points) {
                    const hash = (point.payload as any)?.contentHash as string | undefined;
                    if (hash) existingContentHashes.set(point.id as string, hash);
                }
            } catch (retrieveError: any) {
                _metrics.preflight_batches_qdrant_unreachable_total++;
                const isTimeout = retrieveError?.message?.includes('timeout');
                if (isTimeout) {
                    // #2209: Timeouts don't mean Qdrant is down — just slow on large collections.
                    // Don't mark as unreachable to avoid tripping circuit breaker.
                    console.warn(`[#2209] Preflight retrieve timed out for batch at offset ${i} — treating as non-fatal`);
                } else {
                    // #2165: A non-timeout failure does NOT mean "no existing points" — it means
                    // we don't know. Track it so the caller can back off instead of
                    // re-embedding chunks that are very likely already in Qdrant.
                    allBatchesSucceeded = false;
                    console.warn(`[#2018] Preflight retrieve failed for batch ${i}: ${retrieveError?.message || retrieveError}`);
                }
            }
        }

        // Filter: skip chunks that exist with same contentHash (unchanged content)
        const newSubChunks = subChunks.filter(sc => {
            const existingHash = existingContentHashes.get(sc.chunk.chunk_id);
            if (!existingHash) return true; // Doesn't exist (or unknown) — needs indexing
            return existingHash !== sc.contentHash; // Keep if content changed
        });

        const skipped = subChunks.length - newSubChunks.length;
        _metrics.preflight_chunks_returned_existing_total += existingContentHashes.size;
        _metrics.preflight_chunks_returned_missing_total += (subChunks.length - existingContentHashes.size);
        _metrics.embeddings_preflight_skipped_total += skipped;
        if (skipped > 0) {
            console.log(`[#2018] Preflight dedup: ${skipped}/${subChunks.length} chunks already indexed, computing embeddings for ${newSubChunks.length}`);
        }

        return { subChunks: newSubChunks, qdrantReachable: allBatchesSucceeded };
    } catch (error: any) {
        // #2165: Total failure — Qdrant unreachable. Signal it so the caller backs off.
        console.warn(`[#2018] Preflight dedup failed (Qdrant unreachable): ${error?.message || error}`);
        return { subChunks, qdrantReachable: false };
    }
}

/**
 * #2369: Pre-flight contentHash dedup BEFORE embedding computation.
 * Handles the case where split sub-chunks have new UUIDs (bypassing chunk_id preflight)
 * but their content already exists in Qdrant. Without this, ~90% of embeddings are
 * computed needlessly only to be discarded by post-index dedupByContentHash.
 * Reuses the same scroll-based contentHash query as dedupByContentHash but operates
 * on sub-chunks (before embedding) instead of PointStructs (after embedding).
 */
async function preflightDedupByContentHash(
    subChunks: Array<{ chunk: Chunk; contentHash: string }>
): Promise<Array<{ chunk: Chunk; contentHash: string }>> {
    if (subChunks.length === 0) return subChunks;

    const contentHashes = subChunks.map(sc => sc.contentHash);
    const uniqueHashes = [...new Set(contentHashes)];
    const existingHashes = new Set<string>();

    try {
        const qdrant = getQdrantClient();
        const BATCH_SIZE = 100;

        for (let i = 0; i < uniqueHashes.length; i += BATCH_SIZE) {
            const batch = uniqueHashes.slice(i, i + BATCH_SIZE);
            try {
                const results = await qdrant.scroll(COLLECTION_NAME, {
                    filter: {
                        should: batch.map(hash => ({
                            key: 'contentHash',
                            match: { value: hash },
                        })),
                    },
                    limit: 1000,
                    with_vector: false,
                    with_payload: { include: ['contentHash'] },
                });

                for (const point of results.points) {
                    const hash = (point.payload as any)?.contentHash as string | undefined;
                    if (hash) existingHashes.add(hash);
                }

                while (results.next_page_offset) {
                    const nextResults = await qdrant.scroll(COLLECTION_NAME, {
                        filter: {
                            should: batch.map(hash => ({
                                key: 'contentHash',
                                match: { value: hash },
                            })),
                        },
                        limit: 1000,
                        offset: results.next_page_offset,
                        with_vector: false,
                        with_payload: { include: ['contentHash'] },
                    });
                    for (const point of nextResults.points) {
                        const hash = (point.payload as any)?.contentHash as string | undefined;
                        if (hash) existingHashes.add(hash);
                    }
                    if (!nextResults.next_page_offset) break;
                }
            } catch (scrollError: any) {
                console.warn(`[#2369] Preflight contentHash scroll failed for batch ${i}: ${scrollError?.message || scrollError}`);
                // Non-blocking: on failure, keep chunks (will be caught by post-index dedup)
            }
        }

        if (existingHashes.size === 0) return subChunks;

        const before = subChunks.length;
        const filtered = subChunks.filter(sc => !existingHashes.has(sc.contentHash));
        const skipped = before - filtered.length;
        _metrics.embeddings_preflight_skipped_total += skipped;
        if (skipped > 0) {
            console.log(`[#2369] Preflight contentHash dedup: ${skipped}/${before} sub-chunks already in Qdrant — skipped before embedding`);
        }
        return filtered;
    } catch (error: any) {
        console.warn(`[#2369] Preflight contentHash dedup failed (non-blocking): ${error?.message || error}`);
        return subChunks;
    }
}

// #2194: Split sub-chunks into batches respecting size and token limits
function buildBatches(
    entries: Array<{ chunk: Chunk; contentHash: string }>,
    batchSize: number,
    maxTokens: number
): Array<Array<{ chunk: Chunk; contentHash: string }>> {
    const batches: Array<Array<{ chunk: Chunk; contentHash: string }>> = [];
    let currentBatch: Array<{ chunk: Chunk; contentHash: string }> = [];
    let currentTokens = 0;

    for (const entry of entries) {
        const estimatedTokens = Math.ceil(entry.chunk.content.length / 4);
        if (
            currentBatch.length >= batchSize ||
            (currentBatch.length > 0 && currentTokens + estimatedTokens > maxTokens)
        ) {
            batches.push(currentBatch);
            currentBatch = [];
            currentTokens = 0;
        }
        currentBatch.push(entry);
        currentTokens += estimatedTokens;
    }
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }
    return batches;
}

// #2194: Embed a single chunk (legacy path for EMBEDDING_BATCH_SIZE=1)
async function embedSingle(
    subChunk: Chunk,
    contentHash: string,
    model: string,
    expectedDims: number,
    now: number
): Promise<number[] | null> {
    const embeddingResponse = await getOpenAIClient().embeddings.create({
        model,
        input: subChunk.content,
    });
    _metrics.embeddings_called_total++;
    const vector = embeddingResponse.data[0].embedding;

    if (!vector || !Array.isArray(vector)) {
        console.error(`❌ [indexTask] Embedding invalide: pas un tableau pour chunk ${subChunk.chunk_id}`);
        return null;
    }
    if (vector.length !== expectedDims) {
        _metrics.embeddings_wrong_dim_total++;
        console.warn(`⚠️ [indexTask] Dimension inattendue: ${vector.length} vs ${expectedDims} pour chunk ${subChunk.chunk_id}`);
        return null;
    }

    embeddingCache.set(contentHash, { vector, timestamp: now });
    operationTimestamps.push(now);
    return vector;
}

// #2194: Embed a batch of chunks in one API call.
// On failure, splits into two halves and retries each independently (no data loss).
async function embedBatch(
    batch: Array<{ chunk: Chunk; contentHash: string }>,
    model: string,
    expectedDims: number,
    now: number
): Promise<Array<number[] | null>> {
    if (batch.length === 1) {
        // Single item — try once, return null on failure
        try {
            const resp = await getOpenAIClient().embeddings.create({ model, input: batch[0].chunk.content });
            _metrics.embeddings_called_total++;
            operationTimestamps.push(now);
            const vector = resp.data[0]?.embedding;
            if (vector && Array.isArray(vector) && vector.length === expectedDims) {
                embeddingCache.set(batch[0].contentHash, { vector, timestamp: now });
                return [vector];
            }
            if (vector && vector.length !== expectedDims) {
                _metrics.embeddings_wrong_dim_total++;
                console.warn(`⚠️ [batch] Dimension inattendue: ${vector.length} vs ${expectedDims} pour chunk ${batch[0].chunk.chunk_id}`);
            }
            return [null];
        } catch (error: any) {
            console.error(`❌ [batch] Single embedding failed for chunk ${batch[0].chunk.chunk_id}: ${error.message}`);
            return [null];
        }
    }

    // Multi-item batch — try full batch, split on failure
    try {
        const inputs = batch.map(e => e.chunk.content);
        const resp = await getOpenAIClient().embeddings.create({ model, input: inputs });
        _metrics.embeddings_called_total += batch.length;
        // #2194 fix: rate limit counts per embedding, not per batch
        for (let i = 0; i < batch.length; i++) {
            operationTimestamps.push(now);
        }

        const results: Array<number[] | null> = new Array(batch.length).fill(null);
        for (let i = 0; i < batch.length; i++) {
            const vector = resp.data[i]?.embedding;
            if (!vector || !Array.isArray(vector)) {
                console.error(`❌ [batch] Embedding invalide pour chunk ${batch[i].chunk.chunk_id}`);
                continue;
            }
            if (vector.length !== expectedDims) {
                _metrics.embeddings_wrong_dim_total++;
                console.warn(`⚠️ [batch] Dimension inattendue: ${vector.length} vs ${expectedDims} pour chunk ${batch[i].chunk.chunk_id}`);
                continue;
            }
            results[i] = vector;
            embeddingCache.set(batch[i].contentHash, { vector, timestamp: now });
        }
        return results;
    } catch (error: any) {
        // Full batch failed — split into two halves and retry each independently
        const mid = Math.ceil(batch.length / 2);
        console.warn(`[batch] Batch of ${batch.length} failed (${error.message}), splitting into ${mid}+${batch.length - mid}`);
        const [left, right] = await Promise.all([
            embedBatch(batch.slice(0, mid), model, expectedDims, now),
            embedBatch(batch.slice(mid), model, expectedDims, now),
        ]);
        return [...left, ...right];
    }
}

/**
 * Indexe une seule tâche en créant des chunks granulaires, en générant des embeddings
 * sélectivement et en les stockant dans Qdrant.
 * @param taskId L'ID de la tâche à indexer.
 * @param taskPath Le chemin complet vers le répertoire de la tâche.
 */
export async function indexTask(taskId: string, taskPath: string, source: 'roo' | 'claude-code' = 'roo', metadata?: { workspace?: string; title?: string }): Promise<PointStruct[]> {
    console.log(`Starting granular indexing for task: ${taskId} (source: ${source})`);

    try {
        // #2165: ROOT-CAUSE FIX for embedding-server hammering.
        // Previously, indexTask() extracted chunks, computed ALL embeddings, THEN
        // discovered the Qdrant circuit breaker was OPEN and threw. Under sustained
        // Qdrant latency the breaker stays OPEN, yet every background cycle still
        // burned GPU embedding chunks whose upsert was guaranteed to be rejected.
        // Short-circuit here, BEFORE any embedding work, when the breaker is open.
        if (isCircuitBreakerBlocking()) {
            _metrics.embeddings_circuit_breaker_blocked_total++;
            const snap = getCircuitBreakerState();
            console.warn(
                `🚫 [indexTask] Circuit breaker OPEN — skipping task ${taskId} BEFORE embedding ` +
                `(failures=${snap.failureCount}, retry in ~${Math.round(snap.msUntilHalfOpen / 1000)}s). ` +
                `No embeddings computed, no GPU burned.`
            );
            throw new GenericError(
                `Qdrant circuit breaker OPEN — indexing for task ${taskId} deferred (no embeddings computed)`,
                GenericErrorCode.CIRCUIT_BREAKER_OPEN,
                { taskId, circuitBreaker: snap, service: 'VectorIndexer.indexTask' }
            );
        }

        await ensureCollectionExists();

        // Dispatch to appropriate chunk extractor based on source
        const chunks = source === 'claude-code'
            ? await extractChunksFromClaudeSession(taskId, taskPath, metadata)
            : await extractChunksFromTask(taskId, taskPath);

        if (chunks.length === 0) {
            console.log(`No chunks found for task ${taskId}. Skipping.`);
            return [];
        }

        // #1758: Hard limit on chunks per task to prevent runaway indexing
        if (chunks.length > MAX_CHUNKS_PER_TASK) {
            console.warn(`⚠️ [#1758] Task ${taskId} has ${chunks.length} chunks — exceeding MAX_CHUNKS_PER_TASK=${MAX_CHUNKS_PER_TASK}. Truncating to first ${MAX_CHUNKS_PER_TASK} chunks.`);
            chunks.length = MAX_CHUNKS_PER_TASK;
        }

        // Phase A: Extract all subChunks with contentHashes (cheap — no API calls)
        const allSubChunks: Array<{ chunk: Chunk; contentHash: string }> = [];

        for (const chunk of chunks) {
            if (chunk.indexed) {
                const subChunks = splitChunk(chunk, MAX_CHUNK_SIZE);
                for (const subChunk of subChunks) {
                    if (!subChunk.content || subChunk.content.trim() === '') continue;
                    const contentHash = crypto.createHash('sha256').update(subChunk.content).digest('hex');
                    allSubChunks.push({ chunk: subChunk, contentHash });
                }
            }
        }

        // Phase B: #2018 Phase 2 — Pre-flight dedup by chunk_id (skip already-indexed chunks BEFORE embeddings)
        const preflight = await preflightDedupByChunkId(allSubChunks);
        let subChunksToEmbed = preflight.subChunks;

        // Phase B2: #2369 — Pre-flight dedup by contentHash (catches split sub-chunks
        // with new UUIDs that bypassed chunk_id preflight but whose content already exists)
        if (subChunksToEmbed.length > 0) {
            subChunksToEmbed = await preflightDedupByContentHash(subChunksToEmbed);
        }

        // #2165: If the pre-flight dedup could not reach Qdrant, the "needs embedding"
        // set is unreliable — it most likely contains chunks already indexed. Embedding
        // them would (a) hammer the embedding server and (b) fail at upsert anyway since
        // Qdrant is unreachable. Back off instead. This is the second half of the
        // root-cause fix: the dedup query failing silently was letting 100% of chunks
        // through to embedding under exactly the load conditions that caused #2165.
        if (!preflight.qdrantReachable && subChunksToEmbed.length > 0) {
            console.warn(
                `🚫 [indexTask] Pre-flight dedup could not reach Qdrant for task ${taskId} — ` +
                `deferring ${subChunksToEmbed.length} chunk embeddings to avoid re-embedding ` +
                `already-indexed content. No GPU burned.`
            );
            recordFailure();
            throw new GenericError(
                `Qdrant unreachable during pre-flight dedup for task ${taskId} — indexing deferred (no embeddings computed)`,
                GenericErrorCode.CIRCUIT_BREAKER_OPEN,
                { taskId, chunksDeferred: subChunksToEmbed.length, service: 'VectorIndexer.indexTask' }
            );
        }

        // Phase C: Compute embeddings only for new/changed chunks
        let pointsToIndex: PointStruct[] = [];

        // #2194: Two-stage pipeline — cache lookup first, then batch embedding for misses
        const embeddingModel = getEmbeddingModel();
        const expectedDims = getEmbeddingDimensions();
        const now = Date.now();

        // Stage 1: Separate cached from uncached
        type SubChunkEntry = { chunk: Chunk; contentHash: string };
        const cachedResults: Map<string, number[]> = new Map(); // contentHash → vector
        const uncached: SubChunkEntry[] = [];

        for (const entry of subChunksToEmbed) {
            const cached = embeddingCache.get(entry.contentHash);
            if (cached && (now - cached.timestamp < EMBEDDING_CACHE_TTL)) {
                _metrics.embeddings_cached_hit_total++;
                cachedResults.set(entry.contentHash, cached.vector);
            } else {
                uncached.push(entry);
            }
        }

        // Stage 2: Batch embed uncached chunks
        if (uncached.length > 0) {
            // Rate-limit check before batch processing
            operationTimestamps = operationTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);
            if (operationTimestamps.length >= MAX_OPERATIONS_PER_WINDOW) {
                _metrics.embeddings_rate_limit_waited_total++;
                console.warn(`[RATE-LIMIT] Trop d'opérations récentes (${operationTimestamps.length}/${MAX_OPERATIONS_PER_WINDOW}). Attente...`);
                await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_WINDOW));
                operationTimestamps = [];
            }

            if (EMBEDDING_BATCH_SIZE <= 1) {
                // Legacy single-input path (backward compat)
                for (const { chunk: subChunk, contentHash } of uncached) {
                    const vector = await embedSingle(subChunk, contentHash, embeddingModel, expectedDims, now);
                    if (vector) {
                        cachedResults.set(contentHash, vector);
                    }
                }
            } else {
                // Batch path: split uncached into batches respecting token limits
                const batches = buildBatches(uncached, EMBEDDING_BATCH_SIZE, EMBEDDING_BATCH_MAX_TOKENS);
                for (const batch of batches) {
                    const batchVectors = await embedBatch(batch, embeddingModel, expectedDims, now);
                    for (let i = 0; i < batch.length; i++) {
                        if (batchVectors[i]) {
                            cachedResults.set(batch[i].contentHash, batchVectors[i]!);
                        }
                    }
                }
            }
        }

        // Stage 3: Build points from all resolved vectors
        for (const { chunk: subChunk, contentHash } of subChunksToEmbed) {
            const vector = cachedResults.get(contentHash);
            if (!vector) continue;

            const point: PointStruct = {
                id: subChunk.chunk_id,
                vector: vector,
                payload: { ...subChunk, source: source, contentHash },
            };
            pointsToIndex.push(point);
        }

        /**
         * #1985: Dedup pre-indexation — skip points whose contentHash already exists in Qdrant
         * Prevents Claude Code session re-indexing creating duplicate vectors on /resume or /compact.
         */
        if (pointsToIndex.length > 0) {
            const deduplicated = await dedupByContentHash(pointsToIndex);
            if (deduplicated.length < pointsToIndex.length) {
                console.log(`[#1985] Dedup: ${pointsToIndex.length - deduplicated.length}/${pointsToIndex.length} points already indexed, indexing ${deduplicated.length} new`);
            }
            pointsToIndex = deduplicated;
        }

        /**
         * ✅ CORRECTION P0 (2025-10-15) - Amélioration logging succès
         * Vérifier si des chunks valides ont été extraits avant de déclarer succès
         */
        if (pointsToIndex.length > 0) {
            console.log(`📤 Préparation upsert Qdrant: ${pointsToIndex.length} points (de ${chunks.length} chunks originaux) pour tâche ${taskId}`);
            const success = await safeQdrantUpsert(pointsToIndex);

            if (success) {
                console.log(`✅ Indexation réussie: ${pointsToIndex.length} points pour tâche ${taskId}`);
            } else {
                // #1273: Propagate error instead of swallowing it silently
                // Previously returned [] which caller treated as "success with 0 points"
                throw new GenericError(
                    `Indexation failed for task ${taskId} - circuit breaker active or repeated upsert errors`,
                    GenericErrorCode.NETWORK_ERROR,
                    { taskId, pointsCount: pointsToIndex.length, service: 'VectorIndexer.indexTask' }
                );
            }
        } else {
            if (chunks.length === 0) {
                console.warn(`⚠️ Tâche ${taskId} : Aucun chunk extrait, vérifier les données source`);
            } else {
                console.warn(`⚠️ Tâche ${taskId} : ${chunks.length} chunks trouvés mais aucun indexable (indexed=false ou contenu vide)`);
            }
            console.log(`No indexable chunks found for task ${taskId}.`);
        }

        return pointsToIndex;

    } catch (error) {
        console.error(`Failed to index task ${taskId}:`, error);

        // #1273: Propagate error so caller can report isError to MCP client
        // Previously swallowed all errors and returned [], causing:
        // - Silent data loss (caller treats [] as "success with 0 points")
        // - Background indexer infinite retry loop (qdrantIndexedAt never set)
        recordFailure();

        // Re-throw as GenericError if not already a typed error
        if (error instanceof GenericError) {
            throw error;
        }
        throw new GenericError(
            `Indexation failed for task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
            GenericErrorCode.NETWORK_ERROR,
            { taskId, originalError: error instanceof Error ? error.message : String(error), service: 'VectorIndexer.indexTask' },
            error instanceof Error ? error : undefined
        );
    }
}

/**
 * FIX ARCHITECTURAL: Met à jour le timestamp d'indexation dans le squelette
 * Cette responsabilité devrait être ICI, pas dans index.ts
 */
export async function updateSkeletonIndexTimestamp(taskId: string, storageLocation: string): Promise<void> {
    try {
        const skeletonPath = path.join(storageLocation, '.skeletons', `${taskId}.json`);

        // Lire le squelette existant
        const skeletonContent = await fs.readFile(skeletonPath, 'utf8');
        const skeleton = JSON.parse(skeletonContent);

        // Mettre à jour le timestamp
        skeleton.metadata = skeleton.metadata || {};
        skeleton.metadata.qdrantIndexedAt = new Date().toISOString();

        // Sauvegarder le squelette mis à jour
        await fs.writeFile(skeletonPath, JSON.stringify(skeleton, null, 2), 'utf8');

        console.log(`✅ Squelette ${taskId} mis à jour avec timestamp d'indexation`);
    } catch (error) {
        console.warn(`⚠️ Impossible de mettre à jour le squelette ${taskId}:`, error);
        // Ne pas throw - l'indexation a réussi même si la mise à jour du squelette échoue
    }
}

/**
 * Réinitialise complètement la collection Qdrant
 */
export async function resetCollection(): Promise<void> {
    try {
        const qdrant = getQdrantClient();

        try {
            await qdrant.deleteCollection(COLLECTION_NAME);
            console.log(`Collection ${COLLECTION_NAME} supprimée`);
        } catch (error) {
            console.log(`Collection ${COLLECTION_NAME} n'existait pas, continuer...`);
        }

        const vectorSize = getEmbeddingDimensions();
        await qdrant.createCollection(COLLECTION_NAME, {
            vectors: {
                size: vectorSize,
                distance: 'Cosine',
            },
            hnsw_config: {
                max_indexing_threads: 2
            }
        });

        console.log(`Collection ${COLLECTION_NAME} recréée avec succès (size=${vectorSize})`);
    } catch (error) {
        console.error('Erreur lors de la réinitialisation de la collection Qdrant:', error);
        throw error;
    }
}

/**
 * Compte les points dans Qdrant pour un host_os spécifique
 */
export async function countPointsByHostOs(hostOs: string): Promise<number> {
    try {
        const result = await retryWithBackoff(async () => {
            const qdrant = getQdrantClient();
            return await qdrant.count(COLLECTION_NAME, {
                filter: {
                    must: [
                        {
                            key: 'host_os',
                            match: {
                                value: hostOs
                            }
                        }
                    ]
                },
                exact: true
            });
        }, `Qdrant count pour host_os=${hostOs}`);

        networkMetrics.qdrantCalls++;
        networkMetrics.bytesTransferred += 1024;
        return result.count;
    } catch (error) {
        console.error(`Could not count points for host_os=${hostOs}:`, error);
        return 0; // Retourner 0 en cas d'erreur
    }
}

/**
 * Insère des points avec batching intelligent et monitoring
 * @param points - Points à insérer
 * @param options - Options d'insertion
 */
export async function upsertPointsBatch(
    points: Array<{ id: string; vector: number[]; payload: any }>,
    options?: {
        batchSize?: number;
        waitOnLast?: boolean;
        maxRetries?: number;
    }
): Promise<void> {
    const batchSize = options?.batchSize || 100;
    const waitOnLast = options?.waitOnLast ?? true;
    const maxRetries = options?.maxRetries || 3;

    const totalBatches = Math.ceil(points.length / batchSize);

    for (let i = 0; i < points.length; i += batchSize) {
        const batch = points.slice(i, i + batchSize);
        const batchNumber = Math.floor(i / batchSize) + 1;
        const isLastBatch = i + batchSize >= points.length;

        // wait=true seulement sur le dernier batch pour garantir indexation
        const shouldWait = isLastBatch && waitOnLast;

        let retryCount = 0;
        let success = false;

        while (!success && retryCount < maxRetries) {
            try {
                // Valider tous les vecteurs avant l'upsert
                batch.forEach((point, idx) => {
                    try {
                        validateVectorGlobal(point.vector as number[]);
                    } catch (error: any) {
                        console.error(`❌ Validation échouée pour point ${idx} dans batch ${batchNumber}:`, error.message);
                        throw error;
                    }
                });

                /**
                 * ✅ CORRECTION P0 (2025-10-15) - Rate Limiter Qdrant
                 * Wrapper avec rate limiter pour éviter surcharge (max 10 req/s)
                 */
                await qdrantRateLimiter.execute(async () => {
                    return await getQdrantClient().upsert(COLLECTION_NAME, {
                        points: batch,
                        wait: shouldWait
                    });
                });

                success = true;
                console.log(`✓ Batch ${batchNumber}/${totalBatches} inséré (${batch.length} points, wait=${shouldWait})`);

                networkMetrics.qdrantCalls++;
                networkMetrics.bytesTransferred += batch.length * getEmbeddingDimensions() * 4;

            } catch (error: any) {
                // Ne pas retry sur HTTP 400 (erreur client)
                if (error.response?.status === 400 || error.status === 400) {
                    console.error(`✗ HTTP 400 sur batch ${batchNumber} - Abandon:`, error.response?.data || error.message);
                    throw error; // Propagate l'erreur
                }

                // Retry sur autres erreurs (timeout, 500, etc.)
                retryCount++;
                if (retryCount < maxRetries) {
                    const backoff = Math.min(1000 * Math.pow(2, retryCount), 10000);
                    console.warn(`⚠ Erreur batch ${batchNumber}, retry ${retryCount}/${maxRetries} dans ${backoff}ms`);
                    await new Promise(resolve => setTimeout(resolve, backoff));
                } else {
                    console.error(`✗ Échec batch ${batchNumber} après ${maxRetries} tentatives:`, error.message);
                    throw error;
                }
            }
        }

        // Pause entre batches pour éviter surcharge (sauf dernier)
        if (!isLastBatch) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
}

/**
 * Supprime les vecteurs plus anciens qu'un âge donné (#1658)
 * Utilise le champ `timestamp` du payload pour filtrer par âge.
 * @param maxAgeDays Âge maximum en jours (défaut: 90)
 * @param dryRun Mode simulation — compte sans supprimer
 * @param workspaceFilter Filtre optionnel par workspace_name
 */
export async function cleanupOldVectors(
    maxAgeDays: number = 90,
    dryRun: boolean = false,
    workspaceFilter?: string
): Promise<{ deletedCount: number; cutoffDate: string; workspaceFilter?: string }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
    const cutoffIso = cutoffDate.toISOString();

    const mustConditions: Array<{ key: string; match: { value: string } } | { key: string; range: { lt: string } }> = [
        {
            key: 'timestamp',
            range: { lt: cutoffIso }
        }
    ];

    if (workspaceFilter) {
        mustConditions.push({
            key: 'workspace_name',
            match: { value: workspaceFilter }
        });
    }

    const filter = { must: mustConditions };

    // Count candidates first
    const countResult = await retryWithBackoff(async () => {
        const qdrant = getQdrantClient();
        return await qdrant.count(COLLECTION_NAME, {
            filter,
            exact: true
        });
    }, `Qdrant cleanup count (age>${maxAgeDays}d)`);

    const candidateCount = countResult.count;
    networkMetrics.qdrantCalls++;

    if (candidateCount === 0) {
        return { deletedCount: 0, cutoffDate: cutoffIso, workspaceFilter };
    }

    if (dryRun) {
        console.log(`[DRY RUN] ${candidateCount} vecteurs seraient supprimés (antérieurs à ${cutoffIso}${workspaceFilter ? `, workspace=${workspaceFilter}` : ''})`);
        return { deletedCount: candidateCount, cutoffDate: cutoffIso, workspaceFilter };
    }

    // Delete in batches using scroll + delete pattern to avoid timeout on large sets
    const BATCH_SIZE = 1000;
    let totalDeleted = 0;
    let hasMore = true;

    while (hasMore) {
        await qdrantRateLimiter.execute(async () => {
            // Scroll to get a batch of point IDs matching the filter
            const scrolled = await retryWithBackoff(async () => {
                const qdrant = getQdrantClient();
                return await qdrant.scroll(COLLECTION_NAME, {
                    filter,
                    limit: BATCH_SIZE,
                    with_payload: false,
                    with_vector: false
                });
            }, `Qdrant cleanup scroll (batch at ${totalDeleted})`);

            networkMetrics.qdrantCalls++;

            if (!scrolled.points || scrolled.points.length === 0) {
                hasMore = false;
                return;
            }

            const idsToDelete = scrolled.points.map((p: any) => p.id);

            // Delete this batch
            await retryWithBackoff(async () => {
                const qdrant = getQdrantClient();
                await qdrant.delete(COLLECTION_NAME, {
                    points: idsToDelete,
                    wait: true
                });
            }, `Qdrant cleanup delete batch (${idsToDelete.length} points)`);

            networkMetrics.qdrantCalls++;
            totalDeleted += idsToDelete.length;

            console.log(`✓ Cleanup batch: ${idsToDelete.length} vecteurs supprimés (total: ${totalDeleted}/${candidateCount})`);

            if (!scrolled.next_page_offset) {
                hasMore = false;
            }
        });
    }

    console.log(`✅ Cleanup terminé: ${totalDeleted} vecteurs supprimés (antérieurs à ${cutoffIso}${workspaceFilter ? `, workspace=${workspaceFilter}` : ''})`);
    return { deletedCount: totalDeleted, cutoffDate: cutoffIso, workspaceFilter };
}