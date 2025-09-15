import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import getOpenAIClient from './openai.js';
import { getQdrantClient } from './qdrant.js';
import { Schemas } from '@qdrant/js-client-rest';

type PointStruct = Schemas['PointStruct'];

const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
const EMBEDDING_MODEL = 'text-embedding-3-small';

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
            await qdrant.createCollection(COLLECTION_NAME, {
                vectors: {
                    size: 1536,
                    distance: 'Cosine',
                },
            });
            console.log(`Collection "${COLLECTION_NAME}" created successfully.`);
        }
    } catch (error) {
        console.error('Error ensuring Qdrant collection exists:', error);
        throw error;
    }
}

function getHostIdentifier() { return "Unknown" }

/**
 * Extrait et structure les chunks d'une tâche selon la stratégie granulaire.
 * @param taskId L'ID de la tâche.
 * @param taskPath Le chemin vers le répertoire de la tâche.
 * @returns Un tableau de chunks structurés.
 */
async function extractChunksFromTask(taskId: string, taskPath: string): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    const apiHistoryPath = path.join(taskPath, 'api_conversation_history.json');
    let sequenceOrder = 0;
    
    // Placeholder values
    let messageIndex = 0;
    let parentTaskId : string | undefined;
    let workspace : string | undefined;
    let taskTitle : string | undefined;
    let totalMessages : number | undefined;

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
                        parent_task_id: null,
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
                    });
                }
            }
        }
    } catch (error) {
        console.warn(`Could not read or parse ${apiHistoryPath}. Error: ${error}`);
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
                parent_task_id: null,
                root_task_id: null,
                chunk_type: 'message_exchange',
                sequence_order: sequenceOrder++,
                timestamp: msg.timestamp || new Date().toISOString(),
                indexed: true,
                content: msg.text,
                content_summary: (msg.text || '').substring(0, 200),
                participants: [msg.author === 'agent' ? 'assistant' : 'user'],
                tool_details: null,
            });
        }
    } catch (error) {
        console.warn(`Could not read or parse ${uiMessagesPath}. Error: ${error}`);
    }

    return chunks.sort((a, b) => a.sequence_order - b.sequence_order);
}


const MAX_CHUNK_SIZE = 8000; // Approx. 2000 tokens, safely below the 8192 limit

function splitChunk(chunk: Chunk, maxSize: number): Chunk[] {
    if (!chunk.content || chunk.content.length <= maxSize) {
        return [chunk];
    }

    const subChunks: Chunk[] = [];
    let content = chunk.content;
    let sequence = 0;

    while (content.length > 0) {
        const contentPart = content.substring(0, maxSize);
        content = content.substring(maxSize);

        subChunks.push({
            ...chunk,
            chunk_id: `${chunk.chunk_id}_part_${sequence}`,
            content: contentPart,
            content_summary: `Part ${sequence + 1}: ${contentPart.substring(0, 100)}...`,
        });
        sequence++;
    }
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

                for (const subChunk of subChunks) {
                    if(!subChunk.content || subChunk.content.trim() === '') continue;

                    const embeddingResponse = await getOpenAIClient().embeddings.create({
                        model: EMBEDDING_MODEL,
                        input: subChunk.content,
                    });
                    const vector = embeddingResponse.data[0].embedding;

                    const point: PointStruct = {
                        id: subChunk.chunk_id,
                        vector: vector,
                        payload: { ...subChunk },
                    };
                    pointsToIndex.push(point);
                }
            }
        }

        if (pointsToIndex.length > 0) {
            await getQdrantClient().upsert(COLLECTION_NAME, {
                wait: true,
                points: pointsToIndex,
            });
            console.log(`Successfully indexed ${pointsToIndex.length} points (from ${chunks.length} original chunks) for task ${taskId}.`);
        } else {
            console.log(`No indexable chunks found for task ${taskId}.`);
        }

        return pointsToIndex;

    } catch (error) {
        console.error(`Failed to index task ${taskId}:`, error);
        throw error;
    }
}

/**
 * Classe TaskIndexer pour l'architecture à 2 niveaux
 */
export class TaskIndexer {
    /**
     * Indexe une tâche à partir de son ID (trouve automatiquement le chemin)
     */
    async indexTask(taskId: string): Promise<PointStruct[]> {
        try {
            const { RooStorageDetector } = await import('../utils/roo-storage-detector.js');
            const locations = await RooStorageDetector.detectStorageLocations();
            
            for (const location of locations) {
                const taskPath = path.join(location, taskId);
                try {
                    await fs.access(taskPath);
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
            
            try {
                await qdrant.deleteCollection(COLLECTION_NAME);
                console.log(`Collection ${COLLECTION_NAME} supprimée`);
            } catch (error) {
                console.log(`Collection ${COLLECTION_NAME} n'existait pas, continuer...`);
            }
            
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
     * Compte les points dans Qdrant pour un host_os spécifique
     */
    async countPointsByHostOs(hostOs: string): Promise<number> {
        try {
            const qdrant = getQdrantClient();
            const result = await qdrant.count(COLLECTION_NAME, {
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
            return result.count;
        } catch (error) {
            console.error(`Could not count points for host_os=${hostOs}:`, error);
            return 0; // Retourner 0 en cas d'erreur
        }
    }
}