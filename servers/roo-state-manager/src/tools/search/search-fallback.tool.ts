import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';

// Type pour les arguments de recherche
export interface SearchFallbackArgs {
  query: string;
  workspace?: string;
  /** #604: Filter by conversation source (roo tasks or claude-code sessions) */
  source?: 'roo' | 'claude-code';
  /** #2548: Max results to return (prevents unbounded dumps) */
  max_results?: number;
  /**
   * #2548: Whether advanced filters that text mode CANNOT support were requested.
   * The caller must exclude has_errors/start_date/end_date from this flag — those
   * three are applied here (#2920), so listing them as "not applied" would lie.
   */
  filters_requested?: boolean;
  /** #2920: applied from `sequence` action statuses (skeleton-derivable) */
  has_errors?: boolean;
  /** #2920: applied against metadata.lastActivity (ISO 8601) */
  start_date?: string;
  /** #2920: applied against metadata.lastActivity (ISO 8601) */
  end_date?: string;
}

/**
 * #2920: parse an ISO date bound. Returns undefined for absent/unparseable input
 * so a malformed bound degrades to "no bound" (and is reported) rather than
 * silently excluding everything.
 */
function parseBound(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Outil de recherche textuel simple (fallback)
 */
export async function searchFallbackTool(
  args: SearchFallbackArgs,
  conversationCache: Map<string, ConversationSkeleton>
): Promise<CallToolResult> {
  try {
    const { query, workspace, source, max_results, filters_requested } = args;
    const { has_errors, start_date, end_date } = args;

    // #2920: date bounds. An unparseable bound is dropped and reported — never
    // applied as "match nothing", which would render a bad input as an empty result.
    const startBound = parseBound(start_date);
    const endBound = parseBound(end_date);
    const invalidBounds: string[] = [];
    if (start_date && startBound === undefined) invalidBounds.push(`start_date="${start_date}"`);
    if (end_date && endBound === undefined) invalidBounds.push(`end_date="${end_date}"`);

    // #2920 + #2963 rule 1: a task whose `sequence` is absent carries no evidence
    // either way about errors. Such tasks are excluded from a has_errors-filtered
    // result AND counted, so "0 results" can never be mistaken for "0 failures".
    let unevaluableForErrors = 0;

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
      // Filtrer par workspace si spécifié — match full path OR short name.
      // The cache stores path form (c:/dev/roo-extensions) while callers pass
      // the short name (roo-extensions); strict !== on the path alone made every
      // workspace-filtered text search return 0 hits (#795 finding, web1).
      if (workspace) {
        const ws = skeleton.metadata?.workspace;
        const wsShort = ws ? ws.split(/[\\/]/).filter(Boolean).pop() : undefined;
        if (ws !== workspace && wsShort !== workspace) {
          continue;
        }
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

      // #2920: date filters, applied against metadata.lastActivity — the same
      // field the results are sorted by, so the bound means what the caller reads.
      if (startBound !== undefined || endBound !== undefined) {
        const activity = new Date(skeleton.metadata?.lastActivity ?? '').getTime();
        if (Number.isNaN(activity)) continue;
        if (startBound !== undefined && activity < startBound) continue;
        if (endBound !== undefined && activity > endBound) continue;
      }

      // #2920: has_errors, derived from ActionMetadata.status === 'failure'.
      if (has_errors !== undefined) {
        const seq = Array.isArray(skeleton.sequence) ? skeleton.sequence : undefined;
        if (!seq || seq.length === 0) {
          unevaluableForErrors++;
          continue;
        }
        const hasFailure = (seq as any[]).some(
          (item: any) => item && typeof item === 'object' && item.status === 'failure'
        );
        if (hasFailure !== has_errors) continue;
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

    // #2548: Cap results to max_results (prevents unbounded context dumps)
    const cappedResults = max_results && max_results > 0
      ? results.slice(0, Math.min(max_results, 100))
      : results;

    // Strip internal _score before returning
    const cleanResults = cappedResults.map(({ _score, ...rest }) => rest);

    // #2548: Build metadata with warnings if filters were requested but not applied
    const warnings: string[] = [];
    // #2920: the warning now names ONLY what text mode genuinely cannot evaluate.
    // chunk_type/role/tool_name/model/exclude_tool_results are properties of the
    // Qdrant chunk index, not of a cached task skeleton — "not applicable" here,
    // which is a different statement from "not applied".
    if (filters_requested) {
      warnings.push('Filters chunk_type, role, tool_name, model and exclude_tool_results are not applicable in text fallback mode (they are properties of the semantic chunk index, not of the task cache). Any of them that were requested are absent from these results.');
    }
    // #2920: applied filters are stated explicitly so the caller can tell an
    // honestly-filtered empty set from an unfiltered one.
    const appliedFilters: string[] = [];
    if (has_errors !== undefined) appliedFilters.push(`has_errors=${has_errors}`);
    if (startBound !== undefined) appliedFilters.push(`start_date=${start_date}`);
    if (endBound !== undefined) appliedFilters.push(`end_date=${end_date}`);
    if (invalidBounds.length > 0) {
      warnings.push(`Unparseable date bound(s) ignored: ${invalidBounds.join(', ')}. Use ISO 8601 (e.g. 2026-07-26 or 2026-07-26T12:00:00Z).`);
    }
    if (unevaluableForErrors > 0) {
      warnings.push(`${unevaluableForErrors} task(s) could not be evaluated for has_errors (no action sequence loaded in cache) and are excluded from these results — this is not evidence that they carry no errors.`);
    }
    if (max_results && results.length > max_results) {
      warnings.push(`Results capped from ${results.length} to ${max_results}.`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          results: cleanResults,
          query,
          searchType: 'text',
          totalFound: cleanResults.length,
          ...(warnings.length > 0 && { warnings }),
          metadata: {
            searchMethod: 'text',
            tokenCount: tokens.length,
            cacheSize: conversationCache.size,
            workspace: workspace || 'all',
            // #2920: explicit so a programmatic consumer never has to infer
            // whether its filters took effect.
            applied_filters: appliedFilters.length > 0 ? appliedFilters : undefined,
            unevaluable_for_has_errors: unevaluableForErrors > 0 ? unevaluableForErrors : undefined
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
