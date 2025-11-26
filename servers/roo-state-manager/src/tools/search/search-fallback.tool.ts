import { ConversationSkeleton } from '../../../types/conversation.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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
      if (workspace && skeleton.workspace !== workspace) {
        continue;
      }

      // Recherche textuelle simple dans le titre, l'instruction et les messages
      const searchText = query.toLowerCase();
      const titleMatch = skeleton.metadata?.title?.toLowerCase().includes(searchText) ||
                        skeleton.title?.toLowerCase().includes(searchText);
      const instructionMatch = skeleton.instruction?.toLowerCase().includes(searchText);
      
      // Chercher aussi dans les messages de la séquence
      let messageMatch = false;
      if (skeleton.sequence && Array.isArray(skeleton.sequence)) {
        messageMatch = skeleton.sequence.some(msg =>
          msg.content && msg.content.toLowerCase().includes(searchText)
        );
      }

      if (titleMatch || instructionMatch || messageMatch) {
        results.push({
          taskId,
          title: skeleton.title || 'Untitled',
          instruction: skeleton.instruction || '',
          workspace: skeleton.workspace || 'unknown',
          lastActivity: skeleton.lastActivity || new Date().toISOString(),
          metadata: {
            taskType: skeleton.taskType || 'unknown',
            status: skeleton.status || 'unknown',
            messageCount: skeleton.messageCount || 0,
            hasChildren: skeleton.hasChildren || false,
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