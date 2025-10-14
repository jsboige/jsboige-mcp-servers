/**
 * Outil MCP : get_storage_stats
 * Calcule des statistiques sur le stockage Roo
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { Tool } from '../../types/tool-definitions.js';

/**
 * Définition de l'outil get_storage_stats
 */
export const getStorageStatsTool: Tool = {
    definition: {
        name: 'get_storage_stats',
        description: 'Calcule des statistiques sur le stockage (nombre de conversations, taille totale).',
        inputSchema: {
            type: 'object',
            properties: {},
            required: []
        }
    },
    handler: handleGetStorageStats
};

/**
 /**
  * Handler pour get_storage_stats
  * Calcule des statistiques enrichies sur le stockage
  */
 async function handleGetStorageStats(args: Record<string, never>): Promise<CallToolResult> {
     const stats = await RooStorageDetector.getStorageStats();
     
     // 🔧 FIX CRITIQUE: Calculer breakdown cohérent avec le total
     // Au lieu d'utiliser seulement le cache mémoire, on scanne directement le disque
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