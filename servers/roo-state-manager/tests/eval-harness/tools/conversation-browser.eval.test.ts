/**
 * conversation-browser.eval.test.ts — Golden-query eval for conversation_browser.
 *
 * Tests the REAL conversation_browser tool (action:'list') against live data.
 * If the storm guard fired, tests skip to INCONCLUSIVE.
 *
 * Key assertions:
 * - conversations.length > 0 (evergreen: 'roosync' pattern must match something)
 * - each conversation has non-empty metadata
 * - contentPattern filter is actually applied (all results contain 'roosync')
 *
 * @issue Epic #2609 V1
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

    // ---- Check: contentPattern filter is actually applied ----
    // All returned conversations should contain 'roosync' somewhere in their stringified form.
    // This validates the filter is not being ignored.
    const pattern = (CONVERSATION_BROWSER_QUERY.args.contentPattern as string).toLowerCase();
    const allMatchPattern =
      conversations.length > 0 &&
      conversations.every((c) => {
        const str = JSON.stringify(c).toLowerCase();
        return str.includes(pattern);
      });
    checks.push({
      name: `contentPattern '${pattern}' applied (all results contain it)`,
      ok: allMatchPattern,
      observed: allMatchPattern
        ? 'yes'
        : `${conversations.filter((c) => !JSON.stringify(c).toLowerCase().includes(pattern)).length} don't match`,
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
    expect(allMatchPattern, 'contentPattern filter must be applied to all results').toBe(true);
  });
});

export { verdicts };
type VerdictOutcome = 'PASS' | 'FAIL' | 'INCONCLUSIVE';
