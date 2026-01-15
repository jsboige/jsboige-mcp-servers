/**
 * Outil MCP : roosync_start_heartbeat_service
 *
 * Démarre le service de heartbeat automatique pour une machine.
 *
 * @module tools/roosync/start-heartbeat-service
 * @version 3.0.0
 */

import { z } from 'zod';
import { getRooSyncService } from '../../services/RooSyncService.js';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';

/**
 * Schema de validation pour roosync_start_heartbeat_service
 */
export const StartHeartbeatServiceArgsSchema = z.object({
  machineId: z.string()
    .describe('Identifiant de la machine'),
  enableAutoSync: z.boolean().optional()
    .describe('Activer la synchronisation automatique (défaut: true)'),
  heartbeatInterval: z.number().optional()
    .describe('Intervalle de heartbeat en millisecondes (défaut: 30000)'),
  offlineTimeout: z.number().optional()
    .describe('Timeout avant de considérer une machine offline en millisecondes (défaut: 120000)')
});

export type StartHeartbeatServiceArgs = z.infer<typeof StartHeartbeatServiceArgsSchema>;

/**
 * Schema de retour pour roosync_start_heartbeat_service
 */
export const StartHeartbeatServiceResultSchema = z.object({
  success: z.boolean()
    .describe('Indique si le démarrage a réussi'),
  machineId: z.string()
    .describe('Identifiant de la machine'),
  startedAt: z.string()
    .describe('Timestamp du démarrage (ISO 8601)'),
  config: z.object({
    heartbeatInterval: z.number()
      .describe('Intervalle de heartbeat configuré'),
    offlineTimeout: z.number()
      .describe('Timeout offline configuré'),
    autoSyncEnabled: z.boolean()
      .describe('Synchronisation automatique activée')
  })
    .describe('Configuration appliquée'),
  message: z.string()
    .describe('Message de confirmation')
});

export type StartHeartbeatServiceResult = z.infer<typeof StartHeartbeatServiceResultSchema>;

/**
 * Outil roosync_start_heartbeat_service
 *
 * Démarre le service de heartbeat automatique pour une machine spécifique.
 * Le service enregistrera automatiquement des heartbeats à intervalles réguliers.
 *
 * @param args Arguments validés
 * @returns Résultat du démarrage
 * @throws {HeartbeatServiceError} En cas d'erreur
 */
export async function roosyncStartHeartbeatService(args: StartHeartbeatServiceArgs): Promise<StartHeartbeatServiceResult> {
  try {
    const {
      machineId,
      enableAutoSync = true,
      heartbeatInterval,
      offlineTimeout
    } = args;

    const rooSyncService = getRooSyncService();
    const heartbeatService = rooSyncService.getHeartbeatService();

    // Mettre à jour la configuration si nécessaire
    if (heartbeatInterval || offlineTimeout) {
      await heartbeatService.updateConfig({
        heartbeatInterval: heartbeatInterval || 30000,
        offlineTimeout: offlineTimeout || 120000,
        autoSyncEnabled: enableAutoSync
      });
    }

    // Démarrer le service de heartbeat
    await heartbeatService.startHeartbeatService(
      machineId,
      // Callback pour détection offline
      (offlineMachineId) => {
        console.log(`[Heartbeat] Machine offline détectée: ${offlineMachineId}`);
      },
      // Callback pour retour online
      (onlineMachineId) => {
        console.log(`[Heartbeat] Machine redevenue online: ${onlineMachineId}`);
      }
    );

    return {
      success: true,
      machineId,
      startedAt: new Date().toISOString(),
      config: {
        heartbeatInterval: heartbeatInterval || 30000,
        offlineTimeout: offlineTimeout || 120000,
        autoSyncEnabled: enableAutoSync
      },
      message: `Service de heartbeat démarré pour ${machineId}`
    };
  } catch (error) {
    if (error instanceof HeartbeatServiceError) {
      throw error;
    }

    throw new HeartbeatServiceError(
      `Erreur lors du démarrage du service de heartbeat: ${(error as Error).message}`,
      'HEARTBEAT_START_FAILED'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const startHeartbeatServiceToolMetadata = {
  name: 'roosync_start_heartbeat_service',
  description: 'Démarre le service de heartbeat automatique pour une machine. Le service enregistrera automatiquement des heartbeats à intervalles réguliers.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      machineId: {
        type: 'string',
        description: 'Identifiant de la machine'
      },
      enableAutoSync: {
        type: 'boolean',
        description: 'Activer la synchronisation automatique (défaut: true)'
      },
      heartbeatInterval: {
        type: 'number',
        description: 'Intervalle de heartbeat en millisecondes (défaut: 30000)'
      },
      offlineTimeout: {
        type: 'number',
        description: 'Timeout avant de considérer une machine offline en millisecondes (défaut: 120000)'
      }
    },
    required: ['machineId'],
    additionalProperties: false
  }
};
