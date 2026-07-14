import { promises as fs, createReadStream } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { v5 as uuidv5 } from 'uuid';
import { StateManagerError } from '../../types/errors.js';

// Namespace pour UUID v5 (généré aléatoirement une fois, constant pour le projet)
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * #2018: Compute a deterministic chunk_id from logical chunk identity.
 *
 * Same (task_id, chunk_type, sequence_order, content) → same UUID.
 * Re-indexation upserts existing points instead of creating duplicates.
 *
 * Seed: `${task_id}|${chunk_type}|seq:${sequence_order}|${sha256_16}`
 * sha256 truncated to 16 hex chars: 64-bit collision resistance, sufficient
 * intra-task where the seq+task_id already disambiguate non-content collisions.
 */
export function computeChunkId(
    taskId: string,
    _chunkType: string,
    sequenceOrder: number,
    content: string
): string {
    // #2247: chunk_type removed from seed — future taxonomy fixes won't break UUIDs
    const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    const seed = `${taskId}|seq:${sequenceOrder}|${contentHash}`;
    return uuidv5(seed, UUID_NAMESPACE);
}

/**
 * #1758: Maximum chunks per task_id before hard truncation.
 * Prevents runaway indexing of worker sessions with 200K+ messages.
 * Default: 50,000 chunks ≈ ~2000 messages (25 chunks/msg average).
 * Configurable via MAX_CHUNKS_PER_TASK env var.
 */
export const MAX_CHUNKS_PER_TASK = parseInt(process.env.MAX_CHUNKS_PER_TASK || '50000', 10);

/**
 * #1758: Maximum messages per task before warning + early truncation.
 * Sessions exceeding this are likely runaway workers (--continue loops).
 * Default: 10,000 messages. Configurable via MAX_MESSAGES_PER_TASK env var.
 */
export const MAX_MESSAGES_PER_TASK = parseInt(process.env.MAX_MESSAGES_PER_TASK || '10000', 10);

/**
 * #2825 (volet A / G1): Maximum sub-chunks a single message/tool chunk may split into.
 *
 * Replaces the former mid-content truncation (`truncateForIndexing`, which dropped the
 * MIDDLE of any content > 20k chars — silently losing the reasoning inside long assistant
 * messages). Content is now carried in FULL into chunks and split losslessly downstream by
 * `splitChunk`. This budget preserves the #1758 anti-explosion intent as a *bounded, logged*
 * backstop for pathological single values (e.g. multi-MB tool dumps) instead of a silent
 * amputation: 2,000 sub-chunks × 800 chars (MAX_CHUNK_SIZE) ≈ 1.6 MB fully indexed per message.
 * Any residual beyond the budget is `console.warn`-ed, never dropped silently.
 * Configurable via MAX_SUBCHUNKS_PER_CHUNK env var (raise it to index even larger single values).
 */
