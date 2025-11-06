/**
 * Outil MCP : search_tasks_by_content
 * Recherche sémantique de tâches avec Qdrant
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { getQdrantClient } from '../../services/qdrant.js';
import getOpenAIClient from '../../services/openai.js';

export interface SearchTasksByContentArgs {
    conversation_id?: string;
    search_query: string;
    max_results?: number;
    diagnose_index?: boolean;
    workspace?: string;
}

/**
 * Helper pour tronquer les messages
 */
function truncateMessage(message: string, truncate: number): string {
    if (!message || truncate === 0) {
        return message;
    }
    const lines = message.split('\n');
    if (lines.length <= truncate * 2) {
        return message;
    }
    const start = lines.slice(0, truncate).join('\n');
    const end = lines.slice(-truncate).join('\n');
    return `${start}\n[...]\n${end}`;
}

/**
 * Définition de l'outil MCP search_tasks_by_content
 */
export const searchTasksByContentTool = {
    definition: {
        name: 'search_tasks_by_content',
        description: 'Recherche des tâches par contenu sémantique avec filtrage par workspace et métadonnées enrichies.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                conversation_id: { 
                    type: 'string', 
                    description: 'ID de la conversation à fouiller.' 
                },
                search_query: { 
                    type: 'string', 
                    description: 'La requête de recherche sémantique.' 
                },
                max_results: { 
                    type: 'number', 
                    description: 'Nombre maximum de résultats à retourner.' 
                },
                workspace: { 
                    type: 'string', 
                    description: 'Filtre les résultats par workspace spécifique.' 
                },
                diagnose_index: { 
                    type: 'boolean', 
                    description: 'Mode diagnostic : retourne des informations sur l\'état de l\'indexation sémantique.' 
                },
            },
            required: ['search_query'],
        }
    },

    /**
     * Handler principal de recherche par contenu
     */
    handler: async (
        args: SearchTasksByContentArgs,
        conversationCache: Map<string, ConversationSkeleton>,
        ensureCacheFreshCallback: (args?: { workspace?: string }) => Promise<boolean>,
        fallbackHandler: (args: any, cache: Map<string, ConversationSkeleton>) => Promise<CallToolResult>,
        diagnoseHandler?: () => Promise<CallToolResult>
    ): Promise<CallToolResult> => {
        const { conversation_id, search_query, max_results = 10, diagnose_index = false, workspace } = args;
        
        // **FAILSAFE: Auto-rebuild cache si nécessaire avec filtre workspace**
        await ensureCacheFreshCallback({ workspace });
        
        // Mode diagnostic - retourne des informations sur l'état de l'indexation
        if (diagnose_index) {
            if (diagnoseHandler) {
                return await diagnoseHandler();
            }
            
            // Fallback si pas de diagnoseHandler fourni
            try {
                const qdrant = getQdrantClient();
                const collections = await qdrant.getCollections();
                const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
                const collection = collections.collections.find(c => c.name === collectionName);
                
                return {
                    content: [{
                        type: 'text',
                        text: `Diagnostic de l'index sémantique:\n- Collection: ${collectionName}\n- Existe: ${collection ? 'Oui' : 'Non'}\n- Points: ${collection ? 'Vérification nécessaire' : 'N/A'}\n- Cache local: ${conversationCache.size} conversations`
                    }]
                };
            } catch (error) {
                return {
                    content: [{
                        type: 'text',
                        text: `Erreur lors du diagnostic: ${error instanceof Error ? error.message : String(error)}`
                    }]
                };
            }
        }

        // Tentative de recherche sémantique via Qdrant/OpenAI
        try {
            const qdrant = getQdrantClient();
            const openai = getOpenAIClient();
            
            // Créer l'embedding de la requête
            const embedding = await openai.embeddings.create({
                model: 'text-embedding-3-small',
                input: search_query
            });
            
            const queryVector = embedding.data[0].embedding;
            const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
            
            // Configuration de la recherche selon conversation_id et workspace
            let filter;
            const filterConditions = [];
            
            if (conversation_id && conversation_id !== 'undefined') {
                filterConditions.push({
                    key: "task_id",
                    match: {
                        value: conversation_id
                    }
                });
            }
            
            if (workspace) {
                filterConditions.push({
                    key: "workspace",
                    match: {
                        value: workspace
                    }
                });
            }
            
            if (filterConditions.length > 0) {
                filter = {
                    must: filterConditions
                };
            }
            // Si pas de filtres, recherche globale
            
            const searchResults = await qdrant.search(collectionName, {
                vector: queryVector,
                limit: max_results,
                filter: filter,
                with_payload: true
            });
            
            // Obtenir l'identifiant de la machine actuelle pour l'en-tête
            const { TaskIndexer, getHostIdentifier } = await import('../../services/task-indexer.js');
            const taskIndexer = new TaskIndexer();
            const currentHostId = getHostIdentifier();
            
            const results = searchResults.map(result => ({
                taskId: result.payload?.task_id || 'unknown',
                score: result.score || 0,
                match: truncateMessage(String(result.payload?.content || 'No content'), 2),
                metadata: {
                    chunk_id: result.payload?.chunk_id,
                    chunk_type: result.payload?.chunk_type,
                    workspace: result.payload?.workspace,
                    task_title: result.payload?.task_title || `Task ${result.payload?.task_id}`,
                    message_index: result.payload?.message_index,
                    total_messages: result.payload?.total_messages,
                    role: result.payload?.role,
                    timestamp: result.payload?.timestamp,
                    message_position: result.payload?.message_index && result.payload?.total_messages
                        ? `${result.payload.message_index}/${result.payload.total_messages}`
                        : undefined,
                    host_os: result.payload?.host_os || 'unknown'
                }
            }));
            
            // Créer un rapport enrichi avec contexte multi-machine
            const searchReport = {
                current_machine: {
                    host_id: currentHostId,
                    search_timestamp: new Date().toISOString(),
                    query: search_query,
                    results_count: results.length
                },
                cross_machine_analysis: {
                    machines_found: [...new Set(results.map(r => r.metadata.host_os))],
                    results_by_machine: results.reduce((acc: { [key: string]: number }, r: any) => {
                        const host = r.metadata.host_os || 'unknown';
                        acc[host] = (acc[host] || 0) + 1;
                        return acc;
                    }, {})
                },
                results: results
            };
            
            return { content: [{ type: 'text', text: JSON.stringify(searchReport, null, 2) }] };
            
        } catch (semanticError) {
            console.log(`[INFO] Recherche sémantique échouée, utilisation du fallback textuel: ${semanticError instanceof Error ? semanticError.message : String(semanticError)}`);
            
            // Fallback vers la recherche textuelle simple
            return await fallbackHandler(args, conversationCache);
        }
    }
};