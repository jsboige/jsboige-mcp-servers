/**
 * MCP Tool unifié pour les opérations de recherche RooSync
 *
 * CONS-11: Consolidation Search/Indexing
 * - Remplace: search_tasks_by_content (semantic + text fallback + diagnose mode)
 * - Approche: Action-based dispatcher
 *
 * @version 1.0.0
 * @author CONS-11 Implementation
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';

// Import des handlers existants
import { searchTasksByContentTool, SearchTasksByContentArgs, extractSemanticErrorMode, INFRASTRUCTURE_ERROR_MODES } from './search-semantic.tool.js';
import { handleSearchTasksSemanticFallback, SearchFallbackArgs } from './search-fallback.tool.js';
import { failureComponent } from './search-error-classifier.js';

/**
 * Arguments du tool roosync_search unifié
 */
export interface RooSyncSearchArgs {
    /** Action de recherche */
    action: 'semantic' | 'text' | 'diagnose';

    /** Requête de recherche (requis pour semantic et text) */
    search_query?: string;

    /** ID de conversation pour filtrer */
    conversation_id?: string;

    /** Nombre max de résultats */
    max_results?: number;

    /** #936: Curseur de pagination — ignorer les N premiers résultats classés (requêtes larges). Clamp [0, 10000]. */
    offset?: number;

    /** Filtre par workspace */
    workspace?: string;

    /** #604: Filtre par source (roo ou claude-code) */
    source?: 'roo' | 'claude-code';

    // #636: Advanced search filters
    /** Filter by chunk type */
    chunk_type?: 'message_exchange' | 'tool_interaction';

    /** Filter by message role */
    role?: 'user' | 'assistant';

    /** Filter by tool name (for tool_interaction chunks) */
    tool_name?: string;

    /** Filter chunks that contain errors */
    has_errors?: boolean;

    /** Filter by LLM model used */
    model?: string;

    // #636 Phase 2: Temporal filters
    /** Filter results after this date (ISO 8601 or YYYY-MM-DD) */
    start_date?: string;

    /** Filter results before this date (ISO 8601 or YYYY-MM-DD) */
    end_date?: string;

    // #636 Phase 3: Convenience filter
    /** Exclude tool calls and tool results, including those stored as message_exchange. */
    exclude_tool_results?: boolean;

    /** #2634: Reset the embeddings circuit breaker if armed (diagnose action only) */
    reset_circuit_breaker?: boolean;
}

/**
 * Définition du tool MCP roosync_search
 */
export const roosyncSearchTool: Tool = {
    name: 'roosync_search',
    description: 'Search Roo tasks (semantic vector search, text search, or index diagnostic)',
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['semantic', 'text', 'diagnose'],
                description: 'Action: semantic (Qdrant vector search), text (cache search), diagnose (index health)'
            },
            search_query: {
                type: 'string',
                description: 'Search query (required for semantic/text)'
            },
            conversation_id: {
                type: 'string',
                description: 'Conversation ID filter (optional)'
            },
            max_results: {
                type: 'number',
                description: 'Max results to return (default: 10, max: 100)'
            },
            offset: {
                type: 'number',
                description: '#936: Pagination cursor — skip the first N ranked results (broad queries). Clamp [0, 10000].'
            },
            workspace: {
                type: 'string',
                description: 'Workspace filter. Default: MCP workspace. "*" or "all" = global.'
            },
            source: {
                type: 'string',
                enum: ['roo', 'claude-code'],
                description: 'Filter by source (Roo or Claude Code)'
            },
            chunk_type: {
                type: 'string',
                enum: ['message_exchange', 'tool_interaction'],
                description: 'Filter by chunk type (messages vs tool calls)'
            },
            role: {
                type: 'string',
                enum: ['user', 'assistant'],
                description: 'Filter by message role'
            },
            tool_name: {
                type: 'string',
                description: 'Filter by tool name'
            },
            has_errors: {
                type: 'boolean',
                description: 'Filter chunks with error patterns'
            },
            model: {
                type: 'string',
                description: 'Filter by LLM model'
            },
            start_date: {
                type: 'string',
                description: 'Filter after date (ISO 8601)'
            },
            end_date: {
                type: 'string',
                description: 'Filter before date (ISO 8601)'
            },
            exclude_tool_results: {
                type: 'boolean',
                description: 'Exclude tool calls and tool results, including tool output stored as message_exchange'
            },
            reset_circuit_breaker: {
                type: 'boolean',
                description: '#2634: Reset embeddings circuit breaker if armed (diagnose action only)'
            }
        },
        required: ['action']
    }
};

