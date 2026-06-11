/**
 * Outil MCP : roosync_health_view
 *
 * Vue agrégée de l'état santé du cluster RooSync en un seul appel.
 * Combine inventory, drift config, env vars critiques, et capability checks.
 *
 * #1746-B: Unified config dashboard tool
 *
 * @module tools/roosync/health-view
 */

import { z } from 'zod';
import { getServerCapabilities } from '../../utils/server-capabilities.js';
import { createLogger } from '../../utils/logger.js';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getSharedStatePath } from '../../utils/shared-state-path.js';
import { extractMachineActivity, isRecentlyActive } from '../../utils/dashboard-activity.js';
import { getRooSyncService } from '../../services/lazy-roosync.js';
import * as os from 'os';

const logger = createLogger('HealthView');

const CRITICAL_ENV_VARS = [
  { name: 'EMBEDDING_MODEL', severity: 'warning' as const },
  { name: 'EMBEDDING_DIMENSIONS', severity: 'warning' as const },
  { name: 'EMBEDDING_API_BASE_URL', severity: 'warning' as const },
  { name: 'EMBEDDING_API_KEY', severity: 'warning' as const },
  { name: 'QDRANT_URL', severity: 'critical' as const },
  { name: 'QDRANT_API_KEY', severity: 'critical' as const },
];

export const HealthViewArgsSchema = z.object({
  machineId: z.string().optional()
    .describe('Machine locale (défaut) ou distante pour le drift check'),
  includeEnvCheck: z.boolean().optional()
    .describe('Inclure la vérification des env vars critiques (défaut: true)'),
  format: z.enum(['json', 'markdown']).optional()
    .describe('Format de sortie (défaut: json)'),
});

export type HealthViewArgs = z.infer<typeof HealthViewArgsSchema>;

interface DriftItem {
  category: string;
  severity: string;
  path: string;
  description: string;
  action?: string;
}

export interface HealthViewResult {
  status: 'HEALTHY' | 'WARNING' | 'CRITICAL';
  score: number;
  timestamp: string;
  localMachine: string;
  systemHealth: {
    machinesOnline: number;
    machinesUnknown: number;
    machinesTotal: number;
    flags: string[];
  };
  capabilities: {
    sharedPath: boolean;
    qdrant: boolean;
    embeddings: boolean;
    /**
     * #2547: Distinguish "configured" (env vars present) from "reachable" (live probe).
     * `embeddings` above checks env-var presence only; this field reflects actual backend health.
     */
    embeddingsReachable?: boolean;
  };
  drift: {
    checked: boolean;
    baselineSource: string;
    critical: number;
    important: number;
    warning: number;
    info: number;
    items: DriftItem[];
  };
  envCheck: {
    checked: boolean;
    missing: Array<{ name: string; severity: string }>;
    present: string[];
  };
  recommendations: string[];
}

function isKnownMachine(machineId: string): boolean {
  return machineId.toLowerCase().startsWith('myia-');
}

function getLocalMachineId(): string {
  return os.hostname().toLowerCase();
}

