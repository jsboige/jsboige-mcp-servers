/**
 * #4131 B11(b) — the inbox rebuild must leave threadpool headroom.
 *
 * The defect: `READ_CONCURRENCY` was a flat 50 against libuv's default pool of 4
 * threads. During a rebuild the G: reads occupied the pool entire, and an
 * operation the same pool serves — the DNS lookup and TLS handshake of a PG
 * connect — queued behind the whole batch. The fix derives the cap from the pool
 * (`pool - THREADPOOL_RESERVE`, see MessageManager) and the wrapper raises
 * `UV_THREADPOOL_SIZE` on the server child, so the smaller cap keeps throughput.
 *
 * Instrumentation: libuv's pool is not ours to inspect from a unit test, so the
 * test MODELS it — a lane semaphore of POOL_TOTAL lanes stands in for the
 * threadpool, every mocked inbox read holds a lane while it is in flight, and a
 * probe (the stand-in for a PG connect's threadpool work) asks for one. What is
 * pinned is the property that makes the reserve real: in-flight inbox reads
 * never exceed pool - THREADPOOL_RESERVE, so a concurrent operation always finds
 * a lane. The pre-fix code enqueues its whole first chunk at once (SEEDED here
 * is 24 > the 6 cap), and the maxInFlight assertion kills it.
 *
 * Tooling note: the root vitest config sets `mockReset: true`, which wipes the
 * implementation a `vi.mock` factory installs, before EVERY test. The read mock
 * is therefore (re)armed in `beforeEach` — an implementation left in the factory
 * silently degrades to `undefined` and the pass reads nothing.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

/** The pool the wrapper sets on the server child (#4131 B11(b)). */
const POOL_TOTAL = 8;
/** pool − THREADPOOL_RESERVE(2) — the cap the derived value must produce. */
const EXPECTED_CAP = 6;
/** More files than one chunk: the pre-fix code sends them all at once. */
const SEEDED = 24;
const READ_TIMEOUT_MS = 10_000;
const RECIPIENT = 'myia-po-2024';

const mocks = vi.hoisted(() => {
  // The wrapper's env reaches the child's process env BEFORE the module is
  // evaluated — the static READ_CONCURRENCY is computed at import time, so this
  // hoisted assignment is what makes the module see the wrapper's pool.
  process.env.UV_THREADPOOL_SIZE = '8';
  const gate = {
    promise: Promise.resolve() as Promise<void>,
    open: (() => {}) as () => void,
  };
  return {
    warn: vi.fn(),
    error: vi.fn(),
    readFile: vi.fn(),
    // --- threadpool stand-in (see header) ---
    slotsInUse: 0,
    inFlight: 0,
    maxInFlight: 0,
    gate,
  };
});

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mocks.warn,
    error: mocks.error,
    debug: vi.fn(),
  }),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: { ...actual.promises, readFile: mocks.readFile },
  };
});

import { MessageManager, deriveReadConcurrency, THREADPOOL_RESERVE } from '../MessageManager.js';

const realFs = await vi.importActual<typeof import('fs')>('fs');
const realReadFile = realFs.promises.readFile as (p: string, enc: string) => Promise<string>;

/** Lanes handed to queued holders; a woken waiter inherits the lane. */
const laneWaiters: Array<() => void> = [];

function acquireLane(): Promise<void> {
  if (mocks.slotsInUse < POOL_TOTAL) {
    mocks.slotsInUse++;
    return Promise.resolve();
  }
  return new Promise<void>(resolve => laneWaiters.push(resolve));
}

function releaseLane(): void {
  const next = laneWaiters.shift();
  if (next) next(); // the lane passes straight to the queued holder
  else mocks.slotsInUse--;
}

/** (Re)install the read mock — `mockReset: true` wipes it before every test. */
function armReadFile(): void {
  mocks.readFile.mockImplementation(async (filePath: unknown) => {
    const p = String(filePath).replace(/\\/g, '/');
    if (p.includes('/inbox/') && p.endsWith('.json')) {
      // A rebuild read: hold a pool lane for its whole duration, and a gate the
      // test keeps shut so "the pass is still running" is a fact, not a race.
      await acquireLane();
      mocks.inFlight++;
      mocks.maxInFlight = Math.max(mocks.maxInFlight, mocks.inFlight);
      try {
        await mocks.gate.promise;
        return await realReadFile(String(filePath), 'utf-8');
      } finally {
        mocks.inFlight--;
        releaseLane();
      }
    }
    return (realReadFile as never)(filePath as never);
  });
}

/**
 * The stand-in for a PG connect's threadpool work (getaddrinfo + TLS): it needs
 * a lane NOW, not after the rebuild's queue drains.
 */
function pgProbe(): { waited: boolean } {
  return { waited: mocks.slotsInUse >= POOL_TOTAL };
}

