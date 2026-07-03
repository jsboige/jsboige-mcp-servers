/**
 * Coverage tests for auto-heartbeat.ts — cold lazy-init path (#1609).
 *
 * The existing auto-heartbeat.test.ts documents (L50-63) that it CANNOT
 * reliably exercise the cold-arm branch
 *
 *     if (!isInitialized) { initAutoHeartbeat(); }   // auto-heartbeat.ts:41-43
 *
 * because the module-level `isInitialized` flag persists across tests within
 * a file: a prior `initAutoHeartbeat()` call (from the initAutoHeartbeat /
 * getAutoHeartbeatState describe blocks) flips it to `true` before the
 * "self-initialize" test runs, so the `initAutoHeartbeat()` inside
 * `autoHeartbeat` never executes and lines 42-43 stay uncovered.
 *
 * This suite isolates a FRESH module instance via `vi.resetModules()` +
 * dynamic import so `isInitialized === false`, then calls `autoHeartbeat()`
 * WITHOUT a prior `initAutoHeartbeat()` — deterministically hitting the lazy
 * self-initialization branch. Add-only, no source touched (#1936).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('auto-heartbeat — cold lazy-init (coverage)', () => {
    beforeEach(() => {
        // Fresh module registry so `let isInitialized = false` is re-evaluated
        // for each import — this is what makes the cold-arm branch reachable.
        vi.resetModules();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-25T12:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.doUnmock('../../services/lazy-roosync.js');
    });

    it('autoHeartbeat self-initializes when the module was never initialized (L41-43)', async () => {
        const mockRegisterHeartbeat = vi.fn().mockResolvedValue(undefined);
        vi.doMock('../../services/lazy-roosync.js', () => ({
            getRooSyncService: vi.fn().mockResolvedValue({
                registerHeartbeat: mockRegisterHeartbeat,
            }),
        }));

        // Fresh instance: isInitialized === false, lastHeartbeatAt === 0.
        const { autoHeartbeat, getAutoHeartbeatState } = await import('../auto-heartbeat.js');

        // Precondition — the very thing the existing suite can't guarantee:
        // the module has NOT been initialized yet.
        expect(getAutoHeartbeatState().isInitialized).toBe(false);

        // Calling autoHeartbeat directly must run the cold-arm init (L41-43),
        // after which lastHeartbeatAt=0 forces the first heartbeat to fire.
        const result = await autoHeartbeat('cold-start-tool');

        expect(getAutoHeartbeatState().isInitialized).toBe(true);
        expect(result).toBe(true);
        expect(mockRegisterHeartbeat).toHaveBeenCalledWith({ triggeredBy: 'cold-start-tool' });
    });

    it('cold self-init is a no-op on the second call (module stays initialized)', async () => {
        vi.doMock('../../services/lazy-roosync.js', () => ({
            getRooSyncService: vi.fn().mockResolvedValue({
                registerHeartbeat: vi.fn().mockResolvedValue(undefined),
            }),
        }));

        const { autoHeartbeat, getAutoHeartbeatState } = await import('../auto-heartbeat.js');
        expect(getAutoHeartbeatState().isInitialized).toBe(false);

        const first = await autoHeartbeat('first');   // cold-init + trigger (lastHeartbeatAt=0)
        const second = await autoHeartbeat('second');  // within 15min interval → skip

        expect(first).toBe(true);
        expect(second).toBe(false);
        expect(getAutoHeartbeatState().isInitialized).toBe(true);
    });
});