async function collectSystemHealth(): Promise<{
  onlineCount: number;
  unknownCount: number;
  totalCount: number;
  flags: string[];
}> {
  // #2546: Unified machine presence — uses the same dashboard-activity utilities
  // and thresholds as get-status.ts to eliminate contradictory readings.
  // Previously used a hardcoded 2h threshold + hardcoded KNOWN_MACHINES list,
  // causing status=CRITICAL vs health=HEALTHY contradictions.
  const sharedPath = getSharedStatePath();
  let onlineCount = 0;
  let unknownCount = 0;
  const flags: string[] = [];
  const ONE_DAY = 24 * 60 * 60 * 1000;

  try {
    const dashboardsDir = join(sharedPath, 'dashboards');
    if (!existsSync(dashboardsDir)) {
      return { onlineCount: 0, unknownCount: 0, totalCount: 0, flags: ['DASHBOARDS_DIR_MISSING'] };
    }

    const dashboardFiles = readdirSync(dashboardsDir).filter(f => f.endsWith('.md'));
    const contents: string[] = [];
    for (const file of dashboardFiles) {
      try {
        contents.push(readFileSync(join(dashboardsDir, file), 'utf-8'));
      } catch { /* skip unreadable */ }
    }

    // #2546: Use shared extractMachineActivity + isRecentlyActive (8h threshold)
    // same as get-status.ts — single source of truth for presence classification
    const activity = extractMachineActivity(contents);
    const onlineMachines: string[] = [];

    for (const [machineId, lastSeenStr] of activity) {
      const id = machineId.toLowerCase();
      if (!isKnownMachine(id)) continue;

      if (isRecentlyActive(lastSeenStr)) {
        onlineCount++;
        onlineMachines.push(id);
      }
      // Machines with stale dashboard activity (>8h) are not counted as online
      // but are also NOT double-counted as unknown — they'll be caught by the
      // registry check below if they haven't posted at all.
    }

    // #2546: Use dynamic registry (service.getKnownMachineIds()) instead of
    // hardcoded KNOWN_MACHINES list — stays in sync with fleet changes.
    // Machines in registry but absent from ALL dashboard activity = unknown.
    const seenSet = new Set(onlineMachines.map(m => m.toLowerCase()));
    let registryMachineIds: string[] = [];
    try {
      const service = await getRooSyncService();
      registryMachineIds = service.getKnownMachineIds().filter(isKnownMachine);
    } catch {
      // Fallback to hardcoded list if service unavailable
      registryMachineIds = ['myia-ai-01', 'myia-po-2023', 'myia-po-2024', 'myia-po-2025', 'myia-po-2026', 'myia-web1'];
    }

    for (const mid of registryMachineIds) {
      if (!seenSet.has(mid.toLowerCase())) {
        // Check if this machine has ANY dashboard activity at all (even stale)
        const lastSeen = activity.get(mid.toLowerCase());
        if (lastSeen) {
          const lastSeenMs = new Date(lastSeen).getTime();
          if (Date.now() - lastSeenMs > ONE_DAY) {
            flags.push(`SYNC_STALE:${mid}`);
          }
        } else {
          // Never seen on any dashboard — flag as SYNC_STALE
          flags.push(`SYNC_STALE:${mid}`);
        }
        unknownCount++;
      }
    }
  } catch (error) {
    flags.push('HEALTH_CHECK_FAILED:dashboard_read_error');
    logger.warn('Failed to derive presence from dashboards', { error: (error as Error).message });
  }

  return {
    onlineCount,
    unknownCount,
    totalCount: onlineCount + unknownCount,
    flags,
  };
}

function collectCapabilities(): {
  sharedPath: boolean;
  qdrant: boolean;
  embeddings: boolean;
  embeddingsReachable?: boolean;
} {
  const caps = getServerCapabilities();
  const embeddingsConfigured = caps.isAvailable('embeddings');

  // #2547: embeddingsReachable is intentionally omitted here (undefined).
  // It is populated asynchronously in roosyncHealthView() via probeEmbeddingBackend()
  // to avoid blocking the synchronous capability check.
  return {
    sharedPath: caps.isAvailable('sharedPath'),
    qdrant: caps.isAvailable('qdrant'),
    embeddings: embeddingsConfigured,
  };
}

/**
 * #2547: Async live probe of the embedding backend.
 * Distinguishes "configured" (env vars present) from "reachable" (backend responds).
 * Uses the same connectivity cache as diagnose-index.tool.ts to avoid redundant API calls.
 */
async function probeEmbeddingBackend(): Promise<boolean> {
  try {
    const getOpenAIClient = (await import('../../services/openai.js')).default;
    const { getEmbeddingModel } = await import('../../services/openai.js');
    const openai = getOpenAIClient();
    const result = await openai.embeddings.create({
      model: getEmbeddingModel(),
      input: 'health-check',
    });
    return result?.data?.[0]?.embedding?.length > 0;
  } catch {
    return false;
  }
}

