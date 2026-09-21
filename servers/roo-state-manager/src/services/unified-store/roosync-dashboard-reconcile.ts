/**
 * Periodic GDrive→PG reconcile of the RooSync dashboards (#3151 Phase C
 * residual, symmetric to the channel reconcile #3292).
 *
 * @module services/unified-store/roosync-dashboard-reconcile
 *
 * WHY — the awaited dual-write (roosync-dashboard-store.dualWriteDashboardSync)
 * mirrors dashboards to PG as they are saved, but the same three measured
 * loss classes as #3292 leave the GDrive file with journal rows PG lacks:
 *   1. hard kill between the GDrive write and the PG write;
 *   2. PG outages (dual-write never throws, the breaker gives up);
 *   3. state regression on a machine (env lost, wedged pool) — dual-write
 *      silently stops while GDrive keeps receiving.
 * Unlike the channel, dashboards had NO reconcile, so the debt accumulates
 * unbounded: 31 disk-only messages on 9 keys measured 13/09, 63 on 19 keys
 * measured 17/09. This standing hole is the one thing blocking
 * UNIFIED_STORE_DASHBOARD_READ_PG (#3151-D/#3230): a PG-reading host that
 * condenses rewrites the file from its PG view and erases disk-only rows
 * (dashboard.ts merge guard, ai-01 13/09).
 *
 * HOW — persisted-id diff per dashboard file, insert + guarded archival:
 *   - only messages carrying a `[msg: <id>]` line are reconcilable — the id
 *     IS the fingerprint. Pre-v3 id-less messages are skipped and counted
 *     (importing them would insert a fresh synthesized id on every pass —
 *     the same phantom rule as the channel reconcile, and the backfill
 *     script got the same guard with this module);
 *   - per keyed .md file: parse, diff persisted ids against the ACTIVE PG
 *     journal (archived_at IS NULL) for that key, and for gap keys call the
 *     writer's backfill transaction (INSERT ... DO NOTHING on both the
 *     dashboard row and the journal) — a pass racing a live dual-write or a
 *     reconcile on another machine converges instead of duplicating;
 *   - insert pass: never overwrites fresher PG content (backfill:true
 *     semantics at the writer).
 *   - ARCHIVAL pass (#3151-D gate, 21/09): alive PG rows whose message the
 *     fresh file no longer shows (condensed on a machine whose dual-write
 *     never landed — the 404-line/8-key "family A" debt measured by ai-01
 *     21/09) get archived_at stamped. Guards, ALL must pass per key:
 *       1. not a GDrive conflict copy ("name (N).md" = fork by construction
 *          — family B, remedy is roosync_dashboard merge, never archive);
 *       2. the file is not BEHIND PG: no alive row newer than the file's
 *          newest message — a dead mirror (2-4 days stale, also family B)
 *          must never drive archival;
 *     and per row: persisted id absent from the file's fingerprintable ids,
 *     non-null message_id, created_at older than a min age (default 24 h —
 *     an append racing THIS pass is young, ai-01 measured a 39 s-old
 *     arbitrage message nearly archived by the manual catch-up).
 *     Stale/fork keys are REPORTED (staleFileKeys/forkFiles), never touched.
 *     Kill-switch: ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE=0 restores the
 *     insert-only behavior; ROOSYNC_DASHBOARD_ARCHIVE_MIN_AGE_H overrides
 *     the min age.
 *
 * Cost — the whole fleet is ~66 keyed files (not the 50 K-file channel
 * pool), so a pass is one readdir + one parse per file + one PG read per
 * divergent key. No lookback window needed.
 *
 * Env-gate: same flags as the dual-write (UNIFIED_STORE_DUAL_WRITE=1 +
 * UNIFIED_STORE_PG_URL) — reconciling into a Null writer is pure GDrive IO.
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import {
  parseDashboardMarkdown,
  extractPersistedMessageIds,
} from '../../tools/roosync/dashboard-markdown.js';
import { mapDashboardToRows } from './roosync-dashboard-store.js';
import type { IUnifiedStoreWriter } from './UnifiedStoreWriter.js';
import type { IUnifiedStoreReader } from './UnifiedStoreReader.js';
import { getUnifiedStoreWriter } from './writer-factory.js';
import { getUnifiedStoreReader } from './reader-factory.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('roosync-dashboard-reconcile');

export interface DashboardReconcileResult {
  /** 'skipped-not-armed' = dual-write off on this process — nothing was done. */
  status: 'ok' | 'skipped-not-armed';
  /** Keyed .md files seen in the dashboards dir. */
  filesScanned: number;
  /** Keys whose parse succeeded. */
  parsedKeys: number;
  /** Persisted-id messages across all parsed files. */
  persistedIds: number;
  /** Pre-v3 id-less messages — skipped by design (unfingerprintable). */
  idlessSkipped: number;
  /** Keys with at least one persisted id missing from the PG journal. */
  keysWithGap: number;
  /** Gap messages across those keys (before insert). */
  gapMessages: number;
  /** Persisted ids PG already held in divergent keys (not re-sent). */
  alreadyPresent: number;
  /** Gap ids verified present in PG after the insert pass (honest count). */
  reconciled: number;
  /** Rows whose archived_at propagated to PG this pass (idempotent, honest count). */
  archivedRows: number;
  /** Alive-but-absent rows NOT archived — younger than the min age (next pass heals). */
  archiveTooYoung: number;
  /** Files whose alive PG journal is AHEAD of the file — fork/dead mirror, merge remedy, untouched. */
  staleFileKeys: string[];
  /** GDrive conflict-copy files ("name (N).md") — fork by construction, merge remedy, untouched. */
  forkFiles: string[];
  /** Files that failed (read/parse/PG). Counted, never thrown per file. */
  errors: number;
  /** file: reason — the operator's re-run list. */
  failures: string[];
  durationMs: number;
}

