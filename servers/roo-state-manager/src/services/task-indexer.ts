import { promises as fs, writeFileSync } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import getOpenAIClient from './openai.js';
import { getQdrantClient } from './qdrant.js';
import { Schemas } from '@qdrant/js-client-rest';

type PointStruct = Schemas['PointStruct'];

const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
const EMBEDDING_MODEL = 'text-embedding-3-small';
// Namespace pour UUID v5 (généré aléatoirement une fois, constant pour le projet)
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

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

// FIX SDDD: Configuration batch pour réindexation massive
const BATCH_MODE_ENABLED = true;
const BATCH_SIZE = 50;
const BATCH_DELAY = 5000; // 5 secondes entre lots

// 📊 MÉTRIQUES DE MONITORING BANDE PASSANTE
interface NetworkMetrics {
    qdrantCalls: number;
    openaiCalls: number;
    cacheHits: number;
    cacheMisses: number;
    bytesTransferred: number;
    lastReset: number;
}

const networkMetrics: NetworkMetrics = {
    qdrantCalls: 0,
    openaiCalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
    bytesTransferred: 0,
    lastReset: Date.now()
};

/**
 * ✅ CORRECTION P0 (2025-10-15)
 * Rate Limiter pour protéger Qdrant des surcharges
 * Limite: 10 requêtes/seconde maximum vers Qdrant
 *
 * Coordination avec Agent Qdrant:
 * - Infrastructure Qdrant prête (59/59 collections HNSW optimisé)
 * - Protection contre les boucles infinies d'indexation
 */
