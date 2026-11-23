/**
 * #4879 — the Qdrant upsert breaker's OPEN window grows with consecutive failures.
 *
 * Measured 23/11 (ai-01): the Qdrant data plane was stalled (query/scroll/count
 * timing out on every collection) while 100 % of the wave targeted
 * `roo_tasks_semantic_index`. With a FIXED 30 s window, every indexer process
 * of the fleet re-sent a full HALF_OPEN upsert every ~35 s for as long as the
 * stall lasted, feeding the saturation it was suffering from.
 *
 * Pinned here:
 *   1. window doubling + ceiling (default 15 min),
 *   2. `QDRANT_BREAKER_MAX_OPEN_MS` kill-switch values restore the fixed 30 s,
 *   3. REAL breaker: a failed HALF_OPEN probe doubles the window — still
 *      blocking 30 s later (fails on the pre-#4879 base), no network call while
 *      blocked, and one success resets the window to 30 s,
 *   4. the #4352 recovery loop waits for the breaker's half-open time instead
 *      of re-entering every 35 s against a still-OPEN breaker.
 *
 * Harness: same Qdrant-client mock set as upsert-window-recovery.test.ts.
 *
 * @module services/task-indexer/__tests__/breaker-escalation
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UpsertRecoveryBudget } from '../VectorIndexer.js';

const mockUpsert = vi.fn();

vi.mock('../../qdrant.js', () => ({
    getQdrantClient: vi.fn(() => ({
        upsert: mockUpsert,
    })),
}));

vi.mock('../../openai.js', () => ({
    default: vi.fn(),
    getEmbeddingModel: vi.fn(() => 'text-embedding-3-small'),
    getEmbeddingDimensions: vi.fn(() => 1536),
}));

vi.mock('../EmbeddingValidator.js', () => ({
    validateVectorGlobal: vi.fn(),
    sanitizePayload: vi.fn((p: any) => p || {}),
}));

vi.mock('../QdrantHealthMonitor.js', () => ({
    networkMetrics: { qdrantCalls: 0, bytesTransferred: 0 },
}));

const onePoint = () => [{
    id: 'pt-breaker',
    vector: new Array(1536).fill(0.1),
    payload: { task_id: 't-breaker', content: 'x' },
}] as any[];

const http503 = () => Object.assign(new Error('Service Unavailable'), {
    response: { status: 503, statusText: 'Service Unavailable', data: {} },
});

/** Run one real safeQdrantUpsert to completion under fake timers (its 2 s / 4 s retry sleeps). */
async function runUpsert(mod: typeof import('../VectorIndexer.js')): Promise<boolean> {
    const pending = mod.safeQdrantUpsert(onePoint());
    await vi.runAllTimersAsync();
    return pending;
}

describe('#4879 — breakerOpenWindowMs / breakerMaxOpenMs', () => {
    afterEach(() => {
        delete process.env.QDRANT_BREAKER_MAX_OPEN_MS;
    });

    test('1. the window doubles past the trip threshold and stops at the 15 min ceiling', async () => {
        const { breakerOpenWindowMs, breakerMaxOpenMs } = await import('../VectorIndexer.js');
        delete process.env.QDRANT_BREAKER_MAX_OPEN_MS;
        expect(breakerMaxOpenMs()).toBe(900_000);
        expect(breakerOpenWindowMs(0)).toBe(30_000);
        expect(breakerOpenWindowMs(3)).toBe(30_000);   // trips with the first window
        expect(breakerOpenWindowMs(4)).toBe(60_000);   // one failed probe
        expect(breakerOpenWindowMs(5)).toBe(120_000);
        expect(breakerOpenWindowMs(7)).toBe(480_000);
        expect(breakerOpenWindowMs(8)).toBe(900_000);  // 960 000 capped
        expect(breakerOpenWindowMs(10_000)).toBe(900_000);
    });

    test('2. kill-switch values restore the fixed 30 s window; a valid value sets the ceiling', async () => {
        const { breakerOpenWindowMs, breakerMaxOpenMs } = await import('../VectorIndexer.js');
        for (const v of ['0', 'not-a-number', '-5', '10000']) {
            process.env.QDRANT_BREAKER_MAX_OPEN_MS = v;
            expect(breakerMaxOpenMs()).toBe(30_000);
            expect(breakerOpenWindowMs(9)).toBe(30_000);
        }
        process.env.QDRANT_BREAKER_MAX_OPEN_MS = '120000';
        expect(breakerOpenWindowMs(4)).toBe(60_000);
        expect(breakerOpenWindowMs(6)).toBe(120_000);
    });
});

