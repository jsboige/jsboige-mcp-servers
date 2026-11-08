/**
 * #4352 W3: shared read-back helper for lock-steal arbitration.
 *
 * W1 (ms#1683 review, ms#1687) added a read-back after every lock steal
 * (dead-PID and stale-threshold) in BOTH tryAcquireWorkerALeaderLock and
 * tryAcquireLeaderLock: whoever's pid the file carries after the overwrite
 * wins; the loser demotes to follower. The helper was first duplicated in
 * the two modules — this module is the deduplication (file ai-01
 * 2026-11-08a, item 1, option "factoriser readLockForAtomicity").
 *
 * Semantics (pinned by leader-election.test.ts and worker-a-steal-races.test.ts):
 *   - readable JSON with a numeric `pid` → that parsed object;
 *   - unreadable file, unparseable JSON, or non-numeric pid → `null`,
 *     which the callers treat as fail-open (our own write succeeded;
 *     nothing observable disputes the seat — pre-W1 behavior).
 *
 * This module is a SATELLITE of the N-process test harness
 * (`worker-a-contender.mjs` transforms it to %TEMP% alongside
 * worker-a-lock.ts): keep it free of imports beyond node builtins.
 */
import { promises as fs } from 'fs';

export async function readLockForAtomicity(lockPath: string): Promise<{ pid: number } | null> {
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
