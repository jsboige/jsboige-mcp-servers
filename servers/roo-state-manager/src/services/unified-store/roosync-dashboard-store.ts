/**
 * PG persistence for the RooSync dashboards (#3151 Phase C).
 *
 * @module services/unified-store/roosync-dashboard-store
 *
 * Splits the GDrive dashboard markdown across the two tables created in
 * migrations/002 and completed by migrations/006:
 *
 *   `roosync_dashboards`        ← frontmatter (status_json) + Status markdown (content)
 *   `roosync_dashboard_messages`← the intercom journal, one row per message
 *
 * Read path — same contract as the Phase B message channel
 * (roosync-channel-read.ts): PG-primary behind a dedicated env gate, GDrive
 * fallback on PG failure OR key miss (under-show protection — a store that
 * was never backfilled must present as "not found", not as an empty
 * dashboard, so the caller falls back to the file).
 *
 *   UNIFIED_STORE_DASHBOARD_READ_PG=1 + UNIFIED_STORE_PG_URL + reader non-Null
 *
 * Write path — dual-write behind the shared channel gate (writer-factory:
 * UNIFIED_STORE_DUAL_WRITE + UNIFIED_STORE_PG_URL). Unlike the message
 * channel's fire-and-forget, callers AWAIT `dualWriteDashboardSync`: the
 * dashboard is a single hot key written by 6 machines and PG becomes the
 * read-primary store, so a lagging mirror would under-show the very next
 * reader. The await is latency-only — this function never throws, so a hard
 * PG failure still degrades to the GDrive-only behavior (breaker caps the
 * retry cost after 3 consecutive failures).
 */

import type { Dashboard, IntercomMessage } from '../../tools/roosync/dashboard-schemas.js';
import type {
  RooSyncDashboardRow,
  RooSyncDashboardMessageRow,
} from './types.js';
import type { IUnifiedStoreReader } from './UnifiedStoreReader.js';
import { getUnifiedStoreReader } from './reader-factory.js';
import { getUnifiedStoreWriter } from './writer-factory.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('roosync-dashboard-store');

/**
 * Returns the dashboard reader when the Phase C read gate is on, else null.
 *
 * Read at call time (not import time) so tests and config reloads can toggle
 * it without a process restart — same as getChannelPgReader.
 */
export function getDashboardPgReader(): IUnifiedStoreReader | null {
  if (process.env.UNIFIED_STORE_DASHBOARD_READ_PG !== '1') return null;
  if (!process.env.UNIFIED_STORE_PG_URL) return null;
  const reader = getUnifiedStoreReader();
  if (reader.isNull()) return null;
  return reader;
}

/**
 * Split a dashboard key ('machine-foo' | 'workspace-Bar' | 'global') into the
 * machine_id / workspace columns. Mirrors buildDashboardKey's strip rules —
 * the stored columns are informational (type queries), the key stays the
 * identity.
 */
function keyToMachineWorkspace(dashboard: Dashboard): {
  machine_id: string | null;
  workspace: string | null;
} {
  if (dashboard.type === 'machine') {
    return { machine_id: dashboard.key.replace(/^machine-/, ''), workspace: null };
  }
  if (dashboard.type === 'workspace') {
    return { machine_id: null, workspace: dashboard.key.replace(/^workspace-/, '') };
  }
  return { machine_id: null, workspace: null };
}

/** Map an in-memory Dashboard to the dashboard row + journal rows. */
export function mapDashboardToRows(dashboard: Dashboard): {
  row: RooSyncDashboardRow;
  messages: RooSyncDashboardMessageRow[];
} {
  const { machine_id, workspace } = keyToMachineWorkspace(dashboard);
  const status: RooSyncDashboardRow['status_json'] = {
    lastModified: dashboard.lastModified,
    lastModifiedBy: {
      machineId: dashboard.lastModifiedBy.machineId,
      workspace: dashboard.lastModifiedBy.workspace,
      ...(dashboard.lastModifiedBy.worktree !== undefined
        ? { worktree: dashboard.lastModifiedBy.worktree }
        : {}),
    },
    totalMessages: dashboard.intercom.totalMessages,
  };
  if (dashboard.intercom.lastCondensedAt !== undefined) {
    status.lastCondensedAt = dashboard.intercom.lastCondensedAt;
  }
  if (dashboard.status.lastDiffCommit !== undefined) {
    status.lastDiffCommit = dashboard.status.lastDiffCommit;
  }

  return {
    row: {
      key: dashboard.key,
      type: dashboard.type,
      machine_id,
      workspace,
      content: dashboard.status.markdown ?? '',
      status_json: status,
    },
    messages: dashboard.intercom.messages.map(m => mapIntercomMessageToRow(dashboard.key, m)),
  };
}

function mapIntercomMessageToRow(key: string, m: IntercomMessage): RooSyncDashboardMessageRow {
  return {
    dashboard_key: key,
    message_id: m.id,
    author_machine: m.author.machineId,
    author_workspace: m.author.workspace,
    content: m.content,
    tags: [],
    team_stage: m.teamStage ?? null,
    reply_to: m.reply_to ?? null,
    acknowledged_at: m.acknowledged_at ?? null,
    archived_at: null,
    created_at: m.timestamp,
  };
}

