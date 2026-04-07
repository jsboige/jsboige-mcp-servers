/**
 * Outil pour lister toutes les conversations avec filtres et tri
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { SkeletonCacheService } from '../../services/skeleton-cache.service.js';
import { normalizePath } from '../../utils/path-normalizer.js';
import { scanDiskForNewTasks } from '../task/disk-scanner.js';
import { ClaudeStorageDetector } from '../../utils/claude-storage-detector.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
// Profiling instrumentation removed (#832) — was generating ~1131 lines of noise in test output

/**
 * Node enrichi pour construire l'arbre hiérarchique
 * Défini explicitement sans étendre ConversationSkeleton pour éviter d'inclure la propriété sequence
 */
interface SkeletonNode {
    taskId: string;
    parentTaskId?: string;
    metadata: {
        title?: string;
        lastActivity: string;
        createdAt: string;
        mode?: string;
        messageCount: number;
        actionCount: number;
        totalSize: number;
        workspace?: string;
        machineId?: string;
        qdrantIndexedAt?: string;
        dataSource?: string;
        indexingState?: any;
    };
    firstUserMessage?: string;
    lastUserMessage?: string;
    lastAction?: string;
    isCompleted?: boolean;
    completionMessage?: string;
    synthesis?: {
        available: boolean;
        summary?: string;
        generatedAt?: string;
    };
    children: SkeletonNode[];
}

/**
 * Interface pour les messages API (api_conversation_history.json)
 */
interface ApiMessage {
    role: 'user' | 'assistant' | 'system';
    content: string | Array<{
        type: 'text' | 'tool_use' | 'tool_result';
        text?: string;
        name?: string;
    }>;
    text?: string;
    say?: string;
    timestamp?: string;
}

/**
 * Interface allégée pour list_conversations avec informations essentielles
 */
interface ConversationSummary {
    taskId: string;
    parentTaskId?: string;
    firstUserMessage?: string;
    lastUserMessage?: string;
    lastAction?: string;
    isCompleted?: boolean;
    completionMessage?: string;
    synthesis?: {
        available: boolean;
        summary?: string;
        generatedAt?: string;
    };
    metadata: {
        title?: string;
        lastActivity: string;
        createdAt: string;
        mode?: string;
        messageCount: number;
        actionCount: number;
        totalSize?: number;
        workspace?: string;
        machineId?: string;
    };
    children: ConversationSummary[];
}

/** Max children shown inline in list output (was 10 before regression, 3 was too aggressive) */
const MAX_CHILDREN_SHOWN = 10;

/**
 * Strip XML wrapper tags (<user_message>, </user_message>, <task>, etc.) from message text.
 * These are Roo internal tags that add noise to list output.
 */
function stripXmlTags(text?: string): string | undefined {
    if (!text) return undefined;
    return text
        .replace(/<\/?user_message>/g, '')
        .replace(/<\/?task>/g, '')
        .replace(/^\s*\n/, '') // leading blank line after tag removal
        .trim() || undefined;
}

/**
 * Truncate text at the last word/sentence boundary within maxLength.
 * Avoids cutting mid-word, producing cleaner snippets for conversation_browser list.
 * #1177: Replaces raw substring truncation for firstUserMessage.
 */
function truncateAtBoundary(text: string, maxLength: number): string {
    if (!text || text.length <= maxLength) return text;
    // Try sentence boundary first (. ! ? followed by space)
    const sentenceCut = text.lastIndexOf('. ', maxLength - 2);
    if (sentenceCut > maxLength * 0.4) {
        return text.substring(0, sentenceCut + 1);
    }
    // Try word boundary
    const wordCut = text.lastIndexOf(' ', maxLength - 2);
    if (wordCut > maxLength * 0.4) {
        return text.substring(0, wordCut) + '...';
    }
    // Fallback: hard cut
    return text.substring(0, maxLength - 3) + '...';
}

/**
 * Convertit un SkeletonNode vers un objet JSON compact pour le list output.
 *
 * Compactness strategy (target: ~500 chars/root, ~100 chars/child):
 * - Strip XML tags from messages
 * - Root firstUserMessage ≤150 chars, lastUserMessage ≤120 chars
 * - Skip lastUserMessage if JSON (tool calls, not human text)
 * - Children: max 3 shown (taskId + 50-char snippet + messageCount), rest as childrenCount
 * - Omit falsy/default values (isCompleted:false, empty strings, actionCount:0)
 * - Omit title when redundant with firstUserMessage
 * - synthesis only when available
 */