export interface DashboardReconcileOptions {
  /** `{sharedStatePath}/dashboards` — the dir holding global/machine-/workspace-*.md. */
  dashboardsDir: string;
  /** Reader seam for tests. Default getUnifiedStoreReader(). */
  reader?: Pick<IUnifiedStoreReader, 'getRooSyncDashboard'>;
  /** Writer seam for tests. Default getUnifiedStoreWriter(). */
  writer?: Pick<IUnifiedStoreWriter, 'syncRooSyncDashboard' | 'archiveRooSyncDashboardMessages'>;
}

/** Same gate as the channel reconcile — mirrors writer-factory's arming. */
export function isDashboardReconcileArmed(): boolean {
  return process.env.UNIFIED_STORE_DUAL_WRITE === '1' && !!process.env.UNIFIED_STORE_PG_URL;
}

/** Archival pass kill-switch — '0' restores the insert-only reconcile. */
export function isArchivePassEnabled(): boolean {
  return process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE !== '0';
}

/** Min age (hours) a PG alive row must have before this pass may archive it. */
export function archiveMinAgeHours(): number {
  const v = Number(process.env.ROOSYNC_DASHBOARD_ARCHIVE_MIN_AGE_H);
  return Number.isFinite(v) && v > 0 ? v : 24;
}

/**
 * GDrive conflict copies — "name (N).md" forks, merge remedy, never archived.
 *
 * Exported since #3482-follow: this constant is the ONE definition of "fork by
 * construction" and is also read by the enumeration-side detector
 * (`detectDashboardForks`, tools/roosync/dashboard.ts). Two mirrored copies
 * would be free to drift apart, and a detector that disagrees with the pass
 * that refuses to touch forks is worse than no detector.
 */
export const FORK_FILE_RE = /\s\(\d+\)\.md$/;

