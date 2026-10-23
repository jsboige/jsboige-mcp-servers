/**
 * #3962 piste 5 — the condensation breaker is host-shared.
 *
 * Why this file exists: `condenseCB` used to live only in the module, so on a
 * host running dozens of RSM processes it almost never reached the 3-failure
 * threshold and every condensation paid the full primary timeout before the
 * cloud tier. The fix publishes the state to a small file per primary endpoint.
 * These tests use two module instances (two "processes") against the REAL temp
 * file — a single instance would pass even with the state still in memory.
 *
 * @module tools/roosync/__tests__/dashboard-condense-breaker-shared
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

type BreakerModule = {
  __condenseBreakerHooks: {
    recordFailure: () => void;
    recordSuccess: () => void;
    shouldBypass: () => boolean;
    stateFile: () => string;
  };
  resetCondenseCircuitBreaker: () => void;
};

/** Import a fresh module instance — a distinct in-memory breaker, same host files. */
async function freshModule(): Promise<BreakerModule> {
  vi.resetModules();
  return (await import('../dashboard.js')) as unknown as BreakerModule;
}

describe('#3962 piste 5 — host-shared condensation breaker', { timeout: 30000 }, () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rsm-cb-shared-'));
    stateFile = path.join(tmpDir, 'breaker.json');
    process.env.CONDENSE_CB_STATE_FILE = stateFile;
  });

  afterEach(async () => {
    delete process.env.CONDENSE_CB_STATE_FILE;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('one process opening the breaker opens it for another process on the host', async () => {
    const a = await freshModule();
    const b = await freshModule();

    // A sees a hung primary three times; B has never attempted anything.
    a.__condenseBreakerHooks.recordFailure();
    a.__condenseBreakerHooks.recordFailure();
    expect(b.__condenseBreakerHooks.shouldBypass()).toBe(false);
    a.__condenseBreakerHooks.recordFailure();

    // The whole point: B skips the primary without having failed once itself.
    expect(b.__condenseBreakerHooks.shouldBypass()).toBe(true);
    expect(a.__condenseBreakerHooks.shouldBypass()).toBe(true);

    const published = JSON.parse(await readFile(stateFile, 'utf8'));
    expect(published).toMatchObject({ consecutiveFailures: 3, isOpen: true });
  });

  it('a success in one process closes the breaker for the others', async () => {
    const a = await freshModule();
    const b = await freshModule();

    a.__condenseBreakerHooks.recordFailure();
    a.__condenseBreakerHooks.recordFailure();
    a.__condenseBreakerHooks.recordFailure();
    expect(b.__condenseBreakerHooks.shouldBypass()).toBe(true);

    b.__condenseBreakerHooks.recordSuccess();

    expect(b.__condenseBreakerHooks.shouldBypass()).toBe(false);
    const afterReset = await freshModule();
    expect(afterReset.__condenseBreakerHooks.shouldBypass()).toBe(false);
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toMatchObject({
      consecutiveFailures: 0,
      isOpen: false,
    });
  });

  it('the cooldown half-opens the shared breaker and clears the file', async () => {
    const a = await freshModule();
    // An OPEN state whose last failure is older than the 30 min cooldown.
    await writeFile(
      stateFile,
      JSON.stringify({ consecutiveFailures: 5, lastFailureTime: Date.now() - 31 * 60 * 1000, isOpen: true }),
      'utf8',
    );

    expect(a.__condenseBreakerHooks.shouldBypass()).toBe(false);
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toMatchObject({ consecutiveFailures: 0, isOpen: false });
  });

  it('an OPEN state still inside the cooldown keeps bypassing', async () => {
    const a = await freshModule();
    await writeFile(
      stateFile,
      JSON.stringify({ consecutiveFailures: 5, lastFailureTime: Date.now() - 60 * 1000, isOpen: true }),
      'utf8',
    );

    expect(a.__condenseBreakerHooks.shouldBypass()).toBe(true);
  });

  it('a corrupt state file is ignored and the in-memory breaker still works', async () => {
    const a = await freshModule();
    await writeFile(stateFile, '{ this is not json', 'utf8');

    // Fail-open: an unreadable file must never wedge condensation.
    expect(a.__condenseBreakerHooks.shouldBypass()).toBe(false);

    a.__condenseBreakerHooks.recordFailure();
    a.__condenseBreakerHooks.recordFailure();
    a.__condenseBreakerHooks.recordFailure();
    // The failure path republishes a valid state, so the breaker opens normally.
    expect(a.__condenseBreakerHooks.shouldBypass()).toBe(true);
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toMatchObject({ consecutiveFailures: 3, isOpen: true });
  });

  it('the state file is keyed by primary endpoint when no explicit path is set', async () => {
    const a = await freshModule();
    const original = process.env.CONDENSE_CB_STATE_FILE;
    delete process.env.CONDENSE_CB_STATE_FILE;

    try {
      delete process.env.OPENAI_BASE_URL;
      const dflt = a.__condenseBreakerHooks.stateFile();
      process.env.OPENAI_BASE_URL = 'http://localhost:5002/v1';
      const one = a.__condenseBreakerHooks.stateFile();
      process.env.OPENAI_BASE_URL = 'http://192.168.0.47:5002/v1';
      const other = a.__condenseBreakerHooks.stateFile();

      expect(dflt).not.toBe(one);
      expect(one).not.toBe(other);
      // Same endpoint, same file — across module instances too.
      const b = await freshModule();
      expect(b.__condenseBreakerHooks.stateFile()).toBe(other);
    } finally {
      if (original === undefined) delete process.env.CONDENSE_CB_STATE_FILE;
      else process.env.CONDENSE_CB_STATE_FILE = original;
      delete process.env.OPENAI_BASE_URL;
    }
  });

  it('a future lastFailureTime is clamped on read and cannot pin the breaker open past one TTL', async () => {
    // #3962 review note: a clock corrected backwards after a write leaves a
    // future stamp in the file. Unclamped, `Date.now() - lastFailureTime` is
    // negative and the cooldown NEVER elapses — the breaker stays OPEN until
    // the wall clock re-reaches a moment that may be hours away. The read must
    // clamp the stamp to now and republish, so the cooldown counts from the
    // first read that saw the skew.
    const a = await freshModule();
    const t0 = Date.now();
    await writeFile(stateFile, JSON.stringify({ consecutiveFailures: 3, lastFailureTime: t0 + 60 * 60 * 1000, isOpen: true }), 'utf8');

    vi.useFakeTimers();
    try {
      // 31 min in: still OPEN (the clamp restarts the cooldown from THIS read)
      // and the file no longer carries the future stamp.
      vi.setSystemTime(t0 + 31 * 60 * 1000);
      expect(a.__condenseBreakerHooks.shouldBypass()).toBe(true);
      expect(JSON.parse(await readFile(stateFile, 'utf8')).lastFailureTime).toBeLessThanOrEqual(Date.now());

      // 62 min in (31 min after the clamp): half-open — at most one TTL after
      // the skew was first seen, not until the bogus wall-clock moment.
      vi.setSystemTime(t0 + 62 * 60 * 1000);
      expect(a.__condenseBreakerHooks.shouldBypass()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
