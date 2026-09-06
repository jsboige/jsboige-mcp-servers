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
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { resetEmbeddingOpenAIClient, resetChatOpenAIClient, resetFallbackChatOpenAIClient } from './openai.js';
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
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_CHAT_MODEL_ID',
  // Embeddings (getOpenAIClient, getCodebaseEmbeddingClient, getEmbeddingModel/Dimensions)
  'EMBEDDING_API_KEY',
  'EMBEDDING_API_BASE_URL',
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
] as const;

export type ReloadableEnvKey = typeof RELOADABLE_ENV_KEYS[number];

/** Which reloadable keys each lazy singleton derives its configuration from. */
const CLIENT_DEPENDENCIES: Record<string, readonly string[]> = {
  embeddingClient: ['EMBEDDING_API_KEY', 'OPENAI_API_KEY', 'EMBEDDING_API_BASE_URL', 'EMBEDDING_TIMEOUT_MS'],
  codebaseEmbeddingClient: ['EMBEDDING_API_KEY', 'OPENAI_API_KEY', 'EMBEDDING_API_BASE_URL', 'EMBEDDING_TIMEOUT_MS'],
  chatClient: ['OPENAI_API_KEY', 'EMBEDDING_API_KEY', 'OPENAI_BASE_URL'],
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
  clientsReset: string[];
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
 * one used at startup.
 */
export function reloadConfig(envPath: string = resolveEnvPath()): ConfigReloadReport {
  const report: ConfigReloadReport = {
    envPath,
    envFileFound: false,
    changed: [],
    unchangedCount: 0,
    skippedKeys: [],
    clientsReset: [],
  };

  let raw: string;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
    report.envFileFound = true;
    report.envFileMtime = fs.statSync(envPath).mtime.toISOString();
  } catch {
    // No .env (env supplied by the parent process): nothing to reload, and no
    // client is dropped — dropping them would be a pure regression.
    return report;
  }

  const parsed = dotenv.parse(raw);
  const allowed = new Set<string>(RELOADABLE_ENV_KEYS);

  report.skippedKeys = Object.keys(parsed).filter((k) => !allowed.has(k)).sort();

  const changedKeys = new Set<string>();
  for (const key of RELOADABLE_ENV_KEYS) {
    if (!(key in parsed)) continue; // absent from .env → leave process.env alone
    const before = process.env[key];
    const after = parsed[key];
    if (before === after) {
      report.unchangedCount++;
      continue;
    }
    process.env[key] = after;
    changedKeys.add(key);
    report.changed.push({ key, before: fingerprint(before), after: fingerprint(after) });
  }

  for (const [client, deps] of Object.entries(CLIENT_DEPENDENCIES)) {
    if (deps.some((d) => changedKeys.has(d))) {
      RESETTERS[client]();
      report.clientsReset.push(client);
    }
  }
  report.clientsReset.sort();

  return report;
}
