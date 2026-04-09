/**
 * Outil pour lister toutes les conversations avec filtres et tri
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { SkeletonCacheService } from '../../services/skeleton-cache.service.js';
import { normalizePath } from '../../utils/path-normalizer.js';
import { normalizeWorkspaceId } from '../../utils/message-helpers.js';
import { scanDiskForNewTasks } from '../task/disk-scanner.js';
import { ClaudeStorageDetector } from '../../utils/claude-storage-detector.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { parseFilterDate, isWithinDateRange } from '../../utils/date-filters.js';
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
    /** Last message of ANY role (user or assistant). Often shows the final state/result of the conversation. */
    lastMessage?: string;
    /** Role of the last message ('user' or 'assistant'). Helps disambiguate in output. */
    lastMessageRole?: 'user' | 'assistant';
    lastAction?: string;
    isCompleted?: boolean;
    completionMessage?: string;
    synthesis?: {
        available: boolean;
        summary?: string;
        generatedAt?: string;
    };
    /** Optional per-role message counts (when extractable) */
    userMessageCount?: number;
    assistantMessageCount?: number;
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
    /** #883 / #1244 Couche 3.2 — 'roo' or 'claude'. Prefer metadata.source over taskId prefix. */
    source?: 'roo' | 'claude';
    /** #1244 Couche 3.2 — 'local' (hot tier 1/2) or 'archive' (cold tier 3 GDrive). */
    tier?: 'local' | 'archive';
    parentTaskId?: string;
    firstUserMessage?: string;
    lastUserMessage?: string;
    lastMessage?: string;
    lastMessageRole?: 'user' | 'assistant';
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
        userMessageCount?: number;
        assistantMessageCount?: number;
        actionCount: number;
        totalSize?: number;
        workspace?: string;
        machineId?: string;
    };
    children: ConversationSummary[];
}

/** Max children shown inline in list output.
 *  #1245 round 2: reduced from 10 → 5 to make budget room for richer root-level
 *  firstUserMessage/lastMessage snippets while staying under 50KB total output. */
const MAX_CHILDREN_SHOWN = 5;

/**
 * Strip XML wrapper tags (<user_message>, </user_message>, <task>, etc.) from message text.
 * Also strips leading BOM (U+FEFF) which appears in some Claude task titles and breaks
 * downstream string comparisons (e.g. title vs firstUserMessage dedup).
 * These are Roo/JSONL internal artifacts that add noise to list output.
 */
function stripXmlTags(text?: string): string | undefined {
    if (!text) return undefined;
    return text
        .replace(/^\uFEFF/, '') // Strip BOM (Claude session metadata)
        .replace(/<\/?user_message>/g, '')
        .replace(/<\/?task>/g, '')
        .replace(/^\s*\n/, '') // leading blank line after tag removal
        .trim() || undefined;
}

/**
 * Normalize a string for content-equality comparison: strip BOM, lowercase,
 * collapse whitespace runs to single spaces. Used to detect title vs
 * firstUserMessage redundancy regardless of cosmetic differences.
 */
