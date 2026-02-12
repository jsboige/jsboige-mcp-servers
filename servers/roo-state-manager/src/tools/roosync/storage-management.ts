/**
 * Outil MCP : roosync_storage_management
 *
 * Gestion complète du stockage Roo (inspection, maintenance, cache, BOM repair).
 *
 * @module tools/roosync/storage-management
 * @version 1.0.0
 */

import { z } from 'zod';
import { handleStorageInfo } from '../storage/storage-info.js';
import { handleMaintenance } from '../maintenance/maintenance.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { ServerState } from '../../services/state-manager.service.js';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';

// ====================================================================
// SCHEMAS DE VALIDATION
// ====================================================================

export const StorageManagementArgsSchema = z.object({
    action: z.enum(['storage', 'maintenance'])
        .describe('Type d\'opération: storage (inspection) ou maintenance (réparation/rebuild)'),

    // Paramètres pour action: 'storage'
    storageAction: z.enum(['detect', 'stats']).optional()
        .describe('Sous-action pour storage: detect (localiser), stats (statistiques)'),

    // Paramètres pour action: 'maintenance'
    maintenanceAction: z.enum(['cache_rebuild', 'diagnose_bom', 'repair_bom']).optional()
        .describe('Sous-action pour maintenance: cache_rebuild, diagnose_bom, repair_bom'),

    // Options pour cache_rebuild
    force_rebuild: z.boolean().optional()
        .describe('Force la reconstruction complète du cache (maintenance: cache_rebuild)'),
    workspace_filter: z.string().optional()
        .describe('Filtre par workspace (maintenance: cache_rebuild)'),
    task_ids: z.array(z.string()).optional()
        .describe('Liste d\'IDs de tâches spécifiques (maintenance: cache_rebuild)'),

    // Options pour BOM operations
    fix_found: z.boolean().optional()
        .describe('Réparer automatiquement les fichiers corrompus (maintenance: diagnose_bom)'),
    dry_run: z.boolean().optional()
        .describe('Simuler la réparation sans modifier (maintenance: repair_bom)')
});

export type StorageManagementArgs = z.infer<typeof StorageManagementArgsSchema>;

export const StorageManagementResultSchema = z.object({
    success: z.boolean()
        .describe('Indique si l\'opération a réussi'),
    action: z.enum(['storage', 'maintenance'])
        .describe('Type d\'opération effectuée'),
    subAction: z.string().optional()
        .describe('Sous-action effectuée'),
    timestamp: z.string()
        .describe('Timestamp de l\'opération (ISO 8601)'),
    message: z.string().optional()
        .describe('Message de résultat'),
    data: z.any().optional()
        .describe('Données retournées par l\'opération')
});

export type StorageManagementResult = z.infer<typeof StorageManagementResultSchema>;

// ====================================================================
// IMPLÉMENTATION PRINCIPALE
// ====================================================================

/**
 * Outil principal de gestion du stockage
 * Délègue aux handlers existants storage_info et maintenance
 *
 * @param args Arguments de l'outil
 * @param conversationCache Cache des conversations (requis pour maintenance)
 * @param state État du serveur (requis pour maintenance)
 */
export async function roosyncStorageManagement(
    args: StorageManagementArgs,
    conversationCache?: Map<string, ConversationSkeleton>,
    state?: ServerState
): Promise<StorageManagementResult> {
    try {
        const { action } = args;
        const timestamp = new Date().toISOString();

        switch (action) {
            case 'storage':
                return await handleStorageAction(args, timestamp);

            case 'maintenance':
                return await handleMaintenanceAction(args, conversationCache, state, timestamp);

            default:
                throw new HeartbeatServiceError(
                    `Action non reconnue: ${action}`,
                    'UNKNOWN_ACTION'
                );
        }
    } catch (error) {
        if (error instanceof HeartbeatServiceError) {
            throw error;
        }

        throw new HeartbeatServiceError(
            `Erreur lors de l'opération de gestion du stockage ${args.action}: ${(error as Error).message}`,
            `STORAGE_${args.action.toUpperCase()}_FAILED`
        );
    }
}

/**
 * Gère les opérations d'inspection du stockage
 */
