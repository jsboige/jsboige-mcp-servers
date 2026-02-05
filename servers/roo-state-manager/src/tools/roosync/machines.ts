/**
 * Outil MCP consolidé : roosync_machines
 *
 * Fusionne get-offline-machines et get-warning-machines.
 * Permet de récupérer les machines offline et/ou en avertissement.
 *
 * @module tools/roosync/machines
 * @version 3.0.0
 * @since CONS-6
 */

import { z } from 'zod';
import { UnifiedToolContract, ToolCategory, ProcessingLevel, ToolResult } from '../../interfaces/UnifiedToolInterface.js';
import { getRooSyncService } from '../../services/RooSyncService.js';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';

/**
 * Schema de validation pour roosync_machines
 */
export const MachinesArgsSchema = z.object({
  status: z.enum(['offline', 'warning', 'all'])
    .describe('Statut des machines à récupérer'),
  includeDetails: z.boolean().optional()
    .describe('Inclure les détails complets de chaque machine (défaut: false)')
});

export type MachinesArgs = z.infer<typeof MachinesArgsSchema>;

/**
 * Détails d'une machine offline
 */
export const OfflineMachineDetailsSchema = z.object({
  machineId: z.string()
    .describe('Identifiant de la machine'),
  lastHeartbeat: z.string()
    .describe('Timestamp du dernier heartbeat (ISO 8601)'),
  offlineSince: z.string()
    .describe('Timestamp depuis lequel la machine est offline (ISO 8601)'),
  missedHeartbeats: z.number()
    .describe('Nombre de heartbeats manqués'),
  metadata: z.object({
    firstSeen: z.string()
      .describe('Timestamp de première détection (ISO 8601)'),
    lastUpdated: z.string()
      .describe('Timestamp de dernière mise à jour (ISO 8601)'),
    version: z.string()
      .describe('Version du service')
  })
});

export type OfflineMachineDetails = z.infer<typeof OfflineMachineDetailsSchema>;

/**
 * Détails d'une machine en avertissement
 */
export const WarningMachineDetailsSchema = z.object({
  machineId: z.string()
    .describe('Identifiant de la machine'),
  lastHeartbeat: z.string()
    .describe('Timestamp du dernier heartbeat (ISO 8601)'),
  missedHeartbeats: z.number()
    .describe('Nombre de heartbeats manqués'),
  metadata: z.object({
    firstSeen: z.string()
      .describe('Timestamp de première détection (ISO 8601)'),
    lastUpdated: z.string()
      .describe('Timestamp de dernière mise à jour (ISO 8601)'),
    version: z.string()
      .describe('Version du service')
  })
});

export type WarningMachineDetails = z.infer<typeof WarningMachineDetailsSchema>;

/**
 * Schema de retour pour roosync_machines
 */
export const MachinesResultSchema = z.object({
  success: z.boolean()
    .describe('Indique si la récupération a réussi'),
  offlineMachines: z.union([
    z.array(z.string()).describe('Liste des IDs des machines offline'),
    z.array(OfflineMachineDetailsSchema).describe('Liste détaillée des machines offline')
  ]).optional()
    .describe('Liste des machines offline (IDs ou détails selon includeDetails)'),
  warningMachines: z.union([
    z.array(z.string()).describe('Liste des IDs des machines en avertissement'),
    z.array(WarningMachineDetailsSchema).describe('Liste détaillée des machines en avertissement')
  ]).optional()
    .describe('Liste des machines en avertissement (IDs ou détails selon includeDetails)'),
  offlineCount: z.number().optional()
    .describe('Nombre de machines offline'),
  warningCount: z.number().optional()
    .describe('Nombre de machines en avertissement'),
  checkedAt: z.string()
    .describe('Timestamp de la vérification (ISO 8601)')
});

export type MachinesResult = z.infer<typeof MachinesResultSchema>;

/**
 * Outil roosync_machines (UnifiedToolContract)
 *
 * Fusionne get-offline-machines et get-warning-machines.
 * Permet de récupérer les machines offline et/ou en avertissement.
 */
export const machinesTool: UnifiedToolContract = {
  name: 'roosync_machines',
  description: 'Outil consolidé pour récupérer les machines offline et/ou en avertissement. Fusionne get-offline-machines et get-warning-machines.',
  category: ToolCategory.UTILITY,
  processingLevel: ProcessingLevel.IMMEDIATE,
  version: '3.0.0',
  inputSchema: MachinesArgsSchema,
  execute: async (input: z.infer<typeof MachinesArgsSchema>, context: any): Promise<ToolResult<any>> => {
    const startTime = Date.now();
    try {
      const { status, includeDetails = false } = input;
      const rooSyncService = getRooSyncService();
      const heartbeatService = rooSyncService.getHeartbeatService();
      const checkedAt = new Date().toISOString();

      const result: any = {
        success: true,
        checkedAt
      };

      // Récupérer les machines offline si demandé
      if (status === 'offline' || status === 'all') {
        const offlineMachines = heartbeatService.getOfflineMachines();

        if (includeDetails) {
          const detailedMachines: OfflineMachineDetails[] = [];

          for (const machineId of offlineMachines) {
            const heartbeatData = heartbeatService.getHeartbeatData(machineId);

            if (heartbeatData && heartbeatData.offlineSince) {
              detailedMachines.push({
                machineId: heartbeatData.machineId,
                lastHeartbeat: heartbeatData.lastHeartbeat,
                offlineSince: heartbeatData.offlineSince,
                missedHeartbeats: heartbeatData.missedHeartbeats,
                metadata: heartbeatData.metadata
              });
            }
          }

          result.offlineMachines = detailedMachines;
          result.offlineCount = detailedMachines.length;
        } else {
          result.offlineMachines = offlineMachines;
          result.offlineCount = offlineMachines.length;
        }
      }

      // Récupérer les machines en avertissement si demandé
      if (status === 'warning' || status === 'all') {
        const warningMachines = heartbeatService.getWarningMachines();

        if (includeDetails) {
          const detailedMachines: WarningMachineDetails[] = [];

          for (const machineId of warningMachines) {
            const heartbeatData = heartbeatService.getHeartbeatData(machineId);

            if (heartbeatData) {
              detailedMachines.push({
                machineId: heartbeatData.machineId,
                lastHeartbeat: heartbeatData.lastHeartbeat,
                missedHeartbeats: heartbeatData.missedHeartbeats,
                metadata: heartbeatData.metadata
              });
            }
          }

          result.warningMachines = detailedMachines;
          result.warningCount = detailedMachines.length;
        } else {
          result.warningMachines = warningMachines;
          result.warningCount = warningMachines.length;
        }
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
          code: 'MACHINES_COLLECTION_FAILED',
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
 * Fonction wrapper pour compatibilité avec les tests
 */
export async function roosyncMachines(args: MachinesArgs, context?: any): Promise<ToolResult<any>> {
  return machinesTool.execute(args, context);
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const machinesToolMetadata = {
  name: 'roosync_machines',
  description: 'Outil consolidé pour récupérer les machines offline et/ou en avertissement. Fusionne get-offline-machines et get-warning-machines.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      status: {
        type: 'string',
        enum: ['offline', 'warning', 'all'],
        description: 'Statut des machines à récupérer'
      },
      includeDetails: {
        type: 'boolean',
        description: 'Inclure les détails complets de chaque machine (défaut: false)'
      }
    },
    required: ['status'],
    additionalProperties: false
  }
};
