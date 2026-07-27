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
    /**
     * #2628: Same distinction for Qdrant. `qdrant` above checks env-var presence only;
     * this field reflects an actual bounded authenticated GET /collections round-trip.
     * Without it, a live 503/timeout was masked as "Qdrant: OK" (regression of #2547).
     */
    qdrantReachable?: boolean;
    /**
     * #2977: Cause-resolving Qdrant probe result. Preferred over `qdrantReachable`
     * (which only carries the bool) — `qdrantProbe.kind` names why a probe failed so the
     * rendering distinguishes a 401 (key problem) from a real outage. `qdrantReachable`
     * above is retained for backward compatibility with consumers that only read the bool.
     */
    qdrantProbe?: QdrantProbeResult;
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
  qdrantReachable?: boolean;
} {
  const caps = getServerCapabilities();
  const embeddingsConfigured = caps.isAvailable('embeddings');

  // #2547/#2628: *Reachable fields are intentionally omitted here (undefined).
  // They are populated asynchronously in roosyncHealthView() via probeEmbeddingBackend()
  // and probeQdrantBackend() to avoid blocking the synchronous capability check.
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

/**
 * #2977: Cause-resolving Qdrant probe result.
 *
 * `reachable` collapses to a bool for scoring, but `kind` (+ `status`) carries the
 * *cause* so the rendering can tell a 401 (key problem, server is up) from a real
 * outage — instead of inventing "container down" for an auth failure.
 *
 * - `ok`        : 2xx — backend up and serving.
 * - `auth`      : 401/403 — server reachable, key refused (key rotation drift, etc.).
 * - `http`      : other non-2xx (503/500/404) — server up, request failed.
 * - `timeout`   : AbortController fired — no response within the probe window.
 * - `network`   : thrown fetch error (ECONNRESET / ENOTFOUND / CERT_HAS_EXPIRED / "fetch failed").
 * - `unconfigured`: QDRANT_URL unset (defensive; the caller gates on `capabilities.qdrant`).
 */
export type QdrantProbeResult = {
  reachable: boolean;
  status?: number;
  kind: 'ok' | 'auth' | 'http' | 'timeout' | 'network' | 'unconfigured';
};

/**
 * #2628 / #2977: Async live probe of the Qdrant backend.
 * Distinguishes "configured" (env vars present) from "reachable" (backend responds 2xx),
 * and — per #2977 — reports the *cause* of a non-reachable verdict instead of collapsing
 * six distinct outcomes (auth / http / timeout / network) into one indistinguishable bool.
 *
 * Performs a bounded, authenticated `GET /collections`. The result's `reachable` flag is
 * what flips the score/verdict (regression guard for #2547/#2628: a live outage is no longer
 * masked as `Qdrant: OK` just because the env vars are present); the `kind`/`status` let the
 * rendering name the right cause so an operator is not sent to restart infrastructure that a
 * 401 proves is alive.
 *
 * Exported for unit testing (the regression suite asserts 503/401/timeout → not reachable,
 * and now asserts the rendered *cause*).
 */
export async function probeQdrantBackend(): Promise<QdrantProbeResult> {
  const qdrantUrl = process.env.QDRANT_URL;
  if (!qdrantUrl) return { reachable: false, kind: 'unconfigured' };
  const apiKey = process.env.QDRANT_API_KEY;
  const timeoutMs = parseInt(process.env.QDRANT_HEALTH_PROBE_TIMEOUT_MS || '8000', 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['api-key'] = apiKey;
    const resp = await fetch(`${qdrantUrl.replace(/\/+$/, '')}/collections`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    // #2977: surface the cause instead of collapsing six outcomes into one bool.
    // `resp.ok` (2xx) → reachable. A non-2xx still proves the server is up; the status
    // distinguishes an auth gap (401/403, key problem) from a real HTTP failure (503/500/404).
    if (resp.ok) return { reachable: true, status: resp.status, kind: 'ok' };
    const authStatus = resp.status === 401 || resp.status === 403;
    return {
      reachable: false,
      status: resp.status,
      kind: authStatus ? 'auth' : 'http',
    };
  } catch (err) {
    // AbortError = our timeout; everything else (ECONNRESET/ENOTFOUND/CERT_HAS_EXPIRED/"fetch failed")
    // is a transport-level failure. A timeout is a reachable-but-slow signal; a network error means
    // we could not reach the server at all. Both are non-2xx → not reachable, but the kind lets the
    // rendering name the right cause instead of inventing "container down" for a 401 (#2977).
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    return {
      reachable: false,
      kind: isTimeout ? 'timeout' : 'network',
    };
  } finally {
    clearTimeout(timer);
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
  capabilities: { sharedPath: boolean; qdrant: boolean; embeddings: boolean; qdrantReachable?: boolean },
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
  // #2628: a configured-but-unreachable Qdrant is as bad as a missing one for scoring.
  // Otherwise a live 503/timeout stays masked as HEALTHY (env vars present → qdrant=true,
  // no deduction) — the exact false positive this fix removes.
  if (!capabilities.qdrant || capabilities.qdrantReachable === false) score -= 10;
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

/**
 * #2977: Cause-specific recommendation for a configured-but-not-reachable Qdrant.
 * Replaces the previous single message ("a real outage, not a config gap") that routed
 * every failure shape — including a 401 key problem on a live server — to "restart the
 * container". Each branch names the right thing to check.
 */
function qdrantUnreachableRecommendation(probe?: QdrantProbeResult): string {
  const prefix = 'Qdrant configured but NOT REACHABLE';
  const suffix = ' — semantic search degraded to text mode';
  switch (probe?.kind) {
    case 'auth':
      // Server is up (it returned 401/403); the key was refused. Rotation drift is the
      // usual cause. NEVER send the operator to restart the container for an auth failure.
      return `${prefix} — AUTH (server reachable at status ${probe.status}, key refused). Check QDRANT_API_KEY (rotation alignment), not the container${suffix}`;
    case 'http':
      // Non-2xx, non-auth (503/500/404): the server answered, the request failed.
      return `${prefix} — HTTP ${probe.status} (server answered, request failed). Check qdrant container / reverse proxy / collection state${suffix}`;
    case 'timeout':
      return `${prefix} — TIMEOUT (no response within probe window). Check network path / load on qdrant.myia.io${suffix}`;
    case 'network':
      return `${prefix} — NETWORK error (connection refused / DNS / TLS). Check qdrant.myia.io reachability / reverse proxy${suffix}`;
    case 'ok':
    case 'unconfigured':
    default:
      // Defensive: probe was reachable/absent but the caller treated it as unreachable.
      // Surface the raw kind so the mismatch is visible rather than silently generic.
      return `${prefix} (probe kind: ${probe?.kind ?? 'unknown'})${suffix}`;
  }
}

function generateRecommendations(
  onlineCount: number,
  totalCount: number,
  capabilities: { sharedPath: boolean; qdrant: boolean; embeddings: boolean; qdrantReachable?: boolean; qdrantProbe?: QdrantProbeResult },
  drift: { checked: boolean; critical: number; important: number; items: DriftItem[] },
  envMissing: Array<{ name: string; severity: string }>
): string[] {
  const recs: string[] = [];

  if (!capabilities.sharedPath) {
    recs.push('ROOSYNC_SHARED_PATH not configured — RooSync features unavailable');
  }
  if (!capabilities.qdrant) {
    recs.push('Qdrant not configured (QDRANT_URL / QDRANT_API_KEY / QDRANT_COLLECTION_NAME) — semantic search disabled');
  } else if (capabilities.qdrantReachable === false) {
    // #2977: name the cause instead of asserting "a real outage, not a config gap" — that
    // was only true for 2 of the 6 non-reachable branches. A 401/403 is a key problem on a
    // live server; a 503 is the server itself. Route the operator to the right fix.
    recs.push(qdrantUnreachableRecommendation(capabilities.qdrantProbe));
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
  // #2628: report FAIL (not OK) when configured but the live probe failed.
  // #2977: name the cause in the FAIL label so a 401 (key) is not read as "container down".
  const qdrantProbe = result.capabilities.qdrantProbe;
  const qdrantFailCause = qdrantProbe
    ? { auth: `AUTH (status ${qdrantProbe.status}, key refused)`, http: `HTTP ${qdrantProbe.status}`, timeout: 'TIMEOUT', network: 'NETWORK', unconfigured: 'UNCONFIGURED', ok: '' }[qdrantProbe.kind]
    : '';
  const qdrantStatus = !result.capabilities.qdrant ? 'MISSING (not configured)'
    : result.capabilities.qdrantReachable === true ? 'OK (configured + reachable)'
    : result.capabilities.qdrantReachable === false ? `FAIL (configured but unreachable${qdrantFailCause ? ` — ${qdrantFailCause}` : ''})`
    : 'OK (configured)';
  lines.push(`- Qdrant: ${qdrantStatus}`);
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

  // Collect all data sources in parallel (including optional backend probes)
  const [systemHealth, drift, envCheck, embeddingsReachable, qdrantProbe] = await Promise.all([
    collectSystemHealth(),
    collectDrift(targetMachine),
    args.includeEnvCheck !== false ? Promise.resolve(collectEnvCheck()) : Promise.resolve({
      checked: false, missing: [], present: [],
    }),
    // #2547: Async live probe of embedding backend (only if configured)
    capabilities.embeddings ? probeEmbeddingBackend() : Promise.resolve(false as boolean),
    // #2628/#2977: Async live Qdrant probe (only if configured) — returns the cause, not just a bool
    capabilities.qdrant
      ? probeQdrantBackend()
      : Promise.resolve({ reachable: false, kind: 'unconfigured' } as QdrantProbeResult),
  ]);

  // #2547/#2628/#2977: Merge the async probe results into capabilities BEFORE scoring,
  // so a configured-but-unreachable backend actually moves the score/verdict. `qdrantProbe`
  // carries the cause (#2977); `qdrantReachable` is the bool derivative for the score and
  // backward compatibility with consumers that only read the bool.
  const enrichedCapabilities = {
    ...capabilities,
    embeddingsReachable: capabilities.embeddings ? embeddingsReachable : false,
    qdrantProbe: capabilities.qdrant ? qdrantProbe : ({ reachable: false, kind: 'unconfigured' } as QdrantProbeResult),
    qdrantReachable: capabilities.qdrant ? qdrantProbe.reachable : false,
  };

  const criticalEnvMissing = envCheck.missing.filter(e => e.severity === 'critical').length;
  const score = computeScore(
    systemHealth.onlineCount,
    systemHealth.totalCount,
    enrichedCapabilities,
    drift,
    criticalEnvMissing
  );
  const status = determineStatus(score);
  const recommendations = generateRecommendations(
    systemHealth.onlineCount,
    systemHealth.totalCount,
    enrichedCapabilities,
    drift,
    envCheck.missing
  );

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