/**
 * Inverse of {@link mapDashboardToRows}: reconstruct the in-memory Dashboard.
 *
 * `message_id`-less journal rows (hand-inserted legacy) get a deterministic
 * id derived from the BIGSERIAL — stable across reads, which the #2328 merge
 * and reply_to references require.
 */
export function mapRowsToDashboard(
  row: RooSyncDashboardRow,
  messages: RooSyncDashboardMessageRow[]
): Dashboard {
  const reconstructed: IntercomMessage[] = messages.map(m => {
    const msg: IntercomMessage = {
      id: m.message_id ?? `${m.author_machine}:${m.author_workspace}:pg-${m.id}`,
      timestamp: m.created_at,
      author: { machineId: m.author_machine, workspace: m.author_workspace },
      content: m.content,
    };
    if (m.team_stage !== null) msg.teamStage = m.team_stage as IntercomMessage['teamStage'];
    if (m.reply_to !== null) msg.reply_to = m.reply_to;
    if (m.acknowledged_at && Object.keys(m.acknowledged_at).length > 0) {
      msg.acknowledged_at = m.acknowledged_at;
    }
    return msg;
  });

  const dashboard: Dashboard = {
    type: row.type,
    key: row.key,
    lastModified: row.status_json.lastModified,
    lastModifiedBy: row.status_json.lastModifiedBy,
    status: { markdown: row.content },
    intercom: {
      messages: reconstructed,
      totalMessages: row.status_json.totalMessages ?? reconstructed.length,
    },
  };
  if (row.status_json.lastCondensedAt !== undefined) {
    dashboard.intercom.lastCondensedAt = row.status_json.lastCondensedAt;
  }
  if (row.status_json.lastDiffCommit !== undefined) {
    dashboard.status.lastDiffCommit = row.status_json.lastDiffCommit;
  }
  return dashboard;
}

/**
 * Read one dashboard from PG.
 *
 * @returns The dashboard, or null when the gate is off, PG fails, or the key
 *   has no row — the caller falls back to the GDrive file in all three cases.
 */
export async function readDashboardFromPg(key: string): Promise<Dashboard | null> {
  const reader = getDashboardPgReader();
  if (!reader) return null;
  try {
    const result = await reader.getRooSyncDashboard(key);
    if (!result) return null;
    return mapRowsToDashboard(result.dashboard, result.messages);
  } catch (error) {
    logger.warn('[dashboard-pg] read failed — caller should fall back to GDrive', { key, error: String(error) });
    return null;
  }
}

/**
 * Dual-write a dashboard to PG (sync semantics: row upsert + journal upsert —
 * see PgUnifiedStoreWriter.syncRooSyncDashboard).
 *
 * `opts.condensed` marks a condensation write, the only caller allowed to
 * stamp `archived_at` (GDrive parity: condensation is the sole operation
 * that removes intercom messages). Threaded from applyCondensedWithMerge.
 *
 * Never throws: a PG failure must not block the GDrive path. Callers await
 * this so the PG mirror is consistent before the tool call returns.
 */
export async function dualWriteDashboardSync(
  dashboard: Dashboard,
  opts?: { condensed?: boolean }
): Promise<void> {
  try {
    const { row, messages } = mapDashboardToRows(dashboard);
    await getUnifiedStoreWriter().syncRooSyncDashboard(row, messages, opts);
  } catch (error) {
    // Swallow the throw — never block the GDrive write path — but NEVER in
    // silence: with PG read-primary, "file ahead of PG" is the divergence
    // state, and it must be observable (parity with readDashboardFromPg).
    logger.warn('[dashboard-pg] dual-write sync failed — GDrive write stands, PG mirror diverges', {
      key: dashboard.key,
      condensed: opts?.condensed === true,
      error: String(error),
    });
  }
}

/**
 * Dual-write a dashboard deletion (row + journal cascade). Never throws.
 */
export async function dualWriteDashboardDelete(key: string): Promise<void> {
  try {
    await getUnifiedStoreWriter().deleteRooSyncDashboard(key);
  } catch (error) {
    logger.warn('[dashboard-pg] dual-write delete failed — GDrive delete stands, PG row remains', {
      key,
      error: String(error),
    });
  }
}

/**
 * One-time backfill import of a GDrive-parsed dashboard (#3151 Phase C,
 * scripts/backfill-roosync-dashboards.mjs). INSERT-only semantics
 * (`{ backfill: true }` at the writer) so a file snapshot racing a live
 * sync never overwrites fresher PG state nor archives live messages.
 */
export async function backfillDashboardToStore(dashboard: Dashboard): Promise<void> {
  const { row, messages } = mapDashboardToRows(dashboard);
  await getUnifiedStoreWriter().syncRooSyncDashboard(row, messages, { backfill: true });
}
