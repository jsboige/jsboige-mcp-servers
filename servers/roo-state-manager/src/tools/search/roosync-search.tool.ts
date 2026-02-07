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
                description: 'Filtre les résultats par workspace spécifique'
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
            // Déléguer au handler sémantique existant (inclut fallback automatique sur erreur)
            const semanticArgs: SearchTasksByContentArgs = {
                search_query: args.search_query,
                conversation_id: args.conversation_id,
                max_results: args.max_results,
                workspace: args.workspace,
                diagnose_index: false
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
                workspace: args.workspace
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
