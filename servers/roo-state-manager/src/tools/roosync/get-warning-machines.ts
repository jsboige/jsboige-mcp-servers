/**
 * Outil MCP : roosync_get_warning_machines
 *
 * Obtient la liste des machines actuellement en avertissement dans le système RooSync.
 *
 * @module tools/roosync/get-warning-machines
 * @version 3.0.0
 */

import { z } from 'zod';
import { getRooSyncService } from '../../services/RooSyncService.js';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';

/**
 * Schema de validation pour roosync_get_warning_machines
 */
export const GetWarningMachinesArgsSchema = z.object({
  includeDetails: z.boolean().optional()
    .describe('Inclure les détails complets de chaque machine (défaut: false)')
});

export type GetWarningMachinesArgs = z.infer<typeof GetWarningMachinesArgsSchema>;

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
 * Schema de retour pour roosync_get_warning_machines
 */
export const GetWarningMachinesResultSchema = z.object({
  success: z.boolean()
    .describe('Indique si la récupération a réussi'),
  count: z.number()
    .describe('Nombre de machines en avertissement'),
  machines: z.union([
    z.array(z.string()).describe('Liste des IDs des machines en avertissement'),
    z.array(WarningMachineDetailsSchema).describe('Liste détaillée des machines en avertissement')
  ])
    .describe('Liste des machines en avertissement (IDs ou détails selon includeDetails)'),
  checkedAt: z.string()
    .describe('Timestamp de la vérification (ISO 8601)')
});

export type GetWarningMachinesResult = z.infer<typeof GetWarningMachinesResultSchema>;

/**
 * Outil roosync_get_warning_machines
 *
 * Obtient la liste des machines actuellement en avertissement.
 * Peut retourner uniquement les IDs ou les détails complets.
 *
 * @param args Arguments validés
 * @returns Liste des machines en avertissement
 * @throws {HeartbeatServiceError} En cas d'erreur
 */
export async function roosyncGetWarningMachines(args: GetWarningMachinesArgs): Promise<GetWarningMachinesResult> {
  try {
    const rooSyncService = getRooSyncService();
    const heartbeatService = rooSyncService.getHeartbeatService();

    const warningMachines = heartbeatService.getWarningMachines();
    const checkedAt = new Date().toISOString();

    if (args.includeDetails) {
      // Récupérer les détails complets
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
        count: warningMachines.length,
        machines: warningMachines,
        checkedAt
      };
    }
  } catch (error) {
    if (error instanceof HeartbeatServiceError) {
      throw error;
    }

    throw new HeartbeatServiceError(
      `Erreur lors de la récupération des machines en avertissement: ${(error as Error).message}`,
      'HEARTBEAT_GET_WARNING_FAILED'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const getWarningMachinesToolMetadata = {
  name: 'roosync_get_warning_machines',
  description: 'Obtient la liste des machines actuellement en avertissement dans le système RooSync. Peut retourner uniquement les IDs ou les détails complets.',
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
