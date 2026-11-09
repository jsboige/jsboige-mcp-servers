/**
 * #4611 — the `all` target of `roosync_config`.
 *
 * The tool layer is the entry point users actually call, so the schema contract is
 * tested here (not only the service behind it):
 *  - `targets: ["all"]` is accepted for `collect` ONLY;
 *  - it is exclusive with the package vocabulary (`["all", "modes"]` is refused);
 *  - it never reaches publish/apply, where `["all"]` would be handed to the file
 *    package collector and fail obscurely.
 *
 * The handler itself is exercised in
 * `tests/unit/services/machine-config-collector.test.ts` (case 14 usage test).
 *
 * @module roosync/config-target-all.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.unmock('fs');

async function loadSchema() {
  const module = await import('../../../../src/tools/roosync/config.js');
  return module.ConfigArgsSchema;
}

describe('roosync_config — target "all" (#4611)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('accepts action=collect with targets=["all"]', async () => {
    const schema = await loadSchema();
    const result = schema.safeParse({ action: 'collect', targets: ['all'] });
    expect(result.success).toBe(true);
  });

  it('REFUSES "all" mixed with a package target (exclusive vocabulary)', async () => {
    const schema = await loadSchema();
    const result = schema.safeParse({ action: 'collect', targets: ['all', 'modes'] });
    expect(result.success).toBe(false);
  });

  it('REFUSES "all" for publish (collect-only)', async () => {
    const schema = await loadSchema();
    const result = schema.safeParse({
      action: 'publish',
      targets: ['all'],
      version: '1.0.0',
      description: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('REFUSES "all" for apply', async () => {
    const schema = await loadSchema();
    const result = schema.safeParse({ action: 'apply', targets: ['all'] });
    expect(result.success).toBe(false);
  });

  it('REFUSES "all" for apply_profile', async () => {
    const schema = await loadSchema();
    const result = schema.safeParse({ action: 'apply_profile', targets: ['all'], profileName: 'x' });
    expect(result.success).toBe(false);
  });

  it('still accepts the package targets unchanged (no regression)', async () => {
    const schema = await loadSchema();
    expect(schema.safeParse({ action: 'collect', targets: ['modes', 'mcp'] }).success).toBe(true);
    expect(schema.safeParse({ action: 'collect', targets: ['mcp:roo-state-manager'] }).success).toBe(true);
    expect(schema.safeParse({ action: 'collect', targets: ['unknown-target'] }).success).toBe(false);
  });
});
