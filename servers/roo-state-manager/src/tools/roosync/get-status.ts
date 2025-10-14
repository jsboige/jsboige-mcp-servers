/**
 * Outil MCP : roosync_get_status
 * 
 * Obtient l'état de synchronisation actuel du système RooSync.
 * 
 * @module tools/roosync/get-status
 * @version 2.0.0
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';

/**
 * Schema de validation pour roosync_get_status
 */
export const GetStatusArgsSchema = z.object({
  machineFilter: z.string().optional()
    .describe('ID de machine pour filtrer les résultats (optionnel)')
});

export type GetStatusArgs = z.infer<typeof GetStatusArgsSchema>;

/**
 * Schema de retour pour roosync_get_status
 */
export const GetStatusResultSchema = z.object({
  status: z.enum(['synced', 'diverged', 'conflict', 'unknown'])
    .describe('État global de synchronisation'),
  
  lastSync: z.string()
    .describe('Date de dernière synchronisation (ISO 8601)'),
  
  machines: z.array(z.object({
    id: z.string().describe('ID de la machine'),
    status: z.enum(['online', 'offline', 'unknown']).describe('État de la machine'),
    lastSync: z.string().describe('Dernière synchronisation'),
    pendingDecisions: z.number().describe('Nombre de décisions en attente'),
    diffsCount: z.number().describe('Nombre de différences détectées')
  })).describe('Liste des machines synchronisées'),
  
  summary: z.object({
    totalMachines: z.number().describe('Nombre total de machines'),
    onlineMachines: z.number().describe('Machines en ligne'),
    totalDiffs: z.number().describe('Total des différences'),
    totalPendingDecisions: z.number().describe('Total des décisions en attente')
  }).optional().describe('Résumé statistique')
});

export type GetStatusResult = z.infer<typeof GetStatusResultSchema>;

/**
 * Outil roosync_get_status
 * 
 * Obtient l'état de synchronisation actuel, avec possibilité de filtrer
 * par machine spécifique.
 * 
 * @param args Arguments validés
 * @returns État de synchronisation
 * @throws {RooSyncServiceError} En cas d'erreur
 */
export async function roosyncGetStatus(args: GetStatusArgs): Promise<GetStatusResult> {
  try {
    const service = getRooSyncService();
    const dashboard = await service.loadDashboard();
    
    // Filtrer par machine si demandé
    let machines = Object.entries(dashboard.machines).map(([id, info]) => ({
      id,
      status: info.status,
      lastSync: info.lastSync,
      pendingDecisions: info.pendingDecisions,
      diffsCount: info.diffsCount
    }));
    
    if (args.machineFilter) {
      machines = machines.filter(m => m.id === args.machineFilter);
      
      if (machines.length === 0) {
        throw new RooSyncServiceError(
          `Machine '${args.machineFilter}' non trouvée`,
          'MACHINE_NOT_FOUND'
        );
      }
    }
    
    // Calculer le résumé
    const summary = {
      totalMachines: machines.length,
      onlineMachines: machines.filter(m => m.status === 'online').length,
      totalDiffs: machines.reduce((sum, m) => sum + m.diffsCount, 0),
      totalPendingDecisions: machines.reduce((sum, m) => sum + m.pendingDecisions, 0)
    };
    
    return {
      status: dashboard.overallStatus,
      lastSync: dashboard.lastUpdate,
      machines,
      summary
    };
  } catch (error) {
    if (error instanceof RooSyncServiceError) {
      throw error;
    }
    
    throw new RooSyncServiceError(
      `Erreur lors de la récupération du statut: ${(error as Error).message}`,
      'ROOSYNC_UNKNOWN_ERROR'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 * Utilise Zod.shape natif pour compatibilité MCP
 */
export const getStatusToolMetadata = {
  name: 'roosync_get_status',
  description: 'Obtenir l\'état de synchronisation actuel du système RooSync',
  inputSchema: {
    type: 'object' as const,
    properties: {
      machineFilter: {
        type: 'string',
        description: 'ID de machine pour filtrer les résultats (optionnel)'
      }
    },
    additionalProperties: false
  }
};