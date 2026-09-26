/**
 * v3-passage-quality.eval.test.ts — Golden scenario 2 of Epic #2609, live.
 *
 * "Quelle décision sur la cadence du cron coordinateur, et pourquoi" — the
 * query the Epic baseline measured on 2026-06-16 (results: [] pre-#637).
 * Replayed verbatim to grade the V3 contract: the result must be exploitable
 * WITHOUT re-opening a grep.
 *
 * Rubric (Epic #2609):
 *   (a) coherent passage — snippet is a multi-sentence window, not a fragment
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

    // Truncated snippets must land on a sentence end (no mid-sentence cut)
    let sentenceEndOk = true;
    if (snippet.endsWith('...') && snippet.length >= 100) {
      const body = snippet.slice(0, -3);
      sentenceEndOk = /[.!?]["')]?\s*$/.test(body.trim());
    }
    checks.push({ name: 'rubric(a): truncated snippet ends on sentence boundary', ok: sentenceEndOk, observed: snippet.slice(-40) });

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
