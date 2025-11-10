/**
 * Outil MCP : roosync_reset_service
 * 
 * Réinitialise l'instance singleton RooSyncService pour forcer
 * le rechargement du code après modification.
 * 
 * @module tools/roosync/reset-service
 * @version 2.0.0
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { RooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';

/**
 * Schema de validation pour roosync_reset_service
 */
export const ResetServiceArgsSchema = z.object({
  confirm: z.boolean().default(false).describe('Confirmation pour réinitialiser le service')
});

export type ResetServiceArgs = z.infer<typeof ResetServiceArgsSchema>;

/**
 * Schema de retour pour roosync_reset_service
 */
export const ResetServiceResultSchema = z.object({
  success: z.boolean().describe('Succès de la réinitialisation'),
  message: z.string().describe('Message détaillé sur l\'opération'),
  details: z.object({
    timestamp: z.string().describe('Timestamp de l\'opération'),
    action: z.string().describe('Action effectuée'),
    effect: z.string().describe('Effet de l\'opération')
  }).optional().describe('Détails supplémentaires')
});

export type ResetServiceResult = z.infer<typeof ResetServiceResultSchema>;

/**
 * Outil roosync_reset_service
 * 
 * Réinitialise l'instance singleton RooSyncService pour forcer
 * le rechargement du code après modification.
 * 
 * @param args Arguments validés
 * @returns Résultat de la réinitialisation
 * @throws {RooSyncServiceError} En cas d'erreur
 */
export async function roosyncResetService(args: ResetServiceArgs): Promise<ResetServiceResult> {
  try {
    console.log('[RESET-SERVICE] roosyncResetService appelé à', new Date().toISOString());
    
    if (!args.confirm) {
      return {
        success: false,
        message: 'Veuillez confirmer avec confirm: true pour réinitialiser le service'
      };
    }
    
    console.log('[RESET-SERVICE] Réinitialisation de l\'instance RooSyncService...');
    
    // Réinitialiser l'instance singleton
    RooSyncService.resetInstance();
    
    console.log('[RESET-SERVICE] Instance réinitialisée avec succès');
    
    return {
      success: true,
      message: 'Instance RooSyncService réinitialisée avec succès',
      details: {
        timestamp: new Date().toISOString(),
        action: 'reset_instance',
        effect: 'Le prochain appel à getRooSyncService() créera une nouvelle instance avec le code à jour'
      }
    };
    
  } catch (error) {
    console.error('[RESET-SERVICE] Erreur lors de la réinitialisation:', error);
    
    if (error instanceof RooSyncServiceError) {
      throw error;
    }
    
    throw new RooSyncServiceError(
      `Erreur lors de la réinitialisation du service: ${(error as Error).message}`,
      'ROOSYNC_RESET_ERROR'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 * Utilise Zod.shape natif pour compatibilité MCP
 */
export const resetServiceToolMetadata = {
  name: 'roosync_reset_service',
  description: 'Réinitialise l\'instance singleton RooSyncService (outil de debug)',
  inputSchema: {
    type: 'object' as const,
    properties: {
      confirm: {
        type: 'boolean',
        description: 'Confirmation pour réinitialiser le service',
        default: false
      }
    },
    additionalProperties: false
  }
};