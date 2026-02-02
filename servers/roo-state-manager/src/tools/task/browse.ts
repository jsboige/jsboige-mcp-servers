/**
 * Outil MCP consolidé : task_browse
 * CONS-9 : Consolide get_task_tree + get_current_task
 *
 * Actions disponibles :
 * - 'tree' : Récupère une vue arborescente des tâches (anciennement get_task_tree)
 * - 'current' : Récupère la tâche actuellement active (anciennement get_current_task)
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { StateManagerError } from '../../types/errors.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { handleGetTaskTree, GetTaskTreeArgs } from './get-tree.tool.js';
import { getCurrentTaskTool } from './get-current-task.tool.js';

/**
 * Type union pour les actions supportées
 */
export type TaskBrowseAction = 'tree' | 'current';

/**
 * Arguments pour l'outil task_browse
 */
export interface TaskBrowseArgs {
    /** Action à effectuer : 'tree' ou 'current' */
    action: TaskBrowseAction;

    // Arguments pour action='tree' (GetTaskTreeArgs)
    /** ID de la conversation (requis si action='tree') */
    conversation_id?: string;
    /** Profondeur maximale de l'arbre */
    max_depth?: number;
    /** Inclure les tâches sœurs */
    include_siblings?: boolean;
    /** Format de sortie */
    output_format?: 'json' | 'markdown' | 'ascii-tree' | 'hierarchical';
    /** ID de la tâche en cours pour marquage */
    current_task_id?: string;
    /** Longueur max de l'instruction (défaut: 80) */
    truncate_instruction?: number;
    /** Afficher les métadonnées détaillées */
    show_metadata?: boolean;

    // Arguments pour action='current'
    /** Chemin du workspace (détection auto si omis) */
    workspace?: string;
}

/**
 * Définition de l'outil task_browse
 */
export const taskBrowseTool = {
    name: 'task_browse',
    description: 'Outil consolidé pour naviguer dans les tâches. Actions: "tree" (arbre hiérarchique), "current" (tâche active).',
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['tree', 'current'],
                description: 'Action à effectuer: "tree" pour l\'arbre des tâches, "current" pour la tâche active.'
            },
            // Arguments pour action='tree'
            conversation_id: {
                type: 'string',
                description: '[tree] ID de la conversation pour laquelle récupérer l\'arbre des tâches.'
            },
            max_depth: {
                type: 'number',
                description: '[tree] Profondeur maximale de l\'arbre à retourner.'
            },
            include_siblings: {
                type: 'boolean',
                description: '[tree] Inclure les tâches sœurs (même parent) dans l\'arbre.',
                default: true
            },
            output_format: {
                type: 'string',
                enum: ['json', 'markdown', 'ascii-tree', 'hierarchical'],
                description: '[tree] Format de sortie: json (défaut), markdown, ascii-tree, ou hierarchical.',
                default: 'json'
            },
            current_task_id: {
                type: 'string',
                description: '[tree] ID de la tâche en cours d\'exécution pour marquage explicite.'
            },
            truncate_instruction: {
                type: 'number',
                description: '[tree] Longueur maximale de l\'instruction affichée (défaut: 80).',
                default: 80
            },
            show_metadata: {
                type: 'boolean',
                description: '[tree] Afficher les métadonnées détaillées (défaut: false).',
                default: false
            },
            // Arguments pour action='current'
            workspace: {
                type: 'string',
                description: '[current] Chemin du workspace (détection auto si omis).'
            }
        },
        required: ['action']
    }
};

/**
 * Valide les arguments selon l'action demandée
 */
function validateArgs(args: TaskBrowseArgs): void {
    if (!args.action) {
        throw new StateManagerError(
            'Le paramètre "action" est requis. Valeurs possibles: "tree", "current".',
            'VALIDATION_FAILED',
            'TaskBrowseTool',
            { providedArgs: Object.keys(args) }
        );
    }

    if (!['tree', 'current'].includes(args.action)) {
        throw new StateManagerError(
            `Action invalide: "${args.action}". Valeurs possibles: "tree", "current".`,
            'INVALID_ACTION',
            'TaskBrowseTool',
            { action: args.action }
        );
    }

    if (args.action === 'tree' && !args.conversation_id) {
        throw new StateManagerError(
            'Le paramètre "conversation_id" est requis pour l\'action "tree".',
            'VALIDATION_FAILED',
            'TaskBrowseTool',
            { action: args.action, missingParam: 'conversation_id' }
        );
    }
}

/**
 * Handler pour l'outil task_browse
 */
export async function handleTaskBrowse(
    args: TaskBrowseArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    ensureSkeletonCacheIsFresh: () => Promise<void>,
    contextWorkspace?: string
): Promise<CallToolResult> {
    try {
        // Validation des arguments
        validateArgs(args);

        switch (args.action) {
            case 'tree': {
                // Délègue à handleGetTaskTree
                const treeArgs: GetTaskTreeArgs = {
                    conversation_id: args.conversation_id!,
                    max_depth: args.max_depth,
                    include_siblings: args.include_siblings,
                    output_format: args.output_format,
                    current_task_id: args.current_task_id,
                    truncate_instruction: args.truncate_instruction,
                    show_metadata: args.show_metadata
                };
                return await handleGetTaskTree(treeArgs, conversationCache, ensureSkeletonCacheIsFresh);
            }

            case 'current': {
                // Délègue à getCurrentTaskTool.handler
                return await getCurrentTaskTool.handler(
                    { workspace: args.workspace },
                    conversationCache,
                    contextWorkspace,
                    ensureSkeletonCacheIsFresh
                );
            }

            default:
                // Ne devrait jamais arriver après validation
                throw new StateManagerError(
                    `Action non supportée: ${args.action}`,
                    'UNSUPPORTED_ACTION',
                    'TaskBrowseTool',
                    { action: args.action }
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
            content: [{ type: 'text', text: `Erreur lors de task_browse: ${errorMessage}` }],
            isError: true
        };
    }
}
