import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';

// Type pour les arguments de recherche
export interface SearchFallbackArgs {
  query: string;
  workspace?: string;
  /** #604: Filter by conversation source (roo tasks or claude-code sessions) */
  source?: 'roo' | 'claude-code';
}

/**
 * Outil de recherche textuel simple (fallback)
 */
export async function searchFallbackTool(
  args: SearchFallbackArgs,
  conversationCache: Map<string, ConversationSkeleton>
): Promise<CallToolResult> {
  try {
    const { query, workspace, source } = args;

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

    // #1410 item 7: Tokenize multi-word queries — match ANY token (OR logic)
    // Single-word queries behave identically to before (single-element array).
    // Multi-word queries like "dashboard cleanup" now match tasks containing either word.
    const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
    const fullQuery = query.toLowerCase();

    // Recherche textuelle simple dans le cache
    const results: Array<{
      taskId: string;
      title: string;
      instruction: string;
      workspace: string;
      lastActivity: string;
      metadata: any;
      _score: number;
    }> = [];

    for (const [taskId, skeleton] of conversationCache.entries()) {
      // Filtrer par workspace si spécifié
      if (workspace && skeleton.metadata?.workspace !== workspace) {
        continue;
      }

      // #604: Filtrer par source si spécifié
      // #1324: Use metadata.source (normalized 'roo'/'claude-code'), not metadata.dataSource
      // (which is the raw filesystem path and never matches 'roo' or 'claude-code')
      if (source) {
        const taskSource = skeleton.metadata?.source || (taskId.startsWith('claude-') ? 'claude-code' : 'roo');
        if (taskSource !== source) {
          continue;
        }
      }

      const title = skeleton.metadata?.title?.toLowerCase() || '';
      const instruction = skeleton.truncatedInstruction?.toLowerCase() || '';

      // Build searchable message text
      let messageText = '';
      if (skeleton.sequence && Array.isArray(skeleton.sequence)) {
        messageText = (skeleton.sequence as any[])
          .map((msg: any) => msg.content || msg.text || '')
          .join(' ')
          .toLowerCase();
      }

      // Score: full phrase match > individual token matches
      let score = 0;
      const fullTitleMatch = title.includes(fullQuery);
      const fullInstrMatch = instruction.includes(fullQuery);
      const fullMsgMatch = messageText.includes(fullQuery);

      // Full phrase match gets a high bonus (preferred over individual tokens)
      if (fullTitleMatch) score += 10;
      if (fullInstrMatch) score += 5;
      if (fullMsgMatch) score += 2;

      // Also count individual token matches (additive, even with full match)
      if (tokens.length > 0) {
        for (const token of tokens) {
          if (title.includes(token)) score += 2;
          if (instruction.includes(token)) score += 1;
          if (messageText.includes(token)) score += 1;
        }
      }

      if (score > 0) {
        results.push({
          taskId,
          title: skeleton.metadata?.title || 'Untitled',
          instruction: skeleton.truncatedInstruction || '',
          workspace: skeleton.metadata?.workspace || 'unknown',
          lastActivity: skeleton.metadata?.lastActivity || new Date().toISOString(),
          metadata: {
            taskType: skeleton.metadata?.mode || 'unknown',
            status: skeleton.isCompleted ? 'completed' : 'active',
            messageCount: skeleton.metadata?.messageCount || 0,
            hasChildren: skeleton.childTaskInstructionPrefixes ? skeleton.childTaskInstructionPrefixes.length > 0 : false,

            parentTaskId: skeleton.parentTaskId || null
          },
          _score: score
        });
      }
    }

    // Trier par score décroissant, puis par dernière activité
    results.sort((a, b) => {
      if (a._score !== b._score) {
        return b._score - a._score;
      }
      return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
    });

    // Strip internal _score before returning
    const cleanResults = results.map(({ _score, ...rest }) => rest);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          results: cleanResults,
          query,
          searchType: 'text',
          totalFound: cleanResults.length,
          metadata: {
            searchMethod: 'text',
            tokenCount: tokens.length,
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
