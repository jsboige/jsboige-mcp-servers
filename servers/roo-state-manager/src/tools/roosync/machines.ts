/**
 * Outil MCP : roosync_machines
 *
 * Récupération des machines offline et/ou en avertissement.
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
  status: z.enum(['offline', 'warning', 'all'])
    .describe('Statut des machines à récupérer'),
  includeDetails: z.boolean().optional()
    .describe('Inclure les détails complets de chaque machine (défaut: false)')
});

export type MachinesArgs = z.infer<typeof MachinesArgsSchema>;

/**
 * Détails d'une machine unknown
 */
export const UnknownMachineDetailsSchema = z.object({
  machineId: z.string()
    .describe('Identifiant de la machine'),
  lastHeartbeat: z.string()
    .describe('Timestamp du dernier heartbeat (ISO 8601)'),
  status: z.enum(['online', 'idle', 'unknown'])
    .describe('Statut de la machine'),
  metadata: z.object({
    firstSeen: z.string()
      .describe('Timestamp de première détection (ISO 8601)'),
    lastUpdated: z.string()
      .describe('Timestamp de dernière mise à jour (ISO 8601)')
  })
});

export type UnknownMachineDetails = z.infer<typeof UnknownMachineDetailsSchema>;

/**
 * Détails d'une machine idle
 */
export const IdleMachineDetailsSchema = z.object({
  machineId: z.string()
    .describe('Identifiant de la machine'),
  lastHeartbeat: z.string()
    .describe('Timestamp du dernier heartbeat (ISO 8601)'),
  status: z.enum(['online', 'idle', 'unknown'])
    .describe('Statut de la machine'),
  metadata: z.object({
    firstSeen: z.string()
      .describe('Timestamp de première détection (ISO 8601)'),
    lastUpdated: z.string()
      .describe('Timestamp de dernière mise à jour (ISO 8601)')
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
    z.array(z.string()).describe('Liste des IDs des machines unknown'),
    z.array(UnknownMachineDetailsSchema).describe('Liste détaillée des machines unknown')
  ]).optional()
    .describe('Liste des machines unknown (IDs ou détails selon includeDetails)'),
  idleMachines: z.union([
    z.array(z.string()).describe('Liste des IDs des machines idle'),
    z.array(IdleMachineDetailsSchema).describe('Liste détaillée des machines idle')
  ]).optional()
    .describe('Liste des machines idle (IDs ou détails selon includeDetails)'),
  unknownCount: z.number().optional()
    .describe('Nombre de machines unknown'),
  idleCount: z.number().optional()
    .describe('Nombre de machines idle'),
  checkedAt: z.string()
    .describe('Timestamp de la vérification (ISO 8601)')
});

export type MachinesResult = z.infer<typeof MachinesResultSchema>;

/**
 * Outil roosync_machines (UnifiedToolContract)
 *
 * Récupération des machines offline et/ou en avertissement.
 */
export const machinesTool: UnifiedToolContract = {
  name: 'roosync_machines',
  description: 'Récupération des machines offline et/ou en avertissement.',
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

      // Récupérer les machines unknown si demandé
      if (status === 'offline' || status === 'all') {
        const unknownMachines = heartbeatService.getUnknownMachines();

        if (includeDetails) {
          const detailedMachines: UnknownMachineDetails[] = [];

          for (const machineId of unknownMachines) {
            const heartbeatData = heartbeatService.getHeartbeatData(machineId);

            if (heartbeatData) {
              detailedMachines.push({
                machineId: heartbeatData.machineId,
                lastHeartbeat: heartbeatData.lastHeartbeat,
                status: heartbeatData.status,
                metadata: heartbeatData.metadata
              });
            }
          }

          result.unknownMachines = detailedMachines;
          result.unknownCount = detailedMachines.length;
        } else {
          result.unknownMachines = unknownMachines;
          result.unknownCount = unknownMachines.length;
        }
      }

      // Récupérer les machines idle si demandé
      if (status === 'warning' || status === 'all') {
        const idleMachines = heartbeatService.getIdleMachines();

        if (includeDetails) {
          const detailedMachines: IdleMachineDetails[] = [];

          for (const machineId of idleMachines) {
            const heartbeatData = heartbeatService.getHeartbeatData(machineId);

            if (heartbeatData) {
              detailedMachines.push({
                machineId: heartbeatData.machineId,
                lastHeartbeat: heartbeatData.lastHeartbeat,
                status: heartbeatData.status,
                metadata: heartbeatData.metadata
              });
            }
          }

          result.idleMachines = detailedMachines;
          result.idleCount = detailedMachines.length;
        } else {
          result.idleMachines = idleMachines;
          result.idleCount = idleMachines.length;
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
  description: 'Récupération des machines offline et/ou en avertissement.',
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
