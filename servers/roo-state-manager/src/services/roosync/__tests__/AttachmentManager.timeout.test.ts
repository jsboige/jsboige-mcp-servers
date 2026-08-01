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
// Namespace import resolves to the MOCKED module (vi.mock below) — used to spy on
// `promises.copyFile` for the getAttachment content-hang test without extending
// the hoisted readFile factory (cf. web1 c.51 spyOn-over-factory lesson).
import * as mockedFs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// vi.hoisted: stable refs usable inside vi.mock factories (key-stable pattern,
// cf. web1 c.36 #817 — logger is captured at module load, must be stable).
const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  readFile: vi.fn(),
  // Mutable holder for the per-test shared-state path. The tool resolves the
  // attachments dir via getSharedStatePath() at call time, so pointing this at
  // the test's temp dir routes the real AttachmentManager through the mocked
  // fs without mocking AttachmentManager itself (the bite-test below needs the
  // real stats accumulation path).
  sharedStatePath: '',
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

// shared-state-path mock: returns the per-test temp dir so the real
// AttachmentManager (which the tool instantiates internally) reads from the
// fixture laid down by `seedAttachment`. Hoisted ref so the factory stays stable.
vi.mock('../../../utils/shared-state-path.js', () => ({
  getSharedStatePath: () => mocks.sharedStatePath,
}));

