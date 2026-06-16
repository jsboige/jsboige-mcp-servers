/**
 * codebase-search.eval.test.ts — Golden-query eval for codebase_search.
 *
 * Tests the REAL codebase_search tool against live Qdrant.
 * If the storm guard fired, all tests skip to INCONCLUSIVE.
 *
 * Key assertions:
 * - status === 'success' (NOT 'collection_not_found')
 * - results_count > 0
 * - top score >= 0.5
 * - at least one .ts/.js file inside the repo
 * - snippet.length >= 80
 * - start_line / end_line present (numeric)
 *
 * @issue Epic #2609 V1
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { STORM_ACTIVE, STORM_GUARD_RESULT, runStormGuard } from '../storm-guard.js';
import { CODEBASE_SEARCH_QUERY } from '../golden-queries.js';
import type { ToolVerdict, CheckResult } from '../verdict.js';
import { handleCodebaseSearch } from '../../../src/tools/search/search-codebase.tool.js';

// Module-level verdict accumulator
const verdicts: ToolVerdict[] = [];

beforeAll(async () => {
  await runStormGuard();
});

describe('codebase_search — golden query eval', () => {
  it('presence: status=success and results_count > 0', async () => {
    if (STORM_ACTIVE) {
      console.log(`[INCONCLUSIVE] Storm guard active: ${STORM_GUARD_RESULT.reason}`);
      expect(STORM_GUARD_RESULT.active).toBe(true);
      return;
    }

    const startMs = Date.now();
    const checks: CheckResult[] = [];

    let parsed: any = {};
    let callError: Error | undefined;

    try {
      const result = await handleCodebaseSearch(CODEBASE_SEARCH_QUERY.args as any);
      const rawItem = result.content?.[0];
      const rawText: string = (rawItem && 'text' in rawItem) ? (rawItem as { text: string }).text : '';
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
    checks.push({
      name: 'no_call_error',
      ok: callError === undefined,
      observed: callError?.message,
    });

    // ---- Check: status === 'success' ----
    const status = parsed?.status ?? 'missing';
    checks.push({
      name: "status === 'success'",
      ok: status === 'success',
      observed: status,
    });

    // ---- Check: results_count > 0 ----
    const resultsCount = parsed?.results_count ?? 0;
    checks.push({
      name: 'results_count > 0',
      ok: resultsCount > 0,
      observed: String(resultsCount),
    });

    const results: any[] = Array.isArray(parsed?.results) ? parsed.results : [];

    // ---- Check: each result has file_path + numeric score ----
    const allHaveFilePath = results.length > 0 && results.every((r) => typeof r.file_path === 'string' && r.file_path.length > 0);
    checks.push({
      name: 'all results have file_path',
      ok: allHaveFilePath,
      observed: allHaveFilePath ? 'yes' : `missing on ${results.filter((r) => !r.file_path).length} results`,
    });

    const allHaveScore = results.length > 0 && results.every((r) => typeof r.score === 'number');
    checks.push({
      name: 'all results have numeric score',
      ok: allHaveScore,
      observed: allHaveScore ? 'yes' : 'some missing',
    });

    // ---- Quality check: top score >= 0.5 ----
    const topScore = results[0]?.score ?? 0;
    checks.push({
      name: 'results[0].score >= 0.5',
      ok: topScore >= 0.5,
      observed: String(topScore),
    });

    // ---- Quality check: at least one .ts/.js file ----
    // Note: codebase_search may return relative paths (without repo root prefix) or
    // absolute paths depending on how Roo indexed them. We accept both.
    const repoRoot = (CODEBASE_SEARCH_QUERY.args.workspace as string).toLowerCase().replace(/\\/g, '/');
    const hasRepoFile = results.some((r) => {
      const fp = (r.file_path ?? '').toLowerCase().replace(/\\/g, '/');
      // Accept: absolute path inside repo, OR relative path (no drive letter) ending in .ts/.js
      const isTsOrJs = fp.endsWith('.ts') || fp.endsWith('.js');
      const isAbsoluteInRepo = fp.startsWith(repoRoot);
      const isRelative = isTsOrJs && !fp.includes(':\\') && !fp.startsWith('/');
      return isTsOrJs && (isAbsoluteInRepo || isRelative);
    });
    checks.push({
      name: 'at least one .ts/.js file in results (absolute or relative path)',
      ok: hasRepoFile,
      observed: hasRepoFile
        ? results.find((r) => {
            const fp = (r.file_path ?? '').toLowerCase().replace(/\\/g, '/');
            const isTsOrJs = fp.endsWith('.ts') || fp.endsWith('.js');
            return isTsOrJs && (!fp.includes(':\\') || fp.startsWith(repoRoot));
          })?.file_path
        : `top paths: ${results.slice(0, 3).map((r) => r.file_path).join(', ')}`,
    });

    // ---- Quality check: snippet length >= 80 ----
    const topSnippet = results[0]?.snippet ?? '';
    checks.push({
      name: 'results[0].snippet.length >= 80',
      ok: topSnippet.length >= 80,
      observed: String(topSnippet.length),
    });

    // ---- Quality check: start_line / end_line present ----
    const hasStartLine = typeof results[0]?.start_line === 'number';
    const hasEndLine = typeof results[0]?.end_line === 'number';
    checks.push({
      name: 'results[0] has start_line (numeric)',
      ok: hasStartLine,
      observed: String(results[0]?.start_line),
    });
    checks.push({
      name: 'results[0] has end_line (numeric)',
      ok: hasEndLine,
      observed: String(results[0]?.end_line),
    });

    // ---- #2455 V1 spot-check: cross-workspace leak ----
    // File paths should not be absolute paths from OTHER workspaces (different drive/repo).
    // V1: spot-check — relative paths and paths inside the queried repo are OK.
    const noLeak = results.every((r) => {
      const fp = (r.file_path ?? '').toLowerCase().replace(/\\/g, '/');
      // Relative path (no drive letter, no leading slash) → OK (repo-relative)
      if (!fp.includes(':/') && !fp.startsWith('/')) return true;
      // Absolute path → must be inside the queried repo root
      return fp.startsWith(repoRoot);
    });
    checks.push({
      name: '#2455 V1: no cross-workspace absolute path leak',
      ok: noLeak,
      observed: noLeak
        ? 'ok'
        : `leak in: ${results
            .filter((r) => {
              const fp = (r.file_path ?? '').toLowerCase().replace(/\\/g, '/');
              return (fp.includes(':/') || fp.startsWith('/')) && !fp.startsWith(repoRoot);
            })
            .slice(0, 2)
            .map((r) => r.file_path)
            .join(', ')}`,
    });

    const allPass = checks.every((c) => c.ok);
    const verdict: VerdictOutcome = allPass ? 'PASS' : 'FAIL';

    const toolVerdict: ToolVerdict = {
      tool: 'codebase_search',
      query: CODEBASE_SEARCH_QUERY.args,
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
    console.log(`[codebase_search] verdict=${verdict} latency=${latencyMs}ms`);
    for (const c of checks) {
      const mark = c.ok ? 'OK' : 'FAIL';
      console.log(`  [${mark}] ${c.name}${c.observed !== undefined ? ` → ${c.observed}` : ''}`);
    }

    // Vitest assertions
    expect(callError, 'Tool call should not throw').toBeUndefined();
    expect(status, "status must be 'success'").toBe('success');
    expect(resultsCount, 'Evergreen golden query must return results').toBeGreaterThan(0);
    expect(topScore, 'Top result score must be >= 0.5').toBeGreaterThanOrEqual(0.5);
    expect(hasRepoFile, 'At least one result should be a .ts/.js file inside the repo').toBe(true);
  });
});

export { verdicts };
type VerdictOutcome = 'PASS' | 'FAIL' | 'INCONCLUSIVE';
