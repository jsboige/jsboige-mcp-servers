import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';

// Namespace pour UUID v5 (généré aléatoirement une fois, constant pour le projet)
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export interface ToolDetails {
  tool_name: string;
  parameters: any;
  status: 'success' | 'failure' | 'in_progress';
  summary?: string;
  result?: any;
}

export interface Chunk {
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
export interface ApiMessage {
    role: 'user' | 'assistant' | 'system';
    content: any; // Can be string or array
    tool_calls?: any[];
    timestamp?: string;
}

export interface UiMessage {
    author: 'user' | 'agent';
    text: string;
    timestamp: string;
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
export async function extractChunksFromTask(taskId: string, taskPath: string): Promise<Chunk[]> {
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

export function splitChunk(chunk: Chunk, maxSize: number): Chunk[] {
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