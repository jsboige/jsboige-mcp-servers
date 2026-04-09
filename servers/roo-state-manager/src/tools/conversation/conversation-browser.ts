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
 *
 * Changement tool count : -2 (3 outils → 1 dans ListTools)
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
    /** [summarize] Niveau de détail */
    detailLevel?: 'Full' | 'NoTools' | 'NoResults' | 'Messages' | 'Summary' | 'UserOnly';
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
}

/**
 * Définition de l'outil conversation_browser
 */
export const conversationBrowserTool: Tool = {
    name: 'conversation_browser',
    description: 'Outil consolide pour naviguer, visualiser et resumer les conversations Roo et Claude Code (cross-machine via archives GDrive). Actions: "list" (decouvrir les conversations avec filtres), "tree" (arbre parent-enfant), "current" (tache active du workspace), "view" (zoom contenu d\'une conversation, supporte la pagination message-level), "summarize" (resume/synthese), "rebuild" (reconstruire le cache multi-tier roo+claude+archive). Pattern de zoom: list -> view(detail_level=skeleton) -> view(messageStart/messageEnd) -> summarize. Toujours commencer par "list" pour decouvrir les IDs.',
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['list', 'tree', 'current', 'view', 'summarize', 'rebuild'],
                description: 'Action a effectuer. "list" = decouvrir les conversations (filtres workspace, machineId, startDate/endDate, contentPattern, source). "view" = inspecter une tache (detail_level=skeleton/summary/full, messageStart/messageEnd pour pagination). "summarize" = trace/cluster/synthesis. "tree" = arbre parent-enfant. "rebuild" = reconstruire le cache multi-tier (sources=[roo,claude,archive]).'
            },
            // --- Arguments list ---
            limit: {
                type: 'number',
                description: '[list] Nombre maximum de conversations à retourner (défaut: toutes).'
            },
            sortBy: {
                type: 'string',
                enum: ['lastActivity', 'messageCount', 'totalSize'],
                description: '[list] Critère de tri.',
                default: 'lastActivity'
            },
            sortOrder: {
                type: 'string',
                enum: ['asc', 'desc'],
                description: '[list] Ordre de tri.',
                default: 'desc'
            },
            pendingSubtaskOnly: {
                type: 'boolean',
                description: '[list] Ne retourner que les tâches avec sous-tâche en attente.'
            },
            contentPattern: {
                type: 'string',
                description: '[list] Filtre les tâches contenant ce texte dans leurs messages.'
            },
            // --- Arguments tree ---
            conversation_id: {
                type: 'string',
                description: '[tree] ID de la conversation pour l\'arbre des tâches.'
            },
            max_depth: {
                type: 'number',
                description: '[tree] Profondeur maximale de l\'arbre.'
            },
            include_siblings: {
                type: 'boolean',
                description: '[tree] Inclure les tâches sœurs.',
                default: true
            },
            output_format: {
                type: 'string',
                enum: ['json', 'markdown', 'ascii-tree', 'hierarchical'],
                description: '[tree] Format de sortie.',
                default: 'json'
            },
            current_task_id: {
                type: 'string',
                description: '[tree/view] ID de la tâche en cours pour marquage.'
            },
            truncate_instruction: {
                type: 'number',
                description: '[tree] Longueur max de l\'instruction (défaut: 80).',
                default: 80
            },
            show_metadata: {
                type: 'boolean',
                description: '[tree] Afficher les métadonnées détaillées.',
                default: false
            },
            // --- Arguments current ---
            workspace: {
                type: 'string',
                description: '[current/view] Chemin du workspace (détection auto si omis).'
            },
            workspacePathMatch: {
                type: 'string',
                enum: ['exact', 'normalized', 'substring'],
                description: '[list] #1244 Couche 2.2 — Strategie de matching du workspace. "exact": comparaison stricte (apres normalisation forward-slash). "normalized" (defaut): match par basename, tolere les variations de chemin parent (`d:/dev/CoursIA` == `d:/CoursIA`) — strategie cross-machine la plus robuste. "substring": test includes lowercase, le plus tolerant.',
                default: 'normalized'
            },
            startDate: {
                type: 'string',
                description: '[list] #1244 Couche 2.1 — Date debut (ISO 8601 ou YYYY-MM-DD). Filtre les taches dont lastActivity >= startDate. Combinable avec endDate. Exemple: "2026-04-07".'
            },
            endDate: {
                type: 'string',
                description: '[list] #1244 Couche 2.1 — Date fin (ISO 8601 ou YYYY-MM-DD). Filtre les taches dont lastActivity <= endDate (inclusif jusqu\'a fin de journee). Exemple: "2026-04-08".'
            },
            machineId: {
                type: 'string',
                description: '[list] #1244 Couche 2.1 — Filtre par identifiant machine (cross-machine). Permet d\'isoler les conversations d\'une machine specifique parmi les archives chargees depuis GDrive. Exemple: "myia-po-2025".'
            },
            // --- Arguments view ---
            task_id: {
                type: 'string',
                description: '[view/summarize] ID de la tâche à inspecter. Decouvrir les IDs via action="list" en premier. Pour les sessions Claude Code, le prefixe peut etre "claude-" ; les taches Roo et les archives utilisent l\'UUID brut.'
            },
            view_mode: {
                type: 'string',
                enum: ['single', 'chain', 'cluster'],
                description: '[view] Mode d\'affichage. "single" = une tache, "chain" (defaut) = remonte la chaine parent, "cluster" = arbre enfants.',
                default: 'chain'
            },
            detail_level: {
                type: 'string',
                enum: ['skeleton', 'summary', 'full'],
                description: '[view] Niveau de detail (zoom progressif). "skeleton" (defaut, ~15k chars) = vue overview ; "summary" (~50k) = contenu principal condense ; "full" (~150k) = sequence complete avec tous les outils. Combiner avec messageStart/messageEnd pour pagination message-level.',
                default: 'skeleton'
            },
            truncate: {
                type: 'number',
                description: '[view] Lignes à conserver au début/fin (0 = défaut intelligent).',
                default: 0
            },
            max_output_length: {
                type: 'number',
                description: '[view] Limite max de caractères en sortie. Un hard cap final est applique pour garantir le respect de cette limite quel que soit le mode de troncature.',
                default: 300000
            },
            smart_truncation: {
                type: 'boolean',
                description: '[view] #1244 Couche 2.5 — Algorithme de troncature intelligente (gradient temporel + priorisation par type, preserve debut/fin de conversation). Active PAR DEFAUT depuis #1244. Passer false uniquement pour debug ou comparaison avec le legacy path.',
                default: true
            },
            smart_truncation_config: {
                type: 'object',
                description: '[view] Configuration avancée pour la troncature intelligente.',
                properties: {
                    gradientStrength: { type: 'number' },
                    minPreservationRate: { type: 'number' },
                    maxTruncationRate: { type: 'number' }
                }
            },
            messageStart: {
                type: 'number',
                description: '[view] #1244 Couche 2.6 — Index 0-based du premier message a inclure (inclusif). Permet la pagination message-level sur les longues conversations. Defaut: 0 (debut). Pour paginer, re-appeler view avec messageStart = messageEnd precedent.'
            },
            messageEnd: {
                type: 'number',
                description: '[view] #1244 Couche 2.6 — Index 0-based du dernier message a inclure (exclusif). Si > total, est clampe a total. Defaut: jusqu\'a la fin. La reponse inclut messageRange: {start, end, total} et truncated: bool pour faciliter la navigation.'
            },
            output_file: {
                type: 'string',
                description: '[view] Chemin pour sauvegarder l\'arbre dans un fichier.'
            },
            // --- Arguments summarize ---
            summarize_type: {
                type: 'string',
                enum: ['trace', 'cluster', 'synthesis'],
                description: '[summarize] Type de résumé (requis si action=summarize). "trace" = statistiques et timeline. "cluster" = grappes parent-enfant. "synthesis" = pipeline LLM avec analyse sémantique et profils d\'acteurs.'
            },
            taskId: {
                type: 'string',
                description: '[summarize] ID de la tâche (ou tâche racine pour cluster).'
            },
            source: {
                type: 'string',
                enum: ['roo', 'claude', 'all'],
                description: '[list/summarize] Source des conversations: "roo" (défaut, Roo Code), "claude" (Claude Code sessions), "all" (les deux).',
                default: 'roo'
            },
            filePath: {
                type: 'string',
                description: '[summarize] Chemin pour sauvegarder le fichier.'
            },
            summarize_output_format: {
                type: 'string',
                enum: ['markdown', 'html', 'json'],
                description: '[summarize] Format de sortie.',
                default: 'markdown'
            },
            detailLevel: {
                type: 'string',
                enum: ['Full', 'NoTools', 'NoResults', 'Messages', 'Summary', 'UserOnly'],
                description: '[summarize] Niveau de détail du résumé.',
                default: 'Full'
            },
            truncationChars: {
                type: 'number',
                description: '[summarize] Chars max avant troncature (0 = pas de troncature).',
                default: 0
            },
            compactStats: {
                type: 'boolean',
                description: '[summarize] Format compact pour les statistiques.',
                default: false
            },
            includeCss: {
                type: 'boolean',
                description: '[summarize] Inclure le CSS embarqué.',
                default: true
            },
            generateToc: {
                type: 'boolean',
                description: '[summarize] Générer la table des matières.',
                default: true
            },
            startIndex: {
                type: 'number',
                description: '[summarize] Index de début (1-based).'
            },
            endIndex: {
                type: 'number',
                description: '[summarize] Index de fin (1-based).'
            },
            childTaskIds: {
                type: 'array',
                items: { type: 'string' },
                description: '[summarize/cluster] IDs des tâches enfantes.'
            },
            clusterMode: {
                type: 'string',
                enum: ['aggregated', 'detailed', 'comparative'],
                description: '[summarize/cluster] Mode de clustering.',
                default: 'aggregated'
            },
            includeClusterStats: {
                type: 'boolean',
                description: '[summarize/cluster] Inclure les statistiques de grappe.',
                default: true
            },
            crossTaskAnalysis: {
                type: 'boolean',
                description: '[summarize/cluster] Activer l\'analyse cross-task.',
                default: false
            },
            maxClusterDepth: {
                type: 'number',
                description: '[summarize/cluster] Profondeur max de grappe.',
                default: 10
            },
            clusterSortBy: {
                type: 'string',
                enum: ['chronological', 'size', 'activity', 'alphabetical'],
                description: '[summarize/cluster] Critère de tri.',
                default: 'chronological'
            },
            includeClusterTimeline: {
                type: 'boolean',
                description: '[summarize/cluster] Inclure la timeline.',
                default: false
            },
            clusterTruncationChars: {
                type: 'number',
                description: '[summarize/cluster] Troncature spécifique aux grappes.',
                default: 0
            },
            showTaskRelationships: {
                type: 'boolean',
                description: '[summarize/cluster] Montrer les relations entre tâches.',
                default: true
            },
            // --- Arguments synthesis ---
            synthesis_output_format: {
                type: 'string',
                enum: ['json', 'markdown'],
                description: '[summarize/synthesis] Format de sortie pour la synthèse LLM. "json" retourne l\'analyse complète, "markdown" retourne la section narrative.',
                default: 'json'
            },
            // --- Arguments rebuild ---
            force_rebuild: {
                type: 'boolean',
                description: '[rebuild] Si true, reconstruit TOUS les squelettes (lent). Si false/omis, ne reconstruit que les manquants/obsolètes.',
                default: false
            },
            task_ids: {
                type: 'array',
                items: { type: 'string' },
                description: '[rebuild] Liste optionnelle d\'IDs de tâches spécifiques à reconstruire.'
            },
            sources: {
                type: 'array',
                items: { type: 'string', enum: ['roo', 'claude', 'archive'] },
                description: '[rebuild] #1244 Couche 1.4 — Sources de squelettes a charger. Defaut: ["roo"]. "claude" inclut les sessions Claude Code locales (Tier 2). "archive" inclut les archives cross-machine GDrive (Tier 3, requiert ROOSYNC_SHARED_PATH).'
            },
            reindex: {
                type: 'boolean',
                description: '[rebuild] #1244 Couche 1.4 — Si true, force l\'enqueue Qdrant pour tous les squelettes construits/charges (tous tiers).',
                default: false
            }
        },
        required: ['action']
    }
};

