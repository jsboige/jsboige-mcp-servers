/**
 * Outil pour récupérer le contenu brut d'une conversation (fichiers JSON) sans condensation
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { promises as fs } from 'fs';
import path from 'path';
import { GenericError, GenericErrorCode } from '../../types/errors.js';

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
            throw new GenericError("taskId is required.", GenericErrorCode.INVALID_ARGUMENT);
        }

        // Security: Reject path traversal attempts (check before format to prevent bypass)
        if (taskId.includes('..') || taskId.includes('/') || taskId.includes('\\')) {
            throw new GenericError(
                `Invalid taskId: path separators and parent directory references are not allowed.`,
                GenericErrorCode.INVALID_ARGUMENT
            );
        }

        // Security: Validate taskId format — must be UUID or claude- prefixed session ID
        const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const CLAUDE_SESSION_REGEX = /^claude-[a-zA-Z0-9_.\-/]+--[a-zA-Z0-9\-]+$/;
        if (!UUID_REGEX.test(taskId) && !CLAUDE_SESSION_REGEX.test(taskId)) {
            throw new GenericError(
                `Invalid taskId format: '${taskId.slice(0, 20)}...'. Expected UUID or claude- session ID.`,
                GenericErrorCode.INVALID_ARGUMENT
            );
        }

        const locations = await RooStorageDetector.detectStorageLocations();
        const parseErrors: string[] = [];

        for (const loc of locations) {
            const taskPath = path.join(loc, 'tasks', taskId);
            try {
                await fs.access(taskPath);

                const apiHistoryPath = path.join(taskPath, 'api_conversation_history.json');
                const uiMessagesPath = path.join(taskPath, 'ui_messages.json');
                const metadataPath = path.join(taskPath, 'task_metadata.json');

                // Read JSON files with proper error reporting
                const readJsonFile = async (filePath: string, label: string) => {
                    try {
                        let content = await fs.readFile(filePath, 'utf-8');
                        if (content.charCodeAt(0) === 0xFEFF) {
                            content = content.slice(1);
                        }
                        return { data: JSON.parse(content), error: null as string | null };
                    } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        parseErrors.push(`${label}: ${msg}`);
                        return { data: null, error: msg };
                    }
                };

                const apiResult = await readJsonFile(apiHistoryPath, 'api_conversation_history');
                const uiResult = await readJsonFile(uiMessagesPath, 'ui_messages');
                const metaResult = await readJsonFile(metadataPath, 'metadata');

                const taskStats = await fs.stat(taskPath).catch(() => null);

                const rawData = {
                    taskId,
                    taskStats: taskStats ? {
                        created: taskStats.birthtime,
                        modified: taskStats.mtime,
                        size: taskStats.size
                    } : null,
                    metadata: metaResult.data,
                    api_conversation_history: apiResult.data,
                    ui_messages: uiResult.data,
                    ...(parseErrors.length > 0 ? { _parseErrors: parseErrors } : {}),
                };

                return { content: [{ type: 'text', text: JSON.stringify(rawData, null, 2) }] };
            } catch {
                // Task not found in this location, continue
            }
        }

        throw new GenericError(
            `Task '${taskId}' not found in any storage location.${parseErrors.length > 0 ? ` Parse errors: ${parseErrors.join('; ')}` : ''}`,
            GenericErrorCode.FILE_SYSTEM_ERROR
        );
    }
};