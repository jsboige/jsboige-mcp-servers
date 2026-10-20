/**
 * #4095 — lazy, rotation-aware refresh of the condenser's LLM credentials.
 *
 * The defect this closes (forensics ai-01, 06/10): a vLLM key rotation rewrites
 * `.env` under long-lived RSM hosts, but the chat client is a module singleton
 * built at the FIRST condensation from the `process.env` snapshot taken at spawn
 * (host env wins, then dotenv). The host therefore keeps presenting the revoked
 * key — po-2023 served a key revoked 30/09 for 169 requests until 06/10, visible
 * only as silent fallback-truncations on degraded dashboards. `roosync_diagnose
 * reload` (services/config-reload.ts) resets the singleton in principle, but
 * nothing calls it automatically — and its read is `.env`-only.
 *
 * This module gives `getChatOpenAIClient()` / `getFallbackChatOpenAIClient()` a
 * cheap per-call check: if the package-root `.env` changed since the last look,
 * re-read it and bring the condensation keys into `process.env`, honouring the
 * boot precedence (host env wins; the reload must never invert it — #2719). The
 * getters then rebuild their singleton when the resolved key/base URL differs
 * from the one it was built with, so a rotation lands on the NEXT condensation
 * with no operator gesture.
 *
 * Why a stat-guard rather than a plain re-read on every call: the guard is also
 * the test-isolation mechanism. The file is read ONCE at module load to take the
 * baseline; a test run never rewrites `.env`, so every call below is inert under
 * vitest and no suite sees fleet values it did not set itself. Residual miss
 * window: a rewrite that keeps both byte size and mtimeMs identical — recorded
 * and accepted, its cost being the pre-#4095 behaviour until the next real write.
 *
 * Relationship to services/config-reload.ts: same source file, same host-owned
 * rule, narrower key set (condensation only) and no heavy imports. Deliberate —
 * importing config-reload from here would drag qdrant + search-codebase into
 * every `openai.ts` consumer and close a cycle (config-reload imports the
 * resetters from openai.ts). `chat-key-refresh.test.ts` guards the key-set
 * inclusion in RELOADABLE_ENV_KEYS so the two cannot drift apart silently.
 */

import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getHostEnvKeys } from './host-env-snapshot.js';

/**
 * The condensation keys this refresh may move. Names only — values never leave
 * `process.env`. A strict subset of config-reload's RELOADABLE_ENV_KEYS (asserted
 * by test): everything listed here must be a key the reload is also allowed to
 * touch, or the two paths would disagree about what a rotation may change.
 */
export const CHAT_ENV_KEYS = [
    // Primary chat client (getChatOpenAIClient); model id is read lazily per call
    'VLLM_API_KEY_MEDIUM',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_CHAT_MODEL_ID',
    // Cloud fallback (getFallbackChatOpenAIClient)
    'ZAI_API_KEY',
    'FALLBACK_API_KEY',
    'ZAI_BASE_URL',
    'FALLBACK_BASE_URL',
    'FALLBACK_LLM_MODEL_ID',
] as const;

/**
 * The same `.env` index.ts loads at startup and config-reload reads: the package
 * root, one level above the compiled vintage/build directory this module lives in.
 */
export function resolveChatEnvPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url)); // (build-<vintage>|src)/services
    return path.resolve(here, '..', '..', '.env');
}

interface EnvFileStat {
    mtimeMs: number;
    size: number;
}

let envPathOverride: string | null = null; // test-only
let lastStat: EnvFileStat | null = statOf(currentPath()); // baseline at module load — see header

function currentPath(): string {
    return envPathOverride ?? resolveChatEnvPath();
}

function statOf(envPath: string): EnvFileStat | null {
    try {
        const s = fs.statSync(envPath);
        return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
        // No `.env` (host-env-only seat, CI runner): nothing to read, stays inert.
        return null;
    }
}

/** Point the refresh at a different `.env` and re-baseline (tests only). */
export function setChatEnvPathForTest(envPath: string | null): void {
    envPathOverride = envPath;
    lastStat = statOf(currentPath());
}

/**
 * Bring the condensation keys from `.env` into `process.env` when the file changed.
 *
 * Returns the NAMES it changed (never values) so the caller can tell a rotation
 * from a no-op. A cheap `stat` and nothing else when the file is unchanged,
 * absent or unreadable — the client then keeps its current credentials and the
 * next call retries.
 */
export function refreshChatKeyEnvIfChanged(): string[] {
    const envPath = currentPath();
    const stat = statOf(envPath);
    if (stat === null) {
        lastStat = null; // a `.env` created later is picked up on the next call
        return [];
    }
    if (lastStat !== null && stat.mtimeMs === lastStat.mtimeMs && stat.size === lastStat.size) {
        return [];
    }
    lastStat = stat;

    let parsed: Record<string, string>;
    try {
        parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
    } catch {
        // Unreadable mid-write: keep the current credentials, retry on the next call.
        return [];
    }

    const hostKeys = getHostEnvKeys();
    const changed: string[] = [];
    for (const key of CHAT_ENV_KEYS) {
        if (!(key in parsed)) continue; // absent from `.env` → leave process.env alone
        if (hostKeys?.has(key)) continue; // #2719: the host outranked `.env` at boot — never invert
        if (process.env[key] === parsed[key]) continue;
        process.env[key] = parsed[key];
        changed.push(key);
    }
    return changed;
}