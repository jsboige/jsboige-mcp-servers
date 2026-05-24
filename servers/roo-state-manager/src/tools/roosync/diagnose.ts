/**
 * Outil MCP : roosync_diagnose
 *
 * Diagnostic et debug complet du système RooSync.
 *
 * @module tools/roosync/diagnose
 * @version 1.0.0
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { getEmbeddingMetrics } from '../../services/task-indexer/VectorIndexer.js';
import { tryGetSharedStatePath } from '../../utils/shared-state-path.js';
import { getServerCapabilities } from '../../utils/server-capabilities.js';

// Lazy imports — only loaded when needed by debug/reset actions.
// Static import was causing hangs on action="test" when RooSyncService init blocked (#1910).
type LazyRooSyncModule = typeof import('../../services/lazy-roosync.js');
let _lazyModule: LazyRooSyncModule | null = null;
async function getLazyModule(): Promise<LazyRooSyncModule> {
  if (!_lazyModule) {
    _lazyModule = await import('../../services/lazy-roosync.js');
  }
  return _lazyModule;
}

// ====================================================================
// SCHEMAS DE VALIDATION
// ====================================================================

export const DiagnoseArgsSchema = z.object({
  action: z.enum(['env', 'debug', 'reset', 'test', 'health', 'lifecycle', 'analyze', 'best-practices'])
    .describe('Operation: env, debug, reset, test, health, lifecycle (agent state #1320), analyze (roadmap), best-practices (MCP guide)'),
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
    .describe('Message de test personnalisé (action: test)'),

  // #1935 Cluster D: Paramètres pour action: 'analyze' (fused from analyze_roosync_problems)
  roadmapPath: z.string().optional()
    .describe('Chemin vers sync-roadmap.md (action: analyze, auto-détecté si omis)'),
  generateReport: z.boolean().optional()
    .describe('Générer un rapport dans roo-config/reports (action: analyze)'),

  // #1935 Cluster D: Paramètres pour action: 'best-practices' (fused from get_mcp_best_practices)
  mcp_name: z.string().optional()
    .describe('Nom du MCP spécifique à analyser (action: best-practices)'),

  // #1320: Paramètres pour action: 'lifecycle' (re-câblé depuis standalone tool, #512 arbitrage A)
  state: z.enum(['BOOTSTRAPPING', 'READY', 'CLAIMED', 'WORKING', 'REPORTING', 'IDLE', 'ERROR', 'RECOVERING'])
    .optional()
    .describe('Target lifecycle state (action: lifecycle)'),
  machineId: z.string().optional()
    .describe('Machine ID (action: lifecycle, default: hostname)'),
  reason: z.string().optional()
    .describe('Reason for lifecycle transition (action: lifecycle)')
});

export type DiagnoseArgs = z.infer<typeof DiagnoseArgsSchema>;

export const DiagnoseResultSchema = z.object({
  success: z.boolean()
    .describe('Indique si l\'opération a réussi'),
  action: z.enum(['env', 'debug', 'reset', 'test', 'health', 'lifecycle', 'analyze', 'best-practices'])
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

      case 'health':
        return await handleHealthAction(args, timestamp);

      // #1320: Lifecycle state machine (re-câblé depuis standalone tool, #512 arbitrage A)
      case 'lifecycle': {
        const m = await import('./lifecycle.js');
        const lcResult = await m.reportLifecycle({
          state: args.state!,
          machineId: args.machineId,
          reason: args.reason,
        });
        return {
          success: lcResult.success,
          action: 'lifecycle',
          timestamp,
          message: lcResult.success
            ? `Lifecycle: ${lcResult.fromState} → ${lcResult.toState}`
            : `Lifecycle transition failed: ${lcResult.error}`,
          data: lcResult,
        };
      }

      // #1935 Cluster D: fused from analyze_roosync_problems
      case 'analyze': {
        const m = await import('../diagnostic/analyze_problems.js');
        const analyzeResult = await m.analyzeRooSyncProblems(args as any) as any;
        return {
          success: analyzeResult?.success !== false,
          action: 'analyze',
          timestamp,
          data: analyzeResult
        };
      }

      // #1935 Cluster D: fused from get_mcp_best_practices
      case 'best-practices': {
        const m = await import('../get_mcp_best_practices.js');
        const result = await m.getMcpBestPractices.handler({ mcp_name: args.mcp_name }) as any;
        return {
          success: !result?.isError,
          action: 'best-practices',
          timestamp,
          data: result
        };
      }

      default:
        throw new Error(`Action non reconnue: ${action}`);
    }
  } catch (error) {
    throw new Error(`Erreur lors du diagnostic ${args.action}: ${(error as Error).message}`);
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
    container: {
      dockerHost: process.env.DOCKER_HOST || null,
      isWSL: !!process.env.WSL_DISTRO_NAME,
      isCI: !!(process.env.CI || process.env.GITHUB_ACTIONS),
      containerEnv: process.env.container || null
    },
    directories: {},
    envVars: {
      hasPath: !!process.env.PATH,
      cwd: process.cwd()
    },
    status: 'OK'
  };

  // Resolve directories using configured sharedPath instead of MCP CWD.
  // .shared-state, roo-config, logs live at the RooSync shared state location (GDrive).
  // . and mcps are MCP-server-local and use process.cwd().
  const sharedPath = tryGetSharedStatePath();
  const sharedBase = sharedPath ? path.dirname(sharedPath) : null;

  const criticalDirs: Array<{ name: string; base: string | null }> = [
    { name: '.', base: process.cwd() },
    { name: '.shared-state', base: sharedPath },
    { name: 'roo-config', base: sharedBase },
    { name: 'mcps', base: process.cwd() },
    { name: 'logs', base: sharedBase },
  ];

  for (const { name, base } of criticalDirs) {
    if (!base) {
      report.directories[name] = { exists: false, error: 'ENOENT', note: 'sharedPath not configured' };
      report.status = 'WARNING';
      continue;
    }
    const fullPath = path.resolve(base, name);
    try {
      await fs.access(fullPath, fs.constants.R_OK | fs.constants.W_OK);
      report.directories[name] = { exists: true, writable: true, resolvedPath: fullPath };
    } catch (err: any) {
      report.directories[name] = { exists: false, error: err.code, resolvedPath: fullPath };
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

  // #2195: Surface embedding pipeline metrics
  report.embeddings = getEmbeddingMetrics();

  // #1746-D: Surface degraded capability status
  const caps = getServerCapabilities();
  report.capabilities = {
    degraded: caps.getAllDegraded().map(e => ({ capability: e.capability, reason: e.reason, since: e.since })),
    available: caps.isDegraded() ? false : true,
    report: caps.getReport(),
  };
  if (caps.isDegraded()) {
    report.status = 'DEGRADED';
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
  const { RooSyncService } = await getLazyModule();
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
  throw new Error(
    `Failed to create RooSyncService instance after ${maxRetries} retries`
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
  const { RooSyncService } = await getLazyModule();
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

  const { RooSyncService, getRooSyncService } = await getLazyModule();
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
 * #1747 sub-issue B: Health-check du cache skeleton 3-tier.
 * Retourne le nombre de skeletons par tier et la configuration active.
 */