async function collectDrift(
  localMachineId: string
): Promise<{
  checked: boolean;
  baselineSource: string;
  critical: number;
  important: number;
  warning: number;
  info: number;
  items: DriftItem[];
}> {
  const empty = {
    checked: false as const,
    baselineSource: '',
    critical: 0, important: 0, warning: 0, info: 0,
    items: [] as DriftItem[],
  };

  try {
    const { roosyncCompareConfig } = await import('./compare-config.js');
    const result = await roosyncCompareConfig({
      source: localMachineId,
      granularity: 'full',
    });

    return {
      checked: true,
      baselineSource: `${result.target} (via GDrive inventory)`,
      critical: result.summary.critical,
      important: result.summary.important,
      warning: result.summary.warning,
      info: result.summary.info,
      items: result.differences.map(d => ({
        category: d.category,
        severity: d.severity,
        path: d.path,
        description: d.description,
        action: d.action,
      })),
    };
  } catch (error) {
    const msg = (error as Error).message;
    logger.warn('Drift collection failed', { error: msg });
    return { ...empty, baselineSource: `error: ${msg}` };
  }
}

function collectEnvCheck(): {
  checked: boolean;
  missing: Array<{ name: string; severity: string }>;
  present: string[];
} {
  const missing: Array<{ name: string; severity: string }> = [];
  const present: string[] = [];

  for (const { name, severity } of CRITICAL_ENV_VARS) {
    if (process.env[name]) {
      present.push(name);
    } else {
      missing.push({ name, severity });
    }
  }

  return { checked: true, missing, present };
}

function computeScore(
  onlineCount: number,
  totalCount: number,
  capabilities: { sharedPath: boolean; qdrant: boolean; embeddings: boolean },
  drift: { critical: number; important: number; warning: number },
  criticalEnvMissing: number
): number {
  let score = 100;

  // Machine availability (0-20 points)
  if (totalCount > 0) {
    const onlinePct = onlineCount / totalCount;
    score -= (1 - onlinePct) * 20;
  }

  // Capabilities (0-30 points)
  if (!capabilities.sharedPath) score -= 15;
  if (!capabilities.qdrant) score -= 10;
  if (!capabilities.embeddings) score -= 5;

  // Drift (0-30 points)
  score -= Math.min(drift.critical * 10, 20);
  score -= Math.min(drift.important * 3, 10);

  // Env vars (0-20 points)
  score -= criticalEnvMissing * 10;

  return Math.max(0, Math.round(score));
}

function determineStatus(score: number): 'HEALTHY' | 'WARNING' | 'CRITICAL' {
  if (score >= 80) return 'HEALTHY';
  if (score >= 50) return 'WARNING';
  return 'CRITICAL';
}

function generateRecommendations(
  onlineCount: number,
  totalCount: number,
  capabilities: { sharedPath: boolean; qdrant: boolean; embeddings: boolean },
  drift: { checked: boolean; critical: number; important: number; items: DriftItem[] },
  envMissing: Array<{ name: string; severity: string }>
): string[] {
  const recs: string[] = [];

  if (!capabilities.sharedPath) {
    recs.push('ROOSYNC_SHARED_PATH not configured — RooSync features unavailable');
  }
  if (!capabilities.qdrant) {
    recs.push('Qdrant not reachable — semantic search disabled');
  }
  if (!capabilities.embeddings) {
    recs.push('Embedding service not configured — codebase_search disabled');
  }

  for (const env of envMissing) {
    recs.push(`Set ${env.name} (severity: ${env.severity})`);
  }

  if (drift.checked && drift.critical > 0) {
    recs.push(`${drift.critical} critical config drift(s) detected — run roosync_compare_config for details`);
  }

  if (totalCount > 0 && onlineCount < totalCount) {
    const offline = totalCount - onlineCount;
    recs.push(`${offline} machine(s) offline — check dashboard intercom for [WAKE] signals`);
  }

  if (recs.length === 0) {
    recs.push('All systems nominal');
  }

  return recs;
}

