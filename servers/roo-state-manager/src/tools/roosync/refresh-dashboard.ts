/**
 * Outil MCP : roosync_refresh_dashboard
 *
 * Rafraîchit le dashboard MCP en exécutant le script generate-mcp-dashboard.ps1
 *
 * @module tools/roosync/refresh-dashboard
 * @version 1.1.0 (#4149 : argv sans shell — baseline/outputDir ne sont plus
 *   interpolés dans une commande pwsh -c ; repli powershell.exe siège sans pwsh)
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { PowerShellExecutor, type PowerShellExecutionResult } from '../../services/PowerShellExecutor.js';

/**
 * Détecte la racine roo-extensions en remontant l'arborescence
 */
function findRooExtensionsRoot(): string {
  // ESM-safe: use import.meta.url to get current file location
  const currentFile = fileURLToPath(import.meta.url);
  let dir = path.dirname(currentFile);
  for (let i = 0; i < 10; i++) {
    try {
      fs.accessSync(path.join(dir, 'CLAUDE.md'));
      return dir;
    } catch {
      dir = path.dirname(dir);
    }
  }
  // Fallback: try process.cwd() and walk up
  dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    try {
      fs.accessSync(path.join(dir, 'CLAUDE.md'));
      return dir;
    } catch {
      dir = path.dirname(dir);
    }
  }
  return process.cwd();
}

/**
 * Schema de validation pour roosync_refresh_dashboard
 */
export const RefreshDashboardArgsSchema = z.object({
  baseline: z.string().optional()
    .describe('Machine à utiliser comme baseline (défaut: myia-ai-01)'),
  outputDir: z.string().optional()
    .describe('Répertoire de sortie pour le dashboard (défaut: $ROOSYNC_SHARED_PATH/dashboards)')
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
    // CORRECTION Bug #368: Utiliser ROOSYNC_SHARED_PATH depuis .env, JAMAIS de chemin local dans le dépôt
    const sharedPath = process.env.ROOSYNC_SHARED_PATH;
    if (!sharedPath) {
      throw new Error('ROOSYNC_SHARED_PATH non configuré dans .env - impossible de générer le dashboard');
    }
    const outputDir = args.outputDir || `${sharedPath}/dashboards`;

    console.log('[REFRESH DASHBOARD] Début du rafraîchissement...');
    console.log('[REFRESH DASHBOARD] Baseline:', baseline);
    console.log('[REFRESH DASHBOARD] OutputDir:', outputDir);

    // Construire le chemin du script avec racine absolue
    const repoRoot = findRooExtensionsRoot();
    const scriptPath = path.join(repoRoot, 'scripts', 'roosync', 'generate-mcp-dashboard.ps1');

    console.log('[REFRESH DASHBOARD] Repo root:', repoRoot);

    // #4149 — injection fermée : les valeurs passent en ARGV (spawn sans shell,
    // -File + paramètres via PowerShellExecutor), jamais interpolées dans une
    // chaîne de commande. Une apostrophe dans baseline/outputDir est un littéral,
    // pas un séparateur — il n'existe plus de couche cmd/pwsh qui la parse.
    const execOptions = {
      cwd: repoRoot,
      timeout: 60_000,
      env: { ROOSYNC_SHARED_PATH: sharedPath }
    };
    const scriptArgs = ['-Baseline', baseline, '-OutputDir', outputDir];
    const executor = new PowerShellExecutor({ roosyncBasePath: sharedPath });

    let result: PowerShellExecutionResult;
    try {
      result = await executor.executeScript(scriptPath, scriptArgs, execOptions);
    } catch (error) {
      // Repli #2368 : pwsh est absent de certains sièges — spawn ENOENT seulement.
      // («Script not found» est un rejet AVANT spawn et ne doit PAS retrigger.)
      if (!/ENOENT|Failed to spawn/i.test((error as Error).message)) {
        throw error;
      }
      console.warn('[REFRESH DASHBOARD] pwsh introuvable, repli powershell.exe (Windows PowerShell 5.1)');
      const fallback = new PowerShellExecutor({ roosyncBasePath: sharedPath, powershellPath: 'powershell.exe' });
      result = await fallback.executeScript(scriptPath, scriptArgs, execOptions);
    }

    if (!result.success) {
      // exitCode non nul : le contrat stdout «Fichier:» ne peut pas être honoré.
      throw new Error(
        `generate-mcp-dashboard.ps1 a échoué (exit ${result.exitCode})` +
        (result.stderr ? `: ${result.stderr.trim().slice(0, 300)}` : '')
      );
    }

    const { stdout, stderr } = result;

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
