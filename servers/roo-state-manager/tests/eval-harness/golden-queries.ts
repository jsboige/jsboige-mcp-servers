/**
 * golden-queries.ts — Per-tool golden query + assertion definitions.
 *
 * Each golden query is an evergreen fixture: it should ALWAYS return results
 * if the tool is working correctly against the roo-extensions workspace.
 *
 * Empty result on an evergreen golden query → FAIL.
 * Empty result on a brand-new concept (no data yet) → INCONCLUSIVE (see V2 notes).
 *
 * @issue Epic #2609 V1
 */

export interface GoldenQuery {
  tool: string;
  description: string;
  /** The raw args to pass to the tool handler */
  args: Record<string, unknown>;
}

/**
 * roosync_search golden query.
 * Should find RooSync coordination conversations which are very common
 * in the roo-extensions workspace.
 */
export const ROOSYNC_SEARCH_QUERY: GoldenQuery = {
  tool: 'roosync_search',
  description: 'Semantic search for RooSync multi-agent coordination concepts',
  args: {
    action: 'semantic',
    search_query: 'RooSync multi-agent coordination',
    workspace: 'all',
    max_results: 10,
  },
};

/**
 * codebase_search golden query.
 * Should find the semantic search handler that queries Qdrant in the roo-state-manager codebase.
 * This is code that is always present in the roo-extensions workspace.
 */
export const CODEBASE_SEARCH_QUERY: GoldenQuery = {
  tool: 'codebase_search',
  description: 'Semantic code search for the Qdrant query handler',
  args: {
    query: 'semantic search handler that queries Qdrant',
    workspace: 'd:/roo-extensions',
    limit: 15,
    min_score: 0.5,
  },
};

/**
 * conversation_browser golden query.
 * Lists conversations matching 'roosync' pattern — should always exist
 * in any active roo-extensions workspace with conversations.
 *
 * NOTE: conversation_browser action:'list' does NOT have a 'semantic' action.
 * Only supported actions: list, tree, current, view, summarize, rebuild.
 */
export const CONVERSATION_BROWSER_QUERY: GoldenQuery = {
  tool: 'conversation_browser',
  description: 'List conversations containing "roosync" pattern',
  args: {
    action: 'list',
    contentPattern: 'roosync',
    limit: 10,
    sortBy: 'lastActivity',
  },
};
