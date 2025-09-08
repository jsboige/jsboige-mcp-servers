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
}

// Fichiers de conversation bruts
interface ApiMessage {
    role: 'user' | 'assistant' | 'system';
    content: string | null;
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

    // TODO: Extraire parent_task_id et root_task_id depuis les métadonnées de la tâche

    try {
        if (require('fs').existsSync(apiHistoryPath)) {
            const apiHistoryContent = await fs.readFile(apiHistoryPath, 'utf-8');
            const apiMessages: ApiMessage[] = JSON.parse(apiHistoryContent);

            for (const msg of apiMessages) {
                if (msg.role === 'system') continue;

                // Un message peut avoir à la fois du contenu et un appel d'outil
                // Ils sont traités comme des événements séquentiels distincts.
                if (msg.content) {
                    chunks.push({
                        chunk_id: uuidv4(),
                        task_id: taskId,
                        parent_task_id: null, // TODO
                        root_task_id: null,   // TODO
                        chunk_type: 'message_exchange',
                        sequence_order: sequenceOrder++,
                        timestamp: msg.timestamp || new Date().toISOString(),
                        indexed: true,
                        content: msg.content,
                        content_summary: msg.content.substring(0, 200),
                        participants: [msg.role],
                        tool_details: null,
                    });
                }

                if (msg.tool_calls) {
                    for (const toolCall of msg.tool_calls) {
                        chunks.push({
                            chunk_id: uuidv4(),
                            task_id: taskId,
                            parent_task_id: null, // TODO
                            root_task_id: null,   // TODO
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
                        });
                    }
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
            // Seuls les chunks marqués comme 'indexed' seront vectorisés
            if (chunk.indexed) {
                const embeddingResponse = await getOpenAIClient().embeddings.create({
                    model: EMBEDDING_MODEL,
                    input: chunk.content,
                });
                const vector = embeddingResponse.data[0].embedding;

                // L'ID du point est l'ID du chunk pour une référence directe
                const point: PointStruct = {
                    id: chunk.chunk_id,
                    vector: vector,
                    payload: { ...chunk }, // Le payload est une copie du chunk
                };
                pointsToIndex.push(point);
            }
        }

        if (pointsToIndex.length > 0) {
            await getQdrantClient().upsert(COLLECTION_NAME, {
                wait: true,
                points: pointsToIndex,
            });
            console.log(`Successfully indexed ${pointsToIndex.length} chunks for task ${taskId}.`);
        } else {
            console.log(`No indexable chunks found for task ${taskId}.`);
        }

        return pointsToIndex;

    } catch (error) {
        console.error(`Failed to index task ${taskId}:`, error);
        throw error;
    }
}