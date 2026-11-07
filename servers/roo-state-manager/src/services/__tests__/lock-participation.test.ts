/**
 * Tests for #4352 W2 (ms#1683 review): leader-lock participation flags.
 *
 * gracefulShutdown gates the lock-release dynamic imports on
 * wasAnyLockAttempted() so processes that never entered an election skip the
 * imports entirely (they consumed #3151's shutdown drain budget for nothing).
 * These tests pin the flag semantics the gate relies on:
 *   - the flag is set on EVERY acquisition attempt, win or lose;
 *   - each election has its own flag, either satisfies the gate;
 *   - the gate stays false until a production primitive actually ran.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
    markLeaderLockAttempted,
    markWorkerALockAttempted,
    wasAnyLockAttempted,
    wasLeaderLockAttempted,
    wasWorkerALockAttempted,
    __resetLockParticipationForTests,
} from '../lock-participation.js';

describe('lock-participation flags — #4352 W2', () => {
    beforeEach(() => {
        __resetLockParticipationForTests();
    });

    it('gate is false until any election was attempted', () => {
        expect(wasAnyLockAttempted()).toBe(false);
        expect(wasLeaderLockAttempted()).toBe(false);
        expect(wasWorkerALockAttempted()).toBe(false);
    });

    it('either election alone satisfies the gate', () => {
        markLeaderLockAttempted();
        expect(wasAnyLockAttempted()).toBe(true);
        expect(wasLeaderLockAttempted()).toBe(true);
        expect(wasWorkerALockAttempted()).toBe(false);

        __resetLockParticipationForTests();
        markWorkerALockAttempted();
        expect(wasAnyLockAttempted()).toBe(true);
        expect(wasWorkerALockAttempted()).toBe(true);
        expect(wasLeaderLockAttempted()).toBe(false);
    });
});

// The two production primitives must raise the flag on entry — win OR lose —
// because a follower also holds the service module in memory and its release
// on shutdown is harmless (it unlinks only locks carrying OUR pid, i.e. a
// follower's release is a no-op). The unit suites below already mock fs; here
// we reuse that pattern minimally through the real tmpdir.
describe('production primitives raise the participation flags — #4352 W2', () => {
    let sandbox: string;
    let lockPath: string;

    beforeEach(async () => {
        __resetLockParticipationForTests();
        sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'rsm-4352-w2-'));
        lockPath = path.join(sandbox, 'participation.lock');
    });

    it('tryAcquireWorkerALeaderLock marks participation even when it stays follower', async () => {
        const { tryAcquireWorkerALeaderLock } = await import('../worker-a-lock.js');
        // A fresh lock held by a live foreign pid (our parent) → follower.
        await fs.writeFile(lockPath, JSON.stringify({ pid: process.ppid, timestamp: Date.now() }), 'utf-8');
        const becameLeader = await tryAcquireWorkerALeaderLock('test-machine', { lockPath });
        expect(becameLeader).toBe(false);
        expect(wasWorkerALockAttempted()).toBe(true);
        expect(wasAnyLockAttempted()).toBe(true);
    });

    it('background-services tryAcquireLeaderLock marks participation (mocked fs, win path)', async () => {
        vi.resetModules();
        vi.doMock('fs', async () => {
            const actual = await vi.importActual<typeof import('fs')>('fs');
            return {
                ...actual,
                promises: {
                    ...actual.promises,
                    writeFile: vi.fn().mockResolvedValue(undefined),
                },
            };
        });
        // getLeaderLockPath consults RooStorageDetector; pin it.
        vi.doMock('../../utils/roo-storage-detector.js', () => ({
            RooStorageDetector: {
                detectStorageLocations: vi.fn().mockResolvedValue([sandbox]),
            },
        }));
        // After resetModules, background-services resolves a FRESH
        // lock-participation instance — read the flags through THAT instance,
        // not the statically-imported one at the top of this file.
        const [{ tryAcquireLeaderLock }, participation] = await Promise.all([
            import('../background-services.js'),
            import('../lock-participation.js'),
        ]);
        expect(await tryAcquireLeaderLock('test-machine')).toBe(true);
        expect(participation.wasLeaderLockAttempted()).toBe(true);
        expect(participation.wasAnyLockAttempted()).toBe(true);
        vi.doUnmock('fs');
        vi.doUnmock('../../utils/roo-storage-detector.js');
    });
});
