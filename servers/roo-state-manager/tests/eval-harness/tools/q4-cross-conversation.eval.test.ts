/**
 * q4-cross-conversation.eval.test.ts — Golden scenario 4 of Epic #2609, live.
 *
 * "Les arbitrages encore ouverts cette semaine avec leur contexte" — the only
 * golden scenario never covered by the harness (3/4 since June 2026). Graded
 * as a SYNTHESIS scaffold: the agent must see multiple distinct conversations,
 * each openable via a handle, with when/where metadata — without re-opening
 * a grep on the JSONL.
 *
 * Rubric (Epic #2609, adapted to the synthesis case):
 *   (cross)  ≥2 distinct conversations (unique_tasks) across ≥2 workspaces
 *   (b)      handle — drill_down on the best chunk of each top group
 *   (d)      metadata — relative_time and/or conversation_stats.last_activity
 *   (a)      >=2 human-authored decision passages across >=2 top-3 conversations
 *
 * exclude_tool_results=true is the best measured lever for decision-content
 * queries (live 2026-10-05: 5/7 top slots were tool_interaction JSON fragments
 * without it, 0/7 with it).
 *
 * @issue Epic #2609 scenario 4 (V1 coverage)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { STORM_ACTIVE, STORM_GUARD_RESULT, runStormGuard } from '../storm-guard.js';
import type { CheckResult } from '../verdict.js';
import { writeVerdictArtifact } from '../verdict-artifact.js';
import { CROSS_CONVERSATION_QUERY } from '../golden-queries.js';
import { handleRooSyncSearch } from '../../../src/tools/search/roosync-search.tool.js';
import { handleDiagnoseSemanticIndex } from '../../../src/tools/indexing/diagnose-index.tool.js';
import { handleSearchTasksSemanticFallback } from '../../../src/tools/search/search-fallback.tool.js';
import type { ConversationSkeleton } from '../../../src/types/conversation.js';
import { classifyMachineOutput, isClassifiedInfrastructureError, INFRASTRUCTURE_ERROR_MODES } from '../../../src/tools/search/search-semantic.tool.js';

// Fleet evergreen: "open arbitrations" is core coordination vocabulary, present
// in every era of the corpus (verified 2026-10-05: 24 results / 7 unique tasks /
// 4 machines / 7 distinct workspaces).
const SCENARIO_4_ARGS = CROSS_CONVERSATION_QUERY.args;

beforeAll(async () => {
  await runStormGuard();
});

describe('roosync_search — Epic #2609 scenario 4 (cross-conversation synthesis)', () => {
  it('returns a synthesis scaffold spanning multiple conversations', async () => {
    if (STORM_ACTIVE) {
      writeVerdictArtifact({
        tool: 'roosync_search',
        scenario: 'scenario-4-cross-conversation',
        verdict: 'INCONCLUSIVE',
        reason: `storm guard active: ${STORM_GUARD_RESULT.reason}`,
        checks: [],
        latency_ms: 0,
        timestamp: new Date().toISOString(),
      });
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
      SCENARIO_4_ARGS as any,
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

    // ---- #637 detector (same as scenarios 1-3) ----
    const noFallback = parsed.fallback_used !== true;
    checks.push({ name: 'fallback_used !== true (#637)', ok: noFallback, observed: String(parsed.fallback_used) });
    if (result.isError && isClassifiedInfrastructureError(result)) {
      writeVerdictArtifact({
        tool: 'roosync_search',
        scenario: 'scenario-4-cross-conversation',
        verdict: 'INCONCLUSIVE',
        reason: 'classified infrastructure error',
        checks: [],
        latency_ms: latencyMs,
        timestamp: new Date().toISOString(),
      });
      console.log(`[INCONCLUSIVE] classified infrastructure error: ${result.content?.find((c: any) => 'text' in c)?.text ?? 'unknown'}`);
      expect(isClassifiedInfrastructureError(result)).toBe(true);
      return;
    }
    if (result.isError) {
      writeVerdictArtifact({
        tool: 'roosync_search',
        scenario: 'scenario-4-cross-conversation',
        verdict: 'FAIL',
        reason: 'unclassified semantic error: functional failure',
        checks: checks,
        latency_ms: latencyMs,
        timestamp: new Date().toISOString(),
      });
      console.log(`[roosync_search] verdict=FAIL latency=${latencyMs}ms functional_error=${result.content?.find((c: any) => 'text' in c)?.text ?? 'unknown'}`);
      expect(result.isError, 'unclassified semantic errors are functional failures, not INCONCLUSIVE').not.toBe(true);
      return;
    }
    if (parsed.semantic_degraded === true && typeof parsed.semantic_error_mode === 'string'
      && !INFRASTRUCTURE_ERROR_MODES.has(parsed.semantic_error_mode)) {
      writeVerdictArtifact({
        tool: 'roosync_search',
        scenario: 'scenario-4-cross-conversation',
        verdict: 'FAIL',
        reason: `unclassified semantic error mode: ${parsed.semantic_error_mode}`,
        checks: checks,
        latency_ms: latencyMs,
        timestamp: new Date().toISOString(),
      });
      console.log(`[roosync_search] verdict=FAIL latency=${latencyMs}ms unclassified_semantic_error=${parsed.semantic_error_mode}`);
      expect(false, `degraded fallback caused by an unclassified semantic error (${parsed.semantic_error_mode}) is a functional failure`).toBe(true);
      return;
    }
    if (parsed.semantic_degraded === true || parsed.fallback_used === true) {
      writeVerdictArtifact({
        tool: 'roosync_search',
        scenario: 'scenario-4-cross-conversation',
        verdict: 'INCONCLUSIVE',
        reason: `semantic search degraded: ${parsed.semantic_error ?? parsed.fallback_reason ?? 'unknown'}`,
        checks: [],
        latency_ms: latencyMs,
        timestamp: new Date().toISOString(),
      });
      console.log(`[INCONCLUSIVE] semantic search degraded: ${parsed.semantic_error ?? parsed.fallback_reason ?? 'unknown'}`);
      expect(parsed.semantic_degraded === true || parsed.fallback_used === true).toBe(true);
      return;
    }

    // ---- presence ----
    const hasResults = Array.isArray(parsed.results) && parsed.results.length > 0;
    checks.push({ name: 'results.length > 0', ok: hasResults, observed: String(parsed.results?.length) });

    // ---- rubric (cross): multiple distinct conversations ----
    const uniqueTasks: number = parsed.current_machine?.unique_tasks ?? 0;
    const crossTasksOk = uniqueTasks >= 2;
    checks.push({ name: 'rubric(cross): unique_tasks >= 2', ok: crossTasksOk, observed: `${uniqueTasks} tasks` });

    const workspaces = new Set((parsed.results ?? []).map((r: any) => r.workspace).filter(Boolean));
    const crossWorkspaceOk = workspaces.size >= 2;
    checks.push({
      name: 'rubric(cross): >= 2 distinct workspaces',
      ok: crossWorkspaceOk,
      observed: `${workspaces.size} workspaces: ${[...workspaces].slice(0, 5).join(', ')}`,
    });

    // ---- rubric (b): handle on each top group ----
    const top = (parsed.results ?? []).slice(0, 2);
    const handlesOk = top.length > 0 && top.every((r: any) => {
      const dd = r?.chunks?.[0]?.drill_down;
      return dd?.tool === 'conversation_browser' && dd?.action === 'view' && typeof dd?.task_id === 'string';
    });
    checks.push({
      name: 'rubric(b): drill_down handle on each top group',
      ok: handlesOk,
      observed: top.map((r: any) => r?.chunks?.[0]?.drill_down ? 'present' : 'ABSENT').join(' | '),
    });

    // ---- rubric (d): when/where metadata ----
    const metadataOk = top.every((r: any) => {
      const when = r?.chunks?.[0]?.relative_time || r?.conversation_stats?.last_activity;
      return !!when && !!r?.taskId;
    });
    checks.push({
      name: 'rubric(d): when-metadata + taskId on each top group',
      ok: metadataOk,
      observed: top.map((r: any) => r?.chunks?.[0]?.relative_time || r?.conversation_stats?.last_activity || 'NONE').join(' | '),
    });

    // A sub-sentence or machine-output fragment is not the answer even if its
    // handle and metadata are perfect; that is precisely the Epic baseline.
    const top3 = (parsed.results ?? []).slice(0, 3);
    const humanPassages = top3.filter((r: any) => {
      const c = r?.chunks?.[0];
      return (c?.snippet?.length ?? 0) >= 100
        && (c?.machine_output_kind ?? classifyMachineOutput(c?.chunk_type, c?.snippet ?? '')) === null
        && c?.tool_continuation_status !== 'unknown'
        && /arbitrage|décision|decision|en attente|pending|ouverte?/i.test(c?.snippet ?? '')
        && !/redétaille|redetaille|détaille les arbitrages|detaille les arbitrages/i.test(c?.snippet ?? '');
    });
    const passageInTop3 = humanPassages.length >= 2
      && new Set(humanPassages.map((r: any) => r.taskId)).size >= 2;
    checks.push({
      name: 'rubric(a): >=2 human-authored decision passages across >=2 top-3 conversations',
      ok: passageInTop3,
      observed: top3.map((r: any) => `${r?.chunks?.[0]?.snippet?.length ?? 0}c/${classifyMachineOutput(r?.chunks?.[0]?.chunk_type, r?.chunks?.[0]?.snippet ?? '') ?? 'prose'}`).join(', '),
    });

    // ---- observability of the fragment de-rank lever (informational) ----
    const fragMalus = parsed.current_machine?.fragment_malus;
    checks.push({
      name: 'fragment_malus observability (informational)',
      ok: true,
      observed: fragMalus ? `applied=${fragMalus.applied}` : 'quiet (no fragment in candidates or rollback)',
    });

    // ---- console evidence for the verdict report ----
    console.log('=== q4 cross-conversation live evidence ===');
    console.log(`latency_ms=${latencyMs}, unique_tasks=${uniqueTasks}, workspaces=${workspaces.size}`);
    console.log(`machines_found=${JSON.stringify(parsed.cross_machine_analysis?.machines_found)}`);
    console.log(`context_expansion=${JSON.stringify(parsed.current_machine?.context_expansion ?? null)}`);
    console.log(`fragment_malus=${JSON.stringify(fragMalus ?? null)}`);
    for (const r of top3) {
      const c = r?.chunks?.[0];
      console.log(`- [${r.taskId}] ws=${r.workspace} score=${r.best_score?.toFixed(4)} len=${c?.snippet?.length ?? 0}c :: ${String(c?.snippet ?? '').slice(0, 140)}`);
    }
    console.log('checks:', JSON.stringify(checks.map(c => ({ n: c.name, ok: c.ok }))));

    const allPass = checks.every(c => c.ok);
    writeVerdictArtifact({
      tool: 'roosync_search',
      scenario: 'scenario-4-cross-conversation',
      verdict: allPass ? 'PASS' : 'FAIL',
      reason: allPass ? 'all gates measured and passed' : 'one or more gates failed',
      checks: checks,
      latency_ms: latencyMs,
      timestamp: new Date().toISOString(),
    });
    console.log(`[roosync_search] verdict=${allPass ? 'PASS' : 'FAIL'} latency=${latencyMs}ms`);
    for (const c of checks) console.log(`[${c.ok ? 'OK' : 'FAIL'}] ${c.name}${c.observed !== undefined ? ` -> ${c.observed}` : ''}`);

    // Every rubric is gated: coherent human passages, not only handles and
    // conversation counts, are what make the synthesis scaffold exploitable.
    expect(noFallback).toBe(true);
    expect(hasResults).toBe(true);
    expect(crossTasksOk).toBe(true);
    expect(crossWorkspaceOk).toBe(true);
    expect(handlesOk).toBe(true);
    expect(metadataOk).toBe(true);
    expect(passageInTop3).toBe(true);
  });
});
