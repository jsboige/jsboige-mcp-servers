/**
 * Outil MCP : roosync_machines
 *
 * Récupération des machines unknown et/ou idle.
 *
 * @module tools/roosync/machines
 * @version 3.0.0
 */

import { z } from 'zod';
import { UnifiedToolContract, ToolCategory, ProcessingLevel, ToolResult } from '../../interfaces/UnifiedToolInterface.js';
import { getRooSyncService } from '../../services/lazy-roosync.js';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';

/**
 * Schema de validation pour roosync_machines
 */
export const MachinesArgsSchema = z.object({
  status: z.enum(['unknown', 'idle', 'all'])
    .describe('Statut des machines à récupérer'),
  includeDetails: z.boolean().optional()
    .describe('Inclure les détails complets de chaque machine (défaut: false)')
});

export type MachinesArgs = z.infer<typeof MachinesArgsSchema>;

/**
 * Détails d'une machine offline
 */
export const UnknownMachineDetailsSchema = z.object({
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

export type UnknownMachineDetails = z.infer<typeof UnknownMachineDetailsSchema>;

/**
 * Détails d'une machine en avertissement
 */
export const IdleMachineDetailsSchema = z.object({
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

export type IdleMachineDetails = z.infer<typeof IdleMachineDetailsSchema>;

/**
 * Schema de retour pour roosync_machines
 */
export const MachinesResultSchema = z.object({
  success: z.boolean()
    .describe('Indique si la récupération a réussi'),
  unknownMachines: z.union([
    z.array(z.string()).describe('Liste des IDs des machines offline'),
    z.array(UnknownMachineDetailsSchema).describe('Liste détaillée des machines offline')
  ]).optional()
    .describe('Liste des machines offline (IDs ou détails selon includeDetails)'),
  idleMachines: z.union([
    z.array(z.string()).describe('Liste des IDs des machines en avertissement'),
    z.array(IdleMachineDetailsSchema).describe('Liste détaillée des machines en avertissement')
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
 * Récupération des machines unknown et/ou idle.
 */
export const machinesTool: UnifiedToolContract = {
  name: 'roosync_machines',
  description: 'Récupération des machines unknown et/ou idle.',
  category: ToolCategory.UTILITY,
  processingLevel: ProcessingLevel.IMMEDIATE,
  version: '3.0.0',
  inputSchema: MachinesArgsSchema,
  execute: async (input: z.infer<typeof MachinesArgsSchema>, context: any): Promise<ToolResult<any>> => {
    const startTime = Date.now();
    try {
      const { status, includeDetails = false } = input;
      const rooSyncService = await getRooSyncService();
      const heartbeatService = rooSyncService.getHeartbeatService();
      const checkedAt = new Date().toISOString();

      const result: any = {
        success: true,
        checkedAt
      };

      // Récupérer les machines offline si demandé
      if (status === 'unknown' || status === 'all') {
        const unknownMachines = heartbeatService.getUnknownMachines();

        if (includeDetails) {
          const detailedMachines: UnknownMachineDetails[] = [];

          for (const machineId of unknownMachines) {
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

          result.unknownMachines = detailedMachines;
          result.offlineCount = detailedMachines.length;
        } else {
          result.unknownMachines = unknownMachines;
          result.offlineCount = unknownMachines.length;
        }
      }

      // Récupérer les machines en avertissement si demandé
      if (status === 'idle' || status === 'all') {
        const idleMachines = heartbeatService.getIdleMachines();

        if (includeDetails) {
          const detailedMachines: IdleMachineDetails[] = [];

          for (const machineId of idleMachines) {
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

          result.idleMachines = detailedMachines;
          result.warningCount = detailedMachines.length;
        } else {
          result.idleMachines = idleMachines;
          result.warningCount = idleMachines.length;
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
  description: 'Récupération des machines unknown et/ou idle.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      status: {
        type: 'string',
        enum: ['unknown', 'idle', 'all'],
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
