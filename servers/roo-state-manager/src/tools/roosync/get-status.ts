/**
 * Outil MCP : roosync_get_status
 *
 * Obtient l'état de synchronisation actuel du système RooSync.
 * Fusionné avec roosync_read_dashboard pour inclure les détails des différences.
 *
 * @module tools/roosync/get-status
 * @version 2.3.0
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';

/**
 * Schema de validation pour roosync_get_status
 */
export const GetStatusArgsSchema = z.object({
  machineFilter: z.string().optional()
    .describe('ID de machine pour filtrer les résultats (optionnel)'),
  resetCache: z.boolean().optional()
    .describe('Forcer la réinitialisation du cache du service (défaut: false)'),
  includeDetails: z.boolean().optional()
    .describe('Inclure les détails complets des différences (défaut: false)')
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
  }).optional().describe('Résumé statistique'),
  
  diffs: z.array(z.object({
    type: z.enum(['added', 'modified', 'deleted']).describe('Type de différence'),
    path: z.string().describe('Chemin du fichier concerné'),
    machineId: z.string().describe('ID de la machine source'),
    baselinePath: z.string().optional().describe('Chemin dans la baseline'),
    details: z.any().optional().describe('Détails supplémentaires')
  })).optional().describe('Liste des différences détectées (si includeDetails=true)')
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
    // CRITICAL DEBUG: Log pour vérifier que le tool est appelé
    console.log('[CRITICAL] roosyncGetStatus appelé à', new Date().toISOString());
    
    // Si resetCache est true, réinitialiser l'instance du service
    if (args.resetCache) {
      console.log('[RESET] Réinitialisation du cache du service demandée...');
      // Import dynamique pour éviter les dépendances circulaires
      const { RooSyncService } = await import('../../services/RooSyncService.js');
      RooSyncService.resetInstance();
      console.log('[RESET] Service réinitialisé avec succès');
    }
    
    const service = getRooSyncService();
    console.log('[CRITICAL] Service obtenu, appel de loadDashboard...');
    const dashboard = await service.loadDashboard();
    console.log('[CRITICAL] Dashboard obtenu:', JSON.stringify(dashboard, null, 2));
    
    // CRITICAL FIX: Utiliser les champs machinesArray et summary si disponibles
    // pour garantir la cohérence avec roosync_list_diffs
    let machines = dashboard.machinesArray || Object.entries(dashboard.machines).map(([id, info]) => ({
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
    
    // Utiliser le summary précalculé si disponible, sinon le calculer
    const summary = dashboard.summary || {
      totalMachines: machines.length,
      onlineMachines: machines.filter(m => m.status === 'online').length,
      totalDiffs: machines.reduce((sum, m) => sum + m.diffsCount, 0),
      totalPendingDecisions: machines.reduce((sum, m) => sum + m.pendingDecisions, 0)
    };
    
    // Récupérer les différences si demandé (fusion avec read-dashboard)
    let diffs = undefined;
    if (args.includeDetails) {
      try {
        console.log('[STATUS] Récupération des détails des différences...');
        const diffsResult = await service.listDiffs('all');
        diffs = diffsResult.diffs.map(d => ({
          type: d.type as 'added' | 'modified' | 'deleted',
          path: d.path,
          machineId: d.machines[0] || 'unknown',
          baselinePath: d.path,
          details: { description: d.description, machines: d.machines }
        }));
        console.log('[STATUS] Différences récupérées:', diffs.length);
      } catch (diffError) {
        console.warn('[STATUS] Impossible de récupérer les détails des différences:', diffError);
      }
    }
    
    return {
      status: dashboard.overallStatus,
      lastSync: dashboard.lastUpdate,
      machines,
      summary,
      diffs
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
  description: 'Obtenir l\'état de synchronisation actuel du système RooSync (fusionné avec read-dashboard)',
  inputSchema: {
    type: 'object' as const,
    properties: {
      machineFilter: {
        type: 'string',
        description: 'ID de machine pour filtrer les résultats (optionnel)'
      },
      resetCache: {
        type: 'boolean',
        description: 'Forcer la réinitialisation du cache du service (défaut: false)'
      },
      includeDetails: {
        type: 'boolean',
        description: 'Inclure les détails complets des différences (défaut: false)'
      }
    },
    additionalProperties: false
  }
};