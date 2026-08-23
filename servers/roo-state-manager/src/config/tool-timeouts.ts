/**
 * Single source of truth for the two #2267 anti-hang timeout layers.
 *
 * There are two, and they wrap the SAME call:
 *
 *   1. the per-tool budget, applied inside the registry dispatch
 *      (`getToolTimeoutMs`);
 *   2. the global per-MCP-call guard, applied in `index.ts` around
 *      `originalCallTool` via `Promise.race` (`getMcpToolTimeoutMs`).
 *
 * A race resolves on the FIRST settle, so the tighter of the two governs — and
 * the outer one was tighter than the inner one for `roosync_dashboard`: 300 000 ms
 * outside against a deliberate 720 000 ms inside. Both landed on 2026-06-06, from
 * two PRs of the SAME issue #2267 — #610 set the inner budget, #611 added the outer
 * guard — in two files that never imported each other. Every dashboard condensation was killed at 5 min, which is also where
 * the #1792 truncation circuit-breaker and the #2719 cloud fallback live — both
 * of them scheduled INSIDE the inner budget, hence structurally unreachable.
 * Measured on 4 189 real call durations from this fleet's traces: p99 and max
 * both land on exactly 300.0s, never on 720.
 *
 * The two tables sat in two files that never imported each other, so nothing
 * could compare them; `registry.test.ts` asserted the inner value and passed,
 * while the value that actually governed was elsewhere. Keeping them in one
 * module is what makes the invariant checkable at all.
 *
 * INVARIANT: the outer guard is never tighter than the inner budget. It is
 * enforced by construction in `getMcpToolTimeoutMs` (a `Math.max`), not by
 * convention, so adding a tool to one table can no longer silently preempt the
 * other.
 *
 * @issue #2267 (both layers), #3205 (the disagreement between them)
 */

// #2267: Per-tool timeout configuration (milliseconds).
// Prevents MCP tool calls from hanging indefinitely (22h observed).
// Default: 120s. Heavy tools get longer timeouts.
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
export const TOOL_TIMEOUTS: Record<string, number> = {
    // Indexing/rebuild operations can be slow
    roosync_indexing: 300_000,      // 5 min
    roosync_storage_management: 180_000, // 3 min
    codebase_search: 180_000,       // 3 min (embedding + Qdrant)
    roosync_search: 180_000,        // 3 min
    conversation_browser: 180_000,  // 3 min (can scan large dirs)
    export_data: 180_000,           // 3 min (large exports)
    // roosync_dashboard append/write/condense runs condensation: TWO LLM calls
    // in parallel (qwen3.6-35b reasoning) — generateLLMSummary over the archived
    // messages (~2KB out) AND generateStatusUpdate, which re-ingests the previous
    // status (the project's long-term memory, ~18KB) + ALL messages and evolves
    // it (~18KB out). The status call is the bottleneck: wall-time of 712s has
    // been observed (490s for the status leg alone). The prior 60s cap (#453),
    // then 600s, both cancelled legitimate condensations, write-blocking the
    // fleet's main coord channel (regression — dashboards worked before #453).
    // #2267 follow-up: reduced from 1800s to 720s (12 min). The internal per-LLM-call
    // timeout (CONDENSE_LLM_TIMEOUT_MS, dashboard.ts) was already reduced to 720s.
    // The wrapper timeout aligns to the internal ceiling + circuit-breaker (#1792).
    // This ensures a true hang (stuck GDrive, dead transport) fails within 12 min
    // instead of blocking the MCP connection for 30 min.
    roosync_dashboard: 720_000,     // 12 min (#2267: reduced from 30 min; aligns to CONDENSE_LLM_TIMEOUT_MS)
    roosync_compare_config: 60_000, // 1 min
    roosync_inventory: 60_000,      // 1 min
};

// #833 C3: exported to lock the #2267 per-tool timeout contract under test
// (matches the existing test-hook precedent at L86 `registryLogger` global
// and L90 exported `TOOL_CAPABILITIES`).
export function getToolTimeoutMs(toolName: string): number {
    return TOOL_TIMEOUTS[toolName] ?? DEFAULT_TOOL_TIMEOUT_MS;
}

// #2267: Per-MCP-call global timeout — prevents tool calls from hanging indefinitely.
// Observed incident: roosync_dashboard hung 22h (TBXark session death + GDrive I/O stall).
// Default: 5 min. Override via MCP_TOOL_TIMEOUT_MS env var.
export const MCP_TOOL_TIMEOUT_MS = parseInt(process.env.MCP_TOOL_TIMEOUT_MS || '300000', 10);
// Legitimately-slow tools get a higher cap (10 min).
export const MCP_TOOL_TIMEOUT_OVERRIDES: Readonly<Record<string, number>> = {
    export_data: 600000,
    roosync_baseline: 600000,
    roosync_indexing: 600000,
    roosync_storage_management: 600000,
};

/**
 * Effective global guard for one tool.
 *
 * The `Math.max` is the fix for #3205: whatever the base, the override table or
 * `MCP_TOOL_TIMEOUT_MS` say, the outer guard never fires before the tool's own
 * budget has had its full run — otherwise the recovery paths scheduled inside
 * that budget can never execute, and the guard converts a slow call into a
 * failed one for no gain.
 *
 * `MCP_TOOL_TIMEOUT_MS` therefore still tightens every tool whose inner budget
 * is below it (the majority, at 120s); it can no longer tighten one above it.
 */
export function getMcpToolTimeoutMs(toolName: string): number {
    const outer = MCP_TOOL_TIMEOUT_OVERRIDES[toolName] ?? MCP_TOOL_TIMEOUT_MS;
    return Math.max(outer, getToolTimeoutMs(toolName));
}
