/**
 * #4352 — PID liveness probe for the machine-local leader locks.
 *
 * Extracted so BOTH elections (the #2352 Qdrant indexing lock in
 * background-services.ts and the #3661 Worker A lock in worker-a-lock.ts)
 * share ONE implementation instead of two copies that can drift. Dependency
 * surface is node builtins only — the worker-a-lock module constraint
 * ("keep it that way") is preserved: this module imports nothing.
 *
 * Semantics identical to the `isPidAlive` used for the PG store locks
 * (tools/roosync/dashboard.ts): signal 0 succeeding (or EPERM) means a process
 * holds this PID; ESRCH means no such process.
 *
 * RESERVE (dashboard.ts:1591, measured 03/11 — msedge.exe holding a recycled
 * PG-lock PID): "alive" proves that SOME process holds the PID, NOT that it is
 * the process that wrote the lock. PIDs are recycled. This probe is therefore
 * an ACCELERATOR only — it lets a follower steal a dead holder's lock before
 * the staleness window elapses, and never a replacement for it. The
 * stale-threshold steal stays the net for everything this probe cannot see.
 */
export function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: the process exists but belongs to another user — still alive.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}