async function handleStorageAction(
    args: StorageManagementArgs,
    timestamp: string
): Promise<StorageManagementResult> {
    const { storageAction } = args;

    if (!storageAction) {
        throw new HeartbeatServiceError(
            'storageAction requis pour action "storage"',
            'MISSING_STORAGE_ACTION'
        );
    }

    // Déléguer à handleStorageInfo
    const result = await handleStorageInfo({ action: storageAction });

    // Extraire les données du résultat
    const dataText = result.content[0]?.type === 'text' ? result.content[0].text : '';
    let data: any;
    try {
        data = JSON.parse(dataText);
    } catch {
        data = dataText;
    }

    return {
        success: !result.isError,
        action: 'storage',
        subAction: storageAction,
        timestamp,
        message: result.isError ? 'Erreur lors de l\'inspection du stockage' : 'Inspection du stockage réussie',
        data
    };
}

/**
 * Gère les opérations de maintenance du stockage
 */
async function handleMaintenanceAction(
    args: StorageManagementArgs,
    conversationCache: Map<string, ConversationSkeleton> | undefined,
    state: ServerState | undefined,
    timestamp: string
): Promise<StorageManagementResult> {
    const { maintenanceAction } = args;

    if (!maintenanceAction) {
        throw new HeartbeatServiceError(
            'maintenanceAction requis pour action "maintenance"',
            'MISSING_MAINTENANCE_ACTION'
        );
    }

    if (!conversationCache) {
        throw new HeartbeatServiceError(
            'conversationCache requis pour les opérations de maintenance',
            'MISSING_CONVERSATION_CACHE'
        );
    }

    // Déléguer à handleMaintenance avec les bons paramètres
    const maintenanceArgs = {
        action: maintenanceAction,
        force_rebuild: args.force_rebuild,
        workspace_filter: args.workspace_filter,
        task_ids: args.task_ids,
        fix_found: args.fix_found,
        dry_run: args.dry_run
    };

    const result = await handleMaintenance(maintenanceArgs, conversationCache, state);

    // Extraire les données du résultat
    const dataText = result.content[0]?.type === 'text' ? result.content[0].text : '';
    let data: any;
    try {
        data = JSON.parse(dataText);
    } catch {
        data = dataText;
    }

    return {
        success: !result.isError,
        action: 'maintenance',
        subAction: maintenanceAction,
        timestamp,
        message: result.isError ? 'Erreur lors de la maintenance' : 'Maintenance réussie',
        data
    };
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const storageManagementToolMetadata = {
    name: 'roosync_storage_management',
    description: 'Gestion complète du stockage Roo : inspection et maintenance. Actions : storage (detect=localiser stockage, stats=statistiques par workspace), maintenance (cache_rebuild=reconstruire cache conversations, diagnose_bom=diagnostiquer problèmes BOM UTF-8, repair_bom=réparer fichiers corrompus).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            action: {
                type: 'string',
                enum: ['storage', 'maintenance'],
                description: 'Type d\'opération: storage (inspection) ou maintenance (réparation/rebuild)'
            },
            storageAction: {
                type: 'string',
                enum: ['detect', 'stats'],
                description: 'Sous-action pour storage: detect (localiser le stockage Roo) ou stats (statistiques de stockage)'
            },
            maintenanceAction: {
                type: 'string',
                enum: ['cache_rebuild', 'diagnose_bom', 'repair_bom'],
                description: 'Sous-action pour maintenance: cache_rebuild (reconstruire le cache), diagnose_bom (diagnostiquer BOM), repair_bom (réparer BOM)'
            },
            force_rebuild: {
                type: 'boolean',
                description: 'Force la reconstruction complète du cache (maintenance: cache_rebuild)'
            },
            workspace_filter: {
                type: 'string',
                description: 'Filtre par workspace (maintenance: cache_rebuild)'
            },
            task_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Liste d\'IDs de tâches spécifiques à construire (maintenance: cache_rebuild)'
            },
            fix_found: {
                type: 'boolean',
                description: 'Réparer automatiquement les fichiers corrompus trouvés (maintenance: diagnose_bom)'
            },
            dry_run: {
                type: 'boolean',
                description: 'Simuler la réparation sans modifier les fichiers (maintenance: repair_bom)'
            }
        },
        required: ['action'],
        additionalProperties: false
    }
};
