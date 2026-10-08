/**
 * Timeout/skip behavior for MessageManager inbox cache build (#818 class, #2267).
 *
 * The wedge: `ensureInboxCache` reads inbox files in parallel chunks via
 * `Promise.allSettled`. allSettled waits for EVERY file in the chunk — so a
 * single GDrive "cloud-only" message file that hangs `fs.readFile` blocks the
 * whole chunk until the 120s MCP tool timeout, wedging inbox listing AND the 3
 * cleanup ops (autoArchiveOld/cleanupExpiredMessages/sendExpiryReminders) that
 * all transit `ensureInboxCache`. The fix bounds each read in `withReadTimeout`;
 * on timeout the read throws → allSettled rejected-handler logs + skips the
 * file, so the inbox returns a partial result.
 *
 * Real local fs can't reproduce cloud-only hangs, so we mock `fs.promises.readFile`
 * to never-resolve for the "hung" file. The timeout is injected via the
 * constructor (50ms here) so the test runs in real time without fake timers
 * (cf. AttachmentManager.timeout.test.ts #818).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID, createHash } from 'crypto';

// vi.hoisted: stable refs usable inside vi.mock factories.
const mocks = vi.hoisted(() => ({
  error: vi.fn(),
  readFile: vi.fn(),
  // Write override holder. NOT a vi.fn: vitest.config.ts sets
  // mockReset+restoreMocks, which wipe every implementation before each test —
  // an implementation installed by a mock factory would vanish and turn the
  // seeding writes into silent no-ops (whole inbox reads empty).
  writeFileOverride: { current: null as null | ((p: string, data: unknown, enc?: string) => void) },
}));

// Logger mock: capture error calls to assert the skip is logged.
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.error,
    debug: vi.fn(),
  }),
}));

// fs mock: default readFile passes through to real; per-test overrides hang it.
// writeFileSync is a plain passthrough (seeding keeps working) that merely
// consults mocks.writeFileOverride: the atomic-persist test makes any write to
// the FINAL path hostile to prove the tmp+rename publish never exposes a
// partial file. It is deliberately NOT a vi.fn — see the holder's comment.
// existsSync/mkdirSync/rmSync stay real (module-level re-exports below use the
// original so seeding/cleanup touch the real fs).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  mocks.readFile.mockImplementation(actual.promises.readFile as never);
  const passthroughWrite = ((p: string, data: unknown, enc?: string) =>
    mocks.writeFileOverride.current
      ? mocks.writeFileOverride.current(p, data, enc)
      : actual.writeFileSync(p as never, data as never, enc as never)) as unknown as typeof actual.writeFileSync;
  return {
    ...actual,
    writeFileSync: passthroughWrite,
    promises: {
      ...actual.promises,
      readFile: mocks.readFile,
    },
  };
});

// Imported AFTER mocks are registered.
import { MessageManager } from '../MessageManager.js';

// Real fs captured at module load (before any mock override) for passthrough.
const realFs = await vi.importActual<typeof import('fs')>('fs');
const realReadFile = realFs.promises.readFile as (p: string, enc: string) => Promise<string>;
const realWriteFile = realFs.writeFileSync as unknown as (p: string, data: string, enc: string) => void;

/** Tiny timeout for tests (real timers). Production default is 10s. */
const TEST_TIMEOUT_MS = 50;

