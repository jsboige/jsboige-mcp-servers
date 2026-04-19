/**
 * Outil MCP : search_tasks_by_content
 * Recherche sémantique de tâches avec Qdrant
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { getQdrantClient } from '../../services/qdrant.js';
import getOpenAIClient, { getEmbeddingModel } from '../../services/openai.js';
import { handleSearchTasksSemanticFallback } from './search-fallback.tool.js';
import { getHostIdentifier } from '../../services/task-indexer/ChunkExtractor.js';
import { parseFilterDate, isWithinDateRange } from '../../utils/date-filters.js';

// #1232: Circuit breaker for embedding API failures
// When the embedding API returns 502/503, skip semantic search and go directly to text fallback
// for EMBEDDING_CIRCUIT_BREAKER_TTL_MS (default 5 minutes) to avoid repeated timeouts.
let lastEmbeddingFailureTime = 0;
const EMBEDDING_CIRCUIT_BREAKER_TTL_MS = parseInt(process.env.EMBEDDING_CIRCUIT_BREAKER_TTL_MS || '300000');

/**
 * Check if an error is an HTTP 5xx server error (eligible for circuit breaker).
 * Only activates on real server errors, not generic exceptions.
 */
function isHttpServerError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const msg = error.message;
    return /\b5[0-9]{2}\b/.test(msg) || msg.includes('Bad Gateway') || msg.includes('Service Unavailable') || msg.includes('Gateway Timeout');
}

/**
 * Reset the circuit breaker state (for testing).
 * @internal
 */
export function _resetEmbeddingCircuitBreaker(): void {
    lastEmbeddingFailureTime = 0;
}

export interface SearchTasksByContentArgs {
    conversation_id?: string;
    search_query: string;
    max_results?: number;
    diagnose_index?: boolean;
    workspace?: string;
    source?: 'roo' | 'claude-code';
    // #636: Advanced filters
    chunk_type?: 'message_exchange' | 'tool_interaction';
    role?: 'user' | 'assistant';
    tool_name?: string;
    has_errors?: boolean;
    model?: string;
    // #636 Phase 2: Temporal filters
    start_date?: string;
    end_date?: string;
    // #636 Phase 3: Convenience filter
    /** Exclude tool_interaction chunks, returning only message_exchange chunks */
    exclude_tool_results?: boolean;
    // #1496: When true, propagate semantic errors instead of silently falling
    // back to text search. Used by `roosync_search(action: "semantic")` so the
    // caller gets a clear signal when the embedding backend is down, rather
    // than returning `searchType: "text"` without warning. Default: false
    // (legacy behavior preserved for direct `searchTasks` callers).
    strict_mode?: boolean;
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
function extractSnippet(content: string, query: string, maxChars: number = 600): string {
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

// #1244 Couche 2.1 — parseFilterDate / isWithinDateRange factorises dans
// `src/utils/date-filters.ts` pour reutilisation par list-conversations,
// conversation-browser, summarize, etc. Importes en haut du fichier.

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
        // #636: Enriched metadata
        source: string | undefined;
        tool_name: string | undefined;
        model: string | undefined;
        has_error: boolean | undefined;
    };
}

