/**
 * Outil MCP : roosync_inventory
 *
 * Récupération de l'inventaire machine et/ou de l'état heartbeat.
 *
 * IMPORTANT: Les types "heartbeat" et "all" retournent des données heartbeat
 * IN-MEMORY qui ne reflètent QUE l'activité du processus MCP local.
 * Ils NE DOIVENT PAS être interprétés comme une vérité cross-machine.
 * Le type "machines" est dashboard-dérivé (présence flotte, #2766).
 * Pour un snapshot cross-machine complet, utiliser type="status".
 *
 * @module tools/roosync/inventory
 * @version 4.2.0 (#2766: type="machines" routed to dashboard-derived presence — was stuck on deprecated local-self heartbeat getters, permanently empty)
 * @see #2318, ADR 008 Phase 4, #4004, #2766
 */

import * as os from 'os';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { UnifiedToolContract, ToolCategory, ProcessingLevel, ToolResult } from '../../interfaces/UnifiedToolInterface.js';
import { InventoryService } from '../../services/roosync/InventoryService.js';
import { getRooSyncService } from '../../services/lazy-roosync.js';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';
import { getSharedStatePath } from '../../utils/shared-state-path.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('Inventory');

/**
 * Schema de validation pour roosync_inventory
 */
export const InventoryArgsSchema = z.object({
  type: z.enum(['machine', 'heartbeat', 'all', 'machines', 'status', 'health'])
    .describe('Type d\'inventaire à récupérer. "machines" = fleet machine listing, dashboard-derived presence (#2318/#2766): online + unknown classified from dashboard message timestamps (8h threshold). "status" = compact system snapshot. "health" = unified cluster health view with score (#2224)'),
  machineId: z.string().optional()
    .describe('Identifiant optionnel de la machine (défaut: hostname)'),
  includeHeartbeats: z.boolean().optional()
    .describe('Inclure les données de heartbeat de chaque machine (défaut: true)'),
  // Pour type="machines" (fused from roosync_machines)
  status: z.enum(['unknown', 'idle', 'all']).optional()
    .describe('Filter for type="machines": gates the unknown list ("unknown") — idle is vestigial and always empty (dashboard presence has no idle concept, #2318); onlineMachines is always returned'),
  includeDetails: z.boolean().optional()
    .describe('Inclure les détails complets des machines (type="machines") ou stats outil (type="status")'),
  summary: z.boolean().optional()
    .describe('Retourner un résumé compact (markdown) au lieu du JSON complet (défaut: false)'),
  // #1935 Cluster E: fused from roosync_get_status
  detail: z.enum(['compact', 'full']).optional()
    .describe('Niveau de détail pour type="status". "full" ajoute claims + pipeline stages'),
  resetCache: z.boolean().optional()
    .describe('Forcer la réinitialisation du cache (type="status" uniquement — ignoré ailleurs avec un warning #4004)'),
  // #4004: opt-out of the local-inventory TTL cache
  forceRefresh: z.boolean().optional()
    .describe('Re-collecte fraîche de l\'inventaire LOCAL (type="machine"/"all") — ignore le cache TTL 30 s (#4004)'),
  // #2224: health view params (fused from roosync_health_view standalone)
  format: z.enum(['json', 'markdown']).optional()
    .describe('Output format for type="health". Default: json'),
  includeEnvCheck: z.boolean().optional()
    .describe('Include env var checks in type="health". Default: true'),
  // #1161: explicit drift target — the implicit default is a seat-relative
  // peer-to-peer diff (first registry machine ≠ source).
  driftTarget: z.string().optional()
    .describe('Explicit drift comparison target for type="health". Default (#1161): first registry machine ≠ machineId — a peer-to-peer diff, NOT a fleet baseline')
});

export type InventoryArgs = z.infer<typeof InventoryArgsSchema>;

/**
 * #4004: TTL cache for the LOCAL machine inventory, at the TOOL layer.
 *
 * The service (`InventoryService.getMachineInventory`) always collects fresh and
 * writes the result to `.shared-state/inventories/` — correct for internal
 * callers (compare_config, drift detection) but a GDrive write storm when an
 * agent loops `type="machine"`/`"all"`: every tick re-collected and re-wrote.
 * The cache sits here, not in the service, so internal consumers keep always-
 * fresh data. Remote machineIds bypass it (a GDrive read, no write, and
 * freshness matters for drift checks).
 */
