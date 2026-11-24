/**
 * #4884 — guard for the tool-usage cache isolation pin in tests/setup-env.ts.
 *
 * The production cache lives at os.tmpdir()/roo-state-manager-cache (derived from
 * os.tmpdir(), NOT the homedir the tests mock — roosync-indexing.tool.ts). Without
 * the setup-env.ts pin (#1783), any suite reaching the cache code overwrites the
 * host's real cache, and the weekly save_snapshot then exceeds the 300 s MCP
 * timeout (measured 16/11 and 23/11 on ai-01).
 *
 * The first two tests fail on the base if the pin is removed. The last two
 * close the hole a CONDITIONAL pin left: a seat that exports
 * ROOSYNC_TOOL_USAGE_CACHE_DIR (shell or .env) kept its own value, so
 * "not the production default" stayed green with no pin in force — and the
 * test run wrote wherever that value pointed, production cache included.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP_ENV = path.join(__dirname, '..', 'setup-env.ts');
const PRODUCTION_DEFAULT = path.join(os.tmpdir(), 'roo-state-manager-cache');

// Same node gate as tests/unit/setup-env-teardown.test.ts: the child proof needs
// native type stripping (--experimental-strip-types, Node >= 22.6). On an older
// runtime the child dies on the unknown flag before importing anything — skip.
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number);
const STRIP_TYPES_SUPPORTED = NODE_MAJOR > 22 || (NODE_MAJOR === 22 && NODE_MINOR >= 6);

const CHILD_SCRIPT = `
const { pathToFileURL } = await import('node:url');
const fs = await import('node:fs');
await import(pathToFileURL(process.env.SETUP_ENV_PATH).href);
const dir = process.env.ROOSYNC_TOOL_USAGE_CACHE_DIR;
console.log(JSON.stringify({ dir, existed: fs.existsSync(dir) }));
`.trim();

describe('#4884 — tool-usage cache is isolated from production under test setup', () => {
  it('ROOSYNC_TOOL_USAGE_CACHE_DIR is pinned by setup-env.ts', () => {
    expect(process.env.ROOSYNC_TOOL_USAGE_CACHE_DIR).toBeDefined();
  });

  it('the resolved cache dir is NOT the production default os.tmpdir()/roo-state-manager-cache', () => {
    const resolved = process.env.ROOSYNC_TOOL_USAGE_CACHE_DIR;
    expect(resolved).toBeDefined();
    expect(path.resolve(resolved!)).not.toBe(path.resolve(PRODUCTION_DEFAULT));
  });

  it('the resolved cache dir is the per-worker dir setup-env.ts created', () => {
    // A SEAT value is the blind spot of the assertion above: any pre-set dir
    // other than the production default kept both tests green, pin or no pin.
    expect(path.basename(process.env.ROOSYNC_TOOL_USAGE_CACHE_DIR!)).toMatch(/^rsm-test-tus-cache-/);
  });

  it.skipIf(!STRIP_TYPES_SUPPORTED)('a seat-pre-set value is overridden in a fresh process', () => {
    // In-process, the setup already ran: "pin removed" and "seat value" are
    // indistinguishable. A fresh child that PRE-SETS the production default is
    // the faithful model of a seat exporting it (shell or .env).
    const env = { ...process.env } as NodeJS.ProcessEnv;
    env.ROOSYNC_TOOL_USAGE_CACHE_DIR = PRODUCTION_DEFAULT;
    env.SETUP_ENV_PATH = SETUP_ENV;
    env.NODE_OPTIONS = ''; // do not inherit experimental flags from the runner

    const child = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', CHILD_SCRIPT],
      { env, encoding: 'utf-8', timeout: 60_000 },
    );

    expect(child.status).toBe(0);
    const lastLine = child.stdout.trim().split('\n').pop() ?? '';
    const { dir, existed } = JSON.parse(lastLine) as { dir?: string; existed: boolean };

    expect(dir).toBeDefined();
    expect(existed).toBe(true); // the child really created its own dir
    expect(path.resolve(dir!)).not.toBe(path.resolve(PRODUCTION_DEFAULT));
    expect(path.basename(dir!)).toMatch(/^rsm-test-tus-cache-/);
    // ...and registered it for teardown, like the normal pin path.
    expect(fs.existsSync(dir!)).toBe(false);
  }, 90_000);
});
