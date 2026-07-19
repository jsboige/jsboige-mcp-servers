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
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { getSharedStatePath } from '../../utils/shared-state-path.js';

/** #2336 D1: Convert ISO timestamp to YYYY-WNN week key */
function getISOWeek(timestamp: string): string {
    const d = new Date(timestamp);
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Normalize a raw tool name from a JSONL tool_use block into a canonical key.
 *
 * The same tool is recorded under different prefixes across sources:
 *   - `mcp__<server>__<tool>` (Claude Code, double-underscore)
 *   - `mcp--<server>--<tool>` (double-dash variant)
 *   - `<tool>` (bare name, typically malformed/failed calls)
 * Without normalization, tool_usage_stats counted each variant as a distinct
 * tool, fragmenting totals and inflating unique_tools (~103 vs ~15 real).
 * Fix for #2336 (reported ai-01 2026-06-10).
 *
 * Splits on the prefix separator and returns the final segment (the tool name),
 * which is robust to server names containing the separator char (e.g. `4_5v_mcp`).
 * Bare names and built-in tools (Bash, Read, …) pass through unchanged.
 */
export function normalizeToolName(rawName: string): string {
    const name = rawName.trim();
    if (name.startsWith('mcp__')) {
        const parts = name.split('__');
        return parts[parts.length - 1] || name;
    }
    if (name.startsWith('mcp--')) {
        const parts = name.split('--');
        return parts[parts.length - 1] || name;
    }
    return name;
}

/**
 * Arguments du tool roosync_indexing unifié
 */
export interface RooSyncIndexingArgs {
    /** Action d'indexation */
    action: 'index' | 'reset' | 'rebuild' | 'diagnose' | 'archive' | 'status' | 'cleanup' | 'garbage_scan' | 'cleanup_orphans' | 'repair_gaps' | 'tool_usage_stats' | 'save_snapshot' | 'trend_report';

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

    /** #1821: Confirmation pour suppression orphelins (requis pour action=cleanup_orphans avec dry_run=false). Défaut: false */
    confirm_orphan_cleanup?: boolean;

    /** #2246: Max tasks to repair per call (pour action=repair_gaps). Défaut: 50 */
    max_repair_tasks?: number;

    /** #2336 D1: Start date for tool_usage_stats (ISO 8601 or YYYY-MM-DD). Default: 4 weeks ago */
    start_date?: string;

    /** #2336 D1: End date for tool_usage_stats (ISO 8601 or YYYY-MM-DD). Default: now */
    end_date?: string;
}

/**
 * Définition du tool MCP roosync_indexing
 */
export const roosyncIndexingTool: Tool = {
    name: 'roosync_indexing',
    description: 'Manage semantic index, cache, and archiving (index, reset, rebuild, diagnose, archive, status, cleanup, garbage_scan, cleanup_orphans, repair_gaps)',
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['index', 'reset', 'rebuild', 'diagnose', 'archive', 'status', 'cleanup', 'garbage_scan', 'cleanup_orphans', 'repair_gaps', 'tool_usage_stats', 'save_snapshot', 'trend_report'],
                description: 'Action: index (Qdrant), reset (collection), rebuild (SQLite index), diagnose (health check), archive (GDrive), status (metrics), cleanup (old vectors), garbage_scan (detect junk), cleanup_orphans (remove orphaned vectors), repair_gaps (detect and fix missing/stale index entries), tool_usage_stats (fleet-wide tool usage aggregation), save_snapshot (persist weekly stats to shared storage), trend_report (compare snapshots with ↑/↓ arrows)'
            },
            task_id: {
                type: 'string',
                description: 'Task ID to index (required for action=index)'
            },
            confirm: {
                type: 'boolean',
                description: 'Required confirmation for action=reset',
                default: false
            },
            workspace_filter: {
                type: 'string',
                description: 'Workspace filter (for rebuild)'
            },
            max_tasks: {
                type: 'number',
                description: 'Max tasks to process (for rebuild, 0 = all)',
                default: 0
            },
            dry_run: {
                type: 'boolean',
                description: 'Simulation mode (for rebuild, garbage_scan, cleanup_orphans)',
                default: false
            },
            machine_id: {
                type: 'string',
                description: 'Machine filter (for archive, list archives for this machine)'
            },
            claude_code_sessions: {
                type: 'boolean',
                description: 'Archive Claude Code sessions (BLOCKED - sessions are sanctuary).',
                default: false
            },
            max_sessions: {
                type: 'number',
                description: 'Max Claude Code sessions to archive (0 = all).',
                default: 0
            },
            source: {
                type: 'string',
                enum: ['roo', 'claude-code'],
                description: 'Conversation source for action=index. "roo" (default) or "claude-code".'
            },
            max_age_days: {
                type: 'number',
                description: 'For cleanup. Max age in days of vectors to keep (default: 90).',
                default: 90
            },
            workspace_name_filter: {
                type: 'string',
                description: 'For cleanup. Optional workspace_name filter.'
            },
            deep: {
                type: 'boolean',
                description: 'For diagnose. Enable deep diagnostic (scroll sample, source/workspace distribution, field coverage).',
                default: false
            },
            sample_size: {
                type: 'number',
                description: 'For diagnose with deep=true. Qdrant scroll sample size. Default 1000, max 5000.',
                default: 1000
            },
            top_n_workspaces: {
                type: 'number',
                description: 'For diagnose with deep=true. Top workspace_name count to report. Default 20, max 100.',
                default: 20
            },
            garbage_category: {
                type: 'string',
                enum: ['death_spiral', 'duplicate', 'low_value', 'all'],
                description: 'For garbage_scan. Category: death_spiral, duplicate, low_value, all. Default: all'
            },
            min_messages: {
                type: 'number',
                description: 'For garbage_scan. Min messages for a task to be scanned. Default: 10.',
                default: 10
            },
            max_results: {
                type: 'number',
                description: 'For garbage_scan. Max results returned. Default: 100.',
                default: 100
            },
            remove_skeletons: {
                type: 'boolean',
                description: 'For garbage_scan with dry_run=false. Delete garbage skeleton files. Default: true.',
                default: true
            },
            remove_vectors: {
                type: 'boolean',
                description: 'For garbage_scan with dry_run=false. Delete garbage Qdrant vectors. Default: true.',
                default: true
            },
            confirm_orphan_cleanup: {
                type: 'boolean',
                description: 'For cleanup_orphans with dry_run=false. Required confirmation. Default: false.',
                default: false
            },
            max_repair_tasks: {
                type: 'number',
                description: 'For repair_gaps. Max tasks to scan per call. Default: 50.',
                default: 50
            },
            start_date: {
                type: 'string',
                description: 'For tool_usage_stats. Start date (ISO 8601 or YYYY-MM-DD). Default: 4 weeks ago.'
            },
            end_date: {
                type: 'string',
                description: 'For tool_usage_stats. End date (ISO 8601 or YYYY-MM-DD). Default: now.'
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
        lastIndexedAt?: string;
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

    if (!['index', 'reset', 'rebuild', 'diagnose', 'archive', 'status', 'cleanup', 'garbage_scan', 'cleanup_orphans', 'repair_gaps', 'tool_usage_stats', 'save_snapshot', 'trend_report'].includes(args.action)) {
        return {
            isError: true,
            content: [{ type: 'text', text: `Action "${args.action}" invalide. Valeurs possibles: index, reset, rebuild, diagnose, archive, status, cleanup, garbage_scan, cleanup_orphans, repair_gaps, tool_usage_stats, save_snapshot, trend_report` }]
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
                indexingMetrics: { totalTasks: 0, skippedTasks: 0, indexedTasks: 0, failedTasks: 0, retryTasks: 0, bandwidthSaved: 0, lastIndexedAt: undefined }
            };
            // Diagnostic hints
            const hints: string[] = [];
            if (!state.isQdrantIndexingEnabled) {
                hints.push('Indexation Qdrant désactivée. Vérifiez les variables d\'environnement: QDRANT_URL, QDRANT_API_KEY, EMBEDDING_API_KEY');
            }
            if (state.qdrantIndexQueue.size > 0 && !state.qdrantIndexInterval) {
                hints.push('Queue non vide mais worker non démarré. Le serveur MCP peut ne pas avoir initialisé les services background.');
            }

            // #2307: Collect per-task failure details from cache
            const failedTasks: Array<{ task_id: string; error: string; retry_count: number; last_attempt: string | undefined }> = [];
            for (const [taskId, skeleton] of conversationCache) {
                const idx = skeleton.metadata?.indexingState;
                if (idx?.indexStatus === 'failed') {
                    failedTasks.push({
                        task_id: taskId,
                        error: idx.indexError || 'unknown error',
                        retry_count: idx.indexRetryCount ?? 0,
                        last_attempt: idx.lastIndexAttempt,
                    });
                }
            }

            if (failedTasks.length > 0) {
                hints.push(`${failedTasks.length} tâches en échec permanent (détails dans failed_task_details ci-dessous).`);
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
                        bandwidth_saved_bytes: state.indexingMetrics.bandwidthSaved,
                        last_indexed_at: state.indexingMetrics.lastIndexedAt
                    }
                },
                failed_task_details: failedTasks.length > 0 ? failedTasks : undefined,
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

        case 'cleanup_orphans': {
            const { detectAndCleanupOrphans } = await import('./cleanup-orphans.js');
            const isDryRun = args.dry_run !== false; // default true for safety
            const isConfirmed = args.confirm_orphan_cleanup === true;

            try {
                const result = await detectAndCleanupOrphans(
                    conversationCache,
                    isDryRun,
                    isConfirmed
                );

                const mode = result.fleet_safety_abort
                    ? '[FLEET-SAFETY ABORT]'
                    : (isDryRun ? '[DRY RUN]' : (isConfirmed ? '[EXECUTED]' : '[NEEDS CONFIRM]'));
                const summary = result.fleet_safety_abort
                    ? `${mode} ${result.orphans.length} orphelins détectés sur ${result.total_task_ids_in_qdrant} task_ids — SUPPRESSION REFUSÉE (>50%, artefact mono-machine probable sur collection fleet-shared)`
                    : (isDryRun
                        ? `${mode} ${result.orphans.length} orphelins détectés sur ${result.total_task_ids_in_qdrant} task_ids Qdrant (aucune suppression)`
                        : (isConfirmed
                            ? `${mode} ${result.vectors_deleted} vecteurs supprimés pour ${result.orphans.length} task_ids orphelins`
                            : `${mode} ${result.orphans.length} orphelins détectés — confirmation requise (confirm_orphan_cleanup=true)`));

                return {
                    isError: false,
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            action: 'cleanup_orphans',
                            mode: result.fleet_safety_abort ? 'fleet_safety_abort' : (isDryRun ? 'dry_run' : (isConfirmed ? 'executed' : 'needs_confirm')),
                            fleet_safety_abort: result.fleet_safety_abort || undefined,
                            abort_reason: result.abort_reason,
                            scan: {
                                total_task_ids_in_qdrant: result.total_task_ids_in_qdrant,
                                in_cache: result.in_cache,
                                on_disk: result.on_disk,
                                in_archive: result.in_archive,
                                orphans_detected: result.orphans.length,
                            },
                            cleanup: !isDryRun && isConfirmed && !result.fleet_safety_abort ? {
                                vectors_deleted: result.vectors_deleted,
                            } : null,
                            orphan_task_ids: result.orphans.slice(0, 50),
                            errors: result.errors.length > 0 ? result.errors : undefined,
                            summary
                        }, null, 2)
                    }]
                };
            } catch (error: any) {
                return {
                    isError: true,
                    content: [{
                        type: 'text',
                        text: `Erreur lors du cleanup orphelins: ${error.message}\n${error.stack || ''}`
                    }]
                };
            }
        }

        case 'repair_gaps': {
            // #2246: One-shot gap-repair — detect tasks missing from Qdrant or stale
            // #2307: Optimized — pre-filter from metadata before Qdrant queries, then batch
            const isDryRun = args.dry_run !== false;
            const maxTasks = args.max_repair_tasks || 50;
            const { getQdrantClient } = await import('../../services/qdrant.js');
            const { IndexingDecisionService } = await import('../../services/indexing-decision.js');
            const { indexTask } = await import('../../services/task-indexer.js');
            const { RooStorageDetector } = await import('../../utils/roo-storage-detector.js');
            const decisionService = new IndexingDecisionService();
            const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

            try {
                const qdrant = getQdrantClient();
                const gaps: Array<{ task_id: string; reason: string; points_in_qdrant: number }> = [];
                const repaired: string[] = [];
                const errors: string[] = [];

                // Phase 1: Pre-filter candidates from metadata (no Qdrant calls)
                const candidates: Array<{ taskId: string; checkReason: string; needQdrantCount: boolean }> = [];
                for (const [taskId, skeleton] of conversationCache) {
                    if (candidates.length >= maxTasks * 3) break; // over-sample to account for false positives
                    const metadata = skeleton.metadata;
                    if (!metadata) continue;

                    const indexingState = metadata.indexingState;
                    const lastActivity = metadata.lastActivity;
                    const lastIndexedAt = indexingState?.lastIndexedAt;

                    // Stale: lastActivity > lastIndexedAt + 60s — always needs Qdrant count
                    if (lastActivity && lastIndexedAt) {
                        const activityTime = new Date(lastActivity).getTime();
                        const indexedTime = new Date(lastIndexedAt).getTime();
                        if (activityTime > indexedTime + 60_000) {
                            candidates.push({ taskId, checkReason: `lastActivity > lastIndexedAt (${lastActivity} > ${lastIndexedAt})`, needQdrantCount: true });
                            continue;
                        }
                    }

                    // Never indexed — always needs Qdrant count
                    if (!indexingState?.indexStatus && !metadata.qdrantIndexedAt) {
                        candidates.push({ taskId, checkReason: 'never_indexed', needQdrantCount: true });
                        continue;
                    }

                    // Indexed success but might have 0 points — needs Qdrant count
                    if (indexingState?.indexStatus === 'success') {
                        candidates.push({ taskId, checkReason: 'indexed_success_verify_points', needQdrantCount: true });
                    }
                }

                // Phase 2: Batch Qdrant count queries with concurrency=10
                const BATCH_CONCURRENCY = 10;
                const candidatesNeedingCount = candidates.filter(c => c.needQdrantCount).slice(0, maxTasks);

                for (let i = 0; i < candidatesNeedingCount.length; i += BATCH_CONCURRENCY) {
                    if (gaps.length >= maxTasks) break;
                    const batch = candidatesNeedingCount.slice(i, i + BATCH_CONCURRENCY);
                    const results = await Promise.all(batch.map(async (candidate) => {
                        try {
                            // #2699/#2700: exact:false (cardinality estimate) instead of exact:true.
                            // Gap-detection only tests `pointsCount === 0` below; an estimate cannot
                            // turn a real 0 into >0 (or vice-versa), so presence/absence is reliable.
                            // Measured 5ms vs 20-30s for exact:true on ~889k points without a payload
                            // index (the index build is itself blocked behind the write queue).
                            const countResult = await qdrant.count(collectionName, {
                                filter: { must: [{ key: 'task_id', match: { value: candidate.taskId } }] },
                                exact: false
                            });
                            const pointsCount = (countResult as any).count ?? 0;
                            return { ...candidate, pointsCount, error: null as string | null };
                        } catch {
                            return { ...candidate, pointsCount: -1, error: `${candidate.taskId}: Qdrant count query failed` };
                        }
                    }));

                    for (const r of results) {
                        if (gaps.length >= maxTasks) break;
                        if (r.error) { errors.push(r.error); continue; }

                        if (r.pointsCount === 0 && r.checkReason === 'indexed_success_verify_points') {
                            gaps.push({ task_id: r.taskId, reason: 'indexed_success_but_zero_points', points_in_qdrant: 0 });
                        } else if (r.checkReason === 'never_indexed') {
                            gaps.push({ task_id: r.taskId, reason: 'never_indexed', points_in_qdrant: r.pointsCount });
                        } else if (r.checkReason.startsWith('lastActivity')) {
                            gaps.push({ task_id: r.taskId, reason: r.checkReason, points_in_qdrant: r.pointsCount });
                        }
                    }
                }

                if (!isDryRun && gaps.length > 0) {
                    for (const gap of gaps.slice(0, maxTasks)) {
                        try {
                            const taskSkeleton = conversationCache.get(gap.task_id);
                            if (!taskSkeleton) { errors.push(`${gap.task_id}: not in cache`); continue; }

                            decisionService.resetIndexingState(taskSkeleton);

                            const conversation = await RooStorageDetector.findConversationById(gap.task_id);
                            const taskPath = conversation?.path;
                            if (!taskPath) { errors.push(`${gap.task_id}: path not found`); continue; }

                            await indexTask(gap.task_id, taskPath, 'roo');
                            decisionService.markIndexingSuccess(taskSkeleton);
                            repaired.push(gap.task_id);
                        } catch (err: any) {
                            errors.push(`${gap.task_id}: repair failed — ${err.message}`);
                        }
                    }
                }

                const mode = isDryRun ? '[DRY RUN]' : '[EXECUTED]';
                const summary = isDryRun
                    ? `${mode} ${gaps.length} gaps detected (scan only, no repair)`
                    : `${mode} ${repaired.length}/${gaps.length} tasks repaired, ${errors.length} errors`;

                return {
                    isError: false,
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            action: 'repair_gaps',
                            mode: isDryRun ? 'dry_run' : 'executed',
                            total_cached_tasks: conversationCache.size,
                            candidates_prefiltered: candidates.length,
                            qdrant_queries: candidatesNeedingCount.slice(0, maxTasks).length,
                            gaps_detected: gaps.length,
                            repaired: repaired.length,
                            errors: errors.length > 0 ? errors : undefined,
                            gap_details: gaps.slice(0, 20).map(g => ({
                                task_id: g.task_id,
                                reason: g.reason,
                                points_in_qdrant: g.points_in_qdrant
                            })),
                            summary
                        }, null, 2)
                    }]
                };
            } catch (error: any) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Error during repair_gaps: ${error.message}` }]
                };
            }
        }

        case 'tool_usage_stats': {
            // #2336 D2: Parse tool calls directly from JSONL files (Roo + Claude Code)
            // Previous implementation queried Qdrant for chunk_type=tool_interaction which
            // returned 0 results (ChunkExtractor never populates msg.tool_calls).
            const fs = await import('fs/promises');
            const os = await import('os');

            try {
                // Resolve date range
                const endDate = args.end_date ? new Date(args.end_date) : new Date();
                const defaultStart = new Date(endDate);
                defaultStart.setDate(defaultStart.getDate() - 28); // 4 weeks
                const startDate = args.start_date ? new Date(args.start_date) : defaultStart;

                if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
                    return { isError: true, content: [{ type: 'text', text: 'Invalid start_date or end_date format. Use ISO 8601 or YYYY-MM-DD.' }] };
                }

                const toolCounts: Record<string, number> = {};
                const weeklyBuckets: Record<string, Record<string, number>> = {};
                const errorCounts: Record<string, number> = {};
                const retryCounts: Record<string, number> = {};
                const sourceCounts: Record<string, number> = {};
                const downstreamActionCounts: Record<string, number> = {}; // #2336 D2: tool_use followed by non-tool action
                let totalCalls = 0;
                let filesScanned = 0;

                // --- Scan Roo tasks (api_conversation_history.json) ---
                const storageLocations = await RooStorageDetector.detectStorageLocations();
                for (const loc of storageLocations) {
                    const tasksPath = path.join(loc, 'tasks');
                    let taskDirs: string[];
                    try { taskDirs = await fs.readdir(tasksPath); } catch { continue; }

                    for (const taskId of taskDirs) {
                        const apiPath = path.join(tasksPath, taskId, 'api_conversation_history.json');
                        let content: string;
                        try {
                            content = await fs.readFile(apiPath, 'utf-8');
                            if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
                        } catch { continue; }

                        filesScanned++;
                        let messages: any[];
                        try {
                            const data = JSON.parse(content);
                            messages = Array.isArray(data) ? data : (data?.messages || []);
                        } catch { continue; }

                        // Per-conversation tracking for error matching and retry detection
                        const localIdMap = new Map<string, string>();
                        let lastToolName = '';
                        const lastCallErrored: Record<string, boolean> = {};

                        // #2336 D2: Track tool_use positions for downstream-action detection.
                        // downstream-action = tool_use followed by an assistant message with non-tool content
                        // (reasoning, text, edit — NOT another identical tool call).
                        interface ToolUseRecord { toolName: string; msgIdx: number; }
                        const toolUseRecords: ToolUseRecord[] = [];

                        for (let i = 0; i < messages.length; i++) {
                            const msg = messages[i];
                            if (!Array.isArray(msg.content)) continue;
                            const ts = msg.ts ? new Date(msg.ts) : null;

                            if (msg.role === 'assistant') {
                                if (ts && (ts < startDate || ts > endDate)) continue;

                                for (const block of msg.content) {
                                    if (block.type === 'tool_use' && block.name) {
                                        totalCalls++;
                                        const toolName = normalizeToolName(block.name);
                                        toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
                                        sourceCounts['roo'] = (sourceCounts['roo'] || 0) + 1;

                                        // Track tool_use_id → tool_name for error matching
                                        if (block.id) localIdMap.set(block.id, toolName);

                                        // Retry detection: same tool called again right after an ERRORED call
                                        // of the same tool (#753 — previously counted any sequential use).
                                        if (lastToolName === toolName && lastCallErrored[toolName]) {
                                            retryCounts[toolName] = (retryCounts[toolName] || 0) + 1;
                                        }
                                        lastToolName = toolName;

                                        // #2336 D2: record position for downstream-action scan
                                        toolUseRecords.push({ toolName, msgIdx: i });

                                        if (ts) {
                                            const weekKey = getISOWeek(ts.toISOString());
                                            if (!weeklyBuckets[weekKey]) weeklyBuckets[weekKey] = {};
                                            weeklyBuckets[weekKey][toolName] = (weeklyBuckets[weekKey][toolName] || 0) + 1;
                                        }
                                    }
                                }
                            } else if (msg.role === 'user') {
                                // Scan tool_result blocks for error detection + retry-gating
                                for (const block of msg.content) {
                                    if (block.type === 'tool_result') {
                                        const toolUseId = block.tool_use_id;
                                        const isError = block.is_error === true;
                                        if (toolUseId) {
                                            const toolName = localIdMap.get(toolUseId);
                                            if (toolName) {
                                                // Track latest result status per tool (gates retry detection #753)
                                                lastCallErrored[toolName] = isError;
                                                if (isError) {
                                                    errorCounts[toolName] = (errorCounts[toolName] || 0) + 1;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // #2336 D2: Compute downstream-action rate for Roo conversation.
                        // For each tool_use, check if the next assistant message has non-tool content.
                        for (const rec of toolUseRecords) {
                            for (let j = rec.msgIdx + 1; j < messages.length; j++) {
                                const nextMsg = messages[j];
                                if (nextMsg.role !== 'assistant' || !Array.isArray(nextMsg.content)) continue;
                                // Found the next assistant message — check if it has non-tool_use content
                                const hasNonToolContent = nextMsg.content.some(
                                    (b: any) => b.type !== 'tool_use'
                                );
                                if (hasNonToolContent) {
                                    downstreamActionCounts[rec.toolName] = (downstreamActionCounts[rec.toolName] || 0) + 1;
                                }
                                break; // Only check the first assistant message after the tool_use
                            }
                        }
                    }
                }

                // --- Scan Claude Code sessions (*.jsonl) ---
                const claudeBase = path.join(os.homedir(), '.claude', 'projects');
                let projectDirs: string[];
                try { projectDirs = await fs.readdir(claudeBase); } catch { projectDirs = []; }

                for (const projDir of projectDirs) {
                    const projPath = path.join(claudeBase, projDir);
                    let stat;
                    try { stat = await fs.stat(projPath); } catch { continue; }
                    if (!stat.isDirectory()) continue;

                    let jsonlFiles: string[];
                    try { jsonlFiles = (await fs.readdir(projPath)).filter(f => f.endsWith('.jsonl')); } catch { continue; }

                    for (const jsonlFile of jsonlFiles) {
                        const jsonlPath = path.join(projPath, jsonlFile);
                        filesScanned++;

                        // Per-session tracking for error matching and retry detection
                        const localIdMap = new Map<string, string>();
                        let lastToolName = '';
                        const lastCallErrored: Record<string, boolean> = {};

                        // #2336 D2: Track tool_use names from previous assistant message for downstream-action.
                        // When we see an assistant message with non-tool content, we attribute
                        // downstream-action to all tool_uses from the previous assistant message.
                        let prevAssistantToolUses: string[] = [];

                        // Read JSONL line-by-line to handle large files
                        const { createReadStream } = await import('fs');
                        const readline = await import('readline');
                        const rl = readline.createInterface({ input: createReadStream(jsonlPath, 'utf-8'), crlfDelay: Infinity });

                        for await (const line of rl) {
                            const trimmed = line.trim();
                            if (!trimmed) continue;
                            let entry: any;
                            try { entry = JSON.parse(trimmed); } catch { continue; }

                            // Claude Code JSONL: each line has { type, message, timestamp, ... }
                            const message = entry.message || entry;

                            if (message.role === 'assistant' && Array.isArray(message.content)) {
                                const tsRaw = entry.timestamp || message.timestamp;
                                const ts = tsRaw ? new Date(tsRaw) : null;
                                if (ts && (ts < startDate || ts > endDate)) {
                                    prevAssistantToolUses = [];
                                    continue;
                                }

                                // #2336 D2: Check if this assistant message has non-tool content
                                // (meaning previous tool_uses led to productive action)
                                const hasNonToolContent = message.content.some(
                                    (b: any) => b.type !== 'tool_use'
                                );
                                if (hasNonToolContent && prevAssistantToolUses.length > 0) {
                                    for (const prevTool of prevAssistantToolUses) {
                                        downstreamActionCounts[prevTool] = (downstreamActionCounts[prevTool] || 0) + 1;
                                    }
                                }

                                // Collect tool_uses from this message for next-iteration check
                                const currentToolUses: string[] = [];

                                for (const block of message.content) {
                                    if (block.type === 'tool_use' && block.name) {
                                        totalCalls++;
                                        const toolName = normalizeToolName(block.name);
                                        toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
                                        sourceCounts['claude-code'] = (sourceCounts['claude-code'] || 0) + 1;

                                        // Track tool_use_id → tool_name for error matching
                                        const toolUseId = block.id || block.toolUse?.id;
                                        if (toolUseId) localIdMap.set(toolUseId, toolName);

                                        // Retry detection: same tool called again right after an ERRORED call
                                        // of the same tool (#753 — previously counted any sequential use).
                                        if (lastToolName === toolName && lastCallErrored[toolName]) {
                                            retryCounts[toolName] = (retryCounts[toolName] || 0) + 1;
                                        }
                                        lastToolName = toolName;

                                        currentToolUses.push(toolName);

                                        if (ts) {
                                            const weekKey = getISOWeek(ts.toISOString());
                                            if (!weeklyBuckets[weekKey]) weeklyBuckets[weekKey] = {};
                                            weeklyBuckets[weekKey][toolName] = (weeklyBuckets[weekKey][toolName] || 0) + 1;
                                        }
                                    }
                                }

                                // #2336 D2: If this message has ONLY tool_uses (no text/thinking),
                                // those tools haven't led to downstream action yet — check next message.
                                // If this message has BOTH tool_uses AND non-tool content, the
                                // non-tool content is itself a downstream action for the tool_uses
                                // in the SAME message (but we only count cross-message to avoid
                                // inflating counts — same-message is just the agent calling+reasoning).
                                if (currentToolUses.length > 0 && !hasNonToolContent) {
                                    prevAssistantToolUses = currentToolUses;
                                } else {
                                    prevAssistantToolUses = [];
                                }
                            } else if (message.role === 'user' && Array.isArray(message.content)) {
                                // Scan tool_result blocks for error detection + retry-gating
                                for (const block of message.content) {
                                    if (block.type === 'tool_result') {
                                        const toolUseId = block.tool_use_id || block.toolResult?.tool_use_id;
                                        const isError = block.is_error === true || block.toolResult?.is_error === true;
                                        if (toolUseId) {
                                            const toolName = localIdMap.get(toolUseId);
                                            if (toolName) {
                                                // Track latest result status per tool (gates retry detection #753)
                                                lastCallErrored[toolName] = isError;
                                                if (isError) {
                                                    errorCounts[toolName] = (errorCounts[toolName] || 0) + 1;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // Sort tools by count descending
                const sortedTools = Object.entries(toolCounts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([name, count]) => ({
                        tool_name: name,
                        calls: count,
                        errors: errorCounts[name] || 0,
                        error_rate: count > 0 ? +((errorCounts[name] || 0) / count * 100).toFixed(1) : 0,
                        retries: retryCounts[name] || 0,
                        retry_rate: count > 0 ? +((retryCounts[name] || 0) / count * 100).toFixed(1) : 0,
                        downstream_actions: downstreamActionCounts[name] || 0,
                        downstream_action_rate: count > 0 ? +((downstreamActionCounts[name] || 0) / count * 100).toFixed(1) : 0,
                    }));

                // Sort weeks chronologically
                const sortedWeeks = Object.entries(weeklyBuckets)
                    .sort((a, b) => a[0].localeCompare(b[0]))
                    .map(([week, tools]) => ({
                        week,
                        total_calls: Object.values(tools).reduce((s, c) => s + c, 0),
                        top_tools: Object.entries(tools)
                            .sort((a, b) => b[1] - a[1])
                            .slice(0, 10)
                            .map(([name, count]) => ({ tool_name: name, calls: count })),
                    }));

                return {
                    isError: false,
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            action: 'tool_usage_stats',
                            method: 'jsonl_scan',
                            date_range: {
                                start: startDate.toISOString().slice(0, 10),
                                end: endDate.toISOString().slice(0, 10),
                                weeks: sortedWeeks.length,
                            },
                            files_scanned: filesScanned,
                            total_tool_calls: totalCalls,
                            unique_tools: Object.keys(toolCounts).length,
                            source_distribution: sourceCounts,
                            tools: sortedTools,
                            weekly_trend: sortedWeeks,
                            summary: `${totalCalls} tool calls across ${Object.keys(toolCounts).length} tools, ${sortedWeeks.length} weeks (${startDate.toISOString().slice(0, 10)} → ${endDate.toISOString().slice(0, 10)}). Errors: ${Object.values(errorCounts).reduce((s, c) => s + c, 0)}, Retries: ${Object.values(retryCounts).reduce((s, c) => s + c, 0)}, Downstream actions: ${Object.values(downstreamActionCounts).reduce((s, c) => s + c, 0)}`,
                        }, null, 2)
                    }]
                };
            } catch (error: any) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Error during tool_usage_stats: ${error.message}` }]
                };
            }
        }

        // #2336 D3: Persist weekly tool_usage_stats snapshot to shared storage
        case 'save_snapshot': {
            const fs = await import('fs/promises');
            const os = await import('os');

            try {
                // 1. Compute tool_usage_stats by recursing into the handler
                const statsResult = await handleRooSyncIndexing(
                    { action: 'tool_usage_stats', start_date: args.start_date, end_date: args.end_date },
                    conversationCache, ensureCacheFreshCallback, saveSkeletonCallback, qdrantIndexQueue, setQdrantIndexingEnabled, rebuildHandler, indexingState,
                );
                if (statsResult.isError) return statsResult;

                // 2. Determine snapshot path
                const sharedPath = getSharedStatePath();
                const snapshotsDir = path.join(sharedPath, 'tool-usage-snapshots');
                await fs.mkdir(snapshotsDir, { recursive: true });

                const hostname = os.hostname();
                const now = new Date();
                const dateStr = now.toISOString().slice(0, 10);
                const filename = `${hostname}-${dateStr}.json`;
                const snapshotPath = path.join(snapshotsDir, filename);

                // 3. Enrich with metadata — safely extract text from CallToolResult
                const textContent = statsResult.content.find((c: any) => c.type === 'text');
                if (!textContent || !('text' in textContent)) {
                    return { isError: true, content: [{ type: 'text', text: 'tool_usage_stats returned no text content' }] };
                }
                const parsed = JSON.parse((textContent as any).text);
                const snapshot = {
                    ...parsed,
                    snapshot_metadata: {
                        machine: hostname,
                        captured_at: now.toISOString(),
                        snapshot_type: 'weekly_baseline',
                    },
                };

                await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');

                // 4. List existing snapshots
                let existingFiles: string[] = [];
                try { existingFiles = (await fs.readdir(snapshotsDir)).filter(f => f.endsWith('.json')).sort(); } catch { /* empty */ }

                return {
                    isError: false,
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            action: 'save_snapshot',
                            status: 'saved',
                            path: snapshotPath,
                            filename,
                            total_tool_calls: parsed.total_tool_calls,
                            unique_tools: parsed.unique_tools,
                            date_range: parsed.date_range,
                            total_snapshots: existingFiles.length,
                            all_snapshots: existingFiles,
                        }, null, 2),
                    }],
                };
            } catch (error: any) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Error during save_snapshot: ${error.message}` }],
                };
            }
        }

        // #2336 D3: Generate trend report comparing snapshots
        case 'trend_report': {
            const fs = await import('fs/promises');

            try {
                const sharedPath = getSharedStatePath();
                const snapshotsDir = path.join(sharedPath, 'tool-usage-snapshots');

                // Load all snapshots
                let files: string[];
                try { files = (await fs.readdir(snapshotsDir)).filter(f => f.endsWith('.json')).sort(); } catch {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: 'No snapshots found. Run save_snapshot first.' }],
                    };
                }

                if (files.length < 1) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: 'No snapshots found. Run save_snapshot first.' }],
                    };
                }

                // Load the 2 most recent snapshots (or 1 if only 1 exists)
                const toLoad = files.slice(-2);
                const snapshots: any[] = [];
                for (const f of toLoad) {
                    const content = await fs.readFile(path.join(snapshotsDir, f), 'utf-8');
                    snapshots.push(JSON.parse(content));
                }

                const latest = snapshots[snapshots.length - 1];
                const previous = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
                // #2623: older snapshots (pre per-tool shape) may lack `.tools`/`.weekly_trend`/`.files_scanned`.
                // Defend against schema drift instead of crashing on undefined.map().
                const previousHasTools = !!(previous && Array.isArray(previous.tools));

                // Build trend report as markdown
                const lines: string[] = [];
                lines.push(`# Tool Usage Trend Report`);
                lines.push(``);
                lines.push(`**Generated:** ${new Date().toISOString().slice(0, 10)}`);
                lines.push(`**Snapshots:** ${files.length} total, comparing ${toLoad[0]}${previous ? ' → ' + toLoad[1] : ' (baseline only)'}`);
                lines.push(``);

                // Summary comparison
                lines.push(`## Summary`);
                lines.push(``);
                if (previous) {
                    const callsDiff = latest.total_tool_calls - previous.total_tool_calls;
                    const toolsDiff = latest.unique_tools - previous.unique_tools;
                    const arrow = (n: number) => n > 0 ? `↑+${n}` : n < 0 ? `↓${n}` : `→`;
                    lines.push(`| Metric | Previous | Latest | Change |`);
                    lines.push(`|--------|----------|--------|--------|`);
                    lines.push(`| Total calls | ${previous.total_tool_calls} | ${latest.total_tool_calls} | ${arrow(callsDiff)} |`);
                    lines.push(`| Unique tools | ${previous.unique_tools} | ${latest.unique_tools} | ${arrow(toolsDiff)} |`);
                    // #2623: files_scanned may be absent on older snapshots — show only when both present.
                    if (typeof previous.files_scanned === 'number' && typeof latest.files_scanned === 'number') {
                        lines.push(`| Files scanned | ${previous.files_scanned} | ${latest.files_scanned} | ${arrow(latest.files_scanned - previous.files_scanned)} |`);
                    }
                    if (!previousHasTools) {
                        lines.push(``);
                        lines.push(`> Note: previous snapshot has no per-tool breakdown (older schema). Per-tool trend shows latest only.`);
                    }
                } else {
                    lines.push(`Baseline snapshot only — no comparison available yet.`);
                    lines.push(`- Total calls: ${latest.total_tool_calls}`);
                    lines.push(`- Unique tools: ${latest.unique_tools}`);
                    lines.push(`- Date range: ${latest.date_range?.start} → ${latest.date_range?.end}`);
                }
                lines.push(``);

                // Per-tool trend (top 20) — requires both snapshots to have a `.tools` array (#2623 schema drift guard).
                lines.push(`## Per-Tool Trend (Top 20)`);
                lines.push(``);
                if (previousHasTools) {
                    const prevMap: Map<string, any> = new Map(previous.tools.map((t: any) => [t.tool_name, t]));
                    const rows = latest.tools.slice(0, 20).map((t: any) => {
                        const p: any = prevMap.get(t.tool_name);
                        const callsArrow = p ? (t.calls > p.calls ? '↑' : t.calls < p.calls ? '↓' : '→') : '🆕';
                        const errorArrow = p ? (t.error_rate > p.error_rate ? '↑' : t.error_rate < p.error_rate ? '↓' : '→') : '-';
                        const retryArrow = p ? (t.retry_rate > p.retry_rate ? '↑' : t.retry_rate < p.retry_rate ? '↓' : '→') : '-';
                        return `| ${t.tool_name} | ${t.calls} | ${callsArrow} | ${t.error_rate}% | ${errorArrow} | ${t.retry_rate}% | ${retryArrow} | ${t.downstream_action_rate ?? '-'}% |`;
                    });
                    lines.push(`| Tool | Calls | Trend | Err% | Trend | Retry% | Trend | DwnAct% |`);
                    lines.push(`|------|-------|-------|------|-------|--------|-------|--------|`);
                    lines.push(...rows);
                } else {
                    lines.push(`| Tool | Calls | Err% | Retry% | DwnAct% |`);
                    lines.push(`|------|-------|------|--------|---------|`);
                    for (const t of latest.tools.slice(0, 20)) {
                        lines.push(`| ${t.tool_name} | ${t.calls} | ${t.error_rate}% | ${t.retry_rate}% | ${t.downstream_action_rate ?? '-'}% |`);
                    }
                }
                lines.push(``);

                // All snapshots
                lines.push(`## Available Snapshots (${files.length})`);
                lines.push(``);
                for (const f of files) {
                    lines.push(`- ${f}`);
                }

                return {
                    isError: false,
                    content: [{
                        type: 'text',
                        text: lines.join('\n'),
                    }],
                };
            } catch (error: any) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Error during trend_report: ${error.message}` }],
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
