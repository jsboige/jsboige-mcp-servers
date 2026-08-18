/**
 * Outil MCP : roosync_get_status
 *
 * Retourne un snapshot ultra-compact de l'état RooSync avec flags actionnables.
 * Un seul appel suffit pour décider des prochaines actions.
 *
 * #2318: Machine presence is now purely dashboard-derived. HeartbeatService
 * provides ONLY self-activity (local process) and scheduler metrics (#1442).
 * Cross-machine presence comes exclusively from dashboard message timestamps
 * via crossCheckWithDashboard() — immune to GDrive propagation latency.
 *
 * @module tools/roosync/get-status
 * @version 5.0.0 — #2318: dashboard-only presence, no heartbeat blind seed
 * @see #2318, ADR 008 Phase 4
 */

import { z } from 'zod';
import { getRooSyncService, RooSyncServiceError } from '../../services/lazy-roosync.js';
import { getMessageManager } from '../../services/MessageManager.js';
import { getSharedStatePath } from '../../utils/shared-state-path.js';
import { getToolUsageSnapshot, type ToolUsageSnapshot } from '../../utils/tool-call-metrics.js';
import { join } from 'path';
import { readdirSync, readFileSync, statSync } from 'fs';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('GetStatus');

/**
 * Check if a machine ID is a real production machine (not a test artifact).
 *
 * Production machines match the pattern: myia-*
 * Test artifacts (test-machine, persistent-machine, machine-2, etc.) are excluded.
 *
 * #1365: Orphan test entries in heartbeat files pollute unknown counts.
 */
function isKnownMachine(machineId: string): boolean {
	return machineId.toLowerCase().startsWith('myia-');
}

/**
 * Schema de validation pour roosync_get_status
 */
export const GetStatusArgsSchema = z.object({
  machineFilter: z.string().optional()
    .describe('ID de machine pour filtrer les résultats (optionnel)'),
  resetCache: z.boolean().optional()
    .describe('Forcer la réinitialisation du cache du service (défaut: false)'),
  detail: z.enum(['compact', 'full']).optional()
    .describe('Niveau de détail: "compact" (défaut) = status minimal, "full" = ajoute claims actifs et stages pipeline (#1855 HUD)'),
  includeDetails: z.boolean().optional()
    .describe('Inclure les statistiques détaillées (tool usage, etc.). Défaut: false')
});

export type GetStatusArgs = z.infer<typeof GetStatusArgsSchema>;

/**
 * Schema de retour — Option B: compact status with flags
 */
