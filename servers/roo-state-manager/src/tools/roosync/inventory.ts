/**
 * Outil MCP : roosync_inventory
 *
 * Récupération de l'inventaire machine et/ou de l'état heartbeat.
 *
 * IMPORTANT: Les types "heartbeat", "all" et "machines" retournent des données
 * heartbeat IN-MEMORY qui ne reflètent QUE l'activité du processus MCP local.
 * Ils NE DOIVENT PAS être interprétés comme une vérité cross-machine.
 * Pour un snapshot cross-machine fiable, utiliser type="status".
 *
 * @module tools/roosync/inventory
 * @version 4.0.0 (#2318: cross-machine sunset annotations)
 * @see #2318, ADR 008 Phase 4
 */

import { z } from 'zod';
import { UnifiedToolContract, ToolCategory, ProcessingLevel, ToolResult } from '../../interfaces/UnifiedToolInterface.js';
import { InventoryService } from '../../services/roosync/InventoryService.js';
import { getRooSyncService } from '../../services/lazy-roosync.js';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';

/**
 * Schema de validation pour roosync_inventory
 */
export const InventoryArgsSchema = z.object({
  type: z.enum(['machine', 'heartbeat', 'all', 'machines', 'status'])
    .describe('Type d\'inventaire à récupérer. "machines" = unknown/idle machines. "status" = compact system snapshot (fused from roosync_get_status)'),
  machineId: z.string().optional()
    .describe('Identifiant optionnel de la machine (défaut: hostname)'),
  includeHeartbeats: z.boolean().optional()
    .describe('Inclure les données de heartbeat de chaque machine (défaut: true)'),
  // Pour type="machines" (fused from roosync_machines)
  status: z.enum(['unknown', 'idle', 'all']).optional()
    .describe('Filtrer par statut machines (type="machines")'),
  includeDetails: z.boolean().optional()
    .describe('Inclure les détails complets des machines (type="machines") ou stats outil (type="status")'),
  summary: z.boolean().optional()
    .describe('Retourner un résumé compact (markdown) au lieu du JSON complet (défaut: false)'),
  // #1935 Cluster E: fused from roosync_get_status
  detail: z.enum(['compact', 'full']).optional()
    .describe('Niveau de détail pour type="status". "full" ajoute claims + pipeline stages'),
  resetCache: z.boolean().optional()
    .describe('Forcer la réinitialisation du cache (type="status" uniquement)')
});

export type InventoryArgs = z.infer<typeof InventoryArgsSchema>;

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
  version: '4.0.0',
  inputSchema: InventoryArgsSchema,
  execute: async (input: z.infer<typeof InventoryArgsSchema>, context: any): Promise<ToolResult<any>> => {
    const startTime = Date.now();
    try {
      const { type, machineId, includeHeartbeats = true, summary = false } = input;
      const retrievedAt = new Date().toISOString();

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

      const result: any = {
        success: true,
        retrievedAt
      };

      // Collect data
      let machineInventory: any = null;
      let heartbeatState: any = null;
      let machinesData: any = null;

      // Récupérer l'inventaire machine si demandé
      if (type === 'machine' || type === 'all') {
        const inventoryService = InventoryService.getInstance();
        machineInventory = await inventoryService.getMachineInventory(machineId);
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
      // #2318: Same caveat as "heartbeat" — LOCAL-SELF ONLY data.
      if (type === 'machines') {
        const rooSyncService = await getRooSyncService();
        const heartbeatService = rooSyncService.getHeartbeatService();
        const machinesStatus = input.status || 'all';
        const wantDetails = input.includeDetails || false;

        machinesData = { unknownMachines: [], unknownCount: 0, idleMachines: [], idleCount: 0 };

        if (machinesStatus === 'unknown' || machinesStatus === 'all') {
          const unknownMachines = heartbeatService.getUnknownMachines();
          if (wantDetails) {
            const detailed: any[] = [];
            for (const mid of unknownMachines) {
              const data = heartbeatService.getHeartbeatData(mid);
              if (data) {
                detailed.push({ machineId: data.machineId, lastHeartbeat: data.lastHeartbeat, status: data.status, metadata: data.metadata });
              }
            }
            machinesData.unknownMachines = detailed;
            machinesData.unknownCount = detailed.length;
          } else {
            machinesData.unknownMachines = unknownMachines;
            machinesData.unknownCount = unknownMachines.length;
          }
        }

        if (machinesStatus === 'idle' || machinesStatus === 'all') {
          const idleMachines = heartbeatService.getIdleMachines();
          if (wantDetails) {
            const detailed: any[] = [];
            for (const mid of idleMachines) {
              const data = heartbeatService.getHeartbeatData(mid);
              if (data) {
                detailed.push({ machineId: data.machineId, lastHeartbeat: data.lastHeartbeat, status: data.status, metadata: data.metadata });
              }
            }
            machinesData.idleMachines = detailed;
            machinesData.idleCount = detailed.length;
          } else {
            machinesData.idleMachines = idleMachines;
            machinesData.idleCount = idleMachines.length;
          }
        }
        if (!summary) {
          Object.assign(result, machinesData);
          result.crossMachineWarning = 'Machine status reflects LOCAL process activity only. Use type="status" for reliable cross-machine presence. (#2318)';
        }
      }
      if (summary) {
        const lines: string[] = [`**Inventory Summary** (${retrievedAt})`, ''];

        if (machineInventory) {
          const inv = machineInventory as any;
          lines.push(`**Machine:** ${inv.systemInfo?.hostname || machineId || 'unknown'}`);
          lines.push(`- OS: ${inv.systemInfo?.os || 'N/A'}`);
          const mcpCount = inv.mcpServers ? Object.keys(inv.mcpServers).length : 0;
          lines.push(`- MCPs: ${mcpCount} servers`);
          const modes = inv.rooModes?.modes ? Object.keys(inv.rooModes.modes).length : 0;
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
          lines.push(`**Filtered machines:** unknown=${machinesData.unknownCount}, idle=${machinesData.idleCount}`);
          lines.push('');
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
          code: 'INVENTORY_COLLECTION_FAILED',
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
