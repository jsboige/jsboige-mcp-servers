/**
 * Fallback de recherche sémantique
 * Utilisé quand Qdrant échoue ou n'est pas disponible
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';

export interface SearchFallbackArgs {
    conversation_id?: string;
    search_query: string;
    max_results?: number;
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
 * Handler de fallback pour la recherche sémantique
 * Recherche textuelle simple dans les instructions des conversations
 */
export async function handleSearchTasksSemanticFallback(
    args: SearchFallbackArgs,
    conversationCache: Map<string, ConversationSkeleton>
): Promise<CallToolResult> {
    console.log(`[DEBUG] Fallback called with args:`, JSON.stringify(args));
    
    const { conversation_id, search_query, max_results = 10 } = args;
    console.log(`[DEBUG] Extracted conversation_id: "${conversation_id}" (type: ${typeof conversation_id})`);

    // Si pas de conversation_id spécifique, rechercher dans tout le cache
    console.log(`[DEBUG] Fallback search - conversation_id: "${conversation_id}" (type: ${typeof conversation_id})`);
    const isUndefinedString = conversation_id === 'undefined';
    const isEmptyOrFalsy = !conversation_id;
    console.log(`[DEBUG] isUndefinedString: ${isUndefinedString}, isEmptyOrFalsy: ${isEmptyOrFalsy}`);
    
    if (!conversation_id || conversation_id === 'undefined') {
        const query = search_query.toLowerCase();
        const results: any[] = [];

        for (const [taskId, skeleton] of conversationCache.entries()) {
            if (results.length >= max_results) break;
            
            for (const item of skeleton.sequence) {
                if ('content' in item && typeof item.content === 'string' && item.content.toLowerCase().includes(query)) {
                    results.push({
                        taskId: taskId,
                        score: 1.0,
                        match: `Found in role '${item.role}': ${truncateMessage(item.content, 2)}`
                    });
                    break; // Une seule correspondance par tâche pour éviter la duplication
                }
            }
        }

        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }

    // Recherche dans une conversation spécifique
    console.log(`[DEBUG] Specific search - conversation_id: "${conversation_id}" (type: ${typeof conversation_id})`);
    const skeleton = conversationCache.get(conversation_id);
    if (!skeleton) {
        throw new Error(`Conversation with ID '${conversation_id}' not found in cache.`);
    }

    const query = search_query.toLowerCase();
    const results: any[] = [];

    for (const item of skeleton.sequence) {
        if (results.length >= max_results) {
            break;
        }
        if ('content' in item && typeof item.content === 'string' && item.content.toLowerCase().includes(query)) {
            results.push({
                taskId: skeleton.taskId,
                score: 1.0,
                match: `Found in role '${item.role}': ${truncateMessage(item.content, 2)}`
            });
        }
    }

    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
}