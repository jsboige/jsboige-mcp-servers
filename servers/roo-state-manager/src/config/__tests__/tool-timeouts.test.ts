/**
 * The two #2267 timeout layers must not disagree (#3205).
 *
 * `registry.test.ts` already locks the INNER per-tool budget, and it passed
 * throughout the incident — because the value it asserts is not the value that
 * governs. `index.ts` raced a second, global guard around the same call, and a
 * race settles on the FIRST to fire: for `roosync_dashboard` that was the outer
 * 300s, never the deliberate inner 720s. A test that checks the neighbour of the
 * property that matters guards nothing, so these cases assert the EFFECTIVE
 * ceiling — what a caller actually gets — and the ordering between the layers.
 */

import { describe, test, expect } from 'vitest';
import {
    TOOL_TIMEOUTS,
    MCP_TOOL_TIMEOUT_OVERRIDES,
    MCP_TOOL_TIMEOUT_MS,
    DEFAULT_TOOL_TIMEOUT_MS,
    getToolTimeoutMs,
    getMcpToolTimeoutMs,
} from '../tool-timeouts.js';

describe('#3205: the outer guard never preempts the inner budget', () => {
    const everyConfiguredTool = [
        ...new Set([
            ...Object.keys(TOOL_TIMEOUTS),
            ...Object.keys(MCP_TOOL_TIMEOUT_OVERRIDES),
        ]),
    ];

    test.each(everyConfiguredTool)(
        '%s — effective global guard >= per-tool budget',
        (tool) => {
            expect(getMcpToolTimeoutMs(tool)).toBeGreaterThanOrEqual(getToolTimeoutMs(tool));
        },
    );

    test('an unconfigured tool is still covered by the invariant', () => {
        expect(getMcpToolTimeoutMs('some_unmapped_future_tool'))
            .toBeGreaterThanOrEqual(getToolTimeoutMs('some_unmapped_future_tool'));
    });

    test('roosync_dashboard gets its full 720s — the regression this fixes', () => {
        // Was 300_000: the condensation, the #1792 truncation circuit-breaker and
        // the #2719 cloud fallback all live inside the 720s budget, so a 300s outer
        // guard made every one of them unreachable. Measured p99 and max across
        // 4 189 real calls: exactly 300.0s, never 720.
        expect(getToolTimeoutMs('roosync_dashboard')).toBe(720_000);
        expect(getMcpToolTimeoutMs('roosync_dashboard')).toBe(720_000);
        expect(getMcpToolTimeoutMs('roosync_dashboard')).toBeGreaterThan(MCP_TOOL_TIMEOUT_MS);
    });
});

describe('#3205: the global guard keeps doing its #2267 job', () => {
    test('it still tightens tools whose own budget is below it', () => {
        // The anti-hang guard is the point of #2267 and must survive the fix: a
        // 120s tool is still cut at the 300s global ceiling, not left to hang.
        expect(getToolTimeoutMs('touch_mcp_settings')).toBe(DEFAULT_TOOL_TIMEOUT_MS);
        expect(getMcpToolTimeoutMs('touch_mcp_settings')).toBe(MCP_TOOL_TIMEOUT_MS);
        expect(MCP_TOOL_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TOOL_TIMEOUT_MS);
    });

    test('the override table still raises the slow tools it was written for', () => {
        for (const [tool, ms] of Object.entries(MCP_TOOL_TIMEOUT_OVERRIDES)) {
            expect(getMcpToolTimeoutMs(tool)).toBeGreaterThanOrEqual(ms);
        }
        expect(getMcpToolTimeoutMs('export_data')).toBe(600_000);
    });

    test('roosync_baseline has no inner budget, so the override alone governs', () => {
        // Guards the Math.max against a lopsided reading: it must not shrink an
        // override down to DEFAULT_TOOL_TIMEOUT_MS for tools absent from TOOL_TIMEOUTS.
        expect(TOOL_TIMEOUTS.roosync_baseline).toBeUndefined();
        expect(getMcpToolTimeoutMs('roosync_baseline')).toBe(600_000);
    });
});
