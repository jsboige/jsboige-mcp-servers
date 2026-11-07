/**
 * #4352 W2 (ai-01 review of ms#1683, 07/11): participation flags for the
 * machine-local leader locks.
 *
 * gracefulShutdown (index.ts) releases the leader locks via dynamic imports
 * (per #1140: background-services pulls Qdrant/embeddings, worker-a-lock stays
 * node-builtins-only). Those imports ran in EVERY process at shutdown —
 * including processes that never entered an election — and consumed #3151's
 * shutdown drain budget for nothing. The fix: run the release path only when
 * THIS process actually attempted an acquisition, which is exactly when the
 * service modules are already in memory — the dynamic import then resolves
 * from the ESM cache and costs ~nothing.
 *
 * This module is deliberately dependency-free and tiny so importing it
 * statically (index.ts + both election modules) adds no load budget. While
 * worker-a-lock.ts imports it, the N-process contender harness transforms it
 * alongside pid-liveness (see worker-a-contender.mjs) — keep it import-free.
 */

let leaderLockAttempted = false;
let workerALockAttempted = false;

/** Set on EVERY entry of tryAcquireLeaderLock, win or lose. */
export function markLeaderLockAttempted(): void {
    leaderLockAttempted = true;
}

/** Set on EVERY entry of tryAcquireWorkerALeaderLock, win or lose. */
export function markWorkerALockAttempted(): void {
    workerALockAttempted = true;
}

export function wasLeaderLockAttempted(): boolean {
    return leaderLockAttempted;
}

export function wasWorkerALockAttempted(): boolean {
    return workerALockAttempted;
}

/** The shutdown gate: true as soon as this process touched either election. */
export function wasAnyLockAttempted(): boolean {
    return leaderLockAttempted || workerALockAttempted;
}

/** Tests only — vitest runs many suites in one process. */
export function __resetLockParticipationForTests(): void {
    leaderLockAttempted = false;
    workerALockAttempted = false;
}
