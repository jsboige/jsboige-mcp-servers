/**
 * Outil MCP : roosync_heartbeat
 *
 * CONS-#443 Groupe 1 : Consolidation de heartbeat_status + heartbeat_service
 * Gestion complète du heartbeat : status (lecture) ET service (gestion).
 *
 * @module tools/roosync/heartbeat
 * @version 1.0.0
 */

import { z } from 'zod';
import {
  roosyncHeartbeatStatus,
  HeartbeatStatusArgs,
  HeartbeatStatusResult
} from './heartbeat-status.js';
import {
  roosyncHeartbeatService,
  HeartbeatServiceArgs,
  HeartbeatServiceResult
} from './heartbeat-service.js';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';

// ====================================================================
// SCHEMAS DE VALIDATION
// ====================================================================

export const HeartbeatArgsSchema = z.object({
  action: z.enum(['status', 'register', 'start', 'stop'])
    .describe('Type d\'opération: status (état), register (enregistrer), start (démarrer), stop (arrêter)'),

  // Paramètres pour action: 'status'
  filter: z.enum(['all', 'online', 'offline', 'warning']).optional()
    .describe('Filtrer par statut de machine (action: status)'),
  includeHeartbeats: z.boolean().optional()
    .describe('Inclure les données de heartbeat (action: status)'),
  forceCheck: z.boolean().optional()
    .describe('Forcer une vérification immédiate (action: status)'),
  includeChanges: z.boolean().optional()
    .describe('Inclure les changements de statut (action: status)'),

  // Paramètres pour actions: 'register', 'start'
  machineId: z.string().optional()
    .describe('Identifiant de la machine (requis pour register, start)'),

  // Paramètres pour action: 'register'
  metadata: z.record(z.any()).optional()
    .describe('Métadonnées optionnelles (action: register)'),

  // Paramètres pour action: 'start'
  enableAutoSync: z.boolean().optional()
    .describe('Activer la synchronisation automatique (action: start)'),
  heartbeatInterval: z.number().optional()
    .describe('Intervalle de heartbeat en ms (action: start)'),
  offlineTimeout: z.number().optional()
    .describe('Timeout offline en ms (action: start)'),

  // Paramètres pour action: 'stop'
  saveState: z.boolean().optional()
    .describe('Sauvegarder l\'état avant arrêt (action: stop)')
});

export type HeartbeatArgs = z.infer<typeof HeartbeatArgsSchema>;

export const HeartbeatResultSchema = z.object({
  success: z.boolean()
    .describe('Indique si l\'opération a réussi'),
  action: z.enum(['status', 'register', 'start', 'stop'])
    .describe('Type d\'opération effectuée'),
  timestamp: z.string()
    .describe('Timestamp de l\'opération (ISO 8601)'),
  message: z.string().optional()
    .describe('Message de résultat'),
  data: z.any().optional()
    .describe('Données retournées par l\'opération')
});

export type HeartbeatResult = z.infer<typeof HeartbeatResultSchema>;

// ====================================================================
// IMPLÉMENTATION PRINCIPALE
// ====================================================================

/**
 * Outil principal de gestion du heartbeat
 * Délègue aux handlers existants heartbeat-status et heartbeat-service
 *
 * @param args Arguments de l'outil
 */
export async function roosyncHeartbeat(args: HeartbeatArgs): Promise<HeartbeatResult> {
  try {
    const { action } = args;
    const timestamp = new Date().toISOString();

    switch (action) {
      case 'status':
        return await handleStatusAction(args, timestamp);

      case 'register':
      case 'start':
      case 'stop':
        return await handleServiceAction(args, timestamp);

      default:
        throw new HeartbeatServiceError(
          `Action non reconnue: ${action}`,
          'UNKNOWN_ACTION'
        );
    }
  } catch (error) {
    if (error instanceof HeartbeatServiceError) {
      throw error;
    }

    throw new HeartbeatServiceError(
      `Erreur lors de l'opération de heartbeat ${args.action}: ${(error as Error).message}`,
      `HEARTBEAT_${args.action.toUpperCase()}_FAILED`
    );
  }
}

/**
 * Gère l'action 'status' (lecture de l'état)
 */
async function handleStatusAction(
  args: HeartbeatArgs,
  timestamp: string
): Promise<HeartbeatResult> {
  const statusArgs: HeartbeatStatusArgs = {
    filter: args.filter,
    includeHeartbeats: args.includeHeartbeats,
    forceCheck: args.forceCheck,
    includeChanges: args.includeChanges
  };

  const result: HeartbeatStatusResult = await roosyncHeartbeatStatus(statusArgs);

  return {
    success: result.success,
    action: 'status',
    timestamp,
    message: `État du heartbeat récupéré avec succès`,
    data: result
  };
}

/**
 * Gère les actions de service (register, start, stop)
 */
async function handleServiceAction(
  args: HeartbeatArgs,
  timestamp: string
): Promise<HeartbeatResult> {
  const { action } = args;

  const serviceArgs: HeartbeatServiceArgs = {
    action: action as 'register' | 'start' | 'stop',
    machineId: args.machineId,
    metadata: args.metadata,
    enableAutoSync: args.enableAutoSync,
    heartbeatInterval: args.heartbeatInterval,
    offlineTimeout: args.offlineTimeout,
    saveState: args.saveState
  };

  const result: HeartbeatServiceResult = await roosyncHeartbeatService(serviceArgs);

  return {
    success: result.success,
    action: action as 'register' | 'start' | 'stop',
    timestamp,
    message: result.message,
    data: result.result
  };
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const heartbeatToolMetadata = {
  name: 'roosync_heartbeat',
  description: 'Gestion complète du heartbeat Roo : status (état), register (enregistrer), start (démarrer), stop (arrêter). Consolidation (CONS-#443 Groupe 1) de heartbeat_status + heartbeat_service.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'register', 'start', 'stop'],
        description: 'Type d\'opération: status (état), register (enregistrer), start (démarrer), stop (arrêter)'
      },
      filter: {
        type: 'string',
        enum: ['all', 'online', 'offline', 'warning'],
        description: 'Filtrer par statut de machine (action: status)'
      },
      includeHeartbeats: {
        type: 'boolean',
        description: 'Inclure les données de heartbeat de chaque machine (action: status)'
      },
      forceCheck: {
        type: 'boolean',
        description: 'Forcer une vérification immédiate des heartbeats (action: status)'
      },
      includeChanges: {
        type: 'boolean',
        description: 'Inclure les changements de statut récents (action: status)'
      },
      machineId: {
        type: 'string',
        description: 'Identifiant de la machine (requis pour register, start)'
      },
      metadata: {
        type: 'object',
        description: 'Métadonnées optionnelles à associer au heartbeat (action: register)'
      },
      enableAutoSync: {
        type: 'boolean',
        description: 'Activer la synchronisation automatique (action: start)'
      },
      heartbeatInterval: {
        type: 'number',
        description: 'Intervalle de heartbeat en millisecondes (action: start)'
      },
      offlineTimeout: {
        type: 'number',
        description: 'Timeout avant de considérer une machine offline en ms (action: start)'
      },
      saveState: {
        type: 'boolean',
        description: 'Sauvegarder l\'état avant l\'arrêt (action: stop)'
      }
    },
    required: ['action'],
    additionalProperties: false
  }
};
