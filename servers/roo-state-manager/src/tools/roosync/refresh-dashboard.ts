/**
 * Outil MCP : roosync_refresh_dashboard
 *
 * Rafraîchit le dashboard MCP en exécutant le script generate-mcp-dashboard.ps1
 *
 * @module tools/roosync/refresh-dashboard
 * @version 1.0.0
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Schema de validation pour roosync_refresh_dashboard
 */
export const RefreshDashboardArgsSchema = z.object({
  baseline: z.string().optional()
    .describe('Machine à utiliser comme baseline (défaut: myia-ai-01)'),
  outputDir: z.string().optional()
    .describe('Répertoire de sortie pour le dashboard (défaut: roo-config/shared-state/dashboards)')
});

export type RefreshDashboardArgs = z.infer<typeof RefreshDashboardArgsSchema>;

/**
 * Schema de retour pour roosync_refresh_dashboard
 */
export const RefreshDashboardResultSchema = z.object({
  success: z.boolean().describe('Indique si le rafraîchissement a réussi'),
  dashboardPath: z.string().describe('Chemin du dashboard généré'),
  timestamp: z.string().describe('Horodatage de génération'),
  baseline: z.string().describe('Baseline utilisée'),
  machines: z.array(z.object({
    id: z.string().describe('ID de la machine'),
    status: z.string().describe('Status de l\'inventaire'),
    diffs: z.string().describe('Nombre de diffs ou message d\'erreur')
  })).describe('Liste des machines traitées'),
  metrics: z.object({
    totalMachines: z.number().describe('Nombre total de machines'),
    machinesWithInventory: z.number().describe('Machines avec inventaire'),
    machinesWithoutInventory: z.number().describe('Machines sans inventaire')
  }).describe('Métriques du dashboard')
});

export type RefreshDashboardResult = z.infer<typeof RefreshDashboardResultSchema>;

/**
 * Outil roosync_refresh_dashboard
 *
 * Rafraîchit le dashboard MCP en exécutant le script PowerShell.
 *
 * @param args Arguments validés
 * @returns Résultat du rafraîchissement
 */
export async function roosyncRefreshDashboard(args: RefreshDashboardArgs): Promise<RefreshDashboardResult> {
  try {
    const baseline = args.baseline || 'myia-ai-01';
    const outputDir = args.outputDir || 'roo-config/shared-state/dashboards';

    console.log('[REFRESH DASHBOARD] Début du rafraîchissement...');
    console.log('[REFRESH DASHBOARD] Baseline:', baseline);
    console.log('[REFRESH DASHBOARD] OutputDir:', outputDir);

    // Construire la commande PowerShell
    const scriptPath = 'scripts/roosync/generate-mcp-dashboard.ps1';
    const command = `pwsh -c "& '${scriptPath}' -Baseline '${baseline}' -OutputDir '${outputDir}'"`;

    console.log('[REFRESH DASHBOARD] Exécution de la commande:', command);

    // Exécuter le script PowerShell
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(),
      encoding: 'utf8'
    });

    if (stderr && !stderr.includes('WARNING')) {
      console.warn('[REFRESH DASHBOARD] Stderr:', stderr);
    }

    console.log('[REFRESH DASHBOARD] Stdout:', stdout);

    // Extraire le chemin du dashboard depuis la sortie
    const dashboardPathMatch = stdout.match(/Fichier:\s*(.+\.md)/);
    const dashboardPath = dashboardPathMatch ? dashboardPathMatch[1].trim() : '';

    if (!dashboardPath) {
      throw new Error('Impossible de déterminer le chemin du dashboard généré');
    }

    // Extraire l'horodatage depuis le nom du fichier
    const timestampMatch = dashboardPath.match(/mcp-dashboard-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
    const timestamp = timestampMatch ? timestampMatch[1] : new Date().toISOString();

    // Parser le dashboard pour extraire les informations
    const machines = await parseDashboardMachines(dashboardPath);

    // Calculer les métriques
    const metrics = {
      totalMachines: machines.length,
      machinesWithInventory: machines.filter(m => m.status.includes('✅')).length,
      machinesWithoutInventory: machines.filter(m => m.status.includes('❌')).length
    };

    console.log('[REFRESH DASHBOARD] Dashboard généré avec succès:', dashboardPath);
    console.log('[REFRESH DASHBOARD] Métriques:', metrics);

    return {
      success: true,
      dashboardPath,
      timestamp,
      baseline,
      machines,
      metrics
    };
  } catch (error) {
    console.error('[REFRESH DASHBOARD] Erreur:', error);
    throw new Error(`Erreur lors du rafraîchissement du dashboard: ${(error as Error).message}`);
  }
}

/**
 * Parse le fichier dashboard pour extraire les informations des machines
 */
async function parseDashboardMachines(dashboardPath: string): Promise<Array<{
  id: string;
  status: string;
  diffs: string;
}>> {
  try {
    const fs = await import('fs/promises');
    const content = await fs.readFile(dashboardPath, 'utf8');

    const machines: Array<{ id: string; status: string; diffs: string }> = [];

    // Parser le tableau markdown
    const lines = content.split('\n');
    let inTable = false;

    for (const line of lines) {
      // Début du tableau
      if (line.includes('| Machine |')) {
        inTable = true;
        continue;
      }

      // Fin du tableau (ligne de séparation)
      if (inTable && line.includes('|---')) {
        continue;
      }

      // Ligne de données
      if (inTable && line.startsWith('|')) {
        const parts = line.split('|').map(p => p.trim()).filter(p => p);
        if (parts.length >= 3) {
          machines.push({
            id: parts[0],
            status: parts[1],
            diffs: parts[2]
          });
        }
      }

      // Fin du tableau
      if (inTable && !line.startsWith('|') && line.trim() !== '') {
        break;
      }
    }

    return machines;
  } catch (error) {
    console.warn('[REFRESH DASHBOARD] Impossible de parser le dashboard:', error);
    return [];
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const refreshDashboardToolMetadata = {
  name: 'roosync_refresh_dashboard',
  description: 'Rafraîchit le dashboard MCP en exécutant le script generate-mcp-dashboard.ps1',
  inputSchema: {
    type: 'object' as const,
    properties: {
      baseline: {
        type: 'string',
        description: 'Machine à utiliser comme baseline (défaut: myia-ai-01)'
      },
      outputDir: {
        type: 'string',
        description: 'Répertoire de sortie pour le dashboard (défaut: roo-config/shared-state/dashboards)'
      }
    },
    additionalProperties: false
  }
};
