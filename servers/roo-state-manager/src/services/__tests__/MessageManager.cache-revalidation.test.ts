/**
 * The inbox cache count heuristic must not renew itself indefinitely.
 *
 * `ensureInboxCache` has two fast paths. The first returns while within
 * CACHE_TTL_MS. The second, past the TTL, compares the inbox FILE COUNT with
 * the one seen at the last build and — if unchanged — returns the warm cache
 * AND sets `cacheBuiltAt = now`.
 *
 * That second assignment is the defect. The count detects files ADDED or
 * REMOVED; it is blind to an IN-PLACE mutation, which is exactly what
 * `markAsRead` does (same path, same size, same count). So a process whose
 * pool is quiet renewed forever the TTL of a cache no one had re-read: it kept
 * reporting "unread" a message another process had already handled, for as long
 * as no message happened to arrive or be archived. Staleness was bounded by the
 * next count change — that is, by nothing.
 *
 * A count-shaped check standing where content changes had to be caught: the
 * guard verified a NEIGHBOURING property of the one that mattered.
 *
 * The fix bounds it with `contentBuiltAt`, which only a real disk read sets.
 * Past CONTENT_REVALIDATE_MS the call falls through to the stale-while-
 * revalidate path (#3205): the warm cache is still served immediately, the
 * re-read happens in the background, and no caller waits for it.
 *
 * These tests hold BOTH ends: staleness becomes bounded, and the count
 * optimisation is still there within the bound. Deleting the heuristic
 * outright would also "fix" the staleness — and would reintroduce the full-pool
 * read on every expired TTL that #3205 and #3292 exist to avoid.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { MessageManager } from '../MessageManager.js';

const MACHINE = 'myia-ai-01';
const WS = 'roo-extensions';
const READER = MACHINE + ':' + WS;

const TTL_MS = 300_000;
const BOUND_MS = 900_000;

function makeTempSharedState(): string {
  const dir = join(tmpdir(), 'mm-reval-' + randomUUID());
  for (const sub of ['messages', 'messages/inbox', 'messages/sent', 'messages/archive']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return dir;
}

function seed(sharedState: string, id: string): void {
  writeFileSync(
    join(sharedState, 'messages', 'inbox', id + '.json'),
    JSON.stringify({
      id,
      from: 'myia-po-2023:roo-extensions',
      to: READER,
      subject: 'subject-' + id,
      body: 'body-' + id,
      priority: 'MEDIUM',
      timestamp: new Date('2026-09-01T10:00:00.000Z').toISOString(),
      status: 'unread',
    }),
    'utf-8'
  );
}

/** A fresh manager models a separate process: own cache, same store. */
function process_(sharedState: string): MessageManager {
  return new MessageManager(sharedState, 5000);
}

async function unreadIds(m: MessageManager): Promise<string[]> {
  return (await m.readInbox(MACHINE, 'unread', undefined, WS)).map(x => x.id);
}

/** Await the background revalidation if one was scheduled. */
async function settle(m: MessageManager): Promise<boolean> {
  const inFlight = (m as any).inboxRebuildInFlight;
  if (!inFlight) return false;
  await inFlight.catch(() => {});
  return true;
}

describe('MessageManager — the count fast-path bounds its own staleness', () => {
  let shared: string;
  let clock: number;

  beforeEach(() => {
    shared = makeTempSharedState();
    clock = Date.parse('2026-09-01T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(shared, { recursive: true, force: true });
  });

  test('an in-place mutation by another process is picked up within the bound', async () => {
    seed(shared, 'msg-20260901T100000-revaaa');
    seed(shared, 'msg-20260901T100001-revbbb');

    const reader = process_(shared);
    expect(await unreadIds(reader)).toHaveLength(2);

    // Another process marks one read: same file, same count.
    await process_(shared).markAsRead('msg-20260901T100000-revaaa', READER);

    // Past the bound the call falls through to stale-while-revalidate: it still
    // hands back the warm (stale) cache, and schedules the re-read.
    clock += BOUND_MS + 1_000;
    await reader.readInbox(MACHINE, 'unread', undefined, WS);
    expect(await settle(reader)).toBe(true);

    // Before the fix no rebuild was ever scheduled and this stayed at 2 forever.
    expect(await unreadIds(reader)).toEqual(['msg-20260901T100001-revbbb']);
  });

  test('within the bound the count heuristic still skips the disk read', async () => {
    seed(shared, 'msg-20260901T100002-revccc');

    const reader = process_(shared);
    await unreadIds(reader);

    await process_(shared).markAsRead('msg-20260901T100002-revccc', READER);

    // TTL expired, bound not reached: the whole point of the heuristic.
    clock += TTL_MS + 1_000;
    await reader.readInbox(MACHINE, 'unread', undefined, WS);

    expect((reader as any).inboxRebuildInFlight).toBeNull();
    expect(await unreadIds(reader)).toEqual(['msg-20260901T100002-revccc']);
  });

  test('the fast path renews the TTL but never the content timestamp', async () => {
    seed(shared, 'msg-20260901T100003-revddd');

    const reader = process_(shared);
    await unreadIds(reader);
    const builtAt = (reader as any).contentBuiltAt;

    clock += TTL_MS + 1_000;
    await reader.readInbox(MACHINE, 'unread', undefined, WS);

    // Renewing this one is what the count check is for...
    expect((reader as any).cacheBuiltAt).toBe(clock);
    // ...renewing this one is what made staleness unbounded.
    expect((reader as any).contentBuiltAt).toBe(builtAt);
  });

  test('a quiet pool cannot defer revalidation indefinitely', async () => {
    seed(shared, 'msg-20260901T100004-reveee');

    const reader = process_(shared);
    await unreadIds(reader);

    // Ten TTL windows, not one file added or removed: exactly the situation in
    // which the old code renewed forever.
    let revalidations = 0;
    for (let i = 0; i < 10; i++) {
      clock += TTL_MS + 1_000;
      await reader.readInbox(MACHINE, 'unread', undefined, WS);
      if (await settle(reader)) revalidations++;
    }

    expect(revalidations).toBeGreaterThan(0);
    // ...and not once per call either: the heuristic must still be doing work.
    expect(revalidations).toBeLessThan(10);
  });
});
