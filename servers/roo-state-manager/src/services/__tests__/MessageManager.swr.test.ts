/**
 * Inbox cache: stale-while-revalidate, in-flight dedup, rebuild budget (#3205).
 *
 * The defect these cover: `ensureInboxCache` awaited the full per-file read pass
 * on TTL expiry. Whichever caller happened to arrive on an expired TTL paid the
 * whole rebuild — 3 160 inbox files / 50 concurrency = 64 chunks, and
 * `Promise.allSettled` waits for the slowest file of each chunk, so one
 * cloud-only file per chunk costs 64 x 10s. That caller hit its tool timeout
 * while the retry right behind it landed on the fast path in ~30ms, producing
 * the "times out, then instantly fine" signature reported fleet-wide.
 *
 * Determinism: a real local fs rebuilds in microseconds, so "did the caller wait
 * for the rebuild?" would be untestable by timing. Instead `fs.promises.readFile`
 * is gated on a promise the test resolves by hand — if the caller awaited the
 * rebuild it would hang on the gate and the test would time out rather than pass
 * for the wrong reason.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  readFile: vi.fn(),
}));

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
  mocks.readFile.mockImplementation(actual.promises.readFile as never);
  return {
    ...actual,
    promises: { ...actual.promises, readFile: mocks.readFile },
  };
});

import { MessageManager } from '../MessageManager.js';

const realFs = await vi.importActual<typeof import('fs')>('fs');
const realReadFile = realFs.promises.readFile as (p: string, enc: string) => Promise<string>;

const TEST_TIMEOUT_MS = 50;
const RECIPIENT = 'myia-po-2025';

function makeTempSharedState(): string {
  const dir = join(tmpdir(), `mm-swr-${randomUUID()}`);
  for (const sub of ['messages', 'messages/inbox', 'messages/sent', 'messages/archive']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return dir;
}

function seedInboxMessage(sharedState: string, id: string): void {
  const msg = {
    id,
    from: 'myia-po-2023',
    to: RECIPIENT,
    subject: `subject-${id}`,
    body: `body-${id}`,
    priority: 'MEDIUM',
    timestamp: new Date('2026-08-23T10:00:00.000Z').toISOString(),
    status: 'read',
  };
  writeFileSync(join(sharedState, 'messages', 'inbox', `${id}.json`), JSON.stringify(msg), 'utf-8');
}

/** Gate `readFile` for one id; resolve the returned callback to let it through. */
function gateReadsFor(id: string): () => void {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  mocks.readFile.mockImplementation(async (filePath: string, _enc: string) => {
    if (filePath.includes(id)) {
      await gate;
    }
    return realReadFile(filePath, 'utf-8');
  });
  return release;
}

