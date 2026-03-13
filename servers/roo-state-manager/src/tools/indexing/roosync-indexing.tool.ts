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
    action: 'index' | 'reset' | 'rebuild' | 'diagnose' | 'status' | 'archive';

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
}

/**
 * Définition du tool MCP roosync_indexing
 */
export const roosyncIndexingTool: Tool = {
    name: 'roosync_indexing',
    description: "Outil unifié de gestion de l'index sémantique, du cache et de l'archivage (indexation, reset, rebuild, diagnostic, status, archive Roo/Claude Code)",
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['index', 'reset', 'rebuild', 'diagnose', 'status', 'archive'],
                description: "Action: 'index' (indexer une tâche dans Qdrant), 'reset' (réinitialiser la collection Qdrant), 'rebuild' (reconstruire l'index SQLite VS Code), 'diagnose' (diagnostic complet de l'index), 'status' (état du background indexer), 'archive' (archiver une tâche Roo ou les sessions Claude Code sur GDrive)"
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
            }
        },
        required: ['action']
    }
};

/**
 * Handler unifié pour roosync_indexing
 * Dispatche vers le handler approprié selon l'action
 */
export async function handleRooSyncIndexing(
    args: RooSyncIndexingArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    ensureCacheFreshCallback: () => Promise<boolean>,
    saveSkeletonCallback: (skeleton: ConversationSkeleton) => Promise<void>,
    qdrantIndexQueue: Set<string>,
    setQdrantIndexingEnabled: (enabled: boolean) => void,
    rebuildHandler: (args: any) => Promise<CallToolResult>,
    // #685: Paramètres additionnels pour l'action status
    isQdrantIndexingEnabled?: boolean,
    qdrantIndexInterval?: NodeJS.Timeout | null,
    indexingMetrics?: { totalTasks: number; skippedTasks: number; indexedTasks: number; failedTasks: number; retryTasks: number; bandwidthSaved: number }
): Promise<CallToolResult> {
    // Validation de l'action
    if (!args.action) {
        return {
            isError: true,
            content: [{ type: 'text', text: 'Le paramètre "action" est requis. Valeurs possibles: index, reset, rebuild, diagnose, status, archive' }]
        };
    }

    if (!['index', 'reset', 'rebuild', 'diagnose', 'status', 'archive'].includes(args.action)) {
        return {
            isError: true,
            content: [{ type: 'text', text: `Action "${args.action}" invalide. Valeurs possibles: index, reset, rebuild, diagnose, status, archive` }]
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
            return await handleDiagnoseSemanticIndex(conversationCache);
        }

        case 'status': {
            // #685: Diagnostic de l'état du background indexer
            const now = Date.now();
            const report: Record<string, any> = {
                action: 'background_indexer_status',
                timestamp: new Date(now).toISOString(),
                machine: process.env.ROOSYNC_MACHINE_ID || 'unknown',
            };

            // État du background indexer
            report.enabled = isQdrantIndexingEnabled ?? false;
            report.intervalRunning = qdrantIndexInterval !== null && qdrantIndexInterval !== undefined;
            report.queueSize = qdrantIndexQueue?.size ?? 0;

            // Métriques d'indexation
            if (indexingMetrics) {
                report.metrics = {
                    totalTasks: indexingMetrics.totalTasks,
                    indexedTasks: indexingMetrics.indexedTasks,
                    skippedTasks: indexingMetrics.skippedTasks,
                    failedTasks: indexingMetrics.failedTasks,
                    retryTasks: indexingMetrics.retryTasks,
                    bandwidthSaved: Math.round(indexingMetrics.bandwidthSaved / 1024 / 1024) + 'MB'
                };
            }

            // Diagnostic de santé
            let health = 'UNKNOWN';
            let warnings: string[] = [];

            if (!isQdrantIndexingEnabled) {
                health = 'DISABLED';
                warnings.push('⚠️ L\'indexation background est DÉSACTIVÉE (isQdrantIndexingEnabled=false)');
            }

            if (!qdrantIndexInterval) {
                health = health === 'DISABLED' ? 'DISABLED' : 'NOT_RUNNING';
                warnings.push('⚠️ Aucun interval détecté (qdrantIndexInterval=null)');
            }

            if (qdrantIndexQueue && qdrantIndexQueue.size > 0) {
                warnings.push(`ℹ️ ${qdrantIndexQueue.size} tâches en attente dans la queue`);
            }

            if (warnings.length === 0 && isQdrantIndexingEnabled && qdrantIndexInterval) {
                health = 'HEALTHY';
            }

            report.health = health;
            if (warnings.length > 0) {
                report.warnings = warnings;
            }

            // Tâches dans la queue (limité à 10 pour lisibilité)
            if (qdrantIndexQueue && qdrantIndexQueue.size > 0) {
                const queueArray = Array.from(qdrantIndexQueue).slice(0, 10);
                report.queueSample = queueArray;
                if (qdrantIndexQueue.size > 10) {
                    report.queueSample.push(`... et ${qdrantIndexQueue.size - 10} autres`);
                }
            }

            return {
                isError: false,
                content: [{
                    type: 'text',
                    text: '## Background Indexer Status\n\n```\n' + JSON.stringify(report, null, 2) + '\n```\n\n' +
                        `**Santé:** ${health}\n\n` +
                        (warnings.length > 0 ? warnings.join('\n') + '\n\n' : '') +
                        `**Actions recommandées:**\n` +
                        (health === 'HEALTHY' ? '- ✅ Le système fonctionne normalement\n' : '') +
                        (health === 'DISABLED' ? '- Vérifier pourquoi l\'indexation a été désactivée\n' : '') +
                        (health === 'NOT_RUNNING' ? '- Le processus d\'indexation ne tourne pas, vérifier les logs MCP\n' : '') +
                        (report.queueSize > 0 ? `- Traiter les ${report.queueSize} tâches en attente\n` : '')
                }]
            };
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

        default:
            return {
                isError: true,
                content: [{ type: 'text', text: `Action non supportée: ${(args as any).action}` }]
            };
    }
}