/**
 * True when a dashboard FILE NAME (with extension) is a DriveFS conflict copy.
 * Accepts either a bare name or a key (same thing minus the extension), hence
 * the optional extension in the tested form.
 */
export function isGdriveConflictCopyFile(nameOrKey: string): boolean {
  return FORK_FILE_RE.test(nameOrKey.endsWith('.md') ? nameOrKey : `${nameOrKey}.md`);
}

/**
 * Strip every trailing ` (N)` conflict-copy marker to recover the canonical
 * key a fork belongs to. Nested collisions (` (1) (1)`, seen live on po-2024
 * 2026-09-21) resolve to the same root as the single-marker ones.
 */
export function canonicalKeyOfFork(key: string): string {
  return key.replace(/(\s\(\d+\))+$/, '');
}

/** Max parseable timestamp in ms, or null when nothing parses. */
function maxTimestampMs(values: (string | undefined | null)[]): number | null {
  let max: number | null = null;
  for (const v of values) {
    if (!v) continue;
    const ts = Date.parse(v);
    if (Number.isFinite(ts) && (max === null || ts > max)) max = ts;
  }
  return max;
}

function isKeyedDashboardFile(name: string): boolean {
  return (
    name.endsWith('.md') &&
    (name === 'global.md' || name.startsWith('machine-') || name.startsWith('workspace-'))
  );
}

/**
 * One reconcile pass: per keyed .md file, diff persisted message ids against
 * the active PG journal and backfill-insert the missing rows.
 *
 * Throws only when the initial readdir fails (wrong dir = config error worth
 * surfacing). Everything per-file/per-key is counted, never thrown.
 */
