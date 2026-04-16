/**
 * Outil MCP : roosync_get_status
 *
 * Retourne un snapshot ultra-compact de l'état RooSync avec flags actionnables.
 * Un seul appel suffit pour décider des prochaines actions.
 *
 * @module tools/roosync/get-status
 * @version 3.1.0 — #1365 Fix false positives (orphan test entries + stale sync)
 */

import { z } from 'zod';
import { getRooSyncService, RooSyncServiceError } from '../../services/lazy-roosync.js';
import { getMessageManager } from '../../services/MessageManager.js';

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
    .describe('Forcer la réinitialisation du cache du service (défaut: false)')
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

  flags: z.array(z.string())
    .describe('Flags actionnables (ex: HEARTBEAT_STALE:myia-po-2025)'),

  lastUpdated: z.string()
    .describe('Timestamp ISO 8601 du snapshot')
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

    // Dashboard activity (<24h)
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const activeDashboards = dashboard?.lastUpdate
      ? (new Date(dashboard.lastUpdate).getTime() > oneDayAgo ? 1 : 0)
      : 0;

    // #1365: Filter out orphan test entries (test-machine, persistent-machine, etc.)
    // Only keep machines matching the known pattern: myia-*
    const filteredOnlineMachines = (heartbeatState?.onlineMachines ?? []).filter(isKnownMachine);
    const filteredOfflineMachines = (heartbeatState?.offlineMachines ?? []).filter(isKnownMachine);
    const filteredWarningMachines = (heartbeatState?.warningMachines ?? []).filter(isKnownMachine);
    const filteredDashboardMachines = machines.filter(m => isKnownMachine(m.id));

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

    return {
      status,
      machines: {
        online: filteredOnlineMachines.length,
        offline: filteredOfflineMachines.length,
        total: totalMachines
      },
      inbox: inboxStats,
      decisions: { pending: pendingDecisions },
      dashboards: { active: activeDashboards },
      flags,
      lastUpdated: now
    };
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
  description: 'Obtenir un snapshot compact de l\'état RooSync avec flags actionnables. Remplace 4-5 appels séparés.',
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
      }
    },
    additionalProperties: false
  }
};
