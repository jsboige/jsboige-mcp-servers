/**
 * Outil MCP : roosync_compare_config
 * 
 * Compare la configuration locale avec une autre machine.
 * 
 * @module tools/roosync/compare-config
 * @version 2.0.0
 */

import { z } from 'zod';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';

/**
 * Schema de validation pour roosync_compare_config
 */
export const CompareConfigArgsSchema = z.object({
  targetMachine: z.string().optional()
    .describe('ID de la machine cible (auto-sélection si non spécifié)')
});

export type CompareConfigArgs = z.infer<typeof CompareConfigArgsSchema>;

/**
 * Schema de retour pour roosync_compare_config
 */
export const CompareConfigResultSchema = z.object({
  localMachine: z.string().describe('Machine locale'),
  targetMachine: z.string().describe('Machine cible'),
  differences: z.array(z.object({
    field: z.string().describe('Nom du champ différent'),
    localValue: z.any().describe('Valeur locale'),
    targetValue: z.any().describe('Valeur cible'),
    type: z.enum(['added', 'removed', 'modified']).describe('Type de différence')
  })).describe('Liste des différences'),
  identical: z.boolean().describe('Configurations identiques ?')
});

export type CompareConfigResult = z.infer<typeof CompareConfigResultSchema>;

/**
 * Outil roosync_compare_config
 * 
 * Compare la configuration locale avec une autre machine spécifiée.
 * Si aucune machine n'est spécifiée, sélectionne automatiquement la première
 * machine disponible différente de la machine locale.
 * 
 * @param args Arguments validés
 * @returns Résultat de la comparaison
 * @throws {RooSyncServiceError} En cas d'erreur
 */
export async function roosyncCompareConfig(args: CompareConfigArgs): Promise<CompareConfigResult> {
  try {
    const service = getRooSyncService();
    const result = await service.compareConfig(args.targetMachine);
    
    return {
      ...result,
      differences: result.differences.map(d => ({
        field: d.field,
        localValue: d.localValue,
        targetValue: d.targetValue,
        type: determineChangeType(d)
      })),
      identical: result.differences.length === 0
    };
  } catch (error) {
    if (error instanceof RooSyncServiceError) {
      throw error;
    }
    
    throw new RooSyncServiceError(
      `Erreur lors de la comparaison: ${(error as Error).message}`,
      'ROOSYNC_COMPARE_ERROR'
    );
  }
}

/**
 * Détermine le type de changement en analysant les valeurs
 */
function determineChangeType(diff: { field: string; localValue: any; targetValue: any }): 'added' | 'removed' | 'modified' {
  if (diff.localValue === undefined || diff.localValue === null) {
    return 'removed';
  }
  if (diff.targetValue === undefined || diff.targetValue === null) {
    return 'added';
  }
  return 'modified';
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const compareConfigToolMetadata = {
  name: 'roosync_compare_config',
  description: 'Comparer la configuration locale avec une autre machine',
  inputSchema: CompareConfigArgsSchema,
  outputSchema: CompareConfigResultSchema
};