/**
 * Outil MCP : roosync_compare_config
 * 
 * Compare la configuration locale avec une autre machine.
 * 
 * @module tools/roosync/compare-config
 * @version 2.0.0
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';

/**
 * Schema de validation pour roosync_compare_config
 */
export const CompareConfigArgsSchema = z.object({
  source: z.string().optional()
    .describe('ID de la machine source (optionnel, défaut: local_machine)'),
  target: z.string().optional()
    .describe('ID de la machine cible (optionnel, défaut: remote_machine)'),
  force_refresh: z.boolean().optional()
    .describe('Forcer la collecte d\'inventaire même si cache valide (défaut: false)')
});

export type CompareConfigArgs = z.infer<typeof CompareConfigArgsSchema>;

/**
 * Schema de retour pour roosync_compare_config
 */
export const CompareConfigResultSchema = z.object({
  source: z.string().describe('Machine source'),
  target: z.string().describe('Machine cible'),
  host_id: z.string().optional().describe('Identifiant de l\'hôte local'),
  differences: z.array(z.object({
    category: z.string().describe('Catégorie de différence'),
    severity: z.string().describe('Niveau de sévérité'),
    path: z.string().describe('Chemin de la différence'),
    description: z.string().describe('Description de la différence'),
    action: z.string().optional().describe('Action recommandée')
  })).describe('Liste des différences détectées'),
  summary: z.object({
    total: z.number().describe('Nombre total de différences'),
    critical: z.number().describe('Différences critiques'),
    important: z.number().describe('Différences importantes'),
    warning: z.number().describe('Avertissements'),
    info: z.number().describe('Informations')
  }).describe('Résumé des différences')
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
  // SDDD Debug: Logging direct dans fichier pour contourner le problème de visibilité
  const debugLog = (message: string, data?: any) => {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}${data ? ` | ${JSON.stringify(data)}` : ''}\n`;
    
    // Écrire directement dans un fichier de log
    try {
      const fs = require('fs');
      fs.appendFileSync('c:/dev/roo-extensions/debug-roosync-compare.log', logEntry);
    } catch (e) {
      // Ignorer les erreurs de logging
    }
    
    // Garder le console.log pour compatibilité
    console.log(message, data);
  };
  
  debugLog('roosyncCompareConfig appelé avec args', args);
  try {
    debugLog('Avant getRooSyncService()');
    const service = getRooSyncService();
    debugLog('Après getRooSyncService(), service obtenu', { serviceExists: !!service });
    const config = service.getConfig();
    
    // Déterminer machines source et cible
    const sourceMachineId = args.source || config.machineId;
    const targetMachineId = args.target || await getDefaultTargetMachine(service, sourceMachineId);
    
    // Comparaison réelle
    const report = await service.compareRealConfigurations(
      sourceMachineId,
      targetMachineId,
      args.force_refresh || false
    );

    if (!report) {
      throw new RooSyncServiceError(
        'Échec de la comparaison des configurations',
        'COMPARISON_FAILED'
      );
    }

    // Formatter le rapport pour l'affichage
    return formatComparisonReport(report);
    
  } catch (error) {
    // CORRECTION SDDD: Laisser remonter les erreurs détaillées du BaselineService
    if (error instanceof RooSyncServiceError) {
      debugLog('RooSyncServiceError interceptée', {
        name: error.name,
        message: error.message,
        code: error.code
      });
      throw error;
    }
    
    // Conserver le message d'erreur original pour le debugging
    const originalError = error as Error;
    debugLog('Erreur originale dans compare-config', {
      errorType: typeof error,
      errorMessage: originalError.message,
      errorStack: originalError.stack,
      errorName: originalError.name
    });
    
    throw new RooSyncServiceError(
      `Erreur lors de la comparaison: ${originalError.message}`,
      'ROOSYNC_COMPARE_ERROR'
    );
  }
}

/**
 * Obtenir la machine cible par défaut
 */
async function getDefaultTargetMachine(service: any, sourceMachineId: string): Promise<string> {
  const dashboard = await service.loadDashboard();
  const machines = Object.keys(dashboard.machines).filter(
    m => m !== sourceMachineId
  );
  
  if (machines.length === 0) {
    throw new RooSyncServiceError(
      'Aucune autre machine trouvée pour la comparaison',
      'NO_TARGET_MACHINE'
    );
  }
  
  // Trier par nom pour garantir une sélection prévisible
  machines.sort();
  return machines[0];
}

/**
 * Formate le rapport de comparaison pour l'affichage MCP
 */
function formatComparisonReport(report: any): CompareConfigResult {
  return {
    source: report.sourceMachine,
    target: report.targetMachine,
    host_id: report.hostId || 'unknown',
    differences: report.differences.map((diff: any) => ({
      category: diff.category,
      severity: diff.severity,
      path: diff.path,
      description: diff.description,
      action: diff.recommendedAction
    })),
    summary: report.summary
  };
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 * Utilise Zod.shape natif pour compatibilité MCP
 */
export const compareConfigToolMetadata = {
  name: 'roosync_compare_config',
  description: `Compare les configurations Roo entre deux machines et détecte les différences réelles.

Détection multi-niveaux :
- Configuration Roo (modes, MCPs, settings) - CRITICAL
- Hardware (CPU, RAM, disques, GPU) - IMPORTANT
- Software (PowerShell, Node, Python) - WARNING
- System (OS, architecture) - INFO

Utilise Get-MachineInventory.ps1 pour collecte d'inventaire complet avec cache TTL 1h.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      source: {
        type: 'string',
        description: 'ID de la machine source (optionnel, défaut: local_machine)'
      },
      target: {
        type: 'string',
        description: 'ID de la machine cible (optionnel, défaut: remote_machine)'
      },
      force_refresh: {
        type: 'boolean',
        description: 'Forcer la collecte d\'inventaire même si cache valide (défaut: false)'
      }
    },
    additionalProperties: false
  }
};