export const GetStatusResultSchema = z.object({
  status: z.enum(['HEALTHY', 'WARNING', 'CRITICAL'])
    .describe('État global du système RooSync'),

  machines: z.object({
    online: z.number(),
    unknown: z.number(),
    total: z.number()
  }).describe('Compteurs machines par état'),

  inbox: z.object({
    unread: z.number(),
    urgent: z.number()
  }).describe('Messages non-lus et urgents'),

  decisions: z.object({
    pending: z.number()
  }).describe('Décisions en attente'),

  dashboards: z.object({
    active: z.number()
  }).describe('Dashboards avec activité récente (<24h)'),

  toolUsage: z.object({
    sessionStartAt: z.string(),
    totalCalls: z.number(),
    uniqueTools: z.number(),
    topTools: z.array(z.object({
      name: z.string(),
      count: z.number(),
      avgMs: z.number(),
      lastCallAt: z.string()
    })),
    bottomTools: z.array(z.object({
      name: z.string(),
      count: z.number(),
      avgMs: z.number(),
      lastCallAt: z.string()
    })),
    errorTools: z.array(z.object({
      name: z.string(),
      errorCount: z.number()
    }))
  }).describe('Per-tool usage stats for current session').optional(),

  // #1442: Scheduler execution metrics per machine
  schedulerMetrics: z.record(z.object({
    totalRuns: z.number(),
    successCount: z.number(),
    failureCount: z.number(),
    lastRunAt: z.string().optional(),
    lastRunDurationMs: z.number().optional(),
    lastRunStatus: z.enum(['success', 'failure']).optional(),
    lastError: z.string().optional()
  })).describe('Per-machine scheduler execution metrics (#1442)').optional(),

  flags: z.array(z.string())
    .describe('Flags actionnables (ex: HEARTBEAT_STALE:myia-po-2025)'),

  // #3160: provenance for presence flags. An UNKNOWN:<mid> flag means "this
  // observer's dashboards show no append from <mid> within 8h" — which can be a
  // real outage OR a stale GDrive mirror on the observing side. The last-seen
  // timestamp (and `null` = never seen by this observer) lets the receiver tell
  // the two apart without a round-trip diagnostic.
  machineLastSeen: z.record(z.string().nullable())
    .describe('Dernier append dashboard vu par CET observateur, par machine (null = jamais vu). Base de preuve des flags UNKNOWN:* / HEARTBEAT_STALE:* (#3160)')
    .optional(),

  lastUpdated: z.string()
    .describe('Timestamp ISO 8601 du snapshot'),

  // #1855 HUD statusline: extended data when detail="full"
  hud: z.object({
    activeClaims: z.array(z.object({
      machineId: z.string(),
      issue: z.string(),
      content: z.string(),
      timestamp: z.string()
    })).describe('Claims actifs (<2h) parsés depuis le dashboard intercom'),

    activeStages: z.array(z.object({
      machineId: z.string(),
      stage: z.string(),
      content: z.string(),
      timestamp: z.string()
    })).describe('Stages pipeline actifs parsés depuis le dashboard intercom'),

    onlineAgents: z.array(z.object({
      machineId: z.string(),
      status: z.string()
    })).describe('Machines online avec statut détaillé')
  }).optional().describe('Données étendues pour HUD statusline (uniquement si detail="full")')
});

export type GetStatusResult = z.infer<typeof GetStatusResultSchema>;

/**
 * Génère les flags actionnables à partir des données collectées
 */
function buildFlags(
  heartbeatState: { onlineMachines: string[]; unknownMachines: string[]; idleMachines: string[] },
  inboxStats: { unread: number; urgent: number },
  pendingDecisions: number
): string[] {
  const flags: string[] = [];

  // Unknown machines (ADR 008 terminology)
  for (const machineId of heartbeatState.unknownMachines) {
    flags.push(`UNKNOWN:${machineId}`);
  }

  // Idle machines (ADR 008 terminology)
  for (const machineId of heartbeatState.idleMachines) {
    flags.push(`HEARTBEAT_STALE:${machineId}`);
  }

  // Inbox overflow (>10 unread)
  if (inboxStats.unread > 10) {
    flags.push(`INBOX_OVERFLOW:${inboxStats.unread}_unread`);
  }

  // Urgent messages
  if (inboxStats.urgent > 0) {
    flags.push(`INBOX_URGENT:${inboxStats.urgent}`);
  }

  // Pending decisions
  if (pendingDecisions > 0) {
    flags.push(`DECISIONS_PENDING:${pendingDecisions}`);
  }

  // NOTE: no SYNC_STALE here. It used to be derived from `lastSync`, which is
  // only ever written by BaselineManager / roosync_init — baseline operations, not
  // coordination. Under RooSync v2.3 nothing refreshes it, so every machine's value
  // was 5-8 months old and the flag fired on 6/6 machines permanently. The
  // `status !== 'unknown'` guard even restricted it to the machines that were
  // actually online, inverting its usefulness. A flag that is always on is worse
  // than no flag: it trains readers to skip the whole `flags` array, including
  // HEARTBEAT_STALE / INBOX_URGENT / DECISIONS_PENDING, which are live-fed.
  // The useful SYNC_STALE lives in health-view.ts, keyed on real dashboard activity.

  return flags;
}