const LOCAL_INVENTORY_TTL_MS = 30_000;
let localInventoryCache: { inventory: any; at: number } | null = null;

/** Same locality rule as InventoryService.getMachineInventory (case-insensitive). */
function isLocalMachine(machineId: string | undefined): boolean {
  if (!machineId) return true;
  return machineId.toLowerCase() === os.hostname().toLowerCase();
}

/** Test-only: forget the TTL cache so suites exercise the collect path. */
export function resetLocalInventoryCacheForTest(): void {
  localInventoryCache = null;
}

/**
 * Données de heartbeat d'une machine
 */
export const HeartbeatDataSchema = z.object({
  machineId: z.string()
    .describe('Identifiant de la machine'),
  lastHeartbeat: z.string()
    .describe('Timestamp du dernier heartbeat (ISO 8601)'),
  status: z.enum(['online', 'idle', 'unknown'])
    .describe('Statut de la machine'),
  lifecycleState: z.enum(['BOOTSTRAPPING', 'READY', 'CLAIMED', 'WORKING', 'REPORTING', 'IDLE', 'ERROR', 'RECOVERING'])
    .optional()
    .describe('Agent lifecycle state (#1320). BOOTSTRAPPING→READY→CLAIMED→WORKING→REPORTING→IDLE, any→ERROR→RECOVERING→READY'),
  metadata: z.object({
    firstSeen: z.string()
      .describe('Timestamp de première détection (ISO 8601)'),
    lastUpdated: z.string()
      .describe('Timestamp de dernière mise à jour (ISO 8601)'),
    lifecycleSince: z.string().optional()
      .describe('Timestamp since current lifecycle state (ISO 8601)'),
    lifecycleReason: z.string().optional()
      .describe('Reason for last lifecycle transition'),
  })
});

export type HeartbeatData = z.infer<typeof HeartbeatDataSchema>;

/**
 * Statistiques du service de heartbeat
 */
export const HeartbeatStatisticsSchema = z.object({
  totalMachines: z.number()
    .describe('Nombre total de machines'),
  onlineCount: z.number()
    .describe('Nombre de machines online'),
  idleCount: z.number()
    .describe('Nombre de machines idle'),
  unknownCount: z.number()
    .describe('Nombre de machines unknown'),
  lastHeartbeatCheck: z.string()
    .describe('Timestamp de la dernière vérification (ISO 8601)')
});

export type HeartbeatStatistics = z.infer<typeof HeartbeatStatisticsSchema>;

/**
 * Schema de retour pour roosync_inventory
 */
export const InventoryResultSchema = z.object({
  success: z.boolean()
    .describe('Indique si la récupération a réussi'),
  machineInventory: z.any().optional()
    .describe('Inventaire machine (si type=machine ou type=all)'),
  heartbeatState: z.object({
    onlineMachines: z.array(z.string())
      .describe('Liste des IDs des machines online'),
    unknownMachines: z.array(z.string())
      .describe('Liste des IDs des machines unknown'),
    idleMachines: z.array(z.string())
      .describe('Liste des IDs des machines idle'),
    statistics: HeartbeatStatisticsSchema
      .describe('Statistiques du service'),
    heartbeats: z.record(HeartbeatDataSchema).optional()
      .describe('Données de heartbeat par machine (si includeHeartbeats=true)'),
    retrievedAt: z.string()
      .describe('Timestamp de la récupération (ISO 8601)')
  }).optional()
    .describe('État heartbeat (si type=heartbeat ou type=all)'),
  retrievedAt: z.string()
    .describe('Timestamp de la récupération (ISO 8601)')
});

export type InventoryResult = z.infer<typeof InventoryResultSchema>;

/**
 * Outil roosync_inventory
 *
 * Récupération de l'inventaire machine et/ou de l'état heartbeat.
 *
 * @param args Arguments validés
 * @returns Inventaire et/ou état heartbeat
 * @throws {HeartbeatServiceError} En cas d'erreur
 */