/**
 * Valide les arguments selon l'action demandée
 */
function validateArgs(args: ConversationBrowserArgs): void {
    if (!args.action) {
        throw new StateManagerError(
            'Le paramètre "action" est requis. Valeurs possibles: "list", "tree", "current", "view", "summarize".',
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
 * Handler consolidé pour l'outil conversation_browser
 *
 * @param args Arguments de l'outil
 * @param conversationCache Cache des conversations (pour tree/current/view)
 * @param ensureSkeletonCacheIsFresh Fonction de rafraîchissement du cache (pour tree/current)
 * @param contextWorkspace Workspace contexte (pour current)
 * @param getConversationSkeleton Getter de skeleton (pour summarize, avec disk fallback)
 * @param findChildTasks Finder de tâches enfantes (pour summarize cluster)
 */
export async function handleConversationBrowser(
    args: ConversationBrowserArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    ensureSkeletonCacheIsFresh: () => Promise<void>,
    contextWorkspace?: string,
    getConversationSkeleton?: (id: string) => Promise<ConversationSkeleton | null>,
    findChildTasks?: (rootId: string) => Promise<ConversationSkeleton[]>,
    serverState?: ServerState
): Promise<CallToolResult> {
    // #1262 — Hard timeout (default 30s, env-overridable).
    // The inner work runs unmodified; we just race it against a timer.
    const startedAt = Date.now();
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<CallToolResult>((_, reject) => {
        timeoutHandle = setTimeout(() => {
            reject(new Error(
                `conversation_browser TIMEOUT after ${CONVERSATION_BROWSER_TIMEOUT_MS}ms ` +
                `(action: ${args.action}). This is a BUG to report: list pagination or ` +
                `conversation detail must complete in <30s. Likely culprit: blocking ` +
                `ensureSkeletonCacheIsFresh() in src/index.ts (failsafe full rebuild or ` +
                `disk-scan storm). Workaround: disable force_refresh and retry; if it still ` +
                `blocks, restart the MCP server.`
            ));
        }, CONVERSATION_BROWSER_TIMEOUT_MS);
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
                        machineId: args.machineId
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

                // === Synthesis: LLM pipeline via SynthesisOrchestratorService ===
                // Enrichment methods implemented algorithmically (Phase 2, issue #767)
                if (args.summarize_type === 'synthesis') {
                    return await handleSynthesisAction(
                        resolvedTaskId,
                        args.synthesis_output_format || 'json',
                        args.filePath,
                        getConversationSkeleton
                    );
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
