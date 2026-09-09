/**
 * PG read path for `list_conversations` (unified store conversation tier).
 *
 * @module services/unified-store/conversation-list-store
 *
 * Same contract shape as the RooSync dashboard/channel read paths
 * (roosync-dashboard-store.ts): opt-in behind a dedicated env gate read at
 * CALL time, and additive — this tier only CONTRIBUTES rows the existing tiers
 * did not already produce. It never replaces or reorders them, so turning the
 * gate off restores the previous behavior exactly.
 *
 *   UNIFIED_STORE_CONVERSATION_READ_PG=1 + UNIFIED_STORE_PG_URL + reader non-Null
 *
 * WHY a PG tier at all — measured 2026-09-07, not assumed:
 *
 *   The premise this started from ("the machineId filter is blind") is FALSE
 *   and was discarded. With `includeArchives: true, waitForArchives: true` the
 *   existing Tier-3 path DOES answer cross-machine. The honest case is coverage
 *   and latency, on the same question (all conversations for myia-po-2025):
 *
 *     Tier 3 (GDrive archive cache) :   430 rows in 32.1 s
 *     PG (this tier)                : 1,114 rows in  14.0 ms server-side
 *
 *   PG is backfilled (ai-01 back to 2025-04-30, smooth monthly distribution),
 *   so the row-count comparison is like-for-like rather than an artefact of a
 *   store that only started recording recently.
 *
 * The label problem this module exists to solve: `title` is NULL on 79.8% of
 * `conversations` rows, so mapping it straight through would REGRESS the
 * displayed label. `resolveLabel` coalesces title -> metadata.title -> first
 * user message, measured at 99.9% labelled (1113/1114) on po-2025.
 */

import type { ConversationSkeleton, SkeletonMetadata } from '../../types/conversation.js';
import type {
  IUnifiedStoreReader,
  ConversationListFilters,
  ConversationListRow,
} from './UnifiedStoreReader.js';
import { getUnifiedStoreReader } from './reader-factory.js';
import { createLogger } from '../../utils/logger.js';

/**
 * Lazy logger.
 *
 * `createLogger` touches the filesystem in its constructor (it ensures the log
 * directory exists), and this module is imported — transitively — by
 * list-conversations.tool.ts, whose unit test mocks `fs` with a partial double.
 * Building the logger at module scope crashed that test on IMPORT, before any
 * assertion ran. Constructing on first use keeps the cost off the import path.
 */
let cachedLogger: ReturnType<typeof createLogger> | null = null;
function getLogger(): ReturnType<typeof createLogger> {
  if (!cachedLogger) cachedLogger = createLogger('conversation-list-store');
  return cachedLogger;
}

/** Marks skeletons produced by this tier, mirroring Tier 3's `gdrive-archive`. */
export const PG_DATA_SOURCE = 'unified-store-pg';

/** Default row cap. Reached => the caller reports `truncated`, never silently. */
export const DEFAULT_PG_LIST_LIMIT = 5000;

/** Label length budget, matching what the tool already shows for cache-loaded Roo tasks. */
const LABEL_MAX = 200;

/**
 * Returns the reader when the conversation-list read gate is on, else null.
 *
 * Read at call time (not import time) so tests and config reloads can toggle it
 * without a process restart — same as getDashboardPgReader.
 */
export function getConversationListPgReader(): IUnifiedStoreReader | null {
  if (process.env.UNIFIED_STORE_CONVERSATION_READ_PG !== '1') return null;
  if (!process.env.UNIFIED_STORE_PG_URL) return null;
  const reader = getUnifiedStoreReader();
  if (reader.isNull()) return null;
  return reader;
}

/** Collapse whitespace and cap, so a label never carries newlines into the list output. */
function toLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > LABEL_MAX ? flat.slice(0, LABEL_MAX) + '...' : flat;
}

/**
 * The label a PG row should display, in falling order of fidelity.
 *
 * `title` is authoritative when present but NULL on 79.8% of rows (the
 * dual-write maps `skeleton.metadata?.title ?? null`). `metadata->>'title'`
 * catches rows whose JSON payload kept a title the column did not. The first
 * user message is the last resort and covers 8,289 of the 10,278 title-less
 * rows.
 */
export function resolveLabel(row: ConversationListRow): string | undefined {
  if (row.title && row.title.trim()) return toLabel(row.title);
  const metaTitle = row.metadata?.title;
  if (typeof metaTitle === 'string' && metaTitle.trim()) return toLabel(metaTitle);
  if (row.first_user_message && row.first_user_message.trim()) return toLabel(row.first_user_message);
  return undefined;
}

