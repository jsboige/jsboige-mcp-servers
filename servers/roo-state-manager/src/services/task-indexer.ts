import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import getOpenAIClient from './openai.js';
import { getQdrantClient } from './qdrant.js';
import { Schemas } from '@qdrant/js-client-rest';

type PointStruct = Schemas['PointStruct'];

const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
const EMBEDDING_MODEL = 'text-embedding-3-small';

// Configuration pour l'optimisation par paquets
const EMBEDDING_BATCH_SIZE = 100; // Nombre d'embeddings à traiter par lot OpenAI
const QDRANT_BATCH_SIZE = 50;     // Nombre de points à insérer par lot Qdrant
const MAX_RETRIES = 3;            // Nombre max de tentatives en cas d'erreur
const RETRY_DELAY_MS = 1000;      // Délai entre les tentatives (ms)

// --- Utilitaire pour identifier la machine ---
function getHostIdentifier(): string {
    const hostname = os.hostname();
    const platform = os.platform();
    const arch = os.arch();
    return `${platform}-${arch}-${hostname}`;
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
  
  // Nouvelles métadonnées enrichies
  workspace?: string;
  task_title?: string;
  message_index?: number;
  total_messages?: number;
  role?: 'user' | 'assistant' | 'system';
  host_os?: string;  // Identifiant de la machine d'origine
}

/**
 * Analyse et extrait les chunks d'une tâche spécifique
 */
async function extractChunksFromTask(taskId: string, taskPath: string): Promise<Chunk[]> {
    const apiHistoryPath = path.join(taskPath, 'api_conversation_history.json');
    const uiMessagesPath = path.join(taskPath, 'ui_messages.json');
    const metadataPath = path.join(taskPath, 'task_metadata.json');

    let chunks: Chunk[] = [];
    let sequenceOrder = 0;
    let messageIndex = 0;

    // Lire les métadonnées pour enrichir les chunks
    let workspace = '';
    let taskTitle = taskId;
    let parentTaskId = null;
    let totalMessages = 0;

    try {
        const metadataContent = await fs.readFile(metadataPath, 'utf8');
        const metadata = JSON.parse(metadataContent);
        workspace = metadata.workspace || '';
        taskTitle = metadata.title || taskId;
        parentTaskId = metadata.parentTaskId;
    } catch (error) {
        console.warn(`Could not read metadata for task ${taskId}:`, error);
    }

    // Premier passage pour compter le nombre total de messages
    try {
        const apiHistoryContent = await fs.readFile(apiHistoryPath, 'utf8');
        const apiMessages = JSON.parse(apiHistoryContent);
        totalMessages = apiMessages.filter((msg: any) => msg.role !== 'system').length;
    } catch (error) {
        console.warn(`Could not count messages in ${apiHistoryPath}:`, error);
    }

    // Traiter api_conversation_history.json (priorité car plus structuré)
    try {
        const apiHistoryContent = await fs.readFile(apiHistoryPath, 'utf8');
        const apiMessages = JSON.parse(apiHistoryContent);
        
        for (const msg of apiMessages) {
            if (msg.role === 'system') continue;

            // Un message peut avoir à la fois du contenu et un appel d'outil
            // Ils sont traités comme des événements séquentiels distincts.
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
                    contentText = String(msg.content.toString());
                }

                if (contentText.trim()) {
                    chunks.push({
                        chunk_id: uuidv4(),
                        task_id: taskId,
                        parent_task_id: parentTaskId || null,
                        root_task_id: null, // TODO: calculer la racine si nécessaire
                        chunk_type: 'message_exchange',
                        sequence_order: sequenceOrder++,
                        timestamp: msg.timestamp || new Date().toISOString(),
                        indexed: true,
                        content: contentText,
                        content_summary: String(contentText || '').substring(0, 200),
                        participants: [msg.role],
                        tool_details: null,
                        // Nouvelles métadonnées enrichies
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
                        parent_task_id: parentTaskId || null,
                        root_task_id: null,
                        chunk_type: 'tool_interaction',
                        sequence_order: sequenceOrder++,
                        timestamp: msg.timestamp || new Date().toISOString(),
                        indexed: false,
                        content: `Tool call: ${toolCall.function.name} with args ${toolCall.function.arguments}`,
                        tool_details: {
                            tool_name: toolCall.function.name,
                            parameters: JSON.parse(toolCall.function.arguments || '{}'),
                            status: 'success', // Simplification pour le test
                        },
                        // Nouvelles métadonnées enrichies
                        workspace: workspace,
                        task_title: taskTitle,
                        role: msg.role,
                        host_os: getHostIdentifier(),
                    });
                }
            }
        }
    } catch (error) {
        console.warn(`Could not read or parse ${apiHistoryPath}:`, error);
    }

    // UI messages ne sont généralement pas structurés pour le tool calling,
    // on les traite comme des message_exchange simples.
    // L'implémentation future pourrait vouloir les fusionner plus intelligemment.

    return chunks.sort((a, b) => a.sequence_order - b.sequence_order);
}

