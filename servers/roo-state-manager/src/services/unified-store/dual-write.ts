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

import type { ConversationSkeleton, MessageSkeleton } from '../../types/conversation.js';
import type { ConversationRow, Harness, MessageRow } from './types.js';
import { getUnifiedStoreWriter } from './writer-factory.js';

/**
 * #2957 défaut 1: structural type guard distinguishing MessageSkeleton from
 * ActionMetadata in the `sequence` union. ActionMetadata carries a `type`
 * discriminant ('tool' | 'command'); MessageSkeleton carries a `role`
 * ('user' | 'assistant'). Checking `role` keeps the guard structural — it does
 * not need to import ActionMetadata and tolerates additive fields on either side.
 */
function isMessageSkeleton(
  item: ConversationSkeleton['sequence'][number]
): item is MessageSkeleton {
  return typeof (item as MessageSkeleton).role === 'string';
}

/**
 * #2957 défaut 1: map a skeleton's `sequence` to the DB `MessageRow[]` shape.
 * Filters out ActionMetadata (tool/command actions are not message rows) and
 * assigns a message-relative contiguous `seq` — stable across re-analysis even
 * when action detection varies (a message's seq does not shift if the number of
 * interleaved actions changes). MessageSkeleton carries no `message_id` nor
 * `tool_calls`, so those are null.
 */
function mapSequenceToMessageRows(
  taskId: string,
  sequence: ConversationSkeleton['sequence']
): MessageRow[] {
  const rows: MessageRow[] = [];
  let seq = 0;
  for (const item of sequence) {
    if (!isMessageSkeleton(item)) continue; // skip ActionMetadata (tool/command)
    rows.push({
      task_id: taskId,
      message_id: null,
      seq,
      role: item.role,
      content: item.content,
      tool_calls: null,
      ts: item.timestamp,
    });
    seq++;
  }
  return rows;
}

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

    // #2957: normalize machine_id to lowercase at the write boundary. The fallback
    // chain mixes sources with inconsistent casing — skeleton.metadata.machineId
    // (often os.hostname(), preserves OS casing), ROOSYNC_MACHINE_ID (normalized
    // in roosync-config.ts but only when set), and COMPUTERNAME (Windows preserves
    // the OS casing e.g. 'MyIA-AI-01'). Without normalization the same physical
    // machine is counted twice in the unified store ('myia-ai-01' vs 'MyIA-AI-01').
    // dual-write is the single converging point before the DB write, so this one
    // line covers all three sources. 'unknown' is already lowercase.
    const rawMachineId = skeleton.metadata?.machineId
      ?? process.env.ROOSYNC_MACHINE_ID
      ?? process.env.COMPUTERNAME
      ?? 'unknown';

    const conversationRow: ConversationRow = {
      task_id: taskId,
      machine_id: rawMachineId.toLowerCase(),
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

    // #2957 défaut 1: also dual-write the message-level rows. The writer HAS
    // upsertMessages (PgUnifiedStoreWriter.ts:199) but production never called
    // it → the `messages` table stayed empty while conversations declared
    // sum(msg_count) in the millions (signature #692: writer method with zero
    // call site). Wired here at the single converging point, same fire-and-forget
    // contract. Conversation-first satisfies any FK; both writes fall through
    // the catch on failure (best-effort, like the conversation write above).
    // Single-point guard (audit reco #1): skip when the sequence is empty or
    // missing — covers header-only toHeader() partials (which drop sequence)
    // AND legitimately empty conversations, so the 9 call sites + future
    // callers never emit a spurious empty upsert. Env-gate is inherited:
    // NullUnifiedStoreWriter.upsertMessages is a no-op when the flag is off.
    const sequence = skeleton.sequence ?? [];
    const messageRows = mapSequenceToMessageRows(taskId, sequence);
    if (messageRows.length > 0) {
      await writer.upsertMessages(messageRows);
    }
  } catch {
    // Swallow all errors — dual-write must never block the caller.
    // PgUnifiedStoreWriter has its own circuit-breaker; this catch covers the
    // (rare) case where the writer factory or row mapping itself throws.
  }
}
