/**
 * Explicit-id starvation warning (#3292 follow-up, suites de #1360).
 *
 * The comparator (#1360) sorts explicit-id files FIRST (not provably old), so
 * budget truncations sacrifice GENERATED files — the newest ones — before
 * touching an explicit id. That protection inverts into starvation once the
 * explicit-id population itself reaches the read window: every truncation
 * slot is then consumed by an explicit id and recent generated messages are
 * the ones dropped. The warning covered here fires when that population
 * approaches the window (~80 % of COLD_START_SLICE_SIZE), on both
 * budget-bounded reads, once per instance until the pressure clears.
 *
 * Same harness as the recency suite: virtual clock advanced one tick per
 * inbox read, real fs in a temp shared-state, mocked logger.warn.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'fs';
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
const READ_CONCURRENCY = 50;
/** 80 % of COLD_START_SLICE_SIZE (100) — the approach threshold. */
const STARVATION_THRESHOLD = 80;

/** REAL generated shape: `msg-YYYYMMDDTHHMMSS-…` (the T survives toISOString). */
function idAt(index: number): string {
  const hhmmss = `00${String(Math.floor(index / 60)).padStart(2, '0')}${String(index % 60).padStart(2, '0')}`;
  return `msg-20260901T${hhmmss}-${String(index).padStart(6, '0')}`;
}

function makeTempSharedState(): string {
  const dir = join(tmpdir(), `mm-3292s-${randomUUID()}`);
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

function inboxFiles(sharedState: string): string[] {
  return readdirSync(join(sharedState, 'messages', 'inbox'));
}

describe('MessageManager — explicit-id starvation warning (#3292 suites de #1360)', () => {
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

  test('cold-start slice warns when the explicit-id population approaches the window', async () => {
    // 100 generated + 82 explicit = 182 files: the 100-file window holds all
    // 82 explicit ids (>= 80 threshold) and only 18 generated ones — recent
    // generated messages are the ones a truncation now sacrifices.
    for (let i = 1; i <= 100; i++) {
      seedMessage(sharedState, idAt(i), new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString());
    }
    for (let i = 1; i <= 82; i++) {
      seedMessage(sharedState, `explicit-note-${String(i).padStart(3, '0')}`, new Date(Date.UTC(2026, 8, 2, 0, 0, i)).toISOString());
    }
    const manager = new MessageManager(sharedState, READ_TIMEOUT_MS);

    const slice = await manager.readInbox(RECIPIENT, 'all');
    await (manager as any).inboxRebuildInFlight;

    expect(slice).toHaveLength(100);
    expect(mocks.warn).toHaveBeenCalled();
    expect(mocks.warn.mock.calls.some(([msg]) => String(msg).includes('starvation'))).toBe(true);
  }, 10_000);

  test('a small explicit-id population does not warn (negative control)', async () => {
    for (let i = 1; i <= 105; i++) {
      seedMessage(sharedState, idAt(i), new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString());
    }
    for (let i = 1; i <= 5; i++) {
      seedMessage(sharedState, `explicit-note-${String(i).padStart(3, '0')}`, new Date(Date.UTC(2026, 8, 2, 0, 0, i)).toISOString());
    }
    const manager = new MessageManager(sharedState, READ_TIMEOUT_MS);

    await manager.readInbox(RECIPIENT, 'all');
    await (manager as any).inboxRebuildInFlight;

    expect(mocks.warn.mock.calls.some(([msg]) => String(msg).includes('starvation'))).toBe(false);
  }, 10_000);

  test('the rebuild pass warns too, and only once until the pressure clears (hysteresis)', async () => {
    for (let i = 1; i <= 100; i++) {
      seedMessage(sharedState, idAt(i), new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString());
    }
    for (let i = 1; i <= 85; i++) {
      seedMessage(sharedState, `explicit-note-${String(i).padStart(3, '0')}`, new Date(Date.UTC(2026, 8, 2, 0, 0, i)).toISOString());
    }
    const manager = new MessageManager(sharedState, READ_TIMEOUT_MS);
    const files = inboxFiles(sharedState);

    (manager as any).rebuildBudgetMs = READ_CONCURRENCY; // one-chunk pass
    await (manager as any).rebuildInboxCache(files);
    await (manager as any).rebuildInboxCache(files);

    const starvationCalls = mocks.warn.mock.calls.filter(([msg]) => String(msg).includes('starvation'));
    expect(starvationCalls).toHaveLength(1);
  }, 10_000);
});