function toConversationSummary(node: SkeletonNode, _depth = 0): Record<string, unknown> {
    // Clean and truncate root messages — #1177: use word-boundary truncation for cleaner output
    let firstMsg = stripXmlTags(node.firstUserMessage);
    let lastMsg = stripXmlTags(node.lastUserMessage);
    if (firstMsg) firstMsg = truncateAtBoundary(firstMsg, 400);
    if (lastMsg) lastMsg = truncateAtBoundary(lastMsg, 400);

    // Build summary — always include key fields for readability
    const summary: Record<string, unknown> = { taskId: node.taskId };
    // #883: Always show source type (roo/claude)
    summary.source = node.taskId.startsWith('claude-') ? 'claude' : 'roo';
    if (node.parentTaskId) summary.parentTaskId = node.parentTaskId;
    if (firstMsg) summary.firstUserMessage = firstMsg;
    if (lastMsg) summary.lastUserMessage = lastMsg;
    if (node.lastAction) summary.lastAction = node.lastAction;
    summary.isCompleted = node.isCompleted || false;
    if (node.completionMessage) summary.completionMessage = node.completionMessage;
    if (node.synthesis?.available) summary.synthesis = node.synthesis;

    // Metadata — omit noise (actionCount) but keep useful fields
    const meta: Record<string, unknown> = {
        createdAt: node.metadata.createdAt,
        lastActivity: node.metadata.lastActivity,
        messageCount: node.metadata.messageCount,
    };
    if (node.metadata.totalSize) meta.totalSize = node.metadata.totalSize;
    if (node.metadata.workspace) meta.workspace = node.metadata.workspace;
    if (node.metadata.machineId) meta.machineId = node.metadata.machineId;
    if (node.metadata.mode) meta.mode = node.metadata.mode;
    // Always include title as main snippet. When firstUserMessage also exists,
    // skip title if it's just a prefix of firstUserMessage (redundant).
    if (node.metadata.title) {
        let title = node.metadata.title;
        if (title.length > 200) title = title.substring(0, 200) + '...';
        const titleRedundant = firstMsg && firstMsg.startsWith(title.substring(0, Math.min(50, title.length)));
        if (!titleRedundant) {
            meta.title = title;
        }
    }
    summary.metadata = meta;

    // Children: show first N as compact objects, rest as childrenCount
    if (node.children.length > 0) {
        const shown = node.children.slice(0, MAX_CHILDREN_SHOWN).map((child: SkeletonNode) => {
            let childMsg = stripXmlTags(child.firstUserMessage) || child.metadata.title;
            // #883: Increased from 100 to 200 chars
            if (childMsg && childMsg.length > 200) childMsg = childMsg.substring(0, 200) + '...';
            const c: Record<string, unknown> = { taskId: child.taskId, messageCount: child.metadata.messageCount };
            if (childMsg) c.firstUserMessage = childMsg;
            if (child.metadata.mode) c.mode = child.metadata.mode;
            c.isCompleted = child.isCompleted || false;
            return c;
        });
        summary.children = shown;
        summary.childrenCount = node.children.length;
    }

    return summary;
}

/**
 * Synthesis info returned for a task
 */
interface SynthesisInfo {
    available: boolean;
    summary?: string;
    generatedAt?: string;
}

/**
 * Detects if a synthesis exists for a given task
 *
 * @param skeleton The conversation skeleton to check
 * @returns SynthesisInfo with availability status and summary if available
 */
async function detectSynthesis(skeleton: ConversationSkeleton): Promise<SynthesisInfo> {
    try {
        // Check if skeleton has synthesis metadata
        const synthesisMetadata = (skeleton as any).synthesisMetadata;
        if (!synthesisMetadata) {
            return { available: false };
        }

        // Priority 1: Condensed batch (higher priority)
        if (synthesisMetadata.condensedBatchPath) {
            const summary = await readSynthesisFile(synthesisMetadata.condensedBatchPath);
            if (summary) {
                return {
                    available: true,
                    summary: truncateSummary(summary, 200),
                    generatedAt: synthesisMetadata.lastUpdated
                };
            }
        }

        // Priority 2: Atomic synthesis
        if (synthesisMetadata.analysisFilePath) {
            const summary = await readSynthesisFile(synthesisMetadata.analysisFilePath);
            if (summary) {
                return {
                    available: true,
                    summary: truncateSummary(summary, 200),
                    generatedAt: synthesisMetadata.lastUpdated
                };
            }
        }

        return { available: false };
    } catch (error) {
        console.warn(`[detectSynthesis] Error for ${skeleton.taskId}:`, error);
        return { available: false };
    }
}

/**
 * Reads a synthesis file and extracts the summary
 *
 * @param filePath Path to the synthesis file (relative or absolute)
 * @returns The summary text or null if not found/error
 */
async function readSynthesisFile(filePath: string): Promise<string | null> {
    try {
        let fullPath = filePath;

        // If path is relative, resolve it against the storage location
        if (!path.isAbsolute(filePath)) {
            const storageLocations = await RooStorageDetector.detectStorageLocations();
            if (storageLocations.length === 0) {
                console.warn('[readSynthesisFile] No storage location found');
                return null;
            }

            // Relative paths are relative to storagePath/tasks
            const tasksDir = path.join(storageLocations[0], 'tasks');
            fullPath = path.join(tasksDir, filePath);
        }

        const content = await fs.readFile(fullPath, 'utf-8');
        const analysis = JSON.parse(content);

        // Extract the summary (different fields for different synthesis types)
        // For atomic synthesis: finalTaskSummary
        // For condensed batch: batchSummary
        return analysis.finalTaskSummary || analysis.batchSummary || null;
    } catch (error) {
        console.warn(`[readSynthesisFile] Error reading ${filePath}:`, error);
        return null;
    }
}

/**
 * Truncates a summary to a maximum length
 */
function truncateSummary(summary: string, maxLength: number): string {
    if (summary.length <= maxLength) {
        return summary;
    }
    return summary.substring(0, maxLength) + '...';
}

/**
 * Définition de l'outil list_conversations
 */
