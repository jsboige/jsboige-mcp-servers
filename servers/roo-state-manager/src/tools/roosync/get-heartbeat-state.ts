/**
 * Outil MCP : roosync_get_heartbeat_state
 *
 * Obtient l'état complet du service de heartbeat dans le système RooSync.
 *
 * @module tools/roosync/get-heartbeat-state
 * @version 3.0.0
 */

import { z } from 'zod';
import { getRooSyncService } from '../../services/RooSyncService.js';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';

/**
 * Schema de validation pour roosync_get_heartbeat_state
 */
export const GetHeartbeatStateArgsSchema = z.object({
  includeHeartbeats: z.boolean().optional()
    .describe('Inclure les données de heartbeat de chaque machine (défaut: true)')
});

export type GetHeartbeatStateArgs = z.infer<typeof GetHeartbeatStateArgsSchema>;

/**
 * Données de heartbeat d'une machine
 */
export const HeartbeatDataSchema = z.object({
  machineId: z.string()
    .describe('Identifiant de la machine'),
  lastHeartbeat: z.string()
    .describe('Timestamp du dernier heartbeat (ISO 8601)'),
  status: z.enum(['online', 'offline', 'warning'])
    .describe('Statut de la machine'),
  missedHeartbeats: z.number()
    .describe('Nombre de heartbeats manqués consécutifs'),
  offlineSince: z.string().optional()
    .describe('Timestamp de première détection offline (ISO 8601)'),
  metadata: z.object({
    firstSeen: z.string()
      .describe('Timestamp de première détection (ISO 8601)'),
    lastUpdated: z.string()
      .describe('Timestamp de dernière mise à jour (ISO 8601)'),
    version: z.string()
      .describe('Version du service')
  })
});

export type HeartbeatData = z.infer<typeof HeartbeatDataSchema>;

/**
 * Statistiques du service de heartbeat
 */
export const HeartbeatStatisticsSchema = z.object({
  totalMachines: z.number()
    .describe('Nombre total de machines'),
  onlineCount: z.number()
    .describe('Nombre de machines online'),
  offlineCount: z.number()
    .describe('Nombre de machines offline'),
  warningCount: z.number()
    .describe('Nombre de machines en avertissement'),
  lastHeartbeatCheck: z.string()
    .describe('Timestamp de la dernière vérification (ISO 8601)')
});

export type HeartbeatStatistics = z.infer<typeof HeartbeatStatisticsSchema>;

/**
 * Schema de retour pour roosync_get_heartbeat_state
 */
export const GetHeartbeatStateResultSchema = z.object({
  success: z.boolean()
    .describe('Indique si la récupération a réussi'),
  onlineMachines: z.array(z.string())
    .describe('Liste des IDs des machines online'),
  offlineMachines: z.array(z.string())
    .describe('Liste des IDs des machines offline'),
  warningMachines: z.array(z.string())
    .describe('Liste des IDs des machines en avertissement'),
  statistics: HeartbeatStatisticsSchema
    .describe('Statistiques du service'),
  heartbeats: z.record(HeartbeatDataSchema).optional()
    .describe('Données de heartbeat par machine (si includeHeartbeats=true)'),
  retrievedAt: z.string()
    .describe('Timestamp de la récupération (ISO 8601)')
});

export type GetHeartbeatStateResult = z.infer<typeof GetHeartbeatStateResultSchema>;

/**
 * Outil roosync_get_heartbeat_state
 *
 * Obtient l'état complet du service de heartbeat.
 * Inclut les listes de machines par statut et les statistiques.
 *
 * @param args Arguments validés
 * @returns État complet du service de heartbeat
 * @throws {HeartbeatServiceError} En cas d'erreur
 */
export async function roosyncGetHeartbeatState(args: GetHeartbeatStateArgs): Promise<GetHeartbeatStateResult> {
  try {
    const { includeHeartbeats = true } = args;
    const rooSyncService = getRooSyncService();
    const heartbeatService = rooSyncService.getHeartbeatService();

    const state = heartbeatService.getState();
    const retrievedAt = new Date().toISOString();

    return {
      success: true,
      onlineMachines: state.onlineMachines,
      offlineMachines: state.offlineMachines,
      warningMachines: state.warningMachines,
      statistics: state.statistics,
      heartbeats: includeHeartbeats ? Object.fromEntries(state.heartbeats) : undefined,
      retrievedAt
    };
  } catch (error) {
    if (error instanceof HeartbeatServiceError) {
      throw error;
    }

    throw new HeartbeatServiceError(
      `Erreur lors de la récupération de l'état du heartbeat: ${(error as Error).message}`,
      'HEARTBEAT_GET_STATE_FAILED'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const getHeartbeatStateToolMetadata = {
  name: 'roosync_get_heartbeat_state',
  description: 'Obtient l\'état complet du service de heartbeat dans le système RooSync. Inclut les listes de machines par statut et les statistiques.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      includeHeartbeats: {
        type: 'boolean',
        description: 'Inclure les données de heartbeat de chaque machine (défaut: true)'
      }
    },
    additionalProperties: false
  }
};