/**
 * Fonction utilitaire pour introduire un délai
 */
async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Traitement par paquets avec gestion d'erreurs robuste
 */
async function processBatchWithRetry<T, R>(
    items: T[],
    batchSize: number,
    processor: (batch: T[]) => Promise<R[]>,
    maxRetries: number = MAX_RETRIES
): Promise<R[]> {
    const results: R[] = [];
    
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        let attempt = 0;
        
        while (attempt < maxRetries) {
            try {
                const batchResults = await processor(batch);
                results.push(...batchResults);
                console.log(`✅ Processed batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(items.length/batchSize)}: ${batch.length} items`);
                break;
            } catch (error) {
                attempt++;
                console.error(`❌ Batch ${Math.floor(i/batchSize) + 1} failed (attempt ${attempt}/${maxRetries}):`, error);
                
                if (attempt >= maxRetries) {
                    console.error(`💥 Batch ${Math.floor(i/batchSize) + 1} permanently failed after ${maxRetries} attempts`);
                    throw error;
                } else {
                    console.log(`⏳ Retrying batch ${Math.floor(i/batchSize) + 1} in ${RETRY_DELAY_MS}ms...`);
                    await delay(RETRY_DELAY_MS * attempt); // Backoff exponentiel
                }
            }
        }
    }
    
    return results;
}

/**
 * Fonction principale d'indexation d'une tâche avec optimisations par paquets
 */
export async function indexTask(taskId: string, taskPath: string): Promise<PointStruct[]> {
    console.log(`🚀 Starting optimized batch indexing for task: ${taskId}`);
    
    try {
        // 1. Extraire les chunks
        const chunks = await extractChunksFromTask(taskId, taskPath);
        const eligibleChunks = chunks.filter(chunk => chunk.indexed && chunk.content.trim());
        
        if (eligibleChunks.length === 0) {
            console.log(`⚠️  No eligible chunks found for task ${taskId}`);
            return [];
        }
        
        console.log(`📊 Found ${chunks.length} total chunks, ${eligibleChunks.length} eligible for indexing`);
        console.log(`🔍 Indexed flags:`, chunks.reduce((acc, c) => { acc[c.indexed ? 'indexed' : 'not_indexed'] = (acc[c.indexed ? 'indexed' : 'not_indexed'] || 0) + 1; return acc; }, {} as any));
        
        // 2. Traitement par paquets des embeddings OpenAI
        const embeddingProcessor = async (batch: Chunk[]): Promise<Array<{chunk: Chunk, embedding: number[]}>> => {
            const openai = getOpenAIClient();
            const texts = batch.map(chunk => chunk.content);
            
            const embeddingResponse = await openai.embeddings.create({
                model: EMBEDDING_MODEL,
                input: texts,
            });
            
            return batch.map((chunk, index) => ({
                chunk,
                embedding: embeddingResponse.data[index].embedding
            }));
        };
        
        console.log(`🔄 Processing ${eligibleChunks.length} chunks in batches of ${EMBEDDING_BATCH_SIZE}...`);
        const embeddedChunks = await processBatchWithRetry(
            eligibleChunks,
            EMBEDDING_BATCH_SIZE,
            embeddingProcessor
        );
        
        // 3. Préparation des points Qdrant
        const pointsToIndex: PointStruct[] = embeddedChunks.map(({chunk, embedding}) => ({
            id: chunk.chunk_id,
            vector: embedding,
            payload: {
                task_id: chunk.task_id,
                parent_task_id: chunk.parent_task_id,
                root_task_id: chunk.root_task_id,
                chunk_type: chunk.chunk_type,
                sequence_order: chunk.sequence_order,
                timestamp: chunk.timestamp,
                content: chunk.content,
                content_summary: chunk.content_summary,
                participants: chunk.participants,
                tool_details: chunk.tool_details,
                custom_tags: chunk.custom_tags,
                // Nouvelles métadonnées enrichies
                workspace: chunk.workspace,
                task_title: chunk.task_title,
                message_index: chunk.message_index,
                total_messages: chunk.total_messages,
                role: chunk.role,
                host_os: chunk.host_os,
            }
        }));
        
        // 4. Insertion par paquets dans Qdrant
        const qdrantProcessor = async (batch: PointStruct[]): Promise<PointStruct[]> => {
            const qdrant = getQdrantClient();
            // --- AJOUT DE LOGS POUR LE DÉBOGAGE ---
            if (batch.length > 0) {
                const samplePoint = { ...batch[0] };
                // @ts-ignore
                delete samplePoint.vector; // Supprimer le vecteur pour la lisibilité
                console.log(`[DEBUG QDRANT] Preparing to upsert batch of ${batch.length} points.`);
                console.log(`[DEBUG QDRANT] Full sample point (minus vector): ${JSON.stringify(samplePoint, null, 2)}`);
            }
            // --- FIN DES LOGS DE DÉBOGAGE ---
            await qdrant.upsert(COLLECTION_NAME, {
                wait: true,
                points: batch,
            });
            return batch;
        };
        
        console.log(`💾 Inserting ${pointsToIndex.length} points in Qdrant in batches of ${QDRANT_BATCH_SIZE}...`);
        await processBatchWithRetry(
            pointsToIndex,
            QDRANT_BATCH_SIZE,
            qdrantProcessor
        );
        
        console.log(`✅ Successfully indexed ${pointsToIndex.length} chunks for task ${taskId}`);
        return pointsToIndex;
        
    } catch (error) {
        console.error(`💥 Failed to index task ${taskId}:`, error);
        throw error;
    }
}