export const listConversationsTool = {
    definition: {
        name: 'list_conversations',
        description: 'Liste toutes les conversations avec filtres et tri.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: 'Alias for per_page (backward compat). Max results per page.' },
                page: { type: 'number', description: 'Page number (1-based). Default: 1.' },
                per_page: { type: 'number', description: 'Results per page. Default: 20. Max: 50.' },
                sortBy: { type: 'string', enum: ['lastActivity', 'messageCount', 'totalSize'] },
                sortOrder: { type: 'string', enum: ['asc', 'desc'] },
                hasApiHistory: { type: 'boolean' },
                hasUiMessages: { type: 'boolean' },
                workspace: { type: 'string', description: 'Filtre les conversations par chemin de workspace.' },
                pendingSubtaskOnly: {
                    type: 'boolean',
                    description: 'Si true, retourne uniquement les tâches ayant une instruction de sous-tâche non complétée'
                },
                contentPattern: {
                    type: 'string',
                    description: 'Filtre les tâches contenant ce texte dans leurs messages (recherche insensible à la casse)'
                },
            },
        },
    },
    
    /**
     * Handler pour l'outil list_conversations
     */
    handler: async (
        args: {
            limit?: number,
            page?: number,
            per_page?: number,
            sortBy?: 'lastActivity' | 'messageCount' | 'totalSize',
            sortOrder?: 'asc' | 'desc',
            workspace?: string,
            pendingSubtaskOnly?: boolean,
            contentPattern?: string,
            source?: 'roo' | 'claude' | 'all'
        },
        conversationCache: Map<string, ConversationSkeleton>
    ): Promise<CallToolResult> => {
        // Profiling removed (#832) — was emitting ~1131 lines of timing noise during tests

        const source = args.source || 'roo';
        const includeRoo = source === 'roo' || source === 'all';
        const includeClaude = source === 'claude' || source === 'all';

        let allSkeletons: ConversationSkeleton[] = [];



        // Include Roo conversations (default behavior)
        if (includeRoo) {
            // FIX: Scan disk for new tasks not yet in cache before listing
            // Without this, tasks created after MCP startup are invisible to list
            // PERF: Timeout wrapper (3s) prevents disk scan from blocking list responses
            // when filesystem is slow or contended by background VectorIndexer I/O
            try {
                const scanPromise = scanDiskForNewTasks(conversationCache);
                const timeoutPromise = new Promise<ConversationSkeleton[]>((_, reject) =>
                    setTimeout(() => reject(new Error('Disk scan timeout (3s)')), 3000)
                );
                const newTasks = await Promise.race([scanPromise, timeoutPromise]);
                for (const task of newTasks) {
                    conversationCache.set(task.taskId, task);
                }
                // Discovery count logged only in debug mode (#832)
            } catch (scanError) {
                console.warn('⚠️ list_conversations: Disk scan failed or timed out, using cache only:', scanError instanceof Error ? scanError.message : scanError);
            }

            allSkeletons = Array.from(conversationCache.values()).filter(skeleton =>
                skeleton.metadata
            );
        }

        // Include Claude Code sessions
        if (includeClaude) {
            // PERF: Timeout wrapper (5s) prevents Claude session scan from blocking list responses
            // Claude sessions can be 2GB+ across 200+ JSONL files — scan must not block foreground tools
            try {
                const claudePromise = scanClaudeSessions(args.workspace);
                const claudeTimeout = new Promise<ConversationSkeleton[]>((_, reject) =>
                    setTimeout(() => reject(new Error('Claude session scan timeout (5s)')), 5000)
                );
                const claudeSkeletons = await Promise.race([claudePromise, claudeTimeout]);
                allSkeletons = allSkeletons.concat(claudeSkeletons);
            } catch (claudeError) {
                console.warn('⚠️ list_conversations: Claude session scan failed or timed out, using Roo-only:', claudeError instanceof Error ? claudeError.message : claudeError);
            }
        }

        // Filtrage par workspace
        let workspaceFilteredCount = 0;
        if (args.workspace) {
            const normalizedWorkspace = normalizePath(args.workspace);
            const countBeforeFilter = allSkeletons.length;
            
            // 🔇 LOGS VERBEUX COMMENTÉS (explosion contexte - liste workspaces disponibles)
            // console.log(`[DEBUG] Filtering by workspace: "${args.workspace}" -> normalized: "${normalizedWorkspace}"`);
            // const workspaces = allSkeletons
            //     .filter(s => s.metadata.workspace)
            //     .map(s => `"${s.metadata.workspace!}" -> normalized: "${normalizePath(s.metadata.workspace!)}"`)
            //     .slice(0, 5);
            // console.log(`[DEBUG] Available workspaces (first 5):`, workspaces);
            
            allSkeletons = allSkeletons.filter(skeleton =>
                skeleton.metadata.workspace &&
                normalizePath(skeleton.metadata.workspace) === normalizedWorkspace
            );

            workspaceFilteredCount = countBeforeFilter - allSkeletons.length;
            // 🔇 LOG VERBEUX COMMENTÉ (explosion contexte)
            // console.log(`[DEBUG] Found ${allSkeletons.length} conversations matching workspace filter`);
        }

        // Filtre : Tâches en attente de sous-tâche
        if (args.pendingSubtaskOnly === true) {
            const beforeCount = allSkeletons.length;
            
            const pendingTasks: ConversationSkeleton[] = [];
            for (const skeleton of allSkeletons) {
                try {
                    const hasPending = await hasPendingSubtask(skeleton.taskId);
                    if (hasPending) {
                        pendingTasks.push(skeleton);
                    }
                } catch (error) {
                    console.warn(`[FILTER] Error checking pending subtask for ${skeleton.taskId}:`, error);
                }
            }

            allSkeletons = pendingTasks;
        }

        // Filtre : Recherche de contenu
        if (args.contentPattern && args.contentPattern.trim().length > 0) {
            const beforeCount = allSkeletons.length;
            
            const matchingTasks: ConversationSkeleton[] = [];
            for (const skeleton of allSkeletons) {
                try {
                    const matches = await matchesContentPattern(skeleton.taskId, args.contentPattern);
                    if (matches) {
                        matchingTasks.push(skeleton);
                    }
                } catch (error) {
                    console.warn(`[FILTER] Error checking content pattern for ${skeleton.taskId}:`, error);
                }
            }

            allSkeletons = matchingTasks;
        }


        // Tri
        allSkeletons.sort((a, b) => {
            let comparison = 0;
            const sortBy = args.sortBy || 'lastActivity';
            switch (sortBy) {
                case 'lastActivity':
                    comparison = new Date(b.metadata!.lastActivity).getTime() - new Date(a.metadata!.lastActivity).getTime();
                    break;
                case 'messageCount':
                    comparison = (b.metadata?.messageCount || 0) - (a.metadata?.messageCount || 0);
                    break;
                case 'totalSize':
                    comparison = (b.metadata?.totalSize || 0) - (a.metadata?.totalSize || 0);
                    break;
            }
            return (args.sortOrder === 'asc') ? -comparison : comparison;
        });


        // Créer les SkeletonNode SANS la propriété sequence MAIS avec toutes les infos importantes
        const skeletonMap = new Map<string, SkeletonNode>(allSkeletons.map(s => {
            const sequence = (s as any).sequence;
            
            // Variables pour les informations à extraire
            let firstUserMessage: string | undefined = undefined;
            let lastUserMessage: string | undefined = undefined;
            let lastAction: string | undefined = undefined;
            let isCompleted = false;
            let completionMessage: string | undefined = undefined;

            // Extraire les informations de la sequence si elle existe (Roo tasks)
            if (sequence && Array.isArray(sequence) && sequence.length > 0) {
                // 1. Premier message utilisateur — #1177: strip XML, truncate at word boundary
                const firstUserMsg = sequence.find((msg: any) => msg.role === 'user');
                if (firstUserMsg && firstUserMsg.content) {
                    const cleaned = stripXmlTags(firstUserMsg.content) || firstUserMsg.content;
                    firstUserMessage = truncateAtBoundary(cleaned, 300);
                }

                // 2. Dernier message utilisateur (permet de voir la fin de la conversation)
                const userMessages = sequence.filter((msg: any) => msg.role === 'user');
                if (userMessages.length > 0) {
                    const lastUserMsg = userMessages[userMessages.length - 1];
                    if (lastUserMsg && lastUserMsg.content) {
                        const cleaned = stripXmlTags(lastUserMsg.content) || lastUserMsg.content;
                        lastUserMessage = truncateAtBoundary(cleaned, 200);
                    }
                }

                // 3. Last action/tool used — #1177: extract from ActionMetadata or tool_use blocks
                // Check ActionMetadata items (type: 'tool') first, then assistant tool_use blocks
                const actionItems = sequence.filter((msg: any) => msg.type === 'tool' || msg.type === 'command');
                if (actionItems.length > 0) {
                    const lastAct = actionItems[actionItems.length - 1];
                    lastAction = lastAct.name || undefined;
                } else {
                    // Fallback: scan last 5 assistant messages for tool_use
                    const recentAssistant = sequence
                        .filter((msg: any) => msg.role === 'assistant')
                        .slice(-5)
                        .reverse();
                    for (const msg of recentAssistant) {
                        if (msg.content && Array.isArray(msg.content)) {
                            for (let i = msg.content.length - 1; i >= 0; i--) {
                                const c = msg.content[i];
                                if (c.type === 'tool_use' && c.name) {
                                    lastAction = c.name;
                                    break;
                                }
                            }
                            if (lastAction) break;
                        }
                    }
                }

                // 3. Détecter si la conversation est terminée (dernier message de type attempt_completion)
                const lastAssistantMessages = sequence
                    .filter((msg: any) => msg.role === 'assistant')
                    .slice(-3); // Prendre les 3 derniers messages assistant pour chercher attempt_completion

                for (const msg of lastAssistantMessages.reverse()) {
                    if (msg.content && Array.isArray(msg.content)) {
                        for (const content of msg.content) {
                            if (content.type === 'tool_use' && content.name === 'attempt_completion') {
                                isCompleted = true;
                                const result = content.input?.result;
                                if (result) {
                                    completionMessage = result.length > 200
                                        ? result.substring(0, 200) + '...'
                                        : result;
                                }
                                break;
                            }
                        }
                        if (isCompleted) break;
                    }
                }
            }

            // Fallback: promote metadata.title to firstUserMessage when sequence is empty/absent
            // This covers Roo tasks loaded via quickAnalyze (sequence: []) where title IS
            // the first user message truncated to ~100 chars from the cache
            if (!firstUserMessage && s.metadata.title) {
                firstUserMessage = s.metadata.title;
            }

            // #666: Fallback for Claude sessions — use pre-extracted JSONL metadata
            const claudeAny = s as any;
            if (!firstUserMessage && claudeAny._claudeFirstUserMessage) {
                firstUserMessage = claudeAny._claudeFirstUserMessage;
            }
            if (!lastUserMessage && claudeAny._claudeLastUserMessage) {
                lastUserMessage = claudeAny._claudeLastUserMessage;
            }

            // Deduplicate: skip lastUserMessage if identical to firstUserMessage
            // (happens with Claude sessions where tail chunk finds same message as head)
            if (lastUserMessage && lastUserMessage === firstUserMessage) {
                lastUserMessage = undefined;
            }

            // Créer explicitement un SkeletonNode avec SEULEMENT les propriétés nécessaires
            // pour éviter de copier des propriétés volumineuses ou des références circulaires
            return [s.taskId, {
                taskId: s.taskId,
                parentTaskId: s.parentTaskId,
                metadata: s.metadata,
                firstUserMessage,
                lastUserMessage,
                lastAction,
                isCompleted,
                completionMessage,
                // NOTE: La synthèse sera détectée en Phase 2 (après création de skeletonMap)
                children: []
            }];
        }));

        // Phase 2: Détecter les synthèses pour chaque nœud
        const synthesisDetectionPromises: Promise<void>[] = [];
        for (const skeleton of allSkeletons) {
            const node = skeletonMap.get(skeleton.taskId);
            if (node) {
                synthesisDetectionPromises.push(
                    detectSynthesis(skeleton).then(synthesis => {
                        node.synthesis = synthesis;
                    }).catch(error => {
                        console.warn(`[list_conversations] Synthesis detection failed for ${skeleton.taskId}:`, error);
                        node.synthesis = { available: false };
                    })
                );
            }
        }
        await Promise.all(synthesisDetectionPromises);

        const forest: SkeletonNode[] = [];

        skeletonMap.forEach(node => {
            if (node.parentTaskId && skeletonMap.has(node.parentTaskId)) {
                skeletonMap.get(node.parentTaskId)!.children.push(node);
            } else {
                forest.push(node);
            }
        });

        // --- Pagination ---
        const perPage = Math.min(args.per_page || args.limit || 20, 50); // Cap at 50
        const page = Math.max(args.page || 1, 1);
        const totalCount = forest.length;
        const totalPages = Math.ceil(totalCount / perPage);
        const startIdx = (page - 1) * perPage;
        const paginatedForest = forest.slice(startIdx, startIdx + perPage);

        // Convertir en objets compacts — omit falsy fields, cap children
        const summaries = paginatedForest.map(node => toConversationSummary(node));


        const result = JSON.stringify({
            conversations: summaries,
            pagination: {
                page,
                per_page: perPage,
                total_count: totalCount,
                total_pages: totalPages,
                has_next: page < totalPages,
            }
        }, null, 2);


        return { content: [{ type: 'text', text: result }] };
    }
};

