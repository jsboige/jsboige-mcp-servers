import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
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
  // Nouveaux champs pour la traçabilité du chunking
  chunk_index?: number;  // Index de ce chunk (commence à 1)
  total_chunks?: number; // Nombre total de chunks pour ce message
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
        
        // ✅ INFÉRENCE : Si parentTaskId manque, essayer de l'inférer du contenu
        if (!parentTaskId) {
            console.warn(`[extractChunksFromTask] Task ${taskId} missing parentTaskId, attempting inference...`);
            parentTaskId = await inferParentTaskIdFromContent(
                path.join(taskPath, 'api_conversation_history.json'),
                path.join(taskPath, 'ui_messages.json'),
                rawMetadata
            );
            
            if (parentTaskId) {
                console.log(`[extractChunksFromTask] ✅ Parent inféré pour ${taskId}: ${parentTaskId}`);
            }
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

        subChunks.push({
            ...chunk,
            chunk_id: `${chunk.chunk_id}_part_${chunkIndex}`,
            content: contentPart,
            content_summary: `Chunk ${chunkIndex}/${totalChunks}: ${contentPart.substring(0, 100)}...`,
            // Nouveaux champs de traçabilité
            chunk_index: chunkIndex,
            total_chunks: totalChunks
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
 * Tente d'inférer le parentTaskId à partir du contenu de la conversation
 * (même logique que roo-storage-detector.ts)
 */
async function inferParentTaskIdFromContent(
    apiHistoryPath: string,
    uiMessagesPath: string,
    rawMetadata: any
): Promise<string | undefined> {
    try {
        // 1. Analyser le premier message utilisateur dans api_conversation_history.json
        let parentId = await extractParentFromApiHistory(apiHistoryPath);
        if (parentId) return parentId;

        // 2. Analyser ui_messages.json pour des références
        parentId = await extractParentFromUiMessages(uiMessagesPath);
        if (parentId) return parentId;

        return undefined;
    } catch (error) {
        console.error(`[inferParentTaskIdFromContent] Erreur:`, error);
        return undefined;
    }
}

async function extractParentFromApiHistory(apiHistoryPath: string): Promise<string | undefined> {
    try {
        const content = await fs.readFile(apiHistoryPath, 'utf-8');
        const data = JSON.parse(content);
        const messages = Array.isArray(data) ? data : (data?.messages || []);
        
        const firstUserMessage = messages.find((msg: any) => msg.role === 'user');
        if (!firstUserMessage?.content) return undefined;

        const messageText = Array.isArray(firstUserMessage.content)
            ? firstUserMessage.content.find((c: any) => c.type === 'text')?.text || ''
            : firstUserMessage.content;

        return extractTaskIdFromText(messageText);
    } catch (error) {
        return undefined;
    }
}

async function extractParentFromUiMessages(uiMessagesPath: string): Promise<string | undefined> {
    try {
        const content = await fs.readFile(uiMessagesPath, 'utf-8');
        const data = JSON.parse(content);
        const messages = Array.isArray(data) ? data : [];
        
        const firstMessage = messages.find((msg: any) => msg.type === 'user');
        if (!firstMessage?.content) return undefined;

        return extractTaskIdFromText(firstMessage.content);
    } catch (error) {
        return undefined;
    }
}

function extractTaskIdFromText(text: string): string | undefined {
    if (!text) return undefined;

    // Pattern 1: UUIDs v4 explicites
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
    const uuids = text.match(uuidPattern);
    
    if (uuids && uuids.length > 0) {
        console.log(`[extractTaskIdFromText] UUID trouvé: ${uuids[0]}`);
        return uuids[0];
    }

    // Pattern 2: Références contextuelles
    const contextPatterns = [
        /CONTEXTE HÉRITÉ.*?([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i,
        /ORCHESTRATEUR.*?([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i,
        /tâche parent.*?([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i
    ];

    for (const pattern of contextPatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            console.log(`[extractTaskIdFromText] Parent trouvé via pattern: ${match[1]}`);
            return match[1];
        }
    }

    return undefined;
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
                const taskPath = path.join(location, 'tasks', taskId);
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