export async function reconcileDashboardsFromGDrive(
  options: DashboardReconcileOptions
): Promise<DashboardReconcileResult> {
  const startedAt = Date.now();
  const result: DashboardReconcileResult = {
    status: 'ok',
    filesScanned: 0,
    parsedKeys: 0,
    persistedIds: 0,
    idlessSkipped: 0,
    keysWithGap: 0,
    gapMessages: 0,
    alreadyPresent: 0,
    reconciled: 0,
    archivedRows: 0,
    archiveTooYoung: 0,
    staleFileKeys: [],
    forkFiles: [],
    errors: 0,
    failures: [],
    durationMs: 0,
  };

  if (!isDashboardReconcileArmed()) {
    result.status = 'skipped-not-armed';
    result.durationMs = Date.now() - startedAt;
    return result;
  }
  const reader = options.reader ?? getUnifiedStoreReader();
  const writer = options.writer ?? getUnifiedStoreWriter();

  let files: string[];
  try {
    files = await readdir(options.dashboardsDir);
  } catch (error) {
    throw new Error(`dashboards directory unreadable: ${options.dashboardsDir} — ${String(error)}`);
  }
  const keyed = files.filter(isKeyedDashboardFile);
  result.filesScanned = keyed.length;

  for (const file of keyed) {
    const key = file.replace(/\.md$/, '');
    try {
      let content = await readFile(join(options.dashboardsDir, file), 'utf-8');
      content = content.replace(/\r\n/g, '\n'); // same normalization as the tool read path
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // strip UTF-8 BOM
      const persisted = extractPersistedMessageIds(content);
      const dashboard = parseDashboardMarkdown(content, key);
      result.parsedKeys++;
      result.persistedIds += persisted.size;
      // max(0, …): an orphan [msg:] line (id with no matching parsed message)
      // must not drive the count negative.
      result.idlessSkipped += Math.max(0, dashboard.intercom.messages.length - persisted.size);

      // Fingerprintable messages only — id-less ones are skipped by design.
      const messages = dashboard.intercom.messages.filter((m) => persisted.has(m.id));
      if (messages.length === 0) continue;

      // Active PG journal for the key. Key miss (null) = never backfilled —
      // every persisted id is a gap, which imports the file as-is. The
      // snapshot is kept for the archival pass below (pre-insert view: rows
      // PG already held, absent from the fresh file).
      let existing: Awaited<ReturnType<IUnifiedStoreReader['getRooSyncDashboard']>> = null;
      try {
        existing = await reader.getRooSyncDashboard(key);
      } catch (error) {
        // Cannot list this key → do not blind-import it. Next pass retries.
        result.errors++;
        result.failures.push(`${file}: PG read failed — ${String(error)}`);
        continue;
      }
      const pgIds = new Set(
        (existing?.messages ?? []).map((m) => m.message_id).filter((id): id is string => !!id)
      );

      const gap = messages.filter((m) => !pgIds.has(m.id));
      if (gap.length > 0) {
        result.keysWithGap++;
        result.gapMessages += gap.length;
        result.alreadyPresent += messages.length - gap.length;

        // Full dashboard row (correct content/status_json) + journal rows for
        // the gap only. backfill:true = INSERT DO NOTHING everywhere — never
        // overwrites fresher PG content, never archives, converges on races.
        const full = mapDashboardToRows(dashboard);
        const filtered = mapDashboardToRows({
          ...dashboard,
          intercom: { ...dashboard.intercom, messages: gap },
        });
        try {
          await writer.syncRooSyncDashboard(full.row, filtered.messages, { backfill: true });
        } catch (error) {
          result.errors++;
          result.failures.push(`${file}: PG insert failed — ${String(error)}`);
          // PG write path just failed — its state is uncertain, archival
          // would compound the error. Next pass retries both.
          continue;
        }

        // Honest count: withRetry swallows insert failures, so attempts are
        // not persists. One re-read per healed key makes `reconciled` verifiable
        // (same contract as the channel reconcile's post-insert listing).
        try {
          const after = await reader.getRooSyncDashboard(key);
          const afterIds = new Set(
            (after?.messages ?? []).map((m) => m.message_id).filter((id): id is string => !!id)
          );
          result.reconciled += gap.filter((m) => afterIds.has(m.id)).length;
        } catch {
          result.reconciled += gap.length; // post-read failed — report attempted count
        }
      }

      // ─── Archival pass (#3151-D gate — guards documented in the module
      // header). Runs on the PRE-insert snapshot: only rows PG already
      // held, whose message a fresh file read no longer shows, under the
      // per-key freshness/fork gates. Stale and fork keys are reported,
      // never touched — their remedy is roosync_dashboard merge.
      if (isArchivePassEnabled() && existing) {
        if (isGdriveConflictCopyFile(file)) {
          result.forkFiles.push(file);
        } else {
          const fileMaxMs = maxTimestampMs(dashboard.intercom.messages.map((m) => m.timestamp));
          const pgMaxMs = maxTimestampMs(existing.messages.map((m) => m.created_at));
          const candidates = existing.messages.filter(
            (m) => m.message_id !== null && !persisted.has(m.message_id)
          );
          if (candidates.length === 0) {
            // nothing alive-but-absent — healthy key, no classification
          } else if (fileMaxMs === null || pgMaxMs === null || pgMaxMs > fileMaxMs) {
            result.staleFileKeys.push(file);
          } else {
            const cutoff = Date.now() - archiveMinAgeHours() * 3600_000;
            const toArchive = candidates.filter((m) => {
              const ts = Date.parse(m.created_at);
              return Number.isFinite(ts) && ts < cutoff;
            });
            result.archiveTooYoung += candidates.length - toArchive.length;
            if (toArchive.length > 0) {
              try {
                const n = await writer.archiveRooSyncDashboardMessages(
                  key,
                  toArchive.map((m) => m.message_id as string)
                );
                result.archivedRows += n;
              } catch (error) {
                result.errors++;
                result.failures.push(`${file}: PG archive failed — ${String(error)}`);
              }
            }
          }
        }
      }
    } catch (error) {
      // Corrupt frontmatter, transient DriveFS miss — the next pass retries.
      result.errors++;
      result.failures.push(`${file}: ${String(error)}`);
    }
  }

  result.durationMs = Date.now() - startedAt;
  if (result.keysWithGap > 0) {
    logger.info(
      `[dashboard-reconcile] Reconciled ${result.reconciled}/${result.gapMessages} message(s) ` +
        `across ${result.keysWithGap} key(s) (${result.idlessSkipped} id-less skipped, ` +
        `${result.errors} error(s))`
    );
  }
  if (result.archivedRows > 0 || result.archiveTooYoung > 0) {
    logger.info(
      `[dashboard-reconcile] Archived ${result.archivedRows} condensed row(s) in PG ` +
        `(${result.archiveTooYoung} too young deferred, ` +
        `${result.staleFileKeys.length} stale-file key(s) + ${result.forkFiles.length} fork file(s) untouched)`
    );
  }
  // #3482-follow — the fork count above is only emitted when this pass happened
  // to archive a row, so a quiet pass stayed silent about the forks it saw.
  // Fork reporting is a standing fact about the store, not a side note of the
  // archival pass: report it on every pass that found one.
  if (result.forkFiles.length > 0) {
    logger.warn(
      `[dashboard-reconcile] ${result.forkFiles.length} fork file(s) seen, left untouched (#3482) — ` +
        `merge remedy; the enumeration-side signal is on action:"list"`
    );
  }
  return result;
}

