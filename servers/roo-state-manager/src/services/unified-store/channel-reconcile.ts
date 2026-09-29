/**
 * #3151 Phase B arming prerequisite — reconcile `roosync_messages` lifecycle
 * status against the GDrive inbox pool membership.
 *
 * WHY this exists: the shared inbox pool is the system of record for LIVE
 * membership. When a machine archives a message, the file leaves the shared
 * pool for that machine's LOCAL archive dir — but if that machine's channel
 * dual-write was off at the time (or the message predates the backfill), the
 * PG row keeps `status='unread'` forever. A machine that arms
 * `UNIFIED_STORE_CHANNEL_READ_PG=1` on this state would serve thousands of
 * ghost messages as unread (measured 28-29/09/2026 on po-2026: 169 unread in
 * PG, only the recent ones still present as files; ~24k non-archived rows
 * fleet-wide older than 90 days).
 *
 * Rule: a row older than the grace window whose file is ABSENT from the
 * shared inbox pool is marked `status='archived'` in PG. The grace window
 * covers in-flight archiving (a file being moved right now must not ghost-
 * mark a real message) and DriveFS propagation delay.
 *
 * Pure logic lives here (DI-friendly, unit-tested); the pg/readdir wiring
 * lives in `scripts/reconcile-roosync-channel.mjs`.
 */

export interface ReconcileCandidate {
  id: string;
  status: string;
  created_at: string | Date;
}

export interface ReconcileManifestEntry {
  id: string;
  status_before: string;
  created_at: string;
}

export interface ReconcileManifest {
  run_kind: 'dry-run' | 'apply';
  grace_hours: number;
  pool_files: number;
  candidates: number;
  ghosts: number;
  affected: ReconcileManifestEntry[];
  /** Set when a sanity guard refused the pass — nothing is marked archived. */
  aborted?: { reason: 'pool-empty' | 'ghost-ratio'; detail: string };
}

/**
 * Sanity guards (review ai-01 #1256 point 1): an unmounted/empty DriveFS pool
 * would make EVERY live message look like a ghost and archive the whole
 * mailbox past the grace window. Both guards abort the pass (no ghosts
 * emitted) rather than trust a pool that looks disconnected.
 *
 * Thresholds: a healthy pool always has live files (5,878 measured 29/09);
 * the legitimate first-pass reconcile was 61% ghosts (9,346/15,225) — the
 * ratio guard only fires when QUASI everything is a ghost, which no sane
 * first pass produced.
 */
export const MAX_GHOST_RATIO = 0.9;
export const MIN_CANDIDATES_FOR_RATIO = 100;

export interface ReconcileResult {
  ghosts: ReconcileManifestEntry[];
  kept: { live: number; withinGrace: number };
  manifest: ReconcileManifest;
}

/**
 * Extract the message id from an inbox filename. Files are named exactly
 * `<id>.json` (MessageManager.sendMessage l.957; a mismatch is skipped by the
 * cache build to avoid phantom listings, l.719).
 */
export function idFromInboxFilename(filename: string): string | null {
  if (!filename.endsWith('.json')) return null;
  return filename.slice(0, -'.json'.length);
}

export function buildLiveIdSet(filenames: string[]): Set<string> {
  const set = new Set<string>();
  for (const f of filenames) {
    const id = idFromInboxFilename(f);
    if (id) set.add(id);
  }
  return set;
}

function toEpoch(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/**
 * Compute ghosts among candidates. A candidate is a ghost when BOTH:
 *  - its file is absent from the live pool id set, AND
 *  - it is older than the grace cutoff (recent rows are never touched —
 *    their file may still be propagating through DriveFS, or the archive
 *    move may be in flight).
 */
export function computeReconcileResult(
  candidates: ReconcileCandidate[],
  liveIds: Set<string>,
  graceCutoffEpochMs: number,
  runKind: 'dry-run' | 'apply',
  graceHours: number
): ReconcileResult {
  const ghosts: ReconcileManifestEntry[] = [];
  let live = 0;
  let withinGrace = 0;

  for (const c of candidates) {
    if (liveIds.has(c.id)) {
      live++;
      continue;
    }
    if (toEpoch(c.created_at) >= graceCutoffEpochMs) {
      withinGrace++;
      continue;
    }
    ghosts.push({
      id: c.id,
      status_before: c.status,
      created_at: c.created_at instanceof Date ? c.created_at.toISOString() : c.created_at,
    });
  }

  // Sanity guards — evaluated AFTER classification so the manifest documents
  // the observed pool/candidates, but BEFORE emitting ghosts so an aborted
  // pass never feeds the UPDATE loop.
  if (candidates.length > 0 && liveIds.size === 0) {
    return {
      ghosts: [],
      kept: { live, withinGrace },
      manifest: {
        run_kind: runKind,
        grace_hours: graceHours,
        pool_files: liveIds.size,
        candidates: candidates.length,
        ghosts: 0,
        affected: [],
        aborted: {
          reason: 'pool-empty',
          detail:
            'inbox pool readdir returned no live file while PG has candidates — the shared pool is ' +
            'probably unmounted (DriveFS cold/failed mount). Archiving anything here would ghost-mark ' +
            'every live message past the grace window. Fix the mount, re-run.',
        },
      },
    };
  }
  if (candidates.length >= MIN_CANDIDATES_FOR_RATIO && ghosts.length / candidates.length > MAX_GHOST_RATIO) {
    const ratio = (ghosts.length / candidates.length).toFixed(4);
    return {
      ghosts: [],
      kept: { live, withinGrace },
      manifest: {
        run_kind: runKind,
        grace_hours: graceHours,
        pool_files: liveIds.size,
        candidates: candidates.length,
        ghosts: 0,
        affected: [],
        aborted: {
          reason: 'ghost-ratio',
          detail:
            `${ratio} of candidates classified as ghosts (> ${MAX_GHOST_RATIO}) — the pool is likely ` +
            'partially mounted. No legitimate first pass exceeded 0.61 (9,346/15,225, 29/09). ' +
            'Verify the mount before forcing anything.',
        },
      },
    };
  }

  return {
    ghosts,
    kept: { live, withinGrace },
    manifest: {
      run_kind: runKind,
      grace_hours: graceHours,
      pool_files: liveIds.size,
      candidates: candidates.length,
      ghosts: ghosts.length,
      affected: ghosts,
    },
  };
}

/** Batch ghost ids for UPDATE ... WHERE id = ANY($1) in bounded chunks. */
export function batchIds(ids: string[], batchSize = 500): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    batches.push(ids.slice(i, i + batchSize));
  }
  return batches;
}
