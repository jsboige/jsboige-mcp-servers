/**
 * Fonctions utilitaires pour le serveur MCP
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process'; // kept for potential future use
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../types/conversation.js';
import { RooStorageDetector } from './roo-storage-detector.js';
import { OUTPUT_CONFIG } from '../config/server-config.js';
// FIX: Dynamic import to break circular dependency cycle:
// server-helpers → tools/index → roosync/* → RooSyncService → InventoryCollector → server-helpers
// This circular dep causes ESM module evaluation deadlock (Node.js v24).
// Only 2 functions use toolExports, so lazy-loading is safe.
import { GenericError, GenericErrorCode } from '../types/errors.js';

/**
 * Obtenir le chemin du répertoire shared-state RooSync
 *
 * @throws {Error} Si ROOSYNC_SHARED_PATH n'est pas défini
 * @returns {string} Le chemin vers le répertoire shared-state
 */
export function getSharedStatePath(): string {
    // ROOSYNC_SHARED_PATH est OBLIGATOIRE - pas de fallback pour éviter la pollution du dépôt
    if (!process.env.ROOSYNC_SHARED_PATH) {
        throw new Error(
            'ROOSYNC_SHARED_PATH environment variable is not set. ' +
            'This variable is required to prevent file pollution in the repository. ' +
            'Please set ROOSYNC_SHARED_PATH to your Google Drive shared state path.'
        );
    }
    return process.env.ROOSYNC_SHARED_PATH;
}
/**
 * Tronque les résultats trop longs
 */
export function truncateResult(result: CallToolResult): CallToolResult {
    for (const item of result.content) {
        if (item.type === 'text' && item.text.length > OUTPUT_CONFIG.MAX_OUTPUT_LENGTH) {
            item.text = item.text.substring(0, OUTPUT_CONFIG.MAX_OUTPUT_LENGTH) + 
                `\n\n[...]\n\n--- OUTPUT TRUNCATED AT ${OUTPUT_CONFIG.MAX_OUTPUT_LENGTH} CHARACTERS ---`;
        }
    }
    return result;
}

/**
 * Gère la commande touch_mcp_settings
 * Utilise l'API native Node.js pour éviter les problèmes d'échappement PowerShell
 */
export async function handleTouchMcpSettings(): Promise<CallToolResult> {
    try {
        const appDataPath = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        const settingsPath = path.join(appDataPath, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json');

        // SAFETY GUARD: In test environments, reject paths to REAL mcp_settings.json.
        // Incidents: 2026-03-08 (ai-01), 2026-04-03 (po-2023).
        if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
            const isTestPath = appDataPath.includes('__test-data__') ||
                appDataPath.includes('__roo-state-manager-test-appdata__') ||
                appDataPath.includes('mcp-settings-integration') ||
                settingsPath.includes('__test-data__') ||
                appDataPath === 'C:\\Users\\Test\\AppData\\Roaming' ||
                appDataPath.includes('/home/test') ||
                appDataPath.includes('/tmp/');
            if (!isTestPath) {
                throw new Error(
                    `SAFETY ABORT: handleTouchMcpSettings() would touch REAL mcp_settings.json in test mode!\n` +
                    `  Resolved: ${settingsPath}\n` +
                    `  APPDATA: ${process.env.APPDATA || '(unset)'}`
                );
            }
        }
        
        // Vérifier que le fichier existe
        try {
            await fs.access(settingsPath);
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: false,
                        error: `Fichier mcp_settings.json introuvable à : ${settingsPath}`
                    })
                }],
                isError: true
            };
        }
        
        // Toucher le fichier en modifiant son timestamp (atime et mtime)
        const now = new Date();
        await fs.utimes(settingsPath, now, now);
        
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    message: `Fichier mcp_settings.json touché avec succès à ${now.toISOString()}`,
                    path: settingsPath
                })
            }]
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: false,
                    error: `Erreur lors du touch : ${errorMessage}`
                })
            }],
            isError: true
        };
    }
}

/**
 * Gère l'export JSON
 */
export async function handleExportConversationJson(
    args: {
        taskId: string;
        filePath?: string;
        jsonVariant?: 'light' | 'full';
        truncationChars?: number;
    },
    conversationCache: Map<string, ConversationSkeleton>
): Promise<CallToolResult> {
    try {
        const { taskId } = args;
        
        if (!taskId) {
            throw new GenericError("taskId est requis", GenericErrorCode.INVALID_ARGUMENT);
        }

        const conversation = conversationCache.get(taskId);
        if (!conversation) {
            throw new GenericError(`Conversation avec taskId ${taskId} introuvable`, GenericErrorCode.INVALID_ARGUMENT, { taskId });
        }

        const getConversationSkeleton = async (id: string) => {
            return conversationCache.get(id) || null;
        };

        // #1110 FIX: Direct import from sub-module instead of barrel (avoids ESM circular deadlock)
        const { handleExportConversationJson: handleExportJson } = await import('../tools/export/export-conversation-json.js');
        const result = await handleExportJson(args, getConversationSkeleton);

        return {
            content: [{ type: 'text', text: result }]
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
        return {
            content: [{ type: 'text', text: `❌ Erreur lors de l'export JSON: ${errorMessage}` }],
            isError: true
        };
    }
}

/**
 * Gère l'export CSV
 */
export async function handleExportConversationCsv(
    args: {
        taskId: string;
        filePath?: string;
        csvVariant?: 'conversations' | 'messages' | 'tools';
        truncationChars?: number;
    },
    conversationCache: Map<string, ConversationSkeleton>
): Promise<CallToolResult> {
    try {
        const { taskId } = args;
        
        if (!taskId) {
            throw new GenericError("taskId est requis", GenericErrorCode.INVALID_ARGUMENT);
        }

        const conversation = conversationCache.get(taskId);
        if (!conversation) {
            throw new GenericError(`Conversation avec taskId ${taskId} introuvable`, GenericErrorCode.INVALID_ARGUMENT, { taskId });
        }

        const getConversationSkeleton = async (id: string) => {
            return conversationCache.get(id) || null;
        };

        // #1110 FIX: Direct import from sub-module instead of barrel (avoids ESM circular deadlock)
        const { handleExportConversationCsv: handleExportCsv } = await import('../tools/export/export-conversation-csv.js');
        const result = await handleExportCsv(args, getConversationSkeleton);

        return {
            content: [{ type: 'text', text: result }]
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
        return {
            content: [{ type: 'text', text: `❌ Erreur lors de l'export CSV: ${errorMessage}` }],
            isError: true
        };
    }
}