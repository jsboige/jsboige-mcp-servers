/**
 * Outil MCP : roosync_check_heartbeats
 *
 * Vérifie les heartbeats et détecte les changements de statut des machines.
 *
 * @module tools/roosync/check-heartbeats
 * @version 3.0.0
 */

import { z } from 'zod';
import { getRooSyncService } from '../../services/RooSyncService.js';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';

/**
 * Schema de validation pour roosync_check_heartbeats
 */
export const CheckHeartbeatsArgsSchema = z.object({
  forceCheck: z.boolean().optional()
    .describe('Forcer une vérification immédiate (défaut: false)')
});

export type CheckHeartbeatsArgs = z.infer<typeof CheckHeartbeatsArgsSchema>;

/**
 * Schema de retour pour roosync_check_heartbeats
 */
export const CheckHeartbeatsResultSchema = z.object({
  success: z.boolean()
    .describe('Indique si la vérification a réussi'),
  newlyOfflineMachines: z.array(z.string())
    .describe('Machines nouvellement détectées offline'),
  newlyOnlineMachines: z.array(z.string())
    .describe('Machines redevenues online'),
  warningMachines: z.array(z.string())
    .describe('Machines en avertissement'),
  checkedAt: z.string()
    .describe('Timestamp de la vérification (ISO 8601)'),
  summary: z.object({
    totalChanges: z.number()
      .describe('Nombre total de changements de statut'),
    offlineCount: z.number()
      .describe('Nombre de machines offline'),
    onlineCount: z.number()
      .describe('Nombre de machines online'),
    warningCount: z.number()
      .describe('Nombre de machines en avertissement')
  })
    .describe('Résumé des changements')
});

export type CheckHeartbeatsResult = z.infer<typeof CheckHeartbeatsResultSchema>;

/**
 * Outil roosync_check_heartbeats
 *
 * Vérifie les heartbeats et détecte les changements de statut des machines.
 * Identifie les machines nouvellement offline, redevenues online ou en avertissement.
 *
 * @param args Arguments validés
 * @returns Résultat de la vérification
 * @throws {HeartbeatServiceError} En cas d'erreur
 */
export async function roosyncCheckHeartbeats(args: CheckHeartbeatsArgs): Promise<CheckHeartbeatsResult> {
  try {
    const rooSyncService = getRooSyncService();
    const heartbeatService = rooSyncService.getHeartbeatService();

    // Effectuer la vérification des heartbeats
    const result = await heartbeatService.checkHeartbeats();

    return {
      success: result.success,
      newlyOfflineMachines: result.newlyOfflineMachines,
      newlyOnlineMachines: result.newlyOnlineMachines,
      warningMachines: result.warningMachines,
      checkedAt: result.checkedAt,
      summary: {
        totalChanges: result.newlyOfflineMachines.length + result.newlyOnlineMachines.length + result.warningMachines.length,
        offlineCount: result.newlyOfflineMachines.length,
        onlineCount: result.newlyOnlineMachines.length,
        warningCount: result.warningMachines.length
      }
    };
  } catch (error) {
    if (error instanceof HeartbeatServiceError) {
      throw error;
    }

    throw new HeartbeatServiceError(
      `Erreur lors de la vérification des heartbeats: ${(error as Error).message}`,
      'HEARTBEAT_CHECK_FAILED'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const checkHeartbeatsToolMetadata = {
  name: 'roosync_check_heartbeats',
  description: 'Vérifie les heartbeats et détecte les changements de statut des machines. Identifie les machines nouvellement offline, redevenues online ou en avertissement.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      forceCheck: {
        type: 'boolean',
        description: 'Forcer une vérification immédiate (défaut: false)'
      }
    },
    additionalProperties: false
  }
};
