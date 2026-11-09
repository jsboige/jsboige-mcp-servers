/**
 * #4352 (c.325) — bounded in-task upsert recovery at the WINDOW boundary.
 *
 * Tests `safeQdrantUpsertWithWindowRecovery` and the `QDRANT_UPSERT_RECOVERY_MS`
 * kill-switch. The measured incident (ai-01, 09/11, task 0c3b8a34): a Qdrant
 * segment-optimization wedge exhausted the 3 batch attempts in seconds and the
 * task — 1 h 53 of embeddings — went back to the end of the serial queue. The
 * recovery loop waits out one breaker window and re-tries the SAME window with
 * its vectors still hot; the tests below pin each guard:
 *   1. recovery succeeds on a re-entry, budget charged by elapsed time,
 *   2. `0` budget = kill-switch (single attempt, no pause),
 *   3. budget exhaustion returns false (task-level retry takes over),
 *   4. the g5 fence fires between waits (abort during recovery),
 *   5. `onProgress` fires per re-entry (alive, not hung),
 *   6. HTTP 400 (`#2209` permanent) is never recovered,
 *   7. `upsertRecoveryBudgetMs()` env parsing incl. the kill-switch values.
 *
 * The upsert function is injected — no Qdrant client mocking needed here; the
 * boolean contract of `safeQdrantUpsert` itself is covered by
 * circuit-breaker.test.ts.
 *
 * @module services/task-indexer/__tests__/upsert-window-recovery
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    safeQdrantUpsertWithWindowRecovery,
    upsertRecoveryBudgetMs,
    type UpsertRecoveryBudget,
    type UpsertFailureContext,
} from '../VectorIndexer.js';
import type { IndexTaskProgressOptions } from '../VectorIndexer.js';
import { GenericError } from '../../../types/errors.js';

// Keep the recovery pauses real but short: the tests shrink the budget to a
// few tens of ms so Math.min(PAUSE, remaining) never waits the full 35 s.
const TINY_BUDGET_MS = 60;

function makeBudget(ms = TINY_BUDGET_MS): UpsertRecoveryBudget {
    return { remainingMs: ms };
}

function makePoints(n = 2) {
    return Array.from({ length: n }, (_, i) => ({
        id: `pt-${i}`,
        vector: [0.1, 0.2],
        payload: { task_id: 't1', content: 'x' },
    })) as any[];
}

describe('#4352 c.325 — window upsert recovery', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        delete process.env.QDRANT_UPSERT_RECOVERY_MS;
    });

    test('1. recovers on a re-entry after a transient failure and charges the budget by elapsed time', async () => {
        const budget = makeBudget();
        let calls = 0;
        const upsert = vi.fn(async () => {
            calls += 1;
            return calls >= 2; // fail once, succeed on the recovery re-entry
        });
        const ok = await safeQdrantUpsertWithWindowRecovery(makePoints(), 'task-a', undefined, budget, upsert as any);
        expect(ok).toBe(true);
        expect(upsert).toHaveBeenCalledTimes(2);
        // Elapsed ≥ one pause was charged — the budget is NOT the nominal pause.
        expect(budget.remainingMs).toBeLessThanOrEqual(TINY_BUDGET_MS);
        expect(budget.remainingMs).toBeLessThan(TINY_BUDGET_MS);
    });

    test('2. budget 0 = kill-switch: single attempt, no pause, immediate false', async () => {
        const budget = makeBudget(0);
        const upsert = vi.fn(async () => false);
        const ok = await safeQdrantUpsertWithWindowRecovery(makePoints(), 'task-b', undefined, budget, upsert as any);
        expect(ok).toBe(false);
        expect(upsert).toHaveBeenCalledTimes(1);
    });

    test('3. budget exhaustion returns false — the task-level retry + B2 take over', async () => {
        vi.useFakeTimers();
        try {
            const budget = makeBudget(TINY_BUDGET_MS);
            const upsert = vi.fn(async (_p: any, ctx?: UpsertFailureContext) => {
                if (ctx) ctx.permanentFailure = false; // transient forever
                return false;
            });
            const onProgress = vi.fn();
            const options: IndexTaskProgressOptions = { onProgress };
            const pending = safeQdrantUpsertWithWindowRecovery(
                makePoints(), 'task-c', options, budget, upsert as any,
            );
            // Drain the sleeps without letting wall-clock leak into Date.now().
            await vi.runAllTimersAsync();
            const ok = await pending;
            expect(ok).toBe(false);
            // More than the initial attempt: recovery actually re-entered, then
            // gave up once the elapsed budget was spent.
            expect(upsert.mock.calls.length).toBeGreaterThanOrEqual(2);
        } finally {
            vi.useRealTimers();
        }
    });

    test('4. the g5 fence fires between recovery waits (abort mid-recovery)', async () => {
        const controller = new AbortController();
        // Small budget so the pause itself is ms-scale — the abort (10 ms real)
        // must land while the loop sleeps its first wait.
        const budget = makeBudget(120);
        const upsert = vi.fn(async () => false);
        const options: IndexTaskProgressOptions = { signal: controller.signal };
        const pending = safeQdrantUpsertWithWindowRecovery(
            makePoints(), 'task-d', options, budget, upsert as any,
        );
        // Abort while the loop is sleeping its first pause.
        setTimeout(() => controller.abort(new Error('inactivity watchdog')), 10);
        await expect(pending).rejects.toBeInstanceOf(GenericError);
        // First attempt + the re-entries before the abort — never a re-entry
        // AFTER it: the fence is checked between every wait.
        const callsAtAbort = upsert.mock.calls.length;
        await new Promise((r) => setTimeout(r, 20));
        expect(upsert.mock.calls.length).toBe(callsAtAbort);
    });

    test('5. onProgress fires on every re-entry — alive and fence-checked, not hung', async () => {
        const budget = makeBudget();
        const onProgress = vi.fn();
        const options: IndexTaskProgressOptions = { onProgress };
        let calls = 0;
        const upsert = vi.fn(async () => {
            calls += 1;
            return calls >= 2;
        });
        await safeQdrantUpsertWithWindowRecovery(makePoints(), 'task-e', options, budget, upsert as any);
        expect(onProgress).toHaveBeenCalledTimes(1); // one re-entry → one progress
    });

    test('6. HTTP 400 (#2209 permanent) is never recovered, even with budget left', async () => {
        const budget = makeBudget(10_000);
        const upsert = vi.fn(async (_p: any, ctx?: UpsertFailureContext) => {
            if (ctx) ctx.permanentFailure = true;
            return false;
        });
        const ok = await safeQdrantUpsertWithWindowRecovery(makePoints(), 'task-f', undefined, budget, upsert as any);
        expect(ok).toBe(false);
        expect(upsert).toHaveBeenCalledTimes(1); // no recovery loop at all
    });

    test('6b. a 400 landing DURING recovery stops the loop immediately', async () => {
        const budget = makeBudget(120);
        let calls = 0;
        const upsert = vi.fn(async (_p: any, ctx?: UpsertFailureContext) => {
            calls += 1;
            if (calls >= 2 && ctx) ctx.permanentFailure = true;
            return false;
        });
        const ok = await safeQdrantUpsertWithWindowRecovery(makePoints(), 'task-f2', undefined, budget, upsert as any);
        expect(ok).toBe(false);
        expect(calls).toBe(2); // one recovery re-entry, then stop — no further waits
    });

    test('7. upsertRecoveryBudgetMs() parses QDRANT_UPSERT_RECOVERY_MS (default, kill-switch, garbage)', () => {
        delete process.env.QDRANT_UPSERT_RECOVERY_MS;
        expect(upsertRecoveryBudgetMs()).toBe(600_000);
        process.env.QDRANT_UPSERT_RECOVERY_MS = '0';
        expect(upsertRecoveryBudgetMs()).toBe(0);
        process.env.QDRANT_UPSERT_RECOVERY_MS = 'not-a-number';
        expect(upsertRecoveryBudgetMs()).toBe(0);
        process.env.QDRANT_UPSERT_RECOVERY_MS = '-5';
        expect(upsertRecoveryBudgetMs()).toBe(0);
        process.env.QDRANT_UPSERT_RECOVERY_MS = '120000';
        expect(upsertRecoveryBudgetMs()).toBe(120_000);
    });
});
