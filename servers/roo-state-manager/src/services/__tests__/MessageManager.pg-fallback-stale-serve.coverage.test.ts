/**
 * #4131 B11(b) — on a PG read failure, serve the cache (stale included) rather
 * than awaiting a full G: rebuild.
 *
 * The defect: the PG-failure fallback forwarded the caller's `deep`, so a
 * `deep: true` inbox call — the tools' read path — landed on
 * `ensureInboxCache({ deep })`, whose `deep + partial cache` branch AWAITS the
 * whole G: rebuild (#3292). With PG down and a large pool on a contended
 * DriveFS, that is precisely the long call the PG primary path exists to
 * remove: the caller pays a full G: pass to learn what the warm cache already
 * had. The fix downgrades `deep` on this degraded path only — a warm cache is
 * served immediately and refreshed in the background; only a cache with nothing
 * to hand back makes the caller wait (the cold-start case, unavoidable).
 *
 * Instrumentation: the rebuild's reads are gated — the pass cannot finish until
 * the test opens the gate — so "did the caller wait for the rebuild?" is decided
 * by whether the call resolves while the gate is shut: the fix resolves, the
 * pre-fix code pends and loses the race to the sentinel (deterministic red).
 *
 * Tooling note: the root vitest config sets `mockReset: true`, which wipes the
 * implementation a `vi.mock` factory installs, before EVERY test. The read mock
 * is therefore (re)armed in `beforeEach` (an implementation left in the factory
 * silently degrades to `undefined` and the pass reads nothing).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const READ_TIMEOUT_MS = 10_000;
const RECIPIENT = 'myia-po-2024';
/** One chunk's worth of reads under the derived cap (8 − 2). */
const ONE_CHUNK_BUDGET_MS = 6;
const SEEDED = 24;
/** Real-time sentinel for "the caller pended on the gated rebuild". */
const RACE_MS = 250;

const mocks = vi.hoisted(() => {
  process.env.UV_THREADPOOL_SIZE = '8';
  const gate = {
    promise: Promise.resolve() as Promise<void>,
    open: (() => {}) as () => void,
  };
  return {
    warn: vi.fn(),
    error: vi.fn(),
    readFile: vi.fn(),
    inFlight: 0,
    /** Virtual clock: every inbox read costs 1 ms, so a budget of one chunk
     *  truncates exactly after that chunk (#3292 determinism, as in the
     *  partial-cache-merge suite). */
    fakeNow: 1_000_000_000,
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

// The PG reader exists and the mailbox read FAILS: that is the fallback's
// pre-condition (a null reader would skip the branch entirely).
vi.mock('../unified-store/roosync-channel-read.js', () => ({
  getChannelPgReader: () => ({ stub: true }),
  readChannelInboxFromPg: async () => null,
  countChannelInboxFromPg: async () => null,
  getChannelMessageFromPg: async () => null,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: { ...actual.promises, readFile: mocks.readFile },
  };
});

import { MessageManager } from '../MessageManager.js';

const realFs = await vi.importActual<typeof import('fs')>('fs');
const realReadFile = realFs.promises.readFile as (p: string, enc: string) => Promise<string>;

/** (Re)install the read mock — `mockReset: true` wipes it before every test. */
function armReadFile(): void {
  mocks.readFile.mockImplementation(async (filePath: unknown) => {
    const p = String(filePath).replace(/\\/g, '/');
    if (p.includes('/inbox/') && p.endsWith('.json')) {
      mocks.inFlight++;
      mocks.fakeNow += 1; // 1 ms of virtual time per inbox read
      try {
        await mocks.gate.promise; // shut = the pass cannot finish
        return await realReadFile(String(filePath), 'utf-8');
      } finally {
        mocks.inFlight--;
      }
    }
    return (realReadFile as never)(filePath as never);
  });
}

function idAt(index: number): string {
  const hhmmss = `00${String(Math.floor(index / 60)).padStart(2, '0')}${String(index % 60).padStart(2, '0')}`;
  return `msg-20260801T${hhmmss}-${String(index).padStart(6, '0')}`;
}

function makeTempSharedState(): string {
  const dir = join(tmpdir(), `mm-pg-fallback-${randomUUID()}`);
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

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('MessageManager — PG failure serves the warm cache, not a full rebuild (#4131 B11(b))', () => {
  let sharedState: string;

  beforeEach(() => {
    sharedState = makeTempSharedState();
    mocks.fakeNow = 1_000_000_000;
    mocks.inFlight = 0;
    mocks.warn.mockClear();
    mocks.error.mockClear();
    // Fresh gate, SHUT: gated reads stay in flight until the test opens it.
    let open!: () => void;
    const gatePromise = new Promise<void>(resolve => { open = resolve; });
    mocks.gate.promise = gatePromise;
    mocks.gate.open = open;
    vi.spyOn(Date, 'now').mockImplementation(() => mocks.fakeNow);
    armReadFile();
  });

  afterEach(() => {
    mocks.gate.open();
    rmSync(sharedState, { recursive: true, force: true });
  });

  test('a deep call that loses PG resolves on the stale partial cache while the rebuild is still running', async () => {
    for (let i = 1; i <= SEEDED; i++) seedInboxMessage(sharedState, i);
    const manager = new MessageManager(sharedState, READ_TIMEOUT_MS);
    (manager as any).rebuildBudgetMs = ONE_CHUNK_BUDGET_MS;

    // Pass 1 — gate OPEN: reads complete, the budget truncates after one chunk,
    // and the partial cache is installed (flagged, lastInboxFileCount = -1).
    mocks.gate.open();
    const first = await manager.readInbox(RECIPIENT, 'all', undefined, undefined, undefined, undefined, true);
    await (manager as any).inboxRebuildInFlight;
    expect(first).toHaveLength(ONE_CHUNK_BUDGET_MS);
    expect(manager.isInboxCachePartial()).toBe(true);

    // Pass 2 — gate SHUT: any rebuild read stays in flight until this test says
    // otherwise, and the TTL is expired so the fast path cannot answer.
    let open!: () => void;
    const shut = new Promise<void>(resolve => { open = resolve; });
    mocks.gate.promise = shut;
    (manager as any).cacheBuiltAt = 0;
    (manager as any).contentBuiltAt = 0;

    const raced = await Promise.race([
      manager.readInbox(RECIPIENT, 'all', undefined, undefined, undefined, undefined, true)
        .then(items => ({ items })),
      delay(RACE_MS).then(() => 'GATED' as const),
    ]);

    // Pre-fix: `deep: true` reaches ensureInboxCache, whose `deep + partial`
    // branch awaits the rebuild — gated forever here — and the sentinel wins.
    expect(raced).not.toBe('GATED');
    const items = (raced as { items: unknown[] }).items;
    expect(items).toHaveLength(ONE_CHUNK_BUDGET_MS); // the warm partial cache
    expect(mocks.inFlight).toBeGreaterThan(0); // the background refresh IS running
    expect((manager as any).inboxRebuildInFlight).not.toBeNull();

    // Drain the background pass so nothing leaks into the next test.
    open();
    await (manager as any).inboxRebuildInFlight;
  }, 10_000);
});