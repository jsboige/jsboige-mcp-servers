/**
 * Outil MCP : roosync_heartbeat_status
 *
 * État complet du service de heartbeat (machines online, unknown, idle).
 *
 * @module tools/roosync/heartbeat-status
 * @version 3.1.0
 */

import { z } from 'zod';
import { getRooSyncService } from '../../services/lazy-roosync.js';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';

/**
 * Schema de validation pour roosync_heartbeat_status
 */
export const HeartbeatStatusArgsSchema = z.object({
  filter: z.enum(['all', 'online', 'unknown', 'idle']).optional()
    .describe('Filtrer par statut de machine (defaut: all)'),
  includeHeartbeats: z.boolean().optional()
    .describe('Inclure les donnees de heartbeat de chaque machine (defaut: true)'),
  forceCheck: z.boolean().optional()
    .describe('Forcer une verification immediate des heartbeats (defaut: false)'),
  includeChanges: z.boolean().optional()
    .describe('Inclure les changements de statut recents (defaut: false)')
});

export type HeartbeatStatusArgs = z.infer<typeof HeartbeatStatusArgsSchema>;

/**
 * Donnees de heartbeat d'une machine
 */
export const HeartbeatDataSchema = z.object({
  machineId: z.string()
    .describe('Identifiant de la machine'),
  lastHeartbeat: z.string()
    .describe('Timestamp du dernier heartbeat (ISO 8601)'),
  status: z.enum(['online', 'unknown', 'idle'])
    .describe('Statut de la machine'),
  missedHeartbeats: z.number()
    .describe('Nombre de heartbeats manques consecutifs'),
  offlineSince: z.string().optional()
    .describe('Timestamp de premiere detection offline (ISO 8601)'),
  metadata: z.object({
    firstSeen: z.string()
      .describe('Timestamp de premiere detection (ISO 8601)'),
    lastUpdated: z.string()
      .describe('Timestamp de derniere mise a jour (ISO 8601)'),
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
    .describe('Timestamp de la derniere verification (ISO 8601)')
});

export type HeartbeatStatistics = z.infer<typeof HeartbeatStatisticsSchema>;

/**
 * Changements de statut (si forceCheck ou includeChanges)
 */
export const StatusChangesSchema = z.object({
  newlyUnknownMachines: z.array(z.string())
    .describe('Machines nouvellement detectees offline'),
  newlyOnlineMachines: z.array(z.string())
    .describe('Machines redevenues online'),
  newWarnings: z.array(z.string())
    .describe('Nouvelles machines en avertissement'),
  totalChanges: z.number()
    .describe('Nombre total de changements')
});

export type StatusChanges = z.infer<typeof StatusChangesSchema>;

/**
 * Schema de retour pour roosync_heartbeat_status
 */
export const HeartbeatStatusResultSchema = z.object({
  success: z.boolean()
    .describe('Indique si la recuperation a reussi'),
  onlineMachines: z.array(z.string())
    .describe('Liste des IDs des machines online'),
  unknownMachines: z.array(z.string())
    .describe('Liste des IDs des machines offline'),
  idleMachines: z.array(z.string())
    .describe('Liste des IDs des machines en avertissement'),
  statistics: HeartbeatStatisticsSchema
    .describe('Statistiques du service'),
  heartbeats: z.record(HeartbeatDataSchema).optional()
    .describe('Donnees de heartbeat par machine (si includeHeartbeats=true)'),
  changes: StatusChangesSchema.optional()
    .describe('Changements de statut (si forceCheck ou includeChanges)'),
  retrievedAt: z.string()
    .describe('Timestamp de la recuperation (ISO 8601)')
});

export type HeartbeatStatusResult = z.infer<typeof HeartbeatStatusResultSchema>;

/**
 * Outil roosync_heartbeat_status
 *
 * Outil consolide pour obtenir l'etat complet du service de heartbeat.
 * Remplace: get-heartbeat-state, check-heartbeats, get-offline-machines, get-warning-machines
 *
 * @param args Arguments valides
 * @returns Etat complet du service de heartbeat
 * @throws {HeartbeatServiceError} En cas d'erreur
 */
export async function roosyncHeartbeatStatus(args: HeartbeatStatusArgs): Promise<HeartbeatStatusResult> {
  try {
    const {
      filter = 'all',
      includeHeartbeats = true,
      forceCheck = false,
      includeChanges = false
    } = args;

    const rooSyncService = await getRooSyncService();
    const heartbeatService = rooSyncService.getHeartbeatService();
    const retrievedAt = new Date().toISOString();

    // Si forceCheck, effectuer une verification des heartbeats
    let changes: StatusChanges | undefined;
    if (forceCheck || includeChanges) {
      const checkResult = await heartbeatService.checkHeartbeats();
      changes = {
        newlyUnknownMachines: checkResult.newlyUnknownMachines,
        newlyOnlineMachines: checkResult.newlyOnlineMachines,
        newWarnings: checkResult.idleMachines,
        totalChanges: checkResult.newlyUnknownMachines.length +
                      checkResult.newlyOnlineMachines.length +
                      checkResult.idleMachines.length
      };
    }

    // Recuperer l'etat actuel
    const state = heartbeatService.getState();

    // Appliquer le filtre si necessaire
    let onlineMachines = state.onlineMachines;
    let unknownMachines = state.unknownMachines;
    let idleMachines = state.idleMachines;

    if (filter === 'online') {
      unknownMachines = [];
      idleMachines = [];
    } else if (filter === 'unknown') {
      onlineMachines = [];
      idleMachines = [];
    } else if (filter === 'idle') {
      onlineMachines = [];
      unknownMachines = [];
    }

    // Filtrer les heartbeats si necessaire
    let heartbeats: Record<string, HeartbeatData> | undefined;
    if (includeHeartbeats) {
      const allHeartbeats = Object.fromEntries(state.heartbeats);
      if (filter === 'all') {
        heartbeats = allHeartbeats;
      } else {
        const filteredIds = filter === 'online' ? onlineMachines :
                           filter === 'unknown' ? unknownMachines :
                           idleMachines;
        heartbeats = {};
        for (const id of filteredIds) {
          if (allHeartbeats[id]) {
            heartbeats[id] = allHeartbeats[id];
          }
        }
      }
    }

    return {
      success: true,
      onlineMachines,
      unknownMachines,
      idleMachines,
      statistics: state.statistics,
      heartbeats,
      changes,
      retrievedAt
    };
  } catch (error) {
    if (error instanceof HeartbeatServiceError) {
      throw error;
    }

    throw new HeartbeatServiceError(
      `Erreur lors de la recuperation du statut heartbeat: ${(error as Error).message}`,
      'HEARTBEAT_STATUS_FAILED'
    );
  }
}

/**
 * Metadonnees de l'outil pour l'enregistrement MCP
 */
export const heartbeatStatusToolMetadata = {
  name: 'roosync_heartbeat_status',
  description: 'État complet du service de heartbeat (machines online, unknown, idle, heartbeats).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      filter: {
        type: 'string',
        enum: ['all', 'online', 'unknown', 'idle'],
        description: 'Filtrer par statut de machine (defaut: all)'
      },
      includeHeartbeats: {
        type: 'boolean',
        description: 'Inclure les donnees de heartbeat de chaque machine (defaut: true)'
      },
      forceCheck: {
        type: 'boolean',
        description: 'Forcer une verification immediate des heartbeats (defaut: false)'
      },
      includeChanges: {
        type: 'boolean',
        description: 'Inclure les changements de statut recents (defaut: false)'
      }
    },
    additionalProperties: false
  }
};
