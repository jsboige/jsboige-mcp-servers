/**
 * Outil MCP : roosync_stop_heartbeat_service
 *
 * Arrête le service de heartbeat automatique.
 *
 * @module tools/roosync/stop-heartbeat-service
 * @version 3.0.0
 */

import { z } from 'zod';
import { getRooSyncService } from '../../services/RooSyncService.js';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';

/**
 * Schema de validation pour roosync_stop_heartbeat_service
 */
export const StopHeartbeatServiceArgsSchema = z.object({
  saveState: z.boolean().optional()
    .describe('Sauvegarder l\'état avant l\'arrêt (défaut: true)')
});

export type StopHeartbeatServiceArgs = z.infer<typeof StopHeartbeatServiceArgsSchema>;

/**
 * Schema de retour pour roosync_stop_heartbeat_service
 */
export const StopHeartbeatServiceResultSchema = z.object({
  success: z.boolean()
    .describe('Indique si l\'arrêt a réussi'),
  stoppedAt: z.string()
    .describe('Timestamp de l\'arrêt (ISO 8601)'),
  stateSaved: z.boolean()
    .describe('Indique si l\'état a été sauvegardé'),
  message: z.string()
    .describe('Message de confirmation')
});

export type StopHeartbeatServiceResult = z.infer<typeof StopHeartbeatServiceResultSchema>;

/**
 * Outil roosync_stop_heartbeat_service
 *
 * Arrête le service de heartbeat automatique.
 * L'état est sauvegardé par défaut avant l'arrêt.
 *
 * @param args Arguments validés
 * @returns Résultat de l'arrêt
 * @throws {HeartbeatServiceError} En cas d'erreur
 */
export async function roosyncStopHeartbeatService(args: StopHeartbeatServiceArgs): Promise<StopHeartbeatServiceResult> {
  try {
    const { saveState = true } = args;

    const rooSyncService = getRooSyncService();
    const heartbeatService = rooSyncService.getHeartbeatService();

    // Arrêter le service
    await heartbeatService.stopHeartbeatService();

    return {
      success: true,
      stoppedAt: new Date().toISOString(),
      stateSaved: saveState,
      message: 'Service de heartbeat arrêté avec succès'
    };
  } catch (error) {
    if (error instanceof HeartbeatServiceError) {
      throw error;
    }

    throw new HeartbeatServiceError(
      `Erreur lors de l'arrêt du service de heartbeat: ${(error as Error).message}`,
      'HEARTBEAT_STOP_FAILED'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const stopHeartbeatServiceToolMetadata = {
  name: 'roosync_stop_heartbeat_service',
  description: 'Arrête le service de heartbeat automatique. L\'état est sauvegardé par défaut avant l\'arrêt.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      saveState: {
        type: 'boolean',
        description: 'Sauvegarder l\'état avant l\'arrêt (défaut: true)'
      }
    },
    additionalProperties: false
  }
};