// ─── Daemon (module-level singleton, same shape as MessageManager's channel
// daemon — dashboards have no manager class to host it, and the timer must
// not extend the MCP tool surface) ─────────────────────────────────────────

let dashboardReconcileTimer: ReturnType<typeof setInterval> | null = null;
let dashboardReconcileLastRun: {
  at: string;
  result?: DashboardReconcileResult;
  error?: string;
} | null = null;

/**
 * Start the periodic reconcile. Idempotent start (duplicate start logs and
 * ignores). Concurrency-safe across machines: inserts are DO NOTHING.
 */
export function startDashboardReconcileDaemon(opts: {
  dashboardsDir: string;
  intervalHours?: number;
}): void {
  if (dashboardReconcileTimer !== null) {
    logger.warn('[dashboard-reconcile] daemon already running, ignoring duplicate start');
    return;
  }
  const intervalHours = opts.intervalHours ?? 6;
  const runOnce = async () => {
    const at = new Date().toISOString();
    try {
      const result = await reconcileDashboardsFromGDrive({ dashboardsDir: opts.dashboardsDir });
      dashboardReconcileLastRun = { at, result };
    } catch (error) {
      dashboardReconcileLastRun = {
        at,
        error: error instanceof Error ? error.message : String(error),
      };
      logger.error('[dashboard-reconcile] run failed', error as Record<string, unknown>);
    }
  };
  // Initial run after 90s — staggered vs the channel daemon's 60s first pass.
  setTimeout(() => { void runOnce(); }, 90_000);
  dashboardReconcileTimer = setInterval(() => { void runOnce(); }, intervalHours * 3600 * 1000);
  logger.info(
    `[dashboard-reconcile] daemon started (interval=${intervalHours}h, dir=${opts.dashboardsDir})`
  );
}

export function stopDashboardReconcileDaemon(): void {
  if (dashboardReconcileTimer !== null) {
    clearInterval(dashboardReconcileTimer);
    dashboardReconcileTimer = null;
    logger.info('[dashboard-reconcile] daemon stopped');
  }
}

/**
 * Observability — same contract as getChannelReconcileStatus(): lastRun
 * survives a stop so `running: false` + a last run reads as "was started,
 * then stopped", not "never ran".
 */
export function getDashboardReconcileStatus(): {
  running: boolean;
  lastRun: { at: string; result?: DashboardReconcileResult; error?: string } | null;
} {
  return {
    running: dashboardReconcileTimer !== null,
    lastRun: dashboardReconcileLastRun,
  };
}
