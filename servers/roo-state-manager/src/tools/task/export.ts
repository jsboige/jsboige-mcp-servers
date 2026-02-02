/**
 * Outil MCP consolidé : task_export
 * CONS-9 : Consolide export_task_tree_markdown + debug_task_parsing
 *
 * Actions disponibles :
 * - 'markdown' : Exporte l'arbre des tâches vers fichier markdown (anciennement export_task_tree_markdown)
 * - 'debug' : Analyse le parsing d'une tâche pour diagnostic (anciennement debug_task_parsing)
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { StateManagerError } from '../../types/errors.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { handleExportTaskTreeMarkdown, ExportTaskTreeMarkdownArgs } from './export-tree-md.tool.js';
import { handleDebugTaskParsing, DebugTaskParsingArgs } from './debug-parsing.tool.js';
import { handleGetTaskTree } from './get-tree.tool.js';

/**
 * Type union pour les actions supportées
 */
export type TaskExportAction = 'markdown' | 'debug';

/**
 * Arguments pour l'outil task_export
 */
export interface TaskExportArgs {
    /** Action à effectuer : 'markdown' ou 'debug' */
    action: TaskExportAction;

    // Arguments pour action='markdown' (ExportTaskTreeMarkdownArgs)
    /** ID de la conversation (requis si action='markdown') */
    conversation_id?: string;
    /** Chemin fichier sortie (optionnel) */
    filePath?: string;
    /** Profondeur maximale de l'arbre */
    max_depth?: number;
    /** Inclure les tâches sœurs */
    include_siblings?: boolean;
    /** ID de la tâche en cours pour marquage */
    current_task_id?: string;
    /** Format de sortie */
    output_format?: 'ascii-tree' | 'markdown' | 'hierarchical' | 'json';
    /** Longueur max de l'instruction (défaut: 80) */
    truncate_instruction?: number;
    /** Afficher les métadonnées détaillées */
    show_metadata?: boolean;

    // Arguments pour action='debug'
    /** ID de la tâche à analyser (requis si action='debug') */
    task_id?: string;
}

/**
 * Définition de l'outil task_export
 */
export const taskExportTool = {
    name: 'task_export',
    description: 'Outil consolidé pour exporter/diagnostiquer les tâches. Actions: "markdown" (export fichier), "debug" (diagnostic parsing).',
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['markdown', 'debug'],
                description: 'Action à effectuer: "markdown" pour exporter l\'arbre, "debug" pour diagnostiquer le parsing.'
            },
            // Arguments pour action='markdown'
            conversation_id: {
                type: 'string',
                description: '[markdown] ID de la conversation pour laquelle exporter l\'arbre des tâches.'
            },
            filePath: {
                type: 'string',
                description: '[markdown] Chemin optionnel pour sauvegarder le fichier. Si omis, le contenu est retourné.'
            },
            max_depth: {
                type: 'number',
                description: '[markdown] Profondeur maximale de l\'arbre à inclure dans l\'export.'
            },
            include_siblings: {
                type: 'boolean',
                description: '[markdown] Inclure les tâches sœurs (même parent) dans l\'arbre.',
                default: true
            },
            output_format: {
                type: 'string',
                enum: ['ascii-tree', 'markdown', 'hierarchical', 'json'],
                description: '[markdown] Format de sortie: ascii-tree (défaut), markdown, hierarchical, ou json.',
                default: 'ascii-tree'
            },
            current_task_id: {
                type: 'string',
                description: '[markdown] ID de la tâche en cours d\'exécution pour marquage explicite.'
            },
            truncate_instruction: {
                type: 'number',
                description: '[markdown] Longueur maximale de l\'instruction affichée (défaut: 80).',
                default: 80
            },
            show_metadata: {
                type: 'boolean',
                description: '[markdown] Afficher les métadonnées détaillées (défaut: false).',
                default: false
            },
            // Arguments pour action='debug'
            task_id: {
                type: 'string',
                description: '[debug] ID de la tâche à analyser en détail.'
            }
        },
        required: ['action']
    }
};

/**
 * Valide les arguments selon l'action demandée
 */
function validateArgs(args: TaskExportArgs): void {
    if (!args.action) {
        throw new StateManagerError(
            'Le paramètre "action" est requis. Valeurs possibles: "markdown", "debug".',
            'VALIDATION_FAILED',
            'TaskExportTool',
            { providedArgs: Object.keys(args) }
        );
    }

    if (!['markdown', 'debug'].includes(args.action)) {
        throw new StateManagerError(
            `Action invalide: "${args.action}". Valeurs possibles: "markdown", "debug".`,
            'INVALID_ACTION',
            'TaskExportTool',
            { action: args.action }
        );
    }

    if (args.action === 'markdown' && !args.conversation_id) {
        throw new StateManagerError(
            'Le paramètre "conversation_id" est requis pour l\'action "markdown".',
            'VALIDATION_FAILED',
            'TaskExportTool',
            { action: args.action, missingParam: 'conversation_id' }
        );
    }

    if (args.action === 'debug' && !args.task_id) {
        throw new StateManagerError(
            'Le paramètre "task_id" est requis pour l\'action "debug".',
            'VALIDATION_FAILED',
            'TaskExportTool',
            { action: args.action, missingParam: 'task_id' }
        );
    }
}

/**
 * Handler pour l'outil task_export
 */
export async function handleTaskExport(
    args: TaskExportArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    ensureSkeletonCacheIsFresh: () => Promise<void>
): Promise<CallToolResult> {
    try {
        // Validation des arguments
        validateArgs(args);

        switch (args.action) {
            case 'markdown': {
                // Délègue à handleExportTaskTreeMarkdown
                const exportArgs: ExportTaskTreeMarkdownArgs = {
                    conversation_id: args.conversation_id!,
                    filePath: args.filePath,
                    max_depth: args.max_depth,
                    include_siblings: args.include_siblings,
                    current_task_id: args.current_task_id,
                    output_format: args.output_format,
                    truncate_instruction: args.truncate_instruction,
                    show_metadata: args.show_metadata
                };

                // Créer le handler handleGetTaskTree wrapper pour passer à handleExportTaskTreeMarkdown
                const wrappedHandleGetTaskTree = async (treeArgs: any) => {
                    return await handleGetTaskTree(treeArgs, conversationCache, ensureSkeletonCacheIsFresh);
                };

                return await handleExportTaskTreeMarkdown(
                    exportArgs,
                    wrappedHandleGetTaskTree,
                    ensureSkeletonCacheIsFresh,
                    conversationCache
                );
            }

            case 'debug': {
                // Délègue à handleDebugTaskParsing
                const debugArgs: DebugTaskParsingArgs = {
                    task_id: args.task_id!
                };
                return await handleDebugTaskParsing(debugArgs);
            }

            default:
                // Ne devrait jamais arriver après validation
                throw new StateManagerError(
                    `Action non supportée: ${args.action}`,
                    'UNSUPPORTED_ACTION',
                    'TaskExportTool',
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
            content: [{ type: 'text', text: `Erreur lors de task_export: ${errorMessage}` }],
            isError: true
        };
    }
}
