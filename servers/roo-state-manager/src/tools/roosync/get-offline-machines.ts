/**
 * Outil MCP : roosync_get_offline_machines
 *
 * Obtient la liste des machines actuellement offline dans le système RooSync.
 *
 * @module tools/roosync/get-offline-machines
 * @version 3.0.0
 */

import { z } from 'zod';
import { getRooSyncService } from '../../services/RooSyncService.js';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';

/**
 * Schema de validation pour roosync_get_offline_machines
 */
export const GetOfflineMachinesArgsSchema = z.object({
  includeDetails: z.boolean().optional()
    .describe('Inclure les détails complets de chaque machine (défaut: false)')
});

export type GetOfflineMachinesArgs = z.infer<typeof GetOfflineMachinesArgsSchema>;

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
 * Schema de retour pour roosync_get_offline_machines
 */
export const GetOfflineMachinesResultSchema = z.object({
  success: z.boolean()
    .describe('Indique si la récupération a réussi'),
  count: z.number()
    .describe('Nombre de machines offline'),
  machines: z.union([
    z.array(z.string()).describe('Liste des IDs des machines offline'),
    z.array(OfflineMachineDetailsSchema).describe('Liste détaillée des machines offline')
  ])
    .describe('Liste des machines offline (IDs ou détails selon includeDetails)'),
  checkedAt: z.string()
    .describe('Timestamp de la vérification (ISO 8601)')
});

export type GetOfflineMachinesResult = z.infer<typeof GetOfflineMachinesResultSchema>;

/**
 * Outil roosync_get_offline_machines
 *
 * Obtient la liste des machines actuellement offline.
 * Peut retourner uniquement les IDs ou les détails complets.
 *
 * @param args Arguments validés
 * @returns Liste des machines offline
 * @throws {HeartbeatServiceError} En cas d'erreur
 */
export async function roosyncGetOfflineMachines(args: GetOfflineMachinesArgs): Promise<GetOfflineMachinesResult> {
  try {
    const rooSyncService = getRooSyncService();
    const heartbeatService = rooSyncService.getHeartbeatService();

    const offlineMachines = heartbeatService.getOfflineMachines();
    const checkedAt = new Date().toISOString();

    if (args.includeDetails) {
      // Récupérer les détails complets
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

      return {
        success: true,
        count: detailedMachines.length,
        machines: detailedMachines,
        checkedAt
      };
    } else {
      // Retourner uniquement les IDs
      return {
        success: true,
        count: offlineMachines.length,
        machines: offlineMachines,
        checkedAt
      };
    }
  } catch (error) {
    if (error instanceof HeartbeatServiceError) {
      throw error;
    }

    throw new HeartbeatServiceError(
      `Erreur lors de la récupération des machines offline: ${(error as Error).message}`,
      'HEARTBEAT_GET_OFFLINE_FAILED'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const getOfflineMachinesToolMetadata = {
  name: 'roosync_get_offline_machines',
  description: 'Obtient la liste des machines actuellement offline dans le système RooSync. Peut retourner uniquement les IDs ou les détails complets.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      includeDetails: {
        type: 'boolean',
        description: 'Inclure les détails complets de chaque machine (défaut: false)'
      }
    },
    additionalProperties: false
  }
};
