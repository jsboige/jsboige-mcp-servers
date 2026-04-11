/**
 * Outil MCP : index_task_semantic
 * Indexe une tâche dans Qdrant
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { ClaudeStorageDetector } from '../../utils/claude-storage-detector.js';
import { GenericError, GenericErrorCode } from '../../types/errors.js';

export interface IndexTaskSemanticArgs {
    task_id: string;
    source?: 'roo' | 'claude-code';
}

/**
 * Définition de l'outil MCP index_task_semantic
 */
export const indexTaskSemanticTool = {
    definition: {
        name: 'index_task_semantic',
        description: 'Indexe une tâche spécifique dans Qdrant pour la recherche sémantique.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                task_id: {
                    type: 'string',
                    description: 'ID de la tâche à indexer.'
                },
            },
            required: ['task_id'],
        }
    },

    /**
     * Handler d'indexation d'une tâche
     */
    handler: async (
        args: IndexTaskSemanticArgs,
        conversationCache: Map<string, ConversationSkeleton>,
        ensureCacheFreshCallback: () => Promise<boolean>
    ): Promise<CallToolResult> => {
        try {
            const { task_id } = args;
            const source = args.source || 'roo';

            // **FAILSAFE: Auto-rebuild cache si nécessaire**
            await ensureCacheFreshCallback();

            // Vérification des variables d'environnement
            // EMBEDDING_API_KEY is preferred (self-hosted vLLM), OPENAI_API_KEY as fallback
            const embeddingKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
            const qdrantUrl = process.env.QDRANT_URL;
            const qdrantCollection = process.env.QDRANT_COLLECTION_NAME;

            if (!embeddingKey) {
                throw new GenericError('No embedding API key configured. Set EMBEDDING_API_KEY (preferred) or OPENAI_API_KEY.', GenericErrorCode.INVALID_ARGUMENT);
            }

            let taskPath: string | undefined;

            if (source === 'claude-code') {
                // #852: Pour les sessions Claude Code, utiliser ClaudeStorageDetector
                const claudeConversation = await ClaudeStorageDetector.findConversationById(task_id);
                taskPath = claudeConversation?.metadata?.dataSource;

                if (!taskPath) {
                    throw new GenericError(
                        `Claude Code session '${task_id}' not found. Check that the session exists in ~/.claude/projects/*/sessions/`,
                        GenericErrorCode.FILE_SYSTEM_ERROR
                    );
                }
            } else {
                // Pour les tâches Roo, utiliser le cache + RooStorageDetector
                const skeleton = conversationCache.get(task_id);
                if (!skeleton) {
                    throw new GenericError(`Task with ID '${task_id}' not found in cache.`, GenericErrorCode.INVALID_ARGUMENT);
                }

                const conversation = await RooStorageDetector.findConversationById(task_id);
                taskPath = conversation?.path;
            }

            if (!taskPath) {
                throw new GenericError(`Task directory for '${task_id}' not found in any storage location.`, GenericErrorCode.FILE_SYSTEM_ERROR);
            }

            console.log(`[DEBUG] Attempting to import indexTask from task-indexer.js`);
            const { indexTask } = await import('../../services/task-indexer.js');
            console.log(`[DEBUG] Import successful, calling indexTask with taskId=${task_id}, taskPath=${taskPath}, source=${source}`);
            const indexedPoints = await indexTask(task_id, taskPath, source);
            console.log(`[DEBUG] indexTask completed, returned ${indexedPoints.length} points`);

            return {
                content: [{
                    type: "text",
                    text: `# Indexation sémantique terminée\n\n**Tâche:** ${task_id}\n**Source:** ${source}\n**Chemin:** ${taskPath}\n**Chunks indexés:** ${indexedPoints.length}\n\n**Variables d'env:**\n- EMBEDDING_API_KEY: ${embeddingKey ? 'SET' : 'MISSING'}\n- QDRANT_URL: ${qdrantUrl || 'MISSING'}\n- QDRANT_COLLECTION: ${qdrantCollection || 'MISSING'}`
                }]
            };
        } catch (error) {
            console.error('Task indexing error:', error);
            // #1273: Set isError=true so MCP client knows indexing actually failed
            return {
                isError: true,
                content: [{
                    type: "text",
                    text: `# Erreur d'indexation\n\n**Tâche:** ${args.task_id}\n**Erreur:** ${error instanceof Error ? error.message : String(error)}\n\nL'indexation de la tâche a échoué.`
                }]
            };
        }
    }
};
