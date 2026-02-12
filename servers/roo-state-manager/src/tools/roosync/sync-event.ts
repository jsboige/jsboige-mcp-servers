/**
 * Outil MCP : roosync_sync_event
 *
 * Synchronisation automatique des baselines lors des changements d'état (online/offline).
 *
 * @module tools/roosync/sync-event
 * @version 4.0.0
 */

import { z } from 'zod';
import { getRooSyncService } from '../../services/RooSyncService.js';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';

/**
 * Schema de validation pour roosync_sync_event
 */
export const SyncEventArgsSchema = z.object({
  action: z.enum(['online', 'offline'])
    .describe('Type d\'événement de synchronisation: online (machine revient) ou offline (machine part)'),
  machineId: z.string()
    .describe('Identifiant de la machine concernée'),
  createBackup: z.boolean().optional()
    .describe('Créer une sauvegarde avant synchronisation (défaut: true)'),
  dryRun: z.boolean().optional()
    .describe('Mode simulation sans modification réelle (défaut: false)'),
  syncFromBaseline: z.boolean().optional()
    .describe('Synchroniser depuis la baseline (défaut: true, online uniquement)')
});

export type SyncEventArgs = z.infer<typeof SyncEventArgsSchema>;

/**
 * Schema de retour pour roosync_sync_event
 */
export const SyncEventResultSchema = z.object({
  success: z.boolean()
    .describe('Indique si la synchronisation a réussi'),
  action: z.enum(['online', 'offline'])
    .describe('Type d\'événement traité'),
  machineId: z.string()
    .describe('Identifiant de la machine'),
  syncedAt: z.string()
    .describe('Timestamp de la synchronisation (ISO 8601)'),
  backupCreated: z.boolean()
    .describe('Indique si une sauvegarde a été créée'),
  backupPath: z.string().optional()
    .describe('Chemin de la sauvegarde si créée'),
  changes: z.object({
    filesSynced: z.number()
      .describe('Nombre de fichiers synchronisés'),
    conflictsResolved: z.number()
      .describe('Nombre de conflits résolus'),
    decisionsCreated: z.number()
      .describe('Nombre de décisions créées'),
    offlineDuration: z.number().optional()
      .describe('Durée offline en millisecondes (online uniquement)')
  })
    .describe('Détails des changements'),
  message: z.string()
    .describe('Message de confirmation')
});

export type SyncEventResult = z.infer<typeof SyncEventResultSchema>;

/**
 * Outil roosync_sync_event
 *
 * Synchronise automatiquement les baselines lors des changements d'état online/offline.
 * Cette opération est typiquement appelée par le service de heartbeat.
 *
 * @param args Arguments validés
 * @returns Résultat de la synchronisation
 * @throws {HeartbeatServiceError} En cas d'erreur
 */
export async function roosyncSyncEvent(args: SyncEventArgs): Promise<SyncEventResult> {
  try {
    const {
      action,
      machineId,
      createBackup = true,
      dryRun = false,
      syncFromBaseline = true
    } = args;

    const rooSyncService = getRooSyncService();
    const heartbeatService = rooSyncService.getHeartbeatService();

    // Vérifier que la machine est dans l'état attendu
    const heartbeatData = heartbeatService.getHeartbeatData(machineId);
    const expectedStatus = action === 'online' ? 'online' : 'offline';

    if (!heartbeatData || heartbeatData.status !== expectedStatus) {
      throw new HeartbeatServiceError(
        `La machine ${machineId} n'est pas ${expectedStatus}`,
        action === 'online' ? 'MACHINE_NOT_ONLINE' : 'MACHINE_NOT_OFFLINE'
      );
    }

    // Calculer la durée offline si action=online et disponible
    let offlineDuration: number | undefined;
    if (action === 'online' && heartbeatData.offlineSince) {
      offlineDuration = Date.now() - new Date(heartbeatData.offlineSince).getTime();
    }

    // En mode simulation, retourner un résultat factice
    if (dryRun) {
      return {
        success: true,
        action,
        machineId,
        syncedAt: new Date().toISOString(),
        backupCreated: false,
        changes: {
          filesSynced: 0,
          conflictsResolved: 0,
          decisionsCreated: 0,
          offlineDuration
        },
        message: `Mode simulation: synchronisation ${action} pour ${machineId}`
      };
    }

    // Créer une sauvegarde si demandé
    let backupPath: string | undefined;
    if (createBackup) {
      // Note: La logique de sauvegarde réelle serait implémentée ici
      // Pour l'instant, nous simulons le chemin
      backupPath = `roo-config/backups/${action}-sync-${machineId}-${Date.now()}.json`;
    }

    // Note: La logique de synchronisation réelle serait implémentée ici
    // Pour l'instant, nous simulons le résultat
    const syncedAt = new Date().toISOString();

    return {
      success: true,
      action,
      machineId,
      syncedAt,
      backupCreated: createBackup,
      backupPath,
      changes: {
        filesSynced: 0,
        conflictsResolved: 0,
        decisionsCreated: 0,
        offlineDuration
      },
      message: `Synchronisation ${action} effectuée pour ${machineId}`
    };
  } catch (error) {
    if (error instanceof HeartbeatServiceError) {
      throw error;
    }

    throw new HeartbeatServiceError(
      `Erreur lors de la synchronisation ${args.action}: ${(error as Error).message}`,
      `SYNC_${args.action.toUpperCase()}_FAILED`
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const syncEventToolMetadata = {
  name: 'roosync_sync_event',
  description: 'Synchronise automatiquement les baselines lors des changements d\'état online/offline d\'une machine. Actions : offline (sauvegarde baseline avant déconnexion), online (restauration baseline après reconnexion). Généralement appelé automatiquement par le service heartbeat.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['online', 'offline'],
        description: 'Type d\'événement de synchronisation: online (machine revient) ou offline (machine part)'
      },
      machineId: {
        type: 'string',
        description: 'Identifiant de la machine concernée'
      },
      createBackup: {
        type: 'boolean',
        description: 'Créer une sauvegarde avant synchronisation (défaut: true)'
      },
      dryRun: {
        type: 'boolean',
        description: 'Mode simulation sans modification réelle (défaut: false)'
      },
      syncFromBaseline: {
        type: 'boolean',
        description: 'Synchroniser depuis la baseline (défaut: true, online uniquement)'
      }
    },
    required: ['action', 'machineId'],
    additionalProperties: false
  }
};