describe('MessageManager — inbox cache stale-while-revalidate (#3205)', () => {
  let sharedState: string;

  beforeEach(() => {
    sharedState = makeTempSharedState();
    mocks.warn.mockClear();
    mocks.error.mockClear();
    mocks.readFile.mockClear();
    mocks.readFile.mockImplementation(realReadFile as never);
  });

  afterEach(() => {
    rmSync(sharedState, { recursive: true, force: true });
  });

  test('serves the warm cache immediately instead of awaiting the rebuild', async () => {
    const firstId = 'msg-swr-first-aaaaaa';
    const slowId = 'msg-swr-slow-bbbbbb';
    seedInboxMessage(sharedState, firstId);

    const manager = new MessageManager(sharedState, TEST_TIMEOUT_MS);
    const warm = await manager.readInbox(RECIPIENT, 'all');
    expect(warm.map(m => m.id)).toEqual([firstId]);

    // A second file appears (count changes → the read phase is genuinely required)
    // and its read is gated, so a caller that awaited the rebuild could not return.
    const release = gateReadsFor(slowId);
    seedInboxMessage(sharedState, slowId);
    (manager as any).cacheBuiltAt = 0;

    const stale = await manager.readInbox(RECIPIENT, 'all');
    expect(stale.map(m => m.id)).toEqual([firstId]);

    // The refresh is running in the background, not abandoned.
    expect((manager as any).inboxRebuildInFlight).not.toBeNull();

    release();
    await (manager as any).inboxRebuildInFlight;

    const fresh = await manager.readInbox(RECIPIENT, 'all');
    expect(fresh.map(m => m.id).sort()).toEqual([firstId, slowId].sort());
  }, 10_000);

  test('a cold cache is still awaited — there is nothing else to serve', async () => {
    const onlyId = 'msg-swr-cold-cccccc';
    seedInboxMessage(sharedState, onlyId);

    const manager = new MessageManager(sharedState, TEST_TIMEOUT_MS);
    const first = await manager.readInbox(RECIPIENT, 'all');

    // No stale copy existed, so the very first call must return real content.
    expect(first.map(m => m.id)).toEqual([onlyId]);
  }, 10_000);

  test('concurrent callers share ONE rebuild pass rather than each running their own', async () => {
    const gatedId = 'msg-swr-dedup-dddddd';
    const otherId = 'msg-swr-dedup-eeeeee';
    seedInboxMessage(sharedState, gatedId);
    seedInboxMessage(sharedState, otherId);

    const release = gateReadsFor(gatedId);
    const manager = new MessageManager(sharedState, TEST_TIMEOUT_MS);

    // Cold cache: all three await. Without dedup each would launch its own pass
    // and read the same files three times over.
    const calls = [
      manager.readInbox(RECIPIENT, 'all'),
      manager.readInbox(RECIPIENT, 'all'),
      manager.readInbox(RECIPIENT, 'all'),
    ];
    release();
    const results = await Promise.all(calls);

    for (const r of results) {
      expect(r.map(m => m.id).sort()).toEqual([gatedId, otherId].sort());
    }

    const gatedReads = mocks.readFile.mock.calls.filter(
      ([filePath]) => typeof filePath === 'string' && filePath.includes(gatedId),
    );
    expect(gatedReads).toHaveLength(1);
  }, 10_000);

  test('a pass truncated by the budget never replaces a more complete cache', async () => {
    const ids = ['msg-swr-bud-ffffff', 'msg-swr-bud-gggggg', 'msg-swr-bud-hhhhhh'];
    for (const id of ids) seedInboxMessage(sharedState, id);

    const manager = new MessageManager(sharedState, TEST_TIMEOUT_MS);
    const complete = await manager.readInbox(RECIPIENT, 'all');
    expect(complete).toHaveLength(3);

    // Budget of 0 makes the next pass truncate before reading anything. Set after
    // the complete build so the cache under test is genuinely the complete one.
    (manager as any).rebuildBudgetMs = 0;
    seedInboxMessage(sharedState, 'msg-swr-bud-iiiiii');
    (manager as any).cacheBuiltAt = 0;

    await manager.readInbox(RECIPIENT, 'all');
    await (manager as any).inboxRebuildInFlight;

    // The truncated (empty) pass must be discarded, not installed.
    expect((manager as any).inboxCache).toHaveLength(3);
    // -1 defeats the count check so the next call retries rather than settling
    // on a cache it knows is stale.
    expect((manager as any).lastInboxFileCount).toBe(-1);
    expect(mocks.warn.mock.calls.some(([msg]) => String(msg).includes('budget'))).toBe(true);
  }, 10_000);

  test('a failing background refresh is caught and never becomes an unhandled rejection', async () => {
    const id = 'msg-swr-reject-jjjjjj';
    seedInboxMessage(sharedState, id);

    const manager = new MessageManager(sharedState, TEST_TIMEOUT_MS);
    await manager.readInbox(RECIPIENT, 'all');

    // Make the rebuild itself throw (not an individual file read, which allSettled
    // would absorb): readdir is the one unguarded await in the pass.
    const boom = new Error('Simulated readdir failure');
    const spy = vi
      .spyOn(manager as any, 'rebuildInboxCache')
      .mockRejectedValue(boom);

    seedInboxMessage(sharedState, 'msg-swr-reject-kkkkkk');
    (manager as any).cacheBuiltAt = 0;

    const stale = await manager.readInbox(RECIPIENT, 'all');
    expect(stale.map(m => m.id)).toEqual([id]);

    // Settle the derived chain; an unhandled rejection here would fail the run.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mocks.error).toHaveBeenCalledWith('Inbox cache rebuild failed', boom);
    expect((manager as any).inboxRebuildInFlight).toBeNull();

    spy.mockRestore();
  }, 10_000);
});
