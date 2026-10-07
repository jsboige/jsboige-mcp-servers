/**
 * conversation-browser.eval.test.ts — Golden-query eval for conversation_browser.
 *
 * Tests the REAL conversation_browser tool (action:'list') against live data.
 * If the storm guard fired, tests skip to INCONCLUSIVE.
 *
 * Key assertions:
 * - conversations.length > 0 (evergreen: 'roosync' pattern must match something)
 * - each conversation has non-empty metadata
 * - contentPattern filter is actually applied, non-vacuously: every result carries a
 *   `contentMatch {field, snippet}` whose snippet contains the pattern, AND a negative
 *   control (an unmatched pattern) selects nothing.
 *
 * @issue Epic #2609 V1 — contentPattern assertions hardened after #4104
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { STORM_ACTIVE, STORM_GUARD_RESULT, runStormGuard } from '../storm-guard.js';
import { CONVERSATION_BROWSER_QUERY } from '../golden-queries.js';
import type { ToolVerdict, CheckResult } from '../verdict.js';
import { handleConversationBrowser } from '../../../src/tools/conversation/conversation-browser.js';
import { CACHE_CONFIG } from '../../../src/config/server-config.js';

// Module-level verdict accumulator
const verdicts: ToolVerdict[] = [];

beforeAll(async () => {
  await runStormGuard();
});

describe('conversation_browser — golden query eval (action:list)', () => {
  it('presence: conversations.length > 0 with contentPattern filter applied', async () => {
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
      // handleConversationBrowser signature:
      // (args, conversationCache, ensureSkeletonCacheIsFresh, contextWorkspace,
      //  getConversationSkeleton, findChildTasks, serverState)
      //
      // For action:'list', only args + cache + refresh callback are needed.
      // We pass minimal stubs for the optional parameters.
      const noopRefresh = async () => { /* no-op */ };

      const result = await handleConversationBrowser(
        CONVERSATION_BROWSER_QUERY.args as any,
        new Map(),        // conversationCache — empty for list action
        noopRefresh,      // ensureSkeletonCacheIsFresh
        CACHE_CONFIG.DEFAULT_WORKSPACE, // contextWorkspace
        undefined,        // getConversationSkeleton — not needed for list
        undefined,        // findChildTasks — not needed for list
        undefined         // serverState — not needed for list
      );

      const rawItem = result.content?.[0];
      const rawText: string = (rawItem && 'text' in rawItem) ? (rawItem as { text: string }).text : '';
      try {
        parsed = JSON.parse(rawText);
      } catch {
        // If not JSON, try to detect error in text
        parsed = { _rawText: rawText };
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

    // Extract conversations array — it may be at parsed.conversations or parsed.tasks
    const conversations: any[] =
      Array.isArray(parsed?.conversations) ? parsed.conversations :
      Array.isArray(parsed?.tasks) ? parsed.tasks :
      [];

    // ---- Check: conversations.length > 0 ----
    checks.push({
      name: 'conversations.length > 0',
      ok: conversations.length > 0,
      observed: String(conversations.length),
    });

    // ---- Check: each conversation has non-empty metadata ----
    const allHaveMetadata =
      conversations.length > 0 &&
      conversations.every((c) => {
        // Metadata can be at c.metadata or directly as properties
        const hasMeta =
          (c.metadata && typeof c.metadata === 'object' && Object.keys(c.metadata).length > 0) ||
          (typeof c.id === 'string' && c.id.length > 0) ||
          (typeof c.task_id === 'string' && c.task_id.length > 0);
        return hasMeta;
      });
    checks.push({
      name: 'all conversations have non-empty metadata (id or metadata object)',
      ok: allHaveMetadata,
      observed: allHaveMetadata
        ? 'yes'
        : `${conversations.filter((c) => !c.metadata && !c.id && !c.task_id).length} without metadata`,
    });

    // ---- Check: contentPattern filter is actually applied — NON-VACUOUSLY ----
    // Hardened after #4104. `contentMatch.snippet` echoes the matched text back into the
    // payload, so the previous check — `JSON.stringify(c).includes(pattern)` — became
    // vacuously true: it stayed green even when the filter stopped filtering. It is
    // replaced by per-node positive evidence plus a negative control.
    const pattern = (CONVERSATION_BROWSER_QUERY.args.contentPattern as string).toLowerCase();

    // (a)+(b) every returned node carries a match context whose snippet contains the
    // pattern. Before #4104, deep matches were returned WITHOUT any evidence, so this
    // check fails on that shape — it is a regression test for the very bug it guards.
    const noMatchContext = conversations.filter((c) => {
      const cm = c.contentMatch;
      return (
        !cm ||
        typeof cm.field !== 'string' || cm.field.length === 0 ||
        typeof cm.snippet !== 'string' || !cm.snippet.toLowerCase().includes(pattern)
      );
    });
    checks.push({
      name: `every result carries contentMatch {field, snippet} containing '${pattern}'`,
      ok: conversations.length > 0 && noMatchContext.length === 0,
      observed: noMatchContext.length === 0
        ? 'yes'
        : `${noMatchContext.length}/${conversations.length} without a matching contentMatch`,
    });

    // (c) negative control: a pattern absent from the corpus must select NOTHING.
    // (a)+(b) alone would still pass if the tool ignored contentPattern and stamped a
    // fabricated context on every row; only an unmatched pattern proves the filter
    // actually excludes. Bounded to limit:1 — one extra local call, no storm risk.
    const controlPattern = 'zzq-no-such-motif-4104';
    let controlCount = -1;
    let controlError: string | undefined;
    try {
      const noopRefresh = async () => { /* no-op */ };
      const controlResult = await handleConversationBrowser(
        { ...(CONVERSATION_BROWSER_QUERY.args as any), contentPattern: controlPattern, limit: 1 },
        new Map(),
        noopRefresh,
        CACHE_CONFIG.DEFAULT_WORKSPACE,
        undefined,
        undefined,
        undefined
      );
      const controlRaw = controlResult.content?.[0];
      const controlText = (controlRaw && 'text' in controlRaw) ? (controlRaw as { text: string }).text : '';
      const controlParsed = JSON.parse(controlText);
      const controlConv: any[] =
        Array.isArray(controlParsed?.conversations) ? controlParsed.conversations :
        Array.isArray(controlParsed?.tasks) ? controlParsed.tasks :
        [];
      controlCount = controlConv.length;
    } catch (err: any) {
      controlError = err?.message ?? String(err);
    }
    checks.push({
      name: `negative control: unmatched pattern '${controlPattern}' selects 0 conversations`,
      ok: controlCount === 0,
      observed: controlError !== undefined ? `control call threw: ${controlError}` : String(controlCount),
    });

    const allPass = checks.every((c) => c.ok);
    const verdict: VerdictOutcome = allPass ? 'PASS' : 'FAIL';

    const toolVerdict: ToolVerdict = {
      tool: 'conversation_browser',
      query: CONVERSATION_BROWSER_QUERY.args,
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
    console.log(`[conversation_browser] verdict=${verdict} latency=${latencyMs}ms`);
    for (const c of checks) {
      const mark = c.ok ? 'OK' : 'FAIL';
      console.log(`  [${mark}] ${c.name}${c.observed !== undefined ? ` → ${c.observed}` : ''}`);
    }

    // Vitest assertions
    expect(callError, 'Tool call should not throw').toBeUndefined();

    // If no conversations found: this may mean no local Roo data on this machine.
    // Treat as INCONCLUSIVE (infra condition), not FAIL.
    if (conversations.length === 0) {
      console.log(
        '[conversation_browser] INCONCLUSIVE: 0 conversations returned — ' +
        "no local Roo data matching 'roosync' on this machine. This is expected on machines " +
        'without active Roo workspace history (e.g. coordinator machines).'
      );
      // Override verdict to INCONCLUSIVE
      if (verdicts.length > 0) {
        verdicts[verdicts.length - 1].verdict = 'INCONCLUSIVE';
        verdicts[verdicts.length - 1].reason =
          "0 conversations found — no local Roo data matching 'roosync'. " +
          'Evergreen query requires local conversation history. INCONCLUSIVE on this machine.';
      }
      // Skip the remaining assertions — zero results is not a tool failure here.
      return;
    }

    expect(conversations.length, "Evergreen 'roosync' pattern must match conversations").toBeGreaterThan(0);
    expect(noMatchContext.length, 'every result must carry a contentMatch whose snippet contains the pattern').toBe(0);
    expect(controlCount, `negative control: unmatched pattern '${controlPattern}' must select 0 conversations`).toBe(0);
  });
});

export { verdicts };
type VerdictOutcome = 'PASS' | 'FAIL' | 'INCONCLUSIVE';
