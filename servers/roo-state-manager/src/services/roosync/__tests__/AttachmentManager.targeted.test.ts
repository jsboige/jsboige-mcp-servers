/**
 * #3256 — targeted lookup: `listAttachmentsByRefs` must be O(k_message),
 * never O(N_flotte).
 *
 * The acceptance criteria demand a synthetic store of ≥ 10 000 metadata.json
 * and proof the targeted path stays independent of that total. The decisive
 * instrument is NOT the wall clock (an SSD chews through 10k tiny files fast
 * enough to blur the signal) — it is the COUNT of metadata readFiles issued
 * during the call, which must equal k exactly. The readFile counter below is
 * a delegating mock over `fs.promises.readFile` (namespace import is not
 * configurable in ESM, so vi.spyOn cannot be used — same pattern as the
 * dashboard #3205 tests).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const mocks = vi.hoisted(() => ({
  // Counting wrapper: every readFile goes to the real fs unless a test hangs
  // it via `hangPaths` (per-path prefix match).
  readFileCalls: 0,
  hangPaths: [] as string[],
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const realReadFile = actual.promises.readFile as unknown as (
    p: unknown, enc: unknown,
  ) => Promise<unknown>;
  const countingReadFile = (path: unknown, enc: unknown): Promise<unknown> => {
    mocks.readFileCalls++;
    const p = String(path);
    if (mocks.hangPaths.some((prefix) => p.startsWith(prefix))) {
      return new Promise(() => {});
    }
    return realReadFile(path, enc);
  };
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: countingReadFile,
    },
  };
});

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Imported AFTER mocks are registered.
import { AttachmentManager } from '../AttachmentManager.js';

// Real sync fs for seeding (the namespace import above resolves to the mock).
const realFs = await vi.importActual<typeof import('fs')>('fs');

/** Total synthetic store size — the acceptance floor is 10 000. */
const STORE_SIZE = 10_000;
const TEST_TIMEOUT_MS = 50;

let sharedState: string;
let manager: AttachmentManager;

function seedStore(size: number = STORE_SIZE): string[] {
  const uuids: string[] = [];
  for (let i = 0; i < size; i++) {
    const uuid = `synth-${String(i).padStart(5, '0')}-${randomUUID().slice(0, 8)}`;
    uuids.push(uuid);
    const dir = join(sharedState, 'attachments', uuid);
    realFs.mkdirSync(dir, { recursive: true });
    realFs.writeFileSync(
      join(dir, 'metadata.json'),
      JSON.stringify({
        uuid,
        originalName: `file-${i}.txt`,
        mimeType: 'text/plain',
        sizeBytes: 12,
        uploadedAt: '2026-08-24T00:00:00.000Z',
        uploaderMachineId: 'myia-po-2025',
        messageId: `msg-${i}`,
      }),
      'utf-8',
    );
  }
  return uuids;
}

describe('#3256 listAttachmentsByRefs — O(k), independent of store size', () => {
  let uuids: string[];

  beforeEach(() => {
    sharedState = join(tmpdir(), `att-targeted-${randomUUID()}`);
    realFs.mkdirSync(sharedState, { recursive: true });
    mocks.readFileCalls = 0;
    mocks.hangPaths = [];
    manager = new AttachmentManager(sharedState, TEST_TIMEOUT_MS);
  });

  afterEach(() => {
    realFs.rmSync(sharedState, { recursive: true, force: true });
  });

  test(
    'a 1-ref hit reads exactly ONE metadata from a 10 000-entry store',
    async () => {
      uuids = seedStore();
      const target = uuids[4242];

      const metas = await manager.listAttachmentsByRefs([target]);

      expect(metas).toHaveLength(1);
      expect(metas[0].uuid).toBe(target);
      // The decisive assertion: k=1 readFile, not 10 000. If this regresses to
      // a store scan the count explodes and the test fails long before any
      // wall-clock noise can hide it.
      expect(mocks.readFileCalls).toBe(1);
    },
    120_000,
  );

  test(
    'an empty ref list reads nothing at all — the definitive miss costs zero IO',
    async () => {
      uuids = seedStore();

      const metas = await manager.listAttachmentsByRefs([]);

      expect(metas).toHaveLength(0);
      expect(mocks.readFileCalls).toBe(0);
    },
    120_000,
  );

  test(
    'a multi-ref hit reads exactly k metadatas and preserves ref order',
    async () => {
      uuids = seedStore();
      const targets = [uuids[9], uuids[3], uuids[77]];

      const metas = await manager.listAttachmentsByRefs(targets);

      expect(metas.map((m) => m.uuid)).toEqual(targets);
      expect(mocks.readFileCalls).toBe(3);
    },
    120_000,
  );

  test('a ref whose metadata.json is missing is skipped and counted, not fatal', async () => {
    uuids = seedStore(8);
    const ghost = `ghost-${randomUUID().slice(0, 8)}`;

    const stats = { missingMetadata: 0, readTimeout: 0, parseError: 0 };
    const metas = await manager.listAttachmentsByRefs([uuids[1], ghost, uuids[2]], stats);

    expect(metas).toHaveLength(2);
    expect(stats.missingMetadata).toBe(1);
    expect(mocks.readFileCalls).toBe(2);
  });

  test('a cloud-only (hanging) metadata read is bounded by the timeout and counted', async () => {
    uuids = seedStore(8);
    const hung = uuids[5];
    mocks.hangPaths = [join(sharedState, 'attachments', hung)];

    const stats = { missingMetadata: 0, readTimeout: 0, parseError: 0 };
    const metas = await manager.listAttachmentsByRefs([hung, uuids[6]], stats);

    expect(metas).toHaveLength(1);
    expect(metas[0].uuid).toBe(uuids[6]);
    expect(stats.readTimeout).toBe(1);
  });
});
