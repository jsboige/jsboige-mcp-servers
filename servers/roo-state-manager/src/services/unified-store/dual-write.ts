/**
 * Fire-and-forget dual-write of a FULL ConversationSkeleton to the unified Postgres store.
 *
 * @module services/unified-store/dual-write
 * @issue #692 — the original wiring lived in SkeletonCacheService.addOrUpdate(), which
 *   has ZERO call sites (dead branch). This standalone helper is hooked directly onto the
 *   real production population paths (build-skeleton-cache, background refresh workers,
 *   loadFullSkeleton, loadClaudeCodeSessions) so the dual-write actually fires. See
 *   jsboige/jsboige-mcp-servers#692.
 *
 * Env-gate is delegated to writer-factory: when UNIFIED_STORE_DUAL_WRITE != '1' (or
 * UNIFIED_STORE_PG_URL is unset), getUnifiedStoreWriter() returns a NullUnifiedStoreWriter
 * whose upsertConversationOnly() is a no-op → zero overhead when the flag is off.
 *
 * ⚠️ MUST only be called with a COMPLETE ConversationSkeleton (built by analyzeConversation
 * / archiveToSkeleton / parsed from a skeleton file with a non-empty `sequence`).
 * Header-only partials produced by `toHeader()` drop the sequence and must NOT be passed —
 * they would persist an incomplete row. Call sites that cache a `toHeader()` must dual-write
 * the in-scope full `skeleton`, not the header they cache.
 *
 * Never throws: the writer's circuit-breaker absorbs transient Postgres failures, and
 * dual-write must never block the local cache path. The returned promise therefore never
 * rejects, but callers attach `.catch(() => {})` (matching the fire-and-forget convention in
 * SkeletonCacheService.addOrUpdate) to satisfy floating-promise linting.
 */

import type { ConversationSkeleton } from '../../types/conversation.js';
import type { ConversationRow, Harness } from './types.js';
import { getUnifiedStoreWriter } from './writer-factory.js';

/**
 * Map a ConversationSkeleton to a ConversationRow and upsert it into the unified store.
 * Fire-and-forget at call sites (never rejects, env-gated to a no-op when the flag is off).
 */
export async function dualWriteConversationToStore(
  taskId: string,
  skeleton: ConversationSkeleton
): Promise<void> {
  try {
    const writer = getUnifiedStoreWriter();

    // Map skeleton.metadata.source → Harness
    const source = skeleton.metadata?.source;
    let harness: Harness = 'roo';
    if (source === 'claude-code') harness = 'claude';
    else if (source === 'zoo-code') harness = 'zoo';

    const conversationRow: ConversationRow = {
      task_id: taskId,
      machine_id: skeleton.metadata?.machineId
        ?? process.env.ROOSYNC_MACHINE_ID
        ?? process.env.COMPUTERNAME
        ?? 'unknown',
      harness,
      workspace: skeleton.metadata?.workspace ?? null,
      parent_task_id: skeleton.parentTaskId ?? skeleton.metadata?.parentTaskId ?? null,
      title: skeleton.metadata?.title ?? null,
      first_ts: skeleton.metadata?.createdAt ?? null,
      last_ts: skeleton.metadata?.lastActivity ?? null,
      msg_count: skeleton.metadata?.messageCount ?? 0,
      metadata: skeleton.metadata ? { ...skeleton.metadata } as Record<string, unknown> : null,
    };

    await writer.upsertConversationOnly(conversationRow);
  } catch {
    // Swallow all errors — dual-write must never block the caller.
    // PgUnifiedStoreWriter has its own circuit-breaker; this catch covers the
    // (rare) case where the writer factory or row mapping itself throws.
  }
}
