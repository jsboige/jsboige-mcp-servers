import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import { StateManagerError } from '../../types/errors.js';

// Namespace pour UUID v5 (généré aléatoirement une fois, constant pour le projet)
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * Maximum content size (in chars) before truncation for indexing.
 * Prevents explosion: a 30M char tool result at 800 chars/chunk = 37,500 embeddings.
 * 20,000 chars ≈ 25 chunks max, capturing the essential context without waste.
 * Configurable via env var for tuning.
 */
const MAX_INDEXABLE_CONTENT_SIZE = parseInt(process.env.MAX_INDEXABLE_CONTENT_SIZE || '20000', 10);

/**
 * Truncate content to MAX_INDEXABLE_CONTENT_SIZE, preserving start and end.
 * Keeps first 70% and last 30% to capture both the beginning context and final results.
 */
function truncateForIndexing(content: string, source?: string): string {
    if (content.length <= MAX_INDEXABLE_CONTENT_SIZE) return content;

    const headSize = Math.floor(MAX_INDEXABLE_CONTENT_SIZE * 0.7);
    const tailSize = MAX_INDEXABLE_CONTENT_SIZE - headSize - 80; // 80 chars for truncation marker
    const truncationMarker = `\n\n[TRUNCATED for indexing: ${content.length} chars → ${MAX_INDEXABLE_CONTENT_SIZE}. Source: ${source || 'unknown'}]\n\n`;

    console.log(`✂️ [ChunkExtractor] Truncating ${content.length} chars → ${MAX_INDEXABLE_CONTENT_SIZE} (source: ${source || 'unknown'})`);

    return content.substring(0, headSize) + truncationMarker + content.substring(content.length - tailSize);
}

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
  workspace?: string;           // Full path (e.g., "d:/roo-extensions") — intra-machine filtering
  workspace_name?: string;      // Basename (e.g., "roo-extensions") — cross-machine filtering
  task_title?: string;
  message_index?: number;
  total_messages?: number;
  role?: 'user' | 'assistant' | 'system';
  host_os?: string;
  source?: 'roo' | 'claude-code';
  // #636: Enriched metadata for advanced search filters
  model?: string;          // LLM model used (e.g., 'opus', 'sonnet', 'glm-5')
  tool_name?: string;      // Flattened from tool_details for Qdrant filtering
  has_error?: boolean;     // Whether this chunk contains an error
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
    let taskModel : string | undefined; // #636: Model from task metadata

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
        // #636: Extract model info from metadata if available
        taskModel = rawMetadata.model || rawMetadata.apiConfiguration?.apiModelId;

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
                    // Truncate oversized content (e.g., large tool results) to prevent embedding explosion
                    contentText = truncateForIndexing(contentText, `${msg.role}:msg#${messageIndex}`);

                    // #636: Detect error patterns in content
                    const lowerContent = contentText.toLowerCase();
                    const hasError = lowerContent.includes('error') ||
                        lowerContent.includes('failed') ||
                        lowerContent.includes('exception') ||
                        lowerContent.includes('❌') ||
                        lowerContent.includes('erreur');

                    chunks.push({
                        chunk_id: uuidv4(),
                        task_id: taskId,
                        parent_task_id: parentTaskId || null,
                        root_task_id: null,
                        chunk_type: 'message_exchange',
                        sequence_order: sequenceOrder++,
                        timestamp: msg.timestamp || new Date().toISOString(),
                        indexed: true,
                        content: contentText,
                        content_summary: String(contentText || '').substring(0, 200),
                        participants: [msg.role],
                        tool_details: null,
                        workspace: workspace,
                        workspace_name: workspace ? path.basename(workspace) : undefined,
                        task_title: taskTitle,
                        message_index: messageIndex,
                        total_messages: totalMessages,
                        role: msg.role,
                        host_os: getHostIdentifier(),
                        // #636: Enriched metadata
                        model: taskModel,
                        has_error: hasError || undefined,
                    });
                }
            }
            if (msg.tool_calls) {
                for (const toolCall of msg.tool_calls) {
                    // Parse tool arguments safely
                    let parsedArgs: any = {};
                    try {
                        parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
                    } catch {
                        parsedArgs = { raw: toolCall.function.arguments };
                    }

                    const toolContent = truncateForIndexing(
                        `Tool call: ${toolCall.function.name} with args ${toolCall.function.arguments}`,
                        `tool_call:${toolCall.function.name}`
                    );

                    chunks.push({
                        chunk_id: uuidv4(),
                        task_id: taskId,
                        parent_task_id: parentTaskId || null,
                        root_task_id: null,
                        chunk_type: 'tool_interaction',
                        sequence_order: sequenceOrder++,
                        timestamp: msg.timestamp || new Date().toISOString(),
                        indexed: false,
                        content: toolContent,
                        tool_details: {
                            tool_name: toolCall.function.name,
                            parameters: parsedArgs,
                            status: 'success',
                        },
                        // #636: Enriched metadata for Qdrant filtering
                        tool_name: toolCall.function.name,
                        model: taskModel,
                        workspace: workspace,
                        workspace_name: workspace ? path.basename(workspace) : undefined,
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
        throw new StateManagerError(
            `Extraction chunks échouée pour ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
            'CHUNK_EXTRACTION_FAILED',
            'ChunkExtractor',
            { taskId, apiHistoryPath },
            error instanceof Error ? error : undefined
        );
    }

    const uiMessagesPath = path.join(taskPath, 'ui_messages.json');
    try {
        await fs.access(uiMessagesPath);
        const uiMessagesContent = await fs.readFile(uiMessagesPath, 'utf-8');
        const uiMessages: UiMessage[] = JSON.parse(uiMessagesContent);

        for (const msg of uiMessages) {
            // #636: Detect error patterns
            const uiLower = (msg.text || '').toLowerCase();
            const uiHasError = uiLower.includes('error') || uiLower.includes('failed') || uiLower.includes('❌');

            const uiContent = truncateForIndexing(msg.text || '', `ui_message:${msg.author}`);

            chunks.push({
                chunk_id: uuidv4(),
                task_id: taskId,
                parent_task_id: parentTaskId || null,
                root_task_id: null,
                chunk_type: 'message_exchange',
                sequence_order: sequenceOrder++,
                timestamp: msg.timestamp || new Date().toISOString(),
                indexed: true,
                content: uiContent,
                content_summary: (uiContent || '').substring(0, 200),
                participants: [msg.author === 'agent' ? 'assistant' : 'user'],
                tool_details: null,
                workspace: workspace,
                task_title: taskTitle,
                host_os: getHostIdentifier(),
                // #636: Enriched metadata
                model: taskModel,
                has_error: uiHasError || undefined,
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

/**
 * Extract chunks from a Claude Code JSONL session file.
 * Reads the JSONL format (one JSON object per line) and converts
 * user/assistant messages to indexable chunks.
 *
 * @param taskId The session identifier (prefixed with 'claude-')
 * @param jsonlPath Path to the .jsonl file
 * @param metadata Optional metadata (workspace, title)
 * @returns Chunk array suitable for Qdrant indexation
 */
export async function extractChunksFromClaudeSession(
    taskId: string,
    jsonlPath: string,
    metadata?: { workspace?: string; title?: string }
): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    let sequenceOrder = 0;
    let messageIndex = 0;

    try {
        const content = await fs.readFile(jsonlPath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim());

        for (const line of lines) {
            try {
                const entry = JSON.parse(line);

                // Claude Code JSONL has entries with type and message fields
                const entryType = entry.type;
                const message = entry.message;

                // Only index user and assistant messages (not tool results, system, etc.)
                if (!message || !message.content) continue;
                if (entryType !== 'user' && entryType !== 'assistant') continue;

                const role: 'user' | 'assistant' = entryType === 'user' ? 'user' : 'assistant';

                // Extract text content (can be string or array of content blocks)
                let contentText = '';
                if (typeof message.content === 'string') {
                    contentText = message.content;
                } else if (Array.isArray(message.content)) {
                    contentText = message.content
                        .filter((block: any) => block && block.type === 'text' && typeof block.text === 'string')
                        .map((block: any) => block.text)
                        .join(' ')
                        .trim();
                }

                if (!contentText.trim()) continue;

                // Truncate oversized content to prevent embedding explosion
                contentText = truncateForIndexing(contentText, `claude-${role}:msg#${messageIndex + 1}`);

                messageIndex++;
                // #636: Detect error patterns and extract model
                const ccLower = contentText.toLowerCase();
                const ccHasError = ccLower.includes('error') || ccLower.includes('failed') || ccLower.includes('❌');

                chunks.push({
                    chunk_id: uuidv4(),
                    task_id: taskId,
                    parent_task_id: null,
                    root_task_id: null,
                    chunk_type: 'message_exchange',
                    sequence_order: sequenceOrder++,
                    timestamp: entry.timestamp || new Date().toISOString(),
                    indexed: true,
                    content: contentText,
                    content_summary: contentText.substring(0, 200),
                    participants: [role],
                    tool_details: null,
                    workspace: metadata?.workspace,
                    workspace_name: metadata?.workspace ? path.basename(metadata.workspace) : undefined,
                    task_title: metadata?.title,
                    message_index: messageIndex,
                    role,
                    host_os: getHostIdentifier(),
                    source: 'claude-code',
                    // #636: Enriched metadata
                    model: entry.model || message?.model,
                    has_error: ccHasError || undefined,
                });
            } catch {
                // Skip malformed lines
                continue;
            }
        }
    } catch (error) {
        console.error(`❌ Error extracting chunks from Claude session ${jsonlPath}:`, error);
        throw new StateManagerError(
            `Extraction chunks échouée pour Claude session ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
            'CHUNK_EXTRACTION_FAILED',
            'ChunkExtractor',
            { taskId, jsonlPath },
            error instanceof Error ? error : undefined
        );
    }

    return chunks.sort((a, b) => a.sequence_order - b.sequence_order);
}