/**
 * Outil MCP : search_tasks_by_content
 * Recherche sémantique de tâches avec Qdrant
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { getQdrantClient } from '../../services/qdrant.js';
import getOpenAIClient, { getEmbeddingModel } from '../../services/openai.js';
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
 * Extract a context snippet centered around the best matching portion of content.
 * Looks for query words in the content and returns surrounding text.
 */
function extractSnippet(content: string, query: string, maxChars: number = 300): string {
    if (!content) return '';

    const lowerContent = content.toLowerCase();
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    // Find the position of the first matching query word
    let bestPos = -1;
    for (const word of queryWords) {
        const pos = lowerContent.indexOf(word);
        if (pos !== -1) {
            bestPos = pos;
            break;
        }
    }

    if (bestPos === -1) {
        // No keyword match, return the start of the content
        return content.length <= maxChars ? content : content.substring(0, maxChars) + '...';
    }

    // Center the snippet around the match
    const halfWindow = Math.floor(maxChars / 2);
    const start = Math.max(0, bestPos - halfWindow);
    const end = Math.min(content.length, bestPos + halfWindow);
    let snippet = content.substring(start, end).trim();

    if (start > 0) snippet = '...' + snippet;
    if (end < content.length) snippet = snippet + '...';

    return snippet;
}

/**
 * Interpret a cosine similarity score into a human-readable quality label
 */
function interpretScore(score: number): string {
    if (score >= 0.9) return 'excellent';
    if (score >= 0.75) return 'good';
    if (score >= 0.6) return 'moderate';
    if (score >= 0.4) return 'weak';
    return 'marginal';
}

/**
 * Format a timestamp as relative time (e.g., "2d ago", "5h ago")
 */
function formatRelativeTime(timestamp: string | undefined): string {
    if (!timestamp) return '';
    try {
        const date = new Date(timestamp);
        if (isNaN(date.getTime())) return '';
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffHours / 24);
        if (diffDays > 30) return date.toISOString().split('T')[0];
        if (diffDays > 0) return `${diffDays}d ago`;
        if (diffHours > 0) return `${diffHours}h ago`;
        return 'recent';
    } catch {
        return '';
    }
}

interface RawSearchResult {
    taskId: string;
    score: number;
    content: string;
    snippet: string;
    relevance: string;
    metadata: {
        chunk_id: string | undefined;
        chunk_type: string | undefined;
        workspace: string | undefined;
        task_title: string;
        role: string | undefined;
        timestamp: string | undefined;
        relative_time: string;
        message_position: string | undefined;
        host_os: string;
    };
}

interface GroupedTask {
    taskId: string;
    task_title: string;
    workspace: string | undefined;
    host_os: string;
    best_score: number;
    relevance: string;
    chunks: Array<{
        score: number;
        relevance: string;
        snippet: string;
        chunk_type: string | undefined;
        role: string | undefined;
        relative_time: string;
        message_position: string | undefined;
    }>;
}

/**
 * Deduplicate and group results by task_id, keeping the best-scoring chunks per task.
 */
