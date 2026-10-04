/**
 * Inbox cache: a truncated pass over a PARTIAL cache must merge, not be discarded
 * (#3292 follow-up, refining the #3205 guard).
 *
 * The defect these cover: `rebuildInboxCache` discarded any truncated pass when a
 * cache existed, on the premise that the cache was COMPLETE and the pass therefore
 * a strict subset of it. #3292 broke that premise — the cache can be the 100-file
 * cold-start SLICE, flagged partial. Discarding the pass then throws away every
 * file it read while the slice stays in place, so each attempt restarts from zero;
 * on a pool slow enough to truncate every pass, the slice is terminal and
 * `deep: true` — an explicit request for the full pool — keeps returning the slice.
 *
 * Determinism: truncation is driven by an explicit budget plus a clock the test
 * advances ONE TICK PER INBOX READ, so a pass reads exactly as many files as the
 * budget allows and "how far did the pass get?" is arithmetic, not timing. The
 * pool is 105 files with 50-file chunks, so budget 50 = one chunk, budget 100 = two.
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

/**
 * Generous on purpose: the truncation under test is the BUDGET's, driven by the
 * virtual clock. A tight read timeout would reject real reads under load and
 * quietly shrink the pool the assertions count, turning a logic check into a
 * timing check.
 */
const READ_TIMEOUT_MS = 10_000;
const RECIPIENT = 'myia-po-2025';
const POOL_SIZE = 105; // 50 + 50 + 5 chunks
const READ_CONCURRENCY = 50;

/**
 * REAL generated shape (`msg-YYYYMMDDTHHMMSS-…`, the `T` survives
 * `toISOString()`). Since the recency follow-up, ordering recognises ONLY this
 * shape (`compareByEmbeddedRecencyDesc`); an index-padded fake matches nothing
 * and silently turns the ordering assertions into readdir-order assertions.
 */
function idAt(index: number): string {
  const hhmmss = `00${String(Math.floor(index / 60)).padStart(2, '0')}${String(index % 60).padStart(2, '0')}`;
  return `msg-20260801T${hhmmss}-${String(index).padStart(6, '0')}`;
}

function makeTempSharedState(): string {
  const dir = join(tmpdir(), `mm-3292-${randomUUID()}`);
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
    // Ascending with the index, so recency and id order agree.
    timestamp: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
    status: 'read',
  };
  writeFileSync(join(sharedState, 'messages', 'inbox', `${id}.json`), JSON.stringify(msg), 'utf-8');
}

