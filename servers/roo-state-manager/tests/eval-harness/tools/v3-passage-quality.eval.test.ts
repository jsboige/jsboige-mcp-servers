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
 *       end-of-SENTENCE for prose, end-of-LINE for structured and code
 *       content (JSON / [tool_result] / code) — ai-01 triage on #4105,
 *       2026-10-07, after the daily run measured a [tool_result] JSON
 *       snippet cut right after a complete member line
 *       ("search_timestamp": "…",\n), which snapToSentence accepts as a line
 *       boundary (search-semantic.tool.ts l.266/280). No runtime change —
 *       this grades what the runtime already produces; the shape-based
 *       classifier itself lives in src/utils/snippet-boundary.ts, pinned by
 *       the CI-included unit tests in src/utils/__tests__/ (this suite never
 *       runs in CI).
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
import { gradeSnippetBoundary } from '../../../src/utils/snippet-boundary.js';
import { classifyMachineOutput, isClassifiedInfrastructureError, INFRASTRUCTURE_ERROR_MODES } from '../../../src/tools/search/search-semantic.tool.js';

// Epic #2609 baseline query, verbatim (2026-06-16 live measurement)
const SCENARIO_2_ARGS = {
  action: 'semantic',
  search_query: 'coordinator cron cadence decision 3h deep dispatch',
  workspace: 'all',
  max_results: 5,
  exclude_tool_results: true,
} as const;

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

    const parsed = (result.content ?? []).reduce<any>((payload, item) => {
      if (payload || !('text' in item)) return payload;
      try { return JSON.parse(item.text); } catch { return null; }
    }, null) ?? {};
    const checks: CheckResult[] = [];

    // ---- #637 detector (unchanged from V1) ----
    const noFallback = parsed.fallback_used !== true;
    checks.push({ name: 'fallback_used !== true (#637)', ok: noFallback, observed: String(parsed.fallback_used) });
    if (result.isError && isClassifiedInfrastructureError(result)) {
      console.log(`[INCONCLUSIVE] classified infrastructure error: ${result.content?.find((c: any) => 'text' in c)?.text ?? 'unknown'}`);
      expect(isClassifiedInfrastructureError(result)).toBe(true);
      return;
    }
    if (result.isError) {
      console.log(`[roosync_search] verdict=FAIL latency=${latencyMs}ms functional_error=${result.content?.find((c: any) => 'text' in c)?.text ?? 'unknown'}`);
      expect(result.isError, 'unclassified semantic errors are functional failures, not INCONCLUSIVE').not.toBe(true);
      return;
    }
    if (parsed.semantic_degraded === true && typeof parsed.semantic_error_mode === 'string'
      && !INFRASTRUCTURE_ERROR_MODES.has(parsed.semantic_error_mode)) {
      // The text fallback fires on every semantic failure (#249), so the mode is
      // what separates an outage from a defect: an UNCLASSIFIED mode is a
      // functional failure, not an unmeasured run.
      console.log(`[roosync_search] verdict=FAIL latency=${latencyMs}ms unclassified_semantic_error=${parsed.semantic_error_mode}`);
      expect(false, `degraded fallback caused by an unclassified semantic error (${parsed.semantic_error_mode}) is a functional failure`).toBe(true);
      return;
    }
    if (parsed.semantic_degraded === true || parsed.fallback_used === true) {
      console.log(`[INCONCLUSIVE] semantic search degraded: ${parsed.semantic_error ?? parsed.fallback_reason ?? 'unknown'}`);
      expect(parsed.semantic_degraded === true || parsed.fallback_used === true).toBe(true);
      return;
    }

    // ---- presence ----
    const hasResults = Array.isArray(parsed.results) && parsed.results.length > 0;
    checks.push({ name: 'results.length > 0', ok: hasResults, observed: String(parsed.results?.length) });

    const best = hasResults ? parsed.results[0] : null;
    const bestChunk = best?.chunks?.[0];
    const machineKind = bestChunk?.machine_output_kind ?? classifyMachineOutput(bestChunk?.chunk_type, bestChunk?.snippet ?? '');
    const humanPassageOk = machineKind === null && bestChunk?.tool_continuation_status !== 'unknown';
    checks.push({ name: 'rubric(a): best passage is human-authored prose, not machine output', ok: humanPassageOk, observed: machineKind ?? 'prose' });
    const cadenceDecisionOk = /cadence|cron|coordinateur|coordinator|dispatch/i.test(bestChunk?.snippet ?? '')
      && /(?:\d+\s*(?:h|min|heure)|every\s+\d+|toutes?\s+les\s+\d+)/i.test(bestChunk?.snippet ?? '');
    checks.push({ name: 'known-answer: passage states the coordinator cadence decision', ok: cadenceDecisionOk, observed: cadenceDecisionOk ? 'cadence + interval' : 'decision vocabulary or interval missing' });
    const decisionEvidence = [bestChunk?.snippet, best?.conversation_context?.before_turn?.excerpt, best?.conversation_context?.after_turn?.excerpt].filter(Boolean).join('\n');
    const rationaleOk = /parce que|because|pourquoi|afin de|pour éviter|to avoid|so that|raison|coût|charge|latence/i.test(decisionEvidence);
    checks.push({ name: 'known-answer: passage or adjacent turns carry the decision rationale', ok: rationaleOk, observed: rationaleOk ? 'rationale present' : 'no reasoning in passage/context' });

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

    const allPass = checks.filter(c => !c.name.includes('informational')).every(c => c.ok);
    console.log(`[roosync_search] verdict=${allPass ? 'PASS' : 'FAIL'} latency=${latencyMs}ms`);
    for (const c of checks) console.log(`[${c.ok ? 'OK' : 'FAIL'}] ${c.name}${c.observed !== undefined ? ` -> ${c.observed}` : ''}`);

    // Adjacent turns are recorded but corpus-dependent; every other rubric is
    // a hard gate, including human-authored content on the cadence decision.
    expect(noFallback).toBe(true);
    expect(hasResults).toBe(true);
    expect(humanPassageOk).toBe(true);
    expect(cadenceDecisionOk).toBe(true);
    expect(rationaleOk).toBe(true);
    expect(passageOk).toBe(true);
    expect(sentenceEndOk).toBe(true);
    expect(drillOk).toBe(true);
  });
});

// The classifier's anti-vacuity unit pin (prose mid-sentence FAILs
// unconditionally, embedded-member prose stays prose, code line-boundary
// passes, mid-member/mid-line fail) lives in
// src/utils/__tests__/snippet-boundary.test.ts — CI-included, because this
// eval-harness suite never runs in CI (vitest.config.ci.ts).