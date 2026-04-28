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
    action: 'index' | 'reset' | 'rebuild' | 'diagnose' | 'archive' | 'status' | 'cleanup' | 'garbage_scan';

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

    /** #1658: Âge maximum en jours pour la rétention (pour action=cleanup). Défaut: 90 */
    max_age_days?: number;

    /** #1658: Filtre optionnel par workspace_name (pour action=cleanup) */
    workspace_name_filter?: string;

    /** #1244: Activer le diagnostic approfondi (scroll sample, distribution source/workspace) — pour action=diagnose */
    deep?: boolean;

    /** #1244: Taille de l'échantillon scroll (pour action=diagnose avec deep=true). Défaut 1000, max 5000 */
    sample_size?: number;

    /** #1244: Nombre de top workspaces à reporter (pour action=diagnose avec deep=true). Défaut 20, max 100 */
    top_n_workspaces?: number;

    /** #1786: Catégorie de garbage à scanner (pour action=garbage_scan) */
    garbage_category?: 'death_spiral' | 'duplicate' | 'low_value' | 'all';

    /** #1786: Nombre minimum de messages pour être scanné (pour action=garbage_scan). Défaut: 10 */
    min_messages?: number;

    /** #1786: Nombre max de résultats (pour action=garbage_scan). Défaut: 100 */
    max_results?: number;

    /** #1786: Supprimer les skeletons (pour action=garbage_scan avec dry_run=false). Défaut: true */
    remove_skeletons?: boolean;

    /** #1786: Supprimer les vecteurs Qdrant (pour action=garbage_scan avec dry_run=false). Défaut: true */
    remove_vectors?: boolean;
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
                enum: ['index', 'reset', 'rebuild', 'diagnose', 'archive', 'status', 'cleanup', 'garbage_scan'],
                description: "Action: 'index' (indexer une tâche dans Qdrant), 'reset' (réinitialiser la collection Qdrant), 'rebuild' (reconstruire l'index SQLite VS Code), 'diagnose' (diagnostic complet de l'index), 'archive' (archiver une tâche Roo ou les sessions Claude Code sur GDrive), 'status' (état du background indexer et métriques), 'cleanup' (supprimer les vecteurs plus anciens qu'un âge donné #1658), 'garbage_scan' (détecter/nettoyer les tâches garbage #1786)"
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
                description: 'Archiver les sessions Claude Code (pour action=archive) - DÉSACTIVÉ: sessions sanctuarisées #1621',
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
            max_age_days: {
                type: 'number',
                description: "#1658: Pour action=cleanup. Âge maximum en jours des vecteurs à conserver. Les vecteurs dont le timestamp est antérieur à (now - max_age_days) seront supprimés. Défaut: 90.",
                default: 90
            },
            workspace_name_filter: {
                type: 'string',
                description: "#1658: Pour action=cleanup. Filtre optionnel par workspace_name pour limiter le cleanup à un workspace spécifique."
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
            },
            garbage_category: {
                type: 'string',
                enum: ['death_spiral', 'duplicate', 'low_value', 'all'],
                description: "#1786: Pour action=garbage_scan. Catégorie de garbage à détecter. 'death_spiral' (erreurs en boucle), 'duplicate' (sessions dupliquées), 'low_value' (taux d'erreur élevé, quasi-zéro output assistant), 'all' (toutes). Défaut: all"
            },
            min_messages: {
                type: 'number',
                description: "#1786: Pour action=garbage_scan. Nombre minimum de messages pour qu'une tâche soit scannée. Défaut: 10.",
                default: 10
            },
            max_results: {
                type: 'number',
                description: "#1786: Pour action=garbage_scan. Nombre maximum de résultats retournés. Défaut: 100.",
                default: 100
            },
            remove_skeletons: {
                type: 'boolean',
                description: "#1786: Pour action=garbage_scan avec dry_run=false. Supprimer les fichiers skeleton garbage. Défaut: true.",
                default: true
            },
            remove_vectors: {
                type: 'boolean',
                description: "#1786: Pour action=garbage_scan avec dry_run=false. Supprimer les vecteurs Qdrant garbage. Défaut: true.",
                default: true
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

    if (!['index', 'reset', 'rebuild', 'diagnose', 'archive', 'status', 'cleanup', 'garbage_scan'].includes(args.action)) {
        return {
            isError: true,
            content: [{ type: 'text', text: `Action "${args.action}" invalide. Valeurs possibles: index, reset, rebuild, diagnose, archive, status, cleanup, garbage_scan` }]
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

            // GARDE-FOU SESSIONS SANCTUAIRE #1621
            // Les sessions Claude/Roo sont sanctuarisées pour RL futur - aucun archivage sans approbation explicite
            if (args.claude_code_sessions) {
                return {
                    isError: true,
                    content: [{
                        type: 'text',
                        text: 'ERREUR: Les sessions Claude Code sont SANCTUAIRES pour Reinforcement Learning futur. Aucun archivage ne peut être effectué sans approbation utilisateur explicite. Voir: #1621'
                    }]
                };
            }

            // Support pour l'archivage des sessions Claude Code (bloqué par le garde-fou ci-dessus)
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

        case 'cleanup': {
            const { cleanupOldVectors } = await import('../../services/task-indexer/VectorIndexer.js');
            const maxAgeDays = args.max_age_days || 90;
            const isDryRun = args.dry_run ?? false;

            try {
                const result = await cleanupOldVectors(maxAgeDays, isDryRun, args.workspace_name_filter);

                const mode = isDryRun ? '[DRY RUN]' : '[EXECUTED]';
                return {
                    isError: false,
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            action: 'cleanup',
                            mode: isDryRun ? 'dry_run' : 'executed',
                            max_age_days: maxAgeDays,
                            cutoff_date: result.cutoffDate,
                            workspace_filter: result.workspaceFilter || null,
                            vectors_affected: result.deletedCount,
                            summary: `${mode} ${result.deletedCount} vecteurs ${isDryRun ? 'seraient supprimés' : 'supprimés'} (antérieurs au ${result.cutoffDate})`
                        }, null, 2)
                    }]
                };
            } catch (error: any) {
                return {
                    isError: true,
                    content: [{
                        type: 'text',
                        text: `Erreur lors du cleanup: ${error.message}`
                    }]
                };
            }
        }

        case 'garbage_scan': {
            const { scanForGarbage, cleanupGarbage } = await import('./garbage-scanner.js');
            const isDryRun = args.dry_run !== false; // default true for safety

            try {
                // Phase 1: Scan
                const scanResult = await scanForGarbage(conversationCache, {
                    dry_run: isDryRun,
                    category: args.garbage_category || 'all',
                    min_messages: args.min_messages,
                    max_results: args.max_results,
                    remove_skeletons: args.remove_skeletons,
                    remove_vectors: args.remove_vectors
                });

                // Phase 2: Cleanup (only if dry_run=false)
                let cleanupResult = null;
                if (!isDryRun && scanResult.flagged.length > 0) {
                    cleanupResult = await cleanupGarbage(conversationCache, scanResult.flagged, {
                        dry_run: false,
                        remove_skeletons: args.remove_skeletons !== false,
                        remove_vectors: args.remove_vectors !== false,
                        category: args.garbage_category || 'all',
                        min_messages: args.min_messages,
                        max_results: args.max_results
                    });
                }

                const mode = isDryRun ? '[DRY RUN]' : '[EXECUTED]';
                const summary = isDryRun
                    ? `${mode} ${scanResult.flagged.length} tâches garbage détectées (scan seulement, aucun nettoyage)`
                    : `${mode} ${cleanupResult?.skeletons_removed || 0} skeletons supprimés, ~${cleanupResult?.vectors_deleted || 0} vecteurs retirés`;

                return {
                    isError: false,
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            action: 'garbage_scan',
                            mode: isDryRun ? 'dry_run' : 'executed',
                            scan: {
                                total_scanned: scanResult.total_scanned,
                                flagged_count: scanResult.flagged.length,
                                by_category: scanResult.by_category,
                                total_size_flagged: scanResult.total_size_flagged,
                                estimated_vectors_flagged: scanResult.estimated_vectors_flagged
                            },
                            cleanup: cleanupResult ? {
                                skeletons_removed: cleanupResult.skeletons_removed,
                                vectors_deleted: cleanupResult.vectors_deleted,
                                space_freed_bytes: cleanupResult.space_freed_bytes,
                                errors: cleanupResult.errors.length > 0 ? cleanupResult.errors : undefined
                            } : null,
                            top_flagged: scanResult.flagged.slice(0, 20).map(f => ({
                                task_id: f.task_id,
                                category: f.category,
                                score: f.score,
                                size: f.details.total_size,
                                messages: f.details.message_count,
                                assistant_ratio: f.details.assistant_ratio,
                                error_ratio: f.details.error_ratio,
                                death_spiral_count: f.details.death_spiral_count,
                                duplicate_group_size: f.details.duplicate_group_size
                            })),
                            summary
                        }, null, 2)
                    }]
                };
            } catch (error: any) {
                return {
                    isError: true,
                    content: [{
                        type: 'text',
                        text: `Erreur lors du garbage scan: ${error.message}\n${error.stack || ''}`
                    }]
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
