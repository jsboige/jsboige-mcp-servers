import { QdrantClient } from '@qdrant/js-client-rest';
import getOpenAIClient, { getEmbeddingModel } from './openai.js';
import { getQdrantClient } from './qdrant.js';
import { RooStorageDetector } from '../utils/roo-storage-detector.js';
import { promises as fs } from 'fs';
import path from 'path';

// Interfaces partagées (idéalement dans un fichier de types dédié)
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

interface ApiMessage {
    role: 'user' | 'assistant' | 'system';
    content: string | null;
    tool_calls?: any[];
    timestamp?: string;
}

// Résultat de la recherche, maintenant une "fenêtre de contexte"
export interface ContextWindow {
    taskId: string;
    mainChunk: Chunk;
    contextBefore: Chunk[];
    contextAfter: Chunk[];
    relevanceScore: number;
}


/**
 * Recrée la liste complète des chunks pour une tâche donnée à partir de sa source de vérité.
 */
async function reconstructAllChunksForTask(taskId: string): Promise<Chunk[]> {
    const conversation = await RooStorageDetector.findConversationById(taskId);
    if (!conversation) {
        console.warn(`Could not find conversation path for task ${taskId} during context reconstitution.`);
        return [];
    }

    const chunks: Chunk[] = [];
    const apiHistoryPath = path.join(conversation.path, 'api_conversation_history.json');
    let sequenceOrder = 0;

    try {
        try {
            await fs.access(apiHistoryPath); // Check if file exists and is accessible
            const apiHistoryContent = await fs.readFile(apiHistoryPath, 'utf-8');
            const apiMessages: ApiMessage[] = JSON.parse(apiHistoryContent);

            for (const msg of apiMessages) {
                if (msg.role === 'system') continue;

                if (msg.content) {
                    chunks.push({
                        chunk_id: '', // Non pertinent pour la reconstitution
                        task_id: taskId,
                        parent_task_id: null,
                        root_task_id: null,
                        chunk_type: 'message_exchange',
                        sequence_order: sequenceOrder++,
                        timestamp: msg.timestamp || new Date().toISOString(),
                        indexed: true,
                        content: msg.content,
                        participants: [msg.role],
                    });
                }
                if (msg.tool_calls) {
                    for (const toolCall of msg.tool_calls) {
                         chunks.push({
                            chunk_id: '',
                            task_id: taskId,
                            parent_task_id: null,
                            root_task_id: null,
                            chunk_type: 'tool_interaction',
                            sequence_order: sequenceOrder++,
                            timestamp: msg.timestamp || new Date().toISOString(),
                            indexed: false,
                            content: `Tool call: ${toolCall.function.name}`,
                            tool_details: {
                                tool_name: toolCall.function.name,
                                parameters: JSON.parse(toolCall.function.arguments || '{}'),
                                status: 'success',
                            },
                        });
                    }
                }
            }
        } catch (readError) {
            // File doesn't exist or is unreadable, continue without it.
        }
    } catch (error) {
        console.error(`Error reconstructing chunks for task ${taskId}:`, error);
    }

    return chunks.sort((a, b) => a.sequence_order - b.sequence_order);
}

/**
 * Recherche sémantiquement des chunks et reconstitue leur contexte.
 */
export async function searchTasks(
  query: string,
  options: {
    startDate?: string;
    endDate?: string;
    limit?: number;
    contextBeforeCount?: number; // K
    contextAfterCount?: number; // M
    filter?: any; // Filtre Qdrant
    scoreThreshold?: number; // Seuil de score
  } = {}
): Promise<ContextWindow[]> {

  const openai = getOpenAIClient();
  const qdrant = getQdrantClient();
  const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
  const limit = options.limit || 5;
  const k = options.contextBeforeCount || 2;
  const m = options.contextAfterCount || 1;

  // 1. Vectoriser la requête
  const embeddingResponse = await openai.embeddings.create({
    model: getEmbeddingModel(),
    input: query,
  });
  const vector = embeddingResponse.data[0].embedding;

  // 2. Étape 1: Recherche des Chunks Initiaux dans Qdrant
  const searchResult = await qdrant.search(collectionName, {
    vector,
    limit,
    filter: options.filter,
    score_threshold: options.scoreThreshold,
    with_payload: true,
  });

  const foundChunks = searchResult.map(result => ({
    chunk: result.payload as unknown as Chunk,
    score: result.score,
  }));

  // 3. Étape 2: Reconstitution du Contexte
  const contextWindows: ContextWindow[] = [];
  for (const { chunk, score } of foundChunks) {
      const allTaskChunks = await reconstructAllChunksForTask(chunk.task_id);
      if (allTaskChunks.length === 0) continue;

      const mainChunkIndex = allTaskChunks.findIndex(c => c.sequence_order === chunk.sequence_order);
      if (mainChunkIndex === -1) continue;

      const startIndex = Math.max(0, mainChunkIndex - k);
      const endIndex = Math.min(allTaskChunks.length, mainChunkIndex + m + 1);

      const contextBefore = allTaskChunks.slice(startIndex, mainChunkIndex);
      const contextAfter = allTaskChunks.slice(mainChunkIndex + 1, endIndex);

      contextWindows.push({
          taskId: chunk.task_id,
          mainChunk: chunk,
          contextBefore,
          contextAfter,
          relevanceScore: score,
      });
  }

  return contextWindows;
}