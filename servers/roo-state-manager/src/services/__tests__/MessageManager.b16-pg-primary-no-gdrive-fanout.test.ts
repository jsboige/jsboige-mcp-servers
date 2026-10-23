/**
 * B16 (#4131) — under `UNIFIED_STORE_CHANNEL_PG_PRIMARY=1`, a PG read failure
 * must NOT fan out into GDrive reads.
 *
 * Measured mechanism (c.6353386994): a PG connect timeout stalls the libuv
 * threadpool shared with fs reads; every RSM process then falls back to G: at
 * once and the stalled reads feed more timeouts — 74 live processes on ai-01,
 * 22-23/10. The contract pinned here:
 *   1. PG read fails + NO warm cache      → fail closed, ZERO G: reads;
 *      (positive control: the SAME fixture IS served over G: when the seat is
 *      not PG_PRIMARY, so the zero above is a decision, not an empty fixture)
 *   2. PG read fails + warm cache         → served STALE, zero NEW G: reads;
 *   3. breaker open                       → PG is not probed again, stale served;
 *   4. non-PG_PRIMARY READ_PG seat        → graceful G: fallback unchanged;
 *   5. bulk under PG_PRIMARY + PG down    → fail closed (mutation surface).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const MACHINE = 'myia-po-2024';
const WORKSPACE = 'roo-extensions';

const mocks = vi.hoisted(() => ({
  pgActive: true,
  inboxFails: false,
  mailboxFails: false,
  countFails: false,
  inboxCalls: 0,
  mailboxCalls: 0,
  inboxItems: [] as Array<Record<string, unknown>>,
  mailboxMessages: [] as Array<Record<string, unknown>>,
  counts: { total: 0, unread: 0, read: 0 },
  sharedPath: '',
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// PG channel read surface doubled (transport only — the gates under test are
// the real ones: isChannelPgPrimary reads env, the breaker is the real module).
vi.mock('../unified-store/roosync-channel-read.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getChannelPgReader: () => (mocks.pgActive ? { stub: true } : null),
    readChannelInboxFromPg: async () => {
      mocks.inboxCalls++;
      return mocks.inboxFails ? null : mocks.inboxItems;
    },
    readChannelMailboxFromPg: async () => {
      mocks.mailboxCalls++;
      return mocks.mailboxFails ? null : mocks.mailboxMessages;
    },
    countChannelInboxFromPg: async () => (mocks.countFails ? null : mocks.counts),
  };
});

import { MessageManager } from '../MessageManager.js';
import { resetChannelPgBreakerForTests } from '../unified-store/channel-pg-breaker.js';
import { SharedStoreInaccessibleError } from '../../utils/shared-state-path.js';

let previousEnv: Record<string, string | undefined>;
let manager: MessageManager;

const ENV_KEYS = [
  'ROOSYNC_MACHINE_ID',
  'ROOSYNC_WORKSPACE_ID',
  'UNIFIED_STORE_CHANNEL_READ_PG',
  'UNIFIED_STORE_CHANNEL_PG_PRIMARY',
  'UNIFIED_STORE_DUAL_WRITE',
  'UNIFIED_STORE_PG_URL',
  'CHANNEL_PG_BREAKER_MS',
] as const;

/** Count the filesystem calls that targeted the G: inbox directory. */
function inboxFsCalls(spies: { readdir: { mock: { calls: unknown[][] } }; readFile: { mock: { calls: unknown[][] } } }): number {
  const inboxPath = join(mocks.sharedPath, 'messages', 'inbox');
  const touches = (calls: unknown[][]) =>
    calls.filter((args) => String(args[0] ?? '').includes(inboxPath)).length;
  return touches(spies.readdir.mock.calls) + touches(spies.readFile.mock.calls);
}

function writeInboxFile(id: string, overrides: Record<string, unknown> = {}): void {
  const message = {
    id,
    from: 'myia-ai-01:roo-extensions',
    to: MACHINE, // machine-wide: visible from every workspace
    subject: `B16 fixture ${id}`,
    body: 'body',
    priority: 'MEDIUM',
    status: 'unread',
    timestamp: new Date().toISOString(),
    tags: [],
    ...overrides,
  };
  writeFileSync(join(mocks.sharedPath, 'messages', 'inbox', `${id}.json`), JSON.stringify(message, null, 2), 'utf-8');
}

function setPgPrimaryEnv(): void {
  process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
  process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY = '1';
  process.env.UNIFIED_STORE_DUAL_WRITE = '1';
  process.env.UNIFIED_STORE_PG_URL = 'postgres://unit-test.invalid:5432/rsm';
}

