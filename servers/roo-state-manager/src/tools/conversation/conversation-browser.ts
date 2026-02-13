/**
 * Outil MCP consolidé : conversation_browser
 * CONS-X (#457) : Consolide task_browse + view_conversation_tree + roosync_summarize → 1 outil
 *
 * Actions disponibles :
 * - 'tree'      : Vue arborescente des tâches (anciennement task_browse action=tree)
 * - 'current'   : Tâche actuellement active (anciennement task_browse action=current)
 * - 'view'      : Vue arborescente d'une conversation (anciennement view_conversation_tree)
 * - 'summarize' : Résumé/synthèse de conversation (anciennement roosync_summarize)
 *
 * Changement tool count : -2 (3 outils → 1 dans ListTools)
 * Backward compat : Les 3 anciens noms restent fonctionnels via CallTool dans registry.ts
 */

import { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { StateManagerError } from '../../types/errors.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { handleTaskBrowse, TaskBrowseArgs } from '../task/browse.js';
import { viewConversationTree } from '../view-conversation-tree.js';
import { handleRooSyncSummarize, RooSyncSummarizeArgs } from '../summary/roosync-summarize.tool.js';

/**
 * Type union pour les actions supportées
 */
export type ConversationBrowserAction = 'tree' | 'current' | 'view' | 'summarize';

/**
 * Arguments pour l'outil conversation_browser
 * Combine tous les paramètres des 3 outils originaux
 */
export interface ConversationBrowserArgs {
    /** Action à effectuer */
    action: ConversationBrowserAction;

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
    /** [view] Activer la troncature intelligente */
    smart_truncation?: boolean;
    /** [view] Configuration troncature intelligente */
    smart_truncation_config?: {
        gradientStrength?: number;
        minPreservationRate?: number;
        maxTruncationRate?: number;
    };
    /** [view] Chemin pour sauvegarder l'arbre */
    output_file?: string;

    // ===== Arguments pour action='summarize' (via roosync_summarize) =====
    /** [summarize] Type de résumé (requis si action='summarize') */
    summarize_type?: 'trace' | 'cluster' | 'synthesis';
    /** [summarize] ID de la tâche (alias pour task_id en contexte summarize) */
    taskId?: string;
    /** [summarize] Source des conversations */
    source?: 'roo' | 'claude';
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
}

/**
 * Définition de l'outil conversation_browser
 */
export const conversationBrowserTool: Tool = {
    name: 'conversation_browser',
    description: 'Outil consolidé pour naviguer, visualiser et résumer les conversations. Actions: "tree" (arbre des tâches), "current" (tâche active), "view" (vue conversation), "summarize" (résumé/synthèse).',
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['tree', 'current', 'view', 'summarize'],
                description: 'Action à effectuer.'
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
            // --- Arguments view ---
            task_id: {
                type: 'string',
                description: '[view] ID de la tâche de départ.'
            },
            view_mode: {
                type: 'string',
                enum: ['single', 'chain', 'cluster'],
                description: '[view] Mode d\'affichage.',
                default: 'chain'
            },
            detail_level: {
                type: 'string',
                enum: ['skeleton', 'summary', 'full'],
                description: '[view] Niveau de détail.',
                default: 'skeleton'
            },
            truncate: {
                type: 'number',
                description: '[view] Lignes à conserver au début/fin (0 = défaut intelligent).',
                default: 0
            },
            max_output_length: {
                type: 'number',
                description: '[view] Limite max de caractères en sortie.',
                default: 300000
            },
            smart_truncation: {
                type: 'boolean',
                description: '[view] Activer la troncature intelligente avec gradient.',
                default: false
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
            output_file: {
                type: 'string',
                description: '[view] Chemin pour sauvegarder l\'arbre dans un fichier.'
            },
            // --- Arguments summarize ---
            summarize_type: {
                type: 'string',
                enum: ['trace', 'cluster', 'synthesis'],
                description: '[summarize] Type de résumé (requis si action=summarize).'
            },
            taskId: {
                type: 'string',
                description: '[summarize] ID de la tâche (ou tâche racine pour cluster).'
            },
            source: {
                type: 'string',
                enum: ['roo', 'claude'],
                description: '[summarize] Source des conversations.',
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
            'Le paramètre "action" est requis. Valeurs possibles: "tree", "current", "view", "summarize".',
            'VALIDATION_FAILED',
            'ConversationBrowserTool',
            { providedArgs: Object.keys(args) }
        );
    }

    const validActions: ConversationBrowserAction[] = ['tree', 'current', 'view', 'summarize'];
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
    findChildTasks?: (rootId: string) => Promise<ConversationSkeleton[]>
): Promise<CallToolResult> {
    try {
        validateArgs(args);

        switch (args.action) {
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
                        output_file: args.output_file
                    },
                    conversationCache
                );
            }

            case 'summarize': {
                // Résoudre taskId depuis taskId ou task_id
                const resolvedTaskId = (args.taskId || args.task_id)!;

                const summarizeArgs: RooSyncSummarizeArgs = {
                    type: args.summarize_type!,
                    taskId: resolvedTaskId,
                    source: args.source,
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
