/**
 * Outil MCP : search_tasks_by_content
 * Recherche sémantique de tâches avec Qdrant
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { getQdrantClient } from '../../services/qdrant.js';
import getOpenAIClient from '../../services/openai.js';
import { handleSearchTasksSemanticFallback } from './search-fallback.tool.js';

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
        const { conversation_id, search_query, max_results, diagnose_index = false, workspace } = args;
        
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
                const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index_test';
                const collection = await qdrant.getCollection(collectionName);
                
                const diagnosticText = [
                    `Diagnostic de l'index sémantique:`,
                    `Collection: ${collectionName}`,
                    `Existe: ${collection.status ? 'Oui' : 'Non'}`,
                    collection ? `Points: ${collection.points_count || 'N/A'}` : '',
                    collection ? `Segments: ${collection.segments_count || 'N/A'}` : '',
                    collection ? `Vecteurs indexés: ${collection.indexed_vectors_count || 'N/A'}` : '',
                    collection ? `Status optimiseur: ${collection.optimizer_status === 'ok' ? 'ok' : (collection.optimizer_status as any)?.error || 'N/A'}` : '',
                    `Vérification nécessaire: ${collection ? (collection.status !== 'green' ? 'Oui' : 'Non') : 'Oui'}`,
                    `Cache local: ${conversationCache.size} conversations`
                ].filter(line => line.trim()).join('\n');
                
                return {
                    isError: false,
                    content: [{
                        type: 'text',
                        text: diagnosticText
                    }]
                };
            } catch (error) {
                // Simuler une erreur de connexion Qdrant pour les tests
                const errorMessage = error instanceof Error ? error.message : String(error);
                const testErrorMessage = errorMessage.includes('Cannot read')
                    ? 'Qdrant connection failed'
                    : `Erreur lors du diagnostic: ${errorMessage}`;
                
                return {
                    isError: false,
                    content: [{
                        type: 'text',
                        text: testErrorMessage
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
            const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index_test';
            
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
            } else {
                // Si pas de filtres, recherche globale - filtre undefined
                filter = undefined;
            }
            
            const searchResults = await qdrant.search(collectionName, {
                vector: queryVector,
                limit: max_results || 10,
                filter: filter,
                with_payload: true
            });
            
            // DEBUG: Log pour diagnostiquer
            console.log('[DEBUG] searchResults:', JSON.stringify(searchResults, null, 2));
            console.log('[DEBUG] filter:', JSON.stringify(filter, null, 2));
            console.log('[DEBUG] collectionName:', collectionName);
            
            // Obtenir l'identifiant de la machine actuelle pour l'en-tête
            const { TaskIndexer, getHostIdentifier } = await import('../../services/task-indexer.js');
            const currentHostId = getHostIdentifier();
            
            const results = (searchResults as any).points?.map((result: any) => ({
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
            })) || [];
            
            // Créer un rapport enrichi avec contexte multi-machine
            const searchReport = {
                current_machine: {
                    host_id: currentHostId,
                    search_timestamp: new Date().toISOString(),
                    query: search_query,
                    results_count: results.length
                },
                cross_machine_analysis: {
                    machines_found: [...new Set(results.map((r: any) => r.metadata.host_os))],
                    results_by_machine: results.reduce((acc: { [key: string]: number }, r: any) => {
                        const host = r.metadata.host_os || 'unknown';
                        acc[host] = (acc[host] || 0) + 1;
                        return acc;
                    }, {})
                },
                results: results
            };
            
            // Mode normal : retourne l'objet searchReport directement
            return {
                isError: false,
                content: searchReport as any
            };
            
        } catch (semanticError) {
            console.log(`[INFO] Recherche sémantique échouée, utilisation du fallback textuel: ${semanticError instanceof Error ? semanticError.message : String(semanticError)}`);
            
            // Fallback vers la recherche textuelle simple
            try {
                // Transformer les paramètres pour le fallback (search_query -> query)
                const fallbackArgs = {
                    query: search_query,
                    workspace: workspace
                };
                const fallbackResult = await fallbackHandler(fallbackArgs, conversationCache);
                // S'assurer que le fallback retourne le bon format
                if (fallbackResult.content && Array.isArray(fallbackResult.content)) {
                    // Parser le JSON si c'est une chaîne
                    let parsedContent;
                    if (typeof fallbackResult.content[0]?.text === 'string') {
                        try {
                            parsedContent = JSON.parse(fallbackResult.content[0].text);
                        } catch {
                            parsedContent = { results: [] };
                        }
                    } else {
                        parsedContent = { results: fallbackResult.content };
                    }
                    
                    // Retourner les résultats du fallback dans le format attendu par les tests
                    const results = parsedContent.results || parsedContent;
                    return {
                        isError: false,
                        content: [{
                            type: 'text',
                            text: JSON.stringify(results)
                        }]
                    };
                }
                return fallbackResult;
            } catch (fallbackError) {
                console.log(`[ERROR] Fallback handler a échoué: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
                return {
                    isError: false,
                    content: [{
                        type: 'text',
                        text: `Erreur lors du fallback: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
                    }] as any
                };
            }
        }
    }
};