export const MAX_SUBCHUNKS_PER_CHUNK = parseInt(process.env.MAX_SUBCHUNKS_PER_CHUNK || '2000', 10);

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
  // #2825 (volet A / G3): pagination metadata for lossless splitting of oversized
  // conversations. When a task exceeds MAX_MESSAGES_PER_TASK, the extractor emits
  // the overflow as additional "child units" with synthetic task_ids
  // (`${taskId}#unit-${N}`); `child_unit_index` is the 1-based page number and
  // `child_unit_total` is the total page count. (root_task_id is declared above
  // as `string | null`; pagination lineage is conveyed via parent_task_id chain.)
  child_unit_index?: number;
  child_unit_total?: number;
  // #2825 (volet A / G5): chunk_type 'task_summary' is the first-class type for
  // condensation outputs — already declared in the union above; this comment is
  // the marker for downstream consumers (search filters, dashboards).
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
    // #2825 (volet A / G5): when a task's metadata.source === 'condensation-fallback',
    // the chunks we emit carry chunk_type='task_summary' (instead of 'message_exchange')
    // so search consumers can filter condensation outputs. Set after metadata read below.
    let sourceKind: 'roo' | 'claude-code' | 'condensation-fallback' | null = null;
    // #2825 (volet A / G2): child-unit paging constants. Declared in outer scope so the
    // ui_messages loop below (separate try block) shares the same paging — both loops
    // count toward the same child-unit boundary, preserving lineage across message sources.
    let MESSAGES_PER_CHILD_UNIT = MAX_MESSAGES_PER_TASK;
    let childUnitCount = 1;

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
        // #2825 (G5): detect synthetic condensation tasks so we emit chunk_type='task_summary'
        if (rawMetadata.source === 'condensation-fallback') {
            sourceKind = 'condensation-fallback';
        }

        console.log(`📊 [extractChunksFromTask] Extracted metadata for ${taskId}: parentTaskId=${parentTaskId}, workspace=${workspace}`);
    } catch (error) {
        console.warn(`⚠️ [extractChunksFromTask] Could not read metadata for ${taskId}:`, error);
        // Continuer sans métadonnées - ne pas faire planter l'indexation
    }

    try {
        await fs.access(apiHistoryPath);
        const apiHistoryContent = await fs.readFile(apiHistoryPath, 'utf-8');
        const apiMessages: ApiMessage[] = JSON.parse(apiHistoryContent);

        // #2825 (volet A / G2): page through ALL messages — no silent drop.
        // The previous `slice(0, MAX_MESSAGES_PER_TASK)` amputated 90%+ of runaway
        // worker sessions with no recovery. We now iterate over every message and
        // emit child unit IDs (${taskId}#unit-N) when crossing the budget boundary,
        // so the entire conversation stays searchable in Qdrant. The split is
        // LOGGED (not silently truncated) per the "no silent caps" principle.
        // The #1758 anti-runaway intent is preserved as a *budget per child unit*,
        // not as a hard ceiling on indexed content.
        const totalMessagesCount = apiMessages.length;
        if (totalMessagesCount > MAX_MESSAGES_PER_TASK) {
            console.warn(`⚠️ [#2825/G2] Task ${taskId} has ${totalMessagesCount} messages — exceeds MAX_MESSAGES_PER_TASK=${MAX_MESSAGES_PER_TASK}; splitting into child units (NO DROP, all messages will be indexed).`);
        }
        // Reassign the outer-scope paging constants (declared at function top).
        MESSAGES_PER_CHILD_UNIT = MAX_MESSAGES_PER_TASK;
        childUnitCount = Math.max(1, Math.ceil(totalMessagesCount / MESSAGES_PER_CHILD_UNIT));

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

                    // #2336 D2 étape B: Extract tool_use blocks (Anthropic format) → populate msg.tool_calls
                    // so the existing handler below (line ~260) can emit tool_interaction chunks.
                    if (!msg.tool_calls) {
                        const toolUseBlocks = (msg.content as any[]).filter(
                            (part: any) => part && typeof part === 'object' && part.type === 'tool_use'
                        );
                        if (toolUseBlocks.length > 0) {
                            msg.tool_calls = toolUseBlocks.map((block: any) => ({
                                function: {
                                    name: block.name || 'unknown',
                                    arguments: typeof block.input === 'string'
                                        ? block.input
                                        : JSON.stringify(block.input || {}),
                                },
                            }));
                        }
                    }
                } else if (msg.content) {
                    // Fallback for any other type, ensuring it becomes a string
                    contentText = String(msg.content);
                }

                if (contentText.trim()) {
                    // #2825 (G1): content carried in FULL — split losslessly downstream by splitChunk (no mid-content amputation).
                    // #636: Detect error patterns in content
                    const lowerContent = contentText.toLowerCase();
                    const hasError = lowerContent.includes('error') ||
                        lowerContent.includes('failed') ||
                        lowerContent.includes('exception') ||
                        lowerContent.includes('❌') ||
                        lowerContent.includes('erreur');

                    const seq = sequenceOrder++;
                    // #2825 (G2/G3): assign to a child unit when crossing the page boundary.
                    // Unit #1 keeps the original task_id so existing task_id filters still
                    // find the head of the conversation; overflow pages get synthetic child ids.
                    const unitIndex0 = Math.floor((messageIndex - 1) / MESSAGES_PER_CHILD_UNIT);
                    const childUnitIdx = unitIndex0 + 1;
                    const isOverflowUnit = childUnitIdx > 1;
                    const effectiveTaskId = isOverflowUnit
                        ? `${taskId}#unit-${childUnitIdx}`
                        : taskId;
                    // #2825 (G5): chunk_type 'task_summary' for condensation outputs
                    const chunkType = sourceKind === 'condensation-fallback' ? 'task_summary' : 'message_exchange';
                    chunks.push({
                        chunk_id: computeChunkId(effectiveTaskId, chunkType, seq, contentText),
                        task_id: effectiveTaskId,
                        parent_task_id: isOverflowUnit ? taskId : (parentTaskId || null),
                        root_task_id: parentTaskId || (isOverflowUnit ? taskId : null),
                        chunk_type: chunkType,
                        sequence_order: seq,
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
                        // #2825 (G2/G3): pagination metadata so search can reassemble siblings
                        child_unit_index: childUnitIdx,
                        child_unit_total: childUnitCount,
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

                    // #2825 (G1): full args carried — split losslessly downstream by splitChunk.
                    const toolContent = `Tool call: ${toolCall.function.name} with args ${toolCall.function.arguments}`;

                    const seq = sequenceOrder++;
                    // #2825 (G2/G3): tool calls belong to the same child unit as their
                    // parent message (use messageIndex as the paging anchor).
                    const toolUnitIndex0 = Math.floor((messageIndex - 1) / MESSAGES_PER_CHILD_UNIT);
                    const toolChildUnitIdx = toolUnitIndex0 + 1;
                    const toolIsOverflow = toolChildUnitIdx > 1;
                    const toolEffectiveTaskId = toolIsOverflow
                        ? `${taskId}#unit-${toolChildUnitIdx}`
                        : taskId;
                    chunks.push({
                        chunk_id: computeChunkId(toolEffectiveTaskId, 'tool_interaction', seq, toolContent),
                        task_id: toolEffectiveTaskId,
                        parent_task_id: toolIsOverflow ? taskId : (parentTaskId || null),
                        root_task_id: parentTaskId || (toolIsOverflow ? taskId : null),
                        chunk_type: 'tool_interaction',
                        sequence_order: seq,
                        timestamp: msg.timestamp || new Date().toISOString(),
                        indexed: true, // #2247: tool interactions are valuable search targets
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
                        // #2825 (G2/G3): pagination metadata
                        child_unit_index: toolChildUnitIdx,
                        child_unit_total: childUnitCount,
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

            const uiContent = msg.text || ''; // #2825 (G1): full content — split losslessly downstream by splitChunk.

            const seq = sequenceOrder++;
            // #2825 (G2/G3): UI messages count toward the same child-unit paging as api messages.
            const uiMessageIndex = ++messageIndex;
            const uiUnitIndex0 = Math.floor((uiMessageIndex - 1) / MESSAGES_PER_CHILD_UNIT);
            const uiChildUnitIdx = uiUnitIndex0 + 1;
            const uiIsOverflow = uiChildUnitIdx > 1;
            const uiEffectiveTaskId = uiIsOverflow
                ? `${taskId}#unit-${uiChildUnitIdx}`
                : taskId;
            // #2825 (G5): chunk_type 'task_summary' for condensation outputs
            const uiChunkType = sourceKind === 'condensation-fallback' ? 'task_summary' : 'message_exchange';
            chunks.push({
                chunk_id: computeChunkId(uiEffectiveTaskId, uiChunkType, seq, uiContent),
                task_id: uiEffectiveTaskId,
                parent_task_id: uiIsOverflow ? taskId : (parentTaskId || null),
                root_task_id: parentTaskId || (uiIsOverflow ? taskId : null),
                chunk_type: uiChunkType,
                sequence_order: seq,
                timestamp: msg.timestamp || new Date().toISOString(),
                indexed: true,
                content: uiContent,
                content_summary: (uiContent || '').substring(0, 200),
                participants: [msg.author === 'agent' ? 'assistant' : 'user'],
                tool_details: null,
                workspace: workspace,
                workspace_name: workspace ? path.basename(workspace) : undefined,
                task_title: taskTitle,
                host_os: getHostIdentifier(),
                // #636: Enriched metadata
                model: taskModel,
                has_error: uiHasError || undefined,
                // #2825 (G2/G3): pagination metadata
                child_unit_index: uiChildUnitIdx,
                child_unit_total: childUnitCount,
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
    const fullTotal = Math.ceil(chunk.content.length / maxSize);
    // #2825 (G1): bound runaway embedding for pathological single values (preserves #1758 intent),
    // but do it as a *bounded, logged* cap here instead of a silent mid-content amputation upstream.
    const totalChunks = Math.min(fullTotal, MAX_SUBCHUNKS_PER_CHUNK);
    const subChunks: Chunk[] = [];
    let content = chunk.content;
    let chunkIndex = 1;

    while (content.length > 0 && chunkIndex <= totalChunks) {
        const contentPart = content.substring(0, maxSize);
        content = content.substring(maxSize);

        // #2018: chunk.chunk_id is now deterministic upstream (computeChunkId),
        // so the split parts inherit determinism: same input → same UUIDs.
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

    // #2825 (G1): never a silent drop — surface any residual per the "no silent caps" principle.
    if (content.length > 0) {
        console.warn(`⚠️ [splitChunk] chunk ${chunk.chunk_id} exceeded MAX_SUBCHUNKS_PER_CHUNK=${MAX_SUBCHUNKS_PER_CHUNK} (content ${chunk.content.length} chars, maxSize=${maxSize}, full split would be ${fullTotal} parts); ${content.length} residual chars NOT indexed. Raise MAX_SUBCHUNKS_PER_CHUNK to index the whole value.`);
    }

    console.log(`🔪 Split large chunk into ${subChunks.length} parts (original size: ${chunk.content.length} chars${fullTotal > totalChunks ? `, capped from ${fullTotal}` : ''})`);
    return subChunks;
}

/**
 * Extract chunks from a Claude Code JSONL session file.
 * Reads the JSONL format (one JSON object per line) and converts
 * user/assistant messages to indexable chunks.
 *
 * #852 FIX: Now accepts a project directory and scans all JSONL files within it.
 *
 * @param taskId The session identifier (prefixed with 'claude-')
 * @param projectPath Path to the project directory (will scan for .jsonl files) OR direct .jsonl file path
 * @param metadata Optional metadata (workspace, title)
 * @returns Chunk array suitable for Qdrant indexation
 */
export async function extractChunksFromClaudeSession(
    taskId: string,
    projectPath: string,
    metadata?: { workspace?: string; title?: string }
): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    let sequenceOrder = 0;
    let messageIndex = 0;

    try {
        // #852 FIX: Accept project directory and scan for JSONL files
        const stat = await fs.stat(projectPath);
        let jsonlFiles: string[];

        if (stat.isDirectory()) {
            // projectPath is a directory - scan for JSONL files
            const entries = await fs.readdir(projectPath);
            jsonlFiles = entries
                .filter(e => e.endsWith('.jsonl'))
                .map(e => path.join(projectPath, e));

            if (jsonlFiles.length === 0) {
                console.log(`[Claude] No JSONL files found in ${projectPath}`);
                return [];
            }
            console.log(`[Claude] Found ${jsonlFiles.length} JSONL files in ${projectPath}`);
        } else {
            // projectPath is a file - use directly (backward compatibility)
            jsonlFiles = [projectPath];
        }

        // Process all JSONL files - collect partial results on error
        const fileErrors: { file: string; error: string }[] = [];

        for (const jsonlFile of jsonlFiles) {
            try {
                // Stream JSONL instead of loading entire file into memory.
                // 112 MB files cause 300s+ timeout when read+split all at once.
                // #2825 (G2): process every line inline — do NOT cap the in-memory
                // buffer at MAX_MESSAGES_PER_TASK. Each line is emitted as a chunk
                // tagged with `child_unit_index` (its page number) so the full
                // conversation stays searchable in Qdrant. Memory stays bounded
                // because chunks are pushed (not accumulated as strings).
                const fileStream = createReadStream(jsonlFile, 'utf-8');
                const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

                let totalLines = 0;
                let fileMessageCount = 0;

                for await (const line of rl) {
                    if (!line.trim()) continue;
                    totalLines++;
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
                        let claudeToolUseBlocks: any[] = [];
                        if (typeof message.content === 'string') {
                            contentText = message.content;
                        } else if (Array.isArray(message.content)) {
                            contentText = message.content
                                .filter((block: any) => block && block.type === 'text' && typeof block.text === 'string')
                                .map((block: any) => block.text)
                                .join(' ')
                                .trim();

                            // #2336 D2 étape B: Collect tool_use blocks for tool_interaction chunks
                            claudeToolUseBlocks = message.content.filter(
                                (block: any) => block && typeof block === 'object' && block.type === 'tool_use'
                            );
                        }

                        if (!contentText.trim() && claudeToolUseBlocks.length === 0) continue;

                        // #2825 (G1): content carried in FULL — split losslessly downstream by splitChunk (no mid-content amputation).
                        messageIndex++;
                        fileMessageCount++;
                        // #636: Detect error patterns and extract model
                        const ccLower = contentText.toLowerCase();
                        const ccHasError = ccLower.includes('error') || ccLower.includes('failed') || ccLower.includes('❌');

                        // #2825 (G2/G3): child-unit paging. The first MAX_MESSAGES_PER_TASK
                        // lines stay on the original taskId; overflow lines get synthetic
                        // child ids with the original taskId as parent_task_id.
                        const claudeUnitIndex0 = Math.floor((totalLines - 1) / MAX_MESSAGES_PER_TASK);
                        const claudeChildUnitIdx = claudeUnitIndex0 + 1;
                        const claudeIsOverflow = claudeChildUnitIdx > 1;
                        const claudeChildUnitTotal = Math.max(1, Math.ceil(totalLines / MAX_MESSAGES_PER_TASK));
                        const claudeEffectiveTaskId = claudeIsOverflow
                            ? `${taskId}#unit-${claudeChildUnitIdx}`
                            : taskId;

                        const seq = sequenceOrder++;
                        chunks.push({
                            chunk_id: computeChunkId(claudeEffectiveTaskId, 'claude_message', seq, contentText),
                            task_id: claudeEffectiveTaskId,
                            parent_task_id: claudeIsOverflow ? taskId : null,
                            root_task_id: claudeIsOverflow ? taskId : null,
                            chunk_type: 'message_exchange',
                            sequence_order: seq,
                            timestamp: entry.timestamp || new Date().toISOString(),
                            indexed: true,
                            content: contentText,
                            content_summary: contentText.substring(0, 200),
                            participants: [role],
                            tool_details: null,
                            workspace: metadata?.workspace,
                            workspace_name: metadata?.workspace ? path.basename(metadata.workspace) : undefined,
                            task_title: metadata?.title,
                            message_index: totalLines,
                            role,
                            host_os: getHostIdentifier(),
                            source: 'claude-code',
                            // #636: Enriched metadata
                            model: entry.model || message?.model,
                            has_error: ccHasError || undefined,
                            // #2825 (G2/G3): pagination metadata
                            child_unit_index: claudeChildUnitIdx,
                            child_unit_total: claudeChildUnitTotal,
                        });

                        // #2336 D2 étape B: Emit tool_interaction chunks for Claude Code tool_use blocks
                        for (const toolBlock of claudeToolUseBlocks) {
                            const toolName = toolBlock.name || 'unknown';
                            let parsedInput: any = {};
                            try {
                                parsedInput = typeof toolBlock.input === 'string'
                                    ? JSON.parse(toolBlock.input)
                                    : (toolBlock.input || {});
                            } catch { parsedInput = { raw: toolBlock.input }; }

                            // #2825 (G1): full args carried — split losslessly downstream by splitChunk.
                            const toolContent = `Tool call: ${toolName} with args ${JSON.stringify(parsedInput)}`;

                            // #2825 (G2/G3): tool chunks follow the same child-unit paging as their message
                            const toolSeq = sequenceOrder++;
                            chunks.push({
                                chunk_id: computeChunkId(claudeEffectiveTaskId, 'tool_interaction', toolSeq, toolContent),
                                task_id: claudeEffectiveTaskId,
                                parent_task_id: claudeIsOverflow ? taskId : null,
                                root_task_id: claudeIsOverflow ? taskId : null,
                                chunk_type: 'tool_interaction',
                                sequence_order: toolSeq,
                                timestamp: entry.timestamp || new Date().toISOString(),
                                indexed: true, // #2247: tool interactions are valuable search targets
                                content: toolContent,
                                tool_details: {
                                    tool_name: toolName,
                                    parameters: parsedInput,
                                    status: 'success',
                                },
                                tool_name: toolName,
                                model: entry.model || message?.model,
                                workspace: metadata?.workspace,
                                workspace_name: metadata?.workspace ? path.basename(metadata.workspace) : undefined,
                                task_title: metadata?.title,
                                host_os: getHostIdentifier(),
                                source: 'claude-code',
                                // #2825 (G2/G3): pagination metadata
                                child_unit_index: claudeChildUnitIdx,
                                child_unit_total: claudeChildUnitTotal,
                            });
                        }
                    } catch (parseError) {
                        // Skip malformed lines but log for debugging
                        console.warn(`[Claude] Skipping malformed line in ${jsonlFile}: ${parseError}`);
                        continue;
                    }
                }
                rl.close();
                fileStream.destroy();

                if (totalLines > MAX_MESSAGES_PER_TASK) {
                    const claudeChildUnitCount = Math.max(1, Math.ceil(totalLines / MAX_MESSAGES_PER_TASK));
                    console.warn(`⚠️ [#2825/G2] Claude session ${taskId} has ${totalLines} lines — exceeds MAX_MESSAGES_PER_TASK=${MAX_MESSAGES_PER_TASK}; splitting into ${claudeChildUnitCount} child units (NO DROP, all messages indexed).`);
                }

                console.log(`[Claude] Extracted ${fileMessageCount} chunks from ${path.basename(jsonlFile)}`);
            } catch (fileError) {
                // Log file-level errors but continue processing other files
                const errorMsg = fileError instanceof Error ? fileError.message : String(fileError);
                fileErrors.push({ file: jsonlFile, error: errorMsg });
                console.error(`[Claude] Error reading ${jsonlFile}: ${errorMsg}`);
            }
        }

        // Log summary if there were file errors
        if (fileErrors.length > 0) {
            console.warn(`[Claude] Completed with ${fileErrors.length} file error(s): ${fileErrors.map(e => e.file).join(', ')}`);
        }
    } catch (error) {
        // Only throw for critical errors (e.g., directory not found, permission denied)
        console.error(`❌ Critical error extracting chunks from Claude session ${projectPath}:`, error);
        throw new StateManagerError(
            `Extraction chunks échouée pour Claude session ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
            'CHUNK_EXTRACTION_FAILED',
            'ChunkExtractor',
            { taskId, projectPath },
            error instanceof Error ? error : undefined
        );
    }

    return chunks.sort((a, b) => a.sequence_order - b.sequence_order);
}