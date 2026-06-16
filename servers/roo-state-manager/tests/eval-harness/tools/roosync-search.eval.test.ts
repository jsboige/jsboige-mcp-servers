/**
 * roosync-search.eval.test.ts — Golden-query eval for roosync_search.
 *
 * Tests the REAL roosync_search tool against live Qdrant + Postgres.
 * If the storm guard fired, all tests skip to INCONCLUSIVE.
 *
 * Key assertions (#637 detector):
 * - fallback_used !== true: text-fallback masks broken semantic path
 * - results.length > 0: evergreen query must return results
 * - best_score >= 0.5: quality floor
 *
 * @issue Epic #2609 V1
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { STORM_ACTIVE, STORM_GUARD_RESULT, runStormGuard } from '../storm-guard.js';
import { ROOSYNC_SEARCH_QUERY } from '../golden-queries.js';
import type { ToolVerdict, CheckResult } from '../verdict.js';
import { handleRooSyncSearch } from '../../../src/tools/search/roosync-search.tool.js';
import { handleDiagnoseSemanticIndex } from '../../../src/tools/indexing/diagnose-index.tool.js';
import { handleSearchTasksSemanticFallback } from '../../../src/tools/search/search-fallback.tool.js';
import type { ConversationSkeleton } from '../../../src/types/conversation.js';

// Module-level verdict accumulator (for structured reporting)
const verdicts: ToolVerdict[] = [];

beforeAll(async () => {
  await runStormGuard();
});

describe('roosync_search — golden query eval', () => {
  it('presence: results.length > 0 and basic structure', async () => {
    if (STORM_ACTIVE) {
      console.log(`[INCONCLUSIVE] Storm guard active: ${STORM_GUARD_RESULT.reason}`);
      // We record INCONCLUSIVE but do NOT fail the test — storm = infra issue, not tool issue
      expect(STORM_GUARD_RESULT.active).toBe(true);
      return;
    }

    const startMs = Date.now();
    const checks: CheckResult[] = [];

    // Build minimal noop callbacks matching handleRooSyncSearch signature
    const noopEnsureFresh = async (_args?: { workspace?: string }) => true;
    const realFallbackHandler = async (args: any, cache: Map<string, ConversationSkeleton>) =>
      handleSearchTasksSemanticFallback(args, cache);
    const diagnoseHandler = async () =>
      handleDiagnoseSemanticIndex(new Map<string, ConversationSkeleton>());

    let parsed: any = {};
    let rawText = '';
    let callError: Error | undefined;

    try {
      const result = await handleRooSyncSearch(
        ROOSYNC_SEARCH_QUERY.args as any,
        new Map<string, ConversationSkeleton>(),
        noopEnsureFresh,
        realFallbackHandler,
        diagnoseHandler
      );

      const rawItem = result.content?.[0];
      rawText = (rawItem && 'text' in rawItem) ? (rawItem as { text: string }).text : '';
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = {};
      }
    } catch (err: any) {
      callError = err;
    }

    const latencyMs = Date.now() - startMs;

    // ---- Check: No tool call error ----
    const noError = callError === undefined;
    checks.push({
      name: 'no_call_error',
      ok: noError,
      observed: callError?.message,
    });

    // ---- Check: results array present and non-empty ----
    const results: any[] = Array.isArray(parsed?.results) ? parsed.results : [];
    checks.push({
      name: 'results.length > 0',
      ok: results.length > 0,
      observed: String(results.length),
    });

    // ---- Check: current_machine.unique_tasks > 0 ----
    const uniqueTasks = parsed?.current_machine?.unique_tasks ?? 0;
    checks.push({
      name: 'current_machine.unique_tasks > 0',
      ok: uniqueTasks > 0,
      observed: String(uniqueTasks),
    });

    // ---- Check: cross_machine_analysis.machines_found !== ['unknown'] ----
    const machinesFound: string[] = parsed?.cross_machine_analysis?.machines_found ?? [];
    const notUnknownOnly =
      machinesFound.length > 0 &&
      !(machinesFound.length === 1 && machinesFound[0] === 'unknown');
    checks.push({
      name: 'cross_machine_analysis.machines_found !== ["unknown"]',
      ok: notUnknownOnly,
      observed: JSON.stringify(machinesFound),
    });

    // ---- Quality check: top result score >= 0.5 ----
    const topScore = results[0]?.best_score ?? 0;
    checks.push({
      name: 'results[0].best_score >= 0.5',
      ok: topScore >= 0.5,
      observed: String(topScore),
    });

    // ---- Quality check: snippet length >= 120 ----
    const topSnippet = results[0]?.chunks?.[0]?.snippet ?? '';
    checks.push({
      name: 'results[0].chunks[0].snippet.length >= 120',
      ok: topSnippet.length >= 120,
      observed: String(topSnippet.length),
    });

    // ---- #637 DETECTOR: fallback_used !== true ----
    // If fallback_used=true, the semantic path is broken (text search masked it).
    // This is the most important assertion — a FAIL here means the semantic pipeline is down.
    const fallbackUsed = parsed?.fallback_used === true;
    checks.push({
      name: '#637: fallback_used !== true (semantic path working)',
      ok: !fallbackUsed,
      observed: String(parsed?.fallback_used),
    });

    const allPass = checks.every((c) => c.ok);
    const verdict: VerdictOutcome = allPass ? 'PASS' : 'FAIL';

    const toolVerdict: ToolVerdict = {
      tool: 'roosync_search',
      query: ROOSYNC_SEARCH_QUERY.args,
      verdict,
      reason: allPass
        ? 'All presence + quality checks passed'
        : `Failed checks: ${checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`,
      latency_ms: latencyMs,
      checks,
      timestamp: new Date().toISOString(),
    };
    verdicts.push(toolVerdict);

    // Log for visibility
    console.log(`[roosync_search] verdict=${verdict} latency=${latencyMs}ms`);
    for (const c of checks) {
      const mark = c.ok ? 'OK' : 'FAIL';
      console.log(`  [${mark}] ${c.name}${c.observed !== undefined ? ` → ${c.observed}` : ''}`);
    }

    // Vitest assertions
    expect(noError, 'Tool call should not throw').toBe(true);
    expect(results.length, 'Evergreen golden query must return results').toBeGreaterThan(0);
    expect(
      !fallbackUsed,
      '#637: fallback_used must be false — semantic path is broken if true'
    ).toBe(true);
    expect(topScore, 'Top result score must be >= 0.5').toBeGreaterThanOrEqual(0.5);
  });
});

// Re-export verdicts for potential aggregation by parent suite
export { verdicts };

// Local type alias to avoid import cycles
type VerdictOutcome = 'PASS' | 'FAIL' | 'INCONCLUSIVE';