export const inventoryTool: UnifiedToolContract = {
  name: 'roosync_inventory',
  description: 'Récupération de l\'inventaire machine, état heartbeat, ou snapshot système.',
  category: ToolCategory.UTILITY,
  processingLevel: ProcessingLevel.IMMEDIATE,
  version: '4.2.0',
  inputSchema: InventoryArgsSchema,
  execute: async (input: z.infer<typeof InventoryArgsSchema>, context: any): Promise<ToolResult<any>> => {
    const startTime = Date.now();
    try {
      const { type, machineId, includeHeartbeats = true, summary = false } = input;
      const retrievedAt = new Date().toISOString();

      // #4004: resetCache is honored ONLY by type="status" (below). Everywhere
      // else it was silently ignored — surface it instead of swallowing it.
      // (Only resetCache=true: an explicit false is a no-op, not a mistake.)
      const resetCacheWarnings =
        input.resetCache === true && type !== 'status'
          ? [`resetCache=true ignoré pour type="${type}" — ce flag n'est honoré que pour type="status"`]
          : undefined;

      // #1935 Cluster E: type="status" — fused from roosync_get_status
      if (type === 'status') {
        const { roosyncGetStatus, GetStatusArgsSchema } = await import('./get-status.js');
        const statusArgs = GetStatusArgsSchema.parse({
          machineFilter: machineId,
          resetCache: input.resetCache,
          detail: input.detail,
          includeDetails: input.includeDetails,
        });
        const statusResult = await roosyncGetStatus(statusArgs);
        return {
          success: true,
          data: statusResult,
          metrics: {
            executionTime: Date.now() - startTime,
            processingLevel: ProcessingLevel.IMMEDIATE
          }
        };
      }

      // #2224: type="health" — fused from roosync_health_view standalone (pattern #512 arbitrage A)
      if (type === 'health') {
        const { roosyncHealthView, formatMarkdown } = await import('./health-view.js');
        const healthResult = await roosyncHealthView({
          machineId,
          driftTarget: input.driftTarget,
          includeEnvCheck: input.includeEnvCheck,
          format: input.format,
        });
        // If markdown format requested, format and return as text
        if (input.format === 'markdown') {
          return {
            success: true,
            data: {
              markdownContent: formatMarkdown(healthResult),
              retrievedAt,
              ...(resetCacheWarnings ? { warnings: resetCacheWarnings } : {})
            },
            metrics: {
              executionTime: Date.now() - startTime,
              processingLevel: ProcessingLevel.IMMEDIATE
            }
          };
        }
        return {
          success: true,
          data: resetCacheWarnings ? { ...healthResult, warnings: resetCacheWarnings } : healthResult,
          metrics: {
            executionTime: Date.now() - startTime,
            processingLevel: ProcessingLevel.IMMEDIATE
          }
        };
      }

      const result: any = {
        success: true,
        retrievedAt,
        ...(resetCacheWarnings ? { warnings: resetCacheWarnings } : {})
      };

      // Collect data
      let machineInventory: any = null;
      let heartbeatState: any = null;
      let machinesData: any = null;

      // Récupérer l'inventaire machine si demandé
      if (type === 'machine' || type === 'all') {
        const inventoryService = InventoryService.getInstance();
        // #4004: serve the LOCAL inventory from the TTL cache when fresh — a
        // looping agent must not re-collect + rewrite GDrive on every tick.
        const local = isLocalMachine(machineId);
        if (
          local && !input.forceRefresh && localInventoryCache !== null &&
          Date.now() - localInventoryCache.at < LOCAL_INVENTORY_TTL_MS
        ) {
          machineInventory = localInventoryCache.inventory;
        } else {
          machineInventory = await inventoryService.getMachineInventory(machineId);
          if (local) {
            localInventoryCache = { inventory: machineInventory, at: Date.now() };
          }
        }
        if (!summary) {
          result.machineInventory = machineInventory;
        }
      }

      // Récupérer l'état heartbeat si demandé
      // #2318: These data are LOCAL-SELF ONLY. Each MCP process tracks only its own
      // tool calls. Other machines appear as UNKNOWN regardless of their actual activity.
      // Use type="status" for reliable cross-machine presence.
      if (type === 'heartbeat' || type === 'all') {
        const rooSyncService = await getRooSyncService();
        const heartbeatService = rooSyncService.getHeartbeatService();
        const state = heartbeatService.getState();

        heartbeatState = {
          onlineMachines: state.onlineMachines,
          unknownMachines: state.unknownMachines,
          idleMachines: state.idleMachines,
          statistics: state.statistics,
          heartbeats: includeHeartbeats ? Object.fromEntries(state.heartbeats) : undefined,
          crossMachineWarning: 'Heartbeat data reflects LOCAL process activity only. Other machines appear as UNKNOWN regardless of their actual state. Use type="status" for reliable cross-machine presence. (#2318)',
          retrievedAt
        };
        if (!summary) {
          result.heartbeatState = heartbeatState;
        }
      }

      // [FUSION A2 #1863] type="machines" — fused from roosync_machines
      // #2766 (audit finding, po-2026 05/10 + po-2024 06/10): this listing was
      // still built from the deprecated local-self HeartbeatService getters
      // (#2318) and returned permanently EMPTY lists on a healthy seat — the
      // fusion was never migrated to dashboard-derived presence. #2318 v5.0.0
      // made dashboard message timestamps the sole cross-machine truth for
      // type="status"; this type now uses the same source (reference
      // implementation: get-status.ts, utils/dashboard-activity.ts).
      if (type === 'machines') {
        const service = await getRooSyncService();
        const machinesStatus = input.status || 'all';
        const wantDetails = input.includeDetails || false;
        const isKnownMachine = (mid: string) => mid.toLowerCase().startsWith('myia-');
        const registryMachineIds = service.getKnownMachineIds().filter(isKnownMachine);

        let online: string[] = [];
        let unknown: string[] = [];
        const machineLastSeen: Record<string, string | null> = {};

        try {
          const dashboardsDir = join(getSharedStatePath(), 'dashboards');
          const dashboardContents: string[] = [];
          for (const file of readdirSync(dashboardsDir)) {
            if (file.endsWith('.md') && !file.endsWith('.tmp')) {
              try {
                dashboardContents.push(readFileSync(join(dashboardsDir, file), 'utf-8'));
              } catch {
                logger.debug(`Dashboard ${file} unreadable — skipped`);
              }
            }
          }

          const { extractMachineActivity, isRecentlyActive, lookupMachineActivityInArchives } =
            await import('../../utils/dashboard-activity.js');
          const activity = extractMachineActivity(dashboardContents);

          // #3695: machines archived out of the live files by auto-condensation
          // vanish from the activity map — recover their lastSeen lazily from
          // archives (same as get-status).
          const missingFromCurrent = registryMachineIds.filter(mid => !activity.has(mid.toLowerCase()));
          if (missingFromCurrent.length > 0) {
            for (const [mid, ts] of lookupMachineActivityInArchives(dashboardsDir, missingFromCurrent)) {
              const existing = activity.get(mid);
              if (!existing || ts > existing) activity.set(mid, ts);
            }
          }

          // Classify: registry machines with recent dashboard activity are
          // online; the rest are unknown (absence of signal, not a confirmed
          // outage — same semantics as the UNKNOWN:<mid> flags, #3160).
          const seen = new Set<string>();
          for (const mid of registryMachineIds) {
            const lastSeen = activity.get(mid.toLowerCase()) ?? null;
            machineLastSeen[mid] = lastSeen;
            if (lastSeen !== null && isRecentlyActive(lastSeen)) {
              online.push(mid);
              seen.add(mid.toLowerCase());
            }
          }
          unknown = registryMachineIds.filter(mid => !seen.has(mid.toLowerCase()));
        } catch (err) {
          // Dashboard presence unavailable (no mirror yet, GDrive offline) —
          // registry machines are honestly reported as unknown, lastSeen null.
          unknown = registryMachineIds;
          for (const mid of registryMachineIds) machineLastSeen[mid] = null;
        }

        const withLastSeen = (ids: string[]): string[] | { machineId: string; lastSeen: string | null }[] =>
          wantDetails ? ids.map(mid => ({ machineId: mid, lastSeen: machineLastSeen[mid] ?? null })) : ids;

        machinesData = {
          // onlineMachines is always returned (new field — the most useful
          // list; gating it behind status="all" would hide it from callers
          // that filtered on "unknown" out of old habit).
          onlineMachines: withLastSeen(online),
          onlineCount: online.length,
          unknownMachines: withLastSeen(machinesStatus === 'unknown' || machinesStatus === 'all' ? unknown : []),
          unknownCount: unknown.length,
          // Vestigial shape compat: dashboard-derived presence has no idle
          // concept (#2318) — the field stays, always empty.
          idleMachines: [] as string[],
          idleCount: 0,
          machineLastSeen,
          retrievedAt
        };
        if (!summary) {
          Object.assign(result, machinesData);
          result.crossMachineWarning = 'Machine presence is dashboard-derived (message timestamps, 8h threshold, this observer\'s GDrive mirror). unknown = absence of signal, NOT a confirmed outage. idle* fields are vestigial (#2318) — always empty. For the full system snapshot use type="status".';
        }
      }
      if (summary) {
        const lines: string[] = [`**Inventory Summary** (${retrievedAt})`, ''];

        if (machineInventory) {
          // #2766: payload is machineInventory.inventory.{systemInfo,mcpServers,rooModes}
          // (InventoryService shape, confirmed via DiffDetector/InventoryCollectorWrapper).
          // Reading one level too high (machineInventory.*) left every field undefined.
          const inv = (machineInventory as any).inventory as any;
          lines.push(`**Machine:** ${inv?.systemInfo?.hostname || machineId || 'unknown'}`);
          lines.push(`- OS: ${inv?.systemInfo?.os || 'N/A'}`);
          const mcpCount = Array.isArray(inv?.mcpServers) ? inv.mcpServers.length : 0;
          lines.push(`- MCPs: ${mcpCount} servers`);
          // rooModes is an array (InventoryCollectorWrapper maps over it), not an object
          // with a .modes property — the old inv.rooModes?.modes always rendered 0.
          const modes = Array.isArray(inv?.rooModes) ? inv.rooModes.length : 0;
          lines.push(`- Roo modes: ${modes}`);
          lines.push('');
        }

        if (heartbeatState) {
          const hs = heartbeatState;
          lines.push(`**Cluster status (LOCAL-SELF only):** ${hs.statistics.totalMachines} machines`);
          lines.push(`⚠️ Heartbeat data is local-process only — use type="status" for cross-machine.`);
          lines.push(`- Online (${hs.onlineMachines.length}): ${hs.onlineMachines.join(', ') || 'none'}`);
          lines.push(`- Unknown (${hs.unknownMachines.length}): ${hs.unknownMachines.join(', ') || 'none'}`);
          lines.push(`- Idle (${hs.idleMachines.length}): ${hs.idleMachines.join(', ') || 'none'}`);
          lines.push('');
        }

        if (machinesData) {
          lines.push(`**Machines (dashboard-derived):** online=${machinesData.onlineCount}, unknown=${machinesData.unknownCount}`);
          lines.push('');
        }

        if (resetCacheWarnings) {
          lines.push(`⚠️ ${resetCacheWarnings[0]}`);
        }

        return {
          success: true,
          data: { summary: lines.join('\n'), retrievedAt },
          metrics: {
            executionTime: Date.now() - startTime,
            processingLevel: ProcessingLevel.IMMEDIATE
          }
        };
      }

      return {
        success: true,
        data: result,
        metrics: {
          executionTime: Date.now() - startTime,
          processingLevel: ProcessingLevel.IMMEDIATE
        }
      };
    } catch (error: any) {
      return {
        success: false,
        error: {
          // #4004: propagate the typed code (REMOTE_MACHINE_NOT_FOUND,
          // INVENTORY_PARSE_FAILED, HeartbeatServiceError codes, ...) instead of
          // flattening every failure into INVENTORY_COLLECTION_FAILED.
          code: typeof error?.code === 'string' && error.code ? error.code : 'INVENTORY_COLLECTION_FAILED',
          message: error.message
        },
        metrics: {
          executionTime: Date.now() - startTime,
          processingLevel: ProcessingLevel.IMMEDIATE
        }
      };
    }
  }
};