/**
 * Handler unifié pour roosync_search
 * Dispatche vers le handler approprié selon l'action
 */
export async function handleRooSyncSearch(
    args: RooSyncSearchArgs,
    conversationCache: Map<string, ConversationSkeleton>,
    ensureCacheFreshCallback: (args?: { workspace?: string }) => Promise<boolean>,
    fallbackHandler: (args: any, cache: Map<string, ConversationSkeleton>) => Promise<CallToolResult>,
    diagnoseHandler?: () => Promise<CallToolResult>
): Promise<CallToolResult> {
    // Validation de l'action
    if (!args.action) {
        return {
            isError: true,
            content: [{ type: 'text', text: 'Le paramètre "action" est requis. Valeurs possibles: semantic, text, diagnose' }]
        };
    }

    if (!['semantic', 'text', 'diagnose'].includes(args.action)) {
        return {
            isError: true,
            content: [{ type: 'text', text: `Action "${args.action}" invalide. Valeurs possibles: semantic, text, diagnose` }]
        };
    }

    switch (args.action) {
        case 'semantic': {
            if (!args.search_query) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'Le paramètre "search_query" est requis pour action=semantic' }]
                };
            }

            // #883: Workspace filtering is optional — no default imposed.
            // The caller (agent) passes workspace if they want to filter.
            // Accepts full paths ("d:\roo-extensions") or basenames ("roo-extensions").
            // Special values "*" or "all" = explicit global search (no filter).
            let effectiveWorkspace: string | undefined = args.workspace;
            if (effectiveWorkspace === '*' || effectiveWorkspace === 'all') {
                effectiveWorkspace = undefined;
            }

            // #2473: Clamp max_results to [1, 100] to prevent unbounded Qdrant queries
            const clampedMaxResults = Math.min(Math.max(args.max_results || 10, 1), 100);
            // #936: Pagination cursor for broad queries — clamp to Qdrant's sane bounds
            const clampedOffset = Math.min(Math.max(args.offset || 0, 0), 10000);

            // #249: Try semantic with retry (handled inside search-semantic.tool.ts),
            // then auto-fallback to text search if semantic fails, WITH a warning flag.
            // This replaces #1496 strict_mode=true which blocked fallback entirely.
            // Agents now get results even when semantic is down, but are warned.
            const semanticArgs: SearchTasksByContentArgs = {
                search_query: args.search_query,
                conversation_id: args.conversation_id,
                max_results: clampedMaxResults,
                // #936: forward the pagination cursor to the Qdrant search
                offset: clampedOffset,
                workspace: effectiveWorkspace,
                source: args.source,
                diagnose_index: false,
                strict_mode: true,
                // #636: Advanced filters
                chunk_type: args.chunk_type,
                role: args.role,
                tool_name: args.tool_name,
                has_errors: args.has_errors,
                model: args.model,
                // #636 Phase 2: Temporal filters
                start_date: args.start_date,
                end_date: args.end_date,
                // #636 Phase 3: Convenience filter
                exclude_tool_results: args.exclude_tool_results,
                // #2634: Forward circuit-breaker reset so the agent-facing tool can trigger it
                reset_circuit_breaker: args.reset_circuit_breaker,
            };
            const semanticResult = await searchTasksByContentTool.handler(
                semanticArgs,
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler,
                diagnoseHandler
            );

            // #249: If semantic succeeded, return as-is
            if (!semanticResult.isError) return semanticResult;

            // #249 keeps the fallback for EVERY semantic failure (an agent must
            // still get an answer), but the classified mode travels with the
            // degraded payload: `unknown` means a non-attributable failure, which
            // the eval harness grades FAIL instead of INCONCLUSIVE.
            const semanticErrorMode = extractSemanticErrorMode(semanticResult);

            // #249: Semantic failed after retry — auto-fallback to text search with warning
            console.warn(`[WARN] #249: Semantic search failed, auto-falling back to text search`);
            await ensureCacheFreshCallback({ workspace: effectiveWorkspace });
            const fallbackArgs: SearchFallbackArgs = {
                query: args.search_query,
                workspace: effectiveWorkspace,
                source: args.source,
                // #2548: Propagate max_results to prevent unbounded dumps
                max_results: clampedMaxResults,
                // #936: propagate the pagination cursor to text mode as well
                offset: clampedOffset,
                // #2548 + #2920: flag ONLY the filters text mode cannot evaluate.
                // has_errors/start_date/end_date are now applied by the fallback, so
                // including them here would emit a "not applied" warning about filters
                // that were in fact applied.
                filters_requested: !!(
                    args.chunk_type || args.role || args.tool_name ||
                    args.model || args.exclude_tool_results
                ),
                // #2920: skeleton-derivable filters, applied in text mode.
                has_errors: args.has_errors,
                start_date: args.start_date,
                end_date: args.end_date
            };
            const textResult = await handleSearchTasksSemanticFallback(fallbackArgs, conversationCache);

            // #4287: degradation must be VISIBLE — the response LEADS with a readable
            // warning instead of burying it as late keys in the JSON payload. The text
            // fallback itself stays (deliberate choice, #249); only the surface changes:
            // block 0 = human-readable warning, block 1 = structured payload so JSON
            // consumers keep parsing content[1] with the #1496 metadata intact.
            // #2609 review (D2): a `null` mode means the failure was NOT classified —
            // it is NOT evidence of a backend outage. Only a KNOWN infrastructure mode
            // attributes the failure to a backend; every other case (null,
            // or a classified non-infrastructure mode such as `unknown`) states no cause.
            // #4438: a known infrastructure mode names the component that ACTUALLY
            // failed — Qdrant is not the embeddings lane, and the banner must not send
            // the operator there. Same distinction `diagnose` draws through
            // `qdrant_connection` / `openai_connection`.
            const isInfrastructureMode = semanticErrorMode !== null
                && INFRASTRUCTURE_ERROR_MODES.has(semanticErrorMode);
            const failedComponent = failureComponent(semanticErrorMode);
            const degradedWarning = isInfrastructureMode
                ? (failedComponent === 'qdrant'
                    ? '⚠️ SEMANTIC DEGRADED — qdrant (vector store) unreachable: results are TEXT search only. ' +
                      'Run roosync_search(action: "diagnose") to inspect the qdrant endpoint (QDRANT_URL / the public ingress).'
                    : failedComponent === 'embeddings'
                    ? '⚠️ SEMANTIC DEGRADED — embedding backend unreachable: results are TEXT search only. ' +
                      'Run roosync_search(action: "diagnose") to inspect the embedding endpoint.'
                    : failedComponent === 'auth'
                    ? '⚠️ SEMANTIC DEGRADED — authentication with the search backend failed (401/403): results are TEXT search only. ' +
                      'Run roosync_search(action: "diagnose") to inspect the backend credentials.'
                    : failedComponent === 'resources'
                    ? '⚠️ SEMANTIC DEGRADED — search backend resources exhausted (too many open files / out of memory): results are TEXT search only. ' +
                      'Run roosync_search(action: "diagnose") to inspect the host resources.'
                    : '⚠️ SEMANTIC DEGRADED — search backend unreachable: results are TEXT search only. ' +
                      'Run roosync_search(action: "diagnose") to inspect the backend state.')
                : `⚠️ SEMANTIC DEGRADED — semantic search failed with an UNCLASSIFIED error (${semanticErrorMode ?? 'unknown mode'}): ` +
                  'results are TEXT search only and the failure is NOT attributable to a backend outage. ' +
                  'Run roosync_search(action: "diagnose") and report the mode.';

            // Enrich the structured block wherever a fallback warning placed it.
            const content = [...(textResult.content ?? [])];
            const payloadIndex = content.findIndex(item => {
                if (!('text' in item) || typeof item.text !== 'string') return false;
                try { JSON.parse(item.text); return true; } catch { return false; }
            });
            if (payloadIndex >= 0) {
                const block = content[payloadIndex] as { type: 'text'; text: string };
                const parsed = JSON.parse(block.text);
                parsed.semantic_degraded = true;
                parsed.semantic_error = 'Semantic search failed after retry — results are from text search only. Run roosync_search(action: "diagnose") to check backend state.';
                parsed.fallback_used = true;
                // #2609 review (D1): the reason is DERIVED from the classified mode —
                // the payload may not assert a cause the human warning denies.
                // #4438: the reason names the component too — `embedding_api_error` on a
                // Qdrant outage was the same misattribution as the banner, in the field
                // the agents parse.
                parsed.fallback_reason = semanticErrorMode === null
                    ? 'semantic_error_unclassified'
                    : (failedComponent === 'embeddings'
                        ? 'embedding_api_error'
                        : (failedComponent === 'qdrant' ? 'qdrant_api_error' : semanticErrorMode));
                parsed.original_search_mode = 'semantic';
                parsed.actual_search_mode = 'text';
                if (semanticErrorMode !== null) parsed.semantic_error_mode = semanticErrorMode;
                content[payloadIndex] = { type: 'text', text: JSON.stringify(parsed, null, 2) };
            }
            return {
                ...textResult,
                content: [{ type: 'text', text: degradedWarning }, ...content]
            };
        }

        case 'text': {
            if (!args.search_query) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'Le paramètre "search_query" est requis pour action=text' }]
                };
            }
            // #1324: Translate workspace "all"/"*" to undefined (same as semantic path)
            let textWorkspace: string | undefined = args.workspace;
            if (textWorkspace === '*' || textWorkspace === 'all') {
                textWorkspace = undefined;
            }
            // Appeler directement le fallback textuel
            await ensureCacheFreshCallback({ workspace: textWorkspace });
            const fallbackArgs: SearchFallbackArgs = {
                query: args.search_query,
                workspace: textWorkspace,
                source: args.source,
                // #2548: Propagate max_results
                max_results: Math.min(Math.max(args.max_results || 10, 1), 100),
                // #936: propagate the pagination cursor (text mode slices after ranking)
                offset: Math.min(Math.max(args.offset || 0, 0), 10000),
                // #2920: see the semantic-fallback site above — only the
                // non-applicable filters are flagged, the other three are applied.
                filters_requested: !!(
                    args.chunk_type || args.role || args.tool_name ||
                    args.model || args.exclude_tool_results
                ),
                has_errors: args.has_errors,
                start_date: args.start_date,
                end_date: args.end_date
            };
            return await handleSearchTasksSemanticFallback(fallbackArgs, conversationCache);
        }

        case 'diagnose': {
            // Déléguer au handler sémantique en mode diagnostic
            // #4005: Use a query representative of the diagnose action (index health check).
            // Previous hardcoded 'diagnose' string was meaningless for semantic measurement.
            const diagnoseArgs: SearchTasksByContentArgs = {
                search_query: args.search_query || '_index_diagnostic_probe_',
                diagnose_index: true,
                // #2634: Forward circuit-breaker reset (action: "diagnose" path)
                reset_circuit_breaker: args.reset_circuit_breaker,
            };
            return await searchTasksByContentTool.handler(
                diagnoseArgs,
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler,
                diagnoseHandler
            );
        }

        default:
            return {
                isError: true,
                content: [{ type: 'text', text: `Action non supportée: ${(args as any).action}` }]
            };
    }
}