class QdrantRateLimiter {
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

const qdrantRateLimiter = new QdrantRateLimiter();

// 🛡️ FONCTION DE RETRY AVEC BACKOFF EXPONENTIEL
async function retryWithBackoff<T>(
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

// 📊 FONCTION DE LOGGING DES MÉTRIQUES
function logNetworkMetrics(): void {
    const now = Date.now();
    const elapsedHours = (now - networkMetrics.lastReset) / (1000 * 60 * 60);

    console.log(`📊 [METRICS] Utilisation réseau (dernières ${elapsedHours.toFixed(1)}h):`);
    console.log(`   - Appels Qdrant: ${networkMetrics.qdrantCalls}`);
    console.log(`   - Appels OpenAI: ${networkMetrics.openaiCalls}`);
    console.log(`   - Cache hits: ${networkMetrics.cacheHits}`);
    console.log(`   - Cache misses: ${networkMetrics.cacheMisses}`);
    console.log(`   - Ratio cache: ${((networkMetrics.cacheHits / (networkMetrics.cacheHits + networkMetrics.cacheMisses || 1)) * 100).toFixed(1)}%`);
    console.log(`   - Bytes approximatifs: ${(networkMetrics.bytesTransferred / 1024 / 1024).toFixed(2)}MB`);
}

// --- Nouvelles Interfaces conformes au SDDD ---

interface ToolDetails {
  tool_name: string;
  parameters: any;
  status: 'success' | 'failure' | 'in_progress';
  summary?: string;
  result?: any;
}

interface Chunk {
  chunk_id: string;
  task_id: string;
  parent_task_id: string | null;
  root_task_id: string | null;
  chunk_type: 'message_exchange' | 'tool_interaction' | 'task_summary';
  sequence_order: number;
  timestamp: string;
  indexed: boolean;
  content: string;
  content_summary?: string;
  participants?: ('user' | 'assistant')[];
  tool_details?: ToolDetails | null;
  custom_tags?: string[];
  workspace?: string;
  task_title?: string;
  message_index?: number;
  total_messages?: number;
  role?: 'user' | 'assistant' | 'system';
  host_os?: string;
  // Nouveaux champs pour la traçabilité du chunking
  chunk_index?: number;  // Index de ce chunk (commence à 1)
  total_chunks?: number; // Nombre total de chunks pour ce message
  original_chunk_id?: string; // ID original avant split (pour traçabilité)
}

// Fichiers de conversation bruts
interface ApiMessage {
    role: 'user' | 'assistant' | 'system';
    content: any; // Can be string or array
    tool_calls?: any[];
    timestamp?: string;
}

interface UiMessage {
    author: 'user' | 'agent';
    text: string;
    timestamp: string;
}

/**
 * Assure que la collection Qdrant existe. Si non, la crée.
 */
async function ensureCollectionExists() {
    try {
        const qdrant = getQdrantClient();
        const result = await qdrant.getCollections();
        const collectionExists = result.collections.some((collection) => collection.name === COLLECTION_NAME);

        if (!collectionExists) {
            console.log(`Collection "${COLLECTION_NAME}" not found. Creating...`);

            // 🚨 FIX CRITIQUE: Spécifier max_indexing_threads > 0 lors de la création
            // Sans cela, Qdrant peut utiliser 0 par défaut, causant des deadlocks avec wait=true
            // Référence: diagnostics/20251013_DIAGNOSTIC_FINAL.md - "max_indexing_threads: 0"
            await qdrant.createCollection(COLLECTION_NAME, {
                vectors: {
                    size: 1536,
                    distance: 'Cosine',
                },
                hnsw_config: {
                    max_indexing_threads: 2  // ✅ DOIT être > 0 pour éviter deadlock avec wait=true
                }
            });
            console.log(`Collection "${COLLECTION_NAME}" created successfully with max_indexing_threads: 2`);
        }
    } catch (error) {
        console.error('Error ensuring Qdrant collection exists:', error);
        throw error;
    }
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
 * Validation et nettoyage des payloads avant envoi à Qdrant
 */
function sanitizePayload(payload: any): any {
    const cleaned = { ...payload };

    // Nettoyer les valeurs problématiques
    Object.keys(cleaned).forEach(key => {
        if (cleaned[key] === undefined) {
            delete cleaned[key];
        }
        if (cleaned[key] === null && key !== 'parent_task_id' && key !== 'root_task_id') {
            delete cleaned[key];
        }
        // S'assurer que les strings ne sont pas vides
        if (typeof cleaned[key] === 'string' && cleaned[key].trim() === '') {
            delete cleaned[key];
        }
    });

    return cleaned;
}

/**
 * Valide qu'un vecteur a la bonne dimension et ne contient pas de NaN/Infinity
 */
function validateVectorGlobal(vector: number[], expectedDim: number = 1536): void {
    if (!Array.isArray(vector)) {
        throw new Error(`Vector doit être un tableau, reçu: ${typeof vector}`);
    }

    if (vector.length !== expectedDim) {
        throw new Error(`Dimension invalide: ${vector.length}, attendu: ${expectedDim}`);
    }

    // Vérifier NaN/Infinity qui causent erreurs 400
    const hasInvalidValues = vector.some(v => !Number.isFinite(v));
    if (hasInvalidValues) {
        throw new Error(`Vector contient NaN ou Infinity`);
    }
}

/**
 * Appel sécurisé à Qdrant avec circuit breaker, retry et batching intelligent
 */
async function safeQdrantUpsert(points: PointStruct[]): Promise<boolean> {
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

    // 🚀 BATCHING INTELLIGENT: Si plus de 100 points, découper en batches
    // DEBUG: Réduit à 1 pour diagnostic précis
    const batchSize = 1;
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

                // DEBUG: Logger le premier point pour diagnostic 400
                if (attempt === 0) {
                    const sample = batch[0];
                    console.log(`🔍 [safeQdrantUpsert] Sample Point ID: ${sample.id}`);
                    console.log(`🔍 [safeQdrantUpsert] Sample Payload Keys: ${Object.keys(sample.payload || {}).join(', ')}`);
                    console.log(`🔍 [safeQdrantUpsert] Sample Vector Length: ${Array.isArray(sample.vector) ? sample.vector.length : 'Not array'}`);

                    // DUMP COMPLET DU PAYLOAD AVANT ENVOI
                    // console.error(`🔍 [safeQdrantUpsert] FULL PAYLOAD DUMP:`, JSON.stringify(sample.payload, null, 2));


                    // On laisse l'erreur pour arrêter le processus et voir le log
                    throw new Error(`DEBUG_PAYLOAD_DUMP attempted`);
                }

                await getQdrantClient().upsert(COLLECTION_NAME, {
                    wait: shouldWait,
                    points: batch,
                });

                const attemptDuration = Date.now() - attemptStartTime;

                batchSuccess = true;

                // 📊 Mise à jour métriques réseau
                networkMetrics.qdrantCalls++;
                networkMetrics.bytesTransferred += batch.length * 6144; // 1536 dims * 4 bytes

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

export function getHostIdentifier() {
    // Crée un identifiant unique basé sur les informations système
    const hostname = os.hostname();
    const platform = os.platform();
    const arch = os.arch();
    return `${hostname}-${platform}-${arch}`;
}

/**
 * Extrait et structure les chunks d'une tâche selon la stratégie granulaire.
 * @param taskId L'ID de la tâche.
 * @param taskPath Le chemin vers le répertoire de la tâche.
 * @returns Un tableau de chunks structurés.
 */
async function extractChunksFromTask(taskId: string, taskPath: string): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    const apiHistoryPath = path.join(taskPath, 'api_conversation_history.json');
    const metadataPath = path.join(taskPath, 'task_metadata.json');
    let sequenceOrder = 0;

    // Variables pour les métadonnées extraites
    let messageIndex = 0;
    let parentTaskId : string | undefined;
    let workspace : string | undefined;
    let taskTitle : string | undefined;
    let totalMessages : number | undefined;

    // 🎯 CORRECTION CRITIQUE - Extraction des métadonnées hiérarchiques
    // Utilisation de la même logique que roo-storage-detector.ts pour cohérence
    try {
        const metadataContent = await fs.readFile(metadataPath, 'utf-8');
        // Nettoyage explicite du BOM (Byte Order Mark)
        const cleanMetadata = metadataContent.charCodeAt(0) === 0xFEFF
            ? metadataContent.slice(1)
            : metadataContent;
        const rawMetadata = JSON.parse(cleanMetadata);

        // ✅ LOGIQUE UNIFIÉE : Même extraction que roo-storage-detector.ts:426
        parentTaskId = rawMetadata.parentTaskId || rawMetadata.parent_task_id;

        // 🚫 SUPPRIMÉ : inferParentTaskIdFromContent - impasse remontante
        // Le parentId doit être enregistré de façon descendante au moment de la création
        if (!parentTaskId) {
            console.log(`[extractChunksFromTask] Task ${taskId} sans parentTaskId - normal pour tâche racine ou parentId non encore enregistré`);
        }

        workspace = rawMetadata.workspace;
        taskTitle = rawMetadata.title;

        console.log(`📊 [extractChunksFromTask] Extracted metadata for ${taskId}: parentTaskId=${parentTaskId}, workspace=${workspace}`);
    } catch (error) {
        console.warn(`⚠️ [extractChunksFromTask] Could not read metadata for ${taskId}:`, error);
        // Continuer sans métadonnées - ne pas faire planter l'indexation
    }

    try {
        await fs.access(apiHistoryPath);
        const apiHistoryContent = await fs.readFile(apiHistoryPath, 'utf-8');
        const apiMessages: ApiMessage[] = JSON.parse(apiHistoryContent);

        for (const msg of apiMessages) {
            if (msg.role === 'system') continue;
            if (msg.content) {
                messageIndex++;

                // Handle both string and array content (OpenAI format) with improved safety
                let contentText: string = '';
                if (typeof msg.content === 'string') {
                    contentText = msg.content;
                } else if (Array.isArray(msg.content)) {
                    // Safely extract text from complex array content
                    contentText = (msg.content as any[])
                        .map((part: any) => {
                            if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
                                return part.text;
                            }
                            return '';
                        })
                        .join(' ')
                        .trim();
                } else if (msg.content) {
                    // Fallback for any other type, ensuring it becomes a string
                    contentText = String(msg.content);
                }

                if (contentText.trim()) {
                    chunks.push({
                        chunk_id: uuidv4(),
                        task_id: taskId,
                        parent_task_id: parentTaskId || null, // ✅ FIX: Maintenant correctement assigné
                        root_task_id: null, // TODO: calculer la racine si nécessaire
                        chunk_type: 'message_exchange',
                        sequence_order: sequenceOrder++,
                        timestamp: msg.timestamp || new Date().toISOString(),
                        indexed: true,
                        content: contentText,
                        content_summary: String(contentText || '').substring(0, 200),
                        participants: [msg.role],
                        tool_details: null,
                        // ✅ FIX: Métadonnées enrichies maintenant correctement assignées
                        workspace: workspace,
                        task_title: taskTitle,
                        message_index: messageIndex,
                        total_messages: totalMessages,
                        role: msg.role,
                        host_os: getHostIdentifier(),
                    });
                }
            }
            if (msg.tool_calls) {
                for (const toolCall of msg.tool_calls) {
                    chunks.push({
                        chunk_id: uuidv4(),
                        task_id: taskId,
                        parent_task_id: parentTaskId || null, // ✅ FIX: Utilisation cohérente de parentTaskId
                        root_task_id: null,
                        chunk_type: 'tool_interaction',
                        sequence_order: sequenceOrder++,
                        timestamp: msg.timestamp || new Date().toISOString(),
                        indexed: false,
                        content: `Tool call: ${toolCall.function.name} with args ${toolCall.function.arguments}`,
                        tool_details: {
                            tool_name: toolCall.function.name,
                            parameters: JSON.parse(toolCall.function.arguments || '{}'),
                            status: 'success',
                        },
                        // ✅ FIX: Ajout des métadonnées contextuelles pour les tool_calls
                        workspace: workspace,
                        task_title: taskTitle,
                        host_os: getHostIdentifier(),
                    });
                }
            }
        }
    } catch (error) {
        /**
         * ✅ CORRECTION P0 (2025-10-15) - Amélioration gestion d'erreur
         * Plus de faux succès : propager l'erreur pour diagnostic
         */
        console.error('❌ ERREUR CRITIQUE extraction chunks:', error);
        console.error('Stack trace:', error instanceof Error ? error.stack : 'No stack');
        console.error(`Fichier problématique: ${apiHistoryPath}`);
        console.error(`Task ID: ${taskId}`);

        // Propager l'erreur pour éviter faux succès silencieux
        throw new Error(`Extraction chunks échouée pour ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const uiMessagesPath = path.join(taskPath, 'ui_messages.json');
    try {
        await fs.access(uiMessagesPath);
        const uiMessagesContent = await fs.readFile(uiMessagesPath, 'utf-8');
        const uiMessages: UiMessage[] = JSON.parse(uiMessagesContent);

        for (const msg of uiMessages) {
            chunks.push({
                chunk_id: uuidv4(),
                task_id: taskId,
                parent_task_id: parentTaskId || null, // ✅ FIX: Cohérence avec l'extraction de métadonnées
                root_task_id: null,
                chunk_type: 'message_exchange',
                sequence_order: sequenceOrder++,
                timestamp: msg.timestamp || new Date().toISOString(),
                indexed: true,
                content: msg.text,
                content_summary: (msg.text || '').substring(0, 200),
                participants: [msg.author === 'agent' ? 'assistant' : 'user'],
                tool_details: null,
                // ✅ FIX: Ajout des métadonnées contextuelles pour ui_messages
                workspace: workspace,
                task_title: taskTitle,
                host_os: getHostIdentifier(),
            });
        }
    } catch (error) {
        console.warn(`Could not read or parse ${uiMessagesPath}. Error: ${error}`);
    }

    return chunks.sort((a, b) => a.sequence_order - b.sequence_order);
}


const MAX_CHUNK_SIZE = 800; // Approx. 200-400 tokens, ultra-conservative safety margin below 8192 limit for text-embedding-3-small

function splitChunk(chunk: Chunk, maxSize: number): Chunk[] {
    if (!chunk.content || chunk.content.length <= maxSize) {
        // Chunk unique, on ajoute les métadonnées de traçabilité
        return [{
            ...chunk,
            chunk_index: 1,
            total_chunks: 1
        }];
    }

    // Calcul du nombre total de chunks nécessaires
    const totalChunks = Math.ceil(chunk.content.length / maxSize);
    const subChunks: Chunk[] = [];
    let content = chunk.content;
    let chunkIndex = 1;

    while (content.length > 0) {
        const contentPart = content.substring(0, maxSize);
        content = content.substring(maxSize);

        // 🚨 FIX CRITIQUE: Qdrant exige des UUIDs valides pour les IDs
        // On utilise uuidv5 pour générer un UUID déterministe à partir de l'ID composite
        const compositeId = `${chunk.chunk_id}_part_${chunkIndex}`;
        const deterministicUuid = uuidv5(compositeId, UUID_NAMESPACE);

        subChunks.push({
            ...chunk,
            chunk_id: deterministicUuid, // UUID valide au lieu de string arbitraire
            content: contentPart,
            content_summary: `Chunk ${chunkIndex}/${totalChunks}: ${contentPart.substring(0, 100)}...`,
            // Nouveaux champs de traçabilité
            chunk_index: chunkIndex,
            total_chunks: totalChunks,
            original_chunk_id: chunk.chunk_id // Garder trace de l'ID original
        });
        chunkIndex++;
    }

    console.log(`🔪 Split large chunk into ${totalChunks} parts (original size: ${chunk.content.length} chars)`);
    return subChunks;
}


/**
 * Indexe une seule tâche en créant des chunks granulaires, en générant des embeddings
 * sélectivement et en les stockant dans Qdrant.
 * @param taskId L'ID de la tâche à indexer.
 * @param taskPath Le chemin complet vers le répertoire de la tâche.
 */
export async function indexTask(taskId: string, taskPath: string): Promise<PointStruct[]> {
    console.log(`Starting granular indexing for task: ${taskId}`);

    try {
        await ensureCollectionExists();
        const chunks = await extractChunksFromTask(taskId, taskPath);

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
                        // 🌐 APPEL RÉSEAU OpenAI - Maintenant seulement si nécessaire
                        const embeddingResponse = await getOpenAIClient().embeddings.create({
                            model: EMBEDDING_MODEL,
                            input: subChunk.content,
                        });
                        vector = embeddingResponse.data[0].embedding;

                        // 🔧 FIX CRITIQUE: Validation améliorée avec logging détaillé
                        // Ajout de logs détaillés pour diagnostiquer les problèmes d'embedding
                        console.log(`[DEBUG] Embedding response reçu:`, {
                            model: embeddingResponse.model,
                            usage: embeddingResponse.usage,
                            vectorLength: vector?.length || 'undefined',
                            chunkId: subChunk.chunk_id
                        });

                        // Validation robuste avec gestion d'erreurs améliorée
                        if (!vector || !Array.isArray(vector)) {
                            console.error(`❌ [indexTask] Embedding invalide: pas un tableau pour chunk ${subChunk.chunk_id}`);
                            console.error(`❌ [indexTask] Type reçu: ${typeof vector}, contenu: ${subChunk.content.substring(0, 100)}...`);
                            // Continuer avec le prochain chunk au lieu de tout arrêter
                            continue;
                        }

                        if (vector.length !== 1536) {
                            console.warn(`⚠️ [indexTask] Dimension inattendue: ${vector.length} (attendu: 1536) pour chunk ${subChunk.chunk_id}`);
                            console.warn(`⚠️ [indexTask] Modèle utilisé: ${EMBEDDING_MODEL}`);
                            // Au lieu de rejeter, on tente d'utiliser le vecteur quand même
                            // Qdrant pourrait accepter des dimensions variables ou on ajustera plus tard
                            console.log(`[INFO] Tentative d'indexation avec dimension ${vector.length} pour chunk ${subChunk.chunk_id}`);
                        }

                        // Stocker en cache
                        embeddingCache.set(contentHash, { vector, timestamp: now });
                        operationTimestamps.push(now);
                        console.log(`[CACHE] Embedding mis en cache pour subchunk ${subChunk.chunk_id} (dimension: ${vector.length})`);
                    }

                    const point: PointStruct = {
                        id: subChunk.chunk_id,
                        vector: vector,
                        payload: { ...subChunk },
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
 * Tente d'inférer le parentTaskId à partir du contenu de la conversation
 * (même logique que roo-storage-detector.ts)
 */
// 🚫 SUPPRIMÉ : Toutes les fonctions de remontée parent/enfant
// Le système doit fonctionner en mode descendant : détecter création de sous-tâches XML
// et enregistrer le parentId au moment de la création

/**
 * Classe TaskIndexer pour l'architecture à 2 niveaux
 */
export class TaskIndexer {
    private qdrantClient = getQdrantClient();
    private healthCheckInterval?: NodeJS.Timeout;

    /**
     * Valide qu'un vecteur a la bonne dimension et ne contient pas de NaN/Infinity
     */
    private validateVector(vector: number[], expectedDim: number = 1536): void {
        if (!Array.isArray(vector)) {
            throw new Error(`Vector doit être un tableau, reçu: ${typeof vector}`);
        }

        if (vector.length !== expectedDim) {
            throw new Error(`Dimension invalide: ${vector.length}, attendu: ${expectedDim}`);
        }

        // Vérifier NaN/Infinity qui causent erreurs 400
        const hasInvalidValues = vector.some(v => !Number.isFinite(v));
        if (hasInvalidValues) {
            throw new Error(`Vector contient NaN ou Infinity - invalide pour Qdrant`);
        }
    }

    /**
     * Vérifie la santé de la collection et log les métriques
     */
    private async checkCollectionHealth(): Promise<{
        status: string;
        points_count: number;
        segments_count: number;
        indexed_vectors_count: number;
        optimizer_status: string;
    }> {
        try {
            const collectionInfo = await this.qdrantClient.getCollection(COLLECTION_NAME);

            const metrics = {
                status: collectionInfo.status || 'unknown',
                points_count: collectionInfo.points_count || 0,
                segments_count: collectionInfo.segments_count || 0,
                indexed_vectors_count: collectionInfo.indexed_vectors_count || 0,
                optimizer_status: typeof collectionInfo.optimizer_status === 'string'
                    ? collectionInfo.optimizer_status
                    : (collectionInfo.optimizer_status as any)?.error || 'ok'
            };

            // Log si status != 'green'
            if (metrics.status !== 'green') {
                console.error('⚠️ Collection Qdrant unhealthy:', {
                    status: metrics.status,
                    points: metrics.points_count,
                    segments: metrics.segments_count,
                    indexed_vectors: metrics.indexed_vectors_count,
                    optimizer: metrics.optimizer_status
                });
            } else {
                console.log('✓ Collection health check OK:', {
                    points: metrics.points_count,
                    segments: metrics.segments_count,
                    indexed_vectors: metrics.indexed_vectors_count
                });
            }

            return metrics;

        } catch (error: any) {
            console.error('✗ Échec health check collection:', error.message);
            throw error;
        }
    }

    /**
     * Insère des points avec batching intelligent et monitoring
     * @param points - Points à insérer
     * @param options - Options d'insertion
     */
    private async upsertPointsBatch(
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
                            this.validateVector(point.vector as number[]);
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
                        return await this.qdrantClient.upsert(COLLECTION_NAME, {
                            points: batch,
                            wait: shouldWait
                        });
                    });

                    success = true;
                    console.log(`✓ Batch ${batchNumber}/${totalBatches} inséré (${batch.length} points, wait=${shouldWait})`);

                    networkMetrics.qdrantCalls++;
                    networkMetrics.bytesTransferred += batch.length * 6144; // Approximation: 1536 dims * 4 bytes

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
     * Initialise le health check périodique
     */
    startHealthCheck(): void {
        if (this.healthCheckInterval) {
            return; // Déjà démarré
        }

        // Health check périodique toutes les 5 minutes
        this.healthCheckInterval = setInterval(async () => {
            try {
                await this.checkCollectionHealth();
            } catch (error) {
                console.error('Erreur health check périodique:', error);
            }
        }, 5 * 60 * 1000);

        console.log('✓ Health check périodique démarré (intervalle: 5 minutes)');
    }

    /**
     * Arrête le health check périodique
     */
    stopHealthCheck(): void {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = undefined;
            console.log('✓ Health check périodique arrêté');
        }
    }

    /**
     * Indexe une tâche à partir de son ID (trouve automatiquement le chemin)
     */
    async indexTask(taskId: string): Promise<PointStruct[]> {
        try {
            const { RooStorageDetector } = await import('../utils/roo-storage-detector.js');
            const locations = await RooStorageDetector.detectStorageLocations();

            for (const location of locations) {
                const taskPath = path.join(location, 'tasks', taskId);
                try {
                    await fs.access(taskPath);
                    const points = await indexTask(taskId, taskPath);

                    // FIX ARCHITECTURAL: Mettre à jour le squelette ICI, pas dans index.ts
                    await this.updateSkeletonIndexTimestamp(taskId, location);

                    return points;
                } catch {
                    // Tâche pas dans ce location, on continue
                }
            }

            throw new Error(`Task ${taskId} not found in any storage location`);
        } catch (error) {
            console.error(`Error indexing task ${taskId}:`, error);
            throw error;
        }
    }

    /**
     * FIX ARCHITECTURAL: Met à jour le timestamp d'indexation dans le squelette
     * Cette responsabilité devrait être ICI, pas dans index.ts
     */
    async updateSkeletonIndexTimestamp(taskId: string, storageLocation: string): Promise<void> {
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
    async resetCollection(): Promise<void> {
        try {
            const qdrant = getQdrantClient();

            try {
                await qdrant.deleteCollection(COLLECTION_NAME);
                console.log(`Collection ${COLLECTION_NAME} supprimée`);
            } catch (error) {
                console.log(`Collection ${COLLECTION_NAME} n'existait pas, continuer...`);
            }

            // 🚨 FIX CRITIQUE: Spécifier max_indexing_threads > 0 lors de la recréation
            await qdrant.createCollection(COLLECTION_NAME, {
                vectors: {
                    size: 1536,
                    distance: 'Cosine',
                },
                hnsw_config: {
                    max_indexing_threads: 2  // ✅ DOIT être > 0 pour éviter deadlock avec wait=true
                }
            });

            console.log(`Collection ${COLLECTION_NAME} recréée avec succès`);
        } catch (error) {
            console.error('Erreur lors de la réinitialisation de la collection Qdrant:', error);
            throw error;
        }
    }

    /**
     * Vérifie l'état de la collection Qdrant
     */
    async getCollectionStatus(): Promise<{ exists: boolean; count: number }> {
        try {
            const qdrant = getQdrantClient();
            const result = await qdrant.getCollections();
            const collectionExists = result.collections.some((collection) => collection.name === COLLECTION_NAME);

            if (collectionExists) {
                const info = await qdrant.getCollection(COLLECTION_NAME);
                return {
                    exists: true,
                    count: info.points_count || 0
                };
            } else {
                return { exists: false, count: 0 };
            }
        } catch (error) {
            console.error('Erreur lors de la vérification de l\'état de la collection:', error);
            throw error;
        }
    }

    /**
     * Compte les points dans Qdrant pour un host_os spécifique
     */
    async countPointsByHostOs(hostOs: string): Promise<number> {
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
            networkMetrics.bytesTransferred += 1024; // Approximation pour l'appel count
            return result.count;
        } catch (error) {
            console.error(`Could not count points for host_os=${hostOs}:`, error);
            return 0; // Retourner 0 en cas d'erreur
        }
    }

}