function makeTempSharedState(): string {
  const dir = join(tmpdir(), `mm-timeout-${randomUUID()}`);
  for (const sub of ['messages', 'messages/inbox', 'messages/sent', 'messages/archive']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return dir;
}

/** Seed an inbox file whose name matches its internal id (phantom-guard compatible). */
function seedInboxMessage(sharedState: string, id: string, from: string, to: string): void {
  const msg = {
    id,
    from,
    to,
    subject: `subject-${id}`,
    body: `body-${id}`,
    priority: 'MEDIUM',
    timestamp: new Date('2026-07-04T10:00:00.000Z').toISOString(),
    status: 'read',
  };
  writeFileSync(join(sharedState, 'messages', 'inbox', `${id}.json`), JSON.stringify(msg), 'utf-8');
}

describe('MessageManager — cloud-only inbox read timeout (#818 class, #2267)', () => {
  let sharedState: string;

  beforeEach(() => {
    sharedState = makeTempSharedState();
    mocks.error.mockClear();
    mocks.readFile.mockClear();
    mocks.readFile.mockImplementation(realReadFile as never);
  });

  afterEach(() => {
    rmSync(sharedState, { recursive: true, force: true });
  });

  test('readInbox skips a cloud-only (hung) inbox file and returns the rest', async () => {
    const goodId = 'msg-good-aaaaaaaaaa';
    const hungId = 'msg-hung-bbbbbbbbbb';
    seedInboxMessage(sharedState, goodId, 'myia-po-2023', 'myia-po-2025');
    seedInboxMessage(sharedState, hungId, 'myia-po-2024', 'myia-po-2025');

    const manager = new MessageManager(sharedState, TEST_TIMEOUT_MS);

    // Hang reads targeting the hung file's path; others pass through.
    mocks.readFile.mockImplementation(async (filePath: string, _enc: string) => {
      if (filePath.includes(hungId)) {
        return new Promise<string>(() => {}); // never resolves (cloud-only hang)
      }
      return realReadFile(filePath, 'utf-8');
    });

    const result = await manager.readInbox('myia-po-2025', 'all');

    // Hung file skipped, good file returned.
    const ids = result.map(m => m.id);
    expect(ids).toContain(goodId);
    expect(ids).not.toContain(hungId);

    // The skip surfaced via the existing allSettled rejected-handler error log.
    expect(mocks.error).toHaveBeenCalled();
  }, 10_000);

  test('#4131 lot 2: the read carries an AbortSignal — aborting it CANCELS the read, not just races it', async () => {
    const goodId = 'msg-good-eeeeeeeeee';
    const slowId = 'msg-slow-ffffffffff';
    seedInboxMessage(sharedState, goodId, 'myia-po-2023', 'myia-po-2025');
    seedInboxMessage(sharedState, slowId, 'myia-po-2024', 'myia-po-2025');

    const manager = new MessageManager(sharedState, TEST_TIMEOUT_MS);

    // A read that OBSERVES the signal, the way fs does: reject with AbortError
    // the moment it is aborted. The race backstop sits at timeout+250ms, so a
    // passing assertion on the AbortError path below can only come from the
    // signal — this is what distinguishes cancellation from the old behavior
    // (result discarded, underlying read left running).
    let captured: AbortSignal | undefined;
    mocks.readFile.mockImplementation(async (filePath: string, opts?: unknown) => {
      if (String(filePath).includes(slowId)) {
        captured = (opts as { signal?: AbortSignal } | undefined)?.signal;
        return new Promise<string>((_resolve, reject) => {
          captured?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      return realReadFile(filePath, 'utf-8');
    });

    const result = await manager.readInbox('myia-po-2025', 'all');

    // The signal reached fs.readFile — the read is cancellable…
    expect(captured).toBeDefined();
    // …it was aborted (the read's own deadline), the file is skipped…
    expect(captured!.aborted).toBe(true);
    const ids = result.map(m => m.id);
    expect(ids).toContain(goodId);
    expect(ids).not.toContain(slowId);
    // …and the skip was settled by the CANCELLATION, not by the race: the
    // logged reason is the read's AbortError, and the race's "timed out" error
    // never appears.
    const reasons = mocks.error.mock.calls.map(c => c[1] as { name?: string; message?: string });
    expect(reasons.some(r => r?.name === 'AbortError')).toBe(true);
    expect(reasons.some(r => String(r?.message ?? '').includes('timed out'))).toBe(false);
  }, 10_000);

  test('readInbox returns empty when every inbox file is cloud-only', async () => {
    const hungId1 = 'msg-hung1-cccccccccc';
    const hungId2 = 'msg-hung2-dddddddddd';
    seedInboxMessage(sharedState, hungId1, 'myia-po-2023', 'myia-po-2025');
    seedInboxMessage(sharedState, hungId2, 'myia-po-2024', 'myia-po-2025');

    mocks.readFile.mockImplementation(async () => new Promise<string>(() => {}));

    const manager = new MessageManager(sharedState, TEST_TIMEOUT_MS);
    const result = await manager.readInbox('myia-po-2025', 'all');

    expect(result).toEqual([]);
    expect(mocks.error.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 10_000);
});

describe('MessageManager — negative cache for unreadable inbox files (#3205)', () => {
  let sharedState: string;

  beforeEach(() => {
    sharedState = makeTempSharedState();
    mocks.error.mockClear();
    mocks.readFile.mockClear();
    mocks.readFile.mockImplementation(realReadFile as never);
  });

  afterEach(() => {
    rmSync(sharedState, { recursive: true, force: true });
  });

  // Long enough that the entry persists across two builds in the same test run.
  const LONG_NEG_TTL_MS = 60_000;

  test('skips a failed-to-read file on a subsequent rebuild within the negative-cache window', async () => {
    const goodId = 'msg-neg-good-aaaaaaaa';
    const badId = 'msg-neg-bad-bbbbbbbb';
    seedInboxMessage(sharedState, goodId, 'myia-po-2023', 'myia-po-2025');
    seedInboxMessage(sharedState, badId, 'myia-po-2024', 'myia-po-2025');

    // badId read rejects; everything else passes through.
    mocks.readFile.mockImplementation(async (filePath: string, _enc: string) => {
      if (filePath.includes(badId)) {
        throw new Error('Simulated EIO read failure');
      }
      return realReadFile(filePath, 'utf-8');
    });

    const manager = new MessageManager(sharedState, TEST_TIMEOUT_MS, LONG_NEG_TTL_MS);

    // 1st build: bad file fails → excluded from results, recorded in negative cache.
    const first = await manager.readInbox('myia-po-2025', 'all');
    expect(first.map(m => m.id)).toContain(goodId);
    expect(first.map(m => m.id)).not.toContain(badId);
    expect(mocks.readFile.mock.calls.filter(c => c[0].includes(badId)).length).toBe(1);

    // Force a rebuild via invalidateCache (the cache-TTL fast path would
    // otherwise short-circuit within 5 min). A new file proves it's a real
    // rebuild, not a fast-path return.
    const newId = 'msg-neg-new-cccccccc';
    seedInboxMessage(sharedState, newId, 'myia-po-2025', 'myia-po-2025');
    manager.invalidateCache();

    const second = await manager.readInbox('myia-po-2025', 'all');
    expect(second.map(m => m.id)).toContain(goodId);
    expect(second.map(m => m.id)).toContain(newId);
    expect(second.map(m => m.id)).not.toContain(badId);

    // badId NOT re-read on the rebuild (still inside the negative-cache window).
    expect(mocks.readFile.mock.calls.filter(c => c[0].includes(badId)).length).toBe(1);
  }, 10_000);

  test('retries a previously-failed file once its negative-cache window expires', async () => {
    const goodId = 'msg-neg-exp-good-aaaa';
    const badId = 'msg-neg-exp-bad-bbbb';
    seedInboxMessage(sharedState, goodId, 'myia-po-2023', 'myia-po-2025');
    seedInboxMessage(sharedState, badId, 'myia-po-2024', 'myia-po-2025');

    // badId fails on the FIRST attempt only, then succeeds (simulates hydration).
    let failBad = true;
    mocks.readFile.mockImplementation(async (filePath: string, _enc: string) => {
      if (filePath.includes(badId) && failBad) {
        throw new Error('Simulated EIO read failure');
      }
      return realReadFile(filePath, 'utf-8');
    });

    const manager = new MessageManager(sharedState, TEST_TIMEOUT_MS, 50);

    const first = await manager.readInbox('myia-po-2025', 'all');
    expect(first.map(m => m.id)).not.toContain(badId);

    // Let the negative-cache window elapse, then hydrate the file.
    await new Promise(resolve => setTimeout(resolve, 70));
    failBad = false;

    // Force a rebuild via invalidateCache (cache-TTL fast path would short-circuit).
    const newId = 'msg-neg-exp-new-cccc';
    seedInboxMessage(sharedState, newId, 'myia-po-2025', 'myia-po-2025');
    manager.invalidateCache();

    const second = await manager.readInbox('myia-po-2025', 'all');
    // badId retried after expiry and now reads successfully.
    expect(second.map(m => m.id)).toContain(badId);
    expect(second.map(m => m.id)).toContain(newId);
  }, 10_000);
});

/**
 * #4131 — a file that is cloud-only on THIS machine never hydrates, so a plain
 * TTL makes it time out again on every expiry, forever. Measured 08/10 on
 * ai-01:vllm (2 September placeholders re-read at each cache rebuild). The fix
 * escalates the skip window after N consecutive failures and persists ONLY the
 * dead set, so a cold start (the stdio host restarts with every session) does
 * not re-pay the timeouts either.
 */
describe('MessageManager — consecutive-failure escalation + dead-set persistence (#4131)', () => {
  let sharedState: string;

  /** Normal negative-cache window: short, so it expires between assertions. */
  const NEG_TTL_MS = 60;
  /** Escalated window: long, so it is still active when asserted. */
  const DEAD_TTL_MS = 60_000;

  /** Same derivation as MessageManager.getNegativeCachePath (test-side cleanup). */
  function persistPathFor(dir: string): string {
    const key = createHash('sha256').update(dir).digest('hex').slice(0, 8);
    return join(tmpdir(), 'roo-state-manager', `inbox-read-failures-${key}.json`);
  }

  beforeEach(() => {
    sharedState = makeTempSharedState();
    mocks.error.mockClear();
    mocks.readFile.mockClear();
    mocks.readFile.mockImplementation(realReadFile as never);
    mocks.writeFileOverride.current = null;
    // Contain the blast radius: only the persistence tests opt back in.
    process.env.ROOSYNC_INBOX_NEGCACHE_PERSIST = '0';
  });

  afterEach(() => {
    rmSync(sharedState, { recursive: true, force: true });
    rmSync(persistPathFor(sharedState), { force: true });
    // Atomic publish leaves `${path}.${pid}.tmp` only on a crash path; sweep
    // any residue so a leaked temp cannot make the NEXT test's assertions lie.
    const cacheDir = dirname(persistPathFor(sharedState));
    const stamp = basename(persistPathFor(sharedState));
    try {
      for (const f of readdirSync(cacheDir)) {
        if (f.startsWith(stamp) && f.endsWith('.tmp')) rmSync(join(cacheDir, f), { force: true });
      }
    } catch { /* directory absent — nothing to sweep */ }
    delete process.env.ROOSYNC_INBOX_NEGCACHE_PERSIST;
  });

  /** Fail every read of `badId`; other files pass through. Returns a call counter. */
  function failAlways(badId: string): () => number {
    mocks.readFile.mockImplementation(async (filePath: string, _enc: string) => {
      if (filePath.includes(badId)) throw new Error('Simulated EIO read failure');
      return realReadFile(filePath, 'utf-8');
    });
    return () => mocks.readFile.mock.calls.filter(c => String(c[0]).includes(badId)).length;
  }

  test('escalates the skip window after N consecutive failures', async () => {
    const goodId = 'msg-esc-good-aaaaaaaa';
    const badId = 'msg-esc-bad-bbbbbbbb';
    seedInboxMessage(sharedState, goodId, 'myia-po-2023', 'myia-po-2025');
    seedInboxMessage(sharedState, badId, 'myia-po-2024', 'myia-po-2025');

    const badReads = failAlways(badId);
    const manager = new MessageManager(sharedState, TEST_TIMEOUT_MS, NEG_TTL_MS, 60_000, DEAD_TTL_MS);

    // Three failing builds inside the normal window → the file is declared dead.
    for (let round = 1; round <= 3; round++) {
      const result = await manager.readInbox('myia-po-2025', 'all');
      expect(result.map(m => m.id)).not.toContain(badId);
      expect(badReads()).toBe(round);
      await new Promise(resolve => setTimeout(resolve, NEG_TTL_MS + 15));
      if (round < 3) manager.invalidateCache();
    }
    expect(badReads()).toBe(3);

    // Past the NORMAL window the entry survives on the ESCALATED one.
    manager.invalidateCache();
    const after = await manager.readInbox('myia-po-2025', 'all');
    expect(after.map(m => m.id)).toContain(goodId);
    expect(after.map(m => m.id)).not.toContain(badId);
    expect(badReads()).toBe(3);
  }, 20_000);

  test('a success below the threshold resets the counter (no escalation)', async () => {
    const goodId = 'msg-reset-good-aaaaaa';
    const badId = 'msg-reset-bad-bbbbbbbb';
    seedInboxMessage(sharedState, goodId, 'myia-po-2023', 'myia-po-2025');
    seedInboxMessage(sharedState, badId, 'myia-po-2024', 'myia-po-2025');

    // Fail twice, then hydrate: 2 < N, so nothing is declared dead.
    let failing = true;
    mocks.readFile.mockImplementation(async (filePath: string, _enc: string) => {
      if (filePath.includes(badId) && failing) throw new Error('Simulated EIO read failure');
      return realReadFile(filePath, 'utf-8');
    });
    const manager = new MessageManager(sharedState, TEST_TIMEOUT_MS, NEG_TTL_MS, 60_000, DEAD_TTL_MS);

    for (let i = 0; i < 2; i++) {
      await manager.readInbox('myia-po-2025', 'all');
      await new Promise(resolve => setTimeout(resolve, NEG_TTL_MS + 15));
      manager.invalidateCache();
    }

    failing = false;
    const recovered = await manager.readInbox('myia-po-2025', 'all');
    expect(recovered.map(m => m.id)).toContain(badId);
  }, 20_000);

  test('a dead file is skipped by a NEW instance (cold start) without re-reading it', async () => {
    process.env.ROOSYNC_INBOX_NEGCACHE_PERSIST = '1';
    const goodId = 'msg-persist-good-aaaa';
    const badId = 'msg-persist-bad-bbbbbb';
    seedInboxMessage(sharedState, goodId, 'myia-po-2023', 'myia-po-2025');
    seedInboxMessage(sharedState, badId, 'myia-po-2024', 'myia-po-2025');

    const badReads = failAlways(badId);
    const first = new MessageManager(sharedState, TEST_TIMEOUT_MS, NEG_TTL_MS, 60_000, DEAD_TTL_MS);
    for (let round = 1; round <= 3; round++) {
      await first.readInbox('myia-po-2025', 'all');
      await new Promise(resolve => setTimeout(resolve, NEG_TTL_MS + 15));
      if (round < 3) first.invalidateCache();
    }
    expect(badReads()).toBe(3);

    // Cold start: a fresh host must inherit the dead set, not re-pay 3 timeouts.
    const readsBefore = badReads();
    const second = new MessageManager(sharedState, TEST_TIMEOUT_MS, NEG_TTL_MS, 60_000, DEAD_TTL_MS);
    const result = await second.readInbox('myia-po-2025', 'all');

    expect(result.map(m => m.id)).toContain(goodId);
    expect(result.map(m => m.id)).not.toContain(badId);
    expect(badReads()).toBe(readsBefore);
  }, 20_000);

  test('a single transient failure is never persisted', async () => {
    process.env.ROOSYNC_INBOX_NEGCACHE_PERSIST = '1';
    const goodId = 'msg-transient-good-aaa';
    const badId = 'msg-transient-bad-bbbb';
    seedInboxMessage(sharedState, goodId, 'myia-po-2023', 'myia-po-2025');
    seedInboxMessage(sharedState, badId, 'myia-po-2024', 'myia-po-2025');

    // Fails once, then hydrates.
    let failing = true;
    mocks.readFile.mockImplementation(async (filePath: string, _enc: string) => {
      if (filePath.includes(badId) && failing) throw new Error('Simulated EIO read failure');
      return realReadFile(filePath, 'utf-8');
    });
    const first = new MessageManager(sharedState, TEST_TIMEOUT_MS, NEG_TTL_MS, 60_000, DEAD_TTL_MS);
    await first.readInbox('myia-po-2025', 'all');

    // Below the threshold ⇒ no state on disk ⇒ a fresh host still reads the file.
    expect(existsSync(persistPathFor(sharedState))).toBe(false);

    failing = false;
    const second = new MessageManager(sharedState, TEST_TIMEOUT_MS, NEG_TTL_MS, 60_000, DEAD_TTL_MS);
    const result = await second.readInbox('myia-po-2025', 'all');
    expect(result.map(m => m.id)).toContain(badId);
  }, 20_000);

  test('the persisted dead-set is published atomically — a hostile write to the final path never yields a partial file', async () => {
    process.env.ROOSYNC_INBOX_NEGCACHE_PERSIST = '1';
    const goodId = 'msg-atomic-good-aaaa';
    const badId = 'msg-atomic-bad-bbbbbb';
    seedInboxMessage(sharedState, goodId, 'myia-po-2023', 'myia-po-2025');
    seedInboxMessage(sharedState, badId, 'myia-po-2024', 'myia-po-2025');

    // Every direct write to the FINAL path is hostile: partial content then a
    // throw, i.e. exactly the crash-in-the-middle the tmp+rename publish exists
    // to survive. Writes to the .tmp sibling pass through untouched.
    const persistPath = persistPathFor(sharedState);
    mocks.writeFileOverride.current = (p: string, data: unknown, enc?: string) => {
      if (p === persistPath) {
        realWriteFile(p, '{"entries":{"msg-atomic-bad', enc as string); // truncated JSON
        throw new Error('Simulated crash mid-write');
      }
      return realWriteFile(p, data as string, enc as string);
    };

    const badReads = failAlways(badId);
    const first = new MessageManager(sharedState, TEST_TIMEOUT_MS, NEG_TTL_MS, 60_000, DEAD_TTL_MS);
    for (let round = 1; round <= 3; round++) {
      await first.readInbox('myia-po-2025', 'all');
      await new Promise(resolve => setTimeout(resolve, NEG_TTL_MS + 15));
      if (round < 3) first.invalidateCache();
    }
    expect(badReads()).toBe(3);

    // The publish went through the temp + rename: the final file is complete
    // JSON (the hostile branch never had a chance to land), and no temp is left.
    // The dead set is keyed by inbox FILE name (the phantom guard compares the
    // basename to `message.id + '.json'`), not by bare id.
    const onDisk = JSON.parse(realFs.readFileSync(persistPath, 'utf-8')) as { entries: Record<string, unknown> };
    expect(Object.keys(onDisk.entries)).toContain(`${badId}.json`);
    expect(readdirSync(dirname(persistPath)).filter(f => f.endsWith('.tmp'))).toEqual([]);

    // And the property that matters: a fresh host still inherits the dead set.
    const readsBefore = badReads();
    const second = new MessageManager(sharedState, TEST_TIMEOUT_MS, NEG_TTL_MS, 60_000, DEAD_TTL_MS);
    const result = await second.readInbox('myia-po-2025', 'all');
    expect(result.map(m => m.id)).toContain(goodId);
    expect(result.map(m => m.id)).not.toContain(badId);
    expect(badReads()).toBe(readsBefore);
  }, 20_000);
});