interface GroupedTask {
    taskId: string;
    task_title: string;
    workspace: string | undefined;
    host_os: string;
    best_score: number;
    relevance: string;
    // #636: Enriched task-level metadata
    source: string | undefined;
    model: string | undefined;
    // #636 Phase 2: Conversation-level statistics
    conversation_stats?: {
        total_messages: number;
        workspace: string | undefined;
        last_activity: string | undefined;
    };
    chunks: Array<{
        score: number;
        relevance: string;
        snippet: string;
        chunk_type: string | undefined;
        role: string | undefined;
        relative_time: string;
        message_position: string | undefined;
        // #636: Enriched chunk-level metadata
        tool_name: string | undefined;
        has_error: boolean | undefined;
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
                tool_name: r.metadata.tool_name,
                has_error: r.metadata.has_error,
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
                source: r.metadata.source,
                model: r.metadata.model,
                chunks: [{
                    score: r.score,
                    relevance: r.relevance,
                    snippet: r.snippet,
                    chunk_type: r.metadata.chunk_type,
                    role: r.metadata.role,
                    relative_time: r.metadata.relative_time,
                    message_position: r.metadata.message_position,
                    tool_name: r.metadata.tool_name,
                    has_error: r.metadata.has_error,
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
                source: {
                    type: 'string',
                    enum: ['roo', 'claude-code'],
                    description: 'Filtre les résultats par source (tâches Roo ou sessions Claude Code).'
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
        const { conversation_id, search_query, max_results, diagnose_index = false, workspace, source,
                chunk_type, role, tool_name, has_errors, model, start_date, end_date, exclude_tool_results } = args;

        // #636 Phase 3: resolve effective chunk_type (exclude_tool_results is a convenience alias)
        const effectiveChunkType = chunk_type ?? (exclude_tool_results ? 'message_exchange' : undefined);

        // #883 P0: Skip cache refresh for semantic searches — the skeleton cache is NOT used
        // for Qdrant vector search, only for post-search enrichment. The ensureCacheFreshCallback
        // scans ALL task directories (I/O heavy, ~70s with thousands of tasks), which is the
        // root cause of roosync_search being slow. Cache refresh is only needed for text fallback.
        // await ensureCacheFreshCallback({ workspace }); // REMOVED: #883

        // #883: Workspace filter is now auto-defaulted by roosync_search.
        // If still empty here, it means global search was requested explicitly.
        if (!workspace) {
            console.warn('[INFO] Global semantic search (no workspace filter). May be slower on large collections.');
        }

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

        // #1232: Circuit breaker — if embedding API failed recently, skip directly to text fallback
        const now = Date.now();
        if (lastEmbeddingFailureTime > 0 && (now - lastEmbeddingFailureTime) < EMBEDDING_CIRCUIT_BREAKER_TTL_MS) {
            const remainingMs = EMBEDDING_CIRCUIT_BREAKER_TTL_MS - (now - lastEmbeddingFailureTime);
            console.warn(`[WARN] #1232: Embedding circuit breaker active, skipping semantic search (${Math.ceil(remainingMs / 1000)}s remaining). Using text fallback.`);
            try {
                const fallbackResult = await fallbackHandler(
                    { query: args.search_query, workspace: args.workspace },
                    conversationCache
                );
                return fallbackResult;
            } catch (fallbackError) {
                return {
                    isError: false,
                    content: [{
                        type: 'text',
                        text: `Embedding API indisponible (circuit breaker actif). Fallback textuel échoué: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
                    }] as any
                };
            }
        }

        // Tentative de recherche sémantique via Qdrant/OpenAI
        try {
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

            // #883: Dual workspace fields in Qdrant:
            // - "workspace": full path (d:\roo-extensions) — for intra-machine exact match
            // - "workspace_name": basename (roo-extensions) — for cross-machine filtering
            // If caller passes a basename → filter on workspace_name
            // If caller passes a full path → filter on workspace (exact match)
            if (workspace) {
                const isBasename = !workspace.includes('/') && !workspace.includes('\\');
                if (isBasename) {
                    filterConditions.push({
                        key: "workspace_name",
                        match: { value: workspace }
                    });
                } else {
                    filterConditions.push({
                        key: "workspace",
                        match: { value: workspace }
                    });
                }
            }

            // #604: Filter by conversation source (roo vs claude-code)
            if (source) {
                filterConditions.push({
                    key: "source",
                    match: { value: source }
                });
            }

            // #636: Advanced filters (chunk_type resolved with exclude_tool_results alias)
            if (effectiveChunkType) {
                filterConditions.push({
                    key: "chunk_type",
                    match: { value: effectiveChunkType }
                });
            }

            if (role) {
                filterConditions.push({
                    key: "role",
                    match: { value: role }
                });
            }

            if (tool_name) {
                filterConditions.push({
                    key: "tool_name",
                    match: { value: tool_name }
                });
            }

            if (has_errors === true) {
                filterConditions.push({
                    key: "has_error",
                    match: { value: true }
                });
            }

            if (model) {
                filterConditions.push({
                    key: "model",
                    match: { value: model }
                });
            }

            // #1244 Couche 1.3 — Push date filter INTO Qdrant (range on timestamp field)
            // Avant ce fix, le filtre etait applique APRES retrieval (lignes 548-553) :
            // si un match etait en position 20 et max_results=10, l'utilisateur voyait 0 resultats.
            // Les timestamps sont stockes comme strings ISO 8601 (lexicographiquement comparables).
            const parsedStartDateForQdrant = parseFilterDate(start_date);
            const parsedEndDateForQdrant = parseFilterDate(end_date);
            if (parsedStartDateForQdrant || parsedEndDateForQdrant) {
                const rangeFilter: any = {};
                if (parsedStartDateForQdrant) {
                    rangeFilter.gte = parsedStartDateForQdrant.toISOString();
                }
                if (parsedEndDateForQdrant) {
                    // Pour YYYY-MM-DD, inclure la journee entiere
                    const endOfDay = new Date(parsedEndDateForQdrant.getTime());
                    if (endOfDay.getUTCHours() === 0 && endOfDay.getUTCMinutes() === 0) {
                        endOfDay.setUTCHours(23, 59, 59, 999);
                    }
                    rangeFilter.lte = endOfDay.toISOString();
                }
                filterConditions.push({
                    key: "timestamp",
                    range: rangeFilter
                });
            }

            if (filterConditions.length > 0) {
                filter = { must: filterConditions };
            } else {
                filter = undefined;
            }

            // #831: Add configurable timeout for large vector indexes (9.93M vectors)
            // #1275: Fix Promise leak — clear timeout if search completes first
            const searchTimeoutMs = parseInt(process.env.QDRANT_SEARCH_TIMEOUT_MS || '30000', 10); // Default 30s

            // #883: Global search is now allowed (workspace auto-defaults in roosync_search)

            // #851: Optimized search params for 10M+ vector collection
            // #831/#1275: Timeout wrapper with proper cleanup to avoid Promise leak
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            const searchPromise = qdrant.search(collectionName, {
                vector: queryVector,
                limit: max_results || 10,
                filter: filter,
                params: {
                    hnsw_ef: 128,
                    exact: false,
                    quantization: { rescore: true }
                },
                with_payload: {
                    include: ['task_id', 'timestamp', 'chunk_type', 'content', 'content_summary', 'workspace', 'workspace_name', 'source', 'chunk_id', 'task_title', 'role', 'model', 'tool_name', 'has_error']
                }
            });

            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`Qdrant search timeout after ${searchTimeoutMs}ms (9.93M vectors). Tip: Provide workspace parameter to narrow search.`)), searchTimeoutMs);
            });

            let searchResults;
            try {
                searchResults = await Promise.race([searchPromise, timeoutPromise]);
            } finally {
                // #1275: Always clear timeout to prevent leaked timer
                if (timeoutId !== undefined) {
                    clearTimeout(timeoutId);
                }
            }


            // Obtenir l'identifiant de la machine actuelle pour l'en-tête
            const currentHostId = getHostIdentifier();

            // Normalisation de la réponse Qdrant (supporte format tableau direct ou objet { result/points: [...] })
            const rawPoints = Array.isArray(searchResults)
                ? searchResults
                : (searchResults as any).result || (searchResults as any).points || [];

            // Phase 2: Enriched results with snippets, score interpretation, deduplication
            const results: RawSearchResult[] = rawPoints.map((result: any) => {
                // #982 FIX: Prefer full content for snippet extraction (content_summary is only 200 chars)
                const fullContent = String(result.payload?.content || result.payload?.content_summary || '');
                const content = String(result.payload?.content_summary || result.payload?.content || '');
                const score = result.score || 0;
                return {
                    taskId: result.payload?.task_id || 'unknown',
                    score,
                    content: truncateMessage(content, 5),
                    snippet: extractSnippet(fullContent, search_query),
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
                        host_os: result.payload?.host_os || 'unknown',
                        // #636: Enriched metadata
                        source: result.payload?.source,
                        tool_name: result.payload?.tool_name,
                        model: result.payload?.model,
                        has_error: result.payload?.has_error,
                    }
                };
            });

            // #1244 Couche 1.3 — Filtre temporel : double-couche
            //   (a) Push dans Qdrant en amont (range filter sur 'timestamp', cf. l. 477-495)
            //       → fait l'essentiel du travail, evite de transferer des resultats hors plage.
            //   (b) Filet de securite client-side : si Qdrant n'honore pas le filtre
            //       (timestamp non indexe, schema mismatch, mock de tests), on filtre ici aussi.
            //   Avant ce double-niveau, le filtre etait UNIQUEMENT post-Qdrant et apres `limit`,
            //   ce qui pouvait masquer des matches en position > max_results (bug originel #1244).
            const filteredResults = (parsedStartDateForQdrant || parsedEndDateForQdrant)
                ? results.filter(r => isWithinDateRange(r.metadata.timestamp, parsedStartDateForQdrant, parsedEndDateForQdrant))
                : results;

            // Group by task_id: deduplicate multiple chunks from the same conversation
            const groupedResults = groupResultsByTask(filteredResults);

            // #636 Phase 2: Enrich grouped results with conversation stats from cache
            for (const group of groupedResults) {
                const cached = conversationCache.get(group.taskId);
                if (cached) {
                    group.conversation_stats = {
                        total_messages: cached.metadata?.messageCount || 0,
                        workspace: cached.metadata?.workspace,
                        last_activity: cached.metadata?.lastActivity || cached.metadata?.createdAt,
                    };
                }
            }

            // Cross-machine analysis
            const allHosts = filteredResults.map(r => r.metadata.host_os);
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
                    results_count: filteredResults.length,
                    unique_tasks: groupedResults.length,
                    // #636 Phase 2 + #1244 Couche 1.3: temporal filter info
                    // Le filtre est pousse en amont dans Qdrant (range filter sur 'timestamp')
                    // ET applique en defense-in-depth client-side (cf. filteredResults plus haut).
                    ...(parsedStartDateForQdrant || parsedEndDateForQdrant ? {
                        temporal_filter: {
                            start_date: start_date || null,
                            end_date: end_date || null,
                            pre_filter_count: results.length,
                            post_filter_count: filteredResults.length,
                        }
                    } : {})
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
            // #1232: Activate circuit breaker ONLY on HTTP 5xx server errors
            if (isHttpServerError(semanticError)) {
                lastEmbeddingFailureTime = Date.now();
                console.warn(`[WARN] #1232: Embedding circuit breaker activated for ${EMBEDDING_CIRCUIT_BREAKER_TTL_MS / 1000}s (HTTP 5xx detected)`);
            }

            const semanticErrorMsg = semanticError instanceof Error ? semanticError.message : String(semanticError);

            // #1496: Strict mode — propagate the semantic error instead of silently
            // falling back to text. Callers that explicitly requested semantic
            // (like `roosync_search(action: "semantic")`) need to know when the
            // embedding backend is down, otherwise they treat text results as
            // semantic and real regressions go unnoticed for days (cf #1407, #1451).
            if (args.strict_mode) {
                console.warn(`[WARN] Semantic search failed in strict_mode (no fallback): ${semanticErrorMsg}`);
                return {
                    isError: true,
                    content: [{
                        type: 'text',
                        text: `Semantic search failed: ${semanticErrorMsg}\n\n` +
                              `Diagnostic: run roosync_search(action: "diagnose") to check backend state.\n` +
                              `Hint: if you want text fallback, use roosync_search(action: "text") explicitly.`
                    }]
                };
            }

            console.warn(`[WARN] Semantic search failed, falling back to text search: ${semanticErrorMsg}`);

            // Fallback vers la recherche textuelle simple (legacy — default path)
            try {
                // Fix: mapper search_query → query pour le fallback
                const fallbackResult = await fallbackHandler(
                    { query: args.search_query, workspace: args.workspace },
                    conversationCache
                );

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