async function handleHealthAction(
  _args: DiagnoseArgs,
  timestamp: string
): Promise<DiagnoseResult> {
  const { SkeletonCacheService } = await import('../../services/skeleton-cache.service.js');
  const instance = SkeletonCacheService.getInstance();
  const stats = instance.getCacheTierStats();

  const tierSummary =
    `Tier1(Roo): ${stats.tier1_roo} | ` +
    `Tier2(Claude): ${stats.config.enableClaudeTier ? stats.tier2_claude : 'OFF'} | ` +
    `Tier3(Archives): ${stats.config.enableArchiveTier ? stats.tier3_archives : 'OFF'}`;

  return {
    success: true,
    action: 'health',
    timestamp,
    message: `Skeleton cache health: ${tierSummary} — Total: ${stats.total}`,
    data: {
      tiers: {
        tier1_roo: { enabled: true, count: stats.tier1_roo },
        tier2_claude: { enabled: stats.config.enableClaudeTier, count: stats.tier2_claude },
        tier3_archives: { enabled: stats.config.enableArchiveTier, count: stats.tier3_archives },
      },
      totalSkeletons: stats.total,
      envConfig: {
        SKELETON_CLAUDE_TIER: stats.config.enableClaudeTier,
        SKELETON_ARCHIVE_TIER: stats.config.enableArchiveTier,
      },
    },
  };
}
