/**
 * B18 (#4131) — two contracts on the inbox read path:
 *
 * (a) PG-FIRST COLD INBOX. On a healthy PG_PRIMARY seat the inbox is served
 *     from PG *without* touching G: — including when the cache is stone cold
 *     and including `deep: true` / `getFilteredCount`. The G: pool is only an
 *     export; a cold cache must never re-introduce the DriveFS fan-out (#4131
 *     B16 removed the fan-out on PG *failure* — this pins it on PG *success*).
 *
 * (b) BOUNDED REBUILD. When the share does answer slowly or refuses reads, the
 *     rebuild must not walk the pool at full width: a chunk that fails at least
 *     half its reads halves the batch, doubles the inter-chunk pause, and the
 *     global budget is re-checked after every chunk (not only before one). The
 *     measured incident was 230+ timeouts in a storm fed by back-to-back
 *     full-width chunks.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const MACHINE = 'myia-po-2023';
const WORKSPACE = 'roo-extensions';

const mocks = vi.hoisted(() => ({
  pgActive: true,
  inboxItems: [] as Array<Record<string, unknown>>,
  counts: { total: 0, unread: 0, read: 0 },
  sharedPath: '',
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../unified-store/roosync-channel-read.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getChannelPgReader: () => (mocks.pgActive ? { stub: true } : null),
    readChannelInboxFromPg: async () => mocks.inboxItems,
    readChannelMailboxFromPg: async () => [],
    countChannelInboxFromPg: async () => mocks.counts,
  };
});

import { MessageManager, deriveReadConcurrency } from '../MessageManager.js';
import { resetChannelPgBreakerForTests } from '../unified-store/channel-pg-breaker.js';

const ENV_KEYS = [
  'ROOSYNC_MACHINE_ID',
  'ROOSYNC_WORKSPACE_ID',
  'UNIFIED_STORE_CHANNEL_READ_PG',
  'UNIFIED_STORE_CHANNEL_PG_PRIMARY',
  'UNIFIED_STORE_DUAL_WRITE',
  'UNIFIED_STORE_PG_URL',
  'ROOSYNC_SCAN_LOCK_DIR',
] as const;

let previousEnv: Record<string, string | undefined>;

function setPgPrimaryEnv(): void {
  process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
  process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY = '1';
  process.env.UNIFIED_STORE_DUAL_WRITE = '1';
  process.env.UNIFIED_STORE_PG_URL = 'postgres://unit-test.invalid:5432/rsm';
}

function inboxFsCalls(spies: {
  readdir: { mock: { calls: unknown[][] } };
  readFile: { mock: { calls: unknown[][] } };
}): number {
  const inboxPath = join(mocks.sharedPath, 'messages', 'inbox');
  const touches = (calls: unknown[][]) =>
    calls.filter((args) => String(args[0] ?? '').includes(inboxPath)).length;
  return touches(spies.readdir.mock.calls) + touches(spies.readFile.mock.calls);
}

function writeInboxFile(id: string, overrides: Record<string, unknown> = {}): void {
  const message = {
    id,
    from: 'myia-ai-01:roo-extensions',
    to: MACHINE,
    subject: `B18 fixture ${id}`,
    body: 'body',
    priority: 'MEDIUM',
    status: 'unread',
    timestamp: new Date().toISOString(),
    tags: [],
    ...overrides,
  };
  writeFileSync(join(mocks.sharedPath, 'messages', 'inbox', `${id}.json`), JSON.stringify(message, null, 2), 'utf-8');
}

function pgListItem(id: string) {
  return {
    id,
    from: 'myia-ai-01:roo-extensions',
    to: MACHINE,
    subject: `B18 PG ${id}`,
    priority: 'MEDIUM',
    status: 'unread',
    timestamp: new Date().toISOString(),
    tags: [],
    preview: 'body',
  };
}

/**
 * `ensureInboxCache` is private: the rebuild path is reached through this cast,
 * exactly as the B16 sibling test does. It is the cold-cache entry point.
 */
type CacheHarness = {
  ensureInboxCache: () => Promise<{ items: Array<{ id: string }> }>;
};
function ensureCache(manager: MessageManager): Promise<{ items: Array<{ id: string }> }> {
  return (manager as unknown as CacheHarness).ensureInboxCache();
}


