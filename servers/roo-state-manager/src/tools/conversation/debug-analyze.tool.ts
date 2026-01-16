/**
 * Outil pour analyser et retourner les données brutes d'une conversation
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { GenericError, GenericErrorCode } from '../../types/errors.js';

/**
 * Définition de l'outil debug_analyze_conversation
 */
export const debugAnalyzeTool = {
    definition: {
        name: 'debug_analyze_conversation',
        description: 'Debug tool to analyze a single conversation and return raw data.',
        inputSchema: {
            type: 'object',
            properties: {
                taskId: { type: 'string', description: 'The ID of the task to analyze.' }
            },
            required: ['taskId']
        }
    },
    
    /**
     * Handler pour l'outil debug_analyze_conversation
     */
    handler: async (
        args: { taskId: string },
        conversationCache: Map<string, ConversationSkeleton>
    ): Promise<CallToolResult> => {
        const { taskId } = args;
        const skeleton = conversationCache.get(taskId);
        if (skeleton) {
            return { content: [{ type: 'text', text: JSON.stringify(skeleton, null, 2) }] };
        }
        throw new GenericError(`Task with ID '${taskId}' not found in cache.`, GenericErrorCode.INVALID_ARGUMENT);
    }
};