/**
 * Détecte si une tâche a une sous-tâche en attente de completion
 */
async function hasPendingSubtask(taskId: string): Promise<boolean> {
    try {
        const apiMessages = await loadApiMessages(taskId);
        return detectPendingSubtaskInMessages(apiMessages);
    } catch (error) {
        console.warn(`[hasPendingSubtask] Error for task ${taskId}:`, error);
        return false;
    }
}

/**
 * Vérifie si les messages d'une tâche contiennent un motif de texte
 */
async function matchesContentPattern(taskId: string, pattern: string): Promise<boolean> {
    try {
        const apiMessages = await loadApiMessages(taskId);
        const normalizedPattern = pattern.toLowerCase().trim();
        
        return apiMessages.some(msg => {
            const textContent = extractTextFromMessage(msg).toLowerCase();
            return textContent.includes(normalizedPattern);
        });
    } catch (error) {
        console.warn(`[matchesContentPattern] Error for task ${taskId}:`, error);
        return false;
    }
}

/**
 * Charge les messages API d'une tâche
 */
async function loadApiMessages(taskId: string): Promise<ApiMessage[]> {
    const tasksPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks');
    const apiHistoryPath = path.join(tasksPath, taskId, 'api_conversation_history.json');
    
    const content = await fs.readFile(apiHistoryPath, 'utf-8');
    const data = JSON.parse(content);
    
    // Le fichier peut être un array direct ou un objet avec une propriété messages
    return Array.isArray(data) ? data : (data.messages || []);
}

