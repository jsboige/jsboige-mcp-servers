/**
 * Periodic GDrive→PG reconcile of the RooSync messaging channel (#3292).
 *
 * @module services/unified-store/roosync-channel-reconcile
 * @issue #3292 (residual dual-write loss), #3151 Phase B prerequisite
 *
 * WHY — the dual-write (#1001) mirrors messages to PG as they are sent, but
 * three measured classes of loss leave GDrive files with no PG row:
 *   1. hard kill (Windows TerminateProcess: taskkill, 72 h timeouts) — the
 *      fire-and-forget INSERT never gets to fail, the process simply vanishes
 *      (#3292 c.20, scénario B/C) ;
 *   2. PG outages — the INSERT fails while PG is unreachable (#3292 c.23,
 *      outage of 02/09) ;
 *   3. state regression on a machine (env lost on re-clone, wedged pool) —
 *      dual-write silently stops while GDrive keeps receiving (#3292 c.26,
 *      po-2027).
 *
 * A standing hole in `roosync_messages` is the one thing blocking the
 * PG-primary read path (#3151) — under-show. The reconcile closes the three
 * classes continuously, from any armed machine, without a human remembering
 * to re-run `scripts/backfill-roosync-channel.mjs`.
 *
 * HOW — id-diff, not a full re-import:
 *   - message ids embed their UTC timestamp (`msg-YYYYMMDDTHHMMSS-<rand>`), so
 *     FILENAMES and PG ids share one lexicographic order. One readdir per
 *     mailbox dir (enumeration is cheap — ~0.5 s; the per-file OPEN is the
 *     ~10 ms cost, #3292 c.18) yields the candidates newer than the lookback
 *     cutoff; one indexed `id >= cutoff` SELECT yields the ids PG already
 *     holds. Only the missing set is opened, parsed and inserted — steady
 *     state is a handful of files per run, not a 50 K-file pool scan.
 *   - INSERT ... ON CONFLICT (id) DO NOTHING (writer contract) — a reconcile
 *     racing the live dual-write, or a reconcile on another machine, converges
 *     instead of duplicating.
 *   - insert-only: GDrive stays the source of truth for status transitions
 *     until Phase D; the reconcile heals PRESENCE, not state.
 *
 * Env-gate: same flags as the dual-write (UNIFIED_STORE_DUAL_WRITE=1 +
 * UNIFIED_STORE_PG_URL) — reconciling into a Null writer is pure GDrive IO.
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { Message } from '../MessageManager.js';
import type { IUnifiedStoreWriter } from './UnifiedStoreWriter.js';
import { mapMessageToRow } from './roosync-channel-dual-write.js';
import { getUnifiedStoreWriter } from './writer-factory.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('roosync-channel-reconcile');

/** Mailbox dirs that carry channel files (archive = inbox moved by #809/#3150). */
const RECONCILE_DIRS = ['inbox', 'archive', 'sent'] as const;

export interface ChannelReconcileResult {
  /** 'skipped-not-armed' = dual-write off on this process — nothing was done. */
  status: 'ok' | 'skipped-not-armed';
  /** Lookback cutoff in id form (`msg-YYYYMMDDTHHMMSS`) — same order as ids. */
  sinceId: string;
  /** .json files in the lookback window across the three dirs. */
  candidates: number;
  /** Distinct message ids among candidates (a sent message lives in 2 dirs). */
  candidateIds: number;
  /** Candidate ids PG already had (not re-inserted). */
  alreadyPresent: number;
  /** Rows actually persisted this run (verified by a post-insert id listing). */
  reconciled: number;
  /** Candidates skipped: no id / filename≠id (phantom guard, same as backfill). */
  skipped: number;
  /** Files that failed (read/parse/insert). Counted, never thrown per file. */
  errors: number;
  durationMs: number;
}

export interface ChannelReconcileOptions {
  /** `{sharedStatePath}/messages` — the root holding inbox/ sent/ archive/. */
  messagesRoot: string;
  /** Re-scan window in days. Default 7. */
  lookbackDays?: number;
  /** Clock seam for tests. Default Date.now(). */
  now?: number;
  /** Writer seam for tests. Default getUnifiedStoreWriter(). */
  writer?: Pick<IUnifiedStoreWriter, 'insertRooSyncMessage' | 'listRooSyncMessageIds'>;
}

/**
 * Mirrors the writer-factory gate: only a dual-write-armed process has a live
 * writer to reconcile into. Checked at call time (not import time) so tests
 * and config reloads can toggle without a restart.
 */
