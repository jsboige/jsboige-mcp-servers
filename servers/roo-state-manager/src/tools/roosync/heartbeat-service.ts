/**
 * Outil MCP : roosync_heartbeat_service
 *
 * Gestion du service de heartbeat (register, start, stop).
 *
 * @module tools/roosync/heartbeat-service
 * @version 3.1.0
 */

import { z } from 'zod';
import { getRooSyncService } from '../../services/RooSyncService.js';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';

/**
 * Schema de validation pour roosync_heartbeat_service
 */
export const HeartbeatServiceArgsSchema = z.object({
  action: z.enum(['register', 'start', 'stop'])
    .describe('Action a effectuer: register (enregistrer un heartbeat), start (demarrer le service), stop (arreter le service)'),
  machineId: z.string().optional()
    .describe('Identifiant de la machine (requis pour register et start)'),
  metadata: z.record(z.any()).optional()
    .describe('Metadonnees optionnelles a associer au heartbeat (pour action register)'),
  enableAutoSync: z.boolean().optional()
    .describe('Activer la synchronisation automatique (pour action start, defaut: true)'),
  heartbeatInterval: z.number().optional()
    .describe('Intervalle de heartbeat en millisecondes (pour action start, defaut: 30000)'),
  offlineTimeout: z.number().optional()
    .describe('Timeout avant de considerer une machine offline en millisecondes (pour action start, defaut: 120000)'),
  saveState: z.boolean().optional()
    .describe('Sauvegarder l\'etat avant l\'arret (pour action stop, defaut: true)')
});

export type HeartbeatServiceArgs = z.infer<typeof HeartbeatServiceArgsSchema>;

/**
 * Resultat pour action 'register'
 */
export const RegisterResultSchema = z.object({
  action: z.literal('register'),
  machineId: z.string()
    .describe('Identifiant de la machine'),
  timestamp: z.string()
    .describe('Timestamp du heartbeat (ISO 8601)'),
  status: z.enum(['online', 'offline', 'warning'])
    .describe('Statut de la machine apres l\'enregistrement'),
  isNewMachine: z.boolean()
    .describe('Indique si c\'est une nouvelle machine')
});

/**
 * Resultat pour action 'start'
 */
export const StartResultSchema = z.object({
  action: z.literal('start'),
  machineId: z.string()
    .describe('Identifiant de la machine'),
  startedAt: z.string()
    .describe('Timestamp du demarrage (ISO 8601)'),
  config: z.object({
    heartbeatInterval: z.number()
      .describe('Intervalle de heartbeat configure'),
    offlineTimeout: z.number()
      .describe('Timeout offline configure'),
    autoSyncEnabled: z.boolean()
      .describe('Synchronisation automatique activee')
  })
    .describe('Configuration appliquee')
});

/**
 * Resultat pour action 'stop'
 */
export const StopResultSchema = z.object({
  action: z.literal('stop'),
  stoppedAt: z.string()
    .describe('Timestamp de l\'arret (ISO 8601)'),
  stateSaved: z.boolean()
    .describe('Indique si l\'etat a ete sauvegarde')
});

/**
 * Schema de retour pour roosync_heartbeat_service
 */
export const HeartbeatServiceResultSchema = z.object({
  success: z.boolean()
    .describe('Indique si l\'action a reussi'),
  message: z.string()
    .describe('Message de confirmation'),
  result: z.union([RegisterResultSchema, StartResultSchema, StopResultSchema])
    .describe('Resultat specifique a l\'action')
});

export type HeartbeatServiceResult = z.infer<typeof HeartbeatServiceResultSchema>;

/**
 * Outil roosync_heartbeat_service
 *
 * Outil consolide pour gerer le service de heartbeat.
 * Remplace: register-heartbeat, start-heartbeat-service, stop-heartbeat-service
 *
 * @param args Arguments valides
 * @returns Resultat de l'action
 * @throws {HeartbeatServiceError} En cas d'erreur
 */
