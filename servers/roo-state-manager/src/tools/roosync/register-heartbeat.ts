/**
 * Outil MCP : roosync_register_heartbeat
 *
 * Enregistre un heartbeat pour une machine dans le système RooSync.
 *
 * @module tools/roosync/register-heartbeat
 * @version 3.0.0
 */

import { z } from 'zod';
import { getRooSyncService } from '../../services/RooSyncService.js';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';

/**
 * Schema de validation pour roosync_register_heartbeat
 */
export const RegisterHeartbeatArgsSchema = z.object({
  machineId: z.string()
    .describe('Identifiant de la machine'),
  metadata: z.record(z.any()).optional()
    .describe('Métadonnées optionnelles à associer au heartbeat')
});

export type RegisterHeartbeatArgs = z.infer<typeof RegisterHeartbeatArgsSchema>;

/**
 * Schema de retour pour roosync_register_heartbeat
 */
export const RegisterHeartbeatResultSchema = z.object({
  success: z.boolean()
    .describe('Indique si l\'enregistrement a réussi'),
  machineId: z.string()
    .describe('Identifiant de la machine'),
  timestamp: z.string()
    .describe('Timestamp du heartbeat (ISO 8601)'),
  status: z.enum(['online', 'offline', 'warning'])
    .describe('Statut de la machine après l\'enregistrement'),
  isNewMachine: z.boolean()
    .describe('Indique si c\'est une nouvelle machine')
});

export type RegisterHeartbeatResult = z.infer<typeof RegisterHeartbeatResultSchema>;

/**
 * Outil roosync_register_heartbeat
 *
 * Enregistre un heartbeat pour une machine spécifique.
 * Si la machine n'existe pas, elle est créée automatiquement.
 *
 * @param args Arguments validés
 * @returns Résultat de l'enregistrement
 * @throws {HeartbeatServiceError} En cas d'erreur
 */
export async function roosyncRegisterHeartbeat(args: RegisterHeartbeatArgs): Promise<RegisterHeartbeatResult> {
  try {
    const rooSyncService = getRooSyncService();
    const heartbeatService = rooSyncService.getHeartbeatService();

    // Vérifier si la machine existe déjà
    const existingData = heartbeatService.getHeartbeatData(args.machineId);
    const isNewMachine = !existingData;

    // Enregistrer le heartbeat
    await heartbeatService.registerHeartbeat(args.machineId, args.metadata);

    // Récupérer les données mises à jour
    const updatedData = heartbeatService.getHeartbeatData(args.machineId);

    if (!updatedData) {
      throw new HeartbeatServiceError(
        'Impossible de récupérer les données après enregistrement',
        'HEARTBEAT_RETRIEVAL_FAILED'
      );
    }

    return {
      success: true,
      machineId: args.machineId,
      timestamp: updatedData.lastHeartbeat,
      status: updatedData.status,
      isNewMachine
    };
  } catch (error) {
    if (error instanceof HeartbeatServiceError) {
      throw error;
    }

    throw new HeartbeatServiceError(
      `Erreur lors de l'enregistrement du heartbeat: ${(error as Error).message}`,
      'HEARTBEAT_REGISTRATION_FAILED'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const registerHeartbeatToolMetadata = {
  name: 'roosync_register_heartbeat',
  description: 'Enregistre un heartbeat pour une machine dans le système RooSync. Si la machine n\'existe pas, elle est créée automatiquement.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      machineId: {
        type: 'string',
        description: 'Identifiant de la machine'
      },
      metadata: {
        type: 'object',
        description: 'Métadonnées optionnelles à associer au heartbeat'
      }
    },
    required: ['machineId'],
    additionalProperties: false
  }
};
