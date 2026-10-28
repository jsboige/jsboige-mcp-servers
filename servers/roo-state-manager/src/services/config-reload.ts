/**
 * Hot reload of credential/endpoint configuration from `.env`, without restarting
 * the MCP process.
 *
 * Why this exists: `.env` is read exactly once, by `dotenv.config()` in index.ts,
 * at process start. A fleet-wide credential rotation rewrites `.env` *under*
 * processes that are already running, so every live host keeps the revoked value
 * in memory until it is restarted. Measured on ai-01 2026-09-06: the vLLM key was
 * rotated at 18:18:41Z and `.env` rewritten at 18:18:45Z, while all 66 live RSM
 * hosts had started before that instant — none of them held the new key.
 *
 * The clients that consume these values are lazy null-singletons, so re-reading
 * the file and dropping the singletons is sufficient: the next call rebuilds each
 * client from the refreshed `process.env`.
 *
 * @module services/config-reload
 */

import dotenv from 'dotenv';
import { getHostEnvKeys } from './host-env-snapshot.js';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { resetEmbeddingOpenAIClient, resetChatOpenAIClient, resetFallbackChatOpenAIClient } from './openai.js';
import { recordEmbeddingFileConfig } from './embedding-endpoints.js';
import { resetQdrantClient } from './qdrant.js';
import { resetCodebaseEmbeddingClient } from '../tools/search/search-codebase.tool.js';

/**
 * The ONLY keys a hot reload may change.
 *
 * Membership has one hard requirement: the value must be read **lazily**, at each
 * use, by every consumer. A key captured into a module-level `const` at import
 * time cannot be reloaded — the capture already happened, and refreshing
 * `process.env` would leave the process half-old and half-new, which is strictly
 * worse than leaving it wholly old (the divergence is silent).
 *
 * Deliberately EXCLUDED for that reason (verified 2026-09-06):
 *  - `QDRANT_COLLECTION_NAME` — captured at module level in VectorIndexer.ts:14,
 *    QdrantHealthMonitor.ts:3 and cleanup-orphans.ts:24, yet read lazily in
 *    qdrant.ts:68. Reloading it would desynchronise those four readers.
 *  - `EMBEDDING_BATCH_SIZE`, `EMBEDDING_OPS_PER_MINUTE`, `MCP_TOOL_TIMEOUT_MS`,
 *    and the other module-level `const` captures — same reason.
 *
 * Anything outside this list still requires a real process restart.
 */
export const RELOADABLE_ENV_KEYS = [
  // Chat / synthesis (getChatOpenAIClient, getLLMModelId)
  'VLLM_API_KEY_MEDIUM',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_CHAT_MODEL_ID',
  // Embeddings (getOpenAIClient, getCodebaseEmbeddingClient, getEmbeddingModel/Dimensions)
  'EMBEDDING_API_KEY',
  'EMBEDDING_API_BASE_URL',
  // #4352 (a5): ordered list + failover timing. Host-owned in practice (MCP env),
  // so this reload path is for .env-managed seats; a host env move needs a respawn.
  'EMBEDDING_API_BASE_URLS',
  // #4395: LAN-direct default + kill-switch. Read lazily by getEmbeddingEndpointPlan
  // at each client build, so a reload re-plans (public-only when the kill-switch flips).
  'EMBEDDING_LAN_DIRECT',
  'EMBEDDING_LAN_DIRECT_URL',
  'EMBEDDING_NEGATIVE_CACHE_MS',
  'EMBEDDING_QUERY_ATTEMPT_TIMEOUT_MS',
  'EMBEDDING_QUERY_BUDGET_MS',
  'EMBEDDING_MODEL',
  'EMBEDDING_DIMENSIONS',
  'EMBEDDING_TIMEOUT_MS',
  // Qdrant (getQdrantClient)
  'QDRANT_URL',
  'QDRANT_API_KEY',
  'QDRANT_TIMEOUT_MS',
  // Cloud condensation fallback (getFallbackChatOpenAIClient, getFallbackLLMModelId)
  'ZAI_API_KEY',
  'ZAI_BASE_URL',
  'FALLBACK_API_KEY',
  'FALLBACK_BASE_URL',
  'FALLBACK_LLM_MODEL_ID',
  'FALLBACK_TIMEOUT_MS',
  // #3962 piste 4: read per call in dashboard.ts (fallbackApiFormat), no client to reset.
  'FALLBACK_API_FORMAT',
  // #3962 piste 2: primary/cloud budget split, read per call (condenseCloudReserveMs
  // in dashboard.ts) — same shape: no lazy singleton derives from it.
  'CONDENSE_CLOUD_RESERVE_MS',
] as const;

