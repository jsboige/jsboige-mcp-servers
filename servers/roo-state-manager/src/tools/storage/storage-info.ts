/**
 * Outil MCP consolidé : storage_info
 *
 * CONS-13: Consolide 2 outils de stockage en 1 outil unifié.
 * Remplace:
 *   - detect_roo_storage
 *   - get_storage_stats
 *
 * @module tools/storage/storage-info
 * @version 1.0.0
 * @since CONS-13
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { Tool } from '../../types/tool-definitions.js';

/**
 * Actions supportées par storage_info
 */
export type StorageInfoAction = 'detect' | 'stats';

/**
 * Arguments consolidés du tool storage_info
 */
export interface StorageInfoArgs {
    /** Action à effectuer: detect (localiser le stockage) ou stats (statistiques) */
    action: StorageInfoAction;
}

/**
 * Définition de l'outil storage_info
 */
export const storageInfoTool: Tool<StorageInfoArgs> = {
    definition: {
        name: 'storage_info',
        description: 'Informations sur le stockage Roo. action=detect pour localiser, action=stats pour les statistiques.',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['detect', 'stats'],
                    description: 'Action: detect (localiser le stockage Roo) ou stats (statistiques de stockage).'
                }
            },
            required: ['action']
        }
    },
    handler: handleStorageInfo
};

/**
 * Handler consolidé pour storage_info
 */
export async function handleStorageInfo(args: StorageInfoArgs): Promise<CallToolResult> {
    const { action } = args;

    switch (action) {
        case 'detect':
            return handleDetect();
        case 'stats':
            return handleStats();
        default:
            return {
                content: [{
                    type: 'text',
                    text: `Action inconnue: '${action}'. Actions valides: detect, stats.`
                }],
                isError: true
            };
    }
}

/**
 * Détecte les emplacements de stockage Roo (ex detect_roo_storage)
 */
async function handleDetect(): Promise<CallToolResult> {
    const result = await RooStorageDetector.detectRooStorage();
    return {
        content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2)
        }]
    };
}

/**
 * Calcule les statistiques de stockage (ex get_storage_stats)
 */
async function handleStats(): Promise<CallToolResult> {
    const stats = await RooStorageDetector.getStorageStats();

    // FIX CRITIQUE: Calculer breakdown cohérent avec le total
    const workspaceBreakdown = await RooStorageDetector.getWorkspaceBreakdown();

    const enhancedStats = {
        ...stats,
        workspaceBreakdown,
        totalWorkspaces: Object.keys(workspaceBreakdown).length
    };

    return {
        content: [{
            type: 'text',
            text: JSON.stringify(enhancedStats, null, 2)
        }]
    };
}
