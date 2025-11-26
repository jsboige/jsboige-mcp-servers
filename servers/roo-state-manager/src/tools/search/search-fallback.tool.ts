import { ConversationSkeleton } from '../../types/conversation.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface SearchFallbackArgs {
    search_query: string;
    max_results?: number;
    conversation_id?: string;
    workspace?: string;
}

/**
 * Outil de recherche textuel simple (fallback)
 */
export async function searchFallbackTool(
  args: { query: string; workspace?: string },
  conversationCache: Map<string, ConversationSkeleton>
): Promise<CallToolResult> {
  try {
    const { query, workspace } = args;
    
    if (!query || query.trim().length === 0) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: 'Query parameter is required and cannot be empty'
          })
        }]
      };
    }

    // Recherche textuelle simple dans le cache
    const results: Array<{
      taskId: string;
      title: string;
      instruction: string;
      workspace: string;
      lastActivity: string;
      metadata: any;
    }> = [];

    for (const [taskId, skeleton] of conversationCache.entries()) {
      // Filtrer par workspace si spécifié
      if (workspace && skeleton.metadata.workspace !== workspace) {
        continue;
      }

      // Recherche textuelle simple dans le titre et l'instruction
      const searchText = query.toLowerCase();
      const titleMatch = skeleton.metadata.title?.toLowerCase().includes(searchText);
      const instructionMatch = skeleton.truncatedInstruction?.toLowerCase().includes(searchText);

      if (titleMatch || instructionMatch) {
        results.push({
          taskId,
          title: skeleton.metadata.title || 'Untitled',
          instruction: skeleton.truncatedInstruction || '',
          workspace: skeleton.metadata.workspace || 'unknown',
          lastActivity: skeleton.metadata.lastActivity || new Date().toISOString(),
          metadata: {
            taskType: skeleton.metadata.mode || 'unknown',
            status: skeleton.isCompleted ? 'completed' : 'unknown',
            messageCount: skeleton.metadata.messageCount || 0,
            hasChildren: (skeleton.childTaskInstructionPrefixes && skeleton.childTaskInstructionPrefixes.length > 0) || false,
            parentTaskId: skeleton.parentTaskId || null
          }
        });
      }
    }

    // Trier par pertinence (titre d'abord, puis instruction)
    results.sort((a, b) => {
      const queryLower = query.toLowerCase();
      const aTitleScore = a.title.toLowerCase().includes(queryLower) ? 2 : 0;
      const bTitleScore = b.title.toLowerCase().includes(queryLower) ? 2 : 0;
      const aInstrScore = a.instruction.toLowerCase().includes(queryLower) ? 1 : 0;
      const bInstrScore = b.instruction.toLowerCase().includes(queryLower) ? 1 : 0;
      
      const aScore = aTitleScore + aInstrScore;
      const bScore = bTitleScore + bInstrScore;
      
      if (aScore !== bScore) {
        return bScore - aScore; // Score décroissant
      }
      
      // Même score : trier par dernière activité
      return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          results,
          query,
          searchType: 'text',
          totalFound: results.length,
          metadata: {
            searchMethod: 'text',
            cacheSize: conversationCache.size,
            workspace: workspace || 'all'
          }
        })
      }]
    };

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error in search fallback',
          query: args.query
        })
      }]
    };
  }
}

// Export pour compatibilité avec les tests
export const handleSearchTasksSemanticFallback = searchFallbackTool;