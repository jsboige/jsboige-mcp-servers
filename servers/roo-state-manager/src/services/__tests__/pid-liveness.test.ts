/**
 * #4352 — unit tests for the shared PID liveness probe used by both leader
 * elections (Qdrant indexer + Worker A). The probe is production code shared by
 * both locks, so it gets its own suite instead of being re-probed per election.
 */
import { describe, it, expect } from 'vitest';
import { isProcessAlive } from '../pid-liveness.js';

describe('isProcessAlive — #4352', () => {
    it('reports our own process and our parent as alive', () => {
        // Alive by construction: the vitest worker (ppid) is running this test.
        expect(isProcessAlive(process.pid)).toBe(true);
        expect(isProcessAlive(process.ppid)).toBe(true);
    });

    it('rejects non-positive and non-integer pids without probing', () => {
        expect(isProcessAlive(0)).toBe(false);
        expect(isProcessAlive(-1)).toBe(false);
        expect(isProcessAlive(1.5)).toBe(false);
        expect(isProcessAlive(Number.NaN)).toBe(false);
    });

    it('reports a provably-dead pid as dead', () => {
        // High, sparsely-populated range (Windows PIDs are multiples of 4).
        let dead = -1;
        for (let candidate = 400000; candidate < 1000000 && dead === -1; candidate += 4) {
            if (!isProcessAlive(candidate)) dead = candidate;
        }
        expect(dead).toBeGreaterThan(0);
        // Stability across two calls — this is the value the lock tests seed.
        expect(isProcessAlive(dead)).toBe(false);
    });
});
