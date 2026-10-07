/**
 * v3-passage-quality.eval.test.ts — Golden scenario 2 of Epic #2609, live.
 *
 * "Quelle décision sur la cadence du cron coordinateur, et pourquoi" — the
 * query the Epic baseline measured on 2026-06-16 (results: [] pre-#637).
 * Replayed verbatim to grade the V3 contract: the result must be exploitable
 * WITHOUT re-opening a grep.
 *
 * Rubric (Epic #2609):
 *   (a) coherent passage — snippet is a multi-sentence window, not a fragment;
 *       a truncated snippet must land on a content-appropriate boundary:
 *       end-of-SENTENCE for prose, end-of-LINE for structured content
 *       (JSON / [tool_result] / code) — ai-01 triage on #4105, 2026-10-07,
 *       after the daily run measured a [tool_result] JSON snippet cut right
 *       after a complete member line ("search_timestamp": "…",\n), which
 *       snapToSentence accepts as a line boundary (search-semantic.tool.ts
 *       l.266/280). No runtime change — this grades what the runtime already
 *       produces; the anti-vacuity unit cases below pin the classifier.
 *   (b) handle — drill_down (conversation_browser view, pre-windowed)
 *   (c) context — conversation_context adjacent turns (data-dependent: legacy
 *       points without message_index cannot anchor it; recorded, not gated)
 *
 * @issue Epic #2609 V3
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { STORM_ACTIVE, STORM_GUARD_RESULT, runStormGuard } from '../storm-guard.js';
import type { CheckResult } from '../verdict.js';
import { handleRooSyncSearch } from '../../../src/tools/search/roosync-search.tool.js';
import { handleDiagnoseSemanticIndex } from '../../../src/tools/indexing/diagnose-index.tool.js';
import { handleSearchTasksSemanticFallback } from '../../../src/tools/search/search-fallback.tool.js';
import type { ConversationSkeleton } from '../../../src/types/conversation.js';

// Epic #2609 baseline query, verbatim (2026-06-16 live measurement)
const SCENARIO_2_ARGS = {
  action: 'semantic',
  search_query: 'coordinator cron cadence decision 3h deep dispatch',
  workspace: 'all',
  max_results: 5,
} as const;

/**
 * Boundary grader for rubric (a), split by content kind (ai-01 triage on
 * #4105, 2026-10-07). snapToSentence legitimately lands an end-of-LINE
 * boundary for structured content — the daily run's failing snippet was a
 * [tool_result] JSON cut right after a complete member line — while prose
 * keeps the end-of-SENTENCE requirement. Pure function: the anti-vacuity
 * unit cases below pin it without any live engine.
 */
