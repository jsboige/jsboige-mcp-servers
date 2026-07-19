/**
 * Outil MCP : reset_qdrant_collection
 * Réinitialise la collection Qdrant
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { TaskIndexer } from '../../services/task-indexer.js';

export interface ResetQdrantCollectionArgs {
    confirm?: boolean;
    force?: boolean;
}

/**
 * Définition de l'outil MCP reset_qdrant_collection
 */
export const resetQdrantCollectionTool = {
    definition: {
        name: 'reset_qdrant_collection',
        description: 'Réinitialise complètement la collection Qdrant et supprime tous les timestamps d\'indexation des squelettes pour forcer une réindexation complète. Garde-fou flotte : si la collection contient plus de RESET_SAFETY_FLOOR points, la suppression est REFUSÉE sauf si force=true (évite les wipes accidentels de la collection de production — P1 récidiviste 2026-07-13/18).',
        inputSchema: {
            type: 'object' as const,
            properties: {
                confirm: {
                    type: 'boolean',
                    description: 'Confirmation obligatoire pour supprimer la collection.',
                    default: false
                },
                force: {
                    type: 'boolean',
                    description: 'Requis pour wiper une collection PEUPLÉE (> RESET_SAFETY_FLOOR points). Sans force=true, une grosse collection déclenche un refus explicite au lieu d\'un drop silencieux.',
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

            // Supprimer et recréer la collection Qdrant.
            // force est distinct de confirm : confirm autorise la tentative, force autorise
            // le wipe d'une collection peuplée (garde-fou flotte contre le P1 récidiviste).
            await taskIndexer.resetCollection({ force: args.force });
            
            // Marquer tous les squelettes comme non-indexés
            // Fix #2209: Reset BOTH legacy qdrantIndexedAt AND modern indexingState.
            // Before this fix, only qdrantIndexedAt was cleared — skeletons with
            // indexingState.indexStatus='success' and nextReindexAfter in the future
            // were skipped by shouldIndex(), preventing re-indexation after a reset.
            let skeletonsReset = 0;
            for (const [taskId, skeleton] of conversationCache.entries()) {
                let modified = false;

                // Reset legacy field
                if (skeleton.metadata.qdrantIndexedAt) {
                    delete skeleton.metadata.qdrantIndexedAt;
                    modified = true;
                }

                // Reset modern indexingState (keeps indexVersion only)
                if (skeleton.metadata.indexingState) {
                    skeleton.metadata.indexingState = {
                        indexVersion: skeleton.metadata.indexingState.indexVersion,
                    };
                    modified = true;
                }

                if (modified) {
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