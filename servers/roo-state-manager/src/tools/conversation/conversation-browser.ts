/**
 * Outil MCP consolidé : conversation_browser
 * CONS-X (#457) : Consolide task_browse + view_conversation_tree + roosync_summarize → 1 outil
 *
 * Actions disponibles :
 * - 'list'      : Lister les conversations récentes avec filtres et tri (anciennement list_conversations)
 * - 'tree'      : Vue arborescente des tâches (anciennement task_browse action=tree)
 * - 'current'   : Tâche actuellement active (anciennement task_browse action=current)
 * - 'view'      : Vue arborescente d'une conversation (anciennement view_conversation_tree)
 * - 'summarize' : Résumé/synthèse de conversation (anciennement roosync_summarize)
 * - 'rebuild'   : Reconstruction du cache de squelettes (anciennement build_skeleton_cache)
 *
 * Changement tool count : -3 (4 outils → 1 dans ListTools après ajout de rebuild)
 * Backward compat : Les anciens noms restent fonctionnels via CallTool dans registry.ts
 */

import { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { StateManagerError } from '../../types/errors.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { handleTaskBrowse, TaskBrowseArgs } from '../task/browse.js';
import { viewConversationTree } from '../view-conversation-tree.js';
import { handleRooSyncSummarize, RooSyncSummarizeArgs } from '../summary/roosync-summarize.tool.js';
import { listConversationsTool } from './list-conversations.tool.js';
import { handleBuildSkeletonCache } from '../cache/build-skeleton-cache.tool.js';
import { handleGetConversationSynthesis } from '../summary/get-conversation-synthesis.tool.js';
import { ServerState } from '../../services/state-manager.service.js';
import { conversationBrowserDefinition } from '../tool-definitions.js';

/**
 * Type union pour les actions supportées
 */
export type ConversationBrowserAction = 'list' | 'tree' | 'current' | 'view' | 'summarize' | 'rebuild';

/**
 * Arguments pour l'outil conversation_browser
 * Combine tous les paramètres des 3 outils originaux
 */
export interface ConversationBrowserArgs {
    /** Action à effectuer */
    action: ConversationBrowserAction;

    // ===== Arguments pour action='list' (via list_conversations) =====
    /** [list] Nombre maximum de conversations à retourner */
    limit?: number;
    /** [list] Page number (1-based). Requires per_page. */
    page?: number;
    /** [list] Results per page (10-100). Default: 10. */
    per_page?: number;
    /** [list] Critère de tri */
    sortBy?: 'lastActivity' | 'messageCount' | 'totalSize';
    /** [list] Ordre de tri */
    sortOrder?: 'asc' | 'desc';
    /** [list] Ne retourner que les tâches avec sous-tâche en attente */
    pendingSubtaskOnly?: boolean;
    /** [list] Filtre par contenu (recherche insensible à la casse) */
    contentPattern?: string;

    // ===== Arguments pour action='tree' (via task_browse) =====
    /** [tree] ID de la conversation (requis si action='tree') */
    conversation_id?: string;
    /** [tree] Profondeur maximale de l'arbre */
    max_depth?: number;
    /** [tree] Inclure les tâches sœurs */
    include_siblings?: boolean;
    /** [tree] Format de sortie */
    output_format?: 'json' | 'markdown' | 'ascii-tree' | 'hierarchical';
    /** [tree/view] ID de la tâche en cours pour marquage */
    current_task_id?: string;
    /** [tree] Longueur max de l'instruction (défaut: 80) */
    truncate_instruction?: number;
    /** [tree] Afficher les métadonnées détaillées */
    show_metadata?: boolean;

    // ===== Arguments pour action='current' =====
    /** [current/view] Chemin du workspace (détection auto si omis) */
    workspace?: string;
    /** [list] #1244 Couche 2.2 — Strategie de matching du workspace.
     * 'exact' = comparaison stricte, 'normalized' (defaut) = match basename tolerant cross-machine,
     * 'substring' = test includes pour recherches exploratoires. */
    workspacePathMatch?: 'exact' | 'normalized' | 'substring';
    /** [list] #1244 Couche 2.1 — Date debut (ISO 8601 ou YYYY-MM-DD). Filtre lastActivity >= startDate. */
    startDate?: string;
    /** [list] #1244 Couche 2.1 — Date fin (ISO 8601 ou YYYY-MM-DD). Filtre lastActivity <= endDate. */
    endDate?: string;
    /** [list] #1244 Couche 2.1 — Filtre par identifiant machine (cross-machine). */
    machineId?: string;

    // ===== Arguments pour action='view' (via view_conversation_tree) =====
    /** [view] ID de la tâche de départ */
    task_id?: string;
    /** [view] Mode d'affichage */
    view_mode?: 'single' | 'chain' | 'cluster';
    /** [view] Niveau de détail */
    detail_level?: 'skeleton' | 'summary' | 'full';
    /** [view] Lignes à conserver au début/fin */
    truncate?: number;
    /** [view] Limite max de caractères en sortie */
    max_output_length?: number;
    /** [view] #1244 Couche 2.5 — Troncature intelligente avec gradient. Activee PAR DEFAUT. */
    smart_truncation?: boolean;
    /** [view] Configuration troncature intelligente */
    smart_truncation_config?: {
        gradientStrength?: number;
        minPreservationRate?: number;
        maxTruncationRate?: number;
    };
    /** [view] #1244 Couche 2.6 — Index 0-based du premier message a inclure (inclusif). */
    messageStart?: number;
    /** [view] #1244 Couche 2.6 — Index 0-based du dernier message a inclure (exclusif). */
    messageEnd?: number;
    /** [view] Chemin pour sauvegarder l'arbre */
    output_file?: string;

    // ===== Arguments pour action='summarize' (via roosync_summarize) =====
    /** [summarize] Type de résumé (requis si action='summarize') */
    summarize_type?: 'trace' | 'cluster' | 'synthesis';
    /** [summarize] ID de la tâche (alias pour task_id en contexte summarize) */
    taskId?: string;
    /** [list/summarize] Source des conversations: 'roo' (défaut), 'claude', ou 'all' */
    source?: 'roo' | 'claude' | 'all';
    /** [summarize] Chemin pour sauvegarder */
    filePath?: string;
    /** [summarize] Format de sortie */
    summarize_output_format?: 'markdown' | 'html' | 'json';
    /** [summarize] Niveau de détail (#3196: Compact et NoToolParams exposés — 8 valeurs, alignées sur la factory) */
    detailLevel?: 'Full' | 'NoTools' | 'NoToolParams' | 'Compact' | 'NoResults' | 'Messages' | 'Summary' | 'UserOnly';
    /** [summarize] Chars max avant troncature */
    truncationChars?: number;
    /** [summarize] Format compact pour stats */
    compactStats?: boolean;
    /** [summarize] Inclure CSS */
    includeCss?: boolean;
    /** [summarize] Générer table des matières */
    generateToc?: boolean;
    /** [summarize] Index de début (1-based) */
    startIndex?: number;
    /** [summarize] Index de fin (1-based) */
    endIndex?: number;
    /** [summarize/cluster] IDs tâches enfantes */
    childTaskIds?: string[];
    /** [summarize/cluster] Mode de clustering */
    clusterMode?: 'aggregated' | 'detailed' | 'comparative';
    /** [summarize/cluster] Inclure stats de grappe */
    includeClusterStats?: boolean;
    /** [summarize/cluster] Analyse cross-task */
    crossTaskAnalysis?: boolean;
    /** [summarize/cluster] Profondeur max */
    maxClusterDepth?: number;
    /** [summarize/cluster] Critère de tri */
    clusterSortBy?: 'chronological' | 'size' | 'activity' | 'alphabetical';
    /** [summarize/cluster] Inclure timeline */
    includeClusterTimeline?: boolean;
    /** [summarize/cluster] Troncature de grappe */
    clusterTruncationChars?: number;
    /** [summarize/cluster] Montrer relations */
    showTaskRelationships?: boolean;

    // ===== Arguments pour action='summarize', summarize_type='synthesis' =====
    /** [summarize/synthesis] Format de sortie pour la synthèse LLM */
    synthesis_output_format?: 'json' | 'markdown';

    // ===== Arguments pour action='rebuild' (via build_skeleton_cache) =====
    /** [rebuild] Si true, reconstruit TOUS les squelettes. Si false, ne reconstruit que les manquants/obsolètes */
    force_rebuild?: boolean;
    /** [rebuild] Liste d'IDs de tâches spécifiques à reconstruire */
    task_ids?: string[];
    /** [rebuild] #1244 Couche 1.4 — Sources de squelettes ('roo'|'claude'|'archive'). Defaut: ['roo']. */
    sources?: Array<'roo' | 'claude' | 'archive'>;
    /** [rebuild] #1244 Couche 1.4 — Si true, force l'enqueue Qdrant pour tous les squelettes (tous tiers). */
    reindex?: boolean;
    /** [list] #1752 Bug #3 — Inclure les archives cross-machine depuis GDrive (Tier 3). Default: false. */
    includeArchives?: boolean;
    /** [list] #3255 — Attendre le chargement Tier 3 (budget 45s). Default: false = rendu local immédiat. */
    waitForArchives?: boolean;
}

/**
 * Public handler metadata reuses the exact static definition served by tools/list.
 * The dependency stays one-way: the zero-handler static schema never imports here.
 */
export const conversationBrowserTool = conversationBrowserDefinition as unknown as Tool;

const EMPTY_STRING_SENTINEL_FIELDS = new Set<keyof ConversationBrowserArgs>([
    'sortBy', 'sortOrder', 'contentPattern', 'workspacePathMatch', 'startDate', 'endDate',
    'machineId', 'conversation_id', 'output_format', 'current_task_id', 'workspace',
    'task_id', 'view_mode', 'detail_level', 'output_file', 'summarize_type', 'taskId',
    'source', 'filePath', 'summarize_output_format', 'detailLevel', 'clusterMode',
    'clusterSortBy', 'synthesis_output_format'
]);

/** Wire boundary for clients that require every flat-schema property. */
export type ConversationBrowserWireArgs = {
    [K in keyof ConversationBrowserArgs]: K extends 'action'
        ? ConversationBrowserArgs[K]
        : ConversationBrowserArgs[K] | null
            | (NonNullable<ConversationBrowserArgs[K]> extends string ? '' : never);
};

/**
 * Remove transport-only sentinels before validation and delegation. Real values,
 * including false, 0, empty arrays and empty objects, remain semantically active.
 */
function normalizeWireArgs(args: ConversationBrowserWireArgs): ConversationBrowserArgs {
    const normalized = { ...args } as Record<string, unknown>;

    for (const [name, value] of Object.entries(normalized)) {
        if (name !== 'action' && value === null) {
            delete normalized[name];
        }
    }

    for (const name of EMPTY_STRING_SENTINEL_FIELDS) {
        if (normalized[name] === '') {
            delete normalized[name];
        }
    }

    return normalized as unknown as ConversationBrowserArgs;
}

/**
 * Valide les arguments selon l'action demandée
 */
function validateArgs(args: ConversationBrowserArgs): void {
    if (!args.action) {
        throw new StateManagerError(
            'Le paramètre "action" est requis. Valeurs possibles: "list", "tree", "current", "view", "summarize", "rebuild".',
            'VALIDATION_FAILED',
            'ConversationBrowserTool',
            { providedArgs: Object.keys(args) }
        );
    }

    const validActions: ConversationBrowserAction[] = ['list', 'tree', 'current', 'view', 'summarize', 'rebuild'];
    if (!validActions.includes(args.action)) {
        throw new StateManagerError(
            `Action invalide: "${args.action}". Valeurs possibles: ${validActions.join(', ')}.`,
            'INVALID_ACTION',
            'ConversationBrowserTool',
            { action: args.action }
        );
    }

    if (args.action === 'tree' && !args.conversation_id) {
        throw new StateManagerError(
            'Le paramètre "conversation_id" est requis pour l\'action "tree".',
            'VALIDATION_FAILED',
            'ConversationBrowserTool',
            { action: args.action, missingParam: 'conversation_id' }
        );
    }

    // #3173 — Un identifiant fourni mais non honoré par l'action fait échouer l'appel,
    // jamais de repli silencieux : view+conversation_id rendait la session courante ou
    // une session d'un autre workspace sans avertissement (mesuré po-2023 et ai-01).
    if (args.action === 'view') {
        if (args.conversation_id) {
            throw new StateManagerError(
                'Le paramètre "conversation_id" n\'est pas honoré par l\'action "view" — utilisez "task_id". Un identifiant fourni doit être honoré, jamais ignoré silencieusement.',
                'VALIDATION_FAILED',
                'ConversationBrowserTool',
                { action: args.action, rejectedParam: 'conversation_id', expectedParam: 'task_id' }
            );
        }
        if (args.taskId) {
            throw new StateManagerError(
                'Le paramètre "taskId" (alias de summarize) n\'est pas honoré par l\'action "view" — utilisez "task_id".',
                'VALIDATION_FAILED',
                'ConversationBrowserTool',
                { action: args.action, rejectedParam: 'taskId', expectedParam: 'task_id' }
            );
        }
        // #3174 — detailLevel (vocabulaire summarize, enum Full/Summary/…) était ignoré
        // en silence sur view : l'appelant demandait un rendu Summary et recevait le
        // défaut skeleton sans avertissement (mesuré po-2026 c.251 sur build 52603929).
        if (args.detailLevel !== undefined) {
            throw new StateManagerError(
                'Le paramètre "detailLevel" (vocabulaire de summarize) n\'est pas honoré par l\'action "view" — utilisez "detail_level". Un paramètre fourni doit être honoré, jamais ignoré silencieusement.',
                'VALIDATION_FAILED',
                'ConversationBrowserTool',
                { action: args.action, rejectedParam: 'detailLevel', expectedParam: 'detail_level' }
            );
        }
    }
    if (args.action === 'tree' && args.task_id) {
        throw new StateManagerError(
            'Le paramètre "task_id" n\'est pas honoré par l\'action "tree" — utilisez "conversation_id".',
            'VALIDATION_FAILED',
            'ConversationBrowserTool',
            { action: args.action, rejectedParam: 'task_id', expectedParam: 'conversation_id' }
        );
    }

    // #3187 — Une valeur d'enum inconnue ne doit pas changer le comportement en silence :
    // view_mode invalide rendait un arbre VIDE (switch sans default view-conversation-tree.ts:493/638),
    // detail_level invalide rendait le contenu COMPLET. Même convention que la garde #3173.
    if (args.action === 'view') {
        if (args.view_mode !== undefined && !['single', 'chain', 'cluster'].includes(args.view_mode)) {
            throw new StateManagerError(
                `Valeur invalide pour "view_mode" : "${args.view_mode}". Valeurs acceptées : single, chain, cluster.`,
                'VALIDATION_FAILED',
                'ConversationBrowserTool',
                { action: args.action, rejectedValue: args.view_mode, acceptedValues: ['single', 'chain', 'cluster'] }
            );
        }
        if (args.detail_level !== undefined && !['skeleton', 'summary', 'full'].includes(args.detail_level)) {
            throw new StateManagerError(
                `Valeur invalide pour "detail_level" : "${args.detail_level}". Valeurs acceptées : skeleton, summary, full.`,
                'VALIDATION_FAILED',
                'ConversationBrowserTool',
                { action: args.action, rejectedValue: args.detail_level, acceptedValues: ['skeleton', 'summary', 'full'] }
            );
        }
    }

    if (args.action === 'summarize') {
        if (!args.summarize_type) {
            throw new StateManagerError(
                'Le paramètre "summarize_type" est requis pour l\'action "summarize". Valeurs: "trace", "cluster", "synthesis".',
                'VALIDATION_FAILED',
                'ConversationBrowserTool',
                { action: args.action, missingParam: 'summarize_type' }
            );
        }
        // taskId peut venir de taskId ou task_id
        const resolvedTaskId = args.taskId || args.task_id;
        if (!resolvedTaskId) {
            throw new StateManagerError(
                'Le paramètre "taskId" (ou "task_id") est requis pour l\'action "summarize".',
                'VALIDATION_FAILED',
                'ConversationBrowserTool',
                { action: args.action, missingParam: 'taskId' }
            );
        }
    }
}

/**
 * Handler pour summarize_type='synthesis' : appelle le pipeline LLM complet
 * via get-conversation-synthesis.tool.ts (SynthesisOrchestratorService)
 */
async function handleSynthesisAction(
    taskId: string,
    outputFormat: 'json' | 'markdown',
    filePath?: string,
    getConversationSkeleton?: (id: string) => Promise<ConversationSkeleton | null>
): Promise<CallToolResult> {
    if (!getConversationSkeleton) {
        return {
            content: [{ type: 'text', text: 'Erreur: getConversationSkeleton non disponible pour la synthèse LLM.' }],
            isError: true
        };
    }

    try {
        const result = await handleGetConversationSynthesis(
            { taskId, filePath, outputFormat },
            getConversationSkeleton
        );

        // handleGetConversationSynthesis returns string (if filePath or markdown) or ConversationAnalysis object
        const text = typeof result === 'string'
            ? result
            : JSON.stringify(result, null, 2);

        return {
            content: [{ type: 'text', text }]
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
        return {
            content: [{ type: 'text', text: `Erreur lors de la synthèse LLM: ${errorMessage}` }],
            isError: true
        };
    }
}

/**
 * #1262 — Timeout dur appliqué à toute exécution de conversation_browser.
 * Si une action (list/view/tree/current/...) prend plus de CONVERSATION_BROWSER_TIMEOUT_MS,
 * c'est un BUG à signaler : la pagination de liste ou l'affichage d'une conversation
 * doit se terminer en moins de 30 secondes. Override via env CONVERSATION_BROWSER_TIMEOUT_MS.
 */
const CONVERSATION_BROWSER_TIMEOUT_MS = parseInt(
    process.env.CONVERSATION_BROWSER_TIMEOUT_MS || '30000',
    10
);

/**
 * Tier 3 cold-start: includeArchives (Tier 3 GDrive) gets a larger budget than the
 * default 30s. The archive cache is pre-warmed at boot (background-services), and the
 * list handler degrades gracefully at 45s (local results + notice) via
 * SkeletonCacheService.awaitFreshnessWithBudget — so this 90s cap is a pure backstop
 * that should never fire for the list path. 90s default, env-overridable.
 */
const CONVERSATION_BROWSER_ARCHIVE_TIMEOUT_MS = parseInt(
    process.env.CONVERSATION_BROWSER_ARCHIVE_TIMEOUT_MS || '90000',
    10
);

/**
 * Handler consolidé pour l'outil conversation_browser
 *
 * @param wireArgs Arguments du contrat wire, normalisés avant dispatch
 * @param conversationCache Cache des conversations (pour tree/current/view)
 * @param ensureSkeletonCacheIsFresh Fonction de rafraîchissement du cache (pour tree/current)
 * @param contextWorkspace Workspace contexte (pour current)
 * @param getConversationSkeleton Getter de skeleton (pour summarize, avec disk fallback)
 * @param findChildTasks Finder de tâches enfantes (pour summarize cluster)
 */
export async function handleConversationBrowser(
    wireArgs: ConversationBrowserWireArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    ensureSkeletonCacheIsFresh: () => Promise<void>,
    contextWorkspace?: string,
    getConversationSkeleton?: (id: string) => Promise<ConversationSkeleton | null>,
    findChildTasks?: (rootId: string) => Promise<ConversationSkeleton[]>,
    serverState?: ServerState
): Promise<CallToolResult> {
    // #1262 — Hard timeout (default 30s, env-overridable).
    // #3255: only the explicit waitForArchives opt-in needs the larger archive
    // backstop (90s > the handler's 45s Tier-3 wait). The default fast path must
    // stay under the standard 30s cap like every other action.
    const args = normalizeWireArgs(wireArgs);
    const effectiveTimeoutMs = args.includeArchives && args.waitForArchives
        ? CONVERSATION_BROWSER_ARCHIVE_TIMEOUT_MS
        : CONVERSATION_BROWSER_TIMEOUT_MS;
    // The inner work runs unmodified; we just race it against a timer.
    const startedAt = Date.now();
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<CallToolResult>((_, reject) => {
        timeoutHandle = setTimeout(() => {
            reject(new Error(
                `conversation_browser TIMEOUT after ${effectiveTimeoutMs}ms ` +
                `(action: ${args.action}). This is a BUG to report: list pagination or ` +
                `conversation detail must complete in <30s. Likely culprit: blocking ` +
                `ensureSkeletonCacheIsFresh() in src/index.ts (failsafe full rebuild or ` +
                `disk-scan storm). Workaround: disable force_refresh and retry; if it still ` +
                `blocks, restart the MCP server.`
            ));
        }, effectiveTimeoutMs);
        // Allow process to exit even if timer is still pending
        if (typeof timeoutHandle?.unref === 'function') {
            timeoutHandle.unref();
        }
    });

    try {
        return await Promise.race([
            handleConversationBrowserCore(
                args,
                conversationCache,
                ensureSkeletonCacheIsFresh,
                contextWorkspace,
                getConversationSkeleton,
                findChildTasks,
                serverState
            ),
            timeoutPromise
        ]);
    } catch (error) {
        const elapsedMs = Date.now() - startedAt;
        const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
        // Distinguish timeout from other errors so callers can spot the bug.
        const isTimeout = errorMessage.includes('TIMEOUT after');
        return {
            content: [{
                type: 'text',
                text: isTimeout
                    ? `${errorMessage} (elapsed=${elapsedMs}ms)`
                    : `Erreur lors de conversation_browser: ${errorMessage}`
            }],
            isError: true
        };
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}

/**
 * #1262 — Cœur de l'implémentation, isolé pour permettre le wrapping par timeout.
 * Ne pas exporter : le seul point d'entrée public reste handleConversationBrowser.
 */
async function handleConversationBrowserCore(
    args: ConversationBrowserArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    ensureSkeletonCacheIsFresh: () => Promise<void>,
    contextWorkspace?: string,
    getConversationSkeleton?: (id: string) => Promise<ConversationSkeleton | null>,
    findChildTasks?: (rootId: string) => Promise<ConversationSkeleton[]>,
    serverState?: ServerState
): Promise<CallToolResult> {
    try {
        validateArgs(args);

        switch (args.action) {
            case 'list': {
                return await listConversationsTool.handler(
                    {
                        limit: args.limit,
                        page: args.page,
                        per_page: args.per_page,
                        sortBy: args.sortBy,
                        sortOrder: args.sortOrder,
                        workspace: args.workspace,
                        workspacePathMatch: args.workspacePathMatch,
                        pendingSubtaskOnly: args.pendingSubtaskOnly,
                        contentPattern: args.contentPattern,
                        source: args.source,
                        // #1244 Couche 2.1 — Filtres date/machine cross-machine
                        startDate: args.startDate,
                        endDate: args.endDate,
                        machineId: args.machineId,
                        // #1752 Bug #3 — GDrive archive support
                        includeArchives: args.includeArchives,
                        // #3255 — opt-in bounded Tier-3 wait
                        waitForArchives: args.waitForArchives
                    },
                    conversationCache
                );
            }

            case 'tree': {
                const treeArgs: TaskBrowseArgs = {
                    action: 'tree',
                    conversation_id: args.conversation_id,
                    max_depth: args.max_depth,
                    include_siblings: args.include_siblings,
                    output_format: args.output_format,
                    current_task_id: args.current_task_id,
                    truncate_instruction: args.truncate_instruction,
                    show_metadata: args.show_metadata
                };
                return await handleTaskBrowse(
                    treeArgs,
                    conversationCache,
                    ensureSkeletonCacheIsFresh,
                    contextWorkspace
                );
            }

            case 'current': {
                const currentArgs: TaskBrowseArgs = {
                    action: 'current',
                    workspace: args.workspace
                };
                return await handleTaskBrowse(
                    currentArgs,
                    conversationCache,
                    ensureSkeletonCacheIsFresh,
                    contextWorkspace
                );
            }

            case 'view': {
                return await viewConversationTree.handler(
                    {
                        task_id: args.task_id,
                        workspace: args.workspace,
                        current_task_id: args.current_task_id,
                        view_mode: args.view_mode,
                        detail_level: args.detail_level,
                        truncate: args.truncate,
                        max_output_length: args.max_output_length,
                        smart_truncation: args.smart_truncation,
                        smart_truncation_config: args.smart_truncation_config,
                        // #1244 Couche 2.6 — Pagination message-level
                        messageStart: args.messageStart,
                        messageEnd: args.messageEnd,
                        output_file: args.output_file
                    },
                    conversationCache
                );
            }

            case 'summarize': {
                // Résoudre taskId depuis taskId ou task_id
                const resolvedTaskId = (args.taskId || args.task_id)!;

                // === Synthesis: DISABLED — LLM pipeline not yet implemented (#788) ===
                // Synthesis requires real LLM integration (Phase 3). Stub services return
                // null/error. Block early to prevent unnecessary service instantiation.
                if (args.summarize_type === 'synthesis') {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: 'SYNTHESIS_DISABLED: summarize_type "synthesis" requires LLM integration not yet available. Use "trace" or "cluster" instead. See issue #788.'
                        }],
                        isError: true
                    };
                }

                // Resolve source for summarize: 'all' not supported, auto-detect from taskId prefix
                const summarizeSource = args.source === 'all'
                    ? (resolvedTaskId.startsWith('claude-') ? 'claude' : 'roo')
                    : args.source;

                const summarizeArgs: RooSyncSummarizeArgs = {
                    type: args.summarize_type!,
                    taskId: resolvedTaskId,
                    source: summarizeSource,
                    filePath: args.filePath,
                    outputFormat: args.summarize_output_format,
                    detailLevel: args.detailLevel,
                    truncationChars: args.truncationChars,
                    compactStats: args.compactStats,
                    includeCss: args.includeCss,
                    generateToc: args.generateToc,
                    startIndex: args.startIndex,
                    endIndex: args.endIndex,
                    childTaskIds: args.childTaskIds,
                    clusterMode: args.clusterMode,
                    includeClusterStats: args.includeClusterStats,
                    crossTaskAnalysis: args.crossTaskAnalysis,
                    maxClusterDepth: args.maxClusterDepth,
                    clusterSortBy: args.clusterSortBy,
                    includeClusterTimeline: args.includeClusterTimeline,
                    clusterTruncationChars: args.clusterTruncationChars,
                    showTaskRelationships: args.showTaskRelationships
                };

                const summaryResult = await handleRooSyncSummarize(
                    summarizeArgs,
                    getConversationSkeleton,
                    findChildTasks
                );

                return {
                    content: [{ type: 'text', text: summaryResult }]
                };
            }

            case 'rebuild': {
                // Delegate to the existing build_skeleton_cache handler
                // #1244 Couche 1.4 — Forward sources/reindex pour le multi-tier rebuild
                return await handleBuildSkeletonCache(
                    {
                        force_rebuild: args.force_rebuild,
                        workspace_filter: args.workspace,
                        task_ids: args.task_ids,
                        sources: args.sources,
                        reindex: args.reindex
                    },
                    conversationCache,
                    serverState
                );
            }

            default:
                throw new StateManagerError(
                    `Action non supportée: ${(args as any).action}`,
                    'UNSUPPORTED_ACTION',
                    'ConversationBrowserTool',
                    { action: (args as any).action }
                );
        }
    } catch (error) {
        if (error instanceof StateManagerError) {
            return {
                content: [{ type: 'text', text: `Erreur: ${error.message}` }],
                isError: true
            };
        }
        const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
        return {
            content: [{ type: 'text', text: `Erreur lors de conversation_browser: ${errorMessage}` }],
            isError: true
        };
    }
}
