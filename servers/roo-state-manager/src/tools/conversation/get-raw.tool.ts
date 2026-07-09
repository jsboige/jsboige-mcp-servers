/**
 * Outil pour récupérer le contenu brut d'une conversation (fichiers JSON) sans condensation
 * #252: Added pagination (startMessage/endMessage) and includeToolResults filter.
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { promises as fs } from 'fs';
import path from 'path';
import { GenericError, GenericErrorCode } from '../../types/errors.js';

interface GetRawArgs {
    taskId: string;
    startMessage?: number;
    endMessage?: number;
    includeToolResults?: boolean;
}

/**
 * Définition de l'outil get_raw_conversation
 */
export const getRawConversationTool = {
    definition: {
        name: 'get_raw_conversation',
        description: 'Récupère le contenu brut d\'une conversation (fichiers JSON) sans condensation. #252: Supports pagination via startMessage/endMessage (1-based, post-filter indices) and includeToolResults filter. Validates: positive integers only, start <= end.',
        inputSchema: {
            type: 'object',
            properties: {
                taskId: { type: 'string', description: 'L\'identifiant de la tâche à récupérer.' },
                startMessage: { type: 'number', description: '1-based start index (post-filter). Must be >= 1. Default: 1 (first message).' },
                endMessage: { type: 'number', description: '1-based end index inclusive (post-filter). Must be >= startMessage. Default: last message.' },
                includeToolResults: { type: 'boolean', description: 'Include tool_result AND tool_use blocks. Default: true. When false, both tool calls and results are filtered before pagination is applied.' },
            },
            required: ['taskId'],
        },
    },

    /**
     * Handler pour l'outil get_raw_conversation
     */
    handler: async (args: GetRawArgs): Promise<CallToolResult> => {
        const { taskId, startMessage, endMessage, includeToolResults = true } = args;
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

        // #335 follow-up: Validate pagination parameters
        if (endMessage != null && endMessage <= 0) {
            throw new GenericError(
                `endMessage must be a positive integer, got ${endMessage}.`,
                GenericErrorCode.INVALID_ARGUMENT
            );
        }
        if (startMessage != null && startMessage <= 0) {
            throw new GenericError(
                `startMessage must be a positive integer, got ${startMessage}.`,
                GenericErrorCode.INVALID_ARGUMENT
            );
        }
        if (startMessage != null && endMessage != null && startMessage > endMessage) {
            throw new GenericError(
                `startMessage (${startMessage}) must be <= endMessage (${endMessage}).`,
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

                // #252: Apply pagination and filtering to api_conversation_history
                let apiHistory = apiResult.data;
                const totalMessages = Array.isArray(apiHistory) ? apiHistory.length : 0;
                // #2805: messages removed by the tool-result filter. Captured post-filter,
                // PRE-slice so it does not conflate filter-removal with pagination slice.
                let filteredMessages = 0;

                if (Array.isArray(apiHistory)) {
                    // Filter out tool_result blocks if requested
                    if (!includeToolResults) {
                        apiHistory = apiHistory.filter((msg: any) => {
                            // Keep messages that are not pure tool_result responses
                            if (msg.role === 'tool' || msg.type === 'tool_result') return false;
                            // Filter tool_result content blocks from assistant messages
                            if (Array.isArray(msg.content)) {
                                msg.content = msg.content.filter((block: any) =>
                                    block.type !== 'tool_result' && block.type !== 'tool_use'
                                );
                            }
                            return true;
                        });
                        filteredMessages = totalMessages - apiHistory.length;
                    }

                    // Apply message range (1-based, inclusive)
                    const start = startMessage != null ? Math.max(1, startMessage) - 1 : 0;
                    const end = endMessage != null ? Math.min(apiHistory.length, endMessage) : apiHistory.length;
                    apiHistory = apiHistory.slice(start, end);
                }

                const rawData = {
                    taskId,
                    taskStats: taskStats ? {
                        created: taskStats.birthtime,
                        modified: taskStats.mtime,
                        size: taskStats.size
                    } : null,
                    metadata: metaResult.data,
                    api_conversation_history: apiHistory,
                    ui_messages: uiResult.data,
                    // #252: Pagination metadata
                    pagination: {
                        totalMessages,
                        filteredMessages,
                        note: 'Pagination is post-filter: indices apply to the filtered message list (tool results excluded when includeToolResults=false)',
                        requestedRange: {
                            start: startMessage ?? 1,
                            end: endMessage ?? totalMessages,
                        },
                        returnedMessages: Array.isArray(apiHistory) ? apiHistory.length : 0,
                        includeToolResults,
                    },
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
