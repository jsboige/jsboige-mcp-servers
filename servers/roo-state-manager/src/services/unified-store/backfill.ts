/**
 * One-time backfill of the existing on-disk skeleton corpus into the unified Postgres store.
 *
 * @module services/unified-store/backfill
 * @issue #2581 volet 1 (Epic #2191 unified store)
 *
 * The live dual-write (#692) only fires for conversations indexed AFTER the wiring
 * landed (background refresh workers, build-skeleton-cache, loadFullSkeleton). The
 * read-path that loads the existing corpus from disk never calls addOrUpdate(), so
 * thousands of conversations already on disk never reach the unified store — it stays
 * empty. This module closes that gap by iterating the skeleton cache and feeding each
 * conversation to the dual-write helper.
 *
 * Env-gated: when UNIFIED_STORE_DUAL_WRITE != '1' (or UNIFIED_STORE_PG_URL is unset),
 * the writer-factory returns a NullUnifiedStoreWriter whose upsertConversationOnly()
 * is a no-op → the backfill runs in dry-run mode (validatable WITHOUT a DB).
 *
 * Idempotent: the write function is expected to upsert (ON CONFLICT DO UPDATE), so
 * re-running after an interruption resumes without duplicates.
 *
 * Testable: runBackfill takes an injectable writeFn (default dualWriteConversationToStore)
 * so the iteration/counting logic can be unit-tested WITHOUT a DB or even the env gate.
 */

import type { ConversationSkeleton } from '../../types/conversation.js';

/** Injectable write function (signature matches dualWriteConversationToStore). */
export type BackfillWriteFn = (
  taskId: string,
  skeleton: ConversationSkeleton,
) => Promise<void>;

export interface BackfillOptions {
  /** Stop after N skeletons (testing / partial runs). Default: process all. */
  limit?: number;
}

export interface BackfillResult {
  /** Total skeletons available before the limit is applied. */
  total: number;
  /** Skeletons whose writeFn resolved (inspected by the caller's writer). */
  processed: number;
  /** Skeletons skipped because they had no taskId. */
  skipped: number;
  /** Skeletons whose writeFn rejected (counted; iteration continues). */
  errors: number;
}

/**
 * Iterate skeletons and feed each to the write function.
 *
 * Never throws on a single skeleton failure — the error is counted and iteration
 * continues, so a partial DB outage does not abort the whole backfill.
 *
 * @returns counts for reporting (the CLI prints them; ai-01 validates the real
 *          row delta via `SELECT count(*)` post-merge — that is the source of truth
 *          for rows actually persisted, since dualWriteConversationToStore is
 *          fire-and-forget by contract).
 */
export async function runBackfill(
  skeletons: ConversationSkeleton[],
  writeFn: BackfillWriteFn,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const total = skeletons.length;
  const limit = options.limit ?? total;
  const slice = skeletons.slice(0, Math.max(0, limit));

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const skeleton of slice) {
    if (!skeleton.taskId) {
      skipped++;
      continue;
    }
    try {
      await writeFn(skeleton.taskId, skeleton);
      processed++;
    } catch {
      errors++;
    }
  }

  return { total, processed, skipped, errors };
}
