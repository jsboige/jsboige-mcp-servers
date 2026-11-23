/**
 * #4884 — guard for the tool-usage cache isolation pin in tests/setup-env.ts.
 *
 * The production cache lives at os.tmpdir()/roo-state-manager-cache (derived from
 * os.tmpdir(), NOT the homedir the tests mock — roosync-indexing.tool.ts). Without
 * the setup-env.ts pin (#1783), any suite reaching the cache code overwrites the
 * host's real cache, and the weekly save_snapshot then exceeds the 300 s MCP
 * timeout (measured 16/11 and 23/11 on ai-01).
 *
 * This test fails on the base if the pin is removed: under the test setup, the
 * resolved cache dir must NOT be the production default.
 */
import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

describe('#4884 — tool-usage cache is isolated from production under test setup', () => {
  it('ROOSYNC_TOOL_USAGE_CACHE_DIR is pinned by setup-env.ts', () => {
    expect(process.env.ROOSYNC_TOOL_USAGE_CACHE_DIR).toBeDefined();
  });

  it('the resolved cache dir is NOT the production default os.tmpdir()/roo-state-manager-cache', () => {
    const productionDefault = path.join(os.tmpdir(), 'roo-state-manager-cache');
    const resolved = process.env.ROOSYNC_TOOL_USAGE_CACHE_DIR;
    expect(resolved).toBeDefined();
    expect(path.resolve(resolved!)).not.toBe(path.resolve(productionDefault));
  });
});
