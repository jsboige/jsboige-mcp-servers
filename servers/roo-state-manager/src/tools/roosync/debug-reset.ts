/**
 * Outil MCP : roosync_debug_reset
 * 
 * Outil consolidé combinant debug-dashboard et reset-service.
 * Permet de déboguer le dashboard et de réinitialiser le service.
 * 
 * @module tools/roosync/debug-reset
 * @version 2.3.0
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { RooSyncService, RooSyncServiceError, getRooSyncService } from '../../services/lazy-roosync.js';

/**
 * Schema de validation pour roosync_debug_reset
 */
export const DebugResetArgsSchema = z.object({
  action: z.enum(['debug', 'reset'])
    .describe('Action à effectuer: debug (dashboard) ou reset (service)'),
  clearCache: z.boolean().default(false)
    .describe('Vider le cache du service (défaut: false)'),
  verbose: z.boolean().default(false)
    .describe('Mode verbeux pour debug (défaut: false)'),
  confirm: z.boolean().default(false)
    .describe('Confirmation pour reset (défaut: false)')
});

export type DebugResetArgs = z.infer<typeof DebugResetArgsSchema>;

/**
 * Schema de retour pour roosync_debug_reset
 */
export const DebugResetResultSchema = z.object({
  action: z.string().describe('Action effectuée'),
  success: z.boolean().describe('Succès de l\'opération'),
  message: z.string().describe('Message détaillé'),
  timestamp: z.string().describe('Timestamp de l\'opération'),
  machineId: z.string().describe('ID de la machine'),
  debugInfo: z.object({
    instanceForced: z.boolean().describe('Instance forcée'),
    cacheDisabled: z.boolean().describe('Cache désactivé'),
    cacheCleared: z.boolean().describe('Cache vidé')
  }).optional().describe('Informations de debug')
});

export type DebugResetResult = z.infer<typeof DebugResetResultSchema>;

/**
 * Outil roosync_debug_reset
 * 
 * Outil consolidé combinant debug-dashboard et reset-service.
 * 
 * @param args Arguments validés
 * @returns Résultat de l'opération
 * @throws {RooSyncServiceError} En cas d'erreur
 */
export async function roosync_debug_reset(args: DebugResetArgs): Promise<DebugResetResult> {
  try {
    const timestamp = new Date().toISOString();
    const service = await getRooSyncService();
    const config = service.getConfig();

    if (args.action === 'debug') {
      return await handleDebugAction(args, timestamp, config);
    } else if (args.action === 'reset') {
      return await handleResetAction(args, timestamp, config);
    } else {
      throw new RooSyncServiceError(
        `Action non supportée: ${args.action}`,
        'INVALID_ACTION'
      );
    }
  } catch (error) {
    if (error instanceof RooSyncServiceError) {
      throw error;
    }
    
    throw new RooSyncServiceError(
      `Erreur lors de l'opération: ${(error as Error).message}`,
      'ROOSYNC_DEBUG_RESET_ERROR'
    );
  }
}

/**
 * Gère l'action debug
 */
async function handleDebugAction(
  args: DebugResetArgs,
  timestamp: string,
  config: any
): Promise<DebugResetResult> {
  await RooSyncService.resetInstance();

  let service: Awaited<ReturnType<typeof RooSyncService.getInstance>> | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    service = await RooSyncService.getInstance({ enabled: false });
    if (service) break;
    await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
  }

  if (!service) {
    throw new RooSyncServiceError('debug-reset', 'Failed to create new RooSyncService instance after reset');
  }

  await service.loadDashboard();
  
  return {
    action: 'debug',
    success: true,
    message: 'Dashboard debuggé avec succès',
    timestamp,
    machineId: config.machineId,
    debugInfo: {
      instanceForced: true,
      cacheDisabled: true,
      cacheCleared: args.clearCache
    }
  };
}

/**
 * Gère l'action reset
 */
async function handleResetAction(
  args: DebugResetArgs,
  timestamp: string,
  config: any
): Promise<DebugResetResult> {
  if (!args.confirm) {
    return {
      action: 'reset',
      success: false,
      message: 'Veuillez confirmer avec confirm: true pour réinitialiser le service',
      timestamp,
      machineId: config.machineId
    };
  }
  
  await RooSyncService.resetInstance();

  if (args.clearCache) {
    const service = await getRooSyncService();
    service.clearCache();
  }
  
  return {
    action: 'reset',
    success: true,
    message: 'Instance RooSyncService réinitialisée avec succès',
    timestamp,
    machineId: config.machineId,
    debugInfo: {
      instanceForced: true,
      cacheDisabled: false,
      cacheCleared: args.clearCache
    }
  };
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const debugResetToolMetadata = {
  name: 'roosync_debug_reset',
  description: 'Outil consolidé pour déboguer le dashboard et réinitialiser le service RooSync',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['debug', 'reset'],
        description: 'Action à effectuer: debug (dashboard) ou reset (service)'
      },
      clearCache: {
        type: 'boolean',
        description: 'Vider le cache du service (défaut: false)',
        default: false
      },
      verbose: {
        type: 'boolean',
        description: 'Mode verbeux pour debug (défaut: false)',
        default: false
      },
      confirm: {
        type: 'boolean',
        description: 'Confirmation pour reset (défaut: false)',
        default: false
      }
    },
    required: ['action'],
    additionalProperties: false
  }
};
