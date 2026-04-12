/**
 * Outil MCP : roosync_diagnose
 *
 * Diagnostic et debug complet du système RooSync.
 *
 * @module tools/roosync/diagnose
 * @version 1.0.0
 */

import { z } from 'zod';
import { RooSyncService, RooSyncServiceError, getRooSyncService } from '../../services/lazy-roosync.js';
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
 * #1267: Retry polling with exponential backoff instead of fixed setTimeout.
 * Polls getInstance until it succeeds or max retries exhausted.
 */
async function getInstanceWithRetry(
  options: { enabled: boolean },
  maxRetries = 5,
  baseDelayMs = 100
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const service = await RooSyncService.getInstance(options);
      if (service) return service;
    } catch (err) {
      lastError = err;
    }
    if (attempt < maxRetries - 1) {
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(`[DEBUG] getInstance attempt ${attempt + 1}/${maxRetries} failed, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new RooSyncServiceError(
    `Failed to create RooSyncService instance after ${maxRetries} retries`,
    'INSTANCE_CREATION_FAILED'
  );
}

/**
 * Gère l'action 'debug' (debug du dashboard)
 * Anciennement debug_reset avec action='debug'
 */
async function handleDebugAction(
  args: DiagnoseArgs,
  timestamp: string
): Promise<DiagnoseResult> {
  await RooSyncService.resetInstance();

  const service = await getInstanceWithRetry({ enabled: false });

  const dashboard = await service.loadDashboard();

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

  await RooSyncService.resetInstance();

  if (args.clearCache) {
    const service = await getRooSyncService();
    service.clearCache();
  }

  const service = await getRooSyncService();
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
  description: 'Outil de diagnostic et debug complet pour RooSync. Actions disponibles : env (diagnostic environnement système), debug (debug dashboard avec reset instance), reset (réinitialisation service avec confirmation), test (test minimal MCP).',
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