/**
 * Record the delays requested through the global `setTimeout`. The rebuild
 * pause is the only timer on this path, so this measures the pacing itself
 * instead of a wall-clock bound (which the machine's own I/O noise would make
 * flaky) — a pass that paid no pause is a pass with no timer.
 */
function recordTimerDelays(): number[] {
  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((cb: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    delays.push(Number(ms ?? 0));
    return realSetTimeout(cb as never, ms, ...(rest as never[]));
  }) as never);
  return delays;
}

describe('B18 — PG-first cold inbox + bounded rebuild (#4131)', () => {
  let manager: MessageManager;

  beforeEach(() => {
    mocks.pgActive = true;
    mocks.inboxItems = [];
    mocks.counts = { total: 0, unread: 0, read: 0 };
    mocks.sharedPath = mkdtempSync(join(tmpdir(), 'rsm-b18-'));
    for (const dir of ['inbox', 'sent', 'archive']) {
      mkdirSync(join(mocks.sharedPath, 'messages', dir), { recursive: true });
    }

    previousEnv = {};
    for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
    process.env.ROOSYNC_MACHINE_ID = MACHINE;
    process.env.ROOSYNC_WORKSPACE_ID = WORKSPACE;
    delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
    delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
    delete process.env.UNIFIED_STORE_DUAL_WRITE;
    delete process.env.UNIFIED_STORE_PG_URL;
    // The scan lock is HOST-LOCAL (os.tmpdir): without this it is shared with
    // the live RSM processes on this machine, and a contended lock (up to
    // ~0.5 s of bounded retries) would be measured as if it were our pause.
    process.env.ROOSYNC_SCAN_LOCK_DIR = join(mocks.sharedPath, '.scanlock');
    resetChannelPgBreakerForTests();

    manager = new MessageManager(mocks.sharedPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetChannelPgBreakerForTests();
    for (const key of ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(mocks.sharedPath, { recursive: true, force: true });
  });

  // ── (a) PG first, cold cache, zero G: ────────────────────────────────────

  test('(a) cold cache + healthy PG → inbox served from PG, ZERO G: touches', async () => {
    // Two messages really are on G: — the control below proves this fixture is
    // served over G: when PG is not in play, so a zero is a decision.
    writeInboxFile('msg-20261027T010000-b18a');
    writeInboxFile('msg-20261027T010000-b18b');
    setPgPrimaryEnv();
    mocks.inboxItems = [pgListItem('msg-20261027T010000-pg1'), pgListItem('msg-20261027T010000-pg2')];

    const readdirSpy = vi.spyOn(fsp, 'readdir');
    const readFileSpy = vi.spyOn(fsp, 'readFile');

    const items = await manager.readInbox(MACHINE, 'all', undefined, WORKSPACE);

    expect(items.map((i) => i.id)).toEqual([
      'msg-20261027T010000-pg1',
      'msg-20261027T010000-pg2',
    ]);
    expect(inboxFsCalls({ readdir: readdirSpy as never, readFile: readFileSpy as never })).toBe(0);
    // The cache was never built at all — the cold path did not even start one.
    expect(manager.isInboxCachePartial()).toBe(false);

    // Control: same fixture, PG absent → the G: pool IS served.
    mocks.pgActive = false;
    const other = new MessageManager(mocks.sharedPath);
    const overGdrive = await other.readInbox(MACHINE, 'all', undefined, WORKSPACE);
    expect(overGdrive.map((i) => i.id).sort()).toEqual([
      'msg-20261027T010000-b18a',
      'msg-20261027T010000-b18b',
    ]);
    expect(inboxFsCalls({ readdir: readdirSpy as never, readFile: readFileSpy as never })).toBeGreaterThan(0);
  });

  test('(a) cold cache + `deep: true` + getFilteredCount → still zero G: touches', async () => {
    writeInboxFile('msg-20261027T010000-b18a');
    setPgPrimaryEnv();
    mocks.inboxItems = [pgListItem('msg-20261027T010000-pg1')];
    mocks.counts = { total: 1, unread: 1, read: 0 };

    const readdirSpy = vi.spyOn(fsp, 'readdir');
    const readFileSpy = vi.spyOn(fsp, 'readFile');

    const items = await manager.readInbox(MACHINE, 'all', undefined, WORKSPACE, undefined, undefined, true);
    const counts = await manager.getFilteredCount(MACHINE, 'all', WORKSPACE);

    expect(items.map((i) => i.id)).toEqual(['msg-20261027T010000-pg1']);
    expect(counts.total).toBe(1);
    expect(inboxFsCalls({ readdir: readdirSpy as never, readFile: readFileSpy as never })).toBe(0);
  });

  // ── (b) bounded rebuild ──────────────────────────────────────────────────

  test('(b) failing share → batch shrink + budget honoured, the pool is NOT walked', async () => {
    for (let i = 0; i < 40; i++) {
      writeInboxFile(`msg-20261027T010000-b18-${String(i).padStart(2, '0')}`);
    }
    // No PG at all: this is the G: rebuild path, the one that stormed.
    mocks.pgActive = false;

    const readdirSpy = vi.spyOn(fsp, 'readdir');
    const readFileSpy = vi.spyOn(fsp, 'readFile').mockRejectedValue(new Error('EIO (share refusing reads)'));

    // 15 ms budget, 20 ms base pause: after the very first chunk there is no
    // time left for another one — so the pass must stop there.
    const bounded = new MessageManager(mocks.sharedPath, 10_000, 60_000, 15, 60_000, 20);

    const { items } = await ensureCache(bounded);

    const readCalls = inboxFsCalls({ readdir: readdirSpy as never, readFile: readFileSpy as never });
    expect(items).toEqual([]);
    // Bounded well below the 40-file pool (one chunk at most), never zero-scan.
    expect(readCalls).toBeGreaterThan(0);
    // At most ONE chunk: 1 readdir + `concurrency` readFile calls, never 40.
    expect(readCalls).toBeLessThanOrEqual(deriveReadConcurrency() + 1);
    expect(bounded.isInboxCachePartial()).toBe(true);
  });

  test('(b) a failing chunk paces the next one, and success resumes full width', async () => {
    for (let i = 0; i < 12; i++) {
      writeInboxFile(`msg-20261027T010000-b18p-${String(i).padStart(2, '0')}`);
    }
    mocks.pgActive = false;

    // Bind the real reader BEFORE spying, or the mock would call itself.
    const realRead = fsp.readFile.bind(fsp);
    let calls = 0;
    const readFileSpy = vi.spyOn(fsp, 'readFile').mockImplementation((async (...args: unknown[]) => {
      calls++;
      if (calls <= deriveReadConcurrency()) throw new Error('EIO (first chunk refused)');
      return realRead(...(args as Parameters<typeof realRead>));
    }) as never);

    // Generous budget: only the pacing can slow this pass down.
    const paced = new MessageManager(mocks.sharedPath, 10_000, 60_000, 5_000, 60_000, 40);
    const delays = recordTimerDelays();

    const { items } = await ensureCache(paced);

    // The refused chunk is exactly the first `concurrency` files.
    expect(items).toHaveLength(12 - deriveReadConcurrency());
    expect(paced.isInboxCachePartial()).toBe(false);
    expect(inboxFsCalls({ readdir: vi.spyOn(fsp, 'readdir') as never, readFile: readFileSpy as never })).toBe(12);
    // The failed chunk was followed by a pause — at least the configured base,
    // not an immediate next chunk.
    // (< 1000 ms excludes the per-read `withReadTimeout` backstop, which is
    // not a pacing timer.)
    expect(delays.filter((d) => d >= 40 && d < 1_000)).not.toEqual([]);
  });

  test('(b) a healthy share pays no pause and keeps the full width', async () => {
    for (let i = 0; i < 12; i++) {
      writeInboxFile(`msg-20261027T010000-b18h-${String(i).padStart(2, '0')}`);
    }
    mocks.pgActive = false;

    const healthy = new MessageManager(mocks.sharedPath, 10_000, 60_000, 5_000, 60_000, 40);
    const delays = recordTimerDelays();

    const { items } = await ensureCache(healthy);

    expect(items).toHaveLength(12);
    expect(healthy.isInboxCachePartial()).toBe(false);
    // No inter-chunk pause at all: a healthy share never arms the backoff.
    expect(delays.filter((d) => d > 0 && d < 1_000)).toEqual([]);
  });

});
