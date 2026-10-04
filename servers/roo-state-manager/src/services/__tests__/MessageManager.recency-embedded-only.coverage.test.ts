/**
 * Inbox recency ordering is valid ONLY for names that embed an instant (#3292
 * follow-up).
 *
 * The defect these cover: both budget-bounded reads (the rebuild pass and the
 * cold-start slice) ordered the pool by descending file name. That is a recency
 * sort for generated ids (`msg-YYYYMMDDTHHMMSS-…`) and pure string shape for
 * everything else — an explicit id (#3654) can be any `[A-Za-z0-9._:-]` string,
 * so a fresh `ai01-dispatch-note` sorted BELOW every `msg-*` file and was the
 * FIRST thing a budget truncation dropped, while an old explicit id sorting
 * high was kept. Ordering by a name that proves nothing is the bug; the fix
 * orders by embedded instant only and treats explicit-id files as NOT PROVABLY
 * OLD (first, stable).
 *
 * Determinism: same harness as the partial-cache-merge suite — a virtual clock
 * advanced one tick per inbox read makes "how far did the pass get?" arithmetic
 * (pool of 105 msg files + explicit ones, 50-file chunks ⇒ budget 50 = 1 chunk).
 *
 * NB: explicit ids here use only `-`/`.` — `:` is in the accepted alphabet but
 * illegal in NTFS names, so it cannot occur in a real Windows inbox file.
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

/** Generous: truncation under test is the BUDGET's, never a read timeout's. */
const READ_TIMEOUT_MS = 10_000;
const RECIPIENT = 'myia-po-2025';
const POOL_SIZE = 105; // 50 + 50 + 5 chunks
const READ_CONCURRENCY = 50;
const EXPLICIT_ID = 'ai01-dispatch-note';

/**
 * REAL generated shape: `generateMessageId` keeps the `T` of
 * `toISOString()` (`msg-20260801T000003-…`). The comparator only recognises
 * this exact shape — an index-padded fake (`msg-3292-0003`) matches nothing
 * and would silently turn the test into a readdir-order test.
 */
function idAt(index: number): string {
  const hhmmss = `00${String(Math.floor(index / 60)).padStart(2, '0')}${String(index % 60).padStart(2, '0')}`;
  return `msg-20260801T${hhmmss}-${String(index).padStart(6, '0')}`;
}

function makeTempSharedState(): string {
  const dir = join(tmpdir(), `mm-3292r-${randomUUID()}`);
  for (const sub of ['messages', 'messages/inbox', 'messages/sent', 'messages/archive']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return dir;
}

function seedMessage(sharedState: string, id: string, timestamp: string): void {
  const msg = {
    id,
    from: 'myia-ai-01',
    to: RECIPIENT,
    subject: `subject-${id}`,
    body: `body-${id}`,
    priority: 'HIGH',
    timestamp,
    status: 'unread',
  };
  writeFileSync(join(sharedState, 'messages', 'inbox', `${id}.json`), JSON.stringify(msg), 'utf-8');
}

describe('MessageManager — recency ordering is embedded-instant only (#3292 follow-up)', () => {
  let sharedState: string;
  let fakeNow: number;

  function armClock(): void {
    fakeNow = 1_000_000_000;
    mocks.readFile.mockImplementation(async (filePath: string, _enc: string) => {
      if (String(filePath).replace(/\\/g, '/').includes('/inbox/')) {
        fakeNow += 1;
      }
      return realReadFile(filePath, 'utf-8');
    });
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

  test('a budget truncation must not drop an explicit-id message on a false ordering', async () => {
    for (let i = 1; i <= POOL_SIZE; i++) {
      seedMessage(sharedState, idAt(i), new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString());
    }
    // Lexically BELOW every msg-* file — the exact shape the old sort dropped
    // first — yet written NOW: its timestamp is the newest of the pool.
    seedMessage(sharedState, EXPLICIT_ID, new Date(Date.UTC(2026, 8, 1)).toISOString());
    const manager = new MessageManager(sharedState, READ_TIMEOUT_MS);

    // One-chunk deep pass: reads 50 of the 106 files, truncates.
    (manager as any).rebuildBudgetMs = READ_CONCURRENCY;
    const items = await manager.readInbox(
      RECIPIENT, 'all', undefined, undefined, undefined, undefined, true,
    );
    await (manager as any).inboxRebuildInFlight;

    expect(items.map(m => m.id)).toContain(EXPLICIT_ID);
  }, 10_000);

  test('the cold-start slice includes an explicit-id message the old sort excluded', async () => {
    for (let i = 1; i <= POOL_SIZE; i++) {
      seedMessage(sharedState, idAt(i), new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString());
    }
    seedMessage(sharedState, EXPLICIT_ID, new Date(Date.UTC(2026, 8, 1)).toISOString());
    const manager = new MessageManager(sharedState, READ_TIMEOUT_MS);

    // NON-deep cold call: serves the 100-file slice (106 > 100).
    const slice = await manager.readInbox(RECIPIENT, 'all');
    await (manager as any).inboxRebuildInFlight;

    expect(slice).toHaveLength(100); // COLD_START_SLICE_SIZE
    expect(slice.map(m => m.id)).toContain(EXPLICIT_ID);
  }, 10_000);

  test('among generated ids, newest-first still holds (pin)', async () => {
    for (let i = 1; i <= POOL_SIZE; i++) {
      seedMessage(sharedState, idAt(i), new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString());
    }
    seedMessage(sharedState, EXPLICIT_ID, new Date(Date.UTC(2026, 8, 1)).toISOString());
    const manager = new MessageManager(sharedState, READ_TIMEOUT_MS);

    (manager as any).rebuildBudgetMs = READ_CONCURRENCY;
    const items = await manager.readInbox(
      RECIPIENT, 'all', undefined, undefined, undefined, undefined, true,
    );
    await (manager as any).inboxRebuildInFlight;
    const ids = items.map(m => m.id);

    expect(ids).toContain(idAt(POOL_SIZE)); // newest generated: read first
    expect(ids).not.toContain(idAt(1));     // oldest generated: sacrificed
  }, 10_000);

  test('every explicit-id file is protected, not just one (pin)', async () => {
    for (let i = 1; i <= POOL_SIZE; i++) {
      seedMessage(sharedState, idAt(i), new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString());
    }
    seedMessage(sharedState, 'aa-first-note', new Date(Date.UTC(2026, 8, 1)).toISOString());
    seedMessage(sharedState, 'ab-second-note', new Date(Date.UTC(2026, 8, 2)).toISOString());
    const manager = new MessageManager(sharedState, READ_TIMEOUT_MS);

    (manager as any).rebuildBudgetMs = READ_CONCURRENCY;
    const items = await manager.readInbox(
      RECIPIENT, 'all', undefined, undefined, undefined, undefined, true,
    );
    await (manager as any).inboxRebuildInFlight;
    const ids = items.map(m => m.id);

    expect(ids).toContain('aa-first-note');
    expect(ids).toContain('ab-second-note');
  }, 10_000);
});
