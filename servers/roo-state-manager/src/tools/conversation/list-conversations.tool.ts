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

/**
 * Lightweight child summary — just the essentials (taskId, snippet, messageCount, mode)
 * ~150-200 chars per child instead of ~900
 */
interface ChildSummary {
    taskId: string;
    firstUserMessage?: string;
    messageCount: number;
    mode?: string;
    isCompleted?: boolean;
}

/**
 * Convertit un SkeletonNode vers ConversationSummary
 * Applies aggressive truncation to keep list output compact:
 * - Root: firstUserMessage ≤200 chars, lastUserMessage ≤150 chars
 * - Children: lightweight format (taskId + 80-char snippet + messageCount + mode)
 * - All children shown (lightweight format is small enough)
 * - synthesis omitted when not available
 */
function toConversationSummary(node: SkeletonNode, depth = 0): ConversationSummary {
    // Truncate root messages
    let firstMsg = node.firstUserMessage;
    let lastMsg = node.lastUserMessage;
    if (firstMsg && firstMsg.length > 200) firstMsg = firstMsg.substring(0, 200) + '...';
    if (lastMsg && lastMsg.length > 150) lastMsg = lastMsg.substring(0, 150) + '...';

    // Children as lightweight summaries — all included since they're tiny now
    const childSummaries: ChildSummary[] = node.children.map((child: SkeletonNode) => {
        let childMsg = child.firstUserMessage;
        if (childMsg && childMsg.length > 80) childMsg = childMsg.substring(0, 80) + '...';
        return {
            taskId: child.taskId,
            firstUserMessage: childMsg || undefined,
            messageCount: child.metadata.messageCount,
            mode: child.metadata.mode,
            isCompleted: child.isCompleted,
        };
    });

    const summary: ConversationSummary = {
        taskId: node.taskId,
        parentTaskId: node.parentTaskId,
        firstUserMessage: firstMsg,
        lastUserMessage: lastMsg,
        isCompleted: node.isCompleted,
        metadata: {
            title: node.metadata.title,
            createdAt: node.metadata.createdAt,
            lastActivity: node.metadata.lastActivity,
            mode: node.metadata.mode,
            messageCount: node.metadata.messageCount,
            actionCount: node.metadata.actionCount,
            totalSize: node.metadata.totalSize,
            workspace: node.metadata.workspace,
            machineId: node.metadata.machineId,
        },
        children: childSummaries as any,
    };

    // Only include synthesis when available
    if (node.synthesis?.available) {
        summary.synthesis = node.synthesis;
    }

    // Only include completionMessage if present
    if (node.completionMessage) {
        summary.completionMessage = node.completionMessage;
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
                if (newTasks.length > 0) {
                    console.log(`📊 list_conversations: Discovered ${newTasks.length} new Roo tasks from disk`);
                }
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
                console.log(`📊 list_conversations: Found ${claudeSkeletons.length} Claude Code sessions`);
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

        // Filtre : Tâches en attente de sous-tâche (NOUVEAU)
        if (args.pendingSubtaskOnly === true) {
            console.log(`[DEBUG] Filtering by pendingSubtaskOnly`);
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
            console.log(`[DEBUG] Pending subtask filter: ${beforeCount} -> ${allSkeletons.length} tasks`);
        }

        // Filtre : Recherche de contenu (NOUVEAU)
        if (args.contentPattern && args.contentPattern.trim().length > 0) {
            console.log(`[DEBUG] Filtering by contentPattern: "${args.contentPattern}"`);
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
            console.log(`[DEBUG] Content pattern filter: ${beforeCount} -> ${allSkeletons.length} tasks`);
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
            let isCompleted = false;
            let completionMessage: string | undefined = undefined;

            // Extraire les informations de la sequence si elle existe
            if (sequence && Array.isArray(sequence)) {
                // 1. Premier message utilisateur (augmenté de 200 à 300 caractères)
                const firstUserMsg = sequence.find((msg: any) => msg.role === 'user');
                if (firstUserMsg && firstUserMsg.content) {
                    firstUserMessage = firstUserMsg.content.length > 300
                        ? firstUserMsg.content.substring(0, 300) + '...'
                        : firstUserMsg.content;
                }

                // 2. Dernier message utilisateur (NOUVEAU - permet de voir la fin de la conversation)
                const userMessages = sequence.filter((msg: any) => msg.role === 'user');
                if (userMessages.length > 0) {
                    const lastUserMsg = userMessages[userMessages.length - 1];
                    if (lastUserMsg && lastUserMsg.content) {
                        lastUserMessage = lastUserMsg.content.length > 200
                            ? lastUserMsg.content.substring(0, 200) + '...'
                            : lastUserMsg.content;
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
            
            // Créer explicitement un SkeletonNode avec SEULEMENT les propriétés nécessaires
            // pour éviter de copier des propriétés volumineuses ou des références circulaires
            return [s.taskId, {
                taskId: s.taskId,
                parentTaskId: s.parentTaskId,
                metadata: s.metadata,
                firstUserMessage,
                lastUserMessage,
                isCompleted,
                completionMessage,
                // NOTE: La synthèse sera détectée en Phase 2 (après création de skeletonMap)
                children: []
            }];
        }));

        // Phase 2: Détecter les synthèses pour chaque nœud
        // NOTE: C'est une opération asynchrone qui peut prendre du temps si beaucoup de tâches
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

        // Convertir en ConversationSummary — children use lightweight ChildSummary format
        const summaries = paginatedForest.map(node => toConversationSummary(node));

        // 📊 LOG AGRÉGÉ FINAL (remplace les logs verbeux commentés)
        console.log(`📊 list_conversations: Found ${allSkeletons.length} conversations (workspace filtered: ${workspaceFilteredCount}), returning page ${page}/${totalPages} (${summaries.length} of ${totalCount} top-level)`);

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

                    // PERF: Lightweight stat-based skeleton instead of full JSONL parsing
                    // Avoids the O(n²) issue where analyzeConversation re-reads ALL project files
                    const fileStat = await fs.stat(filePath);

                    const skeleton: ConversationSkeleton = {
                        taskId,
                        sequence: [], // Content loaded on-demand via view action
                        metadata: {
                            title: file.replace('.jsonl', '').substring(0, 80),
                            createdAt: fileStat.birthtime.toISOString(),
                            lastActivity: fileStat.mtime.toISOString(),
                            messageCount: 0, // Unknown without parsing
                            actionCount: 0,
                            totalSize: fileStat.size,
                            workspace: derivedWorkspace,
                            machineId: os.hostname(),
                            dataSource: 'claude',
                        },
                    };

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