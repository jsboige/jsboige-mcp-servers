/**
 * Outil pour récupérer le contenu brut d'une conversation (fichiers JSON) sans condensation
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Définition de l'outil get_raw_conversation
 */
export const getRawConversationTool = {
    definition: {
        name: 'get_raw_conversation',
        description: 'Récupère le contenu brut d\'une conversation (fichiers JSON) sans condensation.',
        inputSchema: {
            type: 'object',
            properties: {
                taskId: { type: 'string', description: 'L\'identifiant de la tâche à récupérer.' },
            },
            required: ['taskId'],
        },
    },
    
    /**
     * Handler pour l'outil get_raw_conversation
     */
    handler: async (args: { taskId: string }): Promise<CallToolResult> => {
        const { taskId } = args;
        if (!taskId) {
            throw new Error("taskId is required.");
        }

        const locations = await RooStorageDetector.detectStorageLocations();
        for (const loc of locations) {
            // 🚨 BUG FIX: Ajouter 'tasks' au chemin pour correspondre à la structure réelle
            const taskPath = path.join(loc, 'tasks', taskId);
            try {
                await fs.access(taskPath); // Vérifie si le répertoire de la tâche existe

                const apiHistoryPath = path.join(taskPath, 'api_conversation_history.json');
                const uiMessagesPath = path.join(taskPath, 'ui_messages.json');

                // 🚨 BUG FIX: Gérer les BOM UTF-8 qui causent des erreurs de parsing JSON
                const readJsonFileClean = async (filePath: string) => {
                    try {
                        let content = await fs.readFile(filePath, 'utf-8');
                        // Nettoyer le BOM UTF-8 si présent
                        if (content.charCodeAt(0) === 0xFEFF) {
                            content = content.slice(1);
                        }
                        return JSON.parse(content);
                    } catch (e) {
                        return null;
                    }
                };

                const apiHistoryContent = await readJsonFileClean(apiHistoryPath);
                const uiMessagesContent = await readJsonFileClean(uiMessagesPath);

                // 🚨 BUG FIX: Ajouter des métadonnées sur le fichier pour diagnostic
                const taskStats = await fs.stat(taskPath).catch(() => null);
                const metadataPath = path.join(taskPath, 'task_metadata.json');
                const metadataContent = await readJsonFileClean(metadataPath);

                const rawData = {
                    taskId,
                    location: taskPath,
                    taskStats: taskStats ? {
                        created: taskStats.birthtime,
                        modified: taskStats.mtime,
                        size: taskStats.size
                    } : null,
                    metadata: metadataContent,
                    api_conversation_history: apiHistoryContent,
                    ui_messages: uiMessagesContent,
                };

                return { content: [{ type: 'text', text: JSON.stringify(rawData, null, 2) }] };
            } catch (e) {
                // Tâche non trouvée dans cet emplacement, on continue
                console.debug(`[DEBUG] Task ${taskId} not found in ${taskPath}: ${e}`);
            }
        }

        throw new Error(`Task with ID '${taskId}' not found in any storage location.`);
    }
};