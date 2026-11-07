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
// #4352: shared PID liveness probe (its own module — node builtins only, this
// file's dependency constraint is preserved: pid-liveness imports nothing).
import { isProcessAlive } from './pid-liveness.js';
import { markWorkerALockAttempted } from './lock-participation.js';

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
 * #4352 W1: read a lock back after an overwrite, to arbitrate a steal race.
 * The plain-write steal path has no atomic primitive (the wx create is the only
 * one), so the read-back answers "did a rival's overwrite land between our
 * write and this re-read?" — the race window the steal itself opens. When it
 * detects the rival, THIS process demotes to follower instead of believing a
 * leadership its write no longer backs. Residual window: a rival writing AFTER
 * our re-read is undetectable here; the renewal tick bounds that overlap (a
 * stale "leader" reads a foreign live pid at its next tryAcquire and steps
 * down). Null on any read failure: the caller treats an unreadable file as its
 * own win (fail-open toward leadership after a successful write, the pre-W1
 * behavior when nothing races us).
 */
async function readLockForAtomicity(lockPath: string): Promise<{ pid: number } | null> {
    try {
        const content = await fs.readFile(lockPath, 'utf-8');
        const parsed = JSON.parse(content);
        if (typeof parsed?.pid === 'number') {
            return parsed;
        }
        return null;
    } catch {
        return null;
    }
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
    // #4352 W2: participation flag — the shutdown release only runs in processes
    // that actually entered this election (saves the dynamic-import budget of
    // processes that never tried to lead).
    markWorkerALockAttempted();
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
            if (!isProcessAlive(existing.pid)) {
                // #4352: a DEAD holder is stolen immediately, before the stale
                // threshold — same fix as tryAcquireLeaderLock (ai-01 measured
                // 24-28 min leaderless per leader death on 07/11). Liveness is
                // an accelerator only; the stale-threshold steal below remains
                // the net for recycled PIDs ("alive" never proves identity).
                // #4352 W1 (ms#1683 review): the steal is NOT atomic — two
                // contenders can both see a dead holder and both overwrite
                // (plain writeFile). Re-read after the write: whoever's pid the
                // file actually carries wins, the loser demotes to follower.
                await fs.writeFile(lockPath, JSON.stringify(lockData));
                const stolen = await readLockForAtomicity(lockPath);
                if (stolen === null || stolen.pid === process.pid) {
                    console.log(`🔑 [WorkerA-Lead] Stolen lock from DEAD PID ${existing.pid} (age ${Math.round(age / 1000)}s, before stale threshold). PID ${process.pid} is now leader.`);
                    return true;
                }
                console.log(`🔑 [WorkerA-Lead] Lost an atomic steal race for DEAD PID ${existing.pid} — ${stolen.pid} wrote last. Staying follower.`);
                return false;
            }
            if (age > WORKER_A_LOCK_STALE_MS) {
                await fs.writeFile(lockPath, JSON.stringify(lockData));
                // W1: same read-back for the stale-threshold steal (same race,
                // same remedy — only the trigger differs).
                const stolen = await readLockForAtomicity(lockPath);
                if (stolen === null || stolen.pid === process.pid) {
                    console.log(`🔑 [WorkerA-Lead] Stolen stale lock (previous PID ${existing.pid}, age ${Math.round(age / 1000)}s). PID ${process.pid} is now leader.`);
                    return true;
                }
                console.log(`🔑 [WorkerA-Lead] Lost an atomic steal race for stale lock (previous PID ${existing.pid}) — ${stolen.pid} wrote last. Staying follower.`);
                return false;
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

/**
 * #4352: release the Worker A lock on clean shutdown, ONLY if it carries OUR
 * pid — a lock won by another process must survive us. Never throws: a failed
 * release costs at most one stale window, which the steal path above already
 * covers. Wired from gracefulShutdown in index.ts; exported for the tests.
 */
export async function releaseWorkerALockIfOurs(
    machineId: string,
    options: WorkerALockOptions = {}
): Promise<boolean> {
    try {
        const lockPath = options.lockPath ?? (await getWorkerALockPath(machineId));
        const content = await fs.readFile(lockPath, 'utf-8');
        const existing = JSON.parse(content);
        if (existing.pid !== process.pid) {
            return false;
        }
        await fs.unlink(lockPath);
        console.log(`🔓 [WorkerA-Lead] Lock released on clean shutdown (PID ${process.pid}).`);
        return true;
    } catch {
        return false;
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
