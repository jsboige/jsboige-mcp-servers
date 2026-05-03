/**
 * Outil MCP : roosync_get_status
 *
 * Retourne un snapshot ultra-compact de l'état RooSync avec flags actionnables.
 * Un seul appel suffit pour décider des prochaines actions.
 *
 * @module tools/roosync/get-status
 * @version 4.0.0 — #1855 HUD statusline: detail="full" adds active claims & pipeline stages
 */

import { z } from 'zod';
import { getRooSyncService, RooSyncServiceError } from '../../services/lazy-roosync.js';
import { getMessageManager } from '../../services/MessageManager.js';
import { getSharedStatePath } from '../../utils/shared-state-path.js';
import { getToolUsageSnapshot, type ToolUsageSnapshot } from '../../utils/tool-call-metrics.js';
import { join } from 'path';
import { readdirSync, readFileSync, statSync } from 'fs';

/**
 * Check if a machine ID is a real production machine (not a test artifact).
 *
 * Production machines match the pattern: myia-*
 * Test artifacts (test-machine, persistent-machine, machine-2, etc.) are excluded.
 *
 * #1365: Orphan test entries in heartbeat files pollute offline counts.
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
    offline: z.number(),
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

  flags: z.array(z.string())
    .describe('Flags actionnables (ex: HEARTBEAT_STALE:myia-po-2025)'),

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
  heartbeatState: { onlineMachines: string[]; offlineMachines: string[]; warningMachines: string[] },
  inboxStats: { unread: number; urgent: number },
  pendingDecisions: number,
  machines: Array<{ id: string; status: string; lastSync?: string }>
): string[] {
  const flags: string[] = [];

  // Offline machines
  for (const machineId of heartbeatState.offlineMachines) {
    flags.push(`OFFLINE:${machineId}`);
  }

  // Warning machines (heartbeat stale)
  for (const machineId of heartbeatState.warningMachines) {
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

  // Stale syncs (>24h since last sync)
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const m of machines) {
    if (m.lastSync) {
      const syncDate = new Date(m.lastSync).getTime();
      if (!isNaN(syncDate) && syncDate < oneDayAgo && m.status !== 'offline') {
        flags.push(`SYNC_STALE:${m.id}`);
      }
    }
  }

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
    const [dashboard, heartbeatState, inboxStats, pendingDecisions] = await Promise.all([
      service.loadDashboard().catch(() => null),
      (async () => {
        try {
          const heartbeatService = service.getHeartbeatService();
          await heartbeatService.checkHeartbeats();
          return heartbeatService.getState();
        } catch {
          return { onlineMachines: [] as string[], offlineMachines: [] as string[], warningMachines: [] as string[] };
        }
      })(),
      (async () => {
        try {
          const config = service.getConfig();
          const messageManager = getMessageManager();
          const stats = await messageManager.getInboxStats(config.machineId);
          return {
            unread: stats.unread,
            urgent: stats.by_priority?.URGENT ?? 0
          };
        } catch {
          return { unread: 0, urgent: 0 };
        }
      })(),
      service.loadPendingDecisions()
        .then(d => d.length)
        .catch(() => 0)
    ]);

    // Dashboard machines data
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
        }
      }
    } catch {
      // dashboards dir may not exist yet
    }

    // #1365: Filter out orphan test entries (test-machine, persistent-machine, etc.)
    // Only keep machines matching the known pattern: myia-*
    let filteredOnlineMachines = (heartbeatState?.onlineMachines ?? []).filter(isKnownMachine);
    let filteredOfflineMachines = (heartbeatState?.offlineMachines ?? []).filter(isKnownMachine);
    let filteredWarningMachines = (heartbeatState?.warningMachines ?? []).filter(isKnownMachine);
    const filteredDashboardMachines = machines.filter(m => isKnownMachine(m.id));

    // #1953: Cross-check heartbeat-derived status against dashboard activity.
    // Dashboard message timestamps are embedded in file content (immune to GDrive
    // propagation latency on file mod time), preventing false OFFLINE detection.
    let dashboardOverrides: string[] = [];
    try {
      const dashboardsDir = join(getSharedStatePath(), 'dashboards');
      const workspaceDashboard = join(dashboardsDir, 'workspace-roo-extensions.md');
      const dashboardContent = readFileSync(workspaceDashboard, 'utf-8');
      const { crossCheckWithDashboard } = await import('../../utils/dashboard-activity.js');
      const crossChecked = crossCheckWithDashboard(
        { onlineMachines: filteredOnlineMachines, offlineMachines: filteredOfflineMachines, warningMachines: filteredWarningMachines },
        dashboardContent
      );
      filteredOnlineMachines = crossChecked.onlineMachines;
      filteredOfflineMachines = crossChecked.offlineMachines;
      filteredWarningMachines = crossChecked.warningMachines;
      dashboardOverrides = crossChecked.overrides;
    } catch {
      // Dashboard file may not exist yet — skip cross-check silently
    }

    // #1409: Use machine registry as authoritative source for total count
    const registryMachineIds = service.getKnownMachineIds();
    const heartbeatTotal = filteredOnlineMachines.length + filteredOfflineMachines.length;
    const totalMachines = Math.max(
      registryMachineIds.length,
      filteredDashboardMachines.length,
      heartbeatTotal
    );

    // Build flags
    const flags = buildFlags(
      {
        onlineMachines: filteredOnlineMachines,
        offlineMachines: filteredOfflineMachines,
        warningMachines: filteredWarningMachines
      },
      inboxStats,
      pendingDecisions,
      filteredDashboardMachines
    );

    // Derive overall status (based on KNOWN machines only)
    let status: 'HEALTHY' | 'WARNING' | 'CRITICAL' = 'HEALTHY';
    if (filteredOfflineMachines.length > 0 || inboxStats.urgent > 0) {
      status = 'CRITICAL';
    } else if (inboxStats.unread > 5 || filteredWarningMachines.length > 0) {
      // WARNING if: high unread count OR heartbeat warning machines (but no offline)
      status = 'WARNING';
    }

    // Apply machine filter if specified
    if (args.machineFilter) {
      const machineExists = filteredDashboardMachines.some(m => m.id === args.machineFilter) ||
        filteredOnlineMachines.includes(args.machineFilter) ||
        filteredOfflineMachines.includes(args.machineFilter);

      if (!machineExists) {
        throw new RooSyncServiceError(
          `Machine '${args.machineFilter}' non trouvée`,
          'MACHINE_NOT_FOUND'
        );
      }
    }

    const result: any = {
      status,
      machines: {
        online: filteredOnlineMachines.length,
        offline: filteredOfflineMachines.length,
        total: totalMachines,
        ...(dashboardOverrides.length > 0 ? { dashboardOverrides } : {})
      },
      inbox: inboxStats,
      decisions: { pending: pendingDecisions },
      dashboards: { active: activeDashboards },
      flags,
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
          filteredWarningMachines.forEach(mid => {
            if (!onlineAgents.some(a => a.machineId === mid)) {
              onlineAgents.push({ machineId: mid, status: 'warning' });
            }
          });

          hudData = { activeClaims, activeStages, onlineAgents };
        } catch {
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

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const getStatusToolMetadata = {
  name: 'roosync_get_status',
  description: 'Obtenir un snapshot compact de l\'état RooSync avec flags actionnables. Remplace 4-5 appels séparés. #1855: detail="full" ajoute claims actifs et pipeline stages pour HUD statusline.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      machineFilter: {
        type: 'string',
        description: 'ID de machine pour filtrer les résultats (optionnel)'
      },
      resetCache: {
        type: 'boolean',
        description: 'Forcer la réinitialisation du cache du service (défaut: false)'
      },
      detail: {
        type: 'string',
        enum: ['compact', 'full'],
        description: 'Niveau de détail: "compact" (défaut) = status minimal, "full" = ajoute claims actifs et stages pipeline (#1855 HUD)'
      }
    },
    additionalProperties: false
  }
};
