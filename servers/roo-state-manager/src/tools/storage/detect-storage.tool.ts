/**
 * Outil MCP : detect_roo_storage
 * Détecte automatiquement les emplacements de stockage Roo
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { Tool } from '../../types/tool-definitions.js';

/**
 * Définition de l'outil detect_roo_storage
 */
export const detectStorageTool: Tool = {
    definition: {
        name: 'detect_roo_storage',
        description: 'Détecte automatiquement les emplacements de stockage Roo et scanne les conversations existantes',
        inputSchema: {
            type: 'object',
            properties: {},
            required: []
        }
    },
    handler: handleDetectRooStorage
};

/**
 * Handler pour detect_roo_storage
 * Détecte les emplacements de stockage Roo
 */
async function handleDetectRooStorage(args: Record<string, never>): Promise<CallToolResult> {
    const result = await RooStorageDetector.detectRooStorage();
    return {
        content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2)
        }]
    };
}