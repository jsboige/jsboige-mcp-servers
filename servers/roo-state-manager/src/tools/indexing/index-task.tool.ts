/**
 * Outil MCP : index_task_semantic
 * Indexe une tâche dans Qdrant
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { GenericError, GenericErrorCode } from '../../types/errors.js';

export interface IndexTaskSemanticArgs {
    task_id: string;
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
            
            // **FAILSAFE: Auto-rebuild cache si nécessaire**
            await ensureCacheFreshCallback();
            
            // Vérification des variables d'environnement
            const openaiKey = process.env.OPENAI_API_KEY;
            const qdrantUrl = process.env.QDRANT_URL;
            const qdrantCollection = process.env.QDRANT_COLLECTION_NAME;
            
            console.log(`[DEBUG] Environment check:`);
            console.log(`[DEBUG] OPENAI_API_KEY: ${openaiKey ? 'SET' : 'MISSING'}`);
            console.log(`[DEBUG] QDRANT_URL: ${qdrantUrl || 'MISSING'}`);
            console.log(`[DEBUG] QDRANT_COLLECTION_NAME: ${qdrantCollection || 'MISSING'}`);
            
            if (!openaiKey) {
                throw new GenericError('OPENAI_API_KEY environment variable is required', GenericErrorCode.INVALID_ARGUMENT);
            }
            
            const skeleton = conversationCache.get(task_id);
            if (!skeleton) {
                throw new GenericError(`Task with ID '${task_id}' not found in cache.`, GenericErrorCode.INVALID_ARGUMENT);
            }
            
            const conversation = await RooStorageDetector.findConversationById(task_id);
            const taskPath = conversation?.path;
            
            if (!taskPath) {
                throw new GenericError(`Task directory for '${task_id}' not found in any storage location.`, GenericErrorCode.FILE_SYSTEM_ERROR);
            }
            
            console.log(`[DEBUG] Attempting to import indexTask from task-indexer.js`);
            const { indexTask } = await import('../../services/task-indexer.js');
            console.log(`[DEBUG] Import successful, calling indexTask with taskId=${task_id}, taskPath=${taskPath}`);
            const indexedPoints = await indexTask(task_id, taskPath);
            console.log(`[DEBUG] indexTask completed, returned ${indexedPoints.length} points`);
            
            return {
                content: [{
                    type: "text",
                    text: `# Indexation sémantique terminée\n\n**Tâche:** ${task_id}\n**Chemin:** ${taskPath}\n**Chunks indexés:** ${indexedPoints.length}\n\n**Variables d'env:**\n- OPENAI_API_KEY: ${openaiKey ? 'SET' : 'MISSING'}\n- QDRANT_URL: ${qdrantUrl || 'MISSING'}\n- QDRANT_COLLECTION: ${qdrantCollection || 'MISSING'}`
                }]
            };
        } catch (error) {
            console.error('Task indexing error:', error);
            return {
                content: [{
                    type: "text",
                    text: `# Erreur d'indexation\n\n**Tâche:** ${args.task_id}\n**Erreur:** ${error instanceof Error ? error.stack : String(error)}\n\nL'indexation de la tâche a échoué.`
                }]
            };
        }
    }
};