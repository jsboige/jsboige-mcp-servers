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
  DashboardRetirementMark,
} from './types.js';
import type { IUnifiedStoreReader } from './UnifiedStoreReader.js';
import type { RooSyncLockAcquireStatus, UnifiedStoreWriteOutcome } from './UnifiedStoreWriter.js';
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
 * #3782 guard (a) — ungated journal probe for the append-on-absent-file guard.
 *
 * Unlike readDashboardFromPg, this probe is NOT behind the
 * UNIFIED_STORE_DASHBOARD_READ_PG gate: that gate decides which surface
 * serves READS (the T0 switchover, #3151/#3230), while the guard is an
 * internal decision input on the append path — a path that already talks to
 * PG through the dual-write. Bounded by a short race timeout (GO #3782
 * condition 1: a hung pool must never block the append); on any failure the
 * answer is 'unreachable' and the caller keeps today's behaviour.
 *
 * Recency threshold per the #3782 design: the journal qualifies as
 * "disappeared" (DriveFS conflict in progress) when the status is non-empty
 * OR at least one journal row is less than 6 h old. Anything else with a row
 * is 'stale' (observable, normal creation); no row is 'empty' (genuinely new
 * key, silent normal creation); no PG story on this host is 'pg-off'.
 */
export type GuardAProbe =
  | { kind: 'pg-off' }
  | { kind: 'unreachable' }
  | { kind: 'empty' }
  | { kind: 'stale'; rows: number }
  | { kind: 'disappeared'; dashboard: Dashboard; rows: number };

const GUARD_A_PROBE_TIMEOUT_MS = 3000;
const GUARD_A_RECENCY_MS = 6 * 3600 * 1000;

export async function probeDashboardJournalForHydration(key: string): Promise<GuardAProbe> {
  if (process.env.UNIFIED_STORE_DUAL_WRITE !== '1' || !process.env.UNIFIED_STORE_PG_URL) {
    return { kind: 'pg-off' };
  }
  const reader = getUnifiedStoreReader();
  if (reader.isNull()) return { kind: 'pg-off' };
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => { timedOut = true; resolve(null); }, GUARD_A_PROBE_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([reader.getRooSyncDashboard(key), timeout]);
    if (result === null && timedOut) return { kind: 'unreachable' };
    if (!result) return { kind: 'empty' };
    const statusNonEmpty = (result.dashboard.content ?? '').trim().length > 0;
    const recencyCutoff = Date.now() - GUARD_A_RECENCY_MS;
    const hasRecentMessage = result.messages.some(
      (m) => new Date(m.created_at).getTime() > recencyCutoff
    );
    if (statusNonEmpty || hasRecentMessage) {
      return {
        kind: 'disappeared',
        dashboard: mapRowsToDashboard(result.dashboard, result.messages),
        rows: result.messages.length,
      };
    }
    return { kind: 'stale', rows: result.messages.length };
  } catch (error) {
    logger.warn("[guard-a] journal probe failed — append keeps today's behaviour", {
      key,
      error: String(error),
    });
    return { kind: 'unreachable' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * #3782 (résurrection workspace-CoursIA 26/09) — tombstones d'archive pour le
 * merge. Un message archivé sur la CIBLE (row journal `archived_at` posé) n'est
 * pas « perdu » quand il apparaît dans une vue source : il est condensé. Sans
 * ce filtre, l'union du merge ressuscite tout message déjà condensé que porte
 * encore une vue fichier périmée ou le journal jamais condensé d'une clé fork
 * (mesuré : 84 messages réimportés vivants, dashboard à 332 %).
 *
 * Même contrat que la sonde guard-a : UNGATED (l'hôte dual-écrit, il peut
 * décider), course de timeout courte, fail-open — `null` (pas d'histoire PG)
 * laisse l'union inchangée.
 */
const ARCHIVED_IDS_TIMEOUT_MS = 3000;

export async function fetchArchivedDashboardMessageIds(key: string): Promise<Set<string> | null> {
  if (process.env.UNIFIED_STORE_DUAL_WRITE !== '1' || !process.env.UNIFIED_STORE_PG_URL) {
    return null;
  }
  const reader = getUnifiedStoreReader();
  if (reader.isNull()) return null;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => { timedOut = true; resolve(null); }, ARCHIVED_IDS_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([
      reader.getArchivedRooSyncDashboardMessageIds(key),
      timeout,
    ]);
    if (result === null && timedOut) {
      logger.warn('[merge-tombstones] archived-id fetch timed out — union proceeds unfiltered (fail-open)', { key });
      return null;
    }
    if (!result) return null;
    return new Set(result);
  } catch (error) {
    logger.warn('[merge-tombstones] archived-id fetch failed — union proceeds unfiltered (fail-open)', {
      key,
      error: String(error),
    });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
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
 * Checked variants (rework #1134, review ask 2): the PG half's outcome is
 * RETURNED, not swallowed. Callers that are about to make an irreversible
 * decision predicated on "PG now holds (or no longer holds) this" — the merge
 * action gating its source removal on the target sync — must use these. The
 * Null writer resolves `{ ok: false, reason: 'disabled' }`: a host with no PG
 * half has nothing at stake there, which callers treat as acceptable.
 *
 * Idempotent by construction (upsert / DELETE by key) — calling a checked
 * variant right after its void sibling re-runs the same payload harmlessly.
 */
export async function dualWriteDashboardSyncChecked(
  dashboard: Dashboard,
  opts?: { condensed?: boolean }
): Promise<UnifiedStoreWriteOutcome> {
  try {
    const { row, messages } = mapDashboardToRows(dashboard);
    return await getUnifiedStoreWriter().syncRooSyncDashboardChecked(row, messages, opts);
  } catch (error) {
    logger.warn('[dashboard-pg] checked dual-write sync failed', {
      key: dashboard.key,
      condensed: opts?.condensed === true,
      error: String(error),
    });
    return { ok: false, reason: 'exhausted', detail: String(error) };
  }
}

export async function dualWriteDashboardDeleteChecked(
  key: string
): Promise<UnifiedStoreWriteOutcome> {
  try {
    return await getUnifiedStoreWriter().deleteRooSyncDashboardChecked(key);
  } catch (error) {
    logger.warn('[dashboard-pg] checked dual-write delete failed', { key, error: String(error) });
    return { ok: false, reason: 'exhausted', detail: String(error) };
  }
}

// ─── Journal-level key retirement (#3782 — arbitration comment 5844675985) ──

const RETIREMENT_LOOKUP_TIMEOUT_MS = 3000;

/**
 * #3782 — the ACTIVE retirement mark of a key, or null (not retired / lifted /
 * no PG half / lookup failure — fail-open everywhere: the worst case is
 * today's behaviour, the fork stays visible).
 *
 * Like the guard-a probe, NOT behind UNIFIED_STORE_DASHBOARD_READ_PG: the
 * marks are decision inputs for every dashboard read/list/write, including on
 * dual-write hosts whose read gate is still off. Bounded by a short race so a
 * hung pool never blocks the read path.
 */
export async function getDashboardRetirement(
  key: string
): Promise<DashboardRetirementMark | null> {
  try {
    const reader = getUnifiedStoreReader();
    if (reader.isNull()) return null;
    let timedOut = false;
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => { timedOut = true; resolve(null); }, RETIREMENT_LOOKUP_TIMEOUT_MS);
    });
    const mark = await Promise.race([reader.getRooSyncDashboardRetirement(key), timeout]);
    if (mark === null && timedOut) {
      logger.warn('[retirement #3782] lookup timed out — treating key as NOT retired (fail-open)', { key });
    }
    return mark;
  } catch (error) {
    logger.warn('[retirement #3782] lookup failed — treating key as NOT retired (fail-open)', {
      key,
      error: String(error),
    });
    return null;
  }
}

/** #3782 — every key carrying an ACTIVE mark. Fail-open: empty set. */
export async function listRetiredDashboardKeys(): Promise<Set<string>> {
  try {
    const reader = getUnifiedStoreReader();
    if (reader.isNull()) return new Set();
    // Same 3s race as getDashboardRetirement (#3782 suite, review ai-01 26/09):
    // list feeds handleList on EVERY dashboard call — a hung PG read must not
    // hang every read/append on the host.
    let timedOut = false;
    const timeout = new Promise<string[]>((resolve) => {
      setTimeout(() => { timedOut = true; resolve([]); }, RETIREMENT_LOOKUP_TIMEOUT_MS);
    });
    const keys = await Promise.race([reader.listRetiredRooSyncDashboardKeys(), timeout]);
    if (timedOut) {
      logger.warn('[retirement #3782] list timed out — treating as no retired keys (fail-open)');
    }
    return new Set(keys);
  } catch (error) {
    logger.warn('[retirement #3782] list failed — treating as no retired keys (fail-open)', {
      error: String(error),
    });
    return new Set();
  }
}

/**
 * #3782 — retire a merged-away source key: a MARK, never a DELETE. The
 * dashboard + journal rows stay in base (gel des purges); reads, listings and
 * the fork detector stop seeing the key; writes are redirected to the target.
 * Checked variant — the merge gates its source disposition on the outcome
 * (`disabled` on a host with no PG half is acceptable, same as the deletes).
 */
export async function retireDashboardKeyChecked(
  sourceKey: string,
  targetKey: string,
  retiredBy: string
): Promise<UnifiedStoreWriteOutcome> {
  try {
    return await getUnifiedStoreWriter().retireRooSyncDashboardKeyChecked(sourceKey, targetKey, retiredBy);
  } catch (error) {
    logger.warn('[retirement #3782] mark write failed', { sourceKey, targetKey, error: String(error) });
    return { ok: false, reason: 'exhausted', detail: String(error) };
  }
}

/** #3782 — lift an active mark: the key becomes readable again with its original content. */
export async function unretireDashboardKeyChecked(
  key: string
): Promise<UnifiedStoreWriteOutcome> {
  try {
    return await getUnifiedStoreWriter().unretireRooSyncDashboardKeyChecked(key);
  } catch (error) {
    logger.warn('[retirement #3782] mark lift failed', { key, error: String(error) });
    return { ok: false, reason: 'exhausted', detail: String(error) };
  }
}

// ─── #3782 locks-off-Drive — consultative PG lock, wrapper layer ─────────────

/** One lock op must answer within this budget; past it the caller falls back to its machine-local lock. */
const LOCK_OP_TIMEOUT_MS = 3000;

/**
 * #3782 locks-off-Drive — acquire the PG consultative lock row. The lock files
 * used to live in dashboards/ on GDrive, where Drive re-parents them to the
 * drive root under contention (58 orphans measured, po-2027 26/09); this row
 * replaces the cross-machine half of that lock. Errors, timeouts, breaker-open
 * and missing writer methods ALL degrade to 'unavailable' — the caller then
 * uses its machine-local lock and #2328 remains the correctness backstop.
 */
export async function acquireDashboardSharedLock(
  lockKey: string,
  holderJson: string,
  ttlMs: number
): Promise<RooSyncLockAcquireStatus> {
  try {
    const timeout = new Promise<RooSyncLockAcquireStatus>((resolve) => {
      setTimeout(() => resolve('unavailable'), LOCK_OP_TIMEOUT_MS);
    });
    return await Promise.race([
      getUnifiedStoreWriter().tryAcquireRooSyncDashboardLock(lockKey, holderJson, ttlMs),
      timeout,
    ]);
  } catch (error) {
    logger.warn('[locks #3782] PG lock acquire failed — machine-local layer takes over', {
      lockKey,
      error: String(error),
    });
    return 'unavailable';
  }
}

/** #3782 — best-effort release of the PG lock row (TTL steal recovers an unreleased row). */
export async function releaseDashboardSharedLock(lockKey: string, holderJson: string): Promise<void> {
  try {
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), LOCK_OP_TIMEOUT_MS);
    });
    await Promise.race([
      getUnifiedStoreWriter().releaseRooSyncDashboardLock(lockKey, holderJson),
      timeout,
    ]);
  } catch {
    // Best-effort: the TTL steal recovers an unreleased row.
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
