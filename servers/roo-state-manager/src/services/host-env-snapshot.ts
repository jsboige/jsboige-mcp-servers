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
 * No imports on purpose: index.ts loads it statically, ahead of everything else.
 *
 * @module services/host-env-snapshot
 */

let hostEnvKeys: ReadonlySet<string> | null = null;

/** Record the names the host set. Call once, BEFORE `dotenv.config()`. */
export function captureHostEnvKeys(env: NodeJS.ProcessEnv = process.env): void {
  hostEnvKeys = new Set(Object.keys(env).filter((k) => env[k] !== undefined));
}

/** Host-set names captured at startup, or null when never captured (tests, scripts). */
export function getHostEnvKeys(): ReadonlySet<string> | null {
  return hostEnvKeys;
}

/** Test-only: forget the snapshot. */
export function resetHostEnvKeysForTest(): void {
  hostEnvKeys = null;
}
