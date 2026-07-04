/**
 * Coverage gap-complement for tool-call-metrics.ts.
 *
 * Baseline (post tool-call-metrics.test.ts, 7 tests): 100% stmts / 92.85% branches
 * / 100% funcs / 100% lines. One cold branch remains; covered here.
 *
 * Anchored on source line:
 *   - recordToolCall L32 `errorCount: hadError ? 1 : 0` — the `: 1` (true) arm of
 *     the ternary inside the `else` (new-tool) branch. The base suite only ever
 *     creates a new tool with hadError=false (L25/L35/etc. cover `: 0`), then
 *     records errors on the ALREADY-existing tool (L26 `existing.errorCount++`).
 *     A new tool whose FIRST call has hadError=true → L32 `: 1` is never reached.
 *
 * Discipline: 0 source touched (#1936 anti-churn). Pure-function, no mocks.
 */

import { describe, it, expect, beforeEach } from 'vitest';

describe('tool-call-metrics — coverage gap-complement (cold branch L32)', () => {
    let recordToolCall: typeof import('../tool-call-metrics.js')['recordToolCall'];
    let getToolUsageSnapshot: typeof import('../tool-call-metrics.js')['getToolUsageSnapshot'];
    let resetMetrics: typeof import('../tool-call-metrics.js')['resetMetrics'];

    beforeEach(async () => {
        const mod = await import('../tool-call-metrics.js');
        recordToolCall = mod.recordToolCall;
        getToolUsageSnapshot = mod.getToolUsageSnapshot;
        resetMetrics = mod.resetMetrics;
        resetMetrics();
    });

    // ─── L32 cold arm: new tool whose FIRST call has hadError=true ───

    it('recordToolCall: first call with hadError=true → errorCount initialized to 1 (L32 `: 1` arm)', () => {
        // Cold branch: the ternary `hadError ? 1 : 0` on the new-tool path. The
        // base suite only enters recordToolCall with hadError=false for a brand
        // new tool (covering `: 0`), then increments via L26 on subsequent calls.
        // A first call with hadError=true exercises the `: 1` arm — errorCount
        // starts at 1, not 0.
        recordToolCall('roosync_messages', 250, true);

        const snapshot = getToolUsageSnapshot();
        expect(snapshot.errorTools).toHaveLength(1);
        expect(snapshot.errorTools[0].name).toBe('roosync_messages');
        expect(snapshot.errorTools[0].errorCount).toBe(1);
        // Also confirm the tool is registered in the top/bottom rankings despite
        // the error (errors don't exclude a tool from usage stats).
        expect(snapshot.totalCalls).toBe(1);
        expect(snapshot.uniqueTools).toBe(1);
        expect(snapshot.topTools[0].name).toBe('roosync_messages');
    });

    it('recordToolCall: first-call error then subsequent errors accumulate via L26 (new+existing error path interaction)', () => {
        // Pin the interaction between L32 (`: 1` on first call) and L26
        // (`existing.errorCount++` on subsequent calls). A tool that errors on
        // its first call AND on later calls must accumulate, not reset.
        recordToolCall('roosync_send', 100, true);   // L32 → errorCount = 1
        recordToolCall('roosync_send', 200, true);   // L26 → errorCount = 2
        recordToolCall('roosync_send', 50, false);   // L26 hadError=false → no increment

        const snapshot = getToolUsageSnapshot();
        expect(snapshot.errorTools).toHaveLength(1);
        expect(snapshot.errorTools[0].errorCount).toBe(2);
        expect(snapshot.totalCalls).toBe(3);
    });

    it('getToolUsageSnapshot: errorTools sorted descending by errorCount (multi-tool error ranking pin)', () => {
        // Pin the L70-73 sort: errorTools ranked by errorCount desc. Two tools
        // with distinct error counts must come back in descending order. Mixed
        // first-call-error (L32) and existing-error (L26) paths feed the sort.
        recordToolCall('tool_low', 10, true);   // L32 → 1
        recordToolCall('tool_low', 10, false);

        recordToolCall('tool_high', 10, true);  // L32 → 1
        recordToolCall('tool_high', 10, true);  // L26 → 2
        recordToolCall('tool_high', 10, true);  // L26 → 3

        recordToolCall('tool_clean', 10, false); // no errors → excluded from errorTools

        const snapshot = getToolUsageSnapshot();
        expect(snapshot.errorTools).toHaveLength(2);
        expect(snapshot.errorTools[0].name).toBe('tool_high');
        expect(snapshot.errorTools[0].errorCount).toBe(3);
        expect(snapshot.errorTools[1].name).toBe('tool_low');
        expect(snapshot.errorTools[1].errorCount).toBe(1);
    });
});