/**
 * Extrait le texte d'un message API (gère les différents formats)
 */
function extractTextFromMessage(message: ApiMessage): string {
    // Gestion du champ text (format UI)
    if (message.text) {
        return message.text;
    }
    
    // Gestion du champ say (format UI alternatif)
    if (message.say) {
        return message.say;
    }
    
    // Gestion du content (format API standard)
    if (typeof message.content === 'string') {
        return message.content;
    }
    
    if (Array.isArray(message.content)) {
        return message.content
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text)
            .join(' ');
    }
    
    return '';
}

/**
 * Lightweight metadata extraction from a Claude Code JSONL session file.
 * Reads first 16KB + last 16KB to find first/last user messages and approximate count.
 * Much faster than full parsing — O(1) I/O per file regardless of size.
 */
interface ClaudeSessionMeta {
    firstUserMessage?: string;
    lastUserMessage?: string;
    messageCount: number;
}

async function extractClaudeSessionMeta(filePath: string, fileSize: number): Promise<ClaudeSessionMeta> {
    const CHUNK = 16384; // 16KB
    const result: ClaudeSessionMeta = { messageCount: 0 };
    let handle: import('fs/promises').FileHandle | undefined;

    try {
        handle = await fs.open(filePath, 'r');

        // --- Read first chunk for first user message + cwd ---
        const headBuf = Buffer.alloc(Math.min(CHUNK, fileSize));
        const { bytesRead: headRead } = await handle.read(headBuf, 0, headBuf.length, 0);
        const headText = headBuf.toString('utf-8', 0, headRead);
        const headLines = headText.split('\n').filter(l => l.trim());

        let lineCount = 0;
        for (const line of headLines) {
            lineCount++;
            try {
                const entry = JSON.parse(line);
                // Claude Code JSONL format: type="user" with message.content (string or array)
                if (entry.type === 'user' && entry.message) {
                    const text = extractClaudeMessageText(entry.message.content);
                    if (text && text.length > 0) {
                        result.firstUserMessage = truncateAtBoundary(text, 300);
                        break;
                    }
                }
            } catch { /* skip malformed lines */ }
        }

        // --- Read last chunk for last user message ---
        if (fileSize > CHUNK) {
            const tailOffset = Math.max(0, fileSize - CHUNK);
            const tailBuf = Buffer.alloc(Math.min(CHUNK, fileSize - tailOffset));
            const { bytesRead: tailRead } = await handle.read(tailBuf, 0, tailBuf.length, tailOffset);
            const tailText = tailBuf.toString('utf-8', 0, tailRead);
            const tailLines = tailText.split('\n').filter(l => l.trim());
            lineCount += tailLines.length;

            // Scan backwards for last user message
            for (let i = tailLines.length - 1; i >= 0; i--) {
                try {
                    const entry = JSON.parse(tailLines[i]);
                    if (entry.type === 'user' && entry.message) {
                        const text = extractClaudeMessageText(entry.message.content);
                        if (text && text.length > 0) {
                            result.lastUserMessage = truncateAtBoundary(text, 200);
                            break;
                        }
                    }
                } catch { /* skip */ }
            }
        }

        // Estimate message count: use line count from chunks as sample,
        // extrapolate to full file based on avg bytes/line
        const avgBytesPerLine = Math.max(100, (CHUNK * 2) / Math.max(lineCount, 1));
        result.messageCount = Math.max(1, Math.round(fileSize / avgBytesPerLine));

    } catch {
        // Fallback — return empty meta
    } finally {
        await handle?.close();
    }

    return result;
}