describe('B16 — no GDrive fan-out under CHANNEL_PG_PRIMARY (#4131)', () => {
  beforeEach(() => {
    mocks.pgActive = true;
    mocks.inboxFails = false;
    mocks.mailboxFails = false;
    mocks.countFails = false;
    mocks.inboxCalls = 0;
    mocks.mailboxCalls = 0;
    mocks.inboxItems = [];
    mocks.mailboxMessages = [];
    mocks.counts = { total: 0, unread: 0, read: 0 };
    mocks.sharedPath = mkdtempSync(join(tmpdir(), 'rsm-b16-'));
    for (const dir of ['inbox', 'sent', 'archive']) {
      mkdirSync(join(mocks.sharedPath, 'messages', dir), { recursive: true });
    }
    writeInboxFile('msg-20261020T120000-b16a');

    previousEnv = {};
    for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
    process.env.ROOSYNC_MACHINE_ID = MACHINE;
    process.env.ROOSYNC_WORKSPACE_ID = WORKSPACE;
    delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
    delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
    delete process.env.UNIFIED_STORE_DUAL_WRITE;
    delete process.env.UNIFIED_STORE_PG_URL;
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

  test('control — a READ_PG seat (no PG_PRIMARY) still degrades to GDrive', async () => {
    process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
    delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
    mocks.inboxFails = true;

    const readdirSpy = vi.spyOn(fsp, 'readdir');
    const readFileSpy = vi.spyOn(fsp, 'readFile');

    const items = await manager.readInbox(MACHINE, 'all', undefined, WORKSPACE);

    expect(items.map((i) => i.id)).toContain('msg-20261020T120000-b16a');
    expect(inboxFsCalls({ readdir: readdirSpy as never, readFile: readFileSpy as never })).toBeGreaterThan(0);
  });

  test('PG failure + no warm cache under PG_PRIMARY → fail closed, ZERO G: reads', async () => {
    setPgPrimaryEnv();
    mocks.inboxFails = true;

    const readdirSpy = vi.spyOn(fsp, 'readdir');
    const readFileSpy = vi.spyOn(fsp, 'readFile');

    await expect(manager.readInbox(MACHINE, 'all', undefined, WORKSPACE)).rejects.toBeInstanceOf(
      SharedStoreInaccessibleError
    );

    expect(inboxFsCalls({ readdir: readdirSpy as never, readFile: readFileSpy as never })).toBe(0);
  });

  test('PG failure + warm cache under PG_PRIMARY → served STALE with zero NEW G: reads', async () => {
    // Warm the cache over G: (reader absent — the gate is off in production;
    // the doubled gate is driven by pgActive) — the pre-B16 path.
    mocks.pgActive = false;
    const warm = await manager.readInbox(MACHINE, 'all', undefined, WORKSPACE);
    expect(warm.map((i) => i.id)).toContain('msg-20261020T120000-b16a');

    mocks.pgActive = true;
    setPgPrimaryEnv();
    mocks.inboxFails = true;

    const readdirSpy = vi.spyOn(fsp, 'readdir');
    const readFileSpy = vi.spyOn(fsp, 'readFile');

    const stale = await manager.readInbox(MACHINE, 'all', undefined, WORKSPACE);

    expect(stale.map((i) => i.id)).toContain('msg-20261020T120000-b16a');
    expect(inboxFsCalls({ readdir: readdirSpy as never, readFile: readFileSpy as never })).toBe(0);
  });

  test('breaker open → PG is not probed again on the next call', async () => {
    mocks.pgActive = false;
    await manager.readInbox(MACHINE, 'all', undefined, WORKSPACE); // warm cache over G:

    mocks.pgActive = true;
    setPgPrimaryEnv();
    mocks.inboxFails = true;
    await manager.readInbox(MACHINE, 'all', undefined, WORKSPACE); // trips the breaker
    expect(mocks.inboxCalls).toBe(1);

    // PG would answer now — the breaker must still refuse to probe this call.
    mocks.inboxFails = false;
    mocks.inboxItems = [];
    const stale = await manager.readInbox(MACHINE, 'all', undefined, WORKSPACE);

    expect(mocks.inboxCalls).toBe(1); // no second probe while open
    expect(stale.map((i) => i.id)).toContain('msg-20261020T120000-b16a');
  });

  test('bulk under PG_PRIMARY + PG down → fail closed, no G: enumeration', async () => {
    setPgPrimaryEnv();
    mocks.mailboxFails = true;

    const readdirSpy = vi.spyOn(fsp, 'readdir');
    const readFileSpy = vi.spyOn(fsp, 'readFile');

    await expect(manager.bulkOperation(MACHINE, 'mark_read', { tag: 'x' }, WORKSPACE)).rejects.toBeInstanceOf(
      SharedStoreInaccessibleError
    );
    expect(inboxFsCalls({ readdir: readdirSpy as never, readFile: readFileSpy as never })).toBe(0);
  });

  test('getFilteredCount under PG_PRIMARY + PG down + warm cache → counts stale, no G: scan', async () => {
    mocks.pgActive = false;
    await manager.readInbox(MACHINE, 'all', undefined, WORKSPACE); // warm cache over G:
    mocks.pgActive = true;
    setPgPrimaryEnv();
    mocks.countFails = true;

    const readdirSpy = vi.spyOn(fsp, 'readdir');
    const readFileSpy = vi.spyOn(fsp, 'readFile');

    const counts = await manager.getFilteredCount(MACHINE, 'all', WORKSPACE);

    expect(counts.total).toBeGreaterThan(0);
    expect(inboxFsCalls({ readdir: readdirSpy as never, readFile: readFileSpy as never })).toBe(0);
  });
});