/**
 * #1855 HUD: Parse workspace dashboard intercom for active claims and pipeline stages.
 * Returns messages from the last 2 hours that contain HUD-relevant tags.
 */
export function parseHudDataFromDashboard(
  dashboardContent: string
): { activeClaims: Array<{ machineId: string; issue: string; content: string; timestamp: string }>; activeStages: Array<{ machineId: string; stage: string; content: string; timestamp: string }> } {
  const activeClaims: Array<{ machineId: string; issue: string; content: string; timestamp: string }> = [];
  const activeStages: Array<{ machineId: string; stage: string; content: string; timestamp: string }> = [];
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

  const stagePattern = /\[(PLAN|PRD|EXEC|VERIFY|FIX|BLOCKED)\]/g;
  const claimPattern = /\[CLAIMED\]/;

  // Extract intercom section
  const intercomMatch = dashboardContent.match(/## Intercom\s*\n([\s\S]+)/);
  if (!intercomMatch) return { activeClaims, activeStages };

  const intercomMarkdown = intercomMatch[1];
  if (intercomMarkdown.includes('*Aucun message.*')) return { activeClaims, activeStages };

  const messageBlocks = intercomMarkdown.split(/(?=^### \[)/m).filter(b => b.trim());
  for (const rawBlock of messageBlocks) {
    const block = rawBlock.replace(/\n---\s*$/, '').trim();
    const headerMatch = block.match(/### \[([^\]]+)\]\s+([^|]+)\|([^|\s]+)/);
    if (!headerMatch) continue;

    const [, timestamp, machineId, workspace] = headerMatch;
    const ts = new Date(timestamp).getTime();
    if (isNaN(ts) || ts < twoHoursAgo) continue;

    const mid = machineId.trim();
    const content = block.replace(/### \[[^\]]+\]\s+[^|]+\|[^|\s]+.*\n/, '').trim();

    // Check for CLAIMED tag
    if (claimPattern.test(content)) {
      const issueMatch = content.match(/#(\d+)/);
      const issue = issueMatch ? `#${issueMatch[1]}` : 'unknown';
      activeClaims.push({ machineId: mid, issue, content: content.substring(0, 200), timestamp });
    }

    // Check for pipeline stage tags
    let match;
    stagePattern.lastIndex = 0;
    while ((match = stagePattern.exec(content)) !== null) {
      activeStages.push({ machineId: mid, stage: match[1], content: content.substring(0, 200), timestamp });
    }
  }

  return { activeClaims, activeStages };
}

/**
 * Outil roosync_get_status
 *
 * Retourne un snapshot compact avec flags actionnables.
 * Un seul appel remplace les 4-5 appels précédents.
 *
 * @param args Arguments validés
 * @returns État compact du système RooSync
 * @throws {RooSyncServiceError} En cas d'erreur
 */
export async function roosyncGetStatus(args: GetStatusArgs): Promise<GetStatusResult> {
  try {
    // Reset cache si demandé
    if (args.resetCache) {
      const { RooSyncService } = await import('../../services/RooSyncService.js');
      await RooSyncService.resetInstance();
    }

    const service = await getRooSyncService();
    const now = new Date().toISOString();

    // Collecte parallèle des données
    // #2318: HeartbeatService is no longer used for cross-machine presence.
    // Machine lists are derived purely from dashboard message timestamps.
    const [dashboard, inboxStats, pendingDecisions] = await Promise.all([
      service.loadDashboard().catch(() => null),
      (async () => {
        try {
          const config = service.getConfig();
          const messageManager = getMessageManager();
          const stats = await messageManager.getInboxStats(config.machineId);
          return {
            unread: stats.unread,
            urgent: stats.by_priority?.URGENT ?? 0
          };
        } catch (err) {
          logger.warn('Inbox stats failed', { error: String(err) });
          return { unread: 0, urgent: 0 };
        }
      })(),
      service.loadPendingDecisions()
        .then(d => d.length)
        .catch(() => 0)
    ]);

    // Dashboard machines data (legacy format, used for total count and flags)
    const machines = dashboard?.machinesArray ||
      (dashboard?.machines
        ? Object.entries(dashboard.machines).map(([id, info]) => ({
            id,
            status: info.status,
            lastSync: info.lastSync
          }))
        : []);

    // Dashboard activity (<24h) — count actual intercom dashboard files (#1409 fix)
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    let activeDashboards = 0;
    const dashboardContents: string[] = [];
    try {
      const dashboardsDir = join(getSharedStatePath(), 'dashboards');
      const files = readdirSync(dashboardsDir);
      for (const file of files) {
        if (file.endsWith('.md') && !file.endsWith('.tmp')) {
          const filePath = join(dashboardsDir, file);
          const stat = statSync(filePath);
          if (stat.mtimeMs > oneDayAgo) {
            activeDashboards++;
          }
          try {
            dashboardContents.push(readFileSync(filePath, 'utf-8'));
          } catch (err) {
            logger.debug(`Dashboard ${file} unreadable`, { error: String(err) });
          }
        }
      }
    } catch (err) {
      logger.debug('Dashboards dir not accessible', { error: String(err) });
    }

    // #2318: Machine presence is now PURELY dashboard-derived.
    // Extract activity from ALL dashboard contents, then classify machines.
    // No heartbeat blind seed — dashboard timestamps are the sole source of truth.
    let filteredOnlineMachines: string[] = [];
    let filteredUnknownMachines: string[] = [];
    let filteredIdleMachines: string[] = [];
    let dashboardOverrides: string[] = [];
    // #3160: last dashboard append seen per machine, from THIS observer's GDrive mirror.
    const machineLastSeen: Record<string, string | null> = {};

    try {
      const { extractMachineActivity, isRecentlyActive } = await import('../../utils/dashboard-activity.js');
      const activity = extractMachineActivity(dashboardContents);

      // Classify machines based purely on dashboard activity
      for (const [machineId, lastSeen] of activity.entries()) {
        if (!isKnownMachine(machineId)) continue;
        if (isRecentlyActive(lastSeen)) {
          filteredOnlineMachines.push(machineId);
        }
        // Machines with no activity in threshold are not added to any list
        // (they simply don't appear — no false "unknown" from heartbeat blind spots)
      }

      // Known machine IDs from registry that weren't seen on any dashboard
      const registryMachineIds = service.getKnownMachineIds().filter(isKnownMachine);
      const seenSet = new Set(filteredOnlineMachines.map(m => m.toLowerCase()));
      for (const mid of registryMachineIds) {
        if (!seenSet.has(mid.toLowerCase())) {
          filteredUnknownMachines.push(mid);
        }
      }

      // #3160: presence provenance — lastSeen per machine as THIS observer sees it.
      // Registry machines absent from the activity map get null ("never seen here"),
      // the strongest mirror-staleness tell.
      for (const mid of registryMachineIds) {
        machineLastSeen[mid] = activity.get(mid.toLowerCase()) ?? null;
      }
      for (const [mid, lastSeen] of activity.entries()) {
        if (isKnownMachine(mid) && !(mid in machineLastSeen)) {
          machineLastSeen[mid] = lastSeen;
        }
      }
    } catch (err) {
      logger.debug('Dashboard activity extraction skipped', { error: String(err) });
      // Fallback: use registry machines as unknown if dashboard parsing fails
      const registryMachineIds = service.getKnownMachineIds().filter(isKnownMachine);
      filteredUnknownMachines = registryMachineIds;
      for (const mid of registryMachineIds) {
        machineLastSeen[mid] = null;
      }
    }

    const filteredDashboardMachines = machines.filter(m => isKnownMachine(m.id));

    // #2318: Total machines = known registry count (authoritative source)
    const totalMachines = Math.max(
      service.getKnownMachineIds().filter(isKnownMachine).length,
      filteredDashboardMachines.length
    );

    // Build flags
    const flags = buildFlags(
      {
        onlineMachines: filteredOnlineMachines,
        unknownMachines: filteredUnknownMachines,
        idleMachines: filteredIdleMachines
      },
      inboxStats,
      pendingDecisions
    );

    // Derive overall status (based on KNOWN machines only)
    let status: 'HEALTHY' | 'WARNING' | 'CRITICAL' = 'HEALTHY';
    if (filteredUnknownMachines.length > 0 || inboxStats.urgent > 0) {
      status = 'CRITICAL';
    } else if (inboxStats.unread > 5 || filteredIdleMachines.length > 0) {
      // WARNING if: high unread count OR heartbeat idle machines (but no unknown)
      status = 'WARNING';
    }

    // Apply machine filter if specified
    if (args.machineFilter) {
      const machineExists = filteredDashboardMachines.some(m => m.id === args.machineFilter) ||
        filteredOnlineMachines.includes(args.machineFilter) ||
        filteredUnknownMachines.includes(args.machineFilter);

      if (!machineExists) {
        throw new RooSyncServiceError(
          `Machine '${args.machineFilter}' non trouvée`,
          'MACHINE_NOT_FOUND'
        );
      }
    }

    // #1442: Collect scheduler metrics from heartbeat service
    const schedulerMetrics: Record<string, any> = {};
    try {
      const heartbeatService = service.getHeartbeatService();
      const allMetrics = heartbeatService.getAllSchedulerMetrics();
      for (const [mid, metrics] of allMetrics.entries()) {
        if (isKnownMachine(mid)) {
          schedulerMetrics[mid] = metrics;
        }
      }
    } catch (err) {
      logger.debug('Scheduler metrics collection skipped', { error: String(err) });
    }

    const result: any = {
      status,
      machines: {
        online: filteredOnlineMachines.length,
        unknown: filteredUnknownMachines.length,
        total: totalMachines,
        ...(dashboardOverrides.length > 0 ? { dashboardOverrides } : {})
      },
      inbox: inboxStats,
      decisions: { pending: pendingDecisions },
      dashboards: { active: activeDashboards },
      ...(Object.keys(schedulerMetrics).length > 0 ? { schedulerMetrics } : {}),
      flags,
      // #3160: only meaningful when flags carry presence data — omit when nothing was classified
      ...(Object.keys(machineLastSeen).length > 0 ? { machineLastSeen } : {}),
      lastUpdated: now,
      // #1855 HUD: extended data when detail="full"
      ...(args.detail === 'full' ? await (async () => {
        let hudData: NonNullable<GetStatusResult['hud']> | undefined;
        try {
          const dashboardsDir = join(getSharedStatePath(), 'dashboards');
          const workspaceDashboard = join(dashboardsDir, 'workspace-roo-extensions.md');
          const content = readFileSync(workspaceDashboard, 'utf-8');
          const { activeClaims, activeStages } = parseHudDataFromDashboard(content);

          const onlineAgents = filteredOnlineMachines.map(mid => ({
            machineId: mid,
            status: 'online'
          }));
          filteredIdleMachines.forEach((mid: string) => {
            if (!onlineAgents.some(a => a.machineId === mid)) {
              onlineAgents.push({ machineId: mid, status: 'idle' });
            }
          });

          hudData = { activeClaims, activeStages, onlineAgents };
        } catch (err) {
          logger.debug('HUD data unavailable', { error: String(err) });
          hudData = undefined;
        }
        return { hud: hudData };
      })() : {})
    };

    if (args.includeDetails) {
      result.toolUsage = getToolUsageSnapshot();
    }

    return result;
  } catch (error) {
    if (error instanceof RooSyncServiceError) {
      throw error;
    }

    throw new RooSyncServiceError(
      `Erreur lors de la récupération du statut: ${(error as Error).message}`,
      'ROOSYNC_UNKNOWN_ERROR'
    );
  }
}
