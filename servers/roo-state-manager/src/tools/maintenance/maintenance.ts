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

/**
 * Actions supportées par maintenance
 */
export type MaintenanceAction = 'cache_rebuild' | 'diagnose_bom' | 'repair_bom';

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
    /** Si true, simule la réparation sans modifier les fichiers (action=repair_bom) */
    dry_run?: boolean;
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
                enum: ['cache_rebuild', 'diagnose_bom', 'repair_bom'],
                description: 'Action: cache_rebuild, diagnose_bom, ou repair_bom.'
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
                description: 'Simuler la réparation sans modifier les fichiers (action=repair_bom).',
                default: false
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

        default:
            return {
                content: [{
                    type: 'text',
                    text: `Action inconnue: '${action}'. Actions valides: cache_rebuild, diagnose_bom, repair_bom.`
                }],
                isError: true
            };
    }
}