export type ReloadableEnvKey = typeof RELOADABLE_ENV_KEYS[number];

/** Which reloadable keys each lazy singleton derives its configuration from. */
const CLIENT_DEPENDENCIES: Record<string, readonly string[]> = {
  embeddingClient: [
    'EMBEDDING_API_KEY', 'OPENAI_API_KEY', 'EMBEDDING_API_BASE_URL', 'EMBEDDING_API_BASE_URLS',
    'EMBEDDING_LAN_DIRECT', 'EMBEDDING_LAN_DIRECT_URL',
    'EMBEDDING_TIMEOUT_MS', 'EMBEDDING_QUERY_ATTEMPT_TIMEOUT_MS', 'EMBEDDING_QUERY_BUDGET_MS',
    'EMBEDDING_NEGATIVE_CACHE_MS', 'EMBEDDING_DIMENSIONS',
  ],
  codebaseEmbeddingClient: [
    'EMBEDDING_API_KEY', 'OPENAI_API_KEY', 'EMBEDDING_API_BASE_URL', 'EMBEDDING_API_BASE_URLS',
    'EMBEDDING_LAN_DIRECT', 'EMBEDDING_LAN_DIRECT_URL',
    'EMBEDDING_TIMEOUT_MS', 'EMBEDDING_QUERY_ATTEMPT_TIMEOUT_MS', 'EMBEDDING_QUERY_BUDGET_MS',
    'EMBEDDING_NEGATIVE_CACHE_MS', 'EMBEDDING_DIMENSIONS',
  ],
  chatClient: ['VLLM_API_KEY_MEDIUM', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  fallbackChatClient: ['ZAI_API_KEY', 'FALLBACK_API_KEY', 'ZAI_BASE_URL', 'FALLBACK_BASE_URL', 'FALLBACK_TIMEOUT_MS'],
  qdrantClient: ['QDRANT_URL', 'QDRANT_API_KEY', 'QDRANT_TIMEOUT_MS'],
};

const RESETTERS: Record<string, () => void> = {
  embeddingClient: resetEmbeddingOpenAIClient,
  codebaseEmbeddingClient: resetCodebaseEmbeddingClient,
  chatClient: resetChatOpenAIClient,
  fallbackChatClient: resetFallbackChatOpenAIClient,
  qdrantClient: resetQdrantClient,
};

export interface ChangedKey {
  key: string;
  /** Fingerprint BEFORE the reload — never the value. */
  before: string;
  /** Fingerprint AFTER the reload — never the value. */
  after: string;
}

export interface ConfigReloadReport {
  envPath: string;
  envFileFound: boolean;
  envFileMtime?: string;
  changed: ChangedKey[];
  unchangedCount: number;
  /** Keys present in `.env` but outside the allowlist — reported by NAME, ignored. */
  skippedKeys: string[];
  /**
   * #2719: allowlisted keys that `.env` sets but the HOST env set at startup —
   * left untouched, because a restart would keep the host value too.
   */
  hostOwnedKeys: string[];
  /**
   * #4004: set ONLY on the no-`.env` path (the nominal state under
   * mcp-wrapper.cjs, where the host serves the keys via RSM_HOST_ENV_KEYS):
   * how many reloadable keys this process holds that a reload can never touch.
   * Distinguishes "nothing to rotate" from "a rotation is invisible to reload
   * (host-owned) — it needs a process re-spawn".
   */
  hostOnlyCount?: number;
  clientsReset: string[];
}

/**
 * #4317 — per-path record of the names the LAST parse (or the boot revision,
 * seeded at module load) took from `.env`. Only a name in this set may be unset
 * when a later parse drops it: a key something else put in the env was never
 * the file's to cut. Seeded RAW for the default path — host ownership is
 * checked live at unset time, because the module can load before index.ts has
 * captured the #2719 snapshot.
 */
const envSourcedNamesByPath = new Map<string, ReadonlySet<string>>();
{
  const bootPath = resolveEnvPath();
  const bootNames = readEnvSourcedNames(bootPath, RELOADABLE_ENV_KEYS);
  if (bootNames) envSourcedNamesByPath.set(bootPath, bootNames);
}

const NO_NAMES: ReadonlySet<string> = new Set();

/** Names of `keys` the file at `envPath` carries; null when unreadable mid-write. */
function readEnvSourcedNames(envPath: string, keys: readonly string[]): ReadonlySet<string> | null {
  let parsed: Record<string, string>;
  try {
    parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
  } catch {
    return null; // absent or unreadable — the caller treats null as "no revision seen"
  }
  return new Set(keys.filter((key) => key in parsed));
}

/**
 * Describe a secret without disclosing it: length plus a truncated SHA-256.
 * Two fingerprints differ iff the values differ; neither reveals the value.
 * Mask the VALUE, never the NAME.
 */
export function fingerprint(value: string | undefined): string {
  if (value === undefined) return 'ABSENT';
  if (value === '') return 'EMPTY';
  const fp = crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
  return `len=${value.length} fp=${fp}`;
}

/**
 * Resolve the same `.env` that index.ts loads at startup: the package root,
 * one level above the compiled `build/` directory this module lives under.
 */
export function resolveEnvPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // build/services
  return path.resolve(here, '..', '..', '.env');
}

