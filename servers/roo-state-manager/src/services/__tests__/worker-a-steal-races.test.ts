/**
 * #4352 W3 — pin the "Lost an atomic steal race" branches of
 * tryAcquireWorkerALeaderLock (file ai-01 2026-11-08a, item 1).
 *
 * Measured hole before this file: mutating the two `return false` of
 * worker-a-lock.ts's lost-race branches (dead-PID L141, stale L153 at
 * 66e35ab5) into `return true` passed the ENTIRE targeted suite 58/58 —
 * the worker-A twin branches of the W1 read-back were never exercised,
 * while their background-services.ts twins were pinned by
 * leader-election.test.ts (ms#1687). A process losing a steal race and
 * still declaring itself leader is exactly the N-leader pathology the
 * read-back exists to prevent.
 *
 * The three tests mirror the leader-election W1 triplet one-for-one:
 *   - dead-PID steal, read-back carries a RIVAL pid  → follower (false);
 *   - stale-threshold steal, read-back carries a RIVAL pid → follower;
 *   - dead-PID steal, read-back UNREADABLE → fail-open leader (true).
 *
 * No N-process parallel-steal test here — by construction the read-back
 * only detects a rival whose overwrite lands between our write and our
 * re-read (sub-ms window); see multi-process-budget.test.ts's note. The
 * arbitration is pinned deterministically through the mocked fs instead.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { spawn } from 'child_process';

vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return {
        ...actual,
        promises: {
            ...actual.promises,
            readFile: vi.fn(),
            writeFile: vi.fn(),
        },
    };
});

import { promises as fs } from 'fs';
import { tryAcquireWorkerALeaderLock, WORKER_A_LOCK_STALE_MS } from '../worker-a-lock.js';

const mockFs = fs as unknown as Record<'readFile' | 'writeFile', ReturnType<typeof vi.fn>>;

const LOCK_PATH = '/mock/roosync-worker-a-leader-test.lock';
const RIVAL_PID = 999_999; // any pid that is not process.pid arbitrates against us

/** A provably-dead pid: spawn, wait for exit, reuse the pid (same pattern as
 *  background-services.worker-a-recovery.test.ts, inverted). */
function provablyDeadPid(): Promise<number> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
        child.on('exit', () => resolve(child.pid!));
    });
}

let logs: string[];

beforeEach(() => {
    vi.clearAllMocks();
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Only the O_CREAT|O_EXCL create is contested (same rule as the recovery
    // suite's wiring): the wx create throws EEXIST so the election falls into
    // the steal paths under test; the steal's plain writes then succeed.
    mockFs.writeFile.mockImplementation(async (p: unknown, _data: unknown, opts?: { flag?: string }) => {
        if (String(p).includes('worker-a-leader') && opts && opts.flag === 'wx') {
            const err: NodeJS.ErrnoException = new Error('EEXIST simulated');
            err.code = 'EEXIST';
            throw err;
        }
        return undefined;
    });
});

describe('#4352 W3 — worker-A steal races are arbitrated by the read-back', () => {
    it('dead-PID steal: a RIVAL pid at the read-back demotes us to follower (mutant: return false → true must fail here)', async () => {
        const deadPid = await provablyDeadPid();
        mockFs.readFile
            .mockResolvedValueOnce(JSON.stringify({ pid: deadPid, timestamp: Date.now() })) // initial read: fresh lock, dead holder
            .mockResolvedValueOnce(JSON.stringify({ pid: RIVAL_PID, timestamp: Date.now() })); // read-back: the rival wrote last

        const becameLeader = await tryAcquireWorkerALeaderLock('test-machine', { lockPath: LOCK_PATH });

        expect(becameLeader).toBe(false);
        expect(logs.some((l) => l.includes('Lost an atomic steal race for DEAD PID'))).toBe(true);
    });

    it('stale-threshold steal: a RIVAL pid at the read-back demotes us to follower too', async () => {
        // Holder provably ALIVE (our parent) but past the stale threshold —
        // only the threshold path triggers, not the dead-PID shortcut.
        const staleLock = { pid: process.ppid, timestamp: Date.now() - (WORKER_A_LOCK_STALE_MS + 60_000) };
        mockFs.readFile
            .mockResolvedValueOnce(JSON.stringify(staleLock)) // initial read
            .mockResolvedValueOnce(JSON.stringify({ pid: RIVAL_PID, timestamp: Date.now() })); // read-back: rival

        const becameLeader = await tryAcquireWorkerALeaderLock('test-machine', { lockPath: LOCK_PATH });

        expect(becameLeader).toBe(false);
        expect(logs.some((l) => l.includes('Lost an atomic steal race for stale lock'))).toBe(true);
    });

    it('dead-PID steal: an UNREADABLE read-back stays fail-open toward leadership', async () => {
        const deadPid = await provablyDeadPid();
        const enoent: NodeJS.ErrnoException = new Error('ENOENT: no such file');
        enoent.code = 'ENOENT';
        mockFs.readFile
            .mockResolvedValueOnce(JSON.stringify({ pid: deadPid, timestamp: Date.now() })) // initial read
            .mockRejectedValueOnce(enoent); // read-back: unreadable → readLockForAtomicity → null

        const becameLeader = await tryAcquireWorkerALeaderLock('test-machine', { lockPath: LOCK_PATH });

        // Our own write succeeded and nothing observable disputes the seat —
        // pre-W1 behavior when nothing races us (pinned in leader-election W1).
        expect(becameLeader).toBe(true);
        expect(logs.some((l) => l.includes('Stolen lock from DEAD PID'))).toBe(true);
    });
});
