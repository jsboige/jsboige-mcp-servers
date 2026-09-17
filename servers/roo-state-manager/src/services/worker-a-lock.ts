/**
 * #3661 — Worker A leader-election lock (skeleton refresh + startup scans).
 *
 * Distinct from the #2352 Qdrant indexing lock (`roosync-indexer-leader-*.lock`)
 * so that an indexing leader crash does NOT paralyse the skeleton refresh, and
 * vice-versa. Without this separation, every MCP process on a high-multiplicity
 * machine (29 on ai-01 per the #3661 measurement) runs the SAME 2-min refresh +
 * the SAME startup scan N times — paying N× disk I/O and N× queue contention.
 *
 * The lock is a machine-local file under os.tmpdir() (NOT ROOSYNC_SHARED_PATH —
 * see the #2352 fleet-storm lesson on why that matters), and the contention
 * algorithm mirrors `tryAcquireLeaderLock` for #2352 parity.
 *
 * WHY THIS LIVES IN ITS OWN MODULE — the N-process acceptance test (§4 of the
 * #3661 design study) spawns real contender processes that must run THIS code.
 * `background-services.ts` cannot be their entry point (it pulls storage
 * detectors, Qdrant, embeddings), so the primitive is extracted here to stay
 * importable: a copy of the algorithm in a test would keep passing after the
 * production election was weakened, which is exactly what the acceptance
 * criterion must not tolerate. Dependency surface is node builtins only — keep
 * it that way.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Stale threshold, SHORTER (10 min) than #2352's 15 min because the Worker A
 * cadence is shorter (2 min vs 5 min): a stale refresh lock is recovered faster
 * than a stale indexing lock.
 */
export const WORKER_A_LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * Returns the MACHINE-LOCAL leader-lock path for Worker A. Same naming
 * convention as #2352 but with a distinct prefix to keep the two election
 * cycles uncoupled.
 */
export async function getWorkerALockPath(machineId: string): Promise<string> {
    const safeId = (machineId || 'local').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    return path.join(os.tmpdir(), `roosync-worker-a-leader-${safeId}.lock`);
}

export interface WorkerALockOptions {
    /**
     * Override the lock file. Production always derives it from the machineId;
     * tests inject a sandbox path so the election is isolated from the locks of
     * any RSM process actually running on the developer's machine.
     */
    lockPath?: string;
}

/**
 * Try to acquire or renew the Worker A leader lock.
 *
 * Fail-closed: an unexpected error (permissions, disk full, unreadable state)
 * yields follower, never leader — the consequences of an N-leader race are worse
 * than the consequences of a process staying read-only for one cycle.
 */
export async function tryAcquireWorkerALeaderLock(
    machineId: string,
    options: WorkerALockOptions = {}
): Promise<boolean> {
    const lockPath = options.lockPath ?? (await getWorkerALockPath(machineId));
    const lockData = { pid: process.pid, timestamp: Date.now() };

    try {
        // O_CREAT|O_EXCL — the single atomic serialization point of the election.
        await fs.writeFile(lockPath, JSON.stringify(lockData), { flag: 'wx' });
        return true; // Created → we are the leader
    } catch (error: any) {
        if (error.code !== 'EEXIST') {
            console.warn(`⚠️ [WorkerA-Lead] Unexpected error acquiring lock: ${error.message}. Assuming follower (fail-closed).`);
            return false;
        }

        // Lock exists — check if it's ours or stale.
        try {
            const content = await fs.readFile(lockPath, 'utf-8');
            const existing = JSON.parse(content);

            if (existing.pid === process.pid) {
                // Same PID = our own lock from an earlier tick → renew.
                await fs.writeFile(lockPath, JSON.stringify(lockData));
                return true;
            }

            const age = Date.now() - existing.timestamp;
            if (age > WORKER_A_LOCK_STALE_MS) {
                await fs.writeFile(lockPath, JSON.stringify(lockData));
                console.log(`🔑 [WorkerA-Lead] Stolen stale lock (previous PID ${existing.pid}, age ${Math.round(age / 1000)}s). PID ${process.pid} is now leader.`);
                return true;
            }

            return false;
        } catch {
            // Unparseable content. This is reachable in TWO very different
            // situations and must not be conflated:
            //   - a holder between O_CREAT and its write() → the entry exists with
            //     zero bytes for a few microseconds. Claiming leadership here
            //     hands out a SECOND leader, i.e. the N× pathology #3661 removes;
            //   - a genuinely abandoned/corrupt lock.
            // The content itself cannot tell them apart, but the file's mtime can:
            // only a lock older than the stale threshold is treated as abandoned.
            // A corrupt lock therefore self-heals one stale-window later instead
            // of instantly — the deliberate price of a single-leader guarantee.
            try {
                const stat = await fs.stat(lockPath);
                const age = Date.now() - stat.mtimeMs;
                if (age > WORKER_A_LOCK_STALE_MS) {
                    await fs.writeFile(lockPath, JSON.stringify(lockData));
                    console.log(`🔑 [WorkerA-Lead] Stolen abandoned lock (unreadable, age ${Math.round(age / 1000)}s). PID ${process.pid} is now leader.`);
                    return true;
                }
            } catch {
                /* stat failed too — fall through to follower (fail-closed) */
            }
            return false;
        }
    }
}

/** Minimal state slice the tick election needs (ServerState satisfies it). */
export interface WorkerALeaderState {
    machineId: string;
    isWorkerALeader: boolean;
}

/** What the tick election did — the caller owns the logging. */
export type WorkerATickOutcome = 'leading' | 'became-leader' | 'follower' | 'stepped-down';

/**
 * Per-tick leadership check for Worker A. Call it at the TOP of every refresh
 * tick, then skip the tick's work unless it returns 'leading' or
 * 'became-leader'.
 *
 * WHY IT MUST RUN EVERY TICK: the lock's stale threshold (10 min) is 5× the
 * 2-min cadence. Acquiring once at boot therefore leaves the lock stale while
 * its leader is still alive — a later starter then steals it and runs a
 * duplicate refresh/repair/startup-scan stack, which is the very N× cost this
 * PR removes. Renewing each tick (and stepping down when renewal fails) is the
 * same shape as the #2352 Qdrant leader at the indexing tick.
 *
 * Step-down never clears the interval: the next tick re-attempts the election,
 * so a machine whose leader died is re-owned within one cadence instead of
 * staying leaderless until restart.
 */
export async function ensureWorkerALeadershipForTick(
    state: WorkerALeaderState,
    options: WorkerALockOptions = {}
): Promise<WorkerATickOutcome> {
    if (state.isWorkerALeader) {
        if (await tryAcquireWorkerALeaderLock(state.machineId, options)) {
            return 'leading';
        }
        state.isWorkerALeader = false;
        return 'stepped-down';
    }

    if (await tryAcquireWorkerALeaderLock(state.machineId, options)) {
        state.isWorkerALeader = true;
        return 'became-leader';
    }
    return 'follower';
}