/**
 * Extract text from a Claude Code message content field.
 * Content can be a string or an array of content blocks [{type:"text", text:"..."}].
 * Strips XML wrapper tags (<command-message>, etc.) for cleaner output.
 */
function extractClaudeMessageText(content: unknown): string | undefined {
    let text: string | undefined;
    if (typeof content === 'string') {
        text = content;
    } else if (Array.isArray(content)) {
        text = content
            .filter((c: any) => c.type === 'text' && c.text)
            .map((c: any) => c.text)
            .join(' ');
    }
    if (!text) return undefined;
    // Strip Claude Code XML wrappers
    text = text
        .replace(/<\/?command-message>/g, '')
        .replace(/<\/?command-name>/g, '')
        .replace(/<\/?ide_selection[^>]*>/g, '')
        .replace(/<\/?system-reminder[^>]*>[\s\S]*?<\/system-reminder>/g, '')
        .trim();
    return text || undefined;
}

/**
 * Extract the workspace (cwd) from the first line of a JSONL file.
 * Reads only the first 4KB to minimize I/O — one read per project, not per file.
 */
async function extractCwdFromJsonl(filePath: string): Promise<string | undefined> {
    let handle: import('fs/promises').FileHandle | undefined;
    try {
        handle = await fs.open(filePath, 'r');
        const buf = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(buf, 0, 4096, 0);
        const firstLine = buf.toString('utf-8', 0, bytesRead).split('\n')[0].trim();
        if (firstLine) {
            const entry = JSON.parse(firstLine);
            if (entry.cwd) {
                return entry.cwd.replace(/\\/g, '/');
            }
        }
    } catch {
        // Ignore — fallback to directory name
    } finally {
        await handle?.close();
    }
    return undefined;
}

/**
 * Metadata extracted from Claude JSONL file edges (first + last few KB).
 * #666: Enriches Claude sessions with real metadata without full file parsing.
 */
interface ClaudeJsonlMetadata {
    cwd?: string;
    firstUserMessage?: string;
    lastUserMessage?: string;
    approxMessageCount: number;
    title?: string;
}

/**
 * Extract metadata from a Claude JSONL file by reading only the first and last 8KB.
 * This provides cwd, first/last user messages, and an approximate message count
 * without parsing the entire file (which can be many MB).
 *
 * JSONL format: each line is a JSON object with { type, message?, cwd?, timestamp? }
 * User messages have type="user" with message.role="user" and message.content (string or array).
 */
