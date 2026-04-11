/**
 * Outil MCP : reset_qdrant_collection
 * Réinitialise la collection Qdrant
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { TaskIndexer } from '../../services/task-indexer.js';

export interface ResetQdrantCollectionArgs {
    confirm?: boolean;
}

/**
 * Définition de l'outil MCP reset_qdrant_collection
 */
export const resetQdrantCollectionTool = {
    definition: {
        name: 'reset_qdrant_collection',
        description: 'Réinitialise complètement la collection Qdrant et supprime tous les timestamps d\'indexation des squelettes pour forcer une réindexation complète.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                confirm: { 
                    type: 'boolean', 
                    description: 'Confirmation obligatoire pour supprimer la collection.', 
                    default: false 
                },
            },
            required: [],
        }
    },

    /**
     * Handler de réinitialisation de la collection Qdrant
     */
    handler: async (
        args: ResetQdrantCollectionArgs,
        conversationCache: Map<string, ConversationSkeleton>,
        saveSkeletonCallback: (skeleton: ConversationSkeleton) => Promise<void>,
        qdrantIndexQueue: Set<string>,
        setQdrantIndexingEnabled: (enabled: boolean) => void
    ): Promise<CallToolResult> => {
        try {
            // Confirmation obligatoire avant opération destructive
            if (!args.confirm) {
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            success: false,
                            message: 'Confirmation requise. Passez confirm: true pour réinitialiser la collection Qdrant.'
                        }, null, 2)
                    }]
                };
            }

            const taskIndexer = new TaskIndexer();
            
            // Supprimer et recréer la collection Qdrant
            await taskIndexer.resetCollection();
            
            // Marquer tous les squelettes comme non-indexés
            let skeletonsReset = 0;
            for (const [taskId, skeleton] of conversationCache.entries()) {
                if (skeleton.metadata.qdrantIndexedAt) {
                    delete skeleton.metadata.qdrantIndexedAt;
                    await saveSkeletonCallback(skeleton);
                    skeletonsReset++;
                }
                // Ajouter à la queue pour réindexation
                qdrantIndexQueue.add(taskId);
            }
            
            // Réactiver le service s'il était désactivé
            setQdrantIndexingEnabled(true);
            
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        success: true,
                        message: `Collection Qdrant réinitialisée avec succès`,
                        skeletonsReset,
                        queuedForReindexing: qdrantIndexQueue.size
                    }, null, 2)
                }]
            };
        } catch (error: any) {
            console.error('Erreur lors de la réinitialisation de Qdrant:', error);
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        success: false,
                        message: `Erreur lors de la réinitialisation: ${error.message}`
                    }, null, 2)
                }]
            };
        }
    }
};