describe('MessageManager — truncated pass over a PARTIAL cache (#3292 follow-up)', () => {
  let sharedState: string;
  let fakeNow: number;

  /**
   * Arm the clock: every inbox read costs 1 ms of virtual time, so a pass whose
   * budget is B reads exactly floor(B / chunk) chunks before the deadline check
   * on the next chunk truncates it.
   */
  function armClock(): void {
    fakeNow = 1_000_000_000;
    mocks.readFile.mockImplementation(async (filePath: string, _enc: string) => {
      if (String(filePath).replace(/\\/g, '/').includes('/inbox/')) {
        fakeNow += 1;
      }
      return realReadFile(filePath, 'utf-8');
    });
  }

  /** One `deep: true` pass — the caller explicitly asking for the whole pool. */
  async function deepPass(manager: MessageManager, budgetMs: number) {
    (manager as any).rebuildBudgetMs = budgetMs;
    (manager as any).cacheBuiltAt = 0;
    (manager as any).contentBuiltAt = 0;
    const items = await manager.readInbox(
      RECIPIENT, 'all', undefined, undefined, undefined, undefined, true,
    );
    // Background/settled work must not leak into the next assertion.
    await (manager as any).inboxRebuildInFlight;
    return items;
  }

  beforeEach(() => {
    sharedState = makeTempSharedState();
    mocks.warn.mockClear();
    mocks.error.mockClear();
    mocks.readFile.mockClear();
    mocks.readFile.mockImplementation(realReadFile as never);
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    armClock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(sharedState, { recursive: true, force: true });
  });

  test('a truncated pass over a partial cache MERGES its reads instead of losing them', async () => {
    for (let i = 1; i <= POOL_SIZE; i++) seedInboxMessage(sharedState, i);
    const manager = new MessageManager(sharedState, READ_TIMEOUT_MS);

    // Pass 1 — budget of one chunk: installs the 50 newest, flagged partial.
    const first = await deepPass(manager, READ_CONCURRENCY);
    expect(first).toHaveLength(READ_CONCURRENCY);
    expect(manager.isInboxCachePartial()).toBe(true);

    // Pass 2 — budget of two chunks: reads 100 files, still truncates.
    const second = await deepPass(manager, READ_CONCURRENCY * 2);

    // The discriminant. Before the fix the pass was discarded as a "subset" of a
    // cache that is in fact the slice, so the listing stayed at 50 forever and the
    // files the second pass read were thrown away.
    expect(second).toHaveLength(READ_CONCURRENCY * 2);
    expect((manager as any).inboxCache).toHaveLength(READ_CONCURRENCY * 2);

    // Progress is not exhaustiveness: the merge must keep saying so.
    expect(manager.isInboxCachePartial()).toBe(true);
    expect((manager as any).lastInboxFileCount).toBe(-1);
  }, 10_000);

  test('the merged listing is the union by id, newest first, with no duplicates', async () => {
    for (let i = 1; i <= POOL_SIZE; i++) seedInboxMessage(sharedState, i);
    const manager = new MessageManager(sharedState, READ_TIMEOUT_MS);

    await deepPass(manager, READ_CONCURRENCY);
    const merged = await deepPass(manager, READ_CONCURRENCY * 2);
    const ids = merged.map(m => m.id);

    expect(new Set(ids).size).toBe(ids.length); // union, not concatenation
    expect(ids).toHaveLength(READ_CONCURRENCY * 2);
    expect(ids).toContain(idAt(POOL_SIZE)); // the newest survived both passes

    const times = merged.map(m => new Date(m.timestamp).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  }, 10_000);

  test('a truncated pass sacrifices the OLDEST files, not an arbitrary subset', async () => {
    for (let i = 1; i <= POOL_SIZE; i++) seedInboxMessage(sharedState, i);
    const manager = new MessageManager(sharedState, READ_TIMEOUT_MS);

    const items = await deepPass(manager, READ_CONCURRENCY);
    const ids = items.map(m => m.id);

    // The pass is budget-bounded; its READ ORDER decides what survives it. Read
    // order is the recency sort, so a one-chunk pass keeps the newest 50 — the
    // files a caller is most likely to act on — and drops the oldest.
    expect(ids).toContain(idAt(POOL_SIZE));
    expect(ids).not.toContain(idAt(1));
    for (let i = POOL_SIZE - READ_CONCURRENCY + 1; i <= POOL_SIZE; i++) {
      expect(ids).toContain(idAt(i));
    }
  }, 10_000);

  test('a truncated pass still never replaces a COMPLETE cache (the #3205 guard holds)', async () => {
    // The merge above is conditional on the cache being PARTIAL. If it were
    // unconditional, this pass would flip a complete cache's flag to partial —
    // asserting the flag is what discriminates, since the merged COUNT would be
    // identical (the truncated pass reads nothing here).
    for (const i of [1, 2, 3]) seedInboxMessage(sharedState, i);
    const manager = new MessageManager(sharedState, READ_TIMEOUT_MS);

    const complete = await deepPass(manager, 10_000);
    expect(complete).toHaveLength(3);
    expect(manager.isInboxCachePartial()).toBe(false);

    seedInboxMessage(sharedState, 4);
    await deepPass(manager, 0); // truncates before reading anything

    expect((manager as any).inboxCache).toHaveLength(3);
    expect(manager.isInboxCachePartial()).toBe(false);
    expect((manager as any).lastInboxFileCount).toBe(-1);
    expect(mocks.warn.mock.calls.some(([msg]) => String(msg).includes('budget'))).toBe(true);
  }, 10_000);
});