async function extractClaudeJsonlMetadata(filePath: string, fileSize: number): Promise<ClaudeJsonlMetadata> {
    const result: ClaudeJsonlMetadata = { approxMessageCount: 0 };
    let handle: import('fs/promises').FileHandle | undefined;

    try {
        handle = await fs.open(filePath, 'r');
        const CHUNK_SIZE = 8192;

        // --- Read first chunk (first 8KB) ---
        const headBuf = Buffer.alloc(Math.min(CHUNK_SIZE, fileSize));
        const { bytesRead: headRead } = await handle.read(headBuf, 0, headBuf.length, 0);
        const headText = headBuf.toString('utf-8', 0, headRead);
        const headLines = headText.split('\n');

        for (const line of headLines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const entry = JSON.parse(trimmed);
                // Extract cwd from first entry that has it
                if (!result.cwd && entry.cwd) {
                    result.cwd = entry.cwd.replace(/\\/g, '/');
                }
                // Extract first user message
                if (!result.firstUserMessage && entry.type === 'user' && entry.message?.role === 'user') {
                    const content = extractClaudeMessageText(entry.message.content);
                    if (content) {
                        result.firstUserMessage = truncateAtBoundary(content, 300);
                        // Derive title from first user message (skip command invocations)
                        const titleText = content.replace(/<[^>]+>/g, '').trim();
                        if (titleText.length > 3) {
                            result.title = titleText.length > 80 ? titleText.substring(0, 80) + '...' : titleText;
                        }
                    }
                }
            } catch {
                // Skip unparseable lines (e.g., truncated at chunk boundary)
            }
        }

        // --- Read last chunk (last 8KB) ---
        if (fileSize > CHUNK_SIZE) {
            const tailOffset = Math.max(0, fileSize - CHUNK_SIZE);
            const tailBuf = Buffer.alloc(Math.min(CHUNK_SIZE, fileSize - tailOffset));
            const { bytesRead: tailRead } = await handle.read(tailBuf, 0, tailBuf.length, tailOffset);
            const tailText = tailBuf.toString('utf-8', 0, tailRead);
            const tailLines = tailText.split('\n');

            // Walk backwards to find the last user message
            for (let i = tailLines.length - 1; i >= 0; i--) {
                const trimmed = tailLines[i].trim();
                if (!trimmed) continue;
                try {
                    const entry = JSON.parse(trimmed);
                    if (entry.type === 'user' && entry.message?.role === 'user') {
                        const content = extractClaudeMessageText(entry.message.content);
                        if (content) {
                            result.lastUserMessage = truncateAtBoundary(content, 200);
                            break;
                        }
                    }
                } catch {
                    // Skip truncated lines at chunk boundary
                }
            }
        }

        // --- Approximate message count from file size ---
        // Claude JSONL lines average ~500-2000 bytes. Use 1000 as middle ground.
        // Only user+assistant messages matter, roughly 60% of lines.
        const approxTotalLines = Math.max(1, Math.round(fileSize / 1000));
        result.approxMessageCount = Math.max(1, Math.round(approxTotalLines * 0.6));

    } catch {
        // Return whatever we have so far
    } finally {
        await handle?.close();
    }

    return result;
}

// --- Claude session scan cache ---
// Claude sessions are expensive to scan (2GB+, 200+ JSONL files parsed individually).
// Cache results for 60s to avoid re-parsing on every list call.
const CLAUDE_SCAN_CACHE_TTL = 60_000; // 60 seconds
let lastClaudeScanTime = 0;
let lastClaudeScanResults: ConversationSkeleton[] | null = null;

/**
 * Scan Claude Code sessions from ~/.claude/projects/ and build ConversationSkeletons
 * Each conversation gets a 'claude-' prefix on its taskId to distinguish from Roo tasks.
 *
 * PERF: Uses lightweight fs.stat-based scanning instead of full JSONL parsing.
 * Full content parsing was O(n²) — analyzeConversation re-read ALL project files for each file.
 * Now: one stat per file, metadata from filename/stat only. Content available via view action.
 */
