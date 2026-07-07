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
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// vi.hoisted: stable refs usable inside vi.mock factories.
const mocks = vi.hoisted(() => ({
  error: vi.fn(),
  readFile: vi.fn(),
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
// existsSync/mkdirSync/writeFileSync/rmSync stay real (module-level re-exports
// below use the original so seeding/cleanup touch the real fs).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  mocks.readFile.mockImplementation(actual.promises.readFile as never);
  return {
    ...actual,
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
