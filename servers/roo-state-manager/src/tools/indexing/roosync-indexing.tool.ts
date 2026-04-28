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

// Fonction pour la détection de garbage tasks #1786
async function handleGarbageScan(
    args: RooSyncIndexingArgs & {
        min_size_kb?: number;
        error_threshold_percent?: number;
        assistant_output_threshold_percent?: number;
        task_id_filter?: string;
    },
    conversationCache: Map<string, ConversationSkeleton>,
    ensureCacheFreshCallback: () => Promise<boolean>
): Promise<CallToolResult> {

/**
 * Arguments du tool roosync_indexing unifié
 */
export interface RooSyncIndexingArgs {
    /** Action d'indexation */
    action: 'index' | 'reset' | 'rebuild' | 'diagnose' | 'archive' | 'status' | 'cleanup' | 'garbage_scan' | 'garbage_cleanup';

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

    /** #1786: Filtres pour la détection de garbage */
    min_size_kb?: number;
    error_threshold_percent?: number;
    assistant_output_threshold_percent?: number;
    task_id_filter?: string;

    /** #1786: Action garbage_cleanup - IDs des tâches à nettoyer */
    garbage_task_ids?: string[];

    /** #1786: Pour garbage_cleanup - valider les tâches avant suppression */
    validate_before_cleanup?: boolean;
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
                enum: ['index', 'reset', 'rebuild', 'diagnose', 'archive', 'status', 'cleanup', 'garbage_scan', 'garbage_cleanup'],
                description: "Action: 'index' (indexer une tâche dans Qdrant), 'reset' (réinitialiser la collection Qdrant), 'rebuild' (reconstruire l'index SQLite VS Code), 'diagnose' (diagnostic complet de l'index), 'archive' (archiver une tâche Roo ou les sessions Claude Code sur GDrive), 'status' (état du background indexer et métriques), 'cleanup' (supprimer les vecteurs plus anciens qu'un âge donné #1658), 'garbage_scan' (détecter les tâches garbage #1786), 'garbage_cleanup' (supprimer des tâches garbage spécifiques #1786)"
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
            garbage_task_ids: {
                type: 'array',
                items: {
                    type: 'string'
                },
                description: "#1786: Pour action=garbage_cleanup. Liste des IDs de tâches à nettoyer du cache et de l'index."
            },
            validate_before_cleanup: {
                type: 'boolean',
                description: "#1786: Pour action=garbage_cleanup. Valider que les tâches correspondent aux critères garbage avant suppression. Défaut: true.",
                default: true
            },
            monitor_task_ids: {
                type: 'array',
                items: {
                    type: 'string'
                },
                description: "#1786: Pour action=garbage_monitor. Liste des IDs des tâches à monitorer pour la détection de death spiral."
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

    if (!['index', 'reset', 'rebuild', 'diagnose', 'archive', 'status', 'cleanup', 'garbage_scan', 'garbage_cleanup'].includes(args.action)) {
        return {
            isError: true,
            content: [{ type: 'text', text: `Action "${args.action}" invalide. Valeurs possibles: index, reset, rebuild, diagnose, archive, status, cleanup, garbage_scan, garbage_cleanup` }]
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
            return await handleGarbageScan(args, conversationCache, ensureCacheFreshCallback);
        }

        case 'garbage_cleanup': {
            // Importer le GarbageCollector
            const { GarbageCollector } = await import('../../services/garbage-collector.js');

            // Valider les paramètres
            if (!args.garbage_task_ids || args.garbage_task_ids.length === 0) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'Le paramètre "garbage_task_ids" est requis pour action=garbage_cleanup' }]
                };
            }

            // Option: valider les tâches avant suppression
            let taskIdsToCleanup = args.garbage_task_ids;
            if (args.validate_before_cleanup !== false) {
                console.log(`🔍 Validation des ${taskIdsToCleanup.length} tâches avant cleanup...`);
                const validation = await GarbageCollector.validateGarbageTasks(
                    taskIdsToCleanup,
                    conversationCache,
                    {
                        min_size_kb: args.min_size_kb,
                        error_threshold_percent: args.error_threshold_percent,
                        assistant_output_threshold_percent: args.assistant_output_threshold_percent
                    }
                );

                taskIdsToCleanup = validation.valid;

                if (validation.invalid.length > 0) {
                    console.log(`⚠️ ${validation.invalid.length} tâches ne correspondent pas aux critères garbage:`);
                    validation.invalid.forEach(({ taskId, reason }) => {
                        console.log(`  - ${taskId}: ${reason}`);
                    });
                }

                if (taskIdsToCleanup.length === 0) {
                    return {
                        isError: false,
                        content: [{
                            type: 'text',
                            text: `Aucune tâche ne correspond aux critères garbage après validation. Aucune suppression effectuée.`
                        }]
                    };
                }
            }

            console.log(`🧹 Cleanup de ${taskIdsToCleanup.length} tâches garbage...`);

            // Exécuter le cleanup
            const results = await GarbageCollector.cleanupGarbageTasks(
                taskIdsToCleanup,
                args.dry_run || false,
                args.workspace_filter
            );

            // Préparer le rapport
            const report = {
                action: 'garbage_cleanup',
                task_ids_processed: taskIdsToCleanup,
                task_ids_original: args.garbage_task_ids,
                dry_run: args.dry_run || false,
                workspace_filter: args.workspace_filter,
                results: {
                    deleted_from_cache: results.deletedFromCache,
                    deleted_from_qdrant: results.deletedFromQdrant,
                    errors_count: results.errors.length,
                    preserved_count: results.preserved.length,
                    preserved_tasks: results.preserved
                },
                errors: results.errors.map(e => ({
                    task_id: e.taskId,
                    error: e.error
                })),
                summary: `Cleanup terminé: ${results.deletedFromCache} du cache, ${results.deletedFromQdrant} de Qdrant, ${results.preserved.length} préservées (sanctuaire), ${results.errors.length} erreurs`
            };

            return {
                isError: false,
                content: [{ type: 'text', text: JSON.stringify(report, null, 2) }]
            };
        }

        case 'garbage_monitor': {
            // Importer le DeathSpiralDetector
            const { DeathSpiralDetector } = await import('../../services/death-spiral-detector.js');

            // Valider les paramètres
            if (!args.monitor_task_ids || args.monitor_task_ids.length === 0) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'Le paramètre "monitor_task_ids" est requis pour action=garbage_monitor' }]
                };
            }

            // Analyser les tâches pour détecter les death spirals
            const analysis = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
                args.monitor_task_ids,
                conversationCache,
                {
                    error_threshold_percent: args.error_threshold_percent || 80,
                    assistant_output_threshold_percent: args.assistant_output_threshold_percent || 5,
                    rapid_error_threshold_count: args.rapid_error_threshold_count || 5,
                    time_window_minutes: args.time_window_minutes || 30
                }
            );

            // Préparer le rapport de monitoring
            const report = {
                action: 'garbage_monitor',
                monitored_task_ids: args.monitor_task_ids,
                death_spirals_detected: analysis.deathSpirals.length,
                tasks_at_risk: analysis.tasksAtRisk.length,
                immediate_actions: analysis.immediateActions,
                recommendations: analysis.recommendations,
                analysis: analysis.deathSpirals.map(ds => ({
                    task_id: ds.taskId,
                    risk_level: ds.riskLevel,
                    triggers: ds.triggers,
                    error_count: ds.errorCount,
                    error_ratio: ds.errorRatio,
                    last_error: ds.lastError,
                    time_to_death_spiral: ds.timeToDeathSpiral
                })),
                summary: `Monitoring: ${analysis.deathSpirals.length} death spirals détectées, ${analysis.tasksAtRisk.length} tâches à risque, ${analysis.immediateActions.length} actions immédiates recommandées`
            };

            return {
                isError: false,
                content: [{ type: 'text', text: JSON.stringify(report, null, 2) }]
            };
        }

        default:
            return {
                isError: true,
                content: [{ type: 'text', text: `Action non supportée: ${(args as any).action}` }]
            };
    }
}

