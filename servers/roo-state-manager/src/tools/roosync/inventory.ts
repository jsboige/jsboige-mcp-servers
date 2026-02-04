/**
 * Outil MCP consolidé : roosync_inventory
 *
 * Fusionne get-machine-inventory et get-heartbeat-state.
 * Permet de récupérer l'inventaire machine et/ou l'état heartbeat.
 *
 * @module tools/roosync/inventory
 * @version 3.0.0
 * @since CONS-6
 */

import { z } from 'zod';
import { UnifiedToolContract, ToolCategory, ProcessingLevel, ToolResult } from '../../interfaces/UnifiedToolInterface.js';
import { InventoryService } from '../../services/roosync/InventoryService.js';
import { getRooSyncService } from '../../services/RooSyncService.js';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';

/**
 * Schema de validation pour roosync_inventory
 */
export const InventoryArgsSchema = z.object({
  type: z.enum(['machine', 'heartbeat', 'all'])
    .describe('Type d\'inventaire à récupérer'),
  machineId: z.string().optional()
    .describe('Identifiant optionnel de la machine (défaut: hostname)'),
  includeHeartbeats: z.boolean().optional()
    .describe('Inclure les données de heartbeat de chaque machine (défaut: true)')
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
 * Fusionne get-machine-inventory et get-heartbeat-state.
 * Permet de récupérer l'inventaire machine et/ou l'état heartbeat.
 *
 * @param args Arguments validés
 * @returns Inventaire et/ou état heartbeat
 * @throws {HeartbeatServiceError} En cas d'erreur
 */
export const inventoryTool: UnifiedToolContract = {
  name: 'roosync_inventory',
  description: 'Outil consolidé pour récupérer l\'inventaire machine et/ou l\'état heartbeat. Fusionne get-machine-inventory et get-heartbeat-state.',
  category: ToolCategory.UTILITY,
  processingLevel: ProcessingLevel.IMMEDIATE,
  version: '3.0.0',
  inputSchema: InventoryArgsSchema,
  execute: async (input: z.infer<typeof InventoryArgsSchema>, context: any): Promise<ToolResult<any>> => {
    const startTime = Date.now();
    try {
      const { type, machineId, includeHeartbeats = true } = input;
      const retrievedAt = new Date().toISOString();

      const result: any = {
        success: true,
        retrievedAt
      };

      // Récupérer l'inventaire machine si demandé
      if (type === 'machine' || type === 'all') {
        const inventoryService = InventoryService.getInstance();
        result.machineInventory = await inventoryService.getMachineInventory(machineId);
      }

      // Récupérer l'état heartbeat si demandé
      if (type === 'heartbeat' || type === 'all') {
        const rooSyncService = getRooSyncService();
        const heartbeatService = rooSyncService.getHeartbeatService();
        const state = heartbeatService.getState();

        result.heartbeatState = {
          onlineMachines: state.onlineMachines,
          offlineMachines: state.offlineMachines,
          warningMachines: state.warningMachines,
          statistics: state.statistics,
          heartbeats: includeHeartbeats ? Object.fromEntries(state.heartbeats) : undefined,
          retrievedAt
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
  description: 'Outil consolidé pour récupérer l\'inventaire machine et/ou l\'état heartbeat. Fusionne get-machine-inventory et get-heartbeat-state.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['machine', 'heartbeat', 'all'],
        description: 'Type d\'inventaire à récupérer'
      },
      machineId: {
        type: 'string',
        description: 'Identifiant optionnel de la machine (défaut: hostname)'
      },
      includeHeartbeats: {
        type: 'boolean',
        description: 'Inclure les données de heartbeat de chaque machine (défaut: true)'
      }
    },
    required: ['type'],
    additionalProperties: false
  }
};