function gradeSnippetBoundary(snippet: string): { ok: boolean; kind: 'not-truncated' | 'prose' | 'structured' } {
  if (!snippet.endsWith('...') || snippet.length < 100) {
    return { ok: true, kind: 'not-truncated' };
  }
  const body = snippet.slice(0, -3);
  const structured =
    snippet.includes('[tool_result]')
    || /^\s*[{\[]/.test(snippet)
    || /"[^"\n]+"\s*:\s/.test(body); // ≥1 JSON member line
  if (structured) {
    // End-of-line boundary: the cut respects complete lines/members — right
    // after a newline, or on a member terminator (, ; } ]). A cut in the
    // middle of a member/key fails even for structured content.
    const ok = /\n\s*$/.test(body) || /[,;}\]]\s*$/.test(body);
    return { ok, kind: 'structured' };
  }
  return { ok: /[.!?]["')]?\s*$/.test(body.trim()), kind: 'prose' };
}

beforeAll(async () => {
  await runStormGuard();
});

describe('roosync_search — Epic #2609 scenario 2 (decision passage)', () => {
  it('returns an exploitable decision passage against live engines', async () => {
    if (STORM_ACTIVE) {
      console.log(`[INCONCLUSIVE] Storm guard active: ${STORM_GUARD_RESULT.reason}`);
      expect(STORM_GUARD_RESULT.active).toBe(true);
      return;
    }

    const noopEnsureFresh = async (_args?: { workspace?: string }) => true;
    const realFallbackHandler = async (args: any, cache: Map<string, ConversationSkeleton>) =>
      handleSearchTasksSemanticFallback(args, cache);
    const diagnoseHandler = async () =>
      handleDiagnoseSemanticIndex(new Map<string, ConversationSkeleton>());

    const startMs = Date.now();
    const result = await handleRooSyncSearch(
      SCENARIO_2_ARGS as any,
      new Map<string, ConversationSkeleton>(),
      noopEnsureFresh,
      realFallbackHandler,
      diagnoseHandler
    );
    const latencyMs = Date.now() - startMs;

    const rawText = result.content?.[0] && 'text' in result.content[0]
      ? (result.content[0] as { text: string }).text
      : '';
    const parsed = JSON.parse(rawText);
    const checks: CheckResult[] = [];

    // ---- #637 detector (unchanged from V1) ----
    const noFallback = parsed.fallback_used !== true;
    checks.push({ name: 'fallback_used !== true (#637)', ok: noFallback, observed: String(parsed.fallback_used) });

    // ---- presence ----
    const hasResults = Array.isArray(parsed.results) && parsed.results.length > 0;
    checks.push({ name: 'results.length > 0', ok: hasResults, observed: String(parsed.results?.length) });

    const best = hasResults ? parsed.results[0] : null;
    const bestChunk = best?.chunks?.[0];

    // ---- rubric (a): coherent passage ----
    const snippet: string = bestChunk?.snippet ?? '';
    const passageOk = snippet.length >= 100;
    checks.push({ name: 'rubric(a): snippet >= 100 chars (passage, not fragment)', ok: passageOk, observed: `${snippet.length} chars` });

    // Truncated snippets must land on a content-appropriate boundary:
    // end-of-sentence for prose, end-of-line for structured content (JSON /
    // [tool_result] / code) — see gradeSnippetBoundary (ai-01 triage #4105).
    const boundary = gradeSnippetBoundary(snippet);
    const sentenceEndOk = boundary.ok;
    checks.push({ name: 'rubric(a): truncated snippet ends on content-appropriate boundary (sentence for prose, line for structured)', ok: sentenceEndOk, observed: `[${boundary.kind}] ${snippet.slice(-40)}` });

    // ---- rubric (b): drill-down handle ----
    const drillOk = !!bestChunk?.drill_down
      && bestChunk.drill_down.tool === 'conversation_browser'
      && bestChunk.drill_down.action === 'view'
      && typeof bestChunk.drill_down.task_id === 'string';
    checks.push({
      name: 'rubric(b): drill_down handle present',
      ok: drillOk,
      observed: bestChunk?.drill_down ? JSON.stringify(bestChunk.drill_down) : 'absent',
    });

    const windowed = drillOk
      && typeof bestChunk.drill_down.messageStart === 'number'
      && typeof bestChunk.drill_down.messageEnd === 'number';
    checks.push({ name: 'rubric(b): handle pre-windowed (messageStart/End)', ok: windowed, observed: bestChunk?.message_position ?? 'no message_index on anchor' });

    // ---- rubric (c): adjacent-turn context (data-dependent, recorded) ----
    const ctx = best?.conversation_context;
    const contextOk = !!(ctx?.before_turn?.excerpt || ctx?.after_turn?.excerpt);
    checks.push({
      name: 'rubric(c): conversation_context adjacent turns (informational)',
      ok: contextOk,
      observed: ctx
        ? `before=${!!ctx.before_turn}, after=${!!ctx.after_turn}`
        : (bestChunk?.message_index ? 'anchor has message_index but no adjacent turn indexed' : 'legacy point: no message_index'),
    });

    // ---- console evidence for the verdict report ----
    console.log('=== V3 scenario-2 live evidence ===');
    console.log(`latency_ms=${latencyMs}, unique_tasks=${parsed.unique_tasks ?? parsed.current_machine?.unique_tasks}`);
    console.log(`context_expansion=${JSON.stringify(parsed.current_machine?.context_expansion ?? null)}`);
    if (bestChunk) {
      console.log(`snippet (${snippet.length} chars): ${snippet.slice(0, 240)}`);
      console.log(`drill_down: ${JSON.stringify(bestChunk.drill_down)}`);
      if (ctx?.before_turn) console.log(`before_turn[${ctx.before_turn.message_index}/${ctx.before_turn.role}]: ${ctx.before_turn.excerpt.slice(0, 160)}`);
      if (ctx?.after_turn) console.log(`after_turn[${ctx.after_turn.message_index}/${ctx.after_turn.role}]: ${ctx.after_turn.excerpt.slice(0, 160)}`);
    }
    console.log('checks:', JSON.stringify(checks.map(c => ({ n: c.name, ok: c.ok }))));

    // Hard gates: structural contracts only (data-independent).
    // rubric(c) is NOT gated: it depends on which points the index happens to
    // hold message_index for — absence degrades the result, never breaks it.
    expect(noFallback).toBe(true);
    expect(hasResults).toBe(true);
    expect(passageOk).toBe(true);
    expect(sentenceEndOk).toBe(true);
    expect(drillOk).toBe(true);
  });
});

describe('rubric (a) boundary classifier — unit (anti-vacuity, no live engines)', () => {
  // Pins the classifier so the structured-content relaxation can never
  // degenerate into "any truncated snippet passes". The prose mid-sentence
  // case MUST stay a FAIL — that is the original V3 contract, unchanged.

  const memberLines = '"search_timestamp": "2026-09-29T22:51:16.389Z",\n"query": "coordinator cron cadence decision 3h deep dispatch",\n';

  it('structured: JSON member-line cut is accepted (the ai-01 daily-run datum)', () => {
    const snippet = `[tool_result] ${memberLines.repeat(2)}...`;
    const g = gradeSnippetBoundary(snippet);
    expect(g.kind).toBe('structured');
    expect(g.ok).toBe(true);
  });

  it('structured: cut in the MIDDLE of a member still fails (not a pass-partout)', () => {
    const snippet = `[tool_result] ${memberLines}"search_timestamp": "2026-09-29T22:51:16.3...`;
    const g = gradeSnippetBoundary(snippet);
    expect(g.kind).toBe('structured');
    expect(g.ok).toBe(false);
  });

  it('prose: mid-sentence cut still FAILS (anti-vacuity — the original contract)', () => {
    const base = 'La cadence du coordinateur a été mesurée sur trois semaines complètes avant arbitrage final et validation par l\'utilisateur. ';
    const snippet = `${base.repeat(2)}Les résultats montrent une économie de tokens significative sans perte de couverture des lanes, ce qui a conduit à la déc...`;
    const g = gradeSnippetBoundary(snippet);
    expect(g.kind).toBe('prose');
    expect(g.ok).toBe(false);
  });

  it('prose: sentence-end cut passes', () => {
    const base = 'La cadence du coordinateur a été mesurée sur trois semaines complètes avant arbitrage final et validation par l\'utilisateur. ';
    const snippet = `${base.repeat(3).trimEnd()}...`;
    const g = gradeSnippetBoundary(snippet);
    expect(g.kind).toBe('prose');
    expect(g.ok).toBe(true);
  });

  it('not-truncated snippets are exempt (unchanged behavior)', () => {
    const g = gradeSnippetBoundary('Un passage complet, sans troncature, qui se termine proprement.');
    expect(g.kind).toBe('not-truncated');
    expect(g.ok).toBe(true);
  });
});
