/**
 * #4131 Phase D — the config gate: an absent shared path no longer throws
 * WHEN a PG store is configured; it still throws (fail-closed, unchanged)
 * when it is not.
 *
 * Measured BEFORE (28/10, #4131 Phase D §3): with the mount absent,
 * loadRooSyncConfig threw RooSyncConfigError and getRooSyncService threw
 * behind it — 18 tools down. This file locks the new default.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadRooSyncConfig, RooSyncConfigError } from '../roosync-config.js';

const KEYS = {
  SHARED: 'ROOSYNC_SHARED_PATH',
  MACHINE: 'ROOSYNC_MACHINE_ID',
  AUTO: 'ROOSYNC_AUTO_SYNC',
  CONFLICT: 'ROOSYNC_CONFLICT_STRATEGY',
  LOG: 'ROOSYNC_LOG_LEVEL',
  PG: 'UNIFIED_STORE_PG_URL',
  DW: 'UNIFIED_STORE_DUAL_WRITE',
  // A seat exporting its real roster rejects 'test-machine' before the gate
  // under test (po-2028, 29/10: 2 failures, CI green because the runner has no
  // roster). Saved and scrubbed like every other key.
  ROSTER: 'ROO_FLEET_ROSTER',
} as const;

const SAVED: Record<string, string | undefined> = {};

function setEnv(overrides: Record<string, string | undefined>): void {
  const base: Record<string, string> = {
    // POSIX form: the Ubuntu runner's path.isAbsolute() is posix.isAbsolute(),
    // for which 'C:\...' is NOT absolute — the test would die one branch above
    // the gate under test ("must be an absolute path"). Hermes ms#1563 review.
    [KEYS.SHARED]: '/__no_such_mount__/shared-state',
    [KEYS.MACHINE]: 'test-machine',
    [KEYS.AUTO]: 'true',
    [KEYS.CONFLICT]: 'manual',
    [KEYS.LOG]: 'info',
  };
  for (const key of Object.values(KEYS)) {
    SAVED[key] = process.env[key];
  }
  // jest.setup sets NODE_ENV='test', whose branch RETURNS EARLY and never
  // reaches the existsSync gate — the blocker lives in the production branch.
  SAVED['NODE_ENV'] = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  for (const [key, value] of Object.entries({ [KEYS.ROSTER]: undefined, ...base, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('#4131 Phase D — config gate: absent shared path × PG presence', () => {
  it('no PG URL → still throws (fail-closed, unchanged)', () => {
    setEnv({ [KEYS.PG]: undefined });
    expect(() => loadRooSyncConfig()).toThrow(RooSyncConfigError);
    expect(() => loadRooSyncConfig()).toThrow(/n'existe pas/);
  });

  it('empty-string PG URL (the test-suite pin) → still throws', () => {
    setEnv({ [KEYS.PG]: '' });
    expect(() => loadRooSyncConfig()).toThrow(RooSyncConfigError);
  });

  it('PG URL present → loads, sharedPath kept verbatim (PG-primary mode)', () => {
    setEnv({ [KEYS.PG]: 'postgresql://user:pass@host:5432/db' });
    const config = loadRooSyncConfig();
    // loadRooSyncConfig resolves the path — compare the resolved form, which
    // stays platform-independent ('D:\__no_such...' on Windows, '/__no_such...'
    // on the Ubuntu runner).
    expect(config.sharedPath).toBe(path.resolve('/__no_such_mount__/shared-state'));
    expect(config.machineId).toBe('test-machine');
  });

  it('PG URL present but kill-switch UNIFIED_STORE_DUAL_WRITE=0 → throws again (GDrive-only)', () => {
    setEnv({ [KEYS.PG]: 'postgresql://user:pass@host:5432/db', [KEYS.DW]: '0' });
    expect(() => loadRooSyncConfig()).toThrow(/n'existe pas/);
  });

  it('an EXISTING shared path keeps loading exactly as before, PG or not', () => {
    // tmpdir exists on every platform — the absolute-path branch below the gate.
    setEnv({ [KEYS.PG]: undefined, [KEYS.SHARED]: os.tmpdir() });
    expect(() => loadRooSyncConfig()).not.toThrow();
    setEnv({ [KEYS.PG]: 'postgresql://user:pass@host:5432/db' });
    expect(() => loadRooSyncConfig()).not.toThrow();
  });
});