/**
 * Re-read `.env` and rebuild every lazy client whose configuration changed.
 *
 * The file is `parse`d rather than `config`d on purpose: parsing yields a plain
 * object, and only allowlisted keys are then copied into `process.env`. That makes
 * the allowlist structural instead of documentary — a reload cannot reach
 * `ROOSYNC_SHARED_PATH`, `NODE_ENV`, or anything else, even if `.env` sets them.
 * It also avoids dotenv's `override` flag, whose precedence is the inverse of the
 * one used at startup — and, since #2719 (22/09), it skips keys the host env set
 * before `.env` was read (`hostOwnedKeys`): copying `.env` over them re-created that
 * same inversion by hand.
 */
export function reloadConfig(envPath: string = resolveEnvPath()): ConfigReloadReport {
  const report: ConfigReloadReport = {
    envPath,
    envFileFound: false,
    changed: [],
    unchangedCount: 0,
    skippedKeys: [],
    hostOwnedKeys: [],
    clientsReset: [],
  };

  let raw: string;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
    report.envFileFound = true;
    report.envFileMtime = fs.statSync(envPath).mtime.toISOString();
  } catch {
    // No .env (env supplied by the parent process — nominal under
    // mcp-wrapper.cjs): nothing to reload, and no client is dropped — dropping
    // them would be a pure regression. #4004: still count the reloadable keys
    // the process holds from the host, so "no rotation to do" and "rotation
    // invisible to reload" stop reading identically.
    const hostKeys = getHostEnvKeys();
    report.hostOnlyCount = RELOADABLE_ENV_KEYS.filter(
      (k) => process.env[k] !== undefined && (hostKeys === null || hostKeys.has(k))
    ).length;
    return report;
  }

  const parsed = dotenv.parse(raw);
  // #4352 (deadep): the file canonical must follow a `.env` edit on reload too —
  // the plan builder reads it when a rebuilt client re-arms the failover order.
  recordEmbeddingFileConfig(parsed);
  const allowed = new Set<string>(RELOADABLE_ENV_KEYS);

  report.skippedKeys = Object.keys(parsed).filter((k) => !allowed.has(k)).sort();

  const hostKeys = getHostEnvKeys();
  const prevSourced = envSourcedNamesByPath.get(envPath) ?? NO_NAMES;
  const nextSourced = new Set<string>();
  const changedKeys = new Set<string>();
  for (const key of RELOADABLE_ENV_KEYS) {
    if (key in parsed) {
      // #2719: startup precedence is host > `.env` (dotenv never overrides). A key the
      // host set outranked `.env` at startup, so it must outrank it on reload too.
      if (hostKeys?.has(key)) {
        report.hostOwnedKeys.push(key);
        continue;
      }
      nextSourced.add(key);
      const before = process.env[key];
      const after = parsed[key];
      if (before === after) {
        report.unchangedCount++;
        continue;
      }
      process.env[key] = after;
      changedKeys.add(key);
      report.changed.push({ key, before: fingerprint(before), after: fingerprint(after) });
    } else if (prevSourced.has(key)) {
      // #4317: the PREVIOUS parse took this key from `.env`; the new one drops it.
      // A restart would not have the key — cut it from the live env too, or a
      // removed credential keeps serving until respawn (`ZAI_API_KEY ||
      // FALLBACK_API_KEY` kept resolving the corpse on ai-01, 22/10). Host
      // ownership is checked live: the raw boot seed may predate the snapshot.
      if (hostKeys?.has(key)) continue;
      const before = process.env[key];
      delete process.env[key];
      changedKeys.add(key);
      report.changed.push({ key, before: fingerprint(before), after: fingerprint(undefined) });
    }
  }
  envSourcedNamesByPath.set(envPath, nextSourced);

  for (const [client, deps] of Object.entries(CLIENT_DEPENDENCIES)) {
    if (deps.some((d) => changedKeys.has(d))) {
      RESETTERS[client]();
      report.clientsReset.push(client);
    }
  }
  report.clientsReset.sort();

  return report;
}