async function scanClaudeSessions(workspaceFilter?: string): Promise<ConversationSkeleton[]> {
    const now = Date.now();

    // Return cached results if TTL hasn't expired
    if (lastClaudeScanResults !== null && (now - lastClaudeScanTime) < CLAUDE_SCAN_CACHE_TTL) {
        // Apply workspace filter on cached results
        if (workspaceFilter) {
            const normalizedFilter = normalizePath(workspaceFilter);
            return lastClaudeScanResults.filter(s =>
                s.metadata?.workspace && normalizePath(s.metadata.workspace) === normalizedFilter
            );
        }
        return lastClaudeScanResults;
    }

    const locations = await ClaudeStorageDetector.detectStorageLocations();
    const skeletons: ConversationSkeleton[] = [];
    const seenProjects = new Set<string>();

    for (const location of locations) {
        // Deduplicate by projectPath
        if (seenProjects.has(location.projectPath)) continue;
        seenProjects.add(location.projectPath);

        try {
            // List JSONL files in this project directory
            let files: string[];
            try {
                files = (await fs.readdir(location.projectPath)).filter(f => f.endsWith('.jsonl'));
            } catch {
                continue;
            }

            // Derive workspace: read cwd from first JSONL line (reliable),
            // fallback to directory name with hyphens preserved (ambiguous but better than wrong)
            let derivedWorkspace: string | undefined;
            if (files.length > 0) {
                derivedWorkspace = await extractCwdFromJsonl(path.join(location.projectPath, files[0]));
            }
            if (!derivedWorkspace) {
                const projectName = path.basename(location.projectPath);
                const driveMatch = projectName.match(/^([a-zA-Z])--(.*)/);
                if (driveMatch) {
                    // Keep hyphens as-is — can't distinguish path separators from literal hyphens
                    derivedWorkspace = `${driveMatch[1].toLowerCase()}:/${driveMatch[2]}`;
                }
            }

            for (const file of files) {
                try {
                    const taskId = `claude-${location.projectName}--${file.replace('.jsonl', '')}`;
                    const filePath = path.join(location.projectPath, file);

                    // PERF: stat + lightweight JSONL metadata extraction
                    // #666: Enriches with firstUserMessage, lastUserMessage, approxMessageCount
                    const fileStat = await fs.stat(filePath);
                    const sessionMeta = await extractClaudeSessionMeta(filePath, fileStat.size);
                    const jsonlMeta = await extractClaudeJsonlMetadata(filePath, fileStat.size);

                    // Use per-file cwd if available, fallback to project-level workspace
                    const fileWorkspace = jsonlMeta.cwd || derivedWorkspace;

                    // Derive a useful title: workspace basename + short session ID
                    const sessionId = file.replace('.jsonl', '');
                    const wsName = (fileWorkspace || derivedWorkspace) ? path.basename(fileWorkspace || derivedWorkspace || '') : 'unknown';
                    const claudeTitle = jsonlMeta.title || `[Claude] ${wsName} — ${sessionId.substring(0, 8)}`;

                    const skeleton: ConversationSkeleton = {
                        taskId,
                        sequence: [], // Content loaded on-demand via view action
                        metadata: {
                            title: claudeTitle,
                            createdAt: fileStat.birthtime.toISOString(),
                            lastActivity: fileStat.mtime.toISOString(),
                            messageCount: sessionMeta.messageCount || jsonlMeta.approxMessageCount,
                            actionCount: 0,
                            totalSize: fileStat.size,
                            workspace: fileWorkspace,
                            machineId: os.hostname(),
                            dataSource: 'claude',
                        },
                        // #666: Store extracted messages for SkeletonNode enrichment (fallback)
                        _claudeFirstUserMessage: jsonlMeta.firstUserMessage,
                        _claudeLastUserMessage: jsonlMeta.lastUserMessage,
                    } as ConversationSkeleton & { _claudeFirstUserMessage?: string; _claudeLastUserMessage?: string };

                    // Inject first/last messages into sequence for toConversationSummary
                    const firstMsg = sessionMeta.firstUserMessage || jsonlMeta.firstUserMessage;
                    const lastMsg = sessionMeta.lastUserMessage || jsonlMeta.lastUserMessage;
                    if (firstMsg || lastMsg) {
                        const seq: any[] = [];
                        if (firstMsg) {
                            seq.push({ role: 'user', content: firstMsg });
                        }
                        if (lastMsg && lastMsg !== firstMsg) {
                            seq.push({ role: 'user', content: lastMsg });
                        }
                        (skeleton as any).sequence = seq;
                    }

                    skeletons.push(skeleton);
                } catch {
                    // Skip individual file errors silently
                }
            }
        } catch (err) {
            console.warn(`⚠️ scanClaudeSessions: Error scanning project ${location.projectPath}:`, err);
        }
    }

    // Update cache (before workspace filtering — cache the full set)
    lastClaudeScanTime = now;
    lastClaudeScanResults = skeletons;

    // Apply workspace filter
    if (workspaceFilter) {
        const normalizedFilter = normalizePath(workspaceFilter);
        return skeletons.filter(s =>
            s.metadata?.workspace && normalizePath(s.metadata.workspace) === normalizedFilter
        );
    }

    return skeletons;
}

/**
 * Logique de détection de sous-tâche en attente
 */
function detectPendingSubtaskInMessages(messages: ApiMessage[]): boolean {
    // Parcours inversé pour trouver la dernière instruction de sous-tâche
    let lastSubtaskInstructionIndex = -1;
    
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role !== 'assistant') continue;
        
        const content = extractTextFromMessage(message);
        
        if (content.includes('<new_task>') || content.includes('<task>')) {
            lastSubtaskInstructionIndex = i;
            break;
        }
    }
    
    // Aucune instruction trouvée
    if (lastSubtaskInstructionIndex === -1) {
        return false;
    }
    
    // Vérification qu'aucun message de completion ne suit
    for (let j = lastSubtaskInstructionIndex + 1; j < messages.length; j++) {
        const followingMessage = messages[j];
        if (followingMessage.role !== 'user') continue;
        
        const followingContent = extractTextFromMessage(followingMessage);
        
        if (followingContent.includes('[new_task completed]') ||
            followingContent.includes('[task completed]')) {
            return false; // La sous-tâche a été complétée
        }
    }
    
    return true; // En attente de completion
}