function normalizeForCompare(s: string | undefined): string {
    if (!s) return '';
    return s.replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Format a duration as a human-readable relative time.
 * "now", "3m ago", "2h ago", "5d ago", "3w ago", "2mo ago", "1y ago".
 * Returns undefined if the input is invalid/missing.
 */
function formatRelativeTime(iso: string | undefined): string | undefined {
    if (!iso) return undefined;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return undefined;
    const deltaMs = Date.now() - t;
    if (deltaMs < 0) return 'in future';
    const sec = Math.floor(deltaMs / 1000);
    if (sec < 60) return 'now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    const wk = Math.floor(day / 7);
    if (wk < 5) return `${wk}w ago`;
    const mo = Math.floor(day / 30);
    if (mo < 12) return `${mo}mo ago`;
    const yr = Math.floor(day / 365);
    return `${yr}y ago`;
}

/**
 * Format a byte count as a human-readable size: "234 B", "1.2 KB", "3.4 MB", "2.5 GB".
 */
function formatBytes(bytes: number | undefined): string | undefined {
    if (bytes === undefined || bytes === null || bytes < 0) return undefined;
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(2)} GB`;
}

/**
 * Extract the workspace basename from a full path. "d:/dev/roo-extensions" → "roo-extensions".
 * Returns undefined for empty/invalid input.
 */
function getWorkspaceShort(workspace: string | undefined): string | undefined {
    if (!workspace) return undefined;
    const cleaned = workspace.replace(/[\\/]+$/, ''); // trim trailing slashes
    const parts = cleaned.split(/[\\/]/);
    const last = parts[parts.length - 1];
    return last && last.length > 0 ? last : undefined;
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
 * Convertit un SkeletonNode vers un objet JSON compact mais informatif pour list output.
 *
 * UX strategy (#1245 — restoring richer output):
 * - Strip XML tags + BOM from messages, word-boundary truncation
 * - Title shown only when distinct from firstUserMessage (BOM-aware dedup)
 * - Metadata enriched with: ago (relative time), sizeHuman, workspaceShort, actionCount
 * - Noise omitted: tier when "local", isCompleted when false, lastUserMessage when == firstMsg
 * - Children: compact format with snippet + ago + mode + completion status
 */
function toConversationSummary(node: SkeletonNode, _depth = 0): Record<string, unknown> {
    // Clean and truncate root messages — #1177: word-boundary truncation.
    // #1245 (round 2): moderate bump (+50-100%) vs previous session, capped to keep
    // total output under 50KB with default per_page=10 (user constraint — above 50KB
    // Claude Code shortens the output to a file reference).
    let firstMsg = stripXmlTags(node.firstUserMessage);
    let lastUMsg = stripXmlTags(node.lastUserMessage);
    let lastAnyMsg = stripXmlTags(node.lastMessage);
    if (firstMsg) firstMsg = truncateAtBoundary(firstMsg, 700);
    if (lastUMsg) lastUMsg = truncateAtBoundary(lastUMsg, 500);
    if (lastAnyMsg) lastAnyMsg = truncateAtBoundary(lastAnyMsg, 500);

    // Drop lastUserMessage when it duplicates firstMsg (Claude tail/head collisions)
    if (lastUMsg && normalizeForCompare(lastUMsg) === normalizeForCompare(firstMsg)) {
        lastUMsg = undefined;
    }
    // Drop lastMessage (any role) when it duplicates firstMsg or lastUserMessage
    if (lastAnyMsg && normalizeForCompare(lastAnyMsg) === normalizeForCompare(firstMsg)) {
        lastAnyMsg = undefined;
    }
    if (lastAnyMsg && lastUMsg && normalizeForCompare(lastAnyMsg) === normalizeForCompare(lastUMsg)) {
        lastAnyMsg = undefined; // already shown as lastUserMessage
    }

    // Build summary — always include key fields for readability
    const summary: Record<string, unknown> = { taskId: node.taskId };

    // #883: Always show source type (roo/claude)
    // #1244 Couche 3.2 — Prefer metadata.source (set by SkeletonCacheService Tier 2/3)
    // before falling back to taskId prefix detection.
    const metaSource = (node.metadata as any)?.source;
    if (metaSource === 'claude-code' || metaSource === 'claude') {
        summary.source = 'claude';
    } else if (metaSource === 'roo') {
        summary.source = 'roo';
    } else {
        summary.source = node.taskId.startsWith('claude-') ? 'claude' : 'roo';
    }

    // #1244 Couche 3.2 — Tier indicator. Only emitted when 'archive' (default 'local' is noise).
    const dataSource = node.metadata?.dataSource;
    if (dataSource === 'archive') {
        summary.tier = 'archive';
    }

    if (node.parentTaskId) summary.parentTaskId = node.parentTaskId;
    if (firstMsg) summary.firstUserMessage = firstMsg;
    if (lastUMsg) summary.lastUserMessage = lastUMsg;
    // lastMessage (any role) — often more informative than lastUserMessage because
    // it surfaces the final assistant response / action / result of the conversation.
    if (lastAnyMsg) {
        summary.lastMessage = lastAnyMsg;
        if (node.lastMessageRole) summary.lastMessageRole = node.lastMessageRole;
    }
    if (node.lastAction) summary.lastAction = node.lastAction;
    if (node.isCompleted) summary.isCompleted = true; // omit when false (default)
    if (node.completionMessage) summary.completionMessage = node.completionMessage;
    if (node.synthesis?.available) summary.synthesis = node.synthesis;

    // Metadata — keep useful fields, drop noise.
    // Field names preserve backward compat: workspace = full path, totalSize = raw bytes.
    // New friendly fields added alongside: ago, sizeHuman, workspaceShort.
    const meta: Record<string, unknown> = {
        createdAt: node.metadata.createdAt,
        lastActivity: node.metadata.lastActivity,
    };
    const ago = formatRelativeTime(node.metadata.lastActivity);
    if (ago) meta.ago = ago;
    meta.messageCount = node.metadata.messageCount;
    // Per-role breakdown when available (extracted from Roo sequence or Claude JSONL scan).
    if (node.userMessageCount !== undefined && node.userMessageCount >= 0) {
        meta.userMessageCount = node.userMessageCount;
    }
    if (node.assistantMessageCount !== undefined && node.assistantMessageCount >= 0) {
        meta.assistantMessageCount = node.assistantMessageCount;
    }
    if (node.metadata.actionCount && node.metadata.actionCount > 0) {
        meta.actionCount = node.metadata.actionCount;
    }
    if (node.metadata.totalSize) {
        meta.totalSize = node.metadata.totalSize;
        const sizeHuman = formatBytes(node.metadata.totalSize);
        if (sizeHuman) meta.sizeHuman = sizeHuman;
    }
    if (node.metadata.mode) meta.mode = node.metadata.mode;
    if (node.metadata.workspace) {
        meta.workspace = node.metadata.workspace;
        const wsShort = getWorkspaceShort(node.metadata.workspace);
        if (wsShort && wsShort !== node.metadata.workspace) meta.workspaceShort = wsShort;
    }
    if (node.metadata.machineId) meta.machineId = node.metadata.machineId;

    // Title: include only when distinct from firstUserMessage (BOM-aware dedup)
    if (node.metadata.title) {
        let title = node.metadata.title.replace(/^\uFEFF/, ''); // strip BOM
        if (title.length > 200) title = title.substring(0, 200) + '...';
        const titleN = normalizeForCompare(title);
        const firstMsgN = normalizeForCompare(firstMsg);
        // Redundant if title is a prefix of (or equal to) firstMsg, OR firstMsg starts with title
        const titleRedundant = titleN.length > 0 && firstMsgN.length > 0 && (
            firstMsgN.startsWith(titleN) ||
            (titleN.length >= 20 && firstMsgN.startsWith(titleN.substring(0, Math.min(60, titleN.length))))
        );
        if (!titleRedundant) {
            meta.title = title;
        }
    }
    summary.metadata = meta;

    // Children: show first N as compact objects with rich info
    if (node.children.length > 0) {
        const shown = node.children.slice(0, MAX_CHILDREN_SHOWN).map((child: SkeletonNode) => {
            // Prefer firstUserMessage; fall back to title (BOM-stripped)
            let childMsg = stripXmlTags(child.firstUserMessage);
            if (!childMsg && child.metadata.title) {
                childMsg = child.metadata.title.replace(/^\uFEFF/, '');
            }
            if (childMsg && childMsg.length > 200) {
                childMsg = childMsg.substring(0, 200) + '...';
            }
            const c: Record<string, unknown> = {
                taskId: child.taskId,
                messageCount: child.metadata.messageCount,
            };
            if (childMsg) c.firstUserMessage = childMsg;
            if (child.metadata.mode) c.mode = child.metadata.mode;
            const childAgo = formatRelativeTime(child.metadata.lastActivity);
            if (childAgo) c.ago = childAgo;
            if (child.isCompleted) c.isCompleted = true; // omit when false
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
 * #1244 Couche 2.2 — Strategie de matching de workspace.
 *
 * - 'exact'      : equivalent strict (apres normalisation forward-slash + lowercase)
 *                  via normalizePath. Conserve le chemin complet (`d:/dev/CoursIA` != `d:/CoursIA`).
 * - 'normalized' : (defaut) match basename via normalizeWorkspaceId. Tolere les
 *                  variations de chemin parent (`d:/dev/CoursIA` == `d:/CoursIA` == `CoursIA`).
 *                  C'est la strategie cross-machine la plus robuste — un meme workspace
 *                  ouvert depuis differents drives ou via des liens symboliques matche.
 * - 'substring'  : test `includes` lowercase. Le plus tolerant, pour les recherches
 *                  exploratoires (`workspace: 'CoursIA'` matche tout chemin contenant CoursIA).
 */
function matchesWorkspace(
    skeletonWorkspace: string | undefined,
    queryWorkspace: string,
    strategy: 'exact' | 'normalized' | 'substring' = 'normalized'
): boolean {
    if (!skeletonWorkspace) return false;
    if (strategy === 'exact') {
        return normalizePath(skeletonWorkspace) === normalizePath(queryWorkspace);
    }
    if (strategy === 'substring') {
        return skeletonWorkspace.toLowerCase().includes(queryWorkspace.toLowerCase());
    }
    // 'normalized' (default)
    return normalizeWorkspaceId(skeletonWorkspace) === normalizeWorkspaceId(queryWorkspace);
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
                limit: { type: 'number', description: 'Alias for per_page (backward compat). Clamped to [10, 100].' },
                page: { type: 'number', description: 'Page number (1-based). Default: 1.' },
                per_page: { type: 'number', description: 'Results per page. Default: 10 (keeps output <50KB so Claude Code displays inline). Min: 10. Max: 100 (opt-in large pages — above ~50KB the host redirects output to a file).' },
                sortBy: { type: 'string', enum: ['lastActivity', 'messageCount', 'totalSize'] },
                sortOrder: { type: 'string', enum: ['asc', 'desc'] },
                hasApiHistory: { type: 'boolean' },
                hasUiMessages: { type: 'boolean' },
                workspace: { type: 'string', description: 'Filtre les conversations par chemin de workspace.' },
                workspacePathMatch: {
                    type: 'string',
                    enum: ['exact', 'normalized', 'substring'],
                    description: '#1244 Couche 2.2 — Strategie de matching du workspace. "exact": comparaison stricte (apres forward-slash + lowercase). "normalized" (defaut): match par basename, tolere les variations de chemin parent (`d:/dev/CoursIA` == `d:/CoursIA`). "substring": test includes lowercase, le plus tolerant.',
                    default: 'normalized'
                },
                pendingSubtaskOnly: {
                    type: 'boolean',
                    description: 'Si true, retourne uniquement les tâches ayant une instruction de sous-tâche non complétée'
                },
                contentPattern: {
                    type: 'string',
                    description: 'Filtre les tâches contenant ce texte dans leurs messages (recherche insensible à la casse)'
                },
                startDate: {
                    type: 'string',
                    description: '#1244 Couche 2.1 — Date debut (ISO 8601 ou YYYY-MM-DD). Filtre les taches dont lastActivity >= startDate. Combinable avec endDate pour fenetrer une periode.'
                },
                endDate: {
                    type: 'string',
                    description: '#1244 Couche 2.1 — Date fin (ISO 8601 ou YYYY-MM-DD). Filtre les taches dont lastActivity <= endDate. Combinable avec startDate.'
                },
                machineId: {
                    type: 'string',
                    description: '#1244 Couche 2.1 — Filtre par identifiant machine (cross-machine). Permet d\'isoler les conversations d\'une machine specifique (ex: "myia-po-2025") parmi les archives chargees depuis GDrive.'
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
            workspacePathMatch?: 'exact' | 'normalized' | 'substring',
            pendingSubtaskOnly?: boolean,
            contentPattern?: string,
            source?: 'roo' | 'claude' | 'all',
            // #1244 Couche 2.1 — Filtres date/machine cross-machine
            startDate?: string,
            endDate?: string,
            machineId?: string
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

        // #1244 Couche 2.2 — Strategie de matching du workspace (defaut: 'normalized')
        const workspaceMatchStrategy = args.workspacePathMatch || 'normalized';

        // Include Claude Code sessions
        if (includeClaude) {
            // PERF: Timeout wrapper (5s) prevents Claude session scan from blocking list responses
            // Claude sessions can be 2GB+ across 200+ JSONL files — scan must not block foreground tools
            try {
                const claudePromise = scanClaudeSessions(args.workspace, workspaceMatchStrategy);
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
            const countBeforeFilter = allSkeletons.length;
            allSkeletons = allSkeletons.filter(skeleton =>
                matchesWorkspace(skeleton.metadata.workspace, args.workspace!, workspaceMatchStrategy)
            );
            workspaceFilteredCount = countBeforeFilter - allSkeletons.length;
            // 🔇 LOG VERBEUX COMMENTÉ (explosion contexte)
            // console.log(`[DEBUG] Found ${allSkeletons.length} conversations matching workspace filter`);
        }

        // #1244 Couche 2.1 — Filtre par fenetre temporelle (lastActivity dans [startDate, endDate])
        // Les bornes acceptent ISO 8601 ou YYYY-MM-DD. endDate inclut la journee entiere.
        const parsedStartDate = parseFilterDate(args.startDate);
        const parsedEndDate = parseFilterDate(args.endDate);
        if (parsedStartDate || parsedEndDate) {
            allSkeletons = allSkeletons.filter(skeleton =>
                isWithinDateRange(skeleton.metadata?.lastActivity, parsedStartDate, parsedEndDate)
            );
        }

        // #1244 Couche 2.1 — Filtre par identifiant machine (cross-machine).
        // Permet d'isoler les conversations d'une machine specifique parmi les
        // squelettes charges depuis archive (Tier 3) ou Roo local.
        if (args.machineId && args.machineId.trim().length > 0) {
            const targetMachineId = args.machineId.trim().toLowerCase();
            allSkeletons = allSkeletons.filter(skeleton => {
                const m = (skeleton.metadata?.machineId || '').toLowerCase();
                return m === targetMachineId;
            });
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
        // #1244 Couche 2.4 — On passe le skeleton entier pour permettre la recherche
        // memoire sur les Tier 2/3 (sequence deja chargee) sans I/O disque inutile.
        if (args.contentPattern && args.contentPattern.trim().length > 0) {
            const matchingTasks: ConversationSkeleton[] = [];
            for (const skeleton of allSkeletons) {
                try {
                    const matches = await matchesContentPattern(skeleton, args.contentPattern);
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
            let lastMessage: string | undefined = undefined;
            let lastMessageRole: 'user' | 'assistant' | undefined = undefined;
            let userMessageCount: number | undefined = undefined;
            let assistantMessageCount: number | undefined = undefined;
            let lastAction: string | undefined = undefined;
            let isCompleted = false;
            let completionMessage: string | undefined = undefined;

            // Extraire les informations de la sequence si elle existe (Roo tasks)
            if (sequence && Array.isArray(sequence) && sequence.length > 0) {
                // 1. Premier message utilisateur — #1177: strip XML, truncate at word boundary
                //    #1245 round 2: bump 300 → 900 chars for richer context
                const firstUserMsg = sequence.find((msg: any) => msg.role === 'user');
                if (firstUserMsg && firstUserMsg.content) {
                    const cleaned = stripXmlTags(firstUserMsg.content) || firstUserMsg.content;
                    firstUserMessage = truncateAtBoundary(cleaned, 900);
                }

                // 2. Dernier message utilisateur — #1245: bump 200 → 500 chars
                const userMessages = sequence.filter((msg: any) => msg.role === 'user');
                userMessageCount = userMessages.length;
                if (userMessages.length > 0) {
                    const lastUserMsg = userMessages[userMessages.length - 1];
                    if (lastUserMsg && lastUserMsg.content) {
                        const cleaned = stripXmlTags(lastUserMsg.content) || lastUserMsg.content;
                        lastUserMessage = truncateAtBoundary(cleaned, 500);
                    }
                }

                // 2b. #1245 round 2: dernier message de TOUT rôle (user OR assistant)
                //     Scan en arrière dans la sequence brute pour capturer le dernier message
                //     réel (souvent un assistant, qui porte la réponse/action finale).
                //     On garde lastMessageRole pour désambiguïser l'affichage.
                const assistantMessages = sequence.filter((msg: any) => msg.role === 'assistant');
                assistantMessageCount = assistantMessages.length;
                for (let i = sequence.length - 1; i >= 0; i--) {
                    const m = sequence[i];
                    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
                    // Extract text content (may be string or array of blocks)
                    let textContent: string | undefined;
                    if (typeof m.content === 'string') {
                        textContent = m.content;
                    } else if (Array.isArray(m.content)) {
                        // Find first text block
                        const textBlock = m.content.find((c: any) => c.type === 'text' && c.text);
                        if (textBlock) textContent = textBlock.text;
                    }
                    if (textContent) {
                        const cleaned = stripXmlTags(textContent) || textContent;
                        lastMessage = truncateAtBoundary(cleaned, 500);
                        lastMessageRole = m.role;
                        break;
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

                // 4. Détecter si la conversation est terminée (dernier message de type attempt_completion)
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

            // #666 + #1245 round 2: Fallback for Claude sessions — use pre-extracted JSONL metadata.
            // These dynamic fields are set by scanClaudeSessions on the skeleton.
            const claudeAny = s as any;
            if (!firstUserMessage && claudeAny._claudeFirstUserMessage) {
                firstUserMessage = claudeAny._claudeFirstUserMessage;
            }
            if (!lastUserMessage && claudeAny._claudeLastUserMessage) {
                lastUserMessage = claudeAny._claudeLastUserMessage;
            }
            if (!lastMessage && claudeAny._claudeLastMessage) {
                lastMessage = claudeAny._claudeLastMessage;
                if (claudeAny._claudeLastMessageRole) {
                    lastMessageRole = claudeAny._claudeLastMessageRole;
                }
            }
            if (userMessageCount === undefined && typeof claudeAny._claudeUserCount === 'number') {
                userMessageCount = claudeAny._claudeUserCount;
            }
            if (assistantMessageCount === undefined && typeof claudeAny._claudeAssistantCount === 'number') {
                assistantMessageCount = claudeAny._claudeAssistantCount;
            }

            // Deduplicate: skip lastUserMessage if identical to firstUserMessage
            // (happens with Claude sessions where tail chunk finds same message as head)
            if (lastUserMessage && lastUserMessage === firstUserMessage) {
                lastUserMessage = undefined;
            }
            // Deduplicate: skip lastMessage if it just mirrors firstUserMessage (tiny task)
            if (lastMessage && lastMessage === firstUserMessage) {
                lastMessage = undefined;
                lastMessageRole = undefined;
            }

            // Créer explicitement un SkeletonNode avec SEULEMENT les propriétés nécessaires
            // pour éviter de copier des propriétés volumineuses ou des références circulaires
            return [s.taskId, {
                taskId: s.taskId,
                parentTaskId: s.parentTaskId,
                metadata: s.metadata,
                firstUserMessage,
                lastUserMessage,
                lastMessage,
                lastMessageRole,
                userMessageCount,
                assistantMessageCount,
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
        // #1245 round 2: clamp to [10, 100].
        //   - floor 10: user explicit ("pas moins de 10 éléments par page, des pages de 5 ça n'a jamais été utile")
        //   - cap 100: an agent may deliberately want a large page (it will be redirected to a file
        //     above ~50KB — that's fine as an opt-in, just not the default behaviour).
        //   - default 10: keeps the default output comfortably under 50KB so Claude Code displays
        //     content inline; agents can pass per_page=50/100 when they want everything in a file.
        const rawPerPage = args.per_page || args.limit || 10;
        const perPage = Math.min(Math.max(rawPerPage, 10), 100);
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
 * Vérifie si les messages d'une tâche contiennent un motif de texte.
 *
 * #1244 Couche 2.4 — Multi-source contentPattern :
 *  - Tier 2 (Claude) et Tier 3 (Archive) : la sequence est deja en memoire
 *    (full skeleton dans le cache). On cherche directement dedans, sans I/O disque.
 *  - Tier 1 (Roo local) : lecture de `api_conversation_history.json` depuis le disque
 *    via `loadApiMessages()`. Comportement historique.
 *
 * Avant le fix, seules les taches Roo avec api_conversation_history sur disque etaient
 * traversees — les sessions Claude et les archives cross-machine etaient invisibles.
 */
async function matchesContentPattern(skeleton: ConversationSkeleton, pattern: string): Promise<boolean> {
    const normalizedPattern = pattern.toLowerCase().trim();
    if (normalizedPattern.length === 0) return true;

    // 1. Sequence deja chargee (Tier 2 Claude / Tier 3 Archive) — recherche memoire
    const sequence = (skeleton as any).sequence;
    if (Array.isArray(sequence) && sequence.length > 0) {
        return sequence.some((msg: any) => {
            if (!msg || msg.role === undefined) return false;
            const raw = typeof msg.content === 'string' ? msg.content : '';
            return raw.toLowerCase().includes(normalizedPattern);
        });
    }

    // 2. Tier 1 (Roo local) — lire api_conversation_history depuis le disque
    //    (les taches Roo n'ont pas de sequence en cache, juste un SkeletonHeader)
    if (!skeleton.taskId.startsWith('claude-')) {
        try {
            const apiMessages = await loadApiMessages(skeleton.taskId);
            return apiMessages.some(msg => {
                const textContent = extractTextFromMessage(msg).toLowerCase();
                return textContent.includes(normalizedPattern);
            });
        } catch (error) {
            console.warn(`[matchesContentPattern] Error reading Roo task ${skeleton.taskId}:`, error);
            return false;
        }
    }

    // 3. Claude session without cached sequence (Tier 2 disabled / load failed) — pas de fallback fiable
    return false;
}

/**
 * Charge les messages API d'une tâche
 */
async function loadApiMessages(taskId: string): Promise<ApiMessage[]> {
    const locations = await RooStorageDetector.detectStorageLocations();
    const parseErrors: string[] = [];

    for (const loc of locations) {
        const apiHistoryPath = path.join(loc, 'tasks', taskId, 'api_conversation_history.json');
        try {
            let content = await fs.readFile(apiHistoryPath, 'utf-8');
            if (content.charCodeAt(0) === 0xFEFF) {
                content = content.slice(1);
            }
            const data = JSON.parse(content);
            return Array.isArray(data) ? data : (data.messages || []);
        } catch {
            parseErrors.push(apiHistoryPath);
        }
    }

    throw new Error(`Task '${taskId}' api_conversation_history not found in any storage location. Tried: ${parseErrors.join(', ')}`);
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
    /** Last message of ANY role (user or assistant) — final state of the conversation. */
    lastMessage?: string;
    lastMessageRole?: 'user' | 'assistant';
    messageCount: number;
    /** Sampled counts from head+tail chunks (under-counts for big files, exact for small ones). */
    sampledUserCount?: number;
    sampledAssistantCount?: number;
    sampledCountsAreExact?: boolean;
}

async function extractClaudeSessionMeta(filePath: string, fileSize: number): Promise<ClaudeSessionMeta> {
    // #1245 round 2: bump 16KB → 48KB so we capture enough first-message content
    // and more accurate counts. 48KB * 2 = 96KB max I/O per file, acceptable for list.
    const CHUNK = 49152; // 48KB
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
        let sampledUser = 0;
        let sampledAssistant = 0;
        for (const line of headLines) {
            lineCount++;
            try {
                const entry = JSON.parse(line);
                if (entry.type === 'user') sampledUser++;
                else if (entry.type === 'assistant') sampledAssistant++;
                // Claude Code JSONL format: type="user" with message.content (string or array)
                if (!result.firstUserMessage && entry.type === 'user' && entry.message) {
                    const text = extractClaudeMessageText(entry.message.content);
                    if (text && text.length > 0) {
                        result.firstUserMessage = truncateAtBoundary(text, 900);
                    }
                }
            } catch { /* skip malformed lines */ }
        }

        // --- Read last chunk for last user message + last message (any role) ---
        const fileFullyRead = fileSize <= CHUNK;
        if (fileSize > CHUNK) {
            const tailOffset = Math.max(0, fileSize - CHUNK);
            const tailBuf = Buffer.alloc(Math.min(CHUNK, fileSize - tailOffset));
            const { bytesRead: tailRead } = await handle.read(tailBuf, 0, tailBuf.length, tailOffset);
            const tailText = tailBuf.toString('utf-8', 0, tailRead);
            const tailLines = tailText.split('\n').filter(l => l.trim());
            lineCount += tailLines.length;

            // Also accumulate per-role counts from the tail (still sampled — may double-count
            // the one boundary line but that's one line of error in large files).
            for (const line of tailLines) {
                try {
                    const entry = JSON.parse(line);
                    if (entry.type === 'user') sampledUser++;
                    else if (entry.type === 'assistant') sampledAssistant++;
                } catch { /* skip */ }
            }

            // Scan backwards for last USER message + last message (any role)
            for (let i = tailLines.length - 1; i >= 0; i--) {
                try {
                    const entry = JSON.parse(tailLines[i]);
                    if (!result.lastMessage && (entry.type === 'user' || entry.type === 'assistant') && entry.message) {
                        const text = extractClaudeMessageText(entry.message.content);
                        if (text && text.length > 0) {
                            result.lastMessage = truncateAtBoundary(text, 500);
                            result.lastMessageRole = entry.type as 'user' | 'assistant';
                        }
                    }
                    if (!result.lastUserMessage && entry.type === 'user' && entry.message) {
                        const text = extractClaudeMessageText(entry.message.content);
                        if (text && text.length > 0) {
                            result.lastUserMessage = truncateAtBoundary(text, 500);
                        }
                    }
                    if (result.lastUserMessage && result.lastMessage) break;
                } catch { /* skip */ }
            }
        } else {
            // Small file: head chunk has everything, scan backwards through headLines for last messages
            for (let i = headLines.length - 1; i >= 0; i--) {
                try {
                    const entry = JSON.parse(headLines[i]);
                    if (!result.lastMessage && (entry.type === 'user' || entry.type === 'assistant') && entry.message) {
                        const text = extractClaudeMessageText(entry.message.content);
                        if (text && text.length > 0) {
                            result.lastMessage = truncateAtBoundary(text, 500);
                            result.lastMessageRole = entry.type as 'user' | 'assistant';
                        }
                    }
                    if (!result.lastUserMessage && entry.type === 'user' && entry.message) {
                        const text = extractClaudeMessageText(entry.message.content);
                        if (text && text.length > 0) {
                            result.lastUserMessage = truncateAtBoundary(text, 500);
                        }
                    }
                    if (result.lastUserMessage && result.lastMessage) break;
                } catch { /* skip */ }
            }
        }

        // Message count: exact if the whole file fit in the head chunk, extrapolated otherwise.
        if (fileFullyRead) {
            result.messageCount = sampledUser + sampledAssistant;
            result.sampledCountsAreExact = true;
        } else {
            // Extrapolate from avg bytes/line across sampled chunks
            const avgBytesPerLine = Math.max(100, (CHUNK * 2) / Math.max(lineCount, 1));
            result.messageCount = Math.max(1, Math.round(fileSize / avgBytesPerLine));
            result.sampledCountsAreExact = false;
        }
        result.sampledUserCount = sampledUser;
        result.sampledAssistantCount = sampledAssistant;

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
    /** Last message of ANY role (user or assistant) — often the final state/result. */
    lastMessage?: string;
    lastMessageRole?: 'user' | 'assistant';
    approxMessageCount: number;
    title?: string;
    /** Sampled per-role counts from head+tail chunks (exact when file fully scanned). */
    userCount?: number;
    assistantCount?: number;
    countsAreExact?: boolean;
}

/**
 * Extract metadata from a Claude JSONL file by reading only the first and last chunks.
 * This provides cwd, first/last messages (per-role + any-role), and an approximate
 * message count without parsing the entire file (which can be many MB).
 *
 * #1245 round 2:
 *   - CHUNK_SIZE bumped 8KB → 48KB (more content in first message, more accurate counts)
 *   - Added lastMessage (any role) + lastMessageRole
 *   - Added userCount/assistantCount with countsAreExact flag
 *   - Truncation 300 → 900 (first), 200 → 500 (last user + last any)
 *
 * JSONL format: each line is a JSON object with { type, message?, cwd?, timestamp? }
 * User messages have type="user" with message.role="user" and message.content (string or array).
 * Assistant messages have type="assistant" with message.role="assistant" and message.content.
 */
async function extractClaudeJsonlMetadata(filePath: string, fileSize: number): Promise<ClaudeJsonlMetadata> {
    const result: ClaudeJsonlMetadata = { approxMessageCount: 0 };
    let handle: import('fs/promises').FileHandle | undefined;

    try {
        handle = await fs.open(filePath, 'r');
        const CHUNK_SIZE = 49152; // 48KB — enough to capture richer first messages and more accurate counts

        let sampledUser = 0;
        let sampledAssistant = 0;
        let fileFullyRead = false;

        // --- Read first chunk (first 48KB) ---
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
                // Count messages by role (sampled from head chunk)
                if (entry.type === 'user' && entry.message?.role === 'user') {
                    sampledUser++;
                } else if (entry.type === 'assistant' && entry.message?.role === 'assistant') {
                    sampledAssistant++;
                }
                // Extract first user message
                if (!result.firstUserMessage && entry.type === 'user' && entry.message?.role === 'user') {
                    const content = extractClaudeMessageText(entry.message.content);
                    if (content) {
                        result.firstUserMessage = truncateAtBoundary(content, 900);
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

        // --- Read last chunk (last 48KB) ---
        if (fileSize > CHUNK_SIZE) {
            const tailOffset = Math.max(0, fileSize - CHUNK_SIZE);
            const tailBuf = Buffer.alloc(Math.min(CHUNK_SIZE, fileSize - tailOffset));
            const { bytesRead: tailRead } = await handle.read(tailBuf, 0, tailBuf.length, tailOffset);
            const tailText = tailBuf.toString('utf-8', 0, tailRead);
            const tailLines = tailText.split('\n');

            // Accumulate per-role counts from tail (note: head+tail may overlap on small files,
            // but we already guarded fileSize > CHUNK_SIZE above, so no overlap here)
            let tailUser = 0;
            let tailAssistant = 0;

            // Walk backwards to find the last message (any role) and the last user message
            let foundLastAny = false;
            let foundLastUser = false;
            for (let i = tailLines.length - 1; i >= 0; i--) {
                const trimmed = tailLines[i].trim();
                if (!trimmed) continue;
                try {
                    const entry = JSON.parse(trimmed);
                    const isUser = entry.type === 'user' && entry.message?.role === 'user';
                    const isAssistant = entry.type === 'assistant' && entry.message?.role === 'assistant';
                    if (isUser) tailUser++;
                    if (isAssistant) tailAssistant++;

                    if (!foundLastAny && (isUser || isAssistant)) {
                        const content = extractClaudeMessageText(entry.message.content);
                        if (content) {
                            result.lastMessage = truncateAtBoundary(content, 500);
                            result.lastMessageRole = isUser ? 'user' : 'assistant';
                            foundLastAny = true;
                        }
                    }
                    if (!foundLastUser && isUser) {
                        const content = extractClaudeMessageText(entry.message.content);
                        if (content) {
                            result.lastUserMessage = truncateAtBoundary(content, 500);
                            foundLastUser = true;
                        }
                    }
                    // Keep scanning so per-role counts are accumulated across the whole tail chunk
                } catch {
                    // Skip truncated lines at chunk boundary
                }
            }

            sampledUser += tailUser;
            sampledAssistant += tailAssistant;
        } else {
            // Small file: entire file was in head chunk. Scan backwards through headLines
            // for lastMessage/lastUserMessage.
            fileFullyRead = true;
            let foundLastAny = false;
            let foundLastUser = false;
            for (let i = headLines.length - 1; i >= 0; i--) {
                const trimmed = headLines[i].trim();
                if (!trimmed) continue;
                try {
                    const entry = JSON.parse(trimmed);
                    const isUser = entry.type === 'user' && entry.message?.role === 'user';
                    const isAssistant = entry.type === 'assistant' && entry.message?.role === 'assistant';
                    if (!foundLastAny && (isUser || isAssistant)) {
                        const content = extractClaudeMessageText(entry.message.content);
                        if (content) {
                            result.lastMessage = truncateAtBoundary(content, 500);
                            result.lastMessageRole = isUser ? 'user' : 'assistant';
                            foundLastAny = true;
                        }
                    }
                    if (!foundLastUser && isUser) {
                        const content = extractClaudeMessageText(entry.message.content);
                        if (content) {
                            result.lastUserMessage = truncateAtBoundary(content, 500);
                            foundLastUser = true;
                        }
                    }
                    if (foundLastAny && foundLastUser) break;
                } catch {
                    // Skip unparseable lines
                }
            }
        }

        // --- Per-role counts + approximate total message count ---
        result.userCount = sampledUser;
        result.assistantCount = sampledAssistant;
        result.countsAreExact = fileFullyRead;

        if (fileFullyRead) {
            result.approxMessageCount = sampledUser + sampledAssistant;
        } else {
            // Claude JSONL lines average ~500-2000 bytes. Use 1000 as middle ground.
            // Only user+assistant messages matter, roughly 60% of lines.
            const approxTotalLines = Math.max(1, Math.round(fileSize / 1000));
            result.approxMessageCount = Math.max(1, Math.round(approxTotalLines * 0.6));
        }

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
async function scanClaudeSessions(
    workspaceFilter?: string,
    workspaceMatchStrategy: 'exact' | 'normalized' | 'substring' = 'normalized'
): Promise<ConversationSkeleton[]> {
    const now = Date.now();

    // Return cached results if TTL hasn't expired
    if (lastClaudeScanResults !== null && (now - lastClaudeScanTime) < CLAUDE_SCAN_CACHE_TTL) {
        // Apply workspace filter on cached results
        if (workspaceFilter) {
            return lastClaudeScanResults.filter(s =>
                matchesWorkspace(s.metadata?.workspace, workspaceFilter, workspaceMatchStrategy)
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

                    // #1245 round 2: prefer sessionMeta's richer fields, fall back to jsonlMeta
                    const mergedFirstUser = sessionMeta.firstUserMessage || jsonlMeta.firstUserMessage;
                    const mergedLastUser = sessionMeta.lastUserMessage || jsonlMeta.lastUserMessage;
                    const mergedLastAny = sessionMeta.lastMessage || jsonlMeta.lastMessage;
                    const mergedLastRole = sessionMeta.lastMessageRole || jsonlMeta.lastMessageRole;

                    // Per-role counts: prefer sessionMeta sampled counts, fall back to jsonlMeta
                    const userCount = sessionMeta.sampledUserCount ?? jsonlMeta.userCount;
                    const assistantCount = sessionMeta.sampledAssistantCount ?? jsonlMeta.assistantCount;

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
                        // #666 + #1245: Store extracted messages + per-role counts for SkeletonNode enrichment (fallback)
                        _claudeFirstUserMessage: mergedFirstUser,
                        _claudeLastUserMessage: mergedLastUser,
                        _claudeLastMessage: mergedLastAny,
                        _claudeLastMessageRole: mergedLastRole,
                        _claudeUserCount: userCount,
                        _claudeAssistantCount: assistantCount,
                    } as ConversationSkeleton & {
                        _claudeFirstUserMessage?: string;
                        _claudeLastUserMessage?: string;
                        _claudeLastMessage?: string;
                        _claudeLastMessageRole?: 'user' | 'assistant';
                        _claudeUserCount?: number;
                        _claudeAssistantCount?: number;
                    };

                    // Inject first/last messages into sequence for toConversationSummary
                    // #1245 round 2: also inject lastMessage (any role) as the FINAL synthetic entry,
                    // so the Roo sequence-extraction code path in the skeletonMap build picks it up
                    // via a reverse scan. Use role='assistant' for non-user last messages so the
                    // existing "last assistant" logic surfaces it.
                    if (mergedFirstUser || mergedLastUser || mergedLastAny) {
                        const seq: any[] = [];
                        if (mergedFirstUser) {
                            seq.push({ role: 'user', content: mergedFirstUser });
                        }
                        if (mergedLastUser && mergedLastUser !== mergedFirstUser) {
                            seq.push({ role: 'user', content: mergedLastUser });
                        }
                        // Final entry = last message of any role, so reverse scans pick it up
                        if (mergedLastAny && mergedLastAny !== mergedLastUser && mergedLastAny !== mergedFirstUser) {
                            seq.push({ role: mergedLastRole || 'assistant', content: mergedLastAny });
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

    // Apply workspace filter (#1244 Couche 2.2 — strategy-aware)
    if (workspaceFilter) {
        return skeletons.filter(s =>
            matchesWorkspace(s.metadata?.workspace, workspaceFilter, workspaceMatchStrategy)
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