export function isChannelDualWriteArmed(): boolean {
  return process.env.UNIFIED_STORE_DUAL_WRITE === '1' && !!process.env.UNIFIED_STORE_PG_URL;
}

/**
 * Lookback cutoff in id form: `msg-YYYYMMDDTHHMMSS` (UTC), the same format
 * ids embed, so a plain lexicographic `id >= sinceId` is a date comparison.
 */
export function cutoffIdFor(now: number, lookbackDays: number): string {
  const cutoff = new Date(now - lookbackDays * 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `msg-${cutoff.getUTCFullYear()}` +
    `${pad(cutoff.getUTCMonth() + 1)}${pad(cutoff.getUTCDate())}` +
    `T${pad(cutoff.getUTCHours())}${pad(cutoff.getUTCMinutes())}${pad(cutoff.getUTCSeconds())}`
  );
}

/**
 * One reconcile pass: filename-diff the lookback window against
 * `roosync_messages`, insert what is missing.
 *
 * Throws only when the PG id listing itself fails (PG unreachable, schema
 * missing) — treating "cannot list" as "nothing present" would re-import the
 * whole window blind. Per-file failures are counted, never thrown.
 */
export async function reconcileChannelFromGDrive(
  options: ChannelReconcileOptions
): Promise<ChannelReconcileResult> {
  const startedAt = Date.now();
  const lookbackDays = options.lookbackDays ?? 7;
  const now = options.now ?? Date.now();
  const sinceId = cutoffIdFor(now, lookbackDays);
  const result: ChannelReconcileResult = {
    status: 'ok',
    sinceId,
    candidates: 0,
    candidateIds: 0,
    alreadyPresent: 0,
    reconciled: 0,
    skipped: 0,
    errors: 0,
    durationMs: 0,
  };

  if (!isChannelDualWriteArmed()) {
    result.status = 'skipped-not-armed';
    result.durationMs = Date.now() - startedAt;
    return result;
  }
  const writer = options.writer ?? getUnifiedStoreWriter();

  // 1. Candidates from filenames only — readdir per dir, zero file opens.
  //    First dir wins on duplicates so the recipient-side copy (inbox/archive,
  //    which carries read_by) is preferred over the sender's sent/ copy.
  const byId = new Map<string, string>();
  for (const dir of RECONCILE_DIRS) {
    let files: string[];
    try {
      files = await readdir(join(options.messagesRoot, dir));
    } catch {
      continue; // missing dir (fresh install) — nothing to reconcile there
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -'.json'.length);
      if (id < sinceId) continue; // lexicographic == chronological for msg-* ids
      result.candidates++;
      if (!byId.has(id)) byId.set(id, join(options.messagesRoot, dir, file));
    }
  }
  result.candidateIds = byId.size;

  if (byId.size === 0) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // 2. Ids PG already holds in the window — one indexed range SELECT.
  const present = new Set(await writer.listRooSyncMessageIds(sinceId));

  // 3. Open + insert only what is missing. Per-file guards identical to the
  //    backfill script: BOM strip, id presence, filename === `${id}.json`.
  const missing = [...byId.keys()].filter((id) => !present.has(id));
  result.alreadyPresent = byId.size - missing.length;
  let insertAttempts = 0;
  for (const id of missing) {
    try {
      let content = await readFile(byId.get(id)!, 'utf-8');
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // strip UTF-8 BOM
      const message = JSON.parse(content) as Message & { id?: string };
      // Phantom guard, same rationale as ensureInboxCache: a file whose name
      // does not match its id would import an unreachable row.
      if (!message || !message.id || message.id !== id) {
        result.skipped++;
        continue;
      }
      await writer.insertRooSyncMessage(mapMessageToRow(message));
      insertAttempts++;
    } catch {
      // 0-byte husk, transient DriveFS miss, parse error — the next run
      // re-detects the id as missing and retries. Never aborts the pass.
      result.errors++;
    }
  }

  // 4. Honest count: withRetry (writer best-effort contract) swallows insert
  //    failures, so "attempts" is not "persisted". One extra SELECT — paid
  //    only when work was done — makes `reconciled` verifiable.
  if (insertAttempts > 0) {
    try {
      const after = new Set(await writer.listRooSyncMessageIds(sinceId));
      result.reconciled = missing.filter((id) => after.has(id)).length;
    } catch (error) {
      logger.warn('[channel-reconcile] post-insert listing failed — reporting attempt count', {
        error: String(error),
      });
      result.reconciled = insertAttempts;
    }
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}