/**
 * Handler pour la détection de tâches garbage #1786
 */
async function handleGarbageScan(
    args: RooSyncIndexingArgs & {
        min_size_kb?: number;
        error_threshold_percent?: number;
        assistant_output_threshold_percent?: number;
        task_id_filter?: string;
    },
    conversationCache: Map<string, ConversationSkeleton>,
    ensureCacheFreshCallback: () => Promise<boolean>
): Promise<CallToolResult> {
    // Paramètres par défaut
    const minSizeKB = args.min_size_kb || 100; // Ne scanner que les tâches > 100KB
    const errorThresholdPercent = args.error_threshold_percent || 80; // 80% d'erreurs = garbage
    const assistantOutputThresholdPercent = args.assistant_output_threshold_percent || 5; // Moins de 5% d'output assistant = garbage

    // S'assurer que le cache est à jour
    await ensureCacheFreshCallback();

    // Analyser toutes les tâches dans le cache
    const allTasks = Array.from(conversationCache.entries());
    const garbageTasks: Array<{
        taskId: string;
        size: number;
        errorCount: number;
        totalMessages: number;
        assistantOutputCount: number;
        errorRatio: number;
        assistantOutputRatio: number;
        errors: string[];
    }> = [];

    const uniqueErrors = new Set<string>();

    for (const [taskId, skeleton] of allTasks) {
        // Filtrer par taille et par ID si spécifié
        const taskSizeKB = skeleton.metadata?.totalSize ? Number(skeleton.metadata.totalSize) / 1024 : 0;
        if (taskSizeKB < minSizeKB) continue;
        if (args.task_id_filter && !taskId.includes(args.task_id_filter)) continue;

        let errorCount = 0;
        let assistantOutputCount = 0;
        let totalMessages = 0;
        const errors: string[] = [];

        // Scanner les messages dans le squelette
        const scanMessages = (messages: any[]) => {
            for (const msg of messages) {
                totalMessages++;

                // Compter les erreurs
                if (msg.role === 'user' && msg.content && Array.isArray(msg.content)) {
                    for (const content of msg.content) {
                        if (content.type === 'text') {
                            // Détecter les erreurs 502, timeout, etc.
                            const errorPatterns = [
                                /502\s+Bad\s+Gateway/i,
                                /timeout/i,
                                /context\s+overflow/i,
                                /retry/i,
                                /MCP\s+error/i,
                                /too_many_tools_warning/i
                            ];

                            for (const pattern of errorPatterns) {
                                if (pattern.test(content.text)) {
                                    errorCount++;
                                    errors.push(content.text.trim());
                                    uniqueErrors.add(pattern.source);
                                    break;
                                }
                            }
                        }
                    }
                }

                // Compter les outputs assistant
                if (msg.role === 'assistant' && msg.content && Array.isArray(msg.content)) {
                    for (const content of msg.content) {
                        if (content.type === 'text' && content.text?.trim().length > 0) {
                            assistantOutputCount++;
                        }
                    }
                }

                // Recursivement scanner les enfants
                if (msg.messages) {
                    scanMessages(msg.messages);
                }
            }
        };

        scanMessages(skeleton.messages || []);

        const errorRatio = totalMessages > 0 ? (errorCount / totalMessages) * 100 : 0;
        const assistantOutputRatio = totalMessages > 0 ? (assistantOutputCount / totalMessages) * 100 : 0;

        // Critères de détection de garbage
        if (errorRatio >= errorThresholdPercent && assistantOutputRatio < assistantOutputThresholdPercent) {
            garbageTasks.push({
                taskId,
                size: taskSizeKB,
                errorCount,
                totalMessages,
                assistantOutputCount,
                errorRatio,
                assistantOutputRatio,
                errors: [...new Set(errors)].slice(0, 10) // Garder 10 erreurs uniques
            });
        }
    }

    // Trier par taille décroissante
    garbageTasks.sort((a, b) => b.size - a.size);

    const stats = {
        total_tasks_scanned: allTasks.length,
        min_size_kb: minSizeKB,
        error_threshold_percent: errorThresholdPercent,
        assistant_output_threshold_percent: assistantOutputThresholdPercent,
        garbage_tasks_found: garbageTasks.length,
        unique_error_types: uniqueErrors.size,
        garbage_size_kb: garbageTasks.reduce((sum, task) => sum + task.size, 0),
        top_errors: Array.from(uniqueErrors).slice(0, 5),
        tasks: garbageTasks.slice(0, 50) // Limiter à 50 résultats
    };

    return {
        isError: false,
        content: [{
            type: 'text',
            text: JSON.stringify(stats, null, 2)
        }]
    };
}
