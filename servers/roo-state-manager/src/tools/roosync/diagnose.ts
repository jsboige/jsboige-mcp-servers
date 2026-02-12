/**
 * Outil MCP : roosync_diagnose
 *
 * CONS-#443 Groupe 5 : Consolidation de diagnose_env + debug_reset + minimal_test_tool
 * Outil complet de diagnostic et debug du système RooSync.
 *
 * @module tools/roosync/diagnose
 * @version 1.0.0
 */

import { z } from 'zod';
import { RooSyncService, RooSyncServiceError, getRooSyncService } from '../../services/RooSyncService.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ====================================================================
// SCHEMAS DE VALIDATION
// ====================================================================

export const DiagnoseArgsSchema = z.object({
  action: z.enum(['env', 'debug', 'reset', 'test'])
    .describe('Type d\'opération: env (environnement), debug (dashboard), reset (service), test (minimal)'),

  // Paramètres pour action: 'env'
  checkDiskSpace: z.boolean().optional()
    .describe('Vérifier l\'espace disque (action: env)'),

  // Paramètres pour action: 'debug'
  verbose: z.boolean().optional()
    .describe('Mode verbeux pour debug (action: debug)'),

  // Paramètres pour action: 'reset'
  clearCache: z.boolean().optional()
    .describe('Vider le cache lors du reset (action: reset)'),
  confirm: z.boolean().optional()
    .describe('Confirmation requise pour reset (action: reset)'),

  // Paramètres pour action: 'test'
  message: z.string().optional()
    .describe('Message de test personnalisé (action: test)')
});

export type DiagnoseArgs = z.infer<typeof DiagnoseArgsSchema>;

export const DiagnoseResultSchema = z.object({
  success: z.boolean()
    .describe('Indique si l\'opération a réussi'),
  action: z.enum(['env', 'debug', 'reset', 'test'])
    .describe('Type d\'opération effectuée'),
  timestamp: z.string()
    .describe('Timestamp de l\'opération (ISO 8601)'),
  message: z.string().optional()
    .describe('Message de résultat'),
  data: z.any().optional()
    .describe('Données retournées par l\'opération')
});

export type DiagnoseResult = z.infer<typeof DiagnoseResultSchema>;

// ====================================================================
// IMPLÉMENTATION PRINCIPALE
// ====================================================================

/**
 * Outil principal de diagnostic RooSync
 * Combine diagnose_env, debug_reset, et minimal_test_tool
 *
 * @param args Arguments de l'outil
 */
export async function roosyncDiagnose(args: DiagnoseArgs): Promise<DiagnoseResult> {
  try {
    const { action } = args;
    const timestamp = new Date().toISOString();

    switch (action) {
      case 'env':
        return await handleEnvAction(args, timestamp);

      case 'debug':
        return await handleDebugAction(args, timestamp);

      case 'reset':
        return await handleResetAction(args, timestamp);

      case 'test':
        return await handleTestAction(args, timestamp);

      default:
        throw new RooSyncServiceError(
          `Action non reconnue: ${action}`,
          'UNKNOWN_ACTION'
        );
    }
  } catch (error) {
    if (error instanceof RooSyncServiceError) {
      throw error;
    }

    throw new RooSyncServiceError(
      `Erreur lors du diagnostic ${args.action}: ${(error as Error).message}`,
      `DIAGNOSE_${args.action.toUpperCase()}_FAILED`
    );
  }
}

/**
 * Gère l'action 'env' (diagnostic d'environnement)
 * Anciennement diagnose_env
 */
async function handleEnvAction(
  args: DiagnoseArgs,
  timestamp: string
): Promise<DiagnoseResult> {
  const report: any = {
    timestamp,
    system: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      hostname: os.hostname(),
      uptime: os.uptime(),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem()
    },
    directories: {},
    envVars: {
      hasPath: !!process.env.PATH,
      cwd: process.cwd()
    },
    status: 'OK'
  };

  const criticalDirs = [
    '.',
    '.shared-state',
    'roo-config',
    'mcps',
    'logs'
  ];

  for (const dir of criticalDirs) {
    const fullPath = path.resolve(process.cwd(), dir);
    try {
      await fs.access(fullPath, fs.constants.R_OK | fs.constants.W_OK);
      report.directories[dir] = { exists: true, writable: true };
    } catch (err: any) {
      report.directories[dir] = { exists: false, error: err.code };
      report.status = 'WARNING';
    }
  }

  const criticalFiles = [
    'package.json',
    'tsconfig.json'
  ];

  for (const file of criticalFiles) {
    try {
      await fs.access(path.resolve(process.cwd(), file));
    } catch {
      report.status = 'WARNING';
      report.missingFiles = report.missingFiles || [];
      report.missingFiles.push(file);
    }
  }

  return {
    success: report.status === 'OK',
    action: 'env',
    timestamp,
    message: `Diagnostic d'environnement ${report.status === 'OK' ? 'OK' : 'WARNING'}`,
    data: report
  };
}