/**
 * Classe utilitaire pour les opérations d'indexation
 */
export class TaskIndexer {
    /**
     * Indexe une tâche spécifique en auto-détectant son emplacement
     */
    async indexTask(taskId: string): Promise<PointStruct[]> {
        try {
            // Détection automatique du chemin de la tâche
            const { RooStorageDetector } = await import('../utils/roo-storage-detector.js');
            const locations = await RooStorageDetector.detectStorageLocations();
            
            for (const location of locations) {
                const taskPath = path.join(location, 'tasks', taskId);
                try {
                    await fs.access(taskPath);
                    // Tâche trouvée, on l'indexe
                    return await indexTask(taskId, taskPath);
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
     * Réinitialise complètement la collection Qdrant
     */
    async resetCollection(): Promise<void> {
        try {
            const qdrant = getQdrantClient();
            
            // Supprimer la collection si elle existe
            try {
                await qdrant.deleteCollection(COLLECTION_NAME);
                console.log(`Collection ${COLLECTION_NAME} supprimée`);
            } catch (error) {
                console.log(`Collection ${COLLECTION_NAME} n'existait pas, continuer...`);
            }
            
            // Recréer la collection
            await qdrant.createCollection(COLLECTION_NAME, {
                vectors: {
                    size: 1536,
                    distance: 'Cosine',
                },
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
     * Compte les points dans Qdrant filtrés par host_os
     */
    async countPointsByHostOs(hostOs?: string): Promise<number> {
        try {
            const qdrant = getQdrantClient();
            const targetHostOs = hostOs || getHostIdentifier();
            
            // Utiliser scroll pour compter avec filtrage
            const scrollResult = await qdrant.scroll(COLLECTION_NAME, {
                filter: {
                    must: [
                        {
                            key: 'host_os',
                            match: { value: targetHostOs }
                        }
                    ]
                },
                limit: 1, // On veut juste compter
                with_payload: false,
                with_vector: false
            });
            
            // Si scroll retourne des résultats, on doit faire plusieurs appels pour compter exactement
            let totalCount = 0;
            let nextPageOffset = scrollResult.next_page_offset;
            
            // Premier lot
            totalCount += scrollResult.points?.length || 0;
            
            // Continue si il y a d'autres pages
            while (nextPageOffset) {
                const nextScroll = await qdrant.scroll(COLLECTION_NAME, {
                    filter: {
                        must: [
                            {
                                key: 'host_os',
                                match: { value: targetHostOs }
                            }
                        ]
                    },
                    limit: 100, // Plus efficace pour le comptage
                    offset: nextPageOffset,
                    with_payload: false,
                    with_vector: false
                });
                
                totalCount += nextScroll.points?.length || 0;
                nextPageOffset = nextScroll.next_page_offset;
            }
            
            return totalCount;
        } catch (error) {
            console.error('Erreur lors du comptage des points par host_os:', error);
            return 0;
        }
    }

    /**
     * Obtient l'identifiant de la machine actuelle
     */
    getCurrentHostIdentifier(): string {
        return getHostIdentifier();
    }
}