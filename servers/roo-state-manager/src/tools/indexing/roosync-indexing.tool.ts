/**
 * MCP Tool unifié pour les opérations d'indexation RooSync
 *
 * CONS-11: Consolidation Search/Indexing
 * - Remplace: index_task_semantic, reset_qdrant_collection, rebuild_task_index, diagnose_semantic_index
 * - Approche: Action-based dispatcher
 *
 * @version 1.0.0
 * @author CONS-11 Implementation
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import * as path from 'path';

// Import des handlers existants
import { indexTaskSemanticTool } from './index-task.tool.js';
import { resetQdrantCollectionTool } from './reset-collection.tool.js';
import { handleDiagnoseSemanticIndex } from './diagnose-index.tool.js';

/**
 * Arguments du tool roosync_indexing unifié
 */
export interface RooSyncIndexingArgs {
    /** Action d'indexation */
    action: 'index' | 'reset' | 'rebuild' | 'diagnose' | 'archive' | 'status';

    /** ID de la tâche à indexer (requis pour action=index) */
    task_id?: string;

    /** Confirmation pour reset (requis pour action=reset) */
    confirm?: boolean;

    /** Filtre par workspace (pour action=rebuild) */
    workspace_filter?: string;

    /** Nombre max de tâches (pour action=rebuild) */
    max_tasks?: number;

    /** Mode simulation (pour action=rebuild) */
    dry_run?: boolean;

    /** Filtre par machine (pour action=archive sans task_id) */
    machine_id?: string;

    /** Archiver les sessions Claude Code (pour action=archive) */
    claude_code_sessions?: boolean;

    /** Nombre max de sessions Claude Code à archiver (pour action=archive avec claude_code_sessions=true) */
    max_sessions?: number;

    /** #604: Source de la conversation (pour action=index, détermine l'extracteur de chunks) */
    source?: 'roo' | 'claude-code';

    /** #1244: Activer le diagnostic approfondi (scroll sample, distribution source/workspace) — pour action=diagnose */
    deep?: boolean;

    /** #1244: Taille de l'échantillon scroll (pour action=diagnose avec deep=true). Défaut 1000, max 5000 */
    sample_size?: number;

    /** #1244: Nombre de top workspaces à reporter (pour action=diagnose avec deep=true). Défaut 20, max 100 */
    top_n_workspaces?: number;
}

/**
 * Définition du tool MCP roosync_indexing
 */
export const roosyncIndexingTool: Tool = {
    name: 'roosync_indexing',
    description: "Outil unifié de gestion de l'index sémantique, du cache et de l'archivage (indexation, reset, rebuild, diagnostic, archive Roo/Claude Code)",
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['index', 'reset', 'rebuild', 'diagnose', 'archive', 'status'],
                description: "Action: 'index' (indexer une tâche dans Qdrant), 'reset' (réinitialiser la collection Qdrant), 'rebuild' (reconstruire l'index SQLite VS Code), 'diagnose' (diagnostic complet de l'index), 'archive' (archiver une tâche Roo ou les sessions Claude Code sur GDrive), 'status' (état du background indexer et métriques)"
            },
            task_id: {
                type: 'string',
                description: 'ID de la tâche à indexer (requis pour action=index)'
            },
            confirm: {
                type: 'boolean',
                description: 'Confirmation obligatoire pour action=reset',
                default: false
            },
            workspace_filter: {
                type: 'string',
                description: 'Filtre optionnel par workspace (pour action=rebuild)'
            },
            max_tasks: {
                type: 'number',
                description: 'Nombre maximum de tâches à traiter (pour action=rebuild, 0 = toutes)',
                default: 0
            },
            dry_run: {
                type: 'boolean',
                description: 'Mode simulation sans modification (pour action=rebuild)',
                default: false
            },
            machine_id: {
                type: 'string',
                description: 'Filtre par machine (pour action=archive, liste les archives de cette machine uniquement)'
            },
            claude_code_sessions: {
                type: 'boolean',
                description: 'Archiver les sessions Claude Code (pour action=archive)',
                default: false
            },
            max_sessions: {
                type: 'number',
                description: 'Nombre max de sessions Claude Code à archiver (pour action=archive avec claude_code_sessions=true, 0 = toutes)',
                default: 0
            },
            source: {
                type: 'string',
                enum: ['roo', 'claude-code'],
                description: "#604: Source de la conversation (pour action=index). 'roo' = tâche Roo standard, 'claude-code' = session Claude Code JSONL. Par défaut: 'roo'"
            },
            deep: {
                type: 'boolean',
                description: "#1244: Pour action=diagnose. Active le diagnostic approfondi (scroll d'un échantillon, distribution source/workspace_name, field coverage, payload samples). Permet de détecter les bugs d'indexation (champs manquants, dimension mismatch).",
                default: false
            },
            sample_size: {
                type: 'number',
                description: "#1244: Pour action=diagnose avec deep=true. Taille de l'échantillon Qdrant à scroll. Défaut 1000, max 5000.",
                default: 1000
            },
            top_n_workspaces: {
                type: 'number',
                description: "#1244: Pour action=diagnose avec deep=true. Nombre de top workspace_name à reporter dans la distribution. Défaut 20, max 100.",
                default: 20
            }
        },
        required: ['action']
    }
};