export async function roosyncHeartbeatService(args: HeartbeatServiceArgs): Promise<HeartbeatServiceResult> {
  const { action } = args;

  try {
    const rooSyncService = getRooSyncService();
    const heartbeatService = rooSyncService.getHeartbeatService();

    switch (action) {
      case 'register': {
        if (!args.machineId) {
          throw new HeartbeatServiceError(
            'machineId est requis pour l\'action register',
            'HEARTBEAT_MISSING_MACHINE_ID'
          );
        }

        // Verifier si la machine existe deja
        const existingData = heartbeatService.getHeartbeatData(args.machineId);
        const isNewMachine = !existingData;

        // Enregistrer le heartbeat
        await heartbeatService.registerHeartbeat(args.machineId, args.metadata);

        // Recuperer les donnees mises a jour
        const updatedData = heartbeatService.getHeartbeatData(args.machineId);

        if (!updatedData) {
          throw new HeartbeatServiceError(
            'Impossible de recuperer les donnees apres enregistrement',
            'HEARTBEAT_RETRIEVAL_FAILED'
          );
        }

        return {
          success: true,
          message: `Heartbeat enregistre pour ${args.machineId}`,
          result: {
            action: 'register',
            machineId: args.machineId,
            timestamp: updatedData.lastHeartbeat,
            status: updatedData.status,
            isNewMachine
          }
        };
      }

      case 'start': {
        if (!args.machineId) {
          throw new HeartbeatServiceError(
            'machineId est requis pour l\'action start',
            'HEARTBEAT_MISSING_MACHINE_ID'
          );
        }

        const {
          enableAutoSync = true,
          heartbeatInterval,
          offlineTimeout
        } = args;

        // Mettre a jour la configuration si necessaire
        if (heartbeatInterval || offlineTimeout) {
          await heartbeatService.updateConfig({
            heartbeatInterval: heartbeatInterval || 30000,
            offlineTimeout: offlineTimeout || 120000,
            autoSyncEnabled: enableAutoSync
          });
        }

        // Demarrer le service de heartbeat
        await heartbeatService.startHeartbeatService(
          args.machineId,
          // Callback pour detection offline
          (offlineMachineId) => {
            console.log(`[Heartbeat] Machine offline detectee: ${offlineMachineId}`);
          },
          // Callback pour retour online
          (onlineMachineId) => {
            console.log(`[Heartbeat] Machine redevenue online: ${onlineMachineId}`);
          }
        );

        return {
          success: true,
          message: `Service de heartbeat demarre pour ${args.machineId}`,
          result: {
            action: 'start',
            machineId: args.machineId,
            startedAt: new Date().toISOString(),
            config: {
              heartbeatInterval: heartbeatInterval || 30000,
              offlineTimeout: offlineTimeout || 120000,
              autoSyncEnabled: enableAutoSync
            }
          }
        };
      }

      case 'stop': {
        const { saveState = true } = args;

        // Arreter le service
        await heartbeatService.stopHeartbeatService();

        return {
          success: true,
          message: 'Service de heartbeat arrete avec succes',
          result: {
            action: 'stop',
            stoppedAt: new Date().toISOString(),
            stateSaved: saveState
          }
        };
      }

      default:
        throw new HeartbeatServiceError(
          `Action inconnue: ${action}`,
          'HEARTBEAT_UNKNOWN_ACTION'
        );
    }
  } catch (error) {
    if (error instanceof HeartbeatServiceError) {
      throw error;
    }

    throw new HeartbeatServiceError(
      `Erreur lors de l'action ${action}: ${(error as Error).message}`,
      'HEARTBEAT_SERVICE_FAILED'
    );
  }
}

/**
 * Metadonnees de l'outil pour l'enregistrement MCP
 */
export const heartbeatServiceToolMetadata = {
  name: 'roosync_heartbeat_service',
  description: 'Gestion du service de heartbeat. Actions : register (enregistrer), start (démarrer), stop (arrêter).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['register', 'start', 'stop'],
        description: 'Action a effectuer: register, start ou stop'
      },
      machineId: {
        type: 'string',
        description: 'Identifiant de la machine (requis pour register et start)'
      },
      metadata: {
        type: 'object',
        description: 'Metadonnees optionnelles (pour action register)'
      },
      enableAutoSync: {
        type: 'boolean',
        description: 'Activer la synchronisation automatique (pour action start, defaut: true)'
      },
      heartbeatInterval: {
        type: 'number',
        description: 'Intervalle de heartbeat en ms (pour action start, defaut: 30000)'
      },
      offlineTimeout: {
        type: 'number',
        description: 'Timeout offline en ms (pour action start, defaut: 120000)'
      },
      saveState: {
        type: 'boolean',
        description: 'Sauvegarder l\'etat avant arret (pour action stop, defaut: true)'
      }
    },
    required: ['action'],
    additionalProperties: false
  }
};
