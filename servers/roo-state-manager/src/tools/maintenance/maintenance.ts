/**
 * Outil MCP consolidé : maintenance
 *
 * CONS-13: Consolide 3 outils de maintenance en 1 outil unifié.
 * Remplace:
 *   - build_skeleton_cache
 *   - diagnose_conversation_bom
 *   - repair_conversation_bom
 *
 * @module tools/maintenance/maintenance
 * @version 1.0.0
 * @since CONS-13
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { ServerState } from '../../services/state-manager.service.js';
import { handleBuildSkeletonCache } from '../cache/build-skeleton-cache.tool.js';
import { diagnoseConversationBomTool } from '../repair/diagnose-conversation-bom.tool.js';
import { repairConversationBomTool } from '../repair/repair-conversation-bom.tool.js';
import { handleRebuildTaskIndex } from './rebuild-task-index.js';

/**
 * Actions supportées par maintenance
 */
export type MaintenanceAction = 'cache_rebuild' | 'diagnose_bom' | 'repair_bom' | 'rebuild_index';

/**
 * Arguments consolidés du tool maintenance
 */
export interface MaintenanceArgs {
    /** Action à effectuer */
    action: MaintenanceAction;

    // Cache-specific options
    /** Force la reconstruction complète du cache (action=cache_rebuild) */
    force_rebuild?: boolean;
    /** Filtre par workspace (action=cache_rebuild) */
    workspace_filter?: string;
    /** Liste d'IDs de tâches spécifiques (action=cache_rebuild) */
    task_ids?: string[];

    // BOM-specific options
    /** Si true, répare automatiquement les fichiers trouvés (action=diagnose_bom) */
    fix_found?: boolean;
    /** Si true (défaut), simule sans modifier les fichiers (action=repair_bom, rebuild_index, cache_rebuild) */
    dry_run?: boolean;

    // Rebuild-index-specific options
    /** Nombre maximum de tâches à traiter (action=rebuild_index) */
    max_tasks?: number;
}

/**
 * Définition de l'outil maintenance (tool registration sans handler - handler est séparé)
 */
export const maintenanceToolDefinition = {
    name: 'maintenance',
    description: 'Opérations de maintenance du stockage. action=cache_rebuild (reconstruire le cache), diagnose_bom (diagnostiquer BOM), repair_bom (réparer BOM).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            action: {
                type: 'string',
                enum: ['cache_rebuild', 'diagnose_bom', 'repair_bom', 'rebuild_index'],
                description: 'Action: cache_rebuild, diagnose_bom, repair_bom, ou rebuild_index (reconstruit l\'index SQLite des tâches VS Code).'
            },
            force_rebuild: {
                type: 'boolean',
                description: 'Force la reconstruction complète du cache (action=cache_rebuild).',
                default: false
            },
            workspace_filter: {
                type: 'string',
                description: 'Filtre par workspace (action=cache_rebuild).'
            },
            task_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Liste d\'IDs de tâches spécifiques à construire (action=cache_rebuild).'
            },
            fix_found: {
                type: 'boolean',
                description: 'Réparer automatiquement les fichiers corrompus (action=diagnose_bom).',
                default: false
            },
            dry_run: {
                type: 'boolean',
                description: 'Simuler sans modifier (action=repair_bom, rebuild_index, cache_rebuild). Défaut: true — passer dry_run=false pour exécuter réellement (#3984).',
                default: true
            },
            max_tasks: {
                type: 'number',
                description: 'Nombre maximum de tâches à traiter (action=rebuild_index). 0 = toutes.',
                default: 0
            }
        },
        required: ['action']
    }
};

/**
 * Handler consolidé pour maintenance
 *
 * Accepte des dépendances injectées (comme CONS-10 export_data)
 * pour build_skeleton_cache qui nécessite conversationCache et state.
 */
export async function handleMaintenance(
    args: MaintenanceArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    state?: ServerState
): Promise<CallToolResult> {
    const { action } = args;

    switch (action) {
        case 'cache_rebuild':
            // #3984: dry_run=true (défaut) — rapporte ce que la passe ferait sans
            // vider le cache ni écrire sur disque. La réécriture réelle (force_rebuild)
            // part avec un backup .skeletons.bak (voir handleBuildSkeletonCache).
            if (args.dry_run !== false) {
                const mode = args.force_rebuild ? 'FORCE_REBUILD' : 'SMART_REBUILD';
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            action: 'cache_rebuild',
                            mode: 'dry_run',
                            planned_mode: mode,
                            workspace_filter: args.workspace_filter ?? null,
                            task_ids: args.task_ids ?? null,
                            in_memory_skeletons: conversationCache.size,
                            note: `Simulation — rien n'a été écrit. La passe réelle (${mode})${args.force_rebuild ? ' réécrit TOUS les fichiers .skeletons après backup .bak' : ' ne reconstruit que les squelettes obsolètes/manquants'}. Relancer avec dry_run=false pour exécuter.`
                        }, null, 2)
                    }]
                };
            }
            return handleBuildSkeletonCache(
                {
                    force_rebuild: args.force_rebuild,
                    workspace_filter: args.workspace_filter,
                    task_ids: args.task_ids
                },
                conversationCache,
                state
            );

        case 'diagnose_bom':
            return diagnoseConversationBomTool.handler({
                fix_found: args.fix_found
            });

        case 'repair_bom':
            return repairConversationBomTool.handler({
                dry_run: args.dry_run
            });

        case 'rebuild_index':
            return handleRebuildTaskIndex({
                workspace_filter: args.workspace_filter,
                max_tasks: args.max_tasks,
                dry_run: args.dry_run ?? true
            });

        default:
            return {
                content: [{
                    type: 'text',
                    text: `Action inconnue: '${action}'. Actions valides: cache_rebuild, diagnose_bom, repair_bom, rebuild_index.`
                }],
                isError: true
            };
    }
}
