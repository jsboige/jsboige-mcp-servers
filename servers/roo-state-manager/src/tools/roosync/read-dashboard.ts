/**
 * Outil MCP : roosync_read_dashboard
 * 
 * Lit le dashboard RooSync avec les données de différences actuelles.
 * Cet outil est spécifiquement conçu pour afficher les différences détectées
 * entre la machine actuelle et la baseline de référence.
 * 
 * @module tools/roosync/read-dashboard
 * @version 2.1.0
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';

/**
 * Schema de validation pour roosync_read_dashboard
 */
export const ReadDashboardArgsSchema = z.object({
  resetCache: z.boolean().optional()
    .describe('Forcer la réinitialisation du cache du service (défaut: false)'),
  machineFilter: z.string().optional()
    .describe('ID de machine pour filtrer les résultats (optionnel)'),
  includeDetails: z.boolean().optional()
    .describe('Inclure les détails complets des différences (défaut: false)')
});

export type ReadDashboardArgs = z.infer<typeof ReadDashboardArgsSchema>;

/**
 * Schema de retour pour roosync_read_dashboard
 */
export const ReadDashboardResultSchema = z.object({
  success: z.boolean().describe('Succès de l\'opération'),
  dashboard: z.object({
    overallStatus: z.enum(['synced', 'diverged', 'conflict', 'unknown'])
      .describe('État global de synchronisation'),
    lastUpdate: z.string().describe('Date de dernière mise à jour (ISO 8601)'),
    machines: z.record(z.object({
      status: z.enum(['online', 'offline', 'unknown']).describe('État de la machine'),
      lastSync: z.string().describe('Dernière synchronisation'),
      pendingDecisions: z.number().describe('Nombre de décisions en attente'),
      diffsCount: z.number().describe('Nombre de différences détectées')
    })).describe('Détails par machine'),
    summary: z.object({
      totalMachines: z.number().describe('Nombre total de machines'),
      onlineMachines: z.number().describe('Machines en ligne'),
      totalDiffs: z.number().describe('Total des différences'),
      totalPendingDecisions: z.number().describe('Total des décisions en attente')
    }).describe('Résumé statistique'),
    diffs: z.array(z.object({
      type: z.enum(['added', 'modified', 'deleted']).describe('Type de différence'),
      path: z.string().describe('Chemin du fichier concerné'),
      machineId: z.string().describe('ID de la machine source'),
      baselinePath: z.string().optional().describe('Chemin dans la baseline'),
      details: z.any().optional().describe('Détails supplémentaires')
    })).optional().describe('Liste des différences détectées')
  }).describe('Données du dashboard'),
  metadata: z.object({
    timestamp: z.string().describe('Horodatage de la réponse'),
    cacheReset: z.boolean().describe('Indique si le cache a été réinitialisé'),
    processingTime: z.number().describe('Temps de traitement en ms')
  }).describe('Métadonnées de la réponse')
});

export type ReadDashboardResult = z.infer<typeof ReadDashboardResultSchema>;

/**
 * Outil roosync_read_dashboard
 * 
 * Lit le dashboard RooSync pour afficher les différences actuelles.
 * Utilise la méthode loadDashboard() corrigée qui évite le cache clearing agressif.
 * 
 * @param args Arguments validés
 * @returns Dashboard avec les différences détectées
 * @throws {RooSyncServiceError} En cas d'erreur
 */
export async function roosyncReadDashboard(args: ReadDashboardArgs): Promise<ReadDashboardResult> {
  const startTime = Date.now();
  
  try {
    console.log('[DASHBOARD] roosyncReadDashboard appelé à', new Date().toISOString());
    
    // Si resetCache est true, réinitialiser l'instance du service
    if (args.resetCache) {
      console.log('[DASHBOARD] Réinitialisation du cache du service demandée...');
      // Import dynamique pour éviter les dépendances circulaires
      const { RooSyncService } = await import('../../services/RooSyncService.js');
      RooSyncService.resetInstance();
      console.log('[DASHBOARD] Service réinitialisé avec succès');
    }
    
    const service = getRooSyncService();
    console.log('[DASHBOARD] Service obtenu, appel de loadDashboard...');
    
    // Utiliser la méthode loadDashboard() corrigée qui évite le cache clearing agressif
    const dashboard = await service.loadDashboard();
    console.log('[DASHBOARD] Dashboard obtenu, diffsCount:', dashboard.summary?.totalDiffs || 'non calculé');
    
    // Filtrer par machine si demandé
    let filteredMachines = dashboard.machines;
    if (args.machineFilter) {
      filteredMachines = {};
      if (dashboard.machines[args.machineFilter]) {
        filteredMachines[args.machineFilter] = dashboard.machines[args.machineFilter];
      }
    }
    
    // Récupérer les différences si demandé
    let diffs = undefined;
    if (args.includeDetails) {
      try {
        // Utiliser le service pour obtenir les différences détaillées
        const diffsResult = await service.listDiffs('all');
        diffs = diffsResult.diffs;
      } catch (diffError) {
        console.warn('[DASHBOARD] Impossible de récupérer les détails des différences:', diffError);
      }
    }
    
    const processingTime = Date.now() - startTime;
    
    return {
      success: true,
      dashboard: {
        overallStatus: dashboard.overallStatus,
        lastUpdate: dashboard.lastUpdate,
        machines: filteredMachines,
        summary: dashboard.summary || {
          totalMachines: Object.keys(filteredMachines).length,
          onlineMachines: Object.values(filteredMachines).filter(m => m.status === 'online').length,
          totalDiffs: Object.values(filteredMachines).reduce((sum, m) => sum + m.diffsCount, 0),
          totalPendingDecisions: Object.values(filteredMachines).reduce((sum, m) => sum + m.pendingDecisions, 0)
        },
        diffs: diffs?.map(d => ({
          type: d.type as 'added' | 'modified' | 'deleted',
          path: d.path,
          machineId: d.machines[0] || 'unknown',
          baselinePath: d.path,
          details: { description: d.description, machines: d.machines }
        }))
      },
      metadata: {
        timestamp: new Date().toISOString(),
        cacheReset: args.resetCache || false,
        processingTime
      }
    };
  } catch (error) {
    console.error('[DASHBOARD] Erreur dans roosyncReadDashboard:', error);
    
    if (error instanceof RooSyncServiceError) {
      throw error;
    }
    
    throw new RooSyncServiceError(
      `Erreur lors de la lecture du dashboard: ${(error as Error).message}`,
      'ROOSYNC_DASHBOARD_ERROR'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const readDashboardToolMetadata = {
  name: 'roosync_read_dashboard',
  description: 'Lire le dashboard RooSync avec les différences actuelles entre machine et baseline',
  inputSchema: {
    type: 'object' as const,
    properties: {
      resetCache: {
        type: 'boolean',
        description: 'Forcer la réinitialisation du cache du service (défaut: false)'
      },
      machineFilter: {
        type: 'string',
        description: 'ID de machine pour filtrer les résultats (optionnel)'
      },
      includeDetails: {
        type: 'boolean',
        description: 'Inclure les détails complets des différences (défaut: false)'
      }
    },
    additionalProperties: false
  }
};