/**
 * #4352 g5 — the inactivity watchdog that replaces the wall-clock task timeout.
 *
 * The 16 sessions of 27/10 died at a TOTAL-time cap while their batches kept
 * landing; the Promise.race loser then kept embedding in the background and the
 * retry raced a second run of the same task. These tests pin the four
 * behaviours the grain demands:
 *   1. a run that keeps acknowledging batches NEVER times out;
 *   2. a silent run fails with the inactivity wording (embedding_timeout class);
 *   3. the watchdog ABORTS the orphan, which fences itself at its checkpoint;
 *   4. INDEX_TASK_INACTIVITY_MS=0 (kill-switch) restores the legacy wall clock,
 *      including its no-abort behaviour;
 *   5. a fence fails its OWN task but never debits the seat-wide breaker
 *      (review ms#1548 B2 — three fences used to OPEN it and defer every task).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { runIndexingWithInactivityWatchdog } from '../background-services.js';
import {
    throwIfIndexingAborted,
    getCircuitBreakerState,
    isCircuitBreakerBlocking,
    indexTask,
} from '../task-indexer/VectorIndexer.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('runIndexingWithInactivityWatchdog (#4352 g5)', () => {
    const savedEnv: Record<string, string | undefined> = {};
    const envKeys = ['INDEX_TASK_INACTIVITY_MS', 'INDEX_TASK_TIMEOUT_MS'];

    beforeEach(() => {
        for (const k of envKeys) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    });
    afterEach(() => {
        for (const k of envKeys) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    });

    it('a run that keeps acknowledging batches never times out, whatever its total duration', async () => {
        process.env.INDEX_TASK_INACTIVITY_MS = '120';
        let batches = 0;
        const result = await runIndexingWithInactivityWatchdog('task-progress', async ({ onProgress }) => {
            // 14 batches x 100 ms = 1400 ms total — ten times the 120 ms budget, and
            // past the watchdog's 1 s tick floor: only the deadline RESETS keep it
            // alive (a mutant that drops the reset dies at the first tick). This is
            // the monolithic-session case: long total, never a long gap.
            for (let i = 0; i < 14; i++) {
                await sleep(100);
                batches++;
                onProgress();
            }
            return batches;
        });
        expect(result).toBe(14);
        expect(batches).toBe(14);
    });

    it('a silent run fails with the inactivity wording (embedding_timeout stays retryable)', async () => {
        process.env.INDEX_TASK_INACTIVITY_MS = '80';
        await expect(runIndexingWithInactivityWatchdog('task-silent', async () => {
            await sleep(3000); // hung embed call — never acknowledges, never resolves
            return 0;
        })).rejects.toThrow(/Indexing timeout for task-silent — no batch acknowledged for 80ms/);
    });

    it('the watchdog ABORTS the orphan — the fenced run stops at its checkpoint instead of competing with the retry', async () => {
        process.env.INDEX_TASK_INACTIVITY_MS = '80';
        let orphanOutcome: 'running' | 'fenced' | 'completed' = 'running';
        await expect(runIndexingWithInactivityWatchdog('task-orphan', async ({ signal }) => {
            try {
                // a run that never acknowledges (the hang) but WOULD keep going:
                // without the fence it runs its 50 iterations in the background
                // while the retry starts the same task a second time.
                for (let i = 0; i < 50; i++) {
                    throwIfIndexingAborted({ signal }, 'task-orphan');
                    await sleep(50);
                }
                orphanOutcome = 'completed';
                return 0;
            } catch (error) {
                orphanOutcome = 'fenced';
                throw error;
            }
        })).rejects.toThrow(/no batch acknowledged for 80ms/);
        // give the loser time to hit its next checkpoint and settle
        await sleep(300);
        expect(orphanOutcome).toBe('fenced');
    });

    it('throwIfIndexingAborted: always throws a MARKED GenericError (watchdogAbort), keeping the classifiable wording', async () => {
        // Review ms#1548 B2: the mark is what keeps a fence out of the breaker, so
        // it must be present on EVERY abort path — the Error-reason path (the one
        // the watchdog actually produces) and the non-Error fallback.
        const controller = new AbortController();
        const reason = new Error('Indexing timeout for t — no batch acknowledged for 80ms (inactivity watchdog #4352 g5)');
        controller.abort(reason);
        let thrown: any = null;
        try { throwIfIndexingAborted({ signal: controller.signal }, 't'); } catch (e) { thrown = e; }
        expect(thrown).not.toBeNull();
        expect(thrown.message).toBe(reason.message);
        expect(thrown.details?.watchdogAbort).toBe(true);

        // non-Error reason: still marked, still classifiable
        const controller2 = new AbortController();
        controller2.abort('boom');
        let thrown2: any = null;
        try { throwIfIndexingAborted({ signal: controller2.signal }, 't'); } catch (e) { thrown2 = e; }
        expect(thrown2.details?.watchdogAbort).toBe(true);
        expect(thrown2.message).toMatch(/Indexing timeout for t — inactivity watchdog/);

        // not aborted / no options: no-op
        expect(() => throwIfIndexingAborted({ signal: new AbortController().signal }, 't')).not.toThrow();
        expect(() => throwIfIndexingAborted(undefined, 't')).not.toThrow();
    });

    it('three watchdog fences in a row leave the seat breaker CLOSED — a fence is not a backend failure (review ms#1548 B2)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const before = getCircuitBreakerState();
            const taskPath = path.join(os.tmpdir(), 'never-extracted');

            for (let i = 1; i <= 3; i++) {
                const controller = new AbortController();
                controller.abort(new Error(
                    `Indexing timeout for task-fence-${i} — no batch acknowledged for 180000ms (inactivity watchdog #4352 g5)`
                ));
                const err: any = await indexTask(`task-fence-${i}`, taskPath, 'roo', undefined, { signal: controller.signal })
                    .then(() => null, (e: unknown) => e);

                // the fence still FAILS the task (retryable embedding_timeout class)…
                expect(err).not.toBeNull();
                expect(err.message).toMatch(/Indexing timeout for task-fence-/);
                expect(err.details?.watchdogAbort).toBe(true);
                // …but costs the fleet nothing: no debit per fence
                expect(getCircuitBreakerState().failureCount).toBe(before.failureCount);
            }

            const after = getCircuitBreakerState();
            expect(after.failureCount).toBe(before.failureCount);
            expect(after.state).toBe('CLOSED');
            expect(isCircuitBreakerBlocking()).toBe(false);
        } finally {
            errorSpy.mockRestore();
            logSpy.mockRestore();
        }
    });

    it('kill-switch INDEX_TASK_INACTIVITY_MS=0 restores the legacy wall clock — and does NOT abort its loser', async () => {
        process.env.INDEX_TASK_INACTIVITY_MS = '0';
        process.env.INDEX_TASK_TIMEOUT_MS = '1'; // 1 s wall clock
        let sawAbort: boolean | null = null;
        const run = runIndexingWithInactivityWatchdog('task-legacy', async ({ signal }) => {
            await sleep(1500);
            sawAbort = signal.aborted;
            return 0;
        });
        await expect(run).rejects.toThrow(/Indexing timeout for task-legacy after 1000ms/);
        // let the loser settle, then read what it observed: the legacy path never
        // fences — the orphan defect is exactly what the kill-switch reinstates.
        await sleep(700);
        expect(sawAbort).toBe(false);
    });
});
