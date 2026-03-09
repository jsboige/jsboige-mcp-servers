import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Schemas } from '@qdrant/js-client-rest';
import { getQdrantClient } from '../qdrant.js';
import getOpenAIClient, { getEmbeddingModel, getEmbeddingDimensions } from '../openai.js';
import { validateVectorGlobal, sanitizePayload } from './EmbeddingValidator.js';
import { extractChunksFromTask, extractChunksFromClaudeSession, splitChunk, Chunk } from './ChunkExtractor.js';
import { networkMetrics } from './QdrantHealthMonitor.js';

type PointStruct = Schemas['PointStruct'];

const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

/** Configurable batch size for Qdrant upserts (was hardcoded to 1 for debug) */
const INDEXING_BATCH_SIZE = Math.max(1, parseInt(process.env.INDEXING_BATCH_SIZE || '50', 10) || 50);

// --- Circuit Breaker Configuration ---
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000; // 2 seconds
const CIRCUIT_BREAKER_TIMEOUT_MS = 30000; // 30 seconds
let circuitBreakerState = 'CLOSED'; // CLOSED | OPEN | HALF_OPEN
let failureCount = 0;
let lastFailureTime = 0;

// 🛡️ CACHE ANTI-FUITE POUR ÉVITER EMBEDDINGS RÉPÉTÉS
const embeddingCache = new Map<string, { vector: number[], timestamp: number }>();
const EMBEDDING_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 jours cache pour embeddings (FIX: augmenté de 24h)
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_OPERATIONS_PER_WINDOW = 100; // Max 100 operations/minute (FIX: augmenté de 10 pour éviter boucle)
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
    } catch (error) {
        console.error('Error ensuring Qdrant collection exists:', error);
        throw error;
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
                    recordFailure();
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
 * Indexe une seule tâche en créant des chunks granulaires, en générant des embeddings
 * sélectivement et en les stockant dans Qdrant.
 * @param taskId L'ID de la tâche à indexer.
 * @param taskPath Le chemin complet vers le répertoire de la tâche.
 */
export async function indexTask(taskId: string, taskPath: string, source: 'roo' | 'claude-code' = 'roo'): Promise<PointStruct[]> {
    console.log(`Starting granular indexing for task: ${taskId} (source: ${source})`);

    try {
        await ensureCollectionExists();

        // Dispatch to appropriate chunk extractor based on source
        const chunks = source === 'claude-code'
            ? await extractChunksFromClaudeSession(taskId, taskPath)
            : await extractChunksFromTask(taskId, taskPath);

        if (chunks.length === 0) {
            console.log(`No chunks found for task ${taskId}. Skipping.`);
            return [];
        }

        const pointsToIndex: PointStruct[] = [];

        for (const chunk of chunks) {
            if (chunk.indexed) {
                const subChunks = splitChunk(chunk, MAX_CHUNK_SIZE);
                console.log(`📊 Original chunk size: ${chunk.content?.length || 0} chars, split into ${subChunks.length} subchunks`);

                for (const subChunk of subChunks) {
                    if(!subChunk.content || subChunk.content.trim() === '') continue;

                    console.log(`📝 Processing subchunk: ${subChunk.content.length} characters (estimated ~${Math.ceil(subChunk.content.length / 4)} tokens)`);

                    // 🛡️ PROTECTION ANTI-FUITE: Rate limiting
                    const now = Date.now();
                    operationTimestamps = operationTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);
                    if (operationTimestamps.length >= MAX_OPERATIONS_PER_WINDOW) {
                        console.warn(`[RATE-LIMIT] Trop d'opérations récentes (${operationTimestamps.length}/${MAX_OPERATIONS_PER_WINDOW}). Attente...`);
                        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_WINDOW));
                        operationTimestamps = []; // Reset after wait
                    }

                    // 🛡️ CACHE EMBEDDINGS pour éviter appels OpenAI répétés
                    const contentHash = crypto.createHash('sha256').update(subChunk.content).digest('hex');
                    let vector: number[];

                    const cached = embeddingCache.get(contentHash);

                    if (cached && (now - cached.timestamp < EMBEDDING_CACHE_TTL)) {
                        console.log(`[CACHE] Embedding trouvé en cache pour subchunk ${subChunk.chunk_id}`);
                        vector = cached.vector;
                    } else {
                        const embeddingModel = getEmbeddingModel();
                        const expectedDims = getEmbeddingDimensions();

                        const embeddingResponse = await getOpenAIClient().embeddings.create({
                            model: embeddingModel,
                            input: subChunk.content,
                        });
                        vector = embeddingResponse.data[0].embedding;

                        console.log(`[DEBUG] Embedding response reçu:`, {
                            model: embeddingResponse.model,
                            usage: embeddingResponse.usage,
                            vectorLength: vector?.length || 'undefined',
                            chunkId: subChunk.chunk_id
                        });

                        if (!vector || !Array.isArray(vector)) {
                            console.error(`❌ [indexTask] Embedding invalide: pas un tableau pour chunk ${subChunk.chunk_id}`);
                            continue;
                        }

                        if (vector.length !== expectedDims) {
                            console.warn(`⚠️ [indexTask] Dimension inattendue: ${vector.length} (attendu: ${expectedDims}) pour chunk ${subChunk.chunk_id}`);
                            console.warn(`⚠️ [indexTask] Modèle utilisé: ${embeddingModel}`);
                        }

                        embeddingCache.set(contentHash, { vector, timestamp: now });
                        operationTimestamps.push(now);
                        console.log(`[CACHE] Embedding mis en cache pour subchunk ${subChunk.chunk_id} (dimension: ${vector.length})`);
                    }

                    const point: PointStruct = {
                        id: subChunk.chunk_id,
                        vector: vector,
                        payload: { ...subChunk, source: source },
                    };
                    pointsToIndex.push(point);
                }
            }
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
                console.error(`❌ Échec indexation pour tâche ${taskId} - Circuit breaker activé ou erreurs répétées`);
                // Ne pas throw l'erreur pour éviter la boucle infernale
                // Retourner un tableau vide pour indiquer l'échec sans crasher
                return [];
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

        // 🚨 CORRECTION CRITIQUE: Ne plus re-throw l'erreur qui cause la boucle infernale
        // À la place, log l'erreur et retourner un résultat vide
        console.error(`🔴 ERREUR CRITIQUE INTERCEPTÉE pour tâche ${taskId}: Circuit breaker activé`);
        recordFailure();
        return [];
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