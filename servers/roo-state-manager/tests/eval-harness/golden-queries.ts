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

/**
 * Golden scenario 4 of Epic #2609 — cross-conversation synthesis.
 *
 * "Les arbitrages encore ouverts cette semaine avec leur contexte" graded as:
 * the response must span ≥2 distinct conversations (unique_tasks), each openable
 * via a drill_down handle, with when/where metadata — the synthesis scaffold an
 * agent needs WITHOUT re-opening a grep.
 *
 * exclude_tool_results=true is deliberate: it is the best measured lever for
 * decision-content queries (live 2026-10-05: tool_interaction JSON fragments
 * occupy 5/7 top slots without it, 0/7 with it).
 *
 * @issue Epic #2609 scenario 4 (V1 coverage)
 */
export const CROSS_CONVERSATION_QUERY: GoldenQuery = {
  tool: 'roosync_search',
  description: 'Cross-conversation synthesis: open arbitrations with context',
  args: {
    action: 'semantic',
    search_query: 'arbitrage user question ouverte décision en attente',
    workspace: '*',
    max_results: 8,
    exclude_tool_results: true,
  },
};

export interface CrossConversationGolden {
  /** Verdict artifact id */
  scenario: string;
  query: GoldenQuery;
}

/** Same args as CROSS_CONVERSATION_QUERY: only the wording varies across the set. */
function crossConversationWording(searchQuery: string, description: string): GoldenQuery {
  return {
    ...CROSS_CONVERSATION_QUERY,
    description,
    args: { ...CROSS_CONVERSATION_QUERY.args, search_query: searchQuery },
  };
}

/**
 * Golden scenario 4 as a SET of wordings (RX133, user 2026-11-01, option c).
 *
 * Ranking can be tuned to one wording; it cannot be tuned to four. Each entry is
 * graded by the full rubric as its own scenario, and every entry must pass. The
 * first entry is the historical query and keeps its scenario id, so the verdict
 * history stays continuous. The wordings were fixed before their first live
 * measurement, not chosen from it.
 */
export const CROSS_CONVERSATION_QUERIES: readonly CrossConversationGolden[] = [
  { scenario: 'scenario-4-cross-conversation', query: CROSS_CONVERSATION_QUERY },
  {
    scenario: 'scenario-4-cross-conversation-epic-wording',
    query: crossConversationWording(
      'Les arbitrages encore ouverts cette semaine avec leur contexte',
      'Cross-conversation synthesis: the Epic #2609 wording of scenario 4',
    ),
  },
  {
    scenario: 'scenario-4-cross-conversation-registry',
    query: crossConversationWording(
      'questions du registre en attente de réponse de l\'utilisateur',
      'Cross-conversation synthesis: registry vocabulary (user question registry)',
    ),
  },
  {
    scenario: 'scenario-4-cross-conversation-english',
    query: crossConversationWording(
      'open user arbitrations still waiting for an answer',
      'Cross-conversation synthesis: English wording',
    ),
  },
];
