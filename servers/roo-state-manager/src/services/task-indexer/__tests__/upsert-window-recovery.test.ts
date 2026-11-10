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
 * The upsert function is injected for tests 1-7 — no Qdrant client mocking
 * needed there; the boolean contract of `safeQdrantUpsert` itself is covered by
 * circuit-breaker.test.ts. The closing describe (file 09d item 3, ai-01
 * 09/11) exercises the REAL `safeQdrantUpsert` with a mocked Qdrant client:
 * the HTTP 400 → `UpsertFailureContext.permanentFailure` liaison was only
 * ever tested through an injected stub — the production line that SETS the
 * flag (VectorIndexer #2209 branch) never ran under test.
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

// Real-path mocks (file 09d item 3) — same set as circuit-breaker.test.ts,
// the proven harness for importing VectorIndexer.js with a stub Qdrant client.
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

describe('#4352 — REAL safeQdrantUpsert: HTTP 400 sets permanentFailure (file 09d item 3)', () => {
    // Tests 6/6b above inject an upsert stub that sets the flag by hand — the
    // PRODUCTION line that sets it (the #2209 branch of the real
    // safeQdrantUpsert) never ran. Here the real function runs against a
    // mocked Qdrant client that answers 400, and the wrapper uses its DEFAULT
    // upsert (undefined) — the full production chain end to end.

    const http400 = () => Object.assign(new Error('Bad Request'), {
        response: { status: 400, statusText: 'Bad Request', data: {} },
    });

    const onePoint = () => [{
        id: 'pt-400',
        vector: new Array(1536).fill(0.1),
        payload: { task_id: 't-400', content: 'x' },
    }] as any[];

    beforeEach(() => {
        vi.resetModules(); // fresh circuit-breaker state per test
    });

    afterEach(() => {
        delete process.env.QDRANT_UPSERT_RECOVERY_MS;
    });

    test('8. a real 400 from the Qdrant client marks the failure permanent — no retry, breaker intact', async () => {
        const { safeQdrantUpsert } = await import('../VectorIndexer.js');
        mockUpsert.mockReset();
        mockUpsert.mockRejectedValue(http400());

        const ctx: UpsertFailureContext = {};
        const ok = await safeQdrantUpsert(onePoint(), ctx);

        expect(ok).toBe(false);
        expect(ctx.permanentFailure).toBe(true);          // the production line, exercised
        expect(mockUpsert).toHaveBeenCalledTimes(1);       // 400 short-circuits BEFORE the 3 batch retries
    });

    test('9. the wrapper with its DEFAULT upsert never recovers a real 400 — full chain', async () => {
        const { safeQdrantUpsertWithWindowRecovery } = await import('../VectorIndexer.js');
        mockUpsert.mockReset();
        mockUpsert.mockRejectedValue(http400());

        const budget: UpsertRecoveryBudget = { remainingMs: 600_000 };
        // upsert deliberately omitted → the REAL safeQdrantUpsert runs inside.
        const ok = await safeQdrantUpsertWithWindowRecovery(onePoint(), 't-400-real', undefined, budget);

        expect(ok).toBe(false);
        expect(mockUpsert).toHaveBeenCalledTimes(1);       // first attempt → 400 → permanent, loop never entered
        expect(budget.remainingMs).toBe(600_000);          // no pause charged, budget untouched
    });
});
