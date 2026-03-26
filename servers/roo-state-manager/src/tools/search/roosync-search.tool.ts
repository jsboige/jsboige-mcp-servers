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
import { searchTasksByContentTool, SearchTasksByContentArgs } from './search-semantic.tool.js';
import { handleSearchTasksSemanticFallback, SearchFallbackArgs } from './search-fallback.tool.js';

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
    /** Exclude tool_interaction chunks, returning only message_exchange chunks */
    exclude_tool_results?: boolean;
}

/**
 * Définition du tool MCP roosync_search
 */
export const roosyncSearchTool: Tool = {
    name: 'roosync_search',
    description: "Outil unifié de recherche dans les tâches Roo (sémantique, textuelle, diagnostic de l'index)",
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['semantic', 'text', 'diagnose'],
                description: "Action: 'semantic' (recherche vectorielle Qdrant avec fallback automatique), 'text' (recherche textuelle directe dans le cache), 'diagnose' (diagnostic de l'index sémantique)"
            },
            search_query: {
                type: 'string',
                description: 'La requête de recherche (requis pour semantic et text)'
            },
            conversation_id: {
                type: 'string',
                description: 'ID de la conversation à fouiller (filtre optionnel pour semantic)'
            },
            max_results: {
                type: 'number',
                description: 'Nombre maximum de résultats à retourner'
            },
            workspace: {
                type: 'string',
                description: 'Filtre par nom de workspace (ex: "roo-extensions"). Auto-défaut: workspace courant du MCP. Pour une recherche globale cross-workspace, passer workspace: "*" ou workspace: "all".'
            },
            source: {
                type: 'string',
                enum: ['roo', 'claude-code'],
                description: '#604: Filtre par source de conversation (tâches Roo ou sessions Claude Code)'
            },
            chunk_type: {
                type: 'string',
                enum: ['message_exchange', 'tool_interaction'],
                description: '#636: Filter by chunk type (messages vs tool calls)'
            },
            role: {
                type: 'string',
                enum: ['user', 'assistant'],
                description: '#636: Filter by message role'
            },
            tool_name: {
                type: 'string',
                description: '#636: Filter by tool name (e.g., "write_to_file", "roosync_send")'
            },
            has_errors: {
                type: 'boolean',
                description: '#636: Filter chunks that contain error patterns'
            },
            model: {
                type: 'string',
                description: '#636: Filter by LLM model (e.g., "opus", "sonnet", "glm-5")'
            },
            start_date: {
                type: 'string',
                description: '#636 P2: Filter results after this date (ISO 8601 or YYYY-MM-DD, e.g., "2026-03-01")'
            },
            end_date: {
                type: 'string',
                description: '#636 P2: Filter results before this date (ISO 8601 or YYYY-MM-DD, e.g., "2026-03-11")'
            },
            exclude_tool_results: {
                type: 'boolean',
                description: '#636 P3: Exclude tool_interaction chunks, returning only message_exchange chunks (conversation messages)'
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

            // Déléguer au handler sémantique existant (inclut fallback automatique sur erreur)
            const semanticArgs: SearchTasksByContentArgs = {
                search_query: args.search_query,
                conversation_id: args.conversation_id,
                max_results: args.max_results,
                workspace: effectiveWorkspace,
                source: args.source,
                diagnose_index: false,
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
            };
            return await searchTasksByContentTool.handler(
                semanticArgs,
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler,
                diagnoseHandler
            );
        }

        case 'text': {
            if (!args.search_query) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'Le paramètre "search_query" est requis pour action=text' }]
                };
            }
            // Appeler directement le fallback textuel
            await ensureCacheFreshCallback({ workspace: args.workspace });
            const fallbackArgs: SearchFallbackArgs = {
                query: args.search_query,
                workspace: args.workspace,
                source: args.source
            };
            return await handleSearchTasksSemanticFallback(fallbackArgs, conversationCache);
        }

        case 'diagnose': {
            // Déléguer au handler sémantique en mode diagnostic
            const diagnoseArgs: SearchTasksByContentArgs = {
                search_query: 'diagnose',
                diagnose_index: true
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
