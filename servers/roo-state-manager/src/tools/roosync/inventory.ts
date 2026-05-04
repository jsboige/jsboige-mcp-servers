/**
 * Outil MCP : roosync_inventory
 *
 * Récupération de l'inventaire machine et/ou de l'état heartbeat.
 *
 * @module tools/roosync/inventory
 * @version 3.0.0
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
  type: z.enum(['machine', 'heartbeat', 'all', 'machines'])
    .describe('Type d\'inventaire à récupérer. "machines" = offline/warning machines (fused from roosync_machines)'),
  machineId: z.string().optional()
    .describe('Identifiant optionnel de la machine (défaut: hostname)'),
  includeHeartbeats: z.boolean().optional()
    .describe('Inclure les données de heartbeat de chaque machine (défaut: true)'),
  // Pour type="machines" (fused from roosync_machines)
  status: z.enum(['offline', 'warning', 'all']).optional()
    .describe('Filtrer par statut machines (type="machines": offline, warning, all)'),
  includeDetails: z.boolean().optional()
    .describe('Inclure les détails complets des machines (type="machines", défaut: false)'),
  summary: z.boolean().optional()
    .describe('Retourner un résumé compact (markdown) au lieu du JSON complet (défaut: false)')
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
  status: z.enum(['online', 'offline', 'warning'])
    .describe('Statut de la machine'),
  missedHeartbeats: z.number()
    .describe('Nombre de heartbeats manqués consécutifs'),
  offlineSince: z.string().optional()
    .describe('Timestamp de première détection offline (ISO 8601)'),
  metadata: z.object({
    firstSeen: z.string()
      .describe('Timestamp de première détection (ISO 8601)'),
    lastUpdated: z.string()
      .describe('Timestamp de dernière mise à jour (ISO 8601)'),
    version: z.string()
      .describe('Version du service')
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
  offlineCount: z.number()
    .describe('Nombre de machines offline'),
  warningCount: z.number()
    .describe('Nombre de machines en avertissement'),
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
    offlineMachines: z.array(z.string())
      .describe('Liste des IDs des machines offline'),
    warningMachines: z.array(z.string())
      .describe('Liste des IDs des machines en avertissement'),
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
  description: 'Récupération de l\'inventaire machine et/ou de l\'état heartbeat.',
  category: ToolCategory.UTILITY,
  processingLevel: ProcessingLevel.IMMEDIATE,
  version: '3.0.0',
  inputSchema: InventoryArgsSchema,
  execute: async (input: z.infer<typeof InventoryArgsSchema>, context: any): Promise<ToolResult<any>> => {
    const startTime = Date.now();
    try {
      const { type, machineId, includeHeartbeats = true, summary = false } = input;
      const retrievedAt = new Date().toISOString();

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
      if (type === 'heartbeat' || type === 'all') {
        const rooSyncService = await getRooSyncService();
        const heartbeatService = rooSyncService.getHeartbeatService();
        const state = heartbeatService.getState();

        heartbeatState = {
          onlineMachines: state.onlineMachines,
          offlineMachines: state.offlineMachines,
          warningMachines: state.warningMachines,
          statistics: state.statistics,
          heartbeats: includeHeartbeats ? Object.fromEntries(state.heartbeats) : undefined,
          retrievedAt
        };
        if (!summary) {
          result.heartbeatState = heartbeatState;
        }
      }

      // [FUSION A2 #1863] type="machines" — fused from roosync_machines
      if (type === 'machines') {
        const rooSyncService = await getRooSyncService();
        const heartbeatService = rooSyncService.getHeartbeatService();
        const machinesStatus = input.status || 'all';
        const wantDetails = input.includeDetails || false;

        machinesData = { offlineMachines: [], offlineCount: 0, warningMachines: [], warningCount: 0 };

        if (machinesStatus === 'offline' || machinesStatus === 'all') {
          const offlineMachines = heartbeatService.getOfflineMachines();
          if (wantDetails) {
            const detailed: any[] = [];
            for (const mid of offlineMachines) {
              const data = heartbeatService.getHeartbeatData(mid);
              if (data && data.offlineSince) {
                detailed.push({ machineId: data.machineId, lastHeartbeat: data.lastHeartbeat, offlineSince: data.offlineSince, missedHeartbeats: data.missedHeartbeats, metadata: data.metadata });
              }
            }
            machinesData.offlineMachines = detailed;
            machinesData.offlineCount = detailed.length;
          } else {
            machinesData.offlineMachines = offlineMachines;
            machinesData.offlineCount = offlineMachines.length;
          }
        }

        if (machinesStatus === 'warning' || machinesStatus === 'all') {
          const warningMachines = heartbeatService.getWarningMachines();
          if (wantDetails) {
            const detailed: any[] = [];
            for (const mid of warningMachines) {
              const data = heartbeatService.getHeartbeatData(mid);
              if (data) {
                detailed.push({ machineId: data.machineId, lastHeartbeat: data.lastHeartbeat, missedHeartbeats: data.missedHeartbeats, metadata: data.metadata });
              }
            }
            machinesData.warningMachines = detailed;
            machinesData.warningCount = detailed.length;
          } else {
            machinesData.warningMachines = warningMachines;
            machinesData.warningCount = warningMachines.length;
          }
        }
        if (!summary) {
          Object.assign(result, machinesData);
        }
      }

      // Summary mode: return compact markdown instead of full JSON
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
          lines.push(`**Cluster status:** ${hs.statistics.totalMachines} machines`);
          lines.push(`- Online (${hs.onlineMachines.length}): ${hs.onlineMachines.join(', ') || 'none'}`);
          lines.push(`- Offline (${hs.offlineMachines.length}): ${hs.offlineMachines.join(', ') || 'none'}`);
          lines.push(`- Warning (${hs.warningMachines.length}): ${hs.warningMachines.join(', ') || 'none'}`);
          lines.push('');
        }

        if (machinesData) {
          lines.push(`**Filtered machines:** offline=${machinesData.offlineCount}, warning=${machinesData.warningCount}`);
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

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const inventoryToolMetadata = {
  name: 'roosync_inventory',
  description: 'Récupération de l\'inventaire machine et/ou de l\'état heartbeat. type="machines" = offline/warning machines (fused from roosync_machines).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['machine', 'heartbeat', 'all', 'machines'],
        description: 'Type d\'inventaire à récupérer. "machines" = offline/warning machines'
      },
      machineId: {
        type: 'string',
        description: 'Identifiant optionnel de la machine (défaut: hostname)'
      },
      includeHeartbeats: {
        type: 'boolean',
        description: 'Inclure les données de heartbeat de chaque machine (défaut: true)'
      },
      status: {
        type: 'string',
        enum: ['offline', 'warning', 'all'],
        description: 'Filtrer par statut machines (type="machines": offline, warning, all)'
      },
      includeDetails: {
        type: 'boolean',
        description: 'Inclure les détails complets des machines (type="machines", défaut: false)'
      },
      summary: {
        type: 'boolean',
        description: 'Retourner un résumé compact (markdown) au lieu du JSON complet (défaut: false)'
      }
    },
    required: ['type'],
    additionalProperties: false
  }
};
