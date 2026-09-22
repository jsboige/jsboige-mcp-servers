/**
 * #2719 (2026-09-22) — startup precedence for the `.env` hot reload.
 *
 * At startup, `dotenv.config()` (index.ts) never overrides a variable the HOST
 * already set (MCP client `env` block, wrapper, shell): host > `.env`. A reload
 * that copied `.env` over such a variable inverted that precedence. Measured on
 * ai-01: a reload re-pointed EMBEDDING_API_BASE_URL from the host's LAN endpoint
 * to the `.env` public proxy, silently.
 *
 * index.ts records the host-set names BEFORE dotenv runs; the reload leaves those
 * keys alone, so a reload yields what a restart would.
 *
 * Under mcp-wrapper.cjs (every fleet launch) a snapshot of the child's own env is
 * worthless: the wrapper loads `.env` into ITS env and spawns the child with all of
 * it, so every `.env` key would look host-set and the reload would move nothing.
 * The wrapper records the names before its own `.env` load and hands them over in
 * RSM_HOST_ENV_KEYS. A child started by an older wrapper, which hands nothing,
 * falls back to the snapshot: the reload then reports those keys as host-owned
 * instead of silently re-pointing one the host set.
 *
 * No imports on purpose: index.ts loads it statically, ahead of everything else.
 *
 * @module services/host-env-snapshot
 */

/** Comma-separated host-set names, written into the child's env by mcp-wrapper.cjs. */
export const HOST_ENV_KEYS_VAR = 'RSM_HOST_ENV_KEYS';

let hostEnvKeys: ReadonlySet<string> | null = null;

/**
 * Record the names the host set. Call once, BEFORE `dotenv.config()`. The list the
 * wrapper handed over wins; without it (direct launch, older wrapper) the env is
 * snapshotted.
 */
export function captureHostEnvKeys(env: NodeJS.ProcessEnv = process.env): void {
  const handed = env[HOST_ENV_KEYS_VAR];
  hostEnvKeys = handed !== undefined
    ? new Set(handed.split(',').filter(Boolean))
    : new Set(Object.keys(env).filter((k) => env[k] !== undefined));
}

/**
 * Give every key the host did NOT set the value `.env` holds now, as a restart does.
 * Needed under the wrapper: its env carries the `.env` it read when IT started, and
 * dotenv never overrides, so a hot-swapped child would keep those values however
 * `.env` changed since. Launched directly, dotenv has just set these very values:
 * a no-op. Keys absent from `.env` are left alone, as the reload does.
 * Returns the names it changed — names only, never values.
 */
export function applyEnvFileForNonHostKeys(
  parsed: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!parsed || !hostEnvKeys) return [];
  const changed: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (hostEnvKeys.has(key) || env[key] === value) continue;
    env[key] = value;
    changed.push(key);
  }
  return changed;
}

/** Host-set names captured at startup, or null when never captured (tests, scripts). */
export function getHostEnvKeys(): ReadonlySet<string> | null {
  return hostEnvKeys;
}

/** Test-only: forget the snapshot. */
export function resetHostEnvKeysForTest(): void {
  hostEnvKeys = null;
}