/** `harness` column -> the `metadata.source` vocabulary used by the list tool. */
function harnessToSource(harness: string): SkeletonMetadata['source'] | undefined {
  switch (harness) {
    case 'roo': return 'roo';
    case 'zoo': return 'zoo-code';
    case 'claude': return 'claude-code';
    default: return undefined;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Map a PG row to the skeleton shape the list tool consumes.
 *
 * `sequence` is intentionally EMPTY: this tier lists conversations, it does not
 * load their 2.7M messages. The tool already handles that case — its node
 * builder falls back to `metadata.title` for `firstUserMessage` when the
 * sequence is empty (the path Roo tasks loaded via quickAnalyze take), which is
 * why the label resolution above is what makes these rows readable.
 *
 * Fields that would have to be INVENTED are left absent rather than defaulted
 * to a plausible number: `actionCount`/`totalSize` fall back to 0 only when the
 * stored metadata carries no real value, and no per-role message counts are
 * fabricated for a conversation whose messages were never read.
 */
export function mapRowToSkeleton(row: ConversationListRow): ConversationSkeleton {
  const meta = row.metadata ?? {};
  const lastActivity =
    row.last_ts ?? stringOrUndefined(meta.lastActivity) ?? row.first_ts ?? row.ingested_at ?? '';
  const createdAt = row.first_ts ?? stringOrUndefined(meta.createdAt) ?? lastActivity;
  const label = resolveLabel(row);
  const source = harnessToSource(row.harness);
  const mode = stringOrUndefined(meta.mode);

  const metadata: SkeletonMetadata = {
    ...(label ? { title: label } : {}),
    lastActivity,
    createdAt,
    messageCount: numberOr(row.msg_count, 0),
    actionCount: numberOr(meta.actionCount, 0),
    totalSize: numberOr(meta.totalSize, 0),
    ...(row.workspace ? { workspace: row.workspace } : {}),
    machineId: row.machine_id,
    dataSource: PG_DATA_SOURCE,
    ...(source ? { source } : {}),
    ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
    ...(mode ? { mode } : {}),
  };

  return {
    taskId: row.task_id,
    ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
    metadata,
    ...(label ? { truncatedInstruction: label } : {}),
    sequence: [],
  };
}

/** Outcome of a PG tier read, reported to the caller verbatim. */
export interface PgConversationTierResult {
  status: 'ready' | 'failed';
  /** Rows the query returned, BEFORE dedup against the tiers already loaded. */
  rows_read: number;
  /** True when the row cap was reached — results may omit older conversations. */
  truncated: boolean;
  /** Skeletons contributed, i.e. rows whose taskId no earlier tier had produced. */
  skeletons: ConversationSkeleton[];
  /** Present only when status === 'failed'. */
  error?: string;
}

/**
 * Read the PG conversation tier.
 *
 * Never throws: a PG failure degrades to `status: 'failed'` carrying the
 * message, so the response still renders its local tiers — the same
 * degradation contract the archive tier already has.
 *
 * @param alreadyPresent taskIds produced by the earlier tiers; rows in this set
 *   are dropped, so PG never duplicates nor overrides a locally-loaded task.
 */
export async function loadPgConversationTier(
  filters: ConversationListFilters,
  alreadyPresent: ReadonlySet<string>,
): Promise<PgConversationTierResult> {
  const reader = getConversationListPgReader();
  if (!reader) {
    // Unreachable via the tool, which checks the gate first. Kept so the
    // function is safe to call directly.
    return { status: 'ready', rows_read: 0, truncated: false, skeletons: [] };
  }

  const limit = filters.limit ?? DEFAULT_PG_LIST_LIMIT;
  try {
    const rows = await reader.listConversations({ ...filters, limit });
    const skeletons: ConversationSkeleton[] = [];
    for (const row of rows) {
      if (alreadyPresent.has(row.task_id)) continue;
      skeletons.push(mapRowToSkeleton(row));
    }
    return {
      status: 'ready',
      rows_read: rows.length,
      truncated: rows.length >= limit,
      skeletons,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getLogger().warn('[conversation-pg] read failed — rendering local tiers only', { error: message });
    return { status: 'failed', rows_read: 0, truncated: false, skeletons: [], error: message };
  }
}