function idAt(index: number): string {
  const hhmmss = `00${String(Math.floor(index / 60)).padStart(2, '0')}${String(index % 60).padStart(2, '0')}`;
  return `msg-20260801T${hhmmss}-${String(index).padStart(6, '0')}`;
}

function makeTempSharedState(): string {
  const dir = join(tmpdir(), `mm-pool-reserve-${randomUUID()}`);
  for (const sub of ['messages', 'messages/inbox', 'messages/sent', 'messages/archive']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return dir;
}

function seedInboxMessage(sharedState: string, index: number): void {
  const id = idAt(index);
  const msg = {
    id,
    from: 'myia-po-2023',
    to: RECIPIENT,
    subject: `subject-${id}`,
    body: `body-${id}`,
    priority: 'MEDIUM',
    timestamp: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
    status: 'read',
  };
  writeFileSync(join(sharedState, 'messages', 'inbox', `${id}.json`), JSON.stringify(msg), 'utf-8');
}

describe('MessageManager — threadpool reserve for the inbox rebuild (#4131 B11(b))', () => {
  let sharedState: string;

  beforeEach(() => {
    sharedState = makeTempSharedState();
    mocks.slotsInUse = 0;
    mocks.inFlight = 0;
    mocks.maxInFlight = 0;
    mocks.warn.mockClear();
    mocks.error.mockClear();
    // A fresh, SHUT gate: gated reads stay in flight until the test opens it.
    let open!: () => void;
    const gatePromise = new Promise<void>(resolve => { open = resolve; });
    mocks.gate.promise = gatePromise;
    mocks.gate.open = open;
    armReadFile();
  });

  afterEach(() => {
    mocks.gate.open(); // drain anything the assertions left in flight
    rmSync(sharedState, { recursive: true, force: true });
  });

  test('in-flight inbox reads never take the pool entire — a PG probe finds a lane', async () => {
    for (let i = 1; i <= SEEDED; i++) seedInboxMessage(sharedState, i);
    const manager = new MessageManager(sharedState, READ_TIMEOUT_MS);

    // Cold cache, deep pass: the rebuild is awaited and every read is gated.
    const pending = manager.readInbox(RECIPIENT, 'all', undefined, undefined, undefined, undefined, true);
    await vi.waitFor(() => {
      expect(mocks.inFlight).toBeGreaterThanOrEqual(EXPECTED_CAP);
    }, { timeout: 5_000 });

    // The pass is RUNNING: reads in flight, gate still shut.
    // Pre-fix: the whole chunk is enqueued at once — 24 reads, pool-bound to 8.
    expect(mocks.inFlight).toBe(EXPECTED_CAP);
    expect(mocks.maxInFlight).toBeLessThanOrEqual(EXPECTED_CAP);
    expect(mocks.slotsInUse).toBeLessThanOrEqual(EXPECTED_CAP);

    // "A PG connect passes while the reads are running": a lane is free NOW,
    // at the very moment the rebuild is holding its lanes.
    const probe = pgProbe();
    expect(mocks.inFlight).toBeGreaterThan(0); // it really was DURING the pass
    expect(probe.waited).toBe(false); // pre-fix: the pool is taken entire → true

    // Let the pass finish: the constraint must hold across EVERY chunk.
    mocks.gate.open();
    const items = await pending;
    expect(items).toHaveLength(SEEDED);
    expect(mocks.maxInFlight).toBeLessThanOrEqual(EXPECTED_CAP);
    expect(mocks.slotsInUse).toBe(0);
    expect(laneWaiters).toHaveLength(0);
  }, 10_000);

  test('the module under the wrapper pool derives the cap (8 → 6)', () => {
    expect(process.env.UV_THREADPOOL_SIZE).toBe('8'); // armed in vi.hoisted, before import
    expect((MessageManager as any).READ_CONCURRENCY).toBe(EXPECTED_CAP);
  });

  test('the cap derives from the pool: reserve kept, floor 2, historical ceiling 50', () => {
    expect(THREADPOOL_RESERVE).toBe(2);
    expect(deriveReadConcurrency({})).toBe(2); // libuv default pool of 4, minus the reserve
    expect(deriveReadConcurrency({ UV_THREADPOOL_SIZE: '4' })).toBe(2);
    expect(deriveReadConcurrency({ UV_THREADPOOL_SIZE: '8' })).toBe(EXPECTED_CAP); // the wrapper's pool
    expect(deriveReadConcurrency({ UV_THREADPOOL_SIZE: '1' })).toBe(2); // never idle the rebuild entirely
    expect(deriveReadConcurrency({ UV_THREADPOOL_SIZE: '128' })).toBe(50); // a big pool keeps the old ceiling
    expect(deriveReadConcurrency({ UV_THREADPOOL_SIZE: 'garbage' })).toBe(2); // unparsable → default pool
  });
});