describe('#4879 — REAL breaker escalation against a stalled Qdrant', () => {
    beforeEach(() => {
        vi.resetModules(); // fresh breaker state per test
        vi.useFakeTimers();
        mockUpsert.mockReset();
        delete process.env.QDRANT_BREAKER_MAX_OPEN_MS;
    });

    afterEach(() => {
        vi.useRealTimers();
        delete process.env.QDRANT_BREAKER_MAX_OPEN_MS;
    });

    test('3. a failed HALF_OPEN probe doubles the window; no network call while blocked; success resets', async () => {
        const mod = await import('../VectorIndexer.js');
        mockUpsert.mockRejectedValue(http503());

        // Trip: 3 fail-outs (each = 3 attempts).
        for (let i = 0; i < 3; i++) expect(await runUpsert(mod)).toBe(false);
        expect(mod.getCircuitBreakerState().state).toBe('OPEN');
        expect(mod.getCircuitBreakerState().msUntilHalfOpen).toBe(30_000);

        // First window elapses → the next call probes HALF_OPEN and fails.
        vi.advanceTimersByTime(30_001);
        expect(mod.isCircuitBreakerBlocking()).toBe(false);
        expect(await runUpsert(mod)).toBe(false);
        expect(mod.getCircuitBreakerState().failureCount).toBe(4);
        expect(mod.getCircuitBreakerState().msUntilHalfOpen).toBe(60_000);

        // 30 s later the breaker is STILL open (pre-#4879: it re-opened here).
        vi.advanceTimersByTime(30_001);
        expect(mod.isCircuitBreakerBlocking()).toBe(true);
        const callsBefore = mockUpsert.mock.calls.length;
        expect(await runUpsert(mod)).toBe(false);
        expect(mockUpsert.mock.calls.length).toBe(callsBefore); // blocked: zero network traffic

        // Past the doubled window → probe allowed; Qdrant is back → CLOSED, window reset.
        vi.advanceTimersByTime(30_000);
        expect(mod.isCircuitBreakerBlocking()).toBe(false);
        mockUpsert.mockReset();
        mockUpsert.mockResolvedValue({ status: 'completed' });
        expect(await runUpsert(mod)).toBe(true);
        const closed = mod.getCircuitBreakerState();
        expect(closed.state).toBe('CLOSED');
        expect(closed.failureCount).toBe(0);

        // The next stall starts again from the first 30 s window.
        mockUpsert.mockReset();
        mockUpsert.mockRejectedValue(http503());
        for (let i = 0; i < 3; i++) await runUpsert(mod);
        expect(mod.getCircuitBreakerState().msUntilHalfOpen).toBe(30_000);
    });

    test('3b. kill-switch: QDRANT_BREAKER_MAX_OPEN_MS=0 keeps the fixed 30 s window after a failed probe', async () => {
        process.env.QDRANT_BREAKER_MAX_OPEN_MS = '0';
        const mod = await import('../VectorIndexer.js');
        mockUpsert.mockRejectedValue(http503());

        for (let i = 0; i < 3; i++) await runUpsert(mod);
        vi.advanceTimersByTime(30_001);
        await runUpsert(mod); // failed probe
        expect(mod.getCircuitBreakerState().msUntilHalfOpen).toBe(30_000);
        vi.advanceTimersByTime(30_001);
        expect(mod.isCircuitBreakerBlocking()).toBe(false);
    });

    test('4. #4352 recovery waits for the breaker half-open time, not a fixed 35 s', async () => {
        const mod = await import('../VectorIndexer.js');
        mockUpsert.mockRejectedValue(http503());

        // Grow the window to 60 s: trip, let it elapse, fail the probe.
        for (let i = 0; i < 3; i++) await runUpsert(mod);
        vi.advanceTimersByTime(30_001);
        await runUpsert(mod);
        expect(mod.getCircuitBreakerState().msUntilHalfOpen).toBe(60_000);

        // Injected window upsert: fails first, succeeds on the recovery re-entry.
        const stub = vi.fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValue(true);
        const budget: UpsertRecoveryBudget = { remainingMs: 600_000 };
        const pending = mod.safeQdrantUpsertWithWindowRecovery(onePoint(), 't-recovery', undefined, budget, stub as any);

        await vi.advanceTimersByTimeAsync(35_001);
        expect(stub).toHaveBeenCalledTimes(1); // pre-#4879: re-entered here, breaker still OPEN

        await vi.advanceTimersByTimeAsync(30_000); // 60 s window + 5 s margin reached
        expect(await pending).toBe(true);
        expect(stub).toHaveBeenCalledTimes(2);
    });
});
