/**
 * Outil MCP : roosync_list_diffs
 * 
 * Liste les différences détectées entre machines.
 * 
 * @module tools/roosync/list-diffs
 * @version 2.0.0
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';

/**
 * Schema de validation pour roosync_list_diffs
 */
export const ListDiffsArgsSchema = z.object({
  filterType: z.enum(['all', 'config', 'files', 'settings']).optional()
    .default('all')
    .describe('Filtrer par type de différence')
});

export type ListDiffsArgs = z.infer<typeof ListDiffsArgsSchema>;

/**
 * Schema de retour pour roosync_list_diffs
 */
export const ListDiffsResultSchema = z.object({
  totalDiffs: z.number().describe('Nombre total de différences'),
  diffs: z.array(z.object({
    type: z.string().describe('Type de différence'),
    path: z.string().describe('Chemin du fichier'),
    description: z.string().describe('Description'),
    machines: z.array(z.string()).describe('Machines concernées'),
    severity: z.enum(['low', 'medium', 'high']).optional().describe('Niveau de sévérité')
  })).describe('Liste détaillée des différences'),
  filterApplied: z.string().describe('Filtre appliqué')
});

export type ListDiffsResult = z.infer<typeof ListDiffsResultSchema>;

/**
 * Outil roosync_list_diffs
 * 
 * Liste les différences détectées entre machines, avec possibilité de filtrer
 * par type (config, files, settings).
 * 
 * @param args Arguments validés
 * @returns Liste des différences
 * @throws {RooSyncServiceError} En cas d'erreur
 */
export async function roosyncListDiffs(args: ListDiffsArgs): Promise<ListDiffsResult> {
  try {
    const service = getRooSyncService();
    const result = await service.listDiffs(args.filterType);
    
    return {
      totalDiffs: result.totalDiffs,
      diffs: result.diffs.map(d => ({
        ...d,
        severity: determineSeverity(d.type)
      })),
      filterApplied: args.filterType || 'all'
    };
  } catch (error) {
    if (error instanceof RooSyncServiceError) {
      throw error;
    }
    
    throw new RooSyncServiceError(
      `Erreur lors du listing: ${(error as Error).message}`,
      'ROOSYNC_LIST_ERROR'
    );
  }
}

/**
 * Détermine la sévérité d'une différence selon son type
 * 
 * @param type Type de différence
 * @returns Niveau de sévérité
 */
function determineSeverity(type: string): 'low' | 'medium' | 'high' {
  // Mappage type -> sévérité selon spécifications
  if (type === 'config') return 'high';
  if (type === 'hardware') return 'medium';
  if (type === 'software') return 'medium';
  return 'low';
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 * Utilise Zod.shape natif pour compatibilité MCP
 */
export const listDiffsToolMetadata = {
  name: 'roosync_list_diffs',
  description: 'Lister les différences détectées entre machines',
  inputSchema: {
    type: 'object' as const,
    properties: {
      filterType: {
        type: 'string',
        enum: ['all', 'config', 'files', 'settings'],
        description: 'Filtrer par type de différence',
        default: 'all'
      }
    },
    additionalProperties: false
  }
};