export function formatMarkdown(result: HealthViewResult): string {
  const lines: string[] = [];
  const statusIcon = result.status === 'HEALTHY' ? 'OK' : result.status === 'WARNING' ? 'WARN' : 'CRIT';

  lines.push(`# [${statusIcon}] Cluster Health View — ${result.localMachine}`);
  lines.push(`**Status:** ${result.status} | **Score:** ${result.score}/100 | **Timestamp:** ${result.timestamp}`);
  lines.push('');

  lines.push('## System Health');
  lines.push(`- **Machines:** ${result.systemHealth.machinesOnline}/${result.systemHealth.machinesTotal} online`);
  if (result.systemHealth.flags.length > 0) {
    lines.push(`- **Flags:** ${result.systemHealth.flags.join(', ')}`);
  }
  lines.push('');

  lines.push('## Capabilities');
  lines.push(`- SharedPath: ${result.capabilities.sharedPath ? 'OK' : 'MISSING'}`);
  lines.push(`- Qdrant: ${result.capabilities.qdrant ? 'OK' : 'MISSING'}`);
  const embStatus = !result.capabilities.embeddings ? 'MISSING (not configured)'
    : result.capabilities.embeddingsReachable === true ? 'OK (configured + reachable)'
    : result.capabilities.embeddingsReachable === false ? 'DEGRADED (configured but unreachable)'
    : 'OK (configured)';
  lines.push(`- Embeddings: ${embStatus}`);
  lines.push('');

  lines.push('## Config Drift');
  if (result.drift.checked) {
    lines.push(`- **Baseline:** ${result.drift.baselineSource}`);
    lines.push(`- Critical: ${result.drift.critical} | Important: ${result.drift.important} | Warning: ${result.drift.warning} | Info: ${result.drift.info}`);
    if (result.drift.items.length > 0) {
      lines.push('');
      for (const item of result.drift.items.slice(0, 10)) {
        lines.push(`  - [${item.severity}] ${item.path}: ${item.description}`);
      }
      if (result.drift.items.length > 10) {
        lines.push(`  - ... and ${result.drift.items.length - 10} more`);
      }
    }
  } else {
    lines.push(`- Not checked (${result.drift.baselineSource})`);
  }
  lines.push('');

  if (result.envCheck.checked) {
    lines.push('## Environment Variables');
    if (result.envCheck.missing.length > 0) {
      for (const m of result.envCheck.missing) {
        lines.push(`- MISSING: ${m.name} (${m.severity})`);
      }
    } else {
      lines.push('- All critical env vars present');
    }
    lines.push('');
  }

  lines.push('## Recommendations');
  for (const rec of result.recommendations) {
    lines.push(`- ${rec}`);
  }

  return lines.join('\n');
}

export async function roosyncHealthView(args: HealthViewArgs): Promise<HealthViewResult> {
  const localMachineId = getLocalMachineId();
  const targetMachine = args.machineId || localMachineId;

  // #2547: Collect sync capabilities first to decide whether to probe embeddings
  const capabilities = collectCapabilities();

  // Collect all data sources in parallel (including optional embedding probe)
  const [systemHealth, drift, envCheck, embeddingsReachable] = await Promise.all([
    collectSystemHealth(),
    collectDrift(targetMachine),
    args.includeEnvCheck !== false ? Promise.resolve(collectEnvCheck()) : Promise.resolve({
      checked: false, missing: [], present: [],
    }),
    // #2547: Async live probe of embedding backend (only if configured)
    capabilities.embeddings ? probeEmbeddingBackend() : Promise.resolve(false as boolean),
  ]);

  const criticalEnvMissing = envCheck.missing.filter(e => e.severity === 'critical').length;
  const score = computeScore(
    systemHealth.onlineCount,
    systemHealth.totalCount,
    capabilities,
    drift,
    criticalEnvMissing
  );
  const status = determineStatus(score);
  const recommendations = generateRecommendations(
    systemHealth.onlineCount,
    systemHealth.totalCount,
    capabilities,
    drift,
    envCheck.missing
  );

  // #2547: Merge the async embedding probe result into capabilities
  const enrichedCapabilities = {
    ...capabilities,
    embeddingsReachable: capabilities.embeddings ? embeddingsReachable : false,
  };

  const result: HealthViewResult = {
    status,
    score,
    timestamp: new Date().toISOString(),
    localMachine: localMachineId,
    systemHealth: {
      machinesOnline: systemHealth.onlineCount,
      machinesUnknown: systemHealth.unknownCount,
      machinesTotal: systemHealth.totalCount,
      flags: systemHealth.flags,
    },
    capabilities: enrichedCapabilities,
    drift,
    envCheck,
    recommendations,
  };

  logger.info(`Health view computed: ${status} (${score}/100)`);
  return result;
}
