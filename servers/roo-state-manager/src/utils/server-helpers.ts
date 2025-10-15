/**
 * Fonctions utilitaires pour le serveur MCP
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../types/conversation.js';
import { RooStorageDetector } from './roo-storage-detector.js';
import { OUTPUT_CONFIG } from '../config/server-config.js';
import * as toolExports from '../tools/index.js';

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
            throw new Error("taskId est requis");
        }

        const conversation = conversationCache.get(taskId);
        if (!conversation) {
            throw new Error(`Conversation avec taskId ${taskId} introuvable`);
        }

        const getConversationSkeleton = async (id: string) => {
            return conversationCache.get(id) || null;
        };

        const result = await toolExports.handleExportConversationJson(args, getConversationSkeleton);

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
            throw new Error("taskId est requis");
        }

        const conversation = conversationCache.get(taskId);
        if (!conversation) {
            throw new Error(`Conversation avec taskId ${taskId} introuvable`);
        }

        const getConversationSkeleton = async (id: string) => {
            return conversationCache.get(id) || null;
        };

        const result = await toolExports.handleExportConversationCsv(args, getConversationSkeleton);

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