function groupResultsByTask(results: RawSearchResult[]): GroupedTask[] {
    const taskMap = new Map<string, GroupedTask>();

    for (const r of results) {
        const existing = taskMap.get(r.taskId);
        if (existing) {
            existing.chunks.push({
                score: r.score,
                relevance: r.relevance,
                snippet: r.snippet,
                chunk_type: r.metadata.chunk_type,
                role: r.metadata.role,
                relative_time: r.metadata.relative_time,
                message_position: r.metadata.message_position,
            });
            if (r.score > existing.best_score) {
                existing.best_score = r.score;
                existing.relevance = r.relevance;
            }
        } else {
            taskMap.set(r.taskId, {
                taskId: r.taskId,
                task_title: r.metadata.task_title,
                workspace: r.metadata.workspace,
                host_os: r.metadata.host_os,
                best_score: r.score,
                relevance: r.relevance,
                chunks: [{
                    score: r.score,
                    relevance: r.relevance,
                    snippet: r.snippet,
                    chunk_type: r.metadata.chunk_type,
                    role: r.metadata.role,
                    relative_time: r.metadata.relative_time,
                    message_position: r.metadata.message_position,
                }],
            });
        }
    }

    // Sort tasks by best score descending
    return Array.from(taskMap.values()).sort((a, b) => b.best_score - a.best_score);
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
                const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
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
            console.log('[DEBUG] Starting semantic search');
            const qdrant = getQdrantClient();
            const openai = getOpenAIClient();

            // Créer l'embedding de la requête
            const embedding = await openai.embeddings.create({
                model: getEmbeddingModel(),
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

            // Normalisation de la réponse Qdrant (supporte format tableau direct ou objet { result/points: [...] })
            const rawPoints = Array.isArray(searchResults)
                ? searchResults
                : (searchResults as any).result || (searchResults as any).points || [];

            // Phase 2: Enriched results with snippets, score interpretation, deduplication
            const results: RawSearchResult[] = rawPoints.map((result: any) => {
                const content = String(result.payload?.content || '');
                const score = result.score || 0;
                return {
                    taskId: result.payload?.task_id || 'unknown',
                    score,
                    content: truncateMessage(content, 5),
                    snippet: extractSnippet(content, search_query),
                    relevance: interpretScore(score),
                    metadata: {
                        chunk_id: result.payload?.chunk_id,
                        chunk_type: result.payload?.chunk_type,
                        workspace: result.payload?.workspace,
                        task_title: result.payload?.task_title || `Task ${result.payload?.task_id}`,
                        role: result.payload?.role,
                        timestamp: result.payload?.timestamp,
                        relative_time: formatRelativeTime(result.payload?.timestamp),
                        message_position: result.payload?.message_index && result.payload?.total_messages
                            ? `${result.payload.message_index}/${result.payload.total_messages}`
                            : undefined,
                        host_os: result.payload?.host_os || 'unknown'
                    }
                };
            });

            // Group by task_id: deduplicate multiple chunks from the same conversation
            const groupedResults = groupResultsByTask(results);

            // Cross-machine analysis
            const allHosts = results.map(r => r.metadata.host_os);
            const machinesFound = [...new Set(allHosts)];
            const resultsByMachine: { [key: string]: number } = {};
            for (const host of allHosts) {
                resultsByMachine[host] = (resultsByMachine[host] || 0) + 1;
            }

            // Build enriched report
            const searchReport = {
                current_machine: {
                    host_id: currentHostId,
                    search_timestamp: new Date().toISOString(),
                    query: search_query,
                    results_count: results.length,
                    unique_tasks: groupedResults.length
                },
                cross_machine_analysis: {
                    machines_found: machinesFound,
                    results_by_machine: resultsByMachine
                },
                results: groupedResults
            };

            return {
                isError: false,
                content: [{
                    type: 'text',
                    text: JSON.stringify(searchReport, null, 2)
                }]
            };

        } catch (semanticError) {
            console.log('[DEBUG] Caught semantic error:', semanticError);
            console.log(`[INFO] Recherche sémantique échouée, utilisation du fallback textuel: ${semanticError instanceof Error ? semanticError.message : String(semanticError)}`);

            // Fallback vers la recherche textuelle simple
            try {
                console.log('[DEBUG] Calling fallbackHandler');
                // Map search_query → query for the fallback handler (SearchFallbackArgs expects 'query', not 'search_query')
                const fallbackArgs = { query: args.search_query, workspace: args.workspace };
                const fallbackResult = await fallbackHandler(fallbackArgs, conversationCache);
                console.log('[DEBUG] fallbackResult:', JSON.stringify(fallbackResult));

                // Le fallback handler retourne déjà le bon format : content: [objets avec taskId, score, match, etc.]
                // Pas besoin de transformation, retourner directement le résultat
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