// Imported AFTER mocks are registered.
import { AttachmentManager } from '../AttachmentManager.js';
import { roosyncListAttachments } from '../../../tools/roosync/roosync-attachments.tool.js';

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

  test('getAttachmentMetadata returns null on a cloud-only (hung) read', async () => {
    const uuid = 'eeeeeeee-0000-0000-0000-000000000005';
    seedAttachment(sharedState, uuid);

    mocks.readFile.mockImplementation(async () => new Promise<string>(() => {}));

    const manager = new AttachmentManager(sharedState, TEST_TIMEOUT_MS);
    const result = await manager.getAttachmentMetadata(uuid);

    // Hung read → null (treated as unavailable), NOT a thrown hang past 120s.
    expect(result).toBeNull();
    expect(mocks.warn).toHaveBeenCalled();
    const warnArg = mocks.warn.mock.calls.find((c) => {
      const ctx = c[1] as { label?: string } | undefined;
      return ctx?.label === `metadata:${uuid}`;
    });
    expect(warnArg).toBeTruthy();
  }, 10_000);

  test('getAttachment throws a clear error when content copyFile hangs (cloud-only)', async () => {
    const uuid = 'ffffffff-0000-0000-0000-000000000006';
    seedAttachment(sharedState, uuid);
    // Seeded metadata points at originalName `${uuid}.txt`; materialize it so
    // existsSync passes and execution reaches the (hung) copyFile.
    writeFileSync(join(sharedState, 'attachments', uuid, `${uuid}.txt`), 'hello', 'utf-8');

    const manager = new AttachmentManager(sharedState, TEST_TIMEOUT_MS);

    // Hang copyFile only (readFile stays real via beforeEach default). The spy
    // mutates the mocked module's promises.copyFile — the same object the SUT
    // resolves `fs.promises.copyFile` against — so it intercepts cleanly without
    // touching the hoisted readFile factory. Restore in finally.
    const spy = vi.spyOn(mockedFs.promises, 'copyFile').mockImplementation(
      () => new Promise<void>(() => {}),
    );
    try {
      await expect(
        manager.getAttachment(uuid, join(sharedState, 'out.txt')),
      ).rejects.toThrow(/content indisponible/i);
      expect(mocks.warn).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  }, 10_000);

  // --- Bounded concurrency (#2766 case (a): `attachments_list` unusable on the
  // fleet share). The per-read cap above bounds each read but NOT their sum:
  // read sequentially, N cloud-only entries cost N × timeout. These tests assert
  // the sum is bounded too. They fail on the sequential implementation, which is
  // what makes them worth having.

  test('listAttachments reads metadata concurrently (>1 in flight)', async () => {
    for (let i = 0; i < 5; i++) {
      seedAttachment(sharedState, `33333333-0000-0000-0000-00000000000${i}`);
    }

    let inFlight = 0;
    let maxInFlight = 0;
    mocks.readFile.mockImplementation(async (filePath: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        // Yield long enough that a sequential loop cannot overlap two reads.
        await new Promise((r) => setTimeout(r, 20));
        return realReadFile(filePath, 'utf-8');
      } finally {
        inFlight--;
      }
    });

    const manager = new AttachmentManager(sharedState, 10_000);
    const result = await manager.listAttachments();

    expect(result).toHaveLength(5);
    // Sequential gives exactly 1. Anything above proves overlap.
    expect(maxInFlight).toBeGreaterThan(1);
  }, 10_000);

  test('listAttachments cost is bounded by the pool, not by the entry count', async () => {
    // 8 cloud-only entries. Sequential: 8 × 50ms = 400ms. Pooled (C=32): ~50ms.
    for (let i = 0; i < 8; i++) {
      seedAttachment(sharedState, `44444444-0000-0000-0000-00000000000${i}`);
    }

    mocks.readFile.mockImplementation(async () => new Promise<string>(() => {}));

    const manager = new AttachmentManager(sharedState, TEST_TIMEOUT_MS);
    const started = Date.now();
    const result = await manager.listAttachments();
    const elapsed = Date.now() - started;

    expect(result).toEqual([]);
    // Generous bound: well under the sequential 400ms, well above the ~50ms floor
    // so a loaded CI machine doesn't flake.
    expect(elapsed).toBeLessThan(250);
  }, 10_000);

  test('listAttachments preserves readdir order despite out-of-order completion', async () => {
    const firstUuid = '55555555-0000-0000-0000-000000000001';
    const secondUuid = '66666666-0000-0000-0000-000000000002';
    seedAttachment(sharedState, firstUuid);
    seedAttachment(sharedState, secondUuid);

    // Make the FIRST entry finish last: appending results as they complete would
    // put `second` at index 0 — a silent ordering regression for callers.
    mocks.readFile.mockImplementation(async (filePath: string) => {
      if (filePath.includes(firstUuid)) {
        await new Promise((r) => setTimeout(r, 40));
      }
      return realReadFile(filePath, 'utf-8');
    });

    const manager = new AttachmentManager(sharedState, 10_000);
    const result = await manager.listAttachments();

    expect(result.map((m) => m.uuid)).toEqual([firstUuid, secondUuid]);
  }, 10_000);

  test('cleanupOldAttachments skips cloud-only entries and cleans the rest', async () => {
    const goodUuid = '11111111-0000-0000-0000-000000000011';
    const hungUuid = '22222222-0000-0000-0000-000000000022';
    seedAttachment(sharedState, goodUuid);
    seedAttachment(sharedState, hungUuid);

    mocks.readFile.mockImplementation(async (filePath: string, _enc: string) => {
      if (filePath.includes(hungUuid)) return new Promise<string>(() => {});
      return realReadFile(filePath, 'utf-8');
    });

    const manager = new AttachmentManager(sharedState, TEST_TIMEOUT_MS);
    // maxAgeDays = 0 → cutoff = now → both seeded (uploadedAt 2026-07-04) qualify
    // for deletion; only the readable one is deleted, the hung one is skipped.
    const deleted = await manager.cleanupOldAttachments(0);

    expect(deleted).toBe(1);
    expect(mocks.warn).toHaveBeenCalled();
  }, 10_000);

  // --- #3013 bite-test: the per-read path must surface a signal in the tool
  // response. This is the exact scenario that was silent before — a hung
  // cloud-only entry got dropped from the list, and the agent received a
  // shorter list with no indication anything was missing. Red on the silent
  // implementation, green once `roosyncListAttachments` formats the skip line.
  //
  // The false-bite to avoid: asserting the presence of a *new field* (red
  // trivially, proves nothing). The property under test is the *response text*
  // — it must contain an explicit signal that entries were omitted, broken
  // down by cause so the caller can tell a partial list from a complete one.

  test('roosyncListAttachments surfaces an omission signal when an entry times out (#3013)', async () => {
    const goodUuid = '77777777-0000-0000-0000-000000000001';
    const hungUuid = '88888888-0000-0000-0000-000000000002';
    seedAttachment(sharedState, goodUuid);
    seedAttachment(sharedState, hungUuid);

    mocks.readFile.mockImplementation(async (filePath: string, _enc: string) => {
      if (filePath.includes(hungUuid)) return new Promise<string>(() => {});
      return realReadFile(filePath, 'utf-8');
    });

    // Route the real AttachmentManager (instantiated inside the tool) at our
    // temp dir via the shared-state-path mock.
    mocks.sharedStatePath = sharedState;
    try {
      const result = await roosyncListAttachments({});

      const text = result.content[0].text;
      // Good entry is still listed.
      expect(text).toContain(goodUuid);
      // The response MUST carry an explicit omission signal — silent truncation
      // was the bug. The breakdown lets the caller tell timeout from parse from
      // missing-file rather than guessing.
      expect(text).toMatch(/omise/);
      expect(text).toMatch(/timeout\s*1/);
    } finally {
      mocks.sharedStatePath = '';
    }
    // Tool instantiates AttachmentManager with the production 10s default
    // (no inject hook), so the hung entry must wait one full timeout — ~10s.
    // Honest cost of exercising the real per-read timeout path end-to-end.
  }, 20_000);

  test('roosyncListAttachments is silent when no entries are dropped (#3013)', async () => {
    const goodUuid = '99999999-0000-0000-0000-000000000003';
    seedAttachment(sharedState, goodUuid);

    // No hang — every entry reads cleanly, so no omission line in the response.
    mocks.readFile.mockImplementation(async (filePath: string) => realReadFile(filePath, 'utf-8'));

    mocks.sharedStatePath = sharedState;
    try {
      const result = await roosyncListAttachments({});
      const text = result.content[0].text;
      expect(text).toContain(goodUuid);
      expect(text).not.toMatch(/omise/);
    } finally {
      mocks.sharedStatePath = '';
    }
  }, 10_000);

  // --- #925 follow-up: "filter before read". The bounded-concurrency pool (#925) caps
  // the *per-batch* read cost; this reverse index caps the *per-query* read count to the
  // matches, so a filtered `listAttachments(messageId)` doesn't read the N−k non-matching
  // metadata files. On a shared GDrive store of cloud-only attachments that is the
  // dominant cost (N≈960 ⇒ 300 s even pooled). The defining property: after one scan has
  // populated the index, a second filtered query touches only the requested message's
  // metadata. Red without the fast path (reads all N), green with it (reads only matches).

  test('listAttachments(messageId) skips non-matching metadata after the index is warm (#925)', async () => {
    // Two messages: A carries 3 attachments, B carries 2 (5 total).
    const msgA = 'msg-filter-A';
    const msgB = 'msg-filter-B';
    const aUuids = ['a1a1a1a1-0000-0000-0000-000000000001', 'a1a1a1a1-0000-0000-0000-000000000002', 'a1a1a1a1-0000-0000-0000-000000000003'];
    const bUuids = ['b2b2b2b2-0000-0000-0000-000000000004', 'b2b2b2b2-0000-0000-0000-000000000005'];
    for (const u of aUuids) seedAttachment(sharedState, u, msgA);
    for (const u of bUuids) seedAttachment(sharedState, u, msgB);

    // Count metadata readFiles across the whole sequence.
    let readCount = 0;
    mocks.readFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('metadata.json')) readCount++;
      return realReadFile(filePath, 'utf-8');
    });

    const manager = new AttachmentManager(sharedState, 10_000);

    // 1) Unfiltered scan: reads all 5 metadata, populates the reverse index as a
    //    side-effect for both messages.
    const all = await manager.listAttachments();
    expect(all).toHaveLength(5);
    const firstPass = readCount;
    expect(firstPass).toBe(5);

    // 2) Filtered query for msg-A with a WARM index: must read only A's 3 metadata,
    //    not re-read B's 2. This is the property — without the fast path, readCount
    //    would jump to 5 again (all N), with it only +3.
    readCount = 0;
    const onlyA = await manager.listAttachments(msgA);

    expect(onlyA).toHaveLength(3);
    expect(onlyA.map((m) => m.uuid).sort()).toEqual([...aUuids].sort());
    expect(readCount).toBe(3); // ← the bite: not 5 (no fast path), exactly 3 (fast path)
  }, 10_000);

  test('listAttachments(unknown messageId) still scans all (never trusts absence) (#925)', async () => {
    // One attachment for msg-A. Query a DIFFERENT, never-seen message: the index has no
    // entry, so the code must fall back to a full scan (correctness over speed — another
    // machine may have uploaded for the queried message on the shared store). Asserting
    // it does NOT short-circuit to [] without looking.
    seedAttachment(sharedState, 'c3c3c3c3-0000-0000-0000-000000000009', 'msg-seen');

    let readCount = 0;
    mocks.readFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('metadata.json')) readCount++;
      return realReadFile(filePath, 'utf-8');
    });

    const manager = new AttachmentManager(sharedState, 10_000);
    const result = await manager.listAttachments('msg-never-seen');

    // No match, but only after actually scanning (readCount=1, not 0).
    expect(result).toEqual([]);
    expect(readCount).toBe(1); // scanned the one dir; did not trust absence from a cold index
  }, 10_000);

  // --- ai-01 review §6: the three completeness holes. Each is RED on the v1 fast path
  // (which gated on bucket presence, not completeness) and GREEN once `completeMessages`
  // separates "known" from "known complete". The defining property is stated per test.

  test('upload does not let a partial bucket masquerade as complete (hole a)', async () => {
    // msg-X ALREADY has 2 attachments on disk (seeded directly, never scanned this process).
    seedAttachment(sharedState, 'd4d4d4d4-0000-0000-0000-000000000010', 'msg-X');
    seedAttachment(sharedState, 'd4d4d4d4-0000-0000-0000-000000000011', 'msg-X');

    let readCount = 0;
    mocks.readFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('metadata.json')) readCount++;
      return realReadFile(filePath, 'utf-8');
    });

    const manager = new AttachmentManager(sharedState, 10_000);

    // Upload a 3rd attachment for msg-X via the real upload path. v1 created an
    // authoritative-looking bucket {only-this-uuid} here; a later filtered query then
    // served ONLY this upload, hiding the 2 pre-existing ones. upload must NOT mark the
    // message complete.
    const src = join(sharedState, 'src-upload.bin');
    writeFileSync(src, 'payload', 'utf-8');
    await manager.uploadAttachment(src, 'myia-po-2023', 'up.txt', 'msg-X');

    // A filtered query for msg-X must fall back to a full scan (message not complete) and
    // render ALL 3 attachments — the 2 pre-existing plus our upload.
    readCount = 0;
    const result = await manager.listAttachments('msg-X');

    expect(result).toHaveLength(3); // ← not 1 (the v1 bug: partial bucket served as complete)
    expect(readCount).toBe(3); // it scanned all 3, did not short-circuit to the uploaded one
  }, 10_000);

  test('deleting the last attachment does not produce a false [] (hole b)', async () => {
    // msg-X and msg-Y each have one attachment. Warm the index with a full scan so both
    // are marked complete.
    const xUuid = 'e5e5e5e5-0000-0000-0000-000000000020';
    const yUuid = 'e5e5e5e5-0000-0000-0000-000000000021';
    seedAttachment(sharedState, xUuid, 'msg-X');
    seedAttachment(sharedState, yUuid, 'msg-Y');

    let readCount = 0;
    mocks.readFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('metadata.json')) readCount++;
      return realReadFile(filePath, 'utf-8');
    });

    const manager = new AttachmentManager(sharedState, 10_000);
    await manager.listAttachments(); // full scan → msg-X, msg-Y complete; readCount=2
    readCount = 0;

    // Delete msg-X's only attachment. Its bucket becomes an empty Set, but Map.has(msg-X)
    // is still true. v1 gated on has() and short-circuited to [] without scanning.
    await manager.deleteAttachment(xUuid);

    // A filtered query for msg-X must SCAN (the emptied bucket routes here via size>0
    // guard), read msg-Y's metadata as part of that scan, and honestly return [] for msg-X.
    const result = await manager.listAttachments('msg-X');

    expect(result).toEqual([]);
    expect(readCount).toBe(1); // ← the bite: v1 short-circuited (0); correctness scans (1)
  }, 10_000);

  test('a post-scan addition by another machine is bounded by the completeness TTL (hole c)', async () => {
    // Inject a tiny TTL so the bound can be exercised in real time without a 60s wait.
    const TTL = 50;
    const manager = new AttachmentManager(sharedState, 10_000, TTL);

    const firstUuid = 'f6f6f6f6-0000-0000-0000-000000000030';
    seedAttachment(sharedState, firstUuid, 'msg-X');

    mocks.readFile.mockImplementation(async (filePath: string) => realReadFile(filePath, 'utf-8'));

    // 1) Warm the index: full scan sees {firstUuid} and marks msg-X complete.
    await manager.listAttachments();

    // 2) Another machine adds a 2nd attachment for msg-X on the shared store.
    const addedUuid = 'f6f6f6f6-0000-0000-0000-000000000031';
    seedAttachment(sharedState, addedUuid, 'msg-X');

    // 3) Query WITHIN the TTL: msg-X is still trusted complete, so the fast path serves the
    //    stale {firstUuid} and misses the addition. This is the irreducible case — we can't
    //    detect it without the very full scan the fast path avoids. The TTL is the bound.
    const withinTtl = await manager.listAttachments('msg-X');
    expect(withinTtl.map((m) => m.uuid)).toEqual([firstUuid]); // stale-but-bounded (documented)

    // 4) After the TTL expires, completeness is no longer trusted → full scan → the
    //    addition is seen. The window is closed in time, independent of FS mtime semantics.
    await new Promise((r) => setTimeout(r, TTL + 20));
    const afterTtl = await manager.listAttachments('msg-X');
    expect(afterTtl.map((m) => m.uuid).sort()).toEqual([firstUuid, addedUuid].sort());
  }, 10_000);
});