/**
 * Handler unifié pour roosync_indexing
 * Dispatche vers le handler approprié selon l'action
 */
export interface IndexingState {
    qdrantIndexQueue: Set<string>;
    qdrantIndexInterval: NodeJS.Timeout | null;
    isQdrantIndexingEnabled: boolean;
    indexingMetrics: {
        totalTasks: number;
        skippedTasks: number;
        indexedTasks: number;
        failedTasks: number;
        retryTasks: number;
        bandwidthSaved: number;
    };
}

export async function handleRooSyncIndexing(
    args: RooSyncIndexingArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    ensureCacheFreshCallback: () => Promise<boolean>,
    saveSkeletonCallback: (skeleton: ConversationSkeleton) => Promise<void>,
    qdrantIndexQueue: Set<string>,
    setQdrantIndexingEnabled: (enabled: boolean) => void,
    rebuildHandler: (args: any) => Promise<CallToolResult>,
    indexingState?: IndexingState
): Promise<CallToolResult> {
    // Validation de l'action
    if (!args.action) {
        return {
            isError: true,
            content: [{ type: 'text', text: 'Le paramètre "action" est requis. Valeurs possibles: index, reset, rebuild, diagnose, archive, status' }]
        };
    }

    if (!['index', 'reset', 'rebuild', 'diagnose', 'archive', 'status'].includes(args.action)) {
        return {
            isError: true,
            content: [{ type: 'text', text: `Action "${args.action}" invalide. Valeurs possibles: index, reset, rebuild, diagnose, archive, status` }]
        };
    }

    switch (args.action) {
        case 'index': {
            if (!args.task_id) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'Le paramètre "task_id" est requis pour action=index' }]
                };
            }
            return await indexTaskSemanticTool.handler(
                { task_id: args.task_id, source: args.source },
                conversationCache,
                ensureCacheFreshCallback
            );
        }

        case 'reset': {
            return await resetQdrantCollectionTool.handler(
                { confirm: args.confirm },
                conversationCache,
                saveSkeletonCallback,
                qdrantIndexQueue,
                setQdrantIndexingEnabled
            );
        }

        case 'rebuild': {
            return await rebuildHandler({
                workspace_filter: args.workspace_filter,
                max_tasks: args.max_tasks,
                dry_run: args.dry_run
            });
        }

        case 'diagnose': {
            return await handleDiagnoseSemanticIndex(conversationCache, {
                deep: args.deep,
                sample_size: args.sample_size,
                top_n_workspaces: args.top_n_workspaces,
            });
        }

        case 'archive': {
            const { TaskArchiver } = await import('../../services/task-archiver/index.js');
            const { RooStorageDetector } = await import('../../utils/roo-storage-detector.js');

            // Support pour l'archivage des sessions Claude Code
            if (args.claude_code_sessions) {
                const os = await import('os');
                const claudeProjectsPath = path.join(os.homedir(), '.claude', 'projects');
                const result = await TaskArchiver.archiveClaudeCodeSessions(
                    claudeProjectsPath,
                    args.max_sessions || 0
                );
                return {
                    isError: false,
                    content: [{
                        type: 'text',
                        text: `Sessions Claude Code archivées: ${result.archived} réussies, ${result.failed} échecs`
                    }]
                };
            }

            // Archivage de tâches Roo existant
            if (args.task_id) {
                // Archiver une tache specifique
                const conversation = await RooStorageDetector.findConversationById(args.task_id);
                if (!conversation) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Tâche ${args.task_id} non trouvée localement` }]
                    };
                }
                const skeleton = conversationCache.get(args.task_id);
                if (!skeleton) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Squelette de la tâche ${args.task_id} non trouvé dans le cache` }]
                    };
                }
                await TaskArchiver.archiveTask(args.task_id, conversation.path, skeleton);
                return {
                    isError: false,
                    content: [{ type: 'text', text: `Tâche ${args.task_id} archivée avec succès sur GDrive` }]
                };
            } else {
                // Lister les archives
                const taskIds = await TaskArchiver.listArchivedTasks(args.machine_id);
                return {
                    isError: false,
                    content: [{ type: 'text', text: JSON.stringify({
                        action: 'archive_list',
                        machine_filter: args.machine_id || 'all',
                        total: taskIds.length,
                        task_ids: taskIds.slice(0, 100)
                    }, null, 2) }]
                };
            }
        }

        case 'status': {
            const state = indexingState || {
                qdrantIndexQueue,
                qdrantIndexInterval: null,
                isQdrantIndexingEnabled: false,
                indexingMetrics: { totalTasks: 0, skippedTasks: 0, indexedTasks: 0, failedTasks: 0, retryTasks: 0, bandwidthSaved: 0 }
            };
            // Diagnostic hints
            const hints: string[] = [];
            if (!state.isQdrantIndexingEnabled) {
                hints.push('Indexation Qdrant désactivée. Vérifiez les variables d\'environnement: QDRANT_URL, QDRANT_API_KEY, EMBEDDING_API_KEY');
            }
            if (state.qdrantIndexQueue.size > 0 && !state.qdrantIndexInterval) {
                hints.push('Queue non vide mais worker non démarré. Le serveur MCP peut ne pas avoir initialisé les services background.');
            }
            if (state.indexingMetrics.failedTasks > 0) {
                hints.push(`${state.indexingMetrics.failedTasks} tâches en échec permanent. Utilisez action: "diagnose" pour plus de détails.`);
            }

            const status = {
                background_indexer: {
                    is_running: state.qdrantIndexInterval !== null,
                    is_enabled: state.isQdrantIndexingEnabled,
                    queue_size: state.qdrantIndexQueue.size,
                    metrics: {
                        total_tasks: state.indexingMetrics.totalTasks,
                        indexed: state.indexingMetrics.indexedTasks,
                        skipped: state.indexingMetrics.skippedTasks,
                        failed: state.indexingMetrics.failedTasks,
                        retry: state.indexingMetrics.retryTasks,
                        bandwidth_saved_bytes: state.indexingMetrics.bandwidthSaved
                    }
                },
                diagnostic_hints: hints.length > 0 ? hints : undefined
            };
            return {
                isError: false,
                content: [{ type: 'text', text: JSON.stringify(status, null, 2) }]
            };
        }

        default:
            return {
                isError: true,
                content: [{ type: 'text', text: `Action non supportée: ${(args as any).action}` }]
            };
    }
}
