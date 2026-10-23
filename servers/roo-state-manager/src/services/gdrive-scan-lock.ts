/**
 * Host-local mutual exclusion for GDrive full-pool scans (#4131 B16).
 *
 * @module services/gdrive-scan-lock
 * @issue #4131 B16 (mechanism c.6353386994, arbitration c.6353630611)
 *
 * WHY — a PG connect timeout stalls the libuv threadpool shared with the fs
 * reads; every RSM process on the host then falls back to G: at once, and the
 * stalled reads feed MORE timeouts (self-feeding loop, 22-23/10 incident on
 * ai-01: 74 live RSM processes). B16 cuts that herd two ways — the breaker
 * (channel-pg-breaker.ts) stops the fan-out, and this lock serializes the
 * scans that legitimately remain (inbox-pool rebuild, channel reconcile) so
 * that AT MOST ONE RSM process per host reads the G: pool at a time.
 *
 * The lock is deliberately HOST-LOCAL (a file under os.tmpdir(), the same
 * pattern as the negative-cache persistence and leader election):
 * `tryAcquireRooSyncDashboardLock` is a PG lock — it cannot gate scans that
 * run precisely because PG is not answering.
 *
 * proper-lockfile v4 is already the house lock (background-services.ts #1984):
 * exclusive-create on a `<target>.lock` sibling, `stale` takeover for holders
 * that died without releasing, `update` keeping the mtime fresh while a long
 * scan runs so a LIVE holder is never stolen from.
 */

import lockfile from 'proper-lockfile';
import { mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('gdrive-scan-lock');

/**
 * A lock older than this is considered abandoned (holder crashed mid-scan)
 * and the next acquirer takes it over. Generous on purpose: an inbox rebuild
 * is budget-bounded to 60 s but a contended DriveFS stretches passes, and a
 * stolen lock means two scanners — the exact state this module exists to
 * prevent — so the threshold errs toward patience.
 */
const SCAN_LOCK_STALE_MS = 15 * 60_000;

/** mtime refresh period while the lock is held (proper-lockfile `update`). */
const SCAN_LOCK_UPDATE_MS = 5_000;

/**
 * Directory shared by host-local RSM state (os.tmpdir, cf. MessageManager
 * negative cache). `ROOSYNC_SCAN_LOCK_DIR` overrides it — test isolation only;
 * production always uses the single tmpdir path every RSM process on the host
 * resolves identically.
 */
function scanLockDir(): string {
  return process.env.ROOSYNC_SCAN_LOCK_DIR || join(tmpdir(), 'roo-state-manager');
}

/**
 * Try to acquire the host-local G: scan lock for a scope. NON-BLOCKING by
 * design: the callers must not queue 74 processes deep behind the current
 * scanner — a refused acquirer defers its pass and retries on its own cadence
 * (TTL expiry for the inbox rebuild, next daemon tick for the reconcile).
 *
 * @returns the release function on success, or **null** when another process
 *   on this host holds the lock — "busy" is a normal, logged-at-caller
 *   outcome, never an error.
 */
export async function acquireGdriveScanLock(scope: string): Promise<(() => Promise<void>) | null> {
  const dir = scanLockDir();
  const target = join(dir, `gdrive-scan-${scope}.lock`);
  try {
    await mkdir(dir, { recursive: true });
    // proper-lockfile locks AROUND an existing path — ensure the target exists
    // (same shape as background-services.ts). Content is diagnostic only.
    try {
      await writeFile(target, `${process.pid}\n`, { flag: 'wx' });
    } catch {
      /* already exists — a previous holder left it; the lock file is the sibling */
    }
    const release = await lockfile.lock(target, {
      // Short bounded retry (~0.5 s), NOT a queue: it absorbs a holder that is
      // releasing right now, while a real scan (seconds to its 60 s budget)
      // still yields "busy" promptly instead of stalling 74 processes.
      retries: { retries: 3, minTimeout: 50, maxTimeout: 200 },
      stale: SCAN_LOCK_STALE_MS,
      update: SCAN_LOCK_UPDATE_MS,
      realpath: false,
      onCompromised: () => {
        // Stolen-from mid-scan (stale takeover by another process): the scan
        // keeps running — worst case there are two scanners for the tail of
        // one pass — but it must be visible.
        logger.warn(`[gdrive-scan-lock] lock for scope "${scope}" was compromised (taken over as stale) mid-scan`);
      },
    });
    return release;
  } catch {
    return null; // held by another process on this host
  }
}