/**
 * Gère l'action 'debug' (debug du dashboard)
 * Anciennement debug_reset avec action='debug'
 */
async function handleDebugAction(
  args: DiagnoseArgs,
  timestamp: string
): Promise<DiagnoseResult> {
  console.log('[DEBUG] debugDashboard - FORCAGE NOUVELLE INSTANCE');

  // Forcer la réinitialisation complète du singleton
  RooSyncService.resetInstance();

  // Attendre un peu pour s'assurer que l'instance est bien nettoyée
  await new Promise(resolve => setTimeout(resolve, 100));

  // Créer une nouvelle instance avec cache désactivé
  const service = RooSyncService.getInstance({ enabled: false });

  console.log('[DEBUG] debugDashboard - NOUVELLE INSTANCE CRÉÉE');

  // Appeler loadDashboard directement
  const dashboard = await service.loadDashboard();

  if (args.verbose) {
    console.log('[DEBUG] debugDashboard - RÉSULTAT BRUT:', JSON.stringify(dashboard, null, 2));
  }

  const config = service.getConfig();

  return {
    success: true,
    action: 'debug',
    timestamp,
    message: 'Dashboard debuggé avec succès',
    data: {
      machineId: config.machineId,
      debugInfo: {
        instanceForced: true,
        cacheDisabled: true,
        dashboard: args.verbose ? dashboard : '(use verbose: true pour voir)'
      }
    }
  };
}

/**
 * Gère l'action 'reset' (réinitialisation du service)
 * Anciennement debug_reset avec action='reset'
 */
async function handleResetAction(
  args: DiagnoseArgs,
  timestamp: string
): Promise<DiagnoseResult> {
  if (!args.confirm) {
    return {
      success: false,
      action: 'reset',
      timestamp,
      message: 'Veuillez confirmer avec confirm: true pour réinitialiser le service'
    };
  }

  console.log('[RESET] Réinitialisation de l\'instance RooSyncService...');

  // Réinitialiser l'instance singleton
  RooSyncService.resetInstance();

  // Vider le cache si demandé
  if (args.clearCache) {
    const service = getRooSyncService();
    service.clearCache();
  }

  console.log('[RESET] Instance réinitialisée avec succès');

  const service = getRooSyncService();
  const config = service.getConfig();

  return {
    success: true,
    action: 'reset',
    timestamp,
    message: 'Instance RooSyncService réinitialisée avec succès',
    data: {
      machineId: config.machineId,
      debugInfo: {
        instanceForced: true,
        cacheDisabled: false,
        cacheCleared: args.clearCache || false
      }
    }
  };
}

/**
 * Gère l'action 'test' (test minimal)
 * Anciennement minimal_test_tool
 */
async function handleTestAction(
  args: DiagnoseArgs,
  timestamp: string
): Promise<DiagnoseResult> {
  const message = args.message || 'Test minimal OK';

  console.log(`[minimal-test] 🧪 Exécution du test minimal: ${message}`);

  return {
    success: true,
    action: 'test',
    timestamp,
    message: 'Test minimal réussi',
    data: {
      testMessage: message,
      mcpStatus: 'OK',
      note: 'Cet outil vérifie que le MCP roo-state-manager fonctionne correctement'
    }
  };
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const diagnoseToolMetadata = {
  name: 'roosync_diagnose',
  description: 'Diagnostic et debug complet RooSync : env (environnement), debug (dashboard), reset (service), test (minimal). Consolidation (CONS-#443 Groupe 5) de diagnose_env + debug_reset + minimal_test_tool.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['env', 'debug', 'reset', 'test'],
        description: 'Type d\'opération: env (environnement), debug (dashboard), reset (service), test (minimal)'
      },
      checkDiskSpace: {
        type: 'boolean',
        description: 'Vérifier l\'espace disque (action: env)'
      },
      verbose: {
        type: 'boolean',
        description: 'Mode verbeux pour debug (action: debug)'
      },
      clearCache: {
        type: 'boolean',
        description: 'Vider le cache lors du reset (action: reset)'
      },
      confirm: {
        type: 'boolean',
        description: 'Confirmation requise pour reset (action: reset)'
      },
      message: {
        type: 'string',
        description: 'Message de test personnalisé (action: test)'
      }
    },
    required: ['action'],
    additionalProperties: false
  }
};
