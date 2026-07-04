/**
 * Timeout/skip behavior for AttachmentManager (#2267 residual fix).
 *
 * The wedge: on GDrive Files On-Demand, a "cloud-only" metadata.json makes
 * `fs.readFile` block while GDrive tries to fetch it — hanging past the 120s
 * MCP tool timeout and wedging `attachments_list`. The fix wraps the per-entry
 * readFile in `withReadTimeout` and skips entries that time out, so the list
 * returns a partial result instead of blocking forever.
 *
 * This can't be reproduced on a real local fs, so we mock `fs.promises.readFile`
 * to hang (never resolve) for the "cloud-only" entry. The timeout is injected
 * via the constructor (50ms here) so the test runs in real time without fake
 * timers (which interact poorly with the real-IO readdir passthrough).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// vi.hoisted: stable refs usable inside vi.mock factories (key-stable pattern,
// cf. web1 c.36 #817 — logger is captured at module load, must be stable).
const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  readFile: vi.fn(),
}));

// Logger mock: capture warn calls to assert the skip is logged.
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mocks.warn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// fs mock: default readFile passes through to real; per-test overrides hang it.
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
import { AttachmentManager } from '../AttachmentManager.js';

// Real fs captured at module load (before any mock override) for passthrough.
const realFs = await vi.importActual<typeof import('fs')>('fs');
const realReadFile = realFs.promises.readFile as (p: string, enc: string) => Promise<string>;

/** Tiny timeout for tests (real timers). Production default is 10s. */
const TEST_TIMEOUT_MS = 50;

function makeTempDir(): string {
  const dir = join(tmpdir(), `att-timeout-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Lay down a UUID attachment dir with metadata.json inside sharedState. */
function seedAttachment(sharedState: string, uuid: string, messageId?: string): void {
  const dir = join(sharedState, 'attachments', uuid);
  mkdirSync(dir, { recursive: true });
  const meta = {
    uuid,
    originalName: `${uuid}.txt`,
    mimeType: 'text/plain',
    sizeBytes: 5,
    uploadedAt: '2026-07-04T10:00:00.000Z',
    uploaderMachineId: 'myia-po-2023',
    ...(messageId ? { messageId } : {}),
  };
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify(meta), 'utf-8');
}

describe('AttachmentManager — cloud-only timeout (#2267 residual)', () => {
  let sharedState: string;

  beforeEach(() => {
    sharedState = makeTempDir();
    mocks.warn.mockClear();
    mocks.readFile.mockClear();
    mocks.readFile.mockImplementation(realReadFile as never);
  });

  afterEach(() => {
    rmSync(sharedState, { recursive: true, force: true });
  });

  test('listAttachments skips a cloud-only (hung) entry and returns the rest', async () => {
    const goodUuid = 'aaaaaaaa-0000-0000-0000-000000000001';
    const hungUuid = 'bbbbbbbb-0000-0000-0000-000000000002';
    seedAttachment(sharedState, goodUuid, 'msg-good');
    seedAttachment(sharedState, hungUuid, 'msg-hung');

    const manager = new AttachmentManager(sharedState, TEST_TIMEOUT_MS);

    // Hang reads targeting the hung entry's metadata.json; others pass through.
    mocks.readFile.mockImplementation(async (filePath: string, _enc: string) => {
      if (filePath.includes(hungUuid)) {
        // Never-resolving promise simulating GDrive cloud-only fetch hang.
        return new Promise<string>(() => {});
      }
      return realReadFile(filePath, 'utf-8');
    });

    const result = await manager.listAttachments();

    // Hung entry skipped, good entry returned.
    expect(result).toHaveLength(1);
    expect(result[0].uuid).toBe(goodUuid);

    // Skip was logged with the hung UUID label.
    expect(mocks.warn).toHaveBeenCalled();
    const warnArg = mocks.warn.mock.calls.find((c) => {
      const ctx = c[1] as { label?: string } | undefined;
      return ctx?.label?.includes(`metadata:${hungUuid}`);
    });
    expect(warnArg).toBeTruthy();
  }, 10_000);

  test('listAttachments returns empty when every entry is cloud-only', async () => {
    const hungUuid1 = 'cccccccc-0000-0000-0000-000000000003';
    const hungUuid2 = 'dddddddd-0000-0000-0000-000000000004';
    seedAttachment(sharedState, hungUuid1);
    seedAttachment(sharedState, hungUuid2);

    mocks.readFile.mockImplementation(async () => new Promise<string>(() => {}));

    const manager = new AttachmentManager(sharedState, TEST_TIMEOUT_MS);
    const result = await manager.listAttachments();

    expect(result).toEqual([]);
    // Both hung entries warned.
    expect(mocks.warn.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 10_000);
});
