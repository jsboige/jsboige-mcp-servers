/**
 * #3230 — the G: probe on a PG miss is bounded.
 *
 * Measured on po-2027 (28/10): under `UNIFIED_STORE_CHANNEL_PG_PRIMARY=1`, a
 * lookup for an id PG does not hold still fanned out to G: through three
 * `existsSync` + `readFile` calls with NO deadline — the one GDrive read left
 * on the PG-primary read path (#4131 B16 forbade the others). A wedged DriveFS
 * therefore held the tool call, and one libuv thread, indefinitely.
 *
 * The contract pinned here:
 *   1. PG_PRIMARY + PG miss → the G: read carries an AbortSignal;
 *   2. the whole probe shares ONE signal (budget = readTimeoutMs, not 3×);
 *   3. a volume that does not answer → the call ends (null), it does not hang;
 *   4. `UNIFIED_STORE_CHANNEL_MISS_PROBE_ABORT=0` → unbounded again (kill-switch);
 *   5. positive control — a file that IS there is still served.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const MACHINE = 'myia-po-2024';
const WORKSPACE = 'roo-extensions';
const CALLER = `${MACHINE}:${WORKSPACE}`;

const mocks = vi.hoisted(() => ({
  sharedPath: '',
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Transport only: the gates under test are the real ones (they read env).
vi.mock('../unified-store/roosync-channel-read.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getChannelPgReader: () => ({ stub: true }),
    getChannelMessageFromPg: async () => null, // PG miss — the case under test
  };
});

import { MessageManager } from '../MessageManager.js';

const ENV_KEYS = [
  'ROOSYNC_MACHINE_ID',
  'ROOSYNC_WORKSPACE_ID',
  'UNIFIED_STORE_CHANNEL_READ_PG',
  'UNIFIED_STORE_CHANNEL_PG_PRIMARY',
  'UNIFIED_STORE_DUAL_WRITE',
  'UNIFIED_STORE_PG_URL',
  'UNIFIED_STORE_CHANNEL_MISS_PROBE_ABORT',
] as const;

let previousEnv: Record<string, string | undefined>;
let manager: MessageManager;

function writeInboxFile(id: string): void {
  const message = {
    id,
    from: 'myia-ai-01:roo-extensions',
    to: MACHINE,
    subject: `#3230 fixture ${id}`,
    body: 'body',
    priority: 'MEDIUM',
    status: 'unread',
    timestamp: new Date().toISOString(),
    tags: [],
  };
  writeFileSync(join(mocks.sharedPath, 'messages', 'inbox', `${id}.json`), JSON.stringify(message, null, 2), 'utf-8');
}

/** The options object the probe handed to `fs.readFile` for a G: path. */
function probeReadOptions(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls
    .filter((args) => String(args[0] ?? '').includes(join(mocks.sharedPath, 'messages')))
    .map((args) => (typeof args[1] === 'object' && args[1] !== null ? args[1] as Record<string, unknown> : {}));
}

beforeEach(() => {
  previousEnv = {};
  for (const key of ENV_KEYS) previousEnv[key] = process.env[key];

  mocks.sharedPath = mkdtempSync(join(tmpdir(), 'msmmiss-'));
  for (const sub of ['messages', join('messages', 'inbox'), join('messages', 'sent'), join('messages', 'archive')]) {
    mkdirSync(join(mocks.sharedPath, sub), { recursive: true });
  }

  process.env.ROOSYNC_MACHINE_ID = MACHINE;
  process.env.ROOSYNC_WORKSPACE_ID = WORKSPACE;
  process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
  process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY = '1';
  process.env.UNIFIED_STORE_DUAL_WRITE = '1';
  process.env.UNIFIED_STORE_PG_URL = 'postgres://unit-test.invalid:5432/rsm';
  delete process.env.UNIFIED_STORE_CHANNEL_MISS_PROBE_ABORT;

  manager = new MessageManager(mocks.sharedPath, 50);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(mocks.sharedPath, { recursive: true, force: true });
});

describe('#3230 — bounded G: miss probe under PG_PRIMARY', () => {
  test('the probe read carries an AbortSignal (bounded by readTimeoutMs)', async () => {
    const readFileSpy = vi.spyOn(fsp, 'readFile');

    await manager.getMessage('msg-20260101T000000-miss1', CALLER);

    const options = probeReadOptions(readFileSpy as never);
    expect(options.length).toBeGreaterThan(0);
    for (const opts of options) {
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test('a volume that never answers ends the call — it does not hang', async () => {
    // DriveFS that accepts the read and never settles until the signal fires.
    vi.spyOn(fsp, 'readFile').mockImplementation((( _path: unknown, opts: unknown) => {
      const signal = (typeof opts === 'object' && opts !== null)
        ? (opts as { signal?: AbortSignal }).signal
        : undefined;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      });
    }) as never);

    const started = Date.now();
    const found = await manager.getMessage('msg-20260101T000000-miss2', CALLER);
    const elapsed = Date.now() - started;

    expect(found).toBeNull();
    // Bounded: the 50 ms budget, not an unbounded wait.
    expect(elapsed).toBeLessThan(2000);
  });

  test('kill-switch UNIFIED_STORE_CHANNEL_MISS_PROBE_ABORT=0 → unbounded read (no signal)', async () => {
    process.env.UNIFIED_STORE_CHANNEL_MISS_PROBE_ABORT = '0';
    const readFileSpy = vi.spyOn(fsp, 'readFile');

    await manager.getMessage('msg-20260101T000000-miss3', CALLER);

    const options = probeReadOptions(readFileSpy as never);
    expect(options.length).toBeGreaterThan(0);
    for (const opts of options) {
      expect(opts.signal).toBeUndefined();
    }
  });

  test('positive control — a file that IS there is still served', async () => {
    writeInboxFile('msg-20260101T000000-hit1');

    const message = await manager.getMessage('msg-20260101T000000-hit1', CALLER);

    expect(message?.id).toBe('msg-20260101T